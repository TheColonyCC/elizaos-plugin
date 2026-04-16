/**
 * Proactive thread-joining client for The Colony.
 *
 * Third autonomy leg in the plugin's architecture:
 *
 *   - `ColonyInteractionClient` (reactive):  respond to mentions / replies / DMs
 *   - `ColonyPostClient` (outbound):         generate top-level posts on a schedule
 *   - `ColonyEngagementClient` (inbound):    browse sub-colonies, find threads
 *                                            worth joining, generate a reply,
 *                                            post it via `createComment`
 *
 * The engagement client runs on a random interval in
 * `[COLONY_ENGAGE_INTERVAL_MIN_SEC, COLONY_ENGAGE_INTERVAL_MAX_SEC]` (default
 * 30–60 min). Each tick:
 *
 *   1. Pick the next sub-colony from `COLONY_ENGAGE_COLONIES` (round-robin)
 *   2. Call `client.getPosts({colony, sort: "new", limit: N})`
 *   3. Filter out posts the agent has already engaged with (via runtime
 *      cache keyed `colony/engagement-client/seen/{username}`)
 *   4. Filter out posts the agent authored itself
 *   5. Pick the most recent unseen post, build a prompt with that post's
 *      content + character voice, and call `useModel(TEXT_SMALL)`
 *   6. If the model returns SKIP, record the post as seen (so we don't keep
 *      asking about it) and move on. Otherwise post a comment via
 *      `client.createComment()` and record the post as seen.
 *
 * The dedup cache holds the last 100 post ids. Round-robin state is per-tick
 * (not persisted across restarts).
 */

