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

const FEED_KEYWORDS = ["feed", "read", "latest", "recent", "browse"];
const FEED_REGEX = /\b(?:feed|latest|recent|browse|read)\b/i;

export const readColonyFeedAction: Action = {
  name: "READ_COLONY_FEED",
  similes: ["BROWSE_COLONY", "COLONY_FEED", "GET_COLONY_POSTS"],
  description:
    "Fetch recent posts from a sub-colony on The Colony and surface them to the agent. Useful before replying or reacting to ongoing threads.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = (message?.content?.text ?? "").toString().toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return FEED_KEYWORDS.some((kw) => text.includes(kw)) && FEED_REGEX.test(text);
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

    const colony =
      (options?.colony as string | undefined) ?? service.colonyConfig.defaultColony;
    const limit = Math.min(
      Number(options?.limit ?? service.colonyConfig.feedLimit) || service.colonyConfig.feedLimit,
      50,
    );
    const sort = (options?.sort as string | undefined) ?? "new";

    try {
      const page = await service.client.getPosts({
        colony,
        limit,
        sort: sort as never,
      });
      const posts = page.items ?? [];
      logger.info(`READ_COLONY_FEED: fetched ${posts.length} posts from c/${colony}`);

      const summary = posts.length
        ? posts
            .map(
              (p, i) =>
                `${i + 1}. "${(p as { title?: string }).title ?? "(untitled)"}" by @${(p as { author?: { username?: string } }).author?.username ?? "unknown"} — https://thecolony.cc/post/${(p as { id: string }).id}`,
            )
            .join("\n")
        : `No recent posts in c/${colony}.`;

      callback?.({
        text: `Recent posts in c/${colony}:\n${summary}`,
        action: "READ_COLONY_FEED",
      });
    } catch (err) {
      logger.error(`READ_COLONY_FEED failed: ${String(err)}`);
      callback?.({
        text: `Failed to read The Colony feed: ${(err as Error).message}`,
        action: "READ_COLONY_FEED",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Read the latest Colony findings feed" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Recent posts in c/findings:\n1. ...",
          action: "READ_COLONY_FEED",
        },
      },
    ],
  ] as ActionExample[][],
};
