import type { IAgentRuntime } from "@elizaos/core";
import type { DmPromptMode } from "./services/dm-prompt-framing.js";
import {
  parseNotificationPolicy,
  type NotificationPolicy,
} from "./services/notification-router.js";
import { getSetting } from "./utils/settings.js";

export interface ColonyConfig {
  apiKey: string;
  defaultColony: string;
  feedLimit: number;
  pollEnabled: boolean;
  pollIntervalMs: number;
  coldStartWindowMs: number;
  notificationTypesIgnore: Set<string>;
  /**
   * v0.22.0: per-type routing policy. Empty map ⇒ every type falls back
   * to `notificationTypesIgnore` (drop) or `dispatch`. Entries present
   * here override the legacy ignore set.
   */
  notificationPolicy: Map<string, NotificationPolicy>;
  dryRun: boolean;
  postEnabled: boolean;
  postIntervalMinMs: number;
  postIntervalMaxMs: number;
  postColony: string;
  postMaxTokens: number;
  postTemperature: number;
  postStyleHint: string;
  postRecentTopicMemory: boolean;
  engageEnabled: boolean;
  engageIntervalMinMs: number;
  engageIntervalMaxMs: number;
  engageColonies: string[];
  engageCandidateLimit: number;
  engageMaxTokens: number;
  engageTemperature: number;
  engageStyleHint: string;
  selfCheckEnabled: boolean;
  postDailyLimit: number;
  karmaBackoffDrop: number;
  karmaBackoffWindowMs: number;
  karmaBackoffCooldownMs: number;
  engageThreadComments: number;
  engageRequireTopicMatch: boolean;
  mentionMinKarma: number;
  postDefaultType: string;
  mentionThreadComments: number;
  bannedPatterns: RegExp[];
  postModelType: string;
  engageModelType: string;
  scorerModelType: string;
  registerSignalHandlers: boolean;
  logFormat: "text" | "json";
  retryQueueEnabled: boolean;
  retryQueueMaxAttempts: number;
  retryQueueMaxAgeMs: number;
  engageReactionMode: boolean;
  autoRotateKey: boolean;
  selfCheckRetry: boolean;
  activityWebhookUrl: string;
  activityWebhookSecret: string;
  engageFollowWeight: "off" | "soft" | "strict";
  engagePreferredAuthors: string[];
  postApprovalRequired: boolean;
  /**
   * v0.17.0: UTC-hour quiet windows. `null` = disabled. When the current UTC
   * hour falls inside the window, the corresponding autonomy loop skips its
   * tick. Reactive polling is unaffected — humans may expect DM replies at
   * any hour. Parsed from e.g. "23-7" into `{startHour: 23, endHour: 7}`;
   * the window wraps midnight when `endHour <= startHour`.
   */
  postQuietHours: { startHour: number; endHour: number } | null;
  engageQuietHours: { startHour: number; endHour: number } | null;
  /**
   * v0.17.0: LLM-health auto-pause. When the fraction of failed useModel
   * calls in the last `llmFailureWindowMs` exceeds `llmFailureThreshold`,
   * the service pauses both autonomy loops for `llmFailureCooldownMs`. The
   * pause shares `pausedUntilTs` with the karma-backoff pause — operators
   * have one "is the agent paused?" check.
   *
   * Disabled by default (`llmFailureThreshold: 0` → never triggers).
   */
  llmFailureThreshold: number;
  llmFailureWindowMs: number;
  llmFailureCooldownMs: number;
  /**
   * v0.17.0: per-author reaction cooldown. After `reactionAuthorLimit`
   * reactions to the same author within `reactionAuthorWindowMs`, further
   * reactions to that author are skipped. Comments (substantive engagement)
   * are unaffected. Avoids sycophancy patterns where the agent nods at
   * every post from the same high-karma author.
   */
  reactionAuthorLimit: number;
  reactionAuthorWindowMs: number;
  /**
   * v0.18.0: target length for autonomous engagement comments. Drives
   * both the prompt's length language and the default `engageMaxTokens`
   * (when not overridden). `short` = 2-4 sentences (the v0.17 default),
   * `medium` = 1-2 substantive paragraphs (the new default), `long` =
   * 3-4 paragraphs with concrete claims/numbers/refs. Operators who
   * want a precise token cap can still set COLONY_ENGAGE_MAX_TOKENS
   * explicitly to override.
   */
  engageLengthTarget: "short" | "medium" | "long";
  /**
   * v0.19.0: content-diversity watchdog. Tracks similarity of the last
   * `diversityWindowSize` autonomous-post outputs; if all pairs exceed
   * the active-mode threshold, the post loop pauses for
   * `diversityCooldownMs`. Defence against the "stuck in a rut" failure
   * where a small local model falls into an attractor state and emits
   * variants of the same post over and over.
   *
   * `diversityThreshold: 0` disables the watchdog entirely. Engagement
   * loop is NOT gated — replies to different posts are naturally
   * diverse, and false positives there would mute thread engagement.
   */
  diversityWindowSize: number;
  diversityThreshold: number;
  diversityNgram: number;
  diversityCooldownMs: number;
  /**
   * v0.29.0: diversity watchdog backend mode.
   *
   * - `"lexical"` (default) — Jaccard similarity on n-gram shingles.
   *   Byte-for-byte v0.19 – v0.28 behaviour. Catches surface-form
   *   duplicates, misses rotated-vocabulary rephrasings of the same
   *   concept.
   * - `"semantic"` — cosine similarity between embedding vectors. The
   *   caller computes the embedding via `runtime.useModel(TEXT_EMBEDDING)`
   *   and the watchdog compares vectors. Catches concept-level
   *   near-duplicates that Jaccard misses. Falls back to lexical if
   *   the embedding call fails.
   * - `"both"` — trips when EITHER check trips. Strictest; recommended
   *   for agents with a documented monoculture tendency.
   *
   * Configured via `COLONY_DIVERSITY_MODE`. Unknown values fail open
   * to `"lexical"`.
   */
  diversityMode: "lexical" | "semantic" | "both";
  /**
   * v0.29.0: client-side comment-dedup ring. When enabled, every
   * `createComment` emission (engagement client, `COMMENT_ON_COLONY_POST`,
   * `REPLY_COMMENT_ON_COLONY_POST`) first checks the generated body
   * against the last N comments emitted from any path using n-gram
   * Jaccard. Near-duplicates are skipped before the API round-trip,
   * avoiding the `ColonyConflictError: You have already posted this
   * comment recently` observed in the eliza-gemma log.
   *
   * Default `true`. Disable via `COLONY_COMMENT_DEDUP_ENABLED=false` to
   * let the server-side dedup handle it instead (useful for operators
   * verifying server behaviour).
   */
  commentDedupEnabled: boolean;
  /**
   * v0.29.0: how many recent comment bodies the dedup ring tracks.
   * Default 16 (~30 min at eliza-gemma's engagement cadence).
   * Configured via `COLONY_COMMENT_DEDUP_RING_SIZE`. Clamped [1, 256]
   * — a larger ring inflates the per-check scan cost without adding
   * useful precision.
   */
  commentDedupRingSize: number;
  /**
   * v0.29.0: Jaccard threshold for the dedup ring. Default 0.7
   * (slightly looser than the DiversityWatchdog's 0.8 because we want
   * to err on the side of skipping ambiguous near-duplicates rather
   * than eating a 409). Configured via `COLONY_COMMENT_DEDUP_THRESHOLD`.
   */
  commentDedupThreshold: number;
  /**
   * v0.29.0: cosine-similarity threshold for semantic mode. Default
   * `0.85`. Configured via `COLONY_DIVERSITY_SEMANTIC_THRESHOLD`. Only
   * consulted when `diversityMode` is `"semantic"` or `"both"`.
   *
   * Slightly tighter than the lexical default (0.80) because embeddings
   * normalise out the vocabulary variance that Jaccard wouldn't forgive
   * anyway — two posts that genuinely cover the same concept will
   * routinely hit 0.85+ cosine even with fully-rotated surface terms.
   */
  diversitySemanticThreshold: number;
  /**
   * v0.19.0: operator kill-switch via DM. When a DM arrives from a
   * username matching `operatorUsername` and starts with
   * `operatorPrefix`, the command is parsed and applied directly to
   * plugin state — `!pause <mins>`, `!resume`, `!status`,
   * `!drop-last-comment`. The DM bypasses the LLM routing entirely.
   * Empty `operatorUsername` disables the feature.
   */
  operatorUsername: string;
  operatorPrefix: string;
  /**
   * v0.19.0: per-conversation DM context window. When generating a
   * reply to a DM, include the last N messages from the thread in the
   * memory passed to `handleMessage`. Default 0 (current behaviour:
   * only the latest message). Set to e.g. 6 for multi-turn coherence.
   */
  dmContextMessages: number;
  /**
   * v0.20.0: when `true`, the engagement client pulls candidates from
   * `GET /trending/posts/rising` instead of `getPosts({sort: "new"})`.
   * Rising is cross-colony — `engageColonies` is ignored when this is
   * on. Off by default preserves v0.19 per-colony rotation.
   */
  engageUseRising: boolean;
  /**
   * v0.20.0: when `true`, the engagement client periodically fetches
   * `GET /trending/tags` and uses the result to reorder eligible
   * candidates — posts whose tags intersect with BOTH the character's
   * `topics` AND the currently-trending tag set rank first.
   * `engageTrendingRefreshMs` controls the cache TTL.
   */
  engageTrendingBoost: boolean;
  engageTrendingRefreshMs: number;
  /**
   * v0.23.0: when `true`, the interaction client's poll interval is
   * multiplied by a graded factor derived from recent LLM-failure rate.
   * Complements the v0.17 binary LLM-health pause — instead of going
   * from 1× directly to paused, we can ramp the interval up gradually
   * as failure rate climbs, slowing ingest pressure on a struggling
   * Ollama without cutting the agent off entirely.
   *
   * Disabled by default (preserves v0.22 behaviour).
   */
  adaptivePollEnabled: boolean;
  /**
   * v0.23.0: cap on the poll-interval multiplier. At max the poll rate
   * drops to `baseInterval × maxMultiplier`. Clamped to [1.0, 20.0] at
   * parse time — 20× of a 2-minute interval = 40-minute poll, which is
   * already "functionally paused" territory.
   */
  adaptivePollMaxMultiplier: number;
  /**
   * v0.23.0: failure-rate below which no adaptive slowdown applies
   * (multiplier stays at 1.0). Above this, the multiplier scales
   * linearly toward `adaptivePollMaxMultiplier` at rate=1.0. Clamped
   * to [0, 0.99] at parse time. Default 0.25 = "25% of LLM calls in
   * the v0.17 failure window must fail before the adaptive logic
   * starts slowing the poll."
   */
  adaptivePollWarnThreshold: number;
  /**
   * v0.23.0: minimum sender-karma floor for DM-origin memories. When
   * set (> 0), DMs whose sender has karma below this threshold are
   * marked-read and dropped BEFORE dispatch through
   * `messageService.handleMessage`, cutting off the remaining
   * sockpuppet-style attack vector left open by v0.21's DM action
   * guards (v0.21 blocks mutating actions; this blocks reply
   * generation itself). Operator kill-switch commands are evaluated
   * before this gate and unaffected. Default 0 = disabled.
   */
  dmMinKarma: number;
  /**
   * v0.28.0: catch-up mode. When an autonomy-loop tick (post / engagement)
   * runs longer than `catchupThresholdMs`, the notification feed may have
   * grown during the GPU-locked window. After such a tick, the plugin fires
   * an immediate `interactionClient.tickNow()` to clear the backlog without
   * waiting for the next scheduled poll interval.
   *
   * `0` disables the feature entirely (no timing overhead, no catch-up
   * firings — preserves v0.27 behaviour). Default: 30000ms (30 s) — shorter
   * than typical poll intervals, so a tick exceeding it genuinely indicates
   * the feed is likely stale by comparison.
   */
  catchupThresholdMs: number;
  /**
   * v0.28.0: engagement-client thread-context compression. Controls how
   * verbose each thread-comment entry is in the engagement prompt.
   *
   * - `"verbatim"` (default) — each comment body kept up to 500 chars,
   *   full `[id=...]` tags. Preserves v0.27 behaviour exactly.
   * - `"abridged"` — each comment body truncated to 150 chars; id tags
   *   preserved (needed for `<reply_to>` threading) but formatting is
   *   compact. Roughly 3–4× less prompt tokens for the thread context,
   *   which matters for VRAM-constrained local agents with limited KV
   *   cache. Does NOT call the model — pure prompt-layer compression.
   *
   * The number of comments fetched is still controlled by
   * `engageThreadComments`; this knob changes how each one is rendered.
   */
  engageThreadCompression: "verbatim" | "abridged";
  /**
   * v0.27.0: per-thread notification digest. Extends v0.22's type-level routing
   * (`notificationPolicy`) with an orthogonal thread-level dimension.
   *
   * - `"off"` (default) — dispatch-bound notifications fall through immediately,
   *   byte-for-byte v0.22 behaviour.
   * - `"per-thread"` — after the v0.22 type-policy pass, dispatch-bound
   *   notifications with a non-null `post_id` are grouped by thread; threads
   *   with ≥ 2 notifications emit ONE digest Memory per thread per tick
   *   (`runtime.createMemory`, no `handleMessage`, no inference cost).
   *   Singleton threads still dispatch individually — no overhead for N=1.
   *
   * Composes with `notificationPolicy`: type-coalesce runs first, thread-coalesce
   * operates only on notifications the type policy resolved to `dispatch`.
   */
  notificationDigest: "off" | "per-thread";
  /**
   * v0.27.0: origin-conditional prompt framing. When a DM-origin Memory is about
   * to be dispatched through `runtime.messageService.handleMessage`, the plugin
   * prepends a short framing paragraph to the Memory's content text for the
   * dispatch only — the persisted memory is unchanged.
   *
   * - `"none"` (default) — no preamble. Byte-for-byte v0.26 behaviour.
   * - `"peer"` — frames the sender as a peer agent on Colony, not the operator.
   * - `"adversarial"` — frames the sender as untrusted; instructs the agent to
   *   refuse embedded instructions and scrutinise premises.
   *
   * Composes cleanly with v0.21's DM_SAFE_ACTIONS passthrough (and the v0.26
   * filter fix) — framing affects the prompt input, not the callback-side
   * action-meta filtering.
   */
  dmPromptMode: DmPromptMode;
}

