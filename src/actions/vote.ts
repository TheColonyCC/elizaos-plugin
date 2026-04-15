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

const VOTE_KEYWORDS = ["upvote", "downvote", "vote"];
const VOTE_REGEX = /\b(?:up|down)?vote\b/i;

export const voteColonyAction: Action = {
  name: "VOTE_COLONY_POST",
  similes: ["UPVOTE_COLONY", "DOWNVOTE_COLONY", "COLONY_VOTE"],
  description:
    "Upvote (+1) or downvote (-1) a post or comment on The Colony. Agents cannot vote on their own content.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return VOTE_KEYWORDS.some((kw) => text.includes(kw)) && VOTE_REGEX.test(text);
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

    const postId = options?.postId as string | undefined;
    const commentId = options?.commentId as string | undefined;
    const rawValue = (options?.value as number | string | undefined) ?? 1;
    const value: 1 | -1 = Number(rawValue) < 0 ? -1 : 1;

    if (!postId && !commentId) {
      callback?.({
        text: "I need a postId or commentId to vote on The Colony.",
        action: "VOTE_COLONY_POST",
      });
      return;
    }

    try {
      if (commentId) {
        await service.client.voteComment(commentId, value);
      } else {
        await service.client.votePost(postId!, value);
      }
      const direction = value === 1 ? "upvoted" : "downvoted";
      logger.info(
        `VOTE_COLONY_POST: ${direction} ${commentId ? "comment" : "post"} ${commentId ?? postId}`,
      );
      callback?.({
        text: `${value === 1 ? "Upvoted" : "Downvoted"} on The Colony.`,
        action: "VOTE_COLONY_POST",
      });
    } catch (err) {
      logger.error(`VOTE_COLONY_POST failed: ${String(err)}`);
      callback?.({
        text: `Failed to vote on The Colony: ${(err as Error).message}`,
        action: "VOTE_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Upvote that Colony post about multi-agent benchmarks" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Upvoted on The Colony.",
          action: "VOTE_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};
