import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import type { ColonyService, ActivityEntry } from "../services/colony.service.js";

const ACTIVITY_KEYWORDS = ["activity", "what have you done", "recent activity", "last done"];
const ACTIVITY_REGEX = /\b(?:activity|recent|what .* (?:done|did)|last done)\b/i;

/**
 * Operator-facing "what did you actually do?" action.
 *
 * Surfaces the last N entries from the service's activity ring buffer —
 * posts created, comments created, votes cast, self-check rejections,
 * curation runs, backoff triggers, dry-run events. Lets the operator
 * inspect agent behavior without grepping logs.
 *
 * Counters (posts/comments/votes/rejections totals) live on COLONY_STATUS;
 * this action is for the per-event timeline.
 */
export const colonyRecentActivityAction: Action = {
  name: "COLONY_RECENT_ACTIVITY",
  similes: ["COLONY_ACTIVITY_LOG", "WHAT_COLONY_DONE", "COLONY_HISTORY"],
  description:
    "List the last N entries from the agent's Colony activity ring buffer (posts, comments, votes, self-check rejections, curation runs, backoff triggers). Use for 'what have you actually done on the Colony in the last few hours?'",
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
      ACTIVITY_KEYWORDS.some((kw) => text.includes(kw)) && ACTIVITY_REGEX.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const rawLimit = Number(options?.limit ?? 20);
    const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 20));
    const typeFilter =
      typeof options?.type === "string" ? (options.type as string) : undefined;

    const log = service.activityLog ?? [];
    const filtered = typeFilter ? log.filter((e) => e.type === typeFilter) : log;
    const recent = filtered.slice(-limit).reverse();

    if (!recent.length) {
      callback?.({
        text: typeFilter
          ? `No '${typeFilter}' entries in the activity log yet.`
          : "Activity log is empty — nothing done on the Colony this session.",
        action: "COLONY_RECENT_ACTIVITY",
      });
      return;
    }

    const lines = [`Last ${recent.length} Colony activity entries (newest first):`];
    for (const entry of recent) {
      lines.push(formatEntry(entry));
    }

    logger.info(`COLONY_RECENT_ACTIVITY: returned ${recent.length} entries`);
    callback?.({
      text: lines.join("\n"),
      action: "COLONY_RECENT_ACTIVITY",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What have you done on the Colony recently?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Last 3 Colony activity entries (newest first):\n- 2m ago · post_created · c/general: Thoughts on agent coordination…\n- 14m ago · vote_cast · +1 post on 6b34e9b0\n- 47m ago · comment_created · reply to 788f8783",
          action: "COLONY_RECENT_ACTIVITY",
        },
      },
    ],
  ] as ActionExample[][],
};

export function formatEntry(entry: ActivityEntry): string {
  const age = formatAge(Date.now() - entry.ts);
  const target = entry.target ? ` ${entry.target.slice(0, 8)}` : "";
  const detail = entry.detail ? ` · ${entry.detail}` : "";
  return `- ${age} ago · ${entry.type}${target}${detail}`;
}

function formatAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  if (h < 24) return mr ? `${h}h${mr}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
