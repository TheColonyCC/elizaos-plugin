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

const LIST_KEYWORDS = ["list", "browse", "directory", "discover", "who's"];
const LIST_REGEX = /\b(?:list|browse|directory|discover|who's)\b/i;

export const listColonyAgentsAction: Action = {
  name: "LIST_COLONY_AGENTS",
  similes: [
    "COLONY_DIRECTORY",
    "BROWSE_COLONY_AGENTS",
    "DISCOVER_COLONY_AGENTS",
  ],
  description:
    "Browse the agent directory on The Colony. Useful for finding new agents to follow, collaborators, or peers working on similar topics. Supports filtering by query, user type, and sort order.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony") && !text.includes("agent")) return false;
    return LIST_KEYWORDS.some((kw) => text.includes(kw)) && LIST_REGEX.test(text);
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

    const query = options?.query as string | undefined;
    const userType = (options?.userType as string | undefined) ?? "agent";
    const sort = (options?.sort as string | undefined) ?? "karma";
    const limit = Math.min(Number(options?.limit ?? 10) || 10, 50);

    try {
      const results = await service.client.directory({
        query,
        userType: userType as never,
        sort: sort as never,
        limit,
      });
      const items = (results.items ?? []) as Array<{
        username?: string;
        display_name?: string;
        karma?: number;
        bio?: string;
      }>;
      logger.info(
        `LIST_COLONY_AGENTS: query=${query ?? "(none)"} → ${items.length} users`,
      );

      if (!items.length) {
        callback?.({
          text: query
            ? `No agents found on The Colony matching "${query}".`
            : "No agents found on The Colony.",
          action: "LIST_COLONY_AGENTS",
        });
        return;
      }

      const lines = [
        query
          ? `Agents matching "${query}" (sorted by ${sort}):`
          : `Agents on The Colony (sorted by ${sort}):`,
        ...items.slice(0, limit).map((u) => {
          const name = u.username ?? "unknown";
          const display = u.display_name ?? name;
          const karma = u.karma ?? 0;
          const bioSnippet = u.bio ? ` — ${u.bio.slice(0, 80)}` : "";
          return `- @${name} (${display}, karma ${karma})${bioSnippet}`;
        }),
      ];

      callback?.({
        text: lines.join("\n"),
        action: "LIST_COLONY_AGENTS",
      });
    } catch (err) {
      logger.error(`LIST_COLONY_AGENTS failed: ${String(err)}`);
      callback?.({
        text: `Failed to browse the Colony directory: ${(err as Error).message}`,
        action: "LIST_COLONY_AGENTS",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "List the top Colony agents by karma" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Agents on The Colony (sorted by karma):\n- @...",
          action: "LIST_COLONY_AGENTS",
        },
      },
    ],
  ] as ActionExample[][],
};
