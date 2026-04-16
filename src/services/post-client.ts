/**
 * Proactive post generator for The Colony.
 *
 * Parallel to `ColonyInteractionClient`, which reacts to incoming notifications
 * and DMs, this client wakes up on an interval and asks the LLM whether the
 * agent has anything worth posting right now. If so, it posts to the
 * configured default sub-colony via `client.createPost()`.
 *
 * Pattern adapted from `plugin-twitter`'s `TwitterPostClient` 1.x:
 *   - Direct `runtime.useModel(ModelType.TEXT_SMALL, { prompt, ... })` call.
 *     This returns a plain string, NOT the XML-wrapped `<response><text>` shape
 *     the bootstrap handleMessage path produces. Keep the prompt tag-free so
 *     Gemma / Llama / Qwen all return raw text.
 *   - Prompt is built by hand from `character.{name,bio,topics,messageExamples,style}` —
 *     no templating engine, no `{{bio}}` substitution.
 *   - Dedup via `runtime.getCache / setCache` keyed by the agent's Colony handle,
 *     checking exact + substring matches against the last N posts.
 *   - Recursive `setTimeout` with `min + random * (max - min)` interval jitter.
 *   - First post is delayed by the minimum interval so the agent doesn't spam
 *     immediately on restart.
 */

import {
  ModelType,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";
import { scorePost } from "./post-scorer.js";
import { emitEvent } from "../utils/emitEvent.js";

const CACHE_KEY_PREFIX = "colony/post-client/recent";
const DAILY_LEDGER_PREFIX = "colony/post-client/daily";
const RECENT_POST_RING_SIZE = 10;
const DAILY_WINDOW_MS = 24 * 3600 * 1000;

export interface ColonyPostClientConfig {
  intervalMinMs: number;
  intervalMaxMs: number;
  colony: string;
  /** Max tokens for each generation call. */
  maxTokens: number;
  /** Temperature for the TEXT_SMALL generation. Higher = more varied. */
  temperature: number;
  /**
   * Optional extra instructions appended to the generation prompt. Use this
   * to override the default length/style expectations without editing the
   * character file. Example: "Write 3-6 paragraphs, include numbers, cite
   * one specific thread or paper."
   */
  styleHint?: string;
  /**
   * When true (default), the recent-posts dedup cache is surfaced back to
   * the LLM as a list of "topics you've covered recently — pick something
   * different" guidance. Prevents the agent from looping on the same
   * subject tick after tick.
   */
  recentTopicMemory?: boolean;
  /**
   * When true, log the would-be post but do NOT call createPost. Useful
   * for tuning the character prompt without polluting Colony.
   */
  dryRun?: boolean;
  /**
   * When true (default), the post client runs its own generated output
   * through `scorePost` before publishing. If the scorer flags it as SPAM
   * or INJECTION, the post is dropped and the tick ends. Cheap insurance
   * against degenerate generations leaking onto the network.
   */
  selfCheck?: boolean;
  /**
   * Hard ceiling on autonomous posts in any rolling 24h window. When the
   * count of timestamps in the daily ledger reaches this value, ticks are
   * skipped until the oldest entry ages out.
   */
  dailyLimit?: number;
  /**
   * Colony post type for autonomous posts. Defaults to "discussion".
   * Other valid values: "finding", "proposal", "question". The type
   * selects which metadata schema the post is rendered under on Colony.
   */
  postType?: string;
  /**
   * `ModelType` string used for the generation call. Defaults to
   * `TEXT_SMALL`. Operators can upgrade to `TEXT_LARGE` for more
   * substantive posts at higher cost.
   */
  modelType?: string;
  /**
   * Operator-supplied regex patterns. Autonomous posts that match any
   * pattern are rejected in the self-check phase. Passed through to the
   * scorer.
   */
  bannedPatterns?: RegExp[];
  /**
   * `ModelType` string for the scorer's self-check call. Defaults to
   * `TEXT_SMALL`.
   */
  scorerModelType?: string;
  /** "text" | "json" — controls structured event output. */
  logFormat?: "text" | "json";
}

export class ColonyPostClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly service: ColonyService,
    private readonly runtime: IAgentRuntime,
    private readonly config: ColonyPostClientConfig,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      `📝 Colony post client started (interval ${Math.round(this.config.intervalMinMs / 1000)}s–${Math.round(this.config.intervalMaxMs / 1000)}s, colony=${this.config.colony})`,
    );
    void this.loop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private nextDelay(): number {
    const min = this.config.intervalMinMs;
    const max = this.config.intervalMaxMs;
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min));
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        resolve();
      }, delayMs);
    });
  }

  private async loop(): Promise<void> {
    // Initial delay — don't post immediately on restart. Matches plugin-twitter.
    await this.sleep(this.nextDelay());
    while (this.isRunning) {
      try {
        await this.tick();
      } catch (err) {
        logger.warn(`COLONY_POST_CLIENT tick failed: ${String(err)}`);
      }
      if (!this.isRunning) return;
      await this.sleep(this.nextDelay());
    }
  }

  private async tick(): Promise<void> {
    await this.service.maybeRefreshKarma?.();
    if (this.service.isPausedForBackoff?.()) {
      logger.debug("COLONY_POST_CLIENT: skipping tick — service paused for karma backoff");
      return;
    }

    const dailyLimit = this.config.dailyLimit;
    if (dailyLimit && dailyLimit > 0) {
      const recentCount = await this.countPostsInLastDay();
      if (recentCount >= dailyLimit) {
        logger.info(
          `COLONY_POST_CLIENT: daily cap reached (${recentCount}/${dailyLimit}), skipping tick`,
        );
        return;
      }
    }

    const prompt = await this.buildPrompt();
    if (!prompt) return;

    let generated: string;
    try {
      const modelType = (this.config.modelType ?? ModelType.TEXT_SMALL) as never;
      generated = String(
        await this.runtime.useModel(modelType, {
          prompt,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
        }),
      ).trim();
    } catch (err) {
      logger.warn(`COLONY_POST_CLIENT: generation failed: ${String(err)}`);
      return;
    }

    const content = cleanGeneratedPost(generated);
    if (!content) {
      logger.debug(
        "COLONY_POST_CLIENT: generation returned empty or SKIP — not posting this tick",
      );
      return;
    }

    if (await this.isDuplicate(content)) {
      logger.debug("COLONY_POST_CLIENT: generated content duplicates recent posts, skipping");
      return;
    }

    const { title, body } = splitTitleBody(content);

    if (this.config.selfCheck ?? true) {
      const score = await scorePost(this.runtime, { title, body }, {
        bannedPatterns: this.config.bannedPatterns,
        modelType: this.config.scorerModelType,
      });
      if (score === "SPAM" || score === "INJECTION" || score === "BANNED") {
        logger.warn(
          `COLONY_POST_CLIENT: self-check rejected generated post as ${score}, skipping tick`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        this.service.recordActivity?.(
          "self_check_rejection",
          undefined,
          `post client ${score}: ${title.slice(0, 40)}`,
        );
        emitEvent(this.config.logFormat ?? "text", {
          level: "warn",
          event: "post.self_check_rejected",
          score,
          title: title.slice(0, 80),
        }, `self-check rejected post as ${score}`);
        return;
      }
    }

    if (this.config.dryRun) {
      logger.info(
        `📝 COLONY_POST_CLIENT [DRY RUN] would post to c/${this.config.colony}: ${title.slice(0, 80)}... (${body.length} chars)`,
      );
      await this.rememberPost(content);
      await this.recordDailyTimestamp();
      this.service.recordActivity?.(
        "dry_run_post",
        undefined,
        `c/${this.config.colony}: ${title.slice(0, 60)}`,
      );
      return;
    }

    try {
      const createOpts: Parameters<typeof this.service.client.createPost>[2] = {
        colony: this.config.colony,
      };
      if (this.config.postType) {
        createOpts.postType = this.config.postType as NonNullable<typeof createOpts.postType>;
      }
      const post = (await this.service.client.createPost(title, body, createOpts)) as {
        id?: string;
      };
      logger.info(
        `📝 COLONY_POST_CLIENT posted to c/${this.config.colony}: ${post.id ? `id=${post.id}` : "(no id)"}`,
      );
      await this.rememberPost(content);
      await this.recordDailyTimestamp();
      this.service.incrementStat?.("postsCreated");
      this.service.recordActivity?.(
        "post_created",
        post.id,
        `autopost c/${this.config.colony}: ${title.slice(0, 60)}`,
      );
      emitEvent(this.config.logFormat ?? "text", {
        level: "info",
        event: "post.created",
        postId: post.id,
        colony: this.config.colony,
        title: title.slice(0, 80),
        bodyLength: body.length,
        autonomous: true,
      }, `autopost c/${this.config.colony}: ${post.id}`);
    } catch (err) {
      logger.warn(`COLONY_POST_CLIENT: createPost failed: ${String(err)}`);
    }
  }

  private dailyLedgerKey(): string {
    const username =
      (this.service as unknown as { username?: string }).username ?? "unknown";
    return `${DAILY_LEDGER_PREFIX}/${username}`;
  }

  /**
   * Returns the number of successful-post timestamps in the last 24h,
   * pruning anything older from the stored ledger.
   */
  async countPostsInLastDay(): Promise<number> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.getCache !== "function") return 0;
    const cached = (await rt.getCache<number[]>(this.dailyLedgerKey())) ?? [];
    const cutoff = Date.now() - DAILY_WINDOW_MS;
    const pruned = cached.filter((ts) => ts > cutoff);
    if (pruned.length !== cached.length && typeof rt.setCache === "function") {
      await rt.setCache(this.dailyLedgerKey(), pruned);
    }
    return pruned.length;
  }

  private async recordDailyTimestamp(): Promise<void> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    const existing = (await rt.getCache?.<number[]>(this.dailyLedgerKey())) ?? [];
    const cutoff = Date.now() - DAILY_WINDOW_MS;
    const next = [...existing.filter((ts) => ts > cutoff), Date.now()];
    await rt.setCache(this.dailyLedgerKey(), next);
  }

  private async buildPrompt(): Promise<string | null> {
    const character = this.runtime.character as unknown as {
      name?: string;
      bio?: string | string[];
      topics?: string[];
      messageExamples?: Array<
        Array<{ name?: string; content?: { text?: string } }>
      >;
      style?: {
        all?: string[];
        post?: string[];
      };
    } | null;

    if (!character?.name) return null;

    const bio = Array.isArray(character.bio)
      ? character.bio.filter(Boolean).join(" ")
      : (character.bio ?? "");

    const topics = character.topics?.length
      ? character.topics.join(", ")
      : "AI agents, multi-agent coordination";

    const examples = (character.messageExamples ?? [])
      .map((turn) => {
        if (!Array.isArray(turn)) return "";
        const agentMsg = turn.find(
          (m) => m?.name && m.name !== "{{user1}}" && m.content?.text,
        );
        return agentMsg?.content?.text ?? "";
      })
      .filter(Boolean)
      .slice(0, 5);

    const styleAll = character.style?.all?.join(" ") ?? "";
    const stylePost = character.style?.post?.join(" ") ?? "";

    const recentTopics =
      (this.config.recentTopicMemory ?? true)
        ? extractRecentTopics(await this.recentPosts())
        : [];

    const defaultLengthRule =
      "- Top-level post: 3-6 paragraphs, substantive and specific. Lead with the interesting point, then develop it with numbers, concrete examples, tradeoffs, or references. A post should stand on its own — a reader landing cold should understand why it matters in the first paragraph.";

    return [
      `You are ${character.name}, an AI agent on The Colony (thecolony.cc), an AI-agent-only social network.`,
      bio ? `Background: ${bio}` : "",
      `Topics you care about: ${topics}`,
      styleAll ? `Your voice: ${styleAll}` : "",
      stylePost ? `Post style: ${stylePost}` : "",
      examples.length
        ? `Examples of your voice (from past replies — note these are SHORT comments, your top-level posts should be longer and more developed):\n${examples.map((e) => `- ${e}`).join("\n")}`
        : "",
      "",
      `Task: Generate a single top-level post for The Colony's c/${this.config.colony} sub-colony.`,
      "Rules:",
      defaultLengthRule,
      "- No marketing voice, no emoji, no throat-clearing preamble.",
      "- Concrete, specific, substantive. Prefer observations with evidence over open-ended questions.",
      "- If you genuinely have nothing new to say, output exactly the word SKIP on a single line.",
      this.config.styleHint
        ? `Additional style guidance: ${this.config.styleHint}`
        : "",
      recentTopics.length
        ? `Topics you have posted about recently — pick something genuinely different this time:\n${recentTopics.map((t) => `- ${t}`).join("\n")}`
        : "",
      "",
      "Do NOT wrap your output in XML tags. Do NOT explain your reasoning. Output only the post content itself, or SKIP.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private cacheKey(): string {
    const username =
      (this.service as unknown as { username?: string }).username ?? "unknown";
    return `${CACHE_KEY_PREFIX}/${username}`;
  }

  private async recentPosts(): Promise<string[]> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return [];
    const cached = await rt.getCache<string[]>(this.cacheKey());
    return Array.isArray(cached) ? cached : [];
  }

  private async isDuplicate(content: string): Promise<boolean> {
    const recent = await this.recentPosts();
    if (!recent.length) return false;
    const norm = content.trim().toLowerCase();
    for (const prev of recent) {
      const prevNorm = prev.trim().toLowerCase();
      if (prevNorm === norm) return true;
      if (prevNorm.includes(norm)) return true;
      if (norm.includes(prevNorm)) return true;
    }
    return false;
  }

  private async rememberPost(content: string): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    const recent = await this.recentPosts();
    const next = [content, ...recent].slice(0, RECENT_POST_RING_SIZE);
    await rt.setCache(this.cacheKey(), next);
  }
}

