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

const FOLLOW_TOP_REGEX = /\b(?:follow|subscribe to) .*(?:top|best) .*(?:agents?|users?)\b/i;

type DirectoryUser = {
  id?: string;
  user_id?: string;
  username?: string;
  karma?: number;
};

/**
 * Operator-triggered "follow the top N agents by karma" bulk action.
 *
 * Wraps `client.directory(sort:"karma", userType:"agent", query?, limit)`
 * + per-agent `client.follow(userId)`. Useful bootstrap for a fresh
 * agent that wants to populate its follow graph, and complements the
 * v0.14.0 engagement follow-graph weighting: if the agent prefers
 * candidates from followed authors, you need to follow the right
 * people first.
 *
 * Options: `limit` (1–50, default 10), `query` (filter string passed to
 * the directory), `minKarma` (skip agents below this threshold). Already-
 * followed agents are detected via the SDK's error response (409
 * conflict = already following) and counted as "skipped."
 */
export const followTopAgentsAction: Action = {
  name: "FOLLOW_TOP_AGENTS",
  similes: ["FOLLOW_TOP_COLONY_AGENTS", "BULK_FOLLOW_AGENTS", "COLONY_FOLLOW_TOP"],
  description:
    "Bulk-follow the top N Colony agents by karma. Options: `limit` (default 10), `query` (directory filter), `minKarma` (skip below threshold).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return FOLLOW_TOP_REGEX.test(text);
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

    const rawLimit = Number(options?.limit ?? 10);
    const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 10));
    const query = typeof options?.query === "string" ? (options.query as string) : undefined;
    const minKarma = Number(options?.minKarma ?? 0);

    let candidates: DirectoryUser[];
    try {
      const result = await (service.client as unknown as {
        directory: (opts: { userType?: string; sort?: string; limit?: number; query?: string }) => Promise<unknown>;
      }).directory({
        userType: "agent",
        sort: "karma",
        limit,
        query,
      });
      candidates = Array.isArray(result)
        ? (result as DirectoryUser[])
        : ((result as { items?: DirectoryUser[] })?.items ?? []);
    } catch (err) {
      logger.error(`FOLLOW_TOP_AGENTS: directory fetch failed: ${String(err)}`);
      callback?.({
        text: `Failed to fetch agent directory: ${(err as Error).message}`,
        action: "FOLLOW_TOP_AGENTS",
      });
      return;
    }

    if (!candidates.length) {
      callback?.({
        text: "Agent directory returned no candidates.",
        action: "FOLLOW_TOP_AGENTS",
      });
      return;
    }

    let followed = 0;
    let skipped = 0;
    let failed = 0;
    const eligible = candidates.filter(
      (c) =>
        (c.karma ?? 0) >= minKarma &&
        c.username !== service.username &&
        (c.id || c.user_id),
    );

    for (const agent of eligible) {
      // Non-null assertion: `eligible` already filters out agents
      // without `id` or `user_id`, so this is a known-present lookup.
      const userId = (agent.id ?? agent.user_id)!;
      try {
        await (service.client as unknown as {
          follow: (id: string) => Promise<unknown>;
        }).follow(userId);
        followed++;
        service.recordActivity?.(
          "post_created",
          userId,
          `followed @${agent.username ?? userId.slice(0, 8)} (karma ${agent.karma ?? "?"})`,
        );
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("409") || msg.includes("already")) {
          skipped++;
        } else {
          failed++;
          logger.debug(`FOLLOW_TOP_AGENTS: follow(${userId}) failed: ${String(err)}`);
        }
      }
    }

    logger.info(
      `FOLLOW_TOP_AGENTS: ${followed} followed, ${skipped} skipped (already following / self / missing id), ${failed} failed (of ${candidates.length} candidates)`,
    );
    callback?.({
      text: `Bulk follow done: ${followed} new follows, ${skipped} skipped (already following / self / invalid), ${failed} failed. Scanned ${candidates.length} top-karma agents${query ? ` matching "${query}"` : ""}.`,
      action: "FOLLOW_TOP_AGENTS",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Follow the top 20 agents on Colony" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Bulk follow done: 15 new follows, 5 skipped (already following / self / invalid), 0 failed. Scanned 20 top-karma agents.",
          action: "FOLLOW_TOP_AGENTS",
        },
      },
    ],
  ] as ActionExample[][],
};
