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
import type { CreatePostOptions } from "@thecolony/sdk";
import type { ColonyService } from "./colony.service.js";
import { scorePost } from "./post-scorer.js";
import { validateGeneratedOutput } from "./output-validator.js";
import { emitEvent } from "../utils/emitEvent.js";
import { RetryQueue } from "./retry-queue.js";
import { DraftQueue } from "./draft-queue.js";
import { isOllamaReachable } from "../utils/readiness.js";
import { isInQuietHours } from "../environment.js";

const CACHE_KEY_PREFIX = "colony/post-client/recent";
const DAILY_LEDGER_PREFIX = "colony/post-client/daily";
const RETRY_QUEUE_PREFIX = "colony/post-client/retry";
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
  /**
   * When true (default), transient createPost failures enqueue the
   * rejected payload into a retry queue that drains on subsequent ticks.
   * False disables the queue entirely — failures log and drop.
   */
  retryQueueEnabled?: boolean;
  /** Max retry attempts before a queue entry is dropped. */
  retryQueueMaxAttempts?: number;
  /** Max age (ms) a queue entry can live before being dropped. */
  retryQueueMaxAgeMs?: number;
  /**
   * When true, SPAM self-check rejections trigger a one-shot regeneration
   * pass with a "try again being more substantive" hint, rather than
   * dropping the tick. INJECTION and BANNED still drop immediately.
   */
  selfCheckRetry?: boolean;
  /**
   * When true (v0.14.0), autonomous posts are enqueued as drafts in the
   * operator-approval queue instead of being published directly. Operator
   * reviews via `COLONY_PENDING_APPROVALS` and approves/rejects via the
   * corresponding actions.
   */
  approvalRequired?: boolean;
  /** Draft queue instance, required when `approvalRequired` is true. */
  draftQueue?: DraftQueue;
}

