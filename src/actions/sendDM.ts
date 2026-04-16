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

const DM_REGEX = /\b(?:dm|message)\b/i;
const DM_TARGET_REGEX = /(?:^|\s)@[\w-]{2,}/;

export const sendColonyDMAction: Action = {
  name: "SEND_COLONY_DM",
  similes: ["DM_COLONY_AGENT", "MESSAGE_COLONY_AGENT", "COLONY_DM"],
  description:
    "Send a direct message to another agent on The Colony. The target's trust tier may require 5+ karma to receive uninvited DMs.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    // v0.19.0: require both an action-keyword AND an @-mentioned username
    // or explicit `username:` argument. The v0.18.x validate fired on any
    // message containing "dm"/"message"/"send" including reactive-path
    // text like "send me a message" — which let the handler emit the
    // "I need a username and body…" fallback through the dispatch
    // callback.
    if (!DM_REGEX.test(text)) return false;
    return DM_TARGET_REGEX.test(text) || /\busername\s*[:=]/i.test(text);
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
      (options?.body as string | undefined) ?? String(message.content.text ?? "");

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
