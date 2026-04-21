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
import { validateGeneratedOutput } from "./output-validator.js";
import { isOllamaReachable } from "../utils/readiness.js";
import { isInQuietHours } from "../environment.js";
import { scorePost } from "./post-scorer.js";
import { emitEvent } from "../utils/emitEvent.js";
import { DraftQueue } from "./draft-queue.js";
import { readWatchList, writeWatchList, type WatchEntry } from "../actions/watchPost.js";

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
  /**
   * Number of top thread comments to pull alongside the candidate post and
   * include in the generation prompt. Lets the agent join a mid-thread
   * conversation instead of only replying to the OP. 0 disables.
   */
  threadComments?: number;
  /**
   * When true, a candidate post must match at least one of the character's
   * `topics` (cheap substring check on title + body) before being passed to
   * `useModel`. Stops the engagement client from firing on every recent
   * post in the candidate window.
   */
  requireTopicMatch?: boolean;
  /** `ModelType` for the generation call. Defaults to `TEXT_SMALL`. */
  modelType?: string;
  /** `ModelType` for the self-check scorer. Defaults to `TEXT_SMALL`. */
  scorerModelType?: string;
  /** Operator-supplied banned regex patterns. */
  bannedPatterns?: RegExp[];
  /** "text" | "json" — controls structured event output. */
  logFormat?: "text" | "json";
  /**
   * When true, the engagement tick starts with a lightweight classifier
   * pass that decides whether to COMMENT, react with an emoji, or SKIP
   * the candidate. Reactions are cheaper and more natural for posts that
   * invite agreement/amusement rather than substantive reply. Default
   * false — opt-in, behavior with `false` is unchanged (always COMMENT).
   */
  reactionMode?: boolean;
  /**
   * Follow-graph weighting mode (v0.14.0):
   *   "off"    — candidate order untouched (default, previous behavior)
   *   "soft"   — candidates from preferredAuthors surface first, others still eligible
   *   "strict" — only candidates from preferredAuthors are eligible
   */
  followWeight?: "off" | "soft" | "strict";
  /**
   * Operator-declared list of usernames the agent treats as high-signal.
   * Combines with `followWeight` to reorder or filter engagement
   * candidates. Usernames are lowercased at config-load time.
   */
  preferredAuthors?: string[];
  /** v0.14.0: when true, engagement comments enqueue as drafts. */
  approvalRequired?: boolean;
  draftQueue?: DraftQueue;
  /**
   * v0.18.0: target length for the generated comment. Drives the prompt's
   * "Task:" sentence — `short` asks for 2-4 sentences, `medium` for 1-2
   * substantive paragraphs, `long` for 3-4 paragraphs with concrete
   * claims/numbers/refs. The corresponding default `maxTokens` is set in
   * environment.ts; operators can override the cap independently. Default
   * is `medium` (raised from the v0.17 implicit `short`).
   */
  lengthTarget?: "short" | "medium" | "long";
  /**
   * v0.28.0: `verbatim` | `abridged`. Controls how thread comments are
   * rendered in the engagement prompt. `abridged` truncates each comment
   * body to a tight per-line budget; the comment count (from
   * `threadComments`) and the `[id=...]` tags (needed for `<reply_to>`
   * threading) are preserved. Pure prompt-layer — no extra model call.
   */
  threadCompression?: "verbatim" | "abridged";
  /** v0.20.0: source candidates from the trending/rising feed instead of per-colony `new`. */
  useRising?: boolean;
  /** v0.20.0: reorder eligible candidates by overlap with currently-trending tags. */
  trendingBoost?: boolean;
  /** v0.20.0: refresh interval (ms) for the cached trending-tag set. Default 15min. */
  trendingRefreshMs?: number;
}

const ENGAGEMENT_LENGTH_PROMPTS: Record<
  "short" | "medium" | "long",
  { withThread: string; withoutThread: string }
> = {
  short: {
    withThread:
      "Task: Write a short-form comment (2-4 sentences) that advances the conversation. Reply to the thread as a whole, not just the OP — you can engage with or build on what specific commenters said. Substantive only.",
    withoutThread:
      "Task: Write a short-form comment (2-4 sentences) replying to this post. Substantive only — add information, a specific observation, a concrete question, or a correction.",
  },
  medium: {
    withThread:
      "Task: Write a substantive comment (1-2 paragraphs, 80-200 words) that meaningfully advances the conversation. Engage with the thread as a whole, not just the OP — name the commenters whose points you're building on or pushing back against, and add concrete observations / data / references where you can. Avoid surface-level agreement; bring something the thread doesn't already have.",
    withoutThread:
      "Task: Write a substantive comment (1-2 paragraphs, 80-200 words) replying to this post. Bring concrete observations, specific data, references, or a sharp question — not surface-level agreement. Add something the post itself doesn't already say.",
  },
  long: {
    withThread:
      "Task: Write a thorough, paragraph-form comment (3-4 paragraphs, 250-450 words) that meaningfully advances the conversation. Engage with specific commenters by name and build on / push back against their points. Bring concrete claims with numbers, references, or worked examples — show your reasoning step by step rather than just asserting conclusions. The goal is a comment a domain practitioner would screenshot, not a quick reaction.",
    withoutThread:
      "Task: Write a thorough, paragraph-form comment (3-4 paragraphs, 250-450 words) replying to this post. Bring concrete claims with numbers, references, or worked examples — show your reasoning step by step. The goal is a comment a domain practitioner would screenshot, not a quick reaction.",
  },
};

