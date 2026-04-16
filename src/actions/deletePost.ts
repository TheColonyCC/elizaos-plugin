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

const POST_ID_REGEX =
  /(?:thecolony\.cc\/post\/|post\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const COMMENT_ID_REGEX =
  /(?:comment\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const DELETE_REGEX = /\b(?:delete|remove|retract|unpost)\b/i;

/**
 * Self-correction action: delete a post the agent previously published.
 *
 * Wraps `client.deletePost(postId)`. Colony enforces a 15-minute
 * deletion window server-side; older content surfaces a 409 that the
 * handler passes through to the operator.
 */
export const deleteColonyPostAction: Action = {
  name: "DELETE_COLONY_POST",
  similes: ["REMOVE_COLONY_POST", "RETRACT_COLONY_POST"],
  description:
    "Delete a Colony post (within the 15-minute server-side deletion window). Use when a post needs to be retracted — e.g. factual error, self-check miss caught after publish.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!DELETE_REGEX.test(text)) return false;
    if (/\bcomment\b/i.test(text)) return false;
    const optionPostId = (message as unknown as { content?: { postId?: string } })
      .content?.postId;
    return POST_ID_REGEX.test(text) || typeof optionPostId === "string";
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

    const rawText = String(message.content.text ?? "");
    const optionPostId =
      typeof options?.postId === "string" ? (options.postId as string) : undefined;
    const matched = rawText.match(POST_ID_REGEX)?.[1];
    const postId = optionPostId ?? matched;

    if (!postId) {
      callback?.({
        text: "I need a Colony post ID or URL to delete.",
        action: "DELETE_COLONY_POST",
      });
      return;
    }

    try {
      await service.client.deletePost(postId);
      logger.info(`DELETE_COLONY_POST: deleted post ${postId}`);
      service.recordActivity?.("post_created", postId, `deleted ${postId.slice(0, 8)}`);
      callback?.({
        text: `Deleted post ${postId}.`,
        action: "DELETE_COLONY_POST",
      });
    } catch (err) {
      logger.error(`DELETE_COLONY_POST: deletePost(${postId}) failed: ${String(err)}`);
      callback?.({
        text: `Failed to delete ${postId}: ${(err as Error).message}`,
        action: "DELETE_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Delete that Colony post about the wrong benchmark" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Deleted post abc123...",
          action: "DELETE_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Self-correction action: delete a comment the agent previously wrote.
 *
 * The SDK doesn't wrap this endpoint yet, so we call it via `client.raw(
 * "DELETE", "/comments/{id}")`. Colony's edit window still applies.
 */
export const deleteColonyCommentAction: Action = {
  name: "DELETE_COLONY_COMMENT",
  similes: ["REMOVE_COLONY_COMMENT", "RETRACT_COLONY_COMMENT"],
  description:
    "Delete a Colony comment (within the server-side deletion window). Accepts commentId in options or a bare UUID in message text.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!DELETE_REGEX.test(text)) return false;
    if (!/\bcomment\b/i.test(text)) return false;
    const optionCommentId = (message as unknown as { content?: { commentId?: string } })
      .content?.commentId;
    return COMMENT_ID_REGEX.test(text) || typeof optionCommentId === "string";
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

    const rawText = String(message.content.text ?? "");
    const optionCommentId =
      typeof options?.commentId === "string" ? (options.commentId as string) : undefined;
    const matched = rawText.match(COMMENT_ID_REGEX)?.[1];
    const commentId = optionCommentId ?? matched;

    if (!commentId) {
      callback?.({
        text: "I need a Colony comment ID to delete.",
        action: "DELETE_COLONY_COMMENT",
      });
      return;
    }

    try {
      await (service.client as unknown as {
        raw: (method: string, path: string) => Promise<unknown>;
      }).raw("DELETE", `/comments/${commentId}`);
      logger.info(`DELETE_COLONY_COMMENT: deleted comment ${commentId}`);
      service.recordActivity?.(
        "comment_created",
        commentId,
        `deleted comment ${commentId.slice(0, 8)}`,
      );
      callback?.({
        text: `Deleted comment ${commentId}.`,
        action: "DELETE_COLONY_COMMENT",
      });
    } catch (err) {
      logger.error(
        `DELETE_COLONY_COMMENT: raw DELETE /comments/${commentId} failed: ${String(err)}`,
      );
      callback?.({
        text: `Failed to delete comment ${commentId}: ${(err as Error).message}`,
        action: "DELETE_COLONY_COMMENT",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Delete that Colony comment — I misread the benchmark" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Deleted comment abc123...",
          action: "DELETE_COLONY_COMMENT",
        },
      },
    ],
  ] as ActionExample[][],
};
