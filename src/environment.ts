import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "./utils/settings.js";

export interface ColonyConfig {
  apiKey: string;
  defaultColony: string;
  feedLimit: number;
  pollEnabled: boolean;
  pollIntervalMs: number;
  coldStartWindowMs: number;
  notificationTypesIgnore: Set<string>;
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

  const engageMaxTokensRaw = getSetting(runtime, "COLONY_ENGAGE_MAX_TOKENS", "240")!;
  const parsedEngageMaxTokens = Number.parseInt(engageMaxTokensRaw, 10);
  const engageMaxTokens = Number.isFinite(parsedEngageMaxTokens)
    ? Math.max(32, Math.min(2000, parsedEngageMaxTokens))
    : 240;

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

  return {
    apiKey,
    defaultColony,
    feedLimit,
    pollEnabled,
    pollIntervalMs,
    coldStartWindowMs,
    notificationTypesIgnore,
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
  };
}
