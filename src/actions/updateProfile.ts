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

const UPDATE_REGEX = /\b(?:update|change|set|edit).*(?:profile|bio|display name)\b/i;

/**
 * Operator-triggered profile update. Wraps `client.updateProfile`.
 * Options: `displayName`, `bio`, `capabilities` (JsonObject). All
 * fields optional — only supplied ones are updated.
 *
 * Colony rate-limits this endpoint to 10/hour; 429 is surfaced to the
 * operator unchanged.
 */
export const updateColonyProfileAction: Action = {
  name: "UPDATE_COLONY_PROFILE",
  similes: ["EDIT_COLONY_PROFILE", "COLONY_PROFILE_UPDATE"],
  description:
    "Update the agent's own Colony profile (display name, bio, capabilities). Rate-limited to 10/hour server-side.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony") && !text.includes("profile") && !text.includes("bio")) return false;
    return UPDATE_REGEX.test(text);
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

    const displayName =
      typeof options?.displayName === "string" ? (options.displayName as string) : undefined;
    const bio = typeof options?.bio === "string" ? (options.bio as string) : undefined;
    const capabilities =
      options?.capabilities && typeof options.capabilities === "object"
        ? (options.capabilities as Record<string, unknown>)
        : undefined;

    if (displayName === undefined && bio === undefined && capabilities === undefined) {
      callback?.({
        text: "I need at least one of `displayName`, `bio`, or `capabilities` to update the profile.",
        action: "UPDATE_COLONY_PROFILE",
      });
      return;
    }

    const updateOpts: Record<string, unknown> = {};
    if (displayName !== undefined) updateOpts.displayName = displayName;
    if (bio !== undefined) updateOpts.bio = bio;
    if (capabilities !== undefined) updateOpts.capabilities = capabilities;

    try {
      await (service.client as unknown as {
        updateProfile: (opts: Record<string, unknown>) => Promise<unknown>;
      }).updateProfile(updateOpts);
      logger.info(
        `UPDATE_COLONY_PROFILE: updated fields ${Object.keys(updateOpts).join(", ")}`,
      );
      service.recordActivity?.(
        "post_created",
        service.username,
        `profile update: ${Object.keys(updateOpts).join("+")}`,
      );
      callback?.({
        text: `Updated Colony profile (${Object.keys(updateOpts).join(", ")}).`,
        action: "UPDATE_COLONY_PROFILE",
      });
    } catch (err) {
      logger.error(`UPDATE_COLONY_PROFILE failed: ${String(err)}`);
      callback?.({
        text: `Failed to update profile: ${(err as Error).message}`,
        action: "UPDATE_COLONY_PROFILE",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Update my colony bio to reflect the v0.13 features" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Updated Colony profile (bio).",
          action: "UPDATE_COLONY_PROFILE",
        },
      },
    ],
  ] as ActionExample[][],
};
