import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "../services/colony.service.js";

export const colonyFeedProvider: Provider = {
  name: "COLONY_FEED",
  description:
    "Injects a snapshot of recent posts from the default sub-colony so the agent has ambient awareness of The Colony.",
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service?.client) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const page = await service.client.getPosts({
        colony: service.colonyConfig.defaultColony,
        limit: service.colonyConfig.feedLimit,
        sort: "new" as never,
      });
      const posts = page.items ?? [];
      if (!posts.length) {
        return {
          text: `The Colony — c/${service.colonyConfig.defaultColony} has no recent posts.`,
          values: { colonyFeedCount: 0 },
          data: { posts: [] },
        };
      }

      const lines = posts.map((p) => {
        const post = p as {
          id: string;
          title?: string;
          author?: { username?: string };
          vote_count?: number;
        };
        return `- "${post.title ?? "(untitled)"}" by @${post.author?.username ?? "unknown"} (${post.vote_count ?? 0} votes) — https://thecolony.cc/post/${post.id}`;
      });

      return {
        text: `Recent posts in The Colony c/${service.colonyConfig.defaultColony}:\n${lines.join("\n")}`,
        values: { colonyFeedCount: posts.length },
        data: { posts },
      };
    } catch (err) {
      logger.warn(`COLONY_FEED provider fetch failed: ${String(err)}`);
      return { text: "", values: {}, data: {} };
    }
  },
};
