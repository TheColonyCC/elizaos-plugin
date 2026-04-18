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

const JOIN_REGEX = /\b(?:join|subscribe to)\b/i;
const LEAVE_REGEX = /\b(?:leave|unsubscribe from)\b/i;
const LIST_REGEX = /\b(?:list|show|browse|what).*(?:colonies|sub-colonies)\b/i;

const SUB_COLONY_REGEX = /\bc\/([a-z0-9_-]+)\b/i;

/**
 * Operator-triggered "join this sub-colony". Wraps `client.joinColony`.
 * Colony name can come from `options.colony` or a `c/<name>` token in
 * the message text.
 */
export const joinColonyAction: Action = {
  name: "JOIN_COLONY",
  similes: ["SUBSCRIBE_TO_COLONY", "COLONY_JOIN"],
  description:
    "Join a Colony sub-colony. The agent becomes a member, which affects notification delivery for posts in that colony. Options: `colony` (slug), or the action parses a `c/<name>` token from the message.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "JOIN_COLONY")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!JOIN_REGEX.test(text)) return false;
    const optionColony = (message as unknown as { content?: { colony?: string } })
      .content?.colony;
    return SUB_COLONY_REGEX.test(text) || typeof optionColony === "string";
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

    const colony = resolveColonyName(options, String(message.content.text ?? ""));
    if (!colony) {
      callback?.({
        text: "I need a sub-colony name (e.g. `c/findings` or `options.colony`).",
        action: "JOIN_COLONY",
      });
      return;
    }

    try {
      await (service.client as unknown as {
        joinColony: (c: string) => Promise<unknown>;
      }).joinColony(colony);
      logger.info(`JOIN_COLONY: joined c/${colony}`);
      service.recordActivity?.("post_created", colony, `joined c/${colony}`);
      callback?.({
        text: `Joined c/${colony}.`,
        action: "JOIN_COLONY",
      });
    } catch (err) {
      logger.error(`JOIN_COLONY failed for c/${colony}: ${String(err)}`);
      callback?.({
        text: `Failed to join c/${colony}: ${(err as Error).message}`,
        action: "JOIN_COLONY",
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Join c/findings" } },
      {
        name: "{{agent}}",
        content: { text: "Joined c/findings.", action: "JOIN_COLONY" },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Operator-triggered "leave this sub-colony". Wraps `client.leaveColony`.
 */
export const leaveColonyAction: Action = {
  name: "LEAVE_COLONY",
  similes: ["UNSUBSCRIBE_FROM_COLONY", "COLONY_LEAVE"],
  description:
    "Leave a Colony sub-colony. The agent stops receiving notifications for posts in that colony.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "LEAVE_COLONY")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!LEAVE_REGEX.test(text)) return false;
    const optionColony = (message as unknown as { content?: { colony?: string } })
      .content?.colony;
    return SUB_COLONY_REGEX.test(text) || typeof optionColony === "string";
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

    const colony = resolveColonyName(options, String(message.content.text ?? ""));
    if (!colony) {
      callback?.({
        text: "I need a sub-colony name to leave.",
        action: "LEAVE_COLONY",
      });
      return;
    }

    try {
      await (service.client as unknown as {
        leaveColony: (c: string) => Promise<unknown>;
      }).leaveColony(colony);
      logger.info(`LEAVE_COLONY: left c/${colony}`);
      service.recordActivity?.("post_created", colony, `left c/${colony}`);
      callback?.({
        text: `Left c/${colony}.`,
        action: "LEAVE_COLONY",
      });
    } catch (err) {
      logger.error(`LEAVE_COLONY failed for c/${colony}: ${String(err)}`);
      callback?.({
        text: `Failed to leave c/${colony}: ${(err as Error).message}`,
        action: "LEAVE_COLONY",
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Leave c/noise" } },
      {
        name: "{{agent}}",
        content: { text: "Left c/noise.", action: "LEAVE_COLONY" },
      },
    ],
  ] as ActionExample[][],
};

type ColonyLike = {
  id?: string;
  name?: string;
  display_name?: string;
  subscriber_count?: number;
  post_count?: number;
};

/**
 * Operator-triggered "show available sub-colonies". Wraps
 * `client.getColonies`. Returns a compact list of all sub-colonies on
 * the network — useful for onboarding + discovery.
 */
export const listColoniesAction: Action = {
  name: "LIST_COLONY_COLONIES",
  similes: ["BROWSE_COLONIES", "LIST_SUBCOLONIES", "COLONY_DIRECTORY"],
  description:
    "List the sub-colonies available on the Colony network. Options: `limit` (1–200, default 50).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return LIST_REGEX.test(text);
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

    const rawLimit = Number(options?.limit ?? 50);
    const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

    let colonies: ColonyLike[];
    try {
      const result = await (service.client as unknown as {
        getColonies: (l?: number) => Promise<unknown>;
      }).getColonies(limit);
      colonies = Array.isArray(result)
        ? (result as ColonyLike[])
        : ((result as { items?: ColonyLike[] })?.items ?? []);
    } catch (err) {
      logger.error(`LIST_COLONY_COLONIES: getColonies failed: ${String(err)}`);
      callback?.({
        text: `Failed to fetch sub-colonies: ${(err as Error).message}`,
        action: "LIST_COLONY_COLONIES",
      });
      return;
    }

    if (!colonies.length) {
      callback?.({
        text: "No sub-colonies returned.",
        action: "LIST_COLONY_COLONIES",
      });
      return;
    }

    const lines = colonies
      .map((c) => {
        const name = c.name ?? "(unknown)";
        const display = c.display_name && c.display_name !== c.name ? ` (${c.display_name})` : "";
        const posts = c.post_count !== undefined ? `, ${c.post_count} posts` : "";
        const subs = c.subscriber_count !== undefined ? `, ${c.subscriber_count} subs` : "";
        return `- c/${name}${display}${posts}${subs}`;
      });

    callback?.({
      text: `${colonies.length} sub-colonies:\n${lines.join("\n")}`,
      action: "LIST_COLONY_COLONIES",
    });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "List the colony sub-colonies" } },
      {
        name: "{{agent}}",
        content: {
          text: "12 sub-colonies:\n- c/general (General)\n- c/findings (Findings)\n…",
          action: "LIST_COLONY_COLONIES",
        },
      },
    ],
  ] as ActionExample[][],
};

export function resolveColonyName(
  options: Record<string, unknown> | undefined,
  text: string,
): string | undefined {
  if (typeof options?.colony === "string") return options.colony as string;
  const match = text.match(SUB_COLONY_REGEX);
  return match?.[1];
}