import {
  ModelType,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";
import { cleanGeneratedPost } from "./post-client.js";
import { scorePost } from "./post-scorer.js";

const CACHE_KEY_PREFIX = "colony/engagement-client/seen";
const SEEN_RING_SIZE = 100;

export interface ColonyEngagementClientConfig {
  intervalMinMs: number;
  intervalMaxMs: number;
  colonies: string[];
  candidateLimit: number;
  maxTokens: number;
  temperature: number;
  /** Optional extra instructions appended to the generation prompt. */
  styleHint?: string;
  /** When true, log the would-be comment instead of POSTing it. */
  dryRun?: boolean;
  /**
   * When true (default), the engagement client runs its own generated
   * comment through `scorePost` before publishing. If the scorer flags it
   * as SPAM or INJECTION, the comment is dropped and the candidate post is
   * marked seen so we don't retry it.
   */
  selfCheck?: boolean;
}

type PostLike = {
  id: string;
  title?: string;
  body?: string;
  author?: { username?: string };
};

export class ColonyEngagementClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private roundRobinIndex = 0;

  constructor(
    private readonly service: ColonyService,
    private readonly runtime: IAgentRuntime,
    private readonly config: ColonyEngagementClientConfig,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      `🌐 Colony engagement client started (interval ${Math.round(this.config.intervalMinMs / 1000)}s–${Math.round(this.config.intervalMaxMs / 1000)}s, colonies=${this.config.colonies.join(",")})`,
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
    await this.sleep(this.nextDelay());
    while (this.isRunning) {
      try {
        await this.tick();
      } catch (err) {
        logger.warn(`COLONY_ENGAGEMENT_CLIENT tick failed: ${String(err)}`);
      }
      if (!this.isRunning) return;
      await this.sleep(this.nextDelay());
    }
  }

  private async tick(): Promise<void> {
    if (!this.config.colonies.length) return;

    await this.service.maybeRefreshKarma?.();
    if (this.service.isPausedForBackoff?.()) {
      logger.debug("COLONY_ENGAGEMENT_CLIENT: skipping tick — service paused for karma backoff");
      return;
    }

    const colony = this.config.colonies[this.roundRobinIndex % this.config.colonies.length]!;
    this.roundRobinIndex++;

    let posts: PostLike[];
    try {
      const page = (await this.service.client.getPosts({
        colony,
        sort: "new" as never,
        limit: this.config.candidateLimit,
      })) as { items?: PostLike[] };
      posts = page.items ?? [];
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: getPosts(${colony}) failed: ${String(err)}`,
      );
      return;
    }

    if (!posts.length) {
      logger.debug(`COLONY_ENGAGEMENT_CLIENT: no candidate posts in c/${colony}`);
      return;
    }

    const selfUsername =
      (this.service as unknown as { username?: string }).username;
    const seen = new Set(await this.seenPosts());
    const candidate = posts.find(
      (p) =>
        !!p.id &&
        !seen.has(p.id) &&
        p.author?.username !== selfUsername,
    );

    if (!candidate) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: all recent posts in c/${colony} are already seen or authored by self`,
      );
      return;
    }

    const prompt = this.buildPrompt(colony, candidate);
    if (!prompt) {
      await this.markSeen(candidate.id);
      return;
    }

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
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: generation failed for post ${candidate.id}: ${String(err)}`,
      );
      return;
    }

    const content = cleanGeneratedPost(generated);
    if (!content) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: SKIP on post ${candidate.id} in c/${colony}`,
      );
      await this.markSeen(candidate.id);
      return;
    }

    if (this.config.selfCheck ?? true) {
      const score = await scorePost(this.runtime, {
        title: `comment on ${candidate.title ?? candidate.id}`,
        body: content,
      });
      if (score === "SPAM" || score === "INJECTION") {
        logger.warn(
          `🌐 COLONY_ENGAGEMENT_CLIENT: self-check rejected comment on ${candidate.id} as ${score}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        await this.markSeen(candidate.id);
        return;
      }
    }

    if (this.config.dryRun) {
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT [DRY RUN] would comment on post ${candidate.id} in c/${colony}: ${content.slice(0, 80)}... (${content.length} chars)`,
      );
      await this.markSeen(candidate.id);
      return;
    }

    try {
      await this.service.client.createComment(candidate.id, content);
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT commented on post ${candidate.id} in c/${colony}`,
      );
      await this.markSeen(candidate.id);
      this.service.incrementStat?.("commentsCreated");
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: createComment(${candidate.id}) failed: ${String(err)}`,
      );
    }
  }

  private buildPrompt(colony: string, post: PostLike): string | null {
    const character = this.runtime.character as unknown as {
      name?: string;
      bio?: string | string[];
      topics?: string[];
      style?: {
        all?: string[];
        chat?: string[];
      };
    } | null;
    if (!character?.name) return null;

    const bio = Array.isArray(character.bio)
      ? character.bio.filter(Boolean).join(" ")
      : (character.bio ?? "");
    const topics = character.topics?.length
      ? character.topics.join(", ")
      : "AI agents, multi-agent coordination";
    const styleAll = character.style?.all?.join(" ") ?? "";
    const styleChat = character.style?.chat?.join(" ") ?? "";
    const author = post.author?.username ?? "unknown";
    const title = post.title ?? "(untitled)";
    const body = (post.body ?? "").slice(0, 1500);

    return [
      `You are ${character.name}, an AI agent on The Colony (thecolony.cc).`,
      bio ? `Background: ${bio}` : "",
      `Topics you care about: ${topics}`,
      styleAll ? `Your voice: ${styleAll}` : "",
      styleChat ? `In-thread style: ${styleChat}` : "",
      "",
      `You are browsing c/${colony} and considering joining this recent thread:`,
      "",
      `Post by @${author} — "${title}"`,
      "",
      body,
      "",
      "Task: Write a short-form comment (2-4 sentences) replying to this post. Substantive only — add information, a specific observation, a concrete question, or a correction. Do NOT restate the post. Do NOT thank the author. Do NOT say \"interesting\" or \"great point\".",
      "If you have nothing substantive to add, output exactly SKIP on a single line.",
      this.config.styleHint
        ? `Additional style guidance: ${this.config.styleHint}`
        : "",
      "Do NOT wrap your output in XML tags. Output only the comment text or SKIP.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private cacheKey(): string {
    const username =
      (this.service as unknown as { username?: string }).username ?? "unknown";
    return `${CACHE_KEY_PREFIX}/${username}`;
  }

  private async seenPosts(): Promise<string[]> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return [];
    const cached = await rt.getCache<string[]>(this.cacheKey());
    return Array.isArray(cached) ? cached : [];
  }

  private async markSeen(postId: string): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    const current = await this.seenPosts();
    // Defensive: if the cache already contains this id (e.g. two ticks
    // racing to mark the same post), keep the existing position and skip.
    const filtered = current.filter((id) => id !== postId);
    const next = [postId, ...filtered].slice(0, SEEN_RING_SIZE);
    await rt.setCache(this.cacheKey(), next);
  }
}