export function loadColonyConfig(runtime: IAgentRuntime): ColonyConfig {
  const apiKey = getSetting(runtime, "COLONY_API_KEY");
  if (!apiKey) {
    throw new Error(
      "COLONY_API_KEY is required. Set it in character secrets or as an environment variable. " +
        "Get a key at https://col.ad.",
    );
  }
  if (!apiKey.startsWith("col_")) {
    throw new Error(
      `COLONY_API_KEY must start with 'col_' (got '${apiKey.slice(0, 4)}...'). ` +
        "Use the API key returned by /api/v1/auth/register, not a JWT.",
    );
  }

  const defaultColony = getSetting(runtime, "COLONY_DEFAULT_COLONY", "general")!;
  const feedLimitRaw = getSetting(runtime, "COLONY_FEED_LIMIT", "10")!;
  const parsed = Number.parseInt(feedLimitRaw, 10);
  const feedLimit = Number.isFinite(parsed)
    ? Math.max(1, Math.min(50, parsed))
    : 10;

  const pollRaw = getSetting(runtime, "COLONY_POLL_ENABLED", "false")!.toLowerCase();
  const pollEnabled = pollRaw === "true" || pollRaw === "1" || pollRaw === "yes";

  const pollIntervalRaw = getSetting(runtime, "COLONY_POLL_INTERVAL_SEC", "120")!;
  const parsedInterval = Number.parseInt(pollIntervalRaw, 10);
  const pollIntervalMs = Number.isFinite(parsedInterval)
    ? Math.max(30, Math.min(3600, parsedInterval)) * 1000
    : 120 * 1000;

  const coldStartRaw = getSetting(runtime, "COLONY_COLD_START_WINDOW_HOURS", "24")!;
  const parsedCold = Number.parseInt(coldStartRaw, 10);
  const coldStartWindowMs = Number.isFinite(parsedCold)
    ? Math.max(0, Math.min(720, parsedCold)) * 3600 * 1000
    : 24 * 3600 * 1000;

  const postRaw = getSetting(runtime, "COLONY_POST_ENABLED", "false")!.toLowerCase();
  const postEnabled = postRaw === "true" || postRaw === "1" || postRaw === "yes";

  const postMinRaw = getSetting(runtime, "COLONY_POST_INTERVAL_MIN_SEC", "5400")!;
  const parsedPostMin = Number.parseInt(postMinRaw, 10);
  const postIntervalMinMs = Number.isFinite(parsedPostMin)
    ? Math.max(60, Math.min(86_400, parsedPostMin)) * 1000
    : 5400 * 1000;

  const postMaxRaw = getSetting(runtime, "COLONY_POST_INTERVAL_MAX_SEC", "10800")!;
  const parsedPostMax = Number.parseInt(postMaxRaw, 10);
  const postIntervalMaxMs = Number.isFinite(parsedPostMax)
    ? Math.max(postIntervalMinMs / 1000, Math.min(86_400, parsedPostMax)) * 1000
    : 10800 * 1000;

  const postColony = getSetting(runtime, "COLONY_POST_COLONY", defaultColony)!;

  const postMaxTokensRaw = getSetting(runtime, "COLONY_POST_MAX_TOKENS", "280")!;
  const parsedPostMaxTokens = Number.parseInt(postMaxTokensRaw, 10);
  const postMaxTokens = Number.isFinite(parsedPostMaxTokens)
    ? Math.max(32, Math.min(2000, parsedPostMaxTokens))
    : 280;

  const postTempRaw = getSetting(runtime, "COLONY_POST_TEMPERATURE", "0.9")!;
  const parsedPostTemp = Number.parseFloat(postTempRaw);
  const postTemperature = Number.isFinite(parsedPostTemp)
    ? Math.max(0, Math.min(2, parsedPostTemp))
    : 0.9;

  const ignoreRaw = getSetting(runtime, "COLONY_NOTIFICATION_TYPES_IGNORE", "vote,follow,award,tip_received")!;
  const notificationTypesIgnore = new Set(
    ignoreRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  // v0.22.0: explicit per-type routing. Format:
  //   "<type>:<policy>(,<type>:<policy>)*"
  // Recommended for busy agents: `vote:coalesce,reaction:coalesce,follow:coalesce,award:coalesce,tip_received:coalesce`
  // Empty string ⇒ empty map ⇒ fall back entirely on the legacy ignore
  // set + default dispatch (pre-v0.22 behaviour).
  const policyRaw = getSetting(runtime, "COLONY_NOTIFICATION_POLICY", "")!;
  const notificationPolicy = parseNotificationPolicy(policyRaw);

  const engageRaw = getSetting(runtime, "COLONY_ENGAGE_ENABLED", "false")!.toLowerCase();
  const engageEnabled = engageRaw === "true" || engageRaw === "1" || engageRaw === "yes";

  const engageMinRaw = getSetting(runtime, "COLONY_ENGAGE_INTERVAL_MIN_SEC", "1800")!;
  const parsedEngageMin = Number.parseInt(engageMinRaw, 10);
  const engageIntervalMinMs = Number.isFinite(parsedEngageMin)
    ? Math.max(60, Math.min(86_400, parsedEngageMin)) * 1000
    : 1800 * 1000;

  const engageMaxRaw = getSetting(runtime, "COLONY_ENGAGE_INTERVAL_MAX_SEC", "3600")!;
  const parsedEngageMax = Number.parseInt(engageMaxRaw, 10);
  const engageIntervalMaxMs = Number.isFinite(parsedEngageMax)
    ? Math.max(engageIntervalMinMs / 1000, Math.min(86_400, parsedEngageMax)) * 1000
    : 3600 * 1000;

  const engageColoniesRaw = getSetting(
    runtime,
    "COLONY_ENGAGE_COLONIES",
    defaultColony,
  )!;
  const engageColonies = engageColoniesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const engageCandidateLimitRaw = getSetting(
    runtime,
    "COLONY_ENGAGE_CANDIDATE_LIMIT",
    "5",
  )!;
  const parsedEngageLimit = Number.parseInt(engageCandidateLimitRaw, 10);
  const engageCandidateLimit = Number.isFinite(parsedEngageLimit)
    ? Math.max(1, Math.min(20, parsedEngageLimit))
    : 5;

  // v0.18.0: COLONY_ENGAGE_LENGTH drives both the prompt's length language
  // and the default token budget. Three presets mapped to (tokens, prompt
  // phrase) pairs in src/services/engagement-client.ts. Default is "medium"
  // because v0.17 shipped 2-sentence comments by default — operators were
  // observing that as too terse for substantive thread engagement.
  const engageLengthRaw = getSetting(
    runtime,
    "COLONY_ENGAGE_LENGTH",
    "medium",
  )!.toLowerCase().trim();
  const engageLengthTarget: "short" | "medium" | "long" =
    engageLengthRaw === "short"
      ? "short"
      : engageLengthRaw === "long"
        ? "long"
        : "medium";
  const lengthTargetMaxTokens =
    engageLengthTarget === "short" ? 240 : engageLengthTarget === "long" ? 800 : 500;

  // COLONY_ENGAGE_MAX_TOKENS is an explicit override — when set, it wins
  // over the length-target default. Lets operators tune precisely without
  // changing the prompt language.
  const engageMaxTokensExplicit = getSetting(runtime, "COLONY_ENGAGE_MAX_TOKENS");
  const engageMaxTokensRaw =
    engageMaxTokensExplicit !== undefined
      ? engageMaxTokensExplicit
      : String(lengthTargetMaxTokens);
  const parsedEngageMaxTokens = Number.parseInt(engageMaxTokensRaw, 10);
  const engageMaxTokens = Number.isFinite(parsedEngageMaxTokens)
    ? Math.max(32, Math.min(2000, parsedEngageMaxTokens))
    : lengthTargetMaxTokens;

  const engageTempRaw = getSetting(runtime, "COLONY_ENGAGE_TEMPERATURE", "0.8")!;
  const parsedEngageTemp = Number.parseFloat(engageTempRaw);
  const engageTemperature = Number.isFinite(parsedEngageTemp)
    ? Math.max(0, Math.min(2, parsedEngageTemp))
    : 0.8;

  const dryRunRaw = getSetting(runtime, "COLONY_DRY_RUN", "false")!.toLowerCase();
  const dryRun = dryRunRaw === "true" || dryRunRaw === "1" || dryRunRaw === "yes";

  const postStyleHint = getSetting(runtime, "COLONY_POST_STYLE_HINT", "")!.trim();
  const engageStyleHint = getSetting(runtime, "COLONY_ENGAGE_STYLE_HINT", "")!.trim();

  const topicMemoryRaw = getSetting(runtime, "COLONY_POST_RECENT_TOPIC_MEMORY", "true")!.toLowerCase();
  const postRecentTopicMemory =
    topicMemoryRaw === "true" || topicMemoryRaw === "1" || topicMemoryRaw === "yes";

  const selfCheckRaw = getSetting(runtime, "COLONY_SELF_CHECK_ENABLED", "true")!.toLowerCase();
  const selfCheckEnabled =
    selfCheckRaw === "true" || selfCheckRaw === "1" || selfCheckRaw === "yes";

  const dailyLimitRaw = getSetting(runtime, "COLONY_POST_DAILY_LIMIT", "24")!;
  const parsedDailyLimit = Number.parseInt(dailyLimitRaw, 10);
  const postDailyLimit = Number.isFinite(parsedDailyLimit)
    ? Math.max(1, Math.min(500, parsedDailyLimit))
    : 24;

  const karmaDropRaw = getSetting(runtime, "COLONY_KARMA_BACKOFF_DROP", "10")!;
  const parsedKarmaDrop = Number.parseInt(karmaDropRaw, 10);
  const karmaBackoffDrop = Number.isFinite(parsedKarmaDrop)
    ? Math.max(1, Math.min(10_000, parsedKarmaDrop))
    : 10;

  const karmaWindowRaw = getSetting(runtime, "COLONY_KARMA_BACKOFF_WINDOW_HOURS", "6")!;
  const parsedKarmaWindow = Number.parseInt(karmaWindowRaw, 10);
  const karmaBackoffWindowMs = Number.isFinite(parsedKarmaWindow)
    ? Math.max(1, Math.min(168, parsedKarmaWindow)) * 3600 * 1000
    : 6 * 3600 * 1000;

  const karmaCooldownRaw = getSetting(runtime, "COLONY_KARMA_BACKOFF_COOLDOWN_MIN", "120")!;
  const parsedKarmaCooldown = Number.parseInt(karmaCooldownRaw, 10);
  const karmaBackoffCooldownMs = Number.isFinite(parsedKarmaCooldown)
    ? Math.max(1, Math.min(10_080, parsedKarmaCooldown)) * 60 * 1000
    : 120 * 60 * 1000;

  const threadCommentsRaw = getSetting(runtime, "COLONY_ENGAGE_THREAD_COMMENTS", "3")!;
  const parsedThreadComments = Number.parseInt(threadCommentsRaw, 10);
  const engageThreadComments = Number.isFinite(parsedThreadComments)
    ? Math.max(0, Math.min(10, parsedThreadComments))
    : 3;

  const requireTopicRaw = getSetting(runtime, "COLONY_ENGAGE_REQUIRE_TOPIC_MATCH", "false")!.toLowerCase();
  const engageRequireTopicMatch =
    requireTopicRaw === "true" || requireTopicRaw === "1" || requireTopicRaw === "yes";

  const mentionMinKarmaRaw = getSetting(runtime, "COLONY_MENTION_MIN_KARMA", "0")!;
  const parsedMentionMinKarma = Number.parseInt(mentionMinKarmaRaw, 10);
  const mentionMinKarma = Number.isFinite(parsedMentionMinKarma)
    ? Math.max(0, Math.min(10_000, parsedMentionMinKarma))
    : 0;

  const postDefaultTypeRaw = getSetting(runtime, "COLONY_POST_DEFAULT_TYPE", "discussion")!.toLowerCase().trim();
  const postDefaultType = ["discussion", "finding", "question", "analysis"].includes(postDefaultTypeRaw)
    ? postDefaultTypeRaw
    : "discussion";

  const mentionThreadRaw = getSetting(runtime, "COLONY_MENTION_THREAD_COMMENTS", "3")!;
  const parsedMentionThread = Number.parseInt(mentionThreadRaw, 10);
  const mentionThreadComments = Number.isFinite(parsedMentionThread)
    ? Math.max(0, Math.min(10, parsedMentionThread))
    : 3;

  const bannedRaw = getSetting(runtime, "COLONY_BANNED_PATTERNS", "")!;
  const bannedPatterns: RegExp[] = [];
  for (const part of bannedRaw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      bannedPatterns.push(new RegExp(trimmed, "i"));
    } catch {
      // Skip invalid regex — don't crash config load on one bad pattern
    }
  }

  const VALID_MODEL_TYPES = new Set(["TEXT_SMALL", "TEXT_LARGE"]);
  const normalizeModelType = (raw: string, fallback = "TEXT_SMALL"): string => {
    const up = raw.toUpperCase().trim();
    return VALID_MODEL_TYPES.has(up) ? up : fallback;
  };
  const postModelType = normalizeModelType(
    getSetting(runtime, "COLONY_POST_MODEL_TYPE", "TEXT_SMALL")!,
  );
  const engageModelType = normalizeModelType(
    getSetting(runtime, "COLONY_ENGAGE_MODEL_TYPE", "TEXT_SMALL")!,
  );
  const scorerModelType = normalizeModelType(
    getSetting(runtime, "COLONY_SCORER_MODEL_TYPE", "TEXT_SMALL")!,
  );

  const registerSignalRaw = getSetting(runtime, "COLONY_REGISTER_SIGNAL_HANDLERS", "false")!.toLowerCase();
  const registerSignalHandlers =
    registerSignalRaw === "true" || registerSignalRaw === "1" || registerSignalRaw === "yes";

  const logFormatRaw = getSetting(runtime, "COLONY_LOG_FORMAT", "text")!.toLowerCase().trim();
  const logFormat: "text" | "json" = logFormatRaw === "json" ? "json" : "text";

  const retryQueueRaw = getSetting(runtime, "COLONY_RETRY_QUEUE_ENABLED", "true")!.toLowerCase();
  const retryQueueEnabled =
    retryQueueRaw === "true" || retryQueueRaw === "1" || retryQueueRaw === "yes";

  const retryAttemptsRaw = getSetting(runtime, "COLONY_RETRY_QUEUE_MAX_ATTEMPTS", "3")!;
  const parsedRetryAttempts = Number.parseInt(retryAttemptsRaw, 10);
  const retryQueueMaxAttempts = Number.isFinite(parsedRetryAttempts)
    ? Math.max(1, Math.min(10, parsedRetryAttempts))
    : 3;

  const retryAgeRaw = getSetting(runtime, "COLONY_RETRY_QUEUE_MAX_AGE_MIN", "60")!;
  const parsedRetryAge = Number.parseInt(retryAgeRaw, 10);
  const retryQueueMaxAgeMs = Number.isFinite(parsedRetryAge)
    ? Math.max(1, Math.min(10_080, parsedRetryAge)) * 60 * 1000
    : 60 * 60 * 1000;

  const reactionModeRaw = getSetting(runtime, "COLONY_ENGAGE_REACTION_MODE", "false")!.toLowerCase();
  const engageReactionMode =
    reactionModeRaw === "true" || reactionModeRaw === "1" || reactionModeRaw === "yes";

  const rotateKeyRaw = getSetting(runtime, "COLONY_AUTO_ROTATE_KEY", "false")!.toLowerCase();
  const autoRotateKey =
    rotateKeyRaw === "true" || rotateKeyRaw === "1" || rotateKeyRaw === "yes";

  const retryCheckRaw = getSetting(runtime, "COLONY_SELF_CHECK_RETRY", "false")!.toLowerCase();
  const selfCheckRetry =
    retryCheckRaw === "true" || retryCheckRaw === "1" || retryCheckRaw === "yes";

  const activityWebhookUrl = getSetting(runtime, "COLONY_ACTIVITY_WEBHOOK_URL", "")!.trim();
  const activityWebhookSecret = getSetting(runtime, "COLONY_ACTIVITY_WEBHOOK_SECRET", "")!.trim();

  const followWeightRaw = getSetting(runtime, "COLONY_ENGAGE_FOLLOW_WEIGHT", "off")!.toLowerCase().trim();
  const engageFollowWeight: "off" | "soft" | "strict" =
    followWeightRaw === "strict" ? "strict" : followWeightRaw === "soft" ? "soft" : "off";

  const preferredAuthorsRaw = getSetting(runtime, "COLONY_ENGAGE_PREFERRED_AUTHORS", "")!;
  const engagePreferredAuthors = preferredAuthorsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const postApprovalRaw = getSetting(runtime, "COLONY_POST_APPROVAL", "false")!.toLowerCase();
  const postApprovalRequired =
    postApprovalRaw === "true" || postApprovalRaw === "1" || postApprovalRaw === "yes";

  const postQuietHours = parseQuietHours(
    getSetting(runtime, "COLONY_POST_QUIET_HOURS", "")!,
  );
  const engageQuietHours = parseQuietHours(
    getSetting(runtime, "COLONY_ENGAGE_QUIET_HOURS", "")!,
  );

  // v0.17.0: LLM-health auto-pause. Default threshold = 0 → disabled.
  const llmFailureThresholdRaw = Number(
    getSetting(runtime, "COLONY_LLM_FAILURE_THRESHOLD", "0"),
  );
  const llmFailureThreshold = Number.isFinite(llmFailureThresholdRaw)
    ? Math.max(0, Math.min(1, llmFailureThresholdRaw))
    : 0;
  const llmFailureWindowMin = Number(
    getSetting(runtime, "COLONY_LLM_FAILURE_WINDOW_MIN", "10"),
  );
  const llmFailureWindowMs =
    (Number.isFinite(llmFailureWindowMin) && llmFailureWindowMin > 0
      ? llmFailureWindowMin
      : 10) * 60_000;
  const llmFailureCooldownMin = Number(
    getSetting(runtime, "COLONY_LLM_FAILURE_COOLDOWN_MIN", "30"),
  );
  const llmFailureCooldownMs =
    (Number.isFinite(llmFailureCooldownMin) && llmFailureCooldownMin > 0
      ? llmFailureCooldownMin
      : 30) * 60_000;

  // v0.17.0: per-author reaction cooldown. Default window 2h, limit 3 —
  // "3 reactions to the same agent in 2h is fine; a 4th feels sycophantic."
  const reactionAuthorLimitRaw = Number(
    getSetting(runtime, "COLONY_REACTION_AUTHOR_LIMIT", "3"),
  );
  const reactionAuthorLimit = Number.isFinite(reactionAuthorLimitRaw)
    ? Math.max(1, Math.floor(reactionAuthorLimitRaw))
    : 3;
  const reactionAuthorWindowHours = Number(
    getSetting(runtime, "COLONY_REACTION_AUTHOR_WINDOW_HOURS", "2"),
  );
  const reactionAuthorWindowMs =
    (Number.isFinite(reactionAuthorWindowHours) && reactionAuthorWindowHours > 0
      ? reactionAuthorWindowHours
      : 2) * 3600_000;

  // v0.19.0 — content-diversity watchdog
  const diversityWindowRaw = getSetting(runtime, "COLONY_DIVERSITY_WINDOW", "3")!;
  const parsedDiversityWindow = Number.parseInt(diversityWindowRaw, 10);
  const diversityWindowSize = Number.isFinite(parsedDiversityWindow)
    ? Math.max(2, Math.min(20, parsedDiversityWindow))
    : 3;

  const diversityThresholdRaw = getSetting(
    runtime,
    "COLONY_DIVERSITY_THRESHOLD",
    "0.8",
  )!;
  const parsedDiversityThreshold = Number.parseFloat(diversityThresholdRaw);
  const diversityThreshold = Number.isFinite(parsedDiversityThreshold)
    ? Math.max(0, Math.min(1, parsedDiversityThreshold))
    : 0.8;

  const diversityNgramRaw = getSetting(runtime, "COLONY_DIVERSITY_NGRAM", "3")!;
  const parsedDiversityNgram = Number.parseInt(diversityNgramRaw, 10);
  const diversityNgram = Number.isFinite(parsedDiversityNgram)
    ? Math.max(1, Math.min(8, parsedDiversityNgram))
    : 3;

  const diversityCooldownRaw = getSetting(
    runtime,
    "COLONY_DIVERSITY_COOLDOWN_MIN",
    "60",
  )!;
  const parsedDiversityCooldown = Number.parseInt(diversityCooldownRaw, 10);
  const diversityCooldownMs =
    (Number.isFinite(parsedDiversityCooldown) && parsedDiversityCooldown > 0
      ? parsedDiversityCooldown
      : 60) * 60_000;

  // v0.29.0 — diversity backend mode (lexical | semantic | both)
  const diversityModeRaw = getSetting(runtime, "COLONY_DIVERSITY_MODE", "lexical")!
    .trim()
    .toLowerCase();
  const diversityMode: "lexical" | "semantic" | "both" =
    diversityModeRaw === "semantic"
      ? "semantic"
      : diversityModeRaw === "both"
        ? "both"
        : "lexical";

  const diversitySemanticThresholdRaw = getSetting(
    runtime,
    "COLONY_DIVERSITY_SEMANTIC_THRESHOLD",
    "0.85",
  )!;
  const parsedDiversitySemanticThreshold = Number.parseFloat(
    diversitySemanticThresholdRaw,
  );
  const diversitySemanticThreshold = Number.isFinite(
    parsedDiversitySemanticThreshold,
  )
    ? Math.max(0, Math.min(1, parsedDiversitySemanticThreshold))
    : 0.85;

  // v0.29.0 — client-side comment dedup (defaults on)
  const commentDedupEnabledRaw = getSetting(
    runtime,
    "COLONY_COMMENT_DEDUP_ENABLED",
    "true",
  )!.toLowerCase();
  const commentDedupEnabled =
    commentDedupEnabledRaw !== "false" &&
    commentDedupEnabledRaw !== "0" &&
    commentDedupEnabledRaw !== "no";

  const commentDedupRingSizeRaw = getSetting(
    runtime,
    "COLONY_COMMENT_DEDUP_RING_SIZE",
    "16",
  )!;
  const parsedCommentDedupRingSize = Number.parseInt(
    commentDedupRingSizeRaw,
    10,
  );
  const commentDedupRingSize = Number.isFinite(parsedCommentDedupRingSize)
    ? Math.max(1, Math.min(256, parsedCommentDedupRingSize))
    : 16;

  const commentDedupThresholdRaw = getSetting(
    runtime,
    "COLONY_COMMENT_DEDUP_THRESHOLD",
    "0.7",
  )!;
  const parsedCommentDedupThreshold = Number.parseFloat(
    commentDedupThresholdRaw,
  );
  const commentDedupThreshold = Number.isFinite(parsedCommentDedupThreshold)
    ? Math.max(0.1, Math.min(1, parsedCommentDedupThreshold))
    : 0.7;

  // v0.19.0 — operator kill-switch
  const operatorUsername = getSetting(runtime, "COLONY_OPERATOR_USERNAME", "")!
    .trim()
    .toLowerCase();
  const operatorPrefixRaw = getSetting(runtime, "COLONY_OPERATOR_PREFIX", "!")!;
  const operatorPrefix = operatorPrefixRaw.length > 0 ? operatorPrefixRaw : "!";

  // v0.19.0 — per-conversation DM context
  const dmContextRaw = getSetting(runtime, "COLONY_DM_CONTEXT_MESSAGES", "0")!;
  const parsedDmContext = Number.parseInt(dmContextRaw, 10);
  const dmContextMessages = Number.isFinite(parsedDmContext)
    ? Math.max(0, Math.min(50, parsedDmContext))
    : 0;

  // v0.20.0 — engagement candidate source + trend weighting
  const useRisingRaw = getSetting(runtime, "COLONY_ENGAGE_USE_RISING", "false")!.toLowerCase();
  const engageUseRising = useRisingRaw === "true" || useRisingRaw === "1" || useRisingRaw === "yes";

  const trendingBoostRaw = getSetting(runtime, "COLONY_ENGAGE_TRENDING_BOOST", "false")!.toLowerCase();
  const engageTrendingBoost =
    trendingBoostRaw === "true" || trendingBoostRaw === "1" || trendingBoostRaw === "yes";

  const trendingRefreshRaw = getSetting(runtime, "COLONY_ENGAGE_TRENDING_REFRESH_MIN", "15")!;
  const parsedTrendingRefresh = Number.parseInt(trendingRefreshRaw, 10);
  const engageTrendingRefreshMs =
    (Number.isFinite(parsedTrendingRefresh) && parsedTrendingRefresh > 0
      ? parsedTrendingRefresh
      : 15) * 60_000;

  // v0.23.0 — adaptive poll interval + DM karma gate
  const adaptivePollRaw = getSetting(runtime, "COLONY_ADAPTIVE_POLL_ENABLED", "false")!.toLowerCase();
  const adaptivePollEnabled =
    adaptivePollRaw === "true" || adaptivePollRaw === "1" || adaptivePollRaw === "yes";

  const adaptiveMaxRaw = getSetting(runtime, "COLONY_ADAPTIVE_POLL_MAX_MULTIPLIER", "4.0")!;
  const parsedAdaptiveMax = Number.parseFloat(adaptiveMaxRaw);
  const adaptivePollMaxMultiplier = Number.isFinite(parsedAdaptiveMax)
    ? Math.max(1.0, Math.min(20.0, parsedAdaptiveMax))
    : 4.0;

  const adaptiveWarnRaw = getSetting(runtime, "COLONY_ADAPTIVE_POLL_WARN_THRESHOLD", "0.25")!;
  const parsedAdaptiveWarn = Number.parseFloat(adaptiveWarnRaw);
  const adaptivePollWarnThreshold = Number.isFinite(parsedAdaptiveWarn)
    ? Math.max(0, Math.min(0.99, parsedAdaptiveWarn))
    : 0.25;

  const dmMinKarmaRaw = getSetting(runtime, "COLONY_DM_MIN_KARMA", "0")!;
  const parsedDmMinKarma = Number.parseInt(dmMinKarmaRaw, 10);
  const dmMinKarma = Number.isFinite(parsedDmMinKarma) && parsedDmMinKarma > 0
    ? parsedDmMinKarma
    : 0;

  // v0.28.0 — thread compression. Unknown values fail open to "verbatim"
  // (preserves v0.27 behaviour).
  const threadCompressRaw = getSetting(
    runtime,
    "COLONY_THREAD_COMPRESSION",
    "verbatim",
  )!.toLowerCase().trim();
  const engageThreadCompression: "verbatim" | "abridged" =
    threadCompressRaw === "abridged" ? "abridged" : "verbatim";

  // v0.28.0 — catch-up mode threshold in ms. 0 = disabled (preserves v0.27
  // behaviour). Default 30 s. Non-finite / negative → default.
  const catchupRaw = getSetting(runtime, "COLONY_CATCHUP_THRESHOLD_SEC", "30")!;
  const parsedCatchup = Number.parseInt(catchupRaw, 10);
  const catchupThresholdMs =
    Number.isFinite(parsedCatchup) && parsedCatchup >= 0
      ? parsedCatchup * 1000
      : 30_000;

  // v0.27.0 — per-thread notification digest. Unknown values fail open to "off"
  // (preserves v0.26 behaviour on typo).
  const notificationDigestRaw = getSetting(
    runtime,
    "COLONY_NOTIFICATION_DIGEST",
    "off",
  )!.toLowerCase().trim();
  const notificationDigest: "off" | "per-thread" =
    notificationDigestRaw === "per-thread" ? "per-thread" : "off";

  // v0.27.0 — DM-origin prompt framing. Unknown values fail closed to "none"
  // (preserves v0.26 behaviour, never injects a preamble the operator didn't ask for).
  const dmPromptModeRaw = getSetting(runtime, "COLONY_DM_PROMPT_MODE", "none")!
    .toLowerCase()
    .trim();
  const dmPromptMode: DmPromptMode =
    dmPromptModeRaw === "peer"
      ? "peer"
      : dmPromptModeRaw === "adversarial"
        ? "adversarial"
        : "none";

  return {
    apiKey,
    defaultColony,
    feedLimit,
    pollEnabled,
    pollIntervalMs,
    coldStartWindowMs,
    notificationTypesIgnore,
    notificationPolicy,
    dryRun,
    postEnabled,
    postIntervalMinMs,
    postIntervalMaxMs,
    postColony,
    postMaxTokens,
    postTemperature,
    postStyleHint,
    postRecentTopicMemory,
    engageEnabled,
    engageIntervalMinMs,
    engageIntervalMaxMs,
    engageColonies,
    engageCandidateLimit,
    engageMaxTokens,
    engageTemperature,
    engageStyleHint,
    selfCheckEnabled,
    postDailyLimit,
    karmaBackoffDrop,
    karmaBackoffWindowMs,
    karmaBackoffCooldownMs,
    engageThreadComments,
    engageRequireTopicMatch,
    mentionMinKarma,
    postDefaultType,
    mentionThreadComments,
    bannedPatterns,
    postModelType,
    engageModelType,
    scorerModelType,
    registerSignalHandlers,
    logFormat,
    retryQueueEnabled,
    retryQueueMaxAttempts,
    retryQueueMaxAgeMs,
    engageReactionMode,
    autoRotateKey,
    selfCheckRetry,
    activityWebhookUrl,
    activityWebhookSecret,
    engageFollowWeight,
    engagePreferredAuthors,
    postApprovalRequired,
    postQuietHours,
    engageQuietHours,
    llmFailureThreshold,
    llmFailureWindowMs,
    llmFailureCooldownMs,
    reactionAuthorLimit,
    reactionAuthorWindowMs,
    engageLengthTarget,
    diversityWindowSize,
    diversityThreshold,
    diversityNgram,
    diversityCooldownMs,
    diversityMode,
    diversitySemanticThreshold,
    commentDedupEnabled,
    commentDedupRingSize,
    commentDedupThreshold,
    operatorUsername,
    operatorPrefix,
    dmContextMessages,
    engageUseRising,
    engageTrendingBoost,
    engageTrendingRefreshMs,
    adaptivePollEnabled,
    adaptivePollMaxMultiplier,
    adaptivePollWarnThreshold,
    dmMinKarma,
    notificationDigest,
    dmPromptMode,
    catchupThresholdMs,
    engageThreadCompression,
  };
}

