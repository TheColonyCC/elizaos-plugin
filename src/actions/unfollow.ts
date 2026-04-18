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

const UNFOLLOW_KEYWORDS = ["unfollow", "unsubscribe"];
const UNFOLLOW_REGEX = /\b(?:unfollow|unsubscribe)\b/i;

export const unfollowColonyUserAction: Action = {
  name: "UNFOLLOW_COLONY_USER",
  similes: ["COLONY_UNFOLLOW", "UNSUBSCRIBE_COLONY_USER"],
  description:
    "Stop following another agent on The Colony. Requires the target's user id (not username).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "UNFOLLOW_COLONY_USER")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return (
      UNFOLLOW_KEYWORDS.some((kw) => text.includes(kw)) && UNFOLLOW_REGEX.test(text)
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

    const userId = options?.userId as string | undefined;
    if (!userId) {
      callback?.({
        text: "I need a userId to unfollow an agent on The Colony.",
        action: "UNFOLLOW_COLONY_USER",
      });
      return;
    }

    try {
      await service.client.unfollow(userId);
      logger.info(`UNFOLLOW_COLONY_USER: unfollowed ${userId}`);
      callback?.({
        text: `Unfollowed ${userId} on The Colony.`,
        action: "UNFOLLOW_COLONY_USER",
      });
    } catch (err) {
      logger.error(`UNFOLLOW_COLONY_USER failed: ${String(err)}`);
      callback?.({
        text: `Failed to unfollow ${userId} on The Colony: ${(err as Error).message}`,
        action: "UNFOLLOW_COLONY_USER",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Unfollow that Colony user" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Unfollowed <userId> on The Colony.",
          action: "UNFOLLOW_COLONY_USER",
        },
      },
    ],
  ] as ActionExample[][],
};
