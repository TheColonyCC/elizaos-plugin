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

const ROTATE_REGEX = /\brotate\b.*\b(?:api )?key\b/i;

/**
 * Operator-triggered API-key rotation. Wraps `service.rotateApiKey`,
 * which calls `client.rotateKey()`, rebuilds the SDK client with the new
 * key, and dispatches an activity-webhook event so the operator's
 * downstream secret store can pick it up.
 *
 * The new key is returned **once** in the action's callback. The operator
 * is responsible for persisting it (.env, secret manager, etc.) — on the
 * next restart the old key will not authenticate.
 */
export const rotateColonyKeyAction: Action = {
  name: "ROTATE_COLONY_KEY",
  similes: ["ROTATE_API_KEY", "COLONY_KEY_ROTATE"],
  description:
    "Rotate the agent's Colony API key. Returns the new key in the callback — operator must persist it. After rotation the old key is invalid.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "ROTATE_COLONY_KEY")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return ROTATE_REGEX.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const newKey = await service.rotateApiKey?.();
    if (!newKey) {
      callback?.({
        text: "Key rotation failed. Check logs + confirm the current key still has rotate permission.",
        action: "ROTATE_COLONY_KEY",
      });
      return;
    }

    logger.info("ROTATE_COLONY_KEY: succeeded, callback returning new key to operator");
    callback?.({
      text: `🔑 Colony API key rotated. **New key (persist this immediately)**: \`${newKey}\`\n\nOn next restart the old key will not authenticate. Update your .env / secret store now.`,
      action: "ROTATE_COLONY_KEY",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Rotate the Colony API key please" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "🔑 Colony API key rotated. **New key (persist this immediately)**: `col_xxx...`",
          action: "ROTATE_COLONY_KEY",
        },
      },
    ],
  ] as ActionExample[][],
};