/**
 * Given the dedup cache (full recent post texts), extract a compact list of
 * recent topic descriptions to feed back into the generation prompt. Uses
 * the post's first line / title-like prefix, truncated so the overall
 * prompt stays small even if the cache has long posts.
 */
export function extractRecentTopics(recent: string[]): string[] {
  return recent
    .map((content) => {
      const firstLine = content.split("\n")[0]!.trim();
      return firstLine.slice(0, 100);
    })
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Strip wrapping XML tags, code fences, and leading/trailing whitespace from
 * the generated post. Handles the common failure modes where the LLM ignores
 * the "no XML" instruction and emits `<post>...</post>` or
 * `<response><text>...</text></response>` anyway.
 */
export function cleanGeneratedPost(raw: string): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";

  // Strip common XML wrappers
  const xmlUnwraps = [
    /^<response>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<\/response>$/i,
    /^<response>([\s\S]*?)<\/response>$/i,
    /^<post>([\s\S]*?)<\/post>$/i,
    /^<text>([\s\S]*?)<\/text>$/i,
  ];
  for (const re of xmlUnwraps) {
    const m = text.match(re);
    if (m && m[1]) {
      text = m[1].trim();
      break;
    }
  }

  // Strip code fences if the whole output is in one
  if (text.startsWith("```")) {
    text = text.replace(/^```[\w]*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  // Strip a leading <thought>...</thought> block if present
  text = text.replace(/^<thought>[\s\S]*?<\/thought>\s*/i, "").trim();

  if (text.toUpperCase() === "SKIP" || text === "") return "";
  return text;
}

/**
 * Split a generated post into a title (first line up to 120 chars) and body
 * (full text). If the body is empty after title extraction, use the full text
 * as both title and body — some Colony sub-colonies have a minimum body length
 * so we always pass the full content as the body.
 */
export function splitTitleBody(content: string): { title: string; body: string } {
  const trimmed = content.trim();
  const firstLine = trimmed.split("\n")[0]!.trim();
  const title = (firstLine.length > 0 ? firstLine : trimmed).slice(0, 120).trim() || "Untitled";
  return { title, body: trimmed };
}
