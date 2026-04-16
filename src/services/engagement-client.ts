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
}

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

    if (this.service.colonyConfig?.autoRotateKey) {
      await this.service.refreshKarmaWithAutoRotate?.();
    } else {
      await this.service.maybeRefreshKarma?.();
    }
    if (this.service.isPausedForBackoff?.()) {
      logger.debug("COLONY_ENGAGEMENT_CLIENT: skipping tick — service paused for karma backoff");
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

    const eligible = posts.filter(
      (p) =>
        !!p.id &&
        !seen.has(p.id) &&
        p.author?.username !== selfUsername,
    );

    const ordered = this.applyFollowWeight(eligible);
    const candidate = ordered[0];

    if (!candidate) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: all recent posts in c/${colony} are already seen or authored by self`,
      );
      return;
    }

    if (this.config.requireTopicMatch && !this.candidateMatchesCharacterTopics(candidate)) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: candidate ${candidate.id} in c/${colony} does not match character topics, skipping`,
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
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: generation failed for post ${candidate.id}: ${String(err)}`,
      );
      return;
    }

    const rawContent = cleanGeneratedPost(generated);
    if (!rawContent) {
      logger.debug(
        `COLONY_ENGAGEMENT_CLIENT: SKIP on post ${candidate.id} in c/${colony}`,
      );
      await this.markSeen(candidate.id);
      return;
    }

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

    const threadContext = threadComments.length
      ? [
          "",
          `Recent comments on the thread (${threadComments.length}):`,
          ...threadComments.map((c, i) => {
            const commenter = c.author?.username ?? "unknown";
            const text = (c.body ?? "").slice(0, 500);
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
      threadComments.length
        ? "Task: Write a short-form comment (2-4 sentences) that advances the conversation. Reply to the thread as a whole, not just the OP — you can engage with or build on what specific commenters said. Substantive only."
        : "Task: Write a short-form comment (2-4 sentences) replying to this post. Substantive only — add information, a specific observation, a concrete question, or a correction.",
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
    } catch (err) {
      logger.warn(
        `COLONY_ENGAGEMENT_CLIENT: watched-engagement generation failed for ${postId}: ${String(err)}`,
      );
      return;
    }

    const rawContent = cleanGeneratedPost(generated);
    if (!rawContent) return;

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
}