export class ColonyPostClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private retryQueue: RetryQueue | null = null;

  constructor(
    private readonly service: ColonyService,
    private readonly runtime: IAgentRuntime,
    private readonly config: ColonyPostClientConfig,
  ) {
    if (config.retryQueueEnabled ?? true) {
      const username =
        (service as unknown as { username?: string }).username ?? "unknown";
      this.retryQueue = new RetryQueue(runtime, `${RETRY_QUEUE_PREFIX}/${username}`, {
        maxAttempts: config.retryQueueMaxAttempts ?? 3,
        maxAgeMs: config.retryQueueMaxAgeMs ?? 60 * 60 * 1000,
      });
    }
  }

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

  /**
   * v0.19.0: expose the retry queue to the service for status reporting.
   * Returns the queue instance or null when disabled via config.
   */
  getRetryQueue(): RetryQueue | null {
    return this.retryQueue;
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

  /**
   * v0.24.0: run one tick immediately, out-of-band from the interval
   * loop. Mirrors `ColonyEngagementClient.tickNow()` (v0.23.0) — same
   * use case: operator wants to nudge a loop now rather than wait for
   * the next timer. Invoked from the SIGUSR2 handler wired in
   * `ColonyService.registerShutdownHandlers`. Errors are caught and
   * logged rather than thrown, so a failed nudge doesn't crash the
   * host process.
   */
  async tickNow(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      logger.warn(`COLONY_POST_CLIENT: tickNow failed: ${String(err)}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.service.colonyConfig?.autoRotateKey) {
      await this.service.refreshKarmaWithAutoRotate?.();
    } else {
      await this.service.maybeRefreshKarma?.();
    }
    if (this.service.isPausedForBackoff?.()) {
      logger.debug("COLONY_POST_CLIENT: skipping tick — service paused for karma backoff");
      return;
    }

    // v0.17.0: quiet-hours gate. Skip autonomous posts entirely when the
    // current UTC hour falls inside the operator-configured quiet window.
    // Reactive polling (interaction client) is unaffected; only the
    // outbound post client respects this.
    if (isInQuietHours(this.service.colonyConfig?.postQuietHours ?? null)) {
      logger.debug(
        "COLONY_POST_CLIENT: skipping tick — inside COLONY_POST_QUIET_HOURS window",
      );
      return;
    }

    // v0.16.0: skip the tick entirely when the configured Ollama endpoint
    // isn't reachable. The alternative — firing `useModel` anyway — wastes
    // compute, produces an error string the rest of the pipeline has to
    // catch, and spams the logs. Cheap probe with 30s TTL cache.
    if (!(await isOllamaReachable(this.runtime))) {
      logger.debug(
        "COLONY_POST_CLIENT: skipping tick — Ollama endpoint is unreachable (probe cached ≤30s)",
      );
      return;
    }

    // Drain any pending retries before attempting a new generation.
    // If a queued retry succeeds, we still proceed with the normal tick
    // (we don't want a queue backlog to starve fresh content).
    if (this.retryQueue) {
      await this.retryQueue.drain(async (entry) => {
        const { title, body, options } = entry.payload as {
          title: string;
          body: string;
          options?: Record<string, unknown>;
        };
        const createOpts: CreatePostOptions = {
          colony: this.config.colony,
          ...(options as object),
        };
        await this.service.client.createPost(title, body, createOpts);
        this.service.incrementStat?.("postsCreated");
        this.service.recordActivity?.(
          "post_created",
          undefined,
          `retry-queue delivery: ${title.slice(0, 60)}`,
        );
      });
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
      this.service.recordLlmCall?.("success");
    } catch (err) {
      logger.warn(`COLONY_POST_CLIENT: generation failed: ${String(err)}`);
      this.service.recordLlmCall?.("failure");
      return;
    }

    const cleanedRaw = cleanGeneratedPost(generated);
    if (!cleanedRaw) {
      logger.debug(
        "COLONY_POST_CLIENT: generation returned empty or SKIP — not posting this tick",
      );
      return;
    }

    // v0.16.0: strip LLM artifacts + reject model-error strings before they
    // reach createPost. See src/services/output-validator.ts for rationale.
    const validated = validateGeneratedOutput(cleanedRaw);
    if (!validated.ok) {
      if (validated.reason === "model_error") {
        logger.warn(
          `COLONY_POST_CLIENT: dropping model-error output (looks like a provider failure, not real content): ${cleanedRaw.slice(0, 120)}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        // The initial useModel technically returned, but the output is a
        // provider-error payload — count as a failure for health stats.
        this.service.recordLlmCall?.("failure");
      } else {
        logger.debug(
          "COLONY_POST_CLIENT: generation was empty after LLM-artifact stripping",
        );
      }
      return;
    }
    let content = validated.content;

    if (await this.isDuplicate(content)) {
      logger.debug("COLONY_POST_CLIENT: generated content duplicates recent posts, skipping");
      return;
    }

    let { title, body, postType: detectedType, titleFromMarker } = splitTitleBody(content);

    // v0.15.0: if the model didn't emit a `Title:` marker, fall back to
    // a cheap second-pass summarization so the title isn't just the
    // first 120 characters of the body.
    if (!titleFromMarker) {
      const generated = await generateTitleFromBody(this.runtime, body, {
        modelType: this.config.modelType,
      });
      if (generated) {
        title = generated;
      }
    }

    // Prefer an auto-detected postType from the marker; fall back to
    // the configured default.
    const effectivePostType = detectedType ?? this.config.postType;

    if (this.config.selfCheck ?? true) {
      let score = await scorePost(this.runtime, { title, body }, {
        bannedPatterns: this.config.bannedPatterns,
        modelType: this.config.scorerModelType,
      });

      // v0.13.0: if SPAM and retry is enabled, regenerate once with a
      // feedback hint. INJECTION + BANNED still drop immediately — they're
      // hard failures we don't want to retry around.
      if (score === "SPAM" && this.config.selfCheckRetry) {
        logger.info(
          "COLONY_POST_CLIENT: self-check SPAM — retrying generation with feedback hint",
        );
        const retryPrompt = `${prompt}\n\nYour previous output was rejected by a quality filter as too low-effort. Try again: be more substantive, include specific numbers / claims / references, lead with a concrete observation. Avoid empty statements and vague claims.`;
        try {
          const modelType = (this.config.modelType ?? ModelType.TEXT_SMALL) as never;
          const retryGenerated = String(
            await this.runtime.useModel(modelType, {
              prompt: retryPrompt,
              temperature: this.config.temperature,
              maxTokens: this.config.maxTokens,
            }),
          ).trim();
          const retryCleaned = cleanGeneratedPost(retryGenerated);
          const retryValidated = retryCleaned
            ? validateGeneratedOutput(retryCleaned)
            : null;
          if (
            retryValidated?.ok &&
            !(await this.isDuplicate(retryValidated.content))
          ) {
            const retryContent = retryValidated.content;
            const split = splitTitleBody(retryContent);
            title = split.title;
            body = split.body;
            content = retryContent;
            score = await scorePost(this.runtime, { title, body }, {
              bannedPatterns: this.config.bannedPatterns,
              modelType: this.config.scorerModelType,
            });
          }
        } catch (err) {
          logger.warn(`COLONY_POST_CLIENT: retry generation failed: ${String(err)}`);
        }
      }

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

    if (this.config.approvalRequired && this.config.draftQueue) {
      const draft = await this.config.draftQueue.enqueue("post", "post_client", {
        title,
        body,
        colony: this.config.colony,
        ...(effectivePostType ? { postType: effectivePostType } : {}),
      });
      await this.rememberPost(content);
      this.service.recordActivity?.(
        "dry_run_post",
        draft.id,
        `queued for approval c/${this.config.colony}: ${title.slice(0, 60)}`,
      );
      return;
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
      const createOpts: CreatePostOptions = {
        colony: this.config.colony,
      };
      if (effectivePostType) {
        createOpts.postType = effectivePostType as NonNullable<typeof createOpts.postType>;
      }
      const post = (await this.service.client.createPost(title, body, createOpts)) as {
        id?: string;
      };
      logger.info(
        `📝 COLONY_POST_CLIENT posted to c/${this.config.colony}: ${post.id ? `id=${post.id}` : "(no id)"}`,
      );
      await this.rememberPost(content);
      await this.recordDailyTimestamp();
      // v0.19.0: feed the body to the diversity watchdog. Trips the
      // semantic-repetition pause if the last N posts are all too
      // similar. Feeding AFTER successful post keeps the watchdog in
      // step with what's actually landed on the platform.
      this.service.recordGeneratedOutput?.(`${title}\n${body}`);
      this.service.incrementStat?.("postsCreated", "autonomous");
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
      if (this.retryQueue) {
        await this.retryQueue.enqueue(
          "post",
          { title, body, options: { colony: this.config.colony } },
          err,
        );
      }
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
      "OUTPUT FORMAT (strict):",
      "  Title: <short headline, 50-100 chars, lead with the interesting point, no quotes or emoji>",
      "  Type: <one of: discussion, finding, question, analysis>",
      "",
      "  <body — the full post content, 3-6 paragraphs>",
      "",
      "The Title and Type lines are required. A blank line separates the header from the body. Do NOT put quotes around the title. The `Type:` line is a post-type hint for the Colony UI; use `finding` for empirical observations / data, `question` for genuine open inquiries, `analysis` for multi-point synthesis, `discussion` for everything else.",
      "",
      "Do NOT wrap your output in XML tags. Do NOT explain your reasoning. Output only the headline block and body, or SKIP.",
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
/**
 * Split generated content into a title and body.
 *
 * v0.15.0: prefers an explicit `Title: <headline>` marker on the first
 * non-blank line (optionally followed by a `Type: finding|question|
 * analysis|discussion` marker on the line after). When present, the
 * title is used verbatim and only the remaining content becomes the
 * body. When absent, falls back to the v0.14 heuristic (first line of
 * body, truncated at 120 chars) — call {@link generateTitleFromBody}
 * afterwards with a runtime to upgrade this fallback to a proper
 * LLM summary.
 *
 * The heuristic fallback is kept so this function remains synchronous
 * and pure — async title generation is a separate opt-in step in the
 * write paths that call it.
 */
export function splitTitleBody(content: string): {
  title: string;
  body: string;
  postType?: string;
  titleFromMarker: boolean;
} {
  const trimmed = content.trim();
  if (!trimmed) {
    return { title: "Untitled", body: "", titleFromMarker: false };
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0]!.trim();
  const titleMatch = firstLine.match(/^title\s*[:—-]\s*(.+)$/i);

  if (titleMatch) {
    const title = titleMatch[1]!.trim().slice(0, 200);
    let bodyStart = 1;
    let postType: string | undefined;
    // Optional Type: marker on the next non-blank line
    while (bodyStart < lines.length && lines[bodyStart]!.trim() === "") {
      bodyStart++;
    }
    if (bodyStart < lines.length) {
      const typeMatch = lines[bodyStart]!.trim().match(/^type\s*[:—-]\s*(\w+)$/i);
      if (typeMatch) {
        const candidate = typeMatch[1]!.toLowerCase();
        if (["discussion", "finding", "question", "analysis"].includes(candidate)) {
          postType = candidate;
          bodyStart++;
        }
      }
    }
    // Skip any additional blank lines after the markers
    while (bodyStart < lines.length && lines[bodyStart]!.trim() === "") {
      bodyStart++;
    }
    const body = lines.slice(bodyStart).join("\n").trim() || trimmed;
    return {
      title: title || "Untitled",
      body,
      postType,
      titleFromMarker: true,
    };
  }

  // Heuristic fallback: first line up to 120 chars, same as pre-v0.15
  // behavior. The caller can upgrade this via generateTitleFromBody.
  const title =
    (firstLine.length > 0 ? firstLine : trimmed).slice(0, 120).trim() || "Untitled";
  return { title, body: trimmed, titleFromMarker: false };
}

/**
 * Generate a title from a body via a short `useModel(TEXT_SMALL)` call.
 * Used when the LLM didn't emit an explicit `Title:` marker in its
 * generation — the body is complete content, just needs a headline.
 *
 * Returns null on any failure (caller falls back to the heuristic
 * title from {@link splitTitleBody}). Intentionally cheap: short
 * prompt, ~40 token cap, conservative temperature.
 */
export async function generateTitleFromBody(
  runtime: IAgentRuntime,
  body: string,
  options: { modelType?: string; maxTokens?: number } = {},
): Promise<string | null> {
  const modelType = (options.modelType ?? ModelType.TEXT_SMALL) as never;
  const maxTokens = options.maxTokens ?? 40;
  const snippet = body.slice(0, 2000);
  const prompt = [
    "Write a short headline for the following Colony post body.",
    "",
    "Rules:",
    "- One line, no quotation marks, no trailing punctuation (unless the headline is itself a question).",
    "- 50-100 characters. Shorter is better if it conveys the point.",
    "- Lead with the interesting claim or observation — not meta-commentary like 'A post about…' or 'Thoughts on…'.",
    "- No emoji. No hashtags.",
    "",
    "Body:",
    snippet,
    "",
    "Respond with only the headline, nothing else.",
  ].join("\n");

  try {
    const raw = String(
      await runtime.useModel(modelType, {
        prompt,
        temperature: 0.3,
        maxTokens,
      }),
    ).trim();
    if (!raw) return null;
    // Strip wrapping quotes if the model added them despite instruction
    const cleaned = raw
      .replace(/^["'“‘]+|["'”’]+$/g, "")
      .replace(/\n.*/s, "") // first line only
      .trim()
      .slice(0, 200);
    return cleaned || null;
  } catch (err) {
    logger.debug(`COLONY_TITLE_GENERATOR: useModel failed: ${String(err)}`);
    return null;
  }
}
