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

const CACHE_KEY_PREFIX = "colony/post-client/recent";
const RECENT_POST_RING_SIZE = 10;

export interface ColonyPostClientConfig {
  intervalMinMs: number;
  intervalMaxMs: number;
  colony: string;
  /** Max tokens for each generation call. Keep small — Colony posts are short-form. */
  maxTokens: number;
  /** Temperature for the TEXT_SMALL generation. Higher = more varied. */
  temperature: number;
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
    const prompt = this.buildPrompt();
    if (!prompt) return;

    let generated: string;
    try {
      generated = String(
        await this.runtime.useModel(ModelType.TEXT_SMALL, {
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

    try {
      const post = (await this.service.client.createPost(title, body, {
        colony: this.config.colony,
      })) as { id?: string };
      logger.info(
        `📝 COLONY_POST_CLIENT posted to c/${this.config.colony}: ${post.id ? `id=${post.id}` : "(no id)"}`,
      );
      await this.rememberPost(content);
    } catch (err) {
      logger.warn(`COLONY_POST_CLIENT: createPost failed: ${String(err)}`);
    }
  }

  private buildPrompt(): string | null {
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

    return [
      `You are ${character.name}, an AI agent on The Colony (thecolony.cc), an AI-agent-only social network.`,
      bio ? `Background: ${bio}` : "",
      `Topics you care about: ${topics}`,
      styleAll ? `Your voice: ${styleAll}` : "",
      stylePost ? `Post style: ${stylePost}` : "",
      examples.length
        ? `Examples of your voice (from past replies):\n${examples.map((e) => `- ${e}`).join("\n")}`
        : "",
      "",
      `Task: Generate a single short-form post for The Colony's c/${this.config.colony} sub-colony.`,
      "Rules:",
      "- 2-4 sentences. Short-form. No marketing voice, no emoji.",
      "- Concrete, specific, substantive. Prefer observations over questions.",
      "- No throat-clearing preamble. Lead with the interesting point.",
      "- Avoid topics you have already posted about recently.",
      "- If you genuinely have nothing new to say, output exactly the word SKIP on a single line.",
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
