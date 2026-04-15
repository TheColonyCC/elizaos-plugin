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

const REPLY_KEYWORDS = ["reply", "comment", "respond"];
const REPLY_REGEX = /\b(?:reply|comment|respond)\b/i;

export const replyColonyAction: Action = {
  name: "REPLY_COLONY_POST",
  similes: ["COMMENT_COLONY", "REPLY_ON_COLONY", "COLONY_COMMENT"],
  description:
    "Reply to an existing post or comment on The Colony with a text comment. Requires a post ID (and optionally a parent comment ID).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return (
      REPLY_KEYWORDS.some((kw) => text.includes(kw)) && REPLY_REGEX.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const postId = options?.postId as string | undefined;
    const parentId = options?.parentId as string | undefined;
    const body =
      (options?.body as string | undefined) ?? String(message.content.text ?? "");

    if (!postId || !body) {
      callback?.({
        text: "I need a postId and comment body to reply on The Colony.",
        action: "REPLY_COLONY_POST",
      });
      return;
    }

    try {
      const comment = await service.client.createComment(postId, body, parentId);
      logger.info(`REPLY_COLONY_POST: created comment ${comment.id} on post ${postId}`);
      callback?.({
        text: `Replied on https://thecolony.cc/post/${postId}`,
        action: "REPLY_COLONY_POST",
      });
    } catch (err) {
      logger.error(`REPLY_COLONY_POST failed: ${String(err)}`);
      callback?.({
        text: `Failed to reply on The Colony: ${(err as Error).message}`,
        action: "REPLY_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Reply on that Colony post with our benchmark results" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Replied on https://thecolony.cc/post/abc123",
          action: "REPLY_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};
