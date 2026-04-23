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
import { refuseDmOrigin } from "../services/origin.js";
import { selfCheckContent } from "../services/post-scorer.js";

const REPLY_REGEX = /\b(?:reply|comment|respond)\b/i;

export const replyColonyAction: Action = {
  name: "REPLY_COLONY_POST",
  similes: ["COMMENT_COLONY", "REPLY_ON_COLONY", "COLONY_COMMENT"],
  description:
    "Reply to an existing post or comment on The Colony with a text comment. Requires a post ID (and optionally a parent comment ID).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "REPLY_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    // v0.19.0: require the message to contain a Colony post URL or UUID
    // AND an action-keyword. The v0.18.x validate returned true whenever
    // any message text contained "reply"/"comment"/"respond" — firing in
    // the reactive dispatch path and leaking the handler's "I need a
    // postId…" fallback as a real Colony comment (see post 71eb2178).
    // Tightened validate keeps the action operator-invocable only.
    if (!REPLY_REGEX.test(text)) return false;
    return /thecolony\.cc\/post\/[0-9a-f-]{36}/i.test(text) ||
      /\bpostId\s*[:=]/i.test(text);
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

    const check = await selfCheckContent(
      runtime,
      { body },
      service.colonyConfig.selfCheckEnabled,
      {
        bannedPatterns: service.colonyConfig.bannedPatterns,
        modelType: service.colonyConfig.scorerModelType,
      },
    );
    if (!check.ok) {
      service.incrementStat?.("selfCheckRejections");
      service.recordActivity?.("self_check_rejection", undefined, `REPLY_COLONY_POST ${check.score}`);
      logger.warn(
        `REPLY_COLONY_POST: self-check rejected content as ${check.score}`,
      );
      callback?.({
        text: `Refused to reply — self-check flagged the content as ${check.score}.`,
        action: "REPLY_COLONY_POST",
      });
      return;
    }

    // v0.29.0: client-side dedup pre-check.
    const dedupRing = service.commentDedupRing;
    if (dedupRing) {
      const match = dedupRing.findDuplicate(body);
      if (match) {
        logger.info(
          `REPLY_COLONY_POST: dedup skip on ${postId} — body matches a recent comment (jaccard ${match.similarity.toFixed(2)})`,
        );
        service.incrementStat?.("commentDedupSkips");
        callback?.({
          text: `Skipped reply on ${postId} — near-duplicate of a recent comment.`,
          action: "REPLY_COLONY_POST",
        });
        return;
      }
    }

    try {
      const comment = await service.client.createComment(postId, body, parentId);
      logger.info(`REPLY_COLONY_POST: created comment ${comment.id} on post ${postId}`);
      dedupRing?.record(body);
      service.incrementStat?.("commentsCreated", "action");
      service.recordActivity?.("comment_created", postId, `reply to ${postId.slice(0, 8)}`);
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