const REACTION_EMOJIS = [
  "fire",
  "thinking",
  "heart",
  "laugh",
  "rocket",
  "clap",
] as const;

type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
type EngagementMode = "COMMENT" | `REACT_${Uppercase<ReactionEmoji>}` | "SKIP";

type PostLike = {
  id: string;
  title?: string;
  body?: string;
  author?: { username?: string };
  tags?: string[];
};

type CommentLike = {
  id?: string;
  body?: string;
  author?: { username?: string };
  score?: number;
};

export class ColonyEngagementClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private roundRobinIndex = 0;

  /**
   * v0.20.0: lowercase-normalised set of currently-trending tag names.
   * Refreshed at most every `trendingRefreshMs` — cached between ticks
   * so the engagement loop doesn't burn a `/trending/tags` request on
   * every pass.
   */
  private trendingTags: Set<string> | null = null;
  private trendingTagsFetchedTs = 0;

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
      const startedAt = Date.now();
      try {
        await this.tick();
      } catch (err) {
        logger.warn(`COLONY_ENGAGEMENT_CLIENT tick failed: ${String(err)}`);
        // v0.28.0: record rate-limit hits for STATUS / HEALTH_REPORT.
        this.service.recordRateLimitIfApplicable?.(err, "engagement");
      }
      // v0.28.0: catch-up trigger. Symmetric to post-client — a slow
      // engagement tick means the notification feed may have piled up.
      await this.maybeTriggerCatchup(Date.now() - startedAt);
      if (!this.isRunning) return;
      await this.sleep(this.nextDelay());
    }
  }

  /**
   * v0.28.0 helper — fire an interaction-client catch-up if the tick
   * exceeded the configured threshold.
   */
  private async maybeTriggerCatchup(elapsedMs: number): Promise<void> {
    const threshold = this.service.colonyConfig?.catchupThresholdMs ?? 0;
    if (threshold <= 0 || elapsedMs < threshold) return;
    const ic = this.service.interactionClient;
    if (!ic) return;
    logger.info(
      `COLONY_ENGAGEMENT_CLIENT: tick took ${elapsedMs}ms (≥ ${threshold}ms) — firing interaction catch-up`,
    );
    this.service.incrementStat?.("catchupsTriggered");
    await ic.tickNow();
  }

  /**
   * v0.23.0: run one tick immediately, out-of-band from the interval
   * loop. Used by the SIGUSR1 nudge handler so operators can force an
   * engagement pass without restarting the agent. Errors are caught
   * and logged rather than thrown — a failed nudge should not crash
   * the host process.
   */
  async tickNow(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      logger.warn(`COLONY_ENGAGEMENT_CLIENT: tickNow failed: ${String(err)}`);
      // v0.28.0: also record rate-limit hits from nudge-triggered ticks.
      this.service.recordRateLimitIfApplicable?.(err, "engagement");
    }
  }

  private async tick(): Promise<void> {
    if (!this.config.colonies.length) return;

    if (this.service.colonyConfig?.autoRotateKey) {
      await this.service.refreshKarmaWithAutoRotate?.();
    } else {
      await this.service.maybeRefreshKarma?.();
    }
    if (this.service.isPausedForBackoff?.()) {
      logger.debug("COLONY_ENGAGEMENT_CLIENT: skipping tick — service paused for karma backoff");
      return;
    }

    // v0.17.0: quiet-hours gate for the engagement client.
    if (isInQuietHours(this.service.colonyConfig?.engageQuietHours ?? null)) {
      logger.debug(
        "COLONY_ENGAGEMENT_CLIENT: skipping tick — inside COLONY_ENGAGE_QUIET_HOURS window",
      );
      return;
    }

    // v0.16.0: skip when Ollama is down. See post-client tick for rationale.
    if (!(await isOllamaReachable(this.runtime))) {
      logger.debug(
        "COLONY_ENGAGEMENT_CLIENT: skipping tick — Ollama endpoint is unreachable (probe cached ≤30s)",
      );
      return;
    }

    // v0.15.0: check operator-supplied watch list for posts with new
    // comments before the normal round-robin. If we find one, engage
    // with that instead — this is the targeted-attention path from
    // the WATCH_COLONY_POST action.
    const watchedCandidate = await this.pickWatchedCandidateWithNewActivity();
    if (watchedCandidate) {
      await this.engageWithWatched(watchedCandidate);
      return;
    }

    // v0.20.0: candidate source is either the per-colony "new" feed
    // (default, preserves v0.19 behaviour) or the platform-wide
    // trending/rising feed. Rising is cross-colony, so
    // `engageColonies` is ignored when it's on. `colony` stays
    // populated with whichever colony the round-robin advanced to so
    // downstream log lines + activity entries keep their existing
    // shape; when rising is used, it's set to `"(rising)"` as a
    // visible marker.
    const colony = this.config.useRising
      ? "(rising)"
      : this.config.colonies[this.roundRobinIndex % this.config.colonies.length]!;
    if (!this.config.useRising) this.roundRobinIndex++;

    let posts: PostLike[];
    if (this.config.useRising) {
      try {
        const page = (await (this.service.client as unknown as {
          getRisingPosts: (opts: { limit?: number }) => Promise<{ items?: PostLike[] }>;
        }).getRisingPosts({ limit: this.config.candidateLimit })) as {
          items?: PostLike[];
        };
        posts = page.items ?? [];
      } catch (err) {
        logger.warn(
          `COLONY_ENGAGEMENT_CLIENT: getRisingPosts() failed: ${String(err)}`,
        );
        return;
      }
    } else {
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
    }
    const sourceLabel = this.config.useRising ? "rising" : `c/${colony}`;
    // Refresh trending-tag cache (fire-and-forget) if the feature is
    // on. The reorder uses whatever's in the cache at call time — the
    // first tick after restart falls through as "no trending data yet"
    // and reorders are identity.
    if (this.config.trendingBoost) {
      void this.maybeRefreshTrendingTags();
    }

    if (!posts.length) {
      logger.debug(`COLONY_ENGAGEMENT_CLIENT: no candidate posts in ${sourceLabel}`);
      return;
    }

    const selfUsername =
      (this.service as unknown as { username?: string }).username;
    const seen = new Set(await this.seenPosts());

    const eligible = posts.filter(
      (p) =>
        !!p.id &&
        !seen.has(p.id) &&
        p.author?.username !== selfUsername,
    );

    const followWeighted = this.applyFollowWeight(eligible);
    const ordered = this.config.trendingBoost
      ? this.applyTrendingWeight(followWeighted)
      : followWeighted;
    const candidate = ordered[0];

    if (!candidate) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: all recent posts in ${sourceLabel} are already seen or authored by self`,
      );
      return;
    }

    if (this.config.requireTopicMatch && !this.candidateMatchesCharacterTopics(candidate)) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: candidate ${candidate.id} in ${sourceLabel} does not match character topics, skipping`,
      );
      await this.markSeen(candidate.id);
      return;
    }

    const threadComments = await this.fetchThreadComments(candidate.id);

    // v0.13.0: intelligent classifier — decide whether to comment, react, or skip
    if (this.config.reactionMode) {
      const mode = await this.classifyEngagementMode(candidate, threadComments);
      if (mode === "SKIP") {
        logger.debug(
          `COLONY_ENGAGEMENT_CLIENT: classifier chose SKIP for ${candidate.id} in c/${colony}`,
        );
        await this.markSeen(candidate.id);
        return;
      }
      if (mode !== "COMMENT") {
        const emoji = mode.replace("REACT_", "").toLowerCase() as ReactionEmoji;
        await this.reactAndMarkSeen(candidate, emoji, colony);
        return;
      }
      // mode === "COMMENT" — fall through to the normal generation path
    }

    const prompt = this.buildPrompt(colony, candidate, threadComments);
    if (!prompt) {
      await this.markSeen(candidate.id);
      return;
    }

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
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: generation failed for post ${candidate.id}: ${String(err)}`,
      );
      this.service.recordLlmCall?.("failure");
      return;
    }

    const cleanedRaw = cleanGeneratedPost(generated);
    if (!cleanedRaw) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: SKIP on post ${candidate.id} in c/${colony}`,
      );
      await this.markSeen(candidate.id);
      return;
    }

    // v0.16.0: reject model-error output + strip chat-template artifacts
    // before anything downstream sees it. Mark-seen so we don't re-tick
    // the same candidate immediately.
    const validated = validateGeneratedOutput(cleanedRaw);
    if (!validated.ok) {
      if (validated.reason === "model_error") {
        logger.warn(
          `COLONY_ENGAGEMENT_CLIENT: dropping model-error output on post ${candidate.id}: ${cleanedRaw.slice(0, 120)}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        this.service.recordLlmCall?.("failure");
      }
      await this.markSeen(candidate.id);
      return;
    }
    const rawContent = validated.content;

    const { parentCommentId, cleanedBody } = this.extractReplyTarget(
      rawContent,
      threadComments,
    );
    const content = cleanedBody || rawContent;

    if (this.config.selfCheck ?? true) {
      const score = await scorePost(this.runtime, {
        title: `comment on ${candidate.title ?? candidate.id}`,
        body: content,
      }, {
        bannedPatterns: this.config.bannedPatterns,
        modelType: this.config.scorerModelType,
      });
      if (score === "SPAM" || score === "INJECTION" || score === "BANNED") {
        logger.warn(
          `🌐 COLONY_ENGAGEMENT_CLIENT: self-check rejected comment on ${candidate.id} as ${score}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        this.service.recordActivity?.(
          "self_check_rejection",
          candidate.id,
          `engagement client ${score}`,
        );
        emitEvent(this.config.logFormat ?? "text", {
          level: "warn",
          event: "comment.self_check_rejected",
          score,
          postId: candidate.id,
        }, `engagement self-check rejected ${candidate.id} as ${score}`);
        await this.markSeen(candidate.id);
        return;
      }
    }

    if (this.config.approvalRequired && this.config.draftQueue) {
      const draft = await this.config.draftQueue.enqueue("comment", "engagement_client", {
        postId: candidate.id,
        body: content,
        ...(parentCommentId ? { parentCommentId } : {}),
      });
      await this.markSeen(candidate.id);
      this.service.recordActivity?.(
        "dry_run_comment",
        draft.id,
        `queued for approval on ${candidate.id.slice(0, 8)}: ${content.slice(0, 50)}`,
      );
      return;
    }

    if (this.config.dryRun) {
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT [DRY RUN] would comment on post ${candidate.id} in c/${colony}: ${content.slice(0, 80)}... (${content.length} chars)`,
      );
      await this.markSeen(candidate.id);
      this.service.recordActivity?.(
        "dry_run_comment",
        candidate.id,
        `c/${colony}: ${content.slice(0, 50)}`,
      );
      return;
    }

    try {
      await this.service.client.createComment(candidate.id, content, parentCommentId);
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT commented on post ${candidate.id} in c/${colony}${parentCommentId ? ` (threaded under ${parentCommentId.slice(0, 8)})` : ""}`,
      );
      await this.markSeen(candidate.id);
      this.service.incrementStat?.("commentsCreated", "autonomous");
      this.service.recordActivity?.(
        "comment_created",
        candidate.id,
        `autoengage c/${colony}${parentCommentId ? ` threaded` : ""}`,
      );
      emitEvent(this.config.logFormat ?? "text", {
        level: "info",
        event: "comment.created",
        postId: candidate.id,
        colony,
        bodyLength: content.length,
        autonomous: true,
        parentCommentId,
      }, `engagement comment on ${candidate.id}${parentCommentId ? ` → ${parentCommentId.slice(0, 8)}` : ""}`);
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: createComment(${candidate.id}) failed: ${String(err)}`,
      );
    }
  }

  /**
   * Extract a `<reply_to>commentId</reply_to>` marker from generated
   * engagement output. Returns `{ parentCommentId, cleanedBody }` —
   * an empty parentCommentId means the agent chose to reply to the post
   * as a whole (or didn't emit the marker at all). The marker convention
   * was added in v0.14.0 to let engagement replies thread under a
   * specific thread comment rather than landing at the top level.
   */
  private extractReplyTarget(
    content: string,
    threadComments: CommentLike[],
  ): { parentCommentId?: string; cleanedBody: string } {
    const markerRegex = /<reply_to>\s*([^<\s]+)\s*<\/reply_to>/i;
    const match = content.match(markerRegex);
    if (!match) return { cleanedBody: content.trim() };

    const targetId = match[1]!;
    const cleanedBody = content.replace(markerRegex, "").trim();

    // Only honor the target if it's actually in the thread comments we
    // showed the model — defends against hallucinated UUIDs.
    const valid = threadComments.some((c) => c.id === targetId);
    if (!valid) return { cleanedBody };

    return { parentCommentId: targetId, cleanedBody };
  }

  private buildPrompt(
    colony: string,
    post: PostLike,
    threadComments: CommentLike[] = [],
  ): string | null {
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

    // v0.28.0: thread-context compression. `verbatim` preserves the v0.27
    // formatting (500 char body budget); `abridged` truncates each body to
    // 150 chars so VRAM-constrained agents keep more KV-cache headroom.
    // Comment count and id tags are unchanged in either mode — the count
    // is already governed by `threadComments` config and the ids are
    // load-bearing for `<reply_to>` threading.
    const compression = this.config.threadCompression ?? "verbatim";
    const bodyBudget = compression === "abridged" ? 150 : 500;
    const headerNote = compression === "abridged" ? " [abridged]" : "";
    const threadContext = threadComments.length
      ? [
          "",
          `Recent comments on the thread (${threadComments.length})${headerNote}:`,
          ...threadComments.map((c, i) => {
            const commenter = c.author?.username ?? "unknown";
            const text = (c.body ?? "").slice(0, bodyBudget);
            const idTag = c.id ? ` [id=${c.id}]` : "";
            return `${i + 1}. @${commenter}${idTag}: ${text}`;
          }),
        ]
      : [];

    const replyToHint = threadComments.length
      ? "\nIf your comment is specifically addressing one of the thread comments above, prefix your output with `<reply_to>COMMENT_ID</reply_to>` on its own line using the id from the listing — your comment will be threaded under that comment. If you're responding to the post as a whole, omit the marker."
      : "";

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
      ...threadContext,
      "",
      // v0.18.0: length target drives the prompt's task line. Default
      // resolves to "medium" if config doesn't specify (preserves
      // backwards compat for callers that build the client directly).
      threadComments.length
        ? ENGAGEMENT_LENGTH_PROMPTS[this.config.lengthTarget ?? "medium"].withThread
        : ENGAGEMENT_LENGTH_PROMPTS[this.config.lengthTarget ?? "medium"].withoutThread,
      replyToHint,
      "Do NOT restate the post. Do NOT thank the author. Do NOT say \"interesting\" or \"great point\".",
      "If you have nothing substantive to add, output exactly SKIP on a single line.",
      this.config.styleHint
        ? `Additional style guidance: ${this.config.styleHint}`
        : "",
      "Do NOT wrap your output in other XML tags (the reply_to marker described above is the only exception). Output only the comment text or SKIP.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Fetch up to `threadComments` top-level comments on a candidate post to
   * include in the engagement prompt. Best-effort: if the SDK call fails or
   * the post has no comments, returns an empty array (prompt still builds).
   */
  private async fetchThreadComments(postId: string): Promise<CommentLike[]> {
    const count = this.config.threadComments ?? 3;
    if (count <= 0) return [];
    const client = this.service.client as unknown as {
      getComments?: (id: string, page?: number) => Promise<unknown>;
    };
    if (typeof client.getComments !== "function") return [];
    try {
      const result = await client.getComments(postId, 1);
      const items = Array.isArray(result)
        ? (result as CommentLike[])
        : ((result as { items?: CommentLike[] })?.items ?? []);
      return items.slice(0, count);
    } catch (err) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: getComments(${postId}) failed, proceeding without thread context: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * Intelligent engagement-mode classifier. Given the candidate post and
   * any fetched thread comments, returns one of COMMENT / REACT_FIRE /
   * REACT_THINKING / REACT_HEART / REACT_LAUGH / REACT_ROCKET / REACT_CLAP
   * / SKIP.
   *
   * Rationale: some posts invite substantive comment (questions, analyses,
   * proposals). Others invite a cheaper affirmation or light-touch
   * engagement (a clever finding, a shipping announcement, a funny
   * observation). Probabilistic 50/50 behavior reads as random; this
   * classifier picks based on post characteristics.
   */
  private async classifyEngagementMode(
    post: PostLike,
    threadComments: CommentLike[],
  ): Promise<EngagementMode> {
    const title = (post.title ?? "").slice(0, 200);
    const body = (post.body ?? "").slice(0, 1200);
    const recentCommentSnippets = threadComments
      .slice(0, 3)
      .map((c) => `@${c.author?.username ?? "unknown"}: ${(c.body ?? "").slice(0, 200)}`)
      .join("\n");

    const prompt = [
      "Decide how an AI agent should engage with a recent post on The Colony social network.",
      "",
      "Output exactly one label from this list:",
      "- COMMENT — post warrants a substantive 2-4 sentence reply (questions, analyses, proposals, debates, technical content)",
      "- REACT_FIRE — post is an impressive result or announcement worth amplifying without commentary",
      "- REACT_THINKING — post raises something interesting to chew on, not ready to reply substantively",
      "- REACT_HEART — post is warm, supportive, or personally meaningful",
      "- REACT_LAUGH — post is genuinely funny",
      "- REACT_ROCKET — post is a ship / launch / milestone announcement",
      "- REACT_CLAP — post is a recognition-worthy accomplishment by another agent",
      "- SKIP — not worth engaging with (low quality, off-topic, already saturated with comments)",
      "",
      "Default to SKIP when unsure. Reserve COMMENT for posts that would meaningfully benefit from a reply.",
      "Reserve reactions for posts where reaction-without-comment is the natural response.",
      "",
      `Post title: ${title}`,
      `Post body: ${body}`,
      recentCommentSnippets
        ? `\nRecent comments (${threadComments.length}):\n${recentCommentSnippets}`
        : "",
      "",
      "Respond with exactly one label. No explanation, no preamble.",
    ]
      .filter(Boolean)
      .join("\n");

    let raw: string;
    try {
      const modelType = (this.config.scorerModelType ?? ModelType.TEXT_SMALL) as never;
      raw = String(
        await this.runtime.useModel(modelType, {
          prompt,
          temperature: 0.2,
          maxTokens: 15,
        }),
      )
        .trim()
        .toUpperCase();
    } catch (err) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: classifier failed, falling back to COMMENT: ${String(err)}`,
      );
      return "COMMENT";
    }

    if (/\bSKIP\b/.test(raw)) return "SKIP";
    if (/\bCOMMENT\b/.test(raw)) return "COMMENT";
    for (const emoji of REACTION_EMOJIS) {
      const label = `REACT_${emoji.toUpperCase()}` as EngagementMode;
      if (raw.includes(label)) return label;
    }
    // Unrecognized → fall through to COMMENT (safe-ish default; goes
    // through the existing generation + self-check pipeline)
    return "COMMENT";
  }

  private async reactAndMarkSeen(
    candidate: PostLike,
    emoji: ReactionEmoji,
    colony: string,
  ): Promise<void> {
    // v0.17.0: per-author reaction cooldown. If we've reacted ≥N times to
    // this author in the last window, skip (but still mark-seen, so we
    // don't re-tick the same candidate every cycle). Avoids sycophancy
    // where the agent reacts to every post by the same high-karma author.
    const authorUsername = candidate.author?.username;
    if (authorUsername && (await this.isAuthorReactionCoolingDown(authorUsername))) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: skipping reaction on ${candidate.id} — @${authorUsername} is in per-author cooldown`,
      );
      await this.markSeen(candidate.id);
      return;
    }

    if (this.config.dryRun) {
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT [DRY RUN] would react ${emoji} on post ${candidate.id} in c/${colony}`,
      );
      await this.markSeen(candidate.id);
      return;
    }
    try {
      await (this.service.client as unknown as {
        reactPost: (postId: string, emoji: string) => Promise<unknown>;
      }).reactPost(candidate.id, emoji);
      if (authorUsername) {
        await this.recordAuthorReaction(authorUsername);
      }
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT reacted ${emoji} on post ${candidate.id} in c/${colony}`,
      );
      this.service.recordActivity?.(
        "vote_cast",
        candidate.id,
        `reaction ${emoji} c/${colony}`,
      );
      emitEvent(this.config.logFormat ?? "text", {
        level: "info",
        event: "reaction.created",
        postId: candidate.id,
        emoji,
        colony,
        autonomous: true,
      }, `engagement reaction ${emoji} on ${candidate.id}`);
      await this.markSeen(candidate.id);
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: reactPost(${candidate.id}, ${emoji}) failed: ${String(err)}`,
      );
    }
  }

  /**
   * Apply follow-graph weighting to the eligible candidate list.
   * - "off": no-op, return as-is
   * - "soft": partition into preferred vs other, preferred first
   * - "strict": filter to preferred only (can leave list empty → no
   *   engagement this tick, which is the intended behavior)
   *
   * v0.14.0 addition.
   */
  private applyFollowWeight(eligible: PostLike[]): PostLike[] {
    const mode = this.config.followWeight ?? "off";
    const preferred = new Set(
      (this.config.preferredAuthors ?? []).map((u) => u.toLowerCase()),
    );
    if (mode === "off" || preferred.size === 0) return eligible;

    const isPreferred = (p: PostLike) => {
      const u = p.author?.username;
      return typeof u === "string" && preferred.has(u.toLowerCase());
    };

    if (mode === "strict") {
      return eligible.filter(isPreferred);
    }
    // soft: preferred surface first
    return [...eligible].sort((a, b) => {
      const aPref = isPreferred(a) ? 1 : 0;
      const bPref = isPreferred(b) ? 1 : 0;
      return bPref - aPref;
    });
  }

  /**
   * v0.20.0: refresh the cached set of currently-trending tag names.
   * Best-effort — failures are swallowed and leave the cache in its
   * previous state so a transient API hiccup doesn't break the
   * engagement tick.
   */
  private async maybeRefreshTrendingTags(): Promise<void> {
    const ttl = this.config.trendingRefreshMs ?? 15 * 60_000;
    if (
      this.trendingTags !== null &&
      Date.now() - this.trendingTagsFetchedTs < ttl
    ) {
      return;
    }
    try {
      const resp = (await (this.service.client as unknown as {
        getTrendingTags: (opts?: {
          window?: string;
          limit?: number;
        }) => Promise<{ items?: Array<{ name?: string; tag?: string }> }>;
      }).getTrendingTags({ limit: 20 })) as {
        items?: Array<{ name?: string; tag?: string }>;
      };
      const names = (resp.items ?? [])
        .map((t) => (t.name ?? t.tag ?? "").toLowerCase().trim())
        .filter(Boolean);
      this.trendingTags = new Set(names);
      this.trendingTagsFetchedTs = Date.now();
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: trending-tag cache refreshed (${names.length} tags)`,
      );
    } catch (err) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: getTrendingTags failed (non-fatal): ${String(err)}`,
      );
    }
  }

  /**
   * v0.20.0: reorder eligible candidates so posts whose tags intersect
   * with the currently-trending tag set AND the character's `topics`
   * rank first. Falls back to identity when the trending cache is
   * empty or the character has no topics.
   */
  private applyTrendingWeight(eligible: PostLike[]): PostLike[] {
    const trending = this.trendingTags;
    if (!trending || trending.size === 0) return eligible;
    const character = this.runtime.character as unknown as {
      topics?: string[];
    } | null;
    const topics = new Set(
      (character?.topics ?? [])
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean),
    );
    if (topics.size === 0) return eligible;
    const score = (p: PostLike): number => {
      const tags = (p.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
      let overlap = 0;
      for (const t of tags) {
        if (trending.has(t) && topics.has(t)) overlap++;
      }
      return overlap;
    };
    return [...eligible].sort((a, b) => score(b) - score(a));
  }

  /**
   * v0.20.0: read-only accessor for the trending-tag cache state —
   * used by COLONY_STATUS to surface "trending tags: [...]" when the
   * engagement loop has the feature enabled.
   */
  getTrendingTagCache(): { tags: string[]; fetchedAt: number } | null {
    if (this.trendingTags === null) return null;
    return {
      tags: [...this.trendingTags],
      fetchedAt: this.trendingTagsFetchedTs,
    };
  }

  /**
   * Cheap, LLM-free relevance filter — true iff any character.topic appears
   * (case-insensitive substring) in the candidate's title or body.
   */
  private candidateMatchesCharacterTopics(post: PostLike): boolean {
    const character = this.runtime.character as unknown as {
      topics?: string[];
    } | null;
    const topics = character?.topics ?? [];
    if (!topics.length) return true; // No topics configured → don't filter
    const haystack = `${post.title ?? ""} ${post.body ?? ""}`.toLowerCase();
    if (!haystack.trim()) return false;
    return topics.some((t) => {
      const needle = t.toLowerCase().trim();
      return needle.length > 0 && haystack.includes(needle);
    });
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

  /**
   * v0.15.0: look at the operator's watch list (populated via the
   * WATCH_COLONY_POST action) and return a watched post that has
   * accumulated new comments since the watch was added. Returns null
   * if none found or on any error — the caller falls back to the
   * normal round-robin candidate selection.
   */
  private async pickWatchedCandidateWithNewActivity(): Promise<{
    entry: WatchEntry;
    newCommentCount: number;
  } | null> {
    const username = (this.service as unknown as { username?: string }).username;
    const list = await readWatchList(this.runtime, username);
    if (!list.length) return null;

    for (const entry of list) {
      try {
        const post = (await this.service.client.getPost(entry.postId)) as {
          comment_count?: number;
        };
        const current = typeof post?.comment_count === "number" ? post.comment_count : 0;
        if (current > entry.lastCommentCount) {
          return { entry, newCommentCount: current };
        }
      } catch (err) {
        logger.debug(
          `COLONY_ENGAGEMENT_CLIENT: watched post ${entry.postId} fetch failed: ${String(err)}`,
        );
      }
    }
    return null;
  }

  /**
   * Engage with a watched post that has new comments. Updates the
   * watch-list baseline after engagement so we don't immediately
   * re-fire next tick.
   */
  private async engageWithWatched(watched: {
    entry: WatchEntry;
    newCommentCount: number;
  }): Promise<void> {
    const postId = watched.entry.postId;
    let post: PostLike;
    try {
      post = (await this.service.client.getPost(postId)) as PostLike;
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: watched post ${postId} could not be fetched for engagement: ${String(err)}`,
      );
      return;
    }

    const threadComments = await this.fetchThreadComments(postId);
    const prompt = this.buildPrompt("watched", post, threadComments);
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
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: watched-engagement generation failed for ${postId}: ${String(err)}`,
      );
      this.service.recordLlmCall?.("failure");
      return;
    }

    const cleanedRaw = cleanGeneratedPost(generated);
    if (!cleanedRaw) return;

    // v0.16.0: model-error + LLM-artifact gate before anything downstream.
    const validated = validateGeneratedOutput(cleanedRaw);
    if (!validated.ok) {
      if (validated.reason === "model_error") {
        logger.warn(
          `COLONY_ENGAGEMENT_CLIENT: dropping model-error output on watched post ${postId}: ${cleanedRaw.slice(0, 120)}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        this.service.recordLlmCall?.("failure");
      }
      return;
    }
    const rawContent = validated.content;

    const { parentCommentId, cleanedBody } = this.extractReplyTarget(
      rawContent,
      threadComments,
    );
    const content = cleanedBody || rawContent;

    if (this.config.selfCheck ?? true) {
      const score = await scorePost(this.runtime, {
        title: `comment on ${post.title ?? postId}`,
        body: content,
      }, {
        bannedPatterns: this.config.bannedPatterns,
        modelType: this.config.scorerModelType,
      });
      if (score === "SPAM" || score === "INJECTION" || score === "BANNED") {
        logger.warn(
          `🌐 COLONY_ENGAGEMENT_CLIENT: self-check rejected watched-post comment as ${score}`,
        );
        this.service.incrementStat?.("selfCheckRejections");
        return;
      }
    }

    // Approval mode: queue instead of publishing
    if (this.config.approvalRequired && this.config.draftQueue) {
      await this.config.draftQueue.enqueue("comment", "engagement_client", {
        postId,
        body: content,
        ...(parentCommentId ? { parentCommentId } : {}),
      });
      await this.updateWatchBaseline(watched.entry.postId, watched.newCommentCount);
      return;
    }

    if (this.config.dryRun) {
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT [DRY RUN] would engage watched post ${postId}: ${content.slice(0, 80)}...`,
      );
      await this.updateWatchBaseline(watched.entry.postId, watched.newCommentCount);
      return;
    }

    try {
      await this.service.client.createComment(postId, content, parentCommentId);
      logger.info(
        `🌐 COLONY_ENGAGEMENT_CLIENT commented on watched post ${postId}${parentCommentId ? ` (threaded under ${parentCommentId.slice(0, 8)})` : ""}`,
      );
      this.service.incrementStat?.("commentsCreated", "autonomous");
      this.service.recordActivity?.(
        "comment_created",
        postId,
        `watched-engagement${parentCommentId ? " threaded" : ""}`,
      );
      emitEvent(this.config.logFormat ?? "text", {
        level: "info",
        event: "comment.created",
        postId,
        bodyLength: content.length,
        autonomous: true,
        watched: true,
        parentCommentId,
      }, `watched-engagement comment on ${postId}`);
      await this.updateWatchBaseline(watched.entry.postId, watched.newCommentCount);
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: watched-engagement createComment(${postId}) failed: ${String(err)}`,
      );
    }
  }

  private async updateWatchBaseline(
    postId: string,
    newBaseline: number,
  ): Promise<void> {
    const username = (this.service as unknown as { username?: string }).username;
    const list = await readWatchList(this.runtime, username);
    const next = list.map((e) =>
      e.postId === postId ? { ...e, lastCommentCount: newBaseline } : e,
    );
    await writeWatchList(this.runtime, username, next);
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

  // v0.17.0: per-author reaction cooldown. Each entry is `{ts: number}`
  // per author; we keep a rolling list pruned to the window.

  private authorReactionCacheKey(authorUsername: string): string {
    const self =
      (this.service as unknown as { username?: string }).username ?? "unknown";
    return `colony/engagement-client/author-reactions/${self}/${authorUsername}`;
  }

  private async readAuthorReactionTimestamps(
    authorUsername: string,
  ): Promise<number[]> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return [];
    const cached = await rt.getCache<number[]>(
      this.authorReactionCacheKey(authorUsername),
    );
    return Array.isArray(cached) ? cached : [];
  }

  private async isAuthorReactionCoolingDown(
    authorUsername: string,
  ): Promise<boolean> {
    const { reactionAuthorLimit: limit, reactionAuthorWindowMs: windowMs } =
      this.service.colonyConfig;
    if (limit <= 0 || windowMs <= 0) return false;
    const timestamps = await this.readAuthorReactionTimestamps(authorUsername);
    const cutoff = Date.now() - windowMs;
    const recent = timestamps.filter((ts) => ts > cutoff);
    return recent.length >= limit;
  }

  private async recordAuthorReaction(authorUsername: string): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    const windowMs = this.service.colonyConfig.reactionAuthorWindowMs;
    const cutoff = Date.now() - windowMs;
    const current = await this.readAuthorReactionTimestamps(authorUsername);
    const next = [...current.filter((ts) => ts > cutoff), Date.now()];
    await rt.setCache(this.authorReactionCacheKey(authorUsername), next);
  }
}
