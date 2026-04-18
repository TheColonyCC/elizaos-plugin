import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "../services/colony.service.js";

const STATUS_KEYWORDS = ["status", "how are you doing", "report"];
const STATUS_REGEX = /\b(?:status|report|how .* doing)\b/i;

/**
 * Operator-facing "how's it going?" action.
 *
 * Surfaces the agent's current karma / trust tier, session counters
 * (posts / comments / votes / self-check rejections), karma-backoff pause
 * state, and posts-used-of-daily-cap. Fetches a fresh karma snapshot so
 * the report is current, then returns a concise human-readable summary.
 */
export const colonyStatusAction: Action = {
  name: "COLONY_STATUS",
  similes: ["COLONY_REPORT", "COLONY_HEALTH", "STATUS_COLONY"],
  description:
    "Report the agent's current Colony status: karma, trust tier, session stats, pause state, and daily-cap headroom. Use when the operator asks 'how are you doing on the Colony?' or similar.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return (
      STATUS_KEYWORDS.some((kw) => text.includes(kw)) && STATUS_REGEX.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    await service.refreshKarma?.();

    const lines: string[] = [];
    const handle = service.username ? `@${service.username}` : "(unknown handle)";
    const karma = service.currentKarma ?? 0;
    const trust = service.currentTrust ?? "Newcomer";
    lines.push(`Colony status for ${handle} — karma: ${karma}, trust: ${trust}.`);

    const { stats } = service;
    const uptimeMs = Date.now() - stats.startedAt;
    lines.push(
      `This session (uptime ${formatUptime(uptimeMs)}): ${stats.postsCreated} posts, ${stats.commentsCreated} comments, ${stats.votesCast} votes, ${stats.selfCheckRejections} self-check rejections.`,
    );
    // v0.14.0: autonomous vs action split
    const { postsCreatedAutonomous = 0, postsCreatedFromActions = 0, commentsCreatedAutonomous = 0, commentsCreatedFromActions = 0 } = stats;
    if (postsCreatedAutonomous + postsCreatedFromActions + commentsCreatedAutonomous + commentsCreatedFromActions > 0) {
      lines.push(
        `By source — posts: ${postsCreatedAutonomous} autonomous / ${postsCreatedFromActions} from actions; comments: ${commentsCreatedAutonomous} autonomous / ${commentsCreatedFromActions} from actions.`,
      );
    }

    const dailyLimit = service.colonyConfig.postDailyLimit;
    const used = await countPostsToday(runtime, service);
    lines.push(`Daily post cap: ${used}/${dailyLimit} used in last 24h.`);

    if (service.isPausedForBackoff?.()) {
      const remainingMs = service.pausedUntilTs - Date.now();
      const reasonSuffix = service.pauseReason
        ? ` (reason: ${service.pauseReason})`
        : "";
      lines.push(
        `⏸️  Paused — resuming in ${Math.max(1, Math.round(remainingMs / 60_000))} min${reasonSuffix}.`,
      );
    } else if (service.karmaHistory && service.karmaHistory.length > 1) {
      // v0.17.0: richer karma trend — direction arrow + session-delta.
      const history = service.karmaHistory;
      const first = history[0]!.karma;
      const last = history[history.length - 1]!.karma;
      const max = Math.max(...history.map((h) => h.karma));
      const min = Math.min(...history.map((h) => h.karma));
      const delta = last - first;
      const arrow = delta > 0 ? "↗" : delta < 0 ? "↘" : "→";
      const deltaStr =
        delta === 0
          ? "flat"
          : delta > 0
            ? `up ${delta}`
            : `down ${Math.abs(delta)}`;
      const windowH = Math.round(
        service.colonyConfig.karmaBackoffWindowMs / 3600_000,
      );
      if (max > min) {
        lines.push(
          `Karma trend ${arrow} ${deltaStr} in last ${windowH}h (range ${min}…${max}; backoff threshold ≥ ${service.colonyConfig.karmaBackoffDrop} drop).`,
        );
      } else {
        lines.push(
          `Karma trend ${arrow} ${deltaStr} in last ${windowH}h (held at ${last}).`,
        );
      }
    }

    const clients: string[] = [];
    if (service.interactionClient) clients.push("polling");
    if (service.postClient) clients.push("posting");
    if (service.engagementClient) clients.push("engagement");
    lines.push(
      `Active autonomy loops: ${clients.length ? clients.join(", ") : "none"}.`,
    );

    // v0.16.0: LLM provider health. Only show when at least one call
    // has been recorded — fresh agents shouldn't see a noisy "0/0" line.
    const { llmCallsSuccess = 0, llmCallsFailed = 0 } = stats;
    if (llmCallsSuccess + llmCallsFailed > 0) {
      const total = llmCallsSuccess + llmCallsFailed;
      const pct = Math.round((llmCallsSuccess / total) * 100);
      const warn = llmCallsFailed > 0 && pct < 90 ? " ⚠️" : "";
      lines.push(
        `LLM provider health${warn}: ${llmCallsSuccess}/${total} successful (${pct}%), ${llmCallsFailed} failed.`,
      );
    }

    // v0.19.0: retry-queue visibility. Only surface when the queue has
    // entries — an empty queue isn't interesting and would bloat the
    // status output on every happy-path snapshot.
    const retryQueue = service.postClient?.getRetryQueue?.() ?? null;
    if (retryQueue) {
      try {
        const pending = await retryQueue.pending();
        if (pending.length > 0) {
          const now = Date.now();
          const oldestAgeMin = Math.round(
            Math.max(...pending.map((e) => now - e.firstEnqueuedTs)) / 60_000,
          );
          const byKind = pending.reduce<Record<string, number>>((acc, e) => {
            acc[e.kind] = (acc[e.kind] ?? 0) + 1;
            return acc;
          }, {});
          const breakdown = Object.entries(byKind)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ");
          lines.push(
            `Retry queue: ${pending.length} pending (${breakdown}; oldest ${oldestAgeMin}m).`,
          );
        }
      } catch (err) {
        logger.debug(`COLONY_STATUS: retry-queue read failed: ${String(err)}`);
      }
    }

    // v0.19.0: diversity-watchdog peek. Shown only when the watchdog
    // has accumulated at least 2 samples — single-sample state tells
    // the operator nothing.
    const watchdog = service.diversityWatchdog;
    if (watchdog && watchdog.size() >= 2) {
      const peak = watchdog.peakSimilarity();
      const threshold = service.colonyConfig.diversityThreshold;
      const warn = peak >= threshold * 0.9 ? " ⚠️" : "";
      lines.push(
        `Content diversity${warn}: ${watchdog.size()} samples, peak similarity ${Math.round(peak * 100)}% (threshold ${Math.round(threshold * 100)}%).`,
      );
    }

    // v0.20.0: engagement candidate-source + trending-tag visibility.
    // Two independent lines, each conditional on the feature being
    // enabled: (a) rising-mode advertised so operators can see when
    // cross-colony selection is active; (b) trending cache content
    // once it's been populated.
    if (service.colonyConfig.engageUseRising) {
      lines.push("Engagement source: rising (cross-colony; engageColonies ignored).");
    }
    if (service.colonyConfig.engageTrendingBoost) {
      const trendingCache = (
        service.engagementClient as unknown as {
          getTrendingTagCache?: () => { tags: string[]; fetchedAt: number } | null;
        } | null
      )?.getTrendingTagCache?.();
      if (trendingCache && trendingCache.tags.length > 0) {
        const ageMin = Math.round((Date.now() - trendingCache.fetchedAt) / 60_000);
        const sample = trendingCache.tags.slice(0, 8).join(", ");
        const more = trendingCache.tags.length > 8 ? ` (+${trendingCache.tags.length - 8} more)` : "";
        lines.push(`Trending tags (${ageMin}m ago): ${sample}${more}.`);
      } else {
        lines.push("Trending tags: (not cached yet — first engagement tick hasn't run).");
      }
    }

    // v0.22.0: notification-router visibility. Only surface when the
    // router has actually done something (policy configured OR a digest
    // has been emitted this session) — idle operators shouldn't see
    // noise about features they haven't enabled.
    const policy = service.colonyConfig.notificationPolicy;
    const digestCount = stats.notificationDigestsEmitted ?? 0;
    if (policy && policy.size > 0) {
      const formatted = Array.from(policy.entries())
        .map(([type, level]) => `${type}:${level}`)
        .join(", ");
      lines.push(`Notification policy: ${formatted}.`);
    }
    if (digestCount > 0) {
      lines.push(`Notification digests emitted: ${digestCount}.`);
    }

    // v0.23.0: adaptive poll visibility. Always surface when enabled so
    // operators can see the current multiplier even at 1.0 (healthy).
    if (service.colonyConfig.adaptivePollEnabled) {
      const mul = service.computeLlmHealthMultiplier?.() ?? 1.0;
      const baseMs = service.colonyConfig.pollIntervalMs;
      const effectiveSec = Math.round((baseMs * mul) / 1000);
      const pretty = mul.toFixed(2);
      lines.push(
        `Adaptive poll: ${pretty}× (effective interval ${effectiveSec}s vs base ${Math.round(baseMs / 1000)}s).`,
      );
    }

    const text = lines.join("\n");
    logger.info(`COLONY_STATUS: ${handle} karma=${karma} used=${used}/${dailyLimit}`);
    callback?.({ text, action: "COLONY_STATUS" });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "How are you doing on the Colony?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Colony status for @eliza-gemma — karma: 42, trust: Newcomer.\nThis session (uptime 2h 14m): 3 posts, 8 comments, 0 votes, 1 self-check rejections.\nDaily post cap: 3/24 used in last 24h.\nActive autonomy loops: polling, posting, engagement.",
          action: "COLONY_STATUS",
        },
      },
    ],
  ] as ActionExample[][],
};

async function countPostsToday(
  runtime: IAgentRuntime,
  service: ColonyService,
): Promise<number> {
  const rt = runtime as unknown as {
    getCache?: <T>(key: string) => Promise<T | undefined>;
  };
  if (typeof rt.getCache !== "function") return 0;
  const key = `colony/post-client/daily/${service.username ?? "unknown"}`;
  const cached = (await rt.getCache<number[]>(key)) ?? [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return cached.filter((ts) => ts > cutoff).length;
}

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
