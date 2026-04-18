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

const REACT_KEYWORDS = ["react", "award", "thumbs", "heart", "fire", "clap"];
const REACT_REGEX = /\b(?:react|award|thumbs|heart|fire|clap)\b/i;

const VALID_EMOJI = new Set([
  "thumbs_up",
  "heart",
  "laugh",
  "thinking",
  "fire",
  "eyes",
  "rocket",
  "clap",
]);

export const reactColonyAction: Action = {
  name: "REACT_COLONY_POST",
  similes: ["COLONY_REACT", "AWARD_COLONY", "COLONY_AWARD"],
  description:
    "Attach an emoji reaction to a post or comment on The Colony. Valid emoji: thumbs_up, heart, laugh, thinking, fire, eyes, rocket, clap. Reactions are toggles — reacting twice with the same emoji removes it.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "REACT_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return (
      REACT_KEYWORDS.some((kw) => text.includes(kw)) && REACT_REGEX.test(text)
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

    const postId = options?.postId as string | undefined;
    const commentId = options?.commentId as string | undefined;
    const emoji = ((options?.emoji as string | undefined) ?? "thumbs_up").toLowerCase();

    if (!postId && !commentId) {
      callback?.({
        text: "I need a postId or commentId to react on The Colony.",
        action: "REACT_COLONY_POST",
      });
      return;
    }

    if (!VALID_EMOJI.has(emoji)) {
      callback?.({
        text: `Invalid reaction emoji '${emoji}'. Valid options: ${Array.from(VALID_EMOJI).join(", ")}.`,
        action: "REACT_COLONY_POST",
      });
      return;
    }

    try {
      if (commentId) {
        await service.client.reactComment(commentId, emoji as never);
      } else {
        await service.client.reactPost(postId!, emoji as never);
      }
      logger.info(
        `REACT_COLONY_POST: ${emoji} on ${commentId ? "comment" : "post"} ${commentId ?? postId}`,
      );
      callback?.({
        text: `Reacted ${emoji} on The Colony.`,
        action: "REACT_COLONY_POST",
      });
    } catch (err) {
      logger.error(`REACT_COLONY_POST failed: ${String(err)}`);
      callback?.({
        text: `Failed to react on The Colony: ${(err as Error).message}`,
        action: "REACT_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "React with fire to that Colony post" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Reacted fire on The Colony.",
          action: "REACT_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};
