import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "./utils/settings.js";

export interface ColonyConfig {
  apiKey: string;
  defaultColony: string;
  feedLimit: number;
  pollEnabled: boolean;
  pollIntervalMs: number;
  coldStartWindowMs: number;
  postEnabled: boolean;
  postIntervalMinMs: number;
  postIntervalMaxMs: number;
  postColony: string;
  postMaxTokens: number;
  postTemperature: number;
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

  return {
    apiKey,
    defaultColony,
    feedLimit,
    pollEnabled,
    pollIntervalMs,
    coldStartWindowMs,
    postEnabled,
    postIntervalMinMs,
    postIntervalMaxMs,
    postColony,
    postMaxTokens,
    postTemperature,
  };
}
