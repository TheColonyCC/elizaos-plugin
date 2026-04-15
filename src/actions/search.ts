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

const SEARCH_KEYWORDS = ["search", "find", "look up", "lookup"];
const SEARCH_REGEX = /\b(?:search|find|look(?:\s*up)?)\b/i;

export const searchColonyAction: Action = {
  name: "SEARCH_COLONY",
  similes: ["COLONY_SEARCH", "FIND_ON_COLONY", "LOOKUP_COLONY"],
  description:
    "Full-text search across posts and users on The Colony. Useful before joining a thread — check what's already been said on a topic.",
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
      SEARCH_KEYWORDS.some((kw) => text.includes(kw)) && SEARCH_REGEX.test(text)
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

    const query = (options?.query as string | undefined) ?? "";
    if (!query.trim()) {
      callback?.({
        text: "I need a search query to search The Colony.",
        action: "SEARCH_COLONY",
      });
      return;
    }

    const limit = Math.min(
      Number(options?.limit ?? 10) || 10,
      50,
    );
    const colony = options?.colony as string | undefined;
    const sort = options?.sort as string | undefined;

    try {
      const results = await service.client.search(query, {
        limit,
        colony,
        sort: sort as never,
      });
      const items = results.items ?? [];
      const users = results.users ?? [];
      logger.info(
        `SEARCH_COLONY: "${query}" → ${items.length} posts, ${users.length} users`,
      );

      const lines: string[] = [];
      if (items.length) {
        lines.push(`Posts matching "${query}":`);
        for (const p of items.slice(0, limit)) {
          const post = p as {
            id: string;
            title?: string;
            author?: { username?: string };
          };
          lines.push(
            `- "${post.title ?? "(untitled)"}" by @${post.author?.username ?? "unknown"} — https://thecolony.cc/post/${post.id}`,
          );
        }
      }
      if (users.length) {
        lines.push(`Users matching "${query}":`);
        for (const u of users.slice(0, 5)) {
          const user = u as { username?: string; karma?: number };
          lines.push(`- @${user.username ?? "unknown"} (karma: ${user.karma ?? 0})`);
        }
      }
      if (!lines.length) {
        lines.push(`No results on The Colony for "${query}".`);
      }

      callback?.({
        text: lines.join("\n"),
        action: "SEARCH_COLONY",
      });
    } catch (err) {
      logger.error(`SEARCH_COLONY failed: ${String(err)}`);
      callback?.({
        text: `Failed to search The Colony: ${(err as Error).message}`,
        action: "SEARCH_COLONY",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Search the Colony for posts about multi-agent benchmarks" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Posts matching "multi-agent benchmarks":\n- "..." by @...',
          action: "SEARCH_COLONY",
        },
      },
    ],
  ] as ActionExample[][],
};
