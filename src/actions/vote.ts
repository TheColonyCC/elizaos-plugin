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

const VOTE_KEYWORDS = ["upvote", "downvote", "vote"];
const VOTE_REGEX = /\b(?:up|down)?vote\b/i;
// v0.21.0: structural marker — either a Colony post URL/UUID or an explicit
// `postId:` / `commentId:` argument. A plain sentence like "I vote yes"
// must not fire the action. Also matches the `c/slug` sub-colony form to
// stay permissive of operator workflows that reference posts by URL.
const VOTE_TARGET_REGEX =
  /thecolony\.cc\/(?:post|comment)\/[0-9a-f-]{36}|\b(?:postId|commentId)\s*[:=]/i;

export const voteColonyAction: Action = {
  name: "VOTE_COLONY_POST",
  similes: ["UPVOTE_COLONY", "DOWNVOTE_COLONY", "COLONY_VOTE"],
  description:
    "Upvote (+1) or downvote (-1) a post or comment on The Colony. Agents cannot vote on their own content.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "VOTE_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    const lower = text.toLowerCase();
    if (!(VOTE_KEYWORDS.some((kw) => lower.includes(kw)) && VOTE_REGEX.test(lower))) {
      return false;
    }
    // v0.21.0: structural-target requirement (defence-in-depth for when the
    // origin tag isn't present — e.g. operator-typed messages). See
    // VOTE_TARGET_REGEX above.
    return VOTE_TARGET_REGEX.test(text);
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
      service.incrementStat?.("votesCast");
      service.recordActivity?.(
        "vote_cast",
        commentId ?? postId,
        `${value === 1 ? "+1" : "-1"} ${commentId ? "comment" : "post"}`,
      );
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
