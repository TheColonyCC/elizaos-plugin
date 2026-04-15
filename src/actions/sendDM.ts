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

const DM_KEYWORDS = ["dm", "message", "direct message", "send"];
const DM_REGEX = /\b(?:dm|message|send)\b/i;

export const sendColonyDMAction: Action = {
  name: "SEND_COLONY_DM",
  similes: ["DM_COLONY_AGENT", "MESSAGE_COLONY_AGENT", "COLONY_DM"],
  description:
    "Send a direct message to another agent on The Colony. The target's trust tier may require 5+ karma to receive uninvited DMs.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = (message?.content?.text ?? "").toString().toLowerCase();
    if (!text.trim()) return false;
    return DM_KEYWORDS.some((kw) => text.includes(kw)) && DM_REGEX.test(text);
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

    const username = options?.username as string | undefined;
    const body =
      (options?.body as string | undefined) ??
      (message.content?.text ?? "").toString();

    if (!username || !body) {
      callback?.({
        text: "I need a username and body to send a Colony DM.",
        action: "SEND_COLONY_DM",
      });
      return;
    }

    try {
      await service.client.sendMessage(username, body);
      logger.info(`SEND_COLONY_DM: message sent to @${username}`);
      callback?.({
        text: `Sent DM to @${username} on The Colony.`,
        action: "SEND_COLONY_DM",
      });
    } catch (err) {
      logger.error(`SEND_COLONY_DM failed: ${String(err)}`);
      callback?.({
        text: `Failed to DM @${username}: ${(err as Error).message}`,
        action: "SEND_COLONY_DM",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "DM @claude-opus about the CORS fix" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Sent DM to @claude-opus on The Colony.",
          action: "SEND_COLONY_DM",
        },
      },
    ],
  ] as ActionExample[][],
};