/**
 * Parse a quiet-hours spec like `"23-7"` or `"0-6"` into a UTC-hour window.
 * Returns `null` for empty input or anything malformed — the caller treats
 * null as "no quiet window, all hours are OK to post."
 *
 * Accepted formats:
 *   - `""` / whitespace → null (disabled)
 *   - `"23-7"` → `{startHour: 23, endHour: 7}` (wraps midnight)
 *   - `"0-6"` → `{startHour: 0, endHour: 6}` (simple overnight)
 *   - `"9-17"` → `{startHour: 9, endHour: 17}` (daytime, weird but supported)
 *
 * Both ends inclusive of the start hour, exclusive of the end hour. So
 * "23-7" is quiet at 23:00, 00:00, ..., 06:00, and NOT quiet at 07:00.
 */
export function parseQuietHours(
  raw: string,
): { startHour: number; endHour: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return null;
  // The regex guarantees at most 2 digits per group, so Number() is always finite.
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour > 23) return null;
  if (endHour > 23) return null;
  if (startHour === endHour) return null; // empty window == disabled
  return { startHour, endHour };
}

/**
 * True when the given UTC hour is inside the (possibly midnight-wrapping)
 * quiet window.
 */
export function isInQuietHours(
  window: { startHour: number; endHour: number } | null,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  const hour = now.getUTCHours();
  const { startHour, endHour } = window;
  if (startHour < endHour) {
    // Non-wrapping: e.g. 9-17 → quiet during the day
    return hour >= startHour && hour < endHour;
  }
  // Wrapping: e.g. 23-7 → quiet from 23:00 to 07:00 (UTC)
  return hour >= startHour || hour < endHour;
}
