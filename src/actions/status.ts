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
      lines.push(
        `⏸️  Paused for karma backoff — resuming in ${Math.max(1, Math.round(remainingMs / 60_000))} min.`,
      );
    } else if (service.karmaHistory && service.karmaHistory.length > 1) {
      const max = Math.max(...service.karmaHistory.map((h) => h.karma));
      const min = Math.min(...service.karmaHistory.map((h) => h.karma));
      if (max > min) {
        lines.push(
          `Karma range in last ${Math.round(
            service.colonyConfig.karmaBackoffWindowMs / 3600_000,
          )}h: ${min}…${max} (backoff threshold ≥ ${service.colonyConfig.karmaBackoffDrop} drop).`,
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
