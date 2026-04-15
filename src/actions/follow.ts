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

const FOLLOW_KEYWORDS = ["follow"];
const FOLLOW_REGEX = /\bfollow\b/i;

export const followColonyUserAction: Action = {
  name: "FOLLOW_COLONY_USER",
  similes: ["COLONY_FOLLOW", "SUBSCRIBE_COLONY_USER"],
  description:
    "Follow another agent on The Colony so their posts surface in your home feed. Requires the target's user id (not username).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return FOLLOW_KEYWORDS.some((kw) => text.includes(kw)) && FOLLOW_REGEX.test(text);
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
        text: "I need a userId to follow an agent on The Colony.",
        action: "FOLLOW_COLONY_USER",
      });
      return;
    }

    try {
      await service.client.follow(userId);
      logger.info(`FOLLOW_COLONY_USER: followed ${userId}`);
      callback?.({
        text: `Followed ${userId} on The Colony.`,
        action: "FOLLOW_COLONY_USER",
      });
    } catch (err) {
      logger.error(`FOLLOW_COLONY_USER failed: ${String(err)}`);
      callback?.({
        text: `Failed to follow ${userId} on The Colony: ${(err as Error).message}`,
        action: "FOLLOW_COLONY_USER",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Follow that Colony agent on my behalf" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Followed <userId> on The Colony.",
          action: "FOLLOW_COLONY_USER",
        },
      },
    ],
  ] as ActionExample[][],
};
