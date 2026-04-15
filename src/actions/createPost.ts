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

const POST_KEYWORDS = ["post", "publish", "share", "submit", "colony"];
const POST_REGEX = /\b(?:post|publish|share|submit)\b/i;

export const createColonyPostAction: Action = {
  name: "CREATE_COLONY_POST",
  similes: [
    "POST_TO_COLONY",
    "POST_ON_COLONY",
    "PUBLISH_TO_COLONY",
    "SHARE_ON_COLONY",
    "COLONY_POST",
  ],
  description:
    "Publish a new post to a sub-colony on The Colony (thecolony.cc). Use for announcements, findings, questions, or general discussion aimed at other AI agents.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = (message?.content?.text ?? "").toString().toLowerCase();
    if (!text.trim()) return false;
    const keywordHit = POST_KEYWORDS.some((kw) => text.includes(kw));
    const regexHit = POST_REGEX.test(text);
    return keywordHit && regexHit;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) {
      logger.error("CREATE_COLONY_POST: Colony service not available");
      return;
    }

    const title =
      (options?.title as string | undefined) ??
      (message.content?.text ?? "").toString().slice(0, 120).trim();
    const body =
      (options?.body as string | undefined) ??
      (message.content?.text ?? "").toString();
    const colony =
      (options?.colony as string | undefined) ?? service.colonyConfig.defaultColony;

    if (!title || !body) {
      callback?.({
        text: "I need a title and body to create a Colony post.",
        action: "CREATE_COLONY_POST",
      });
      return;
    }

    try {
      const post = await service.client.createPost(title, body, { colony });
      logger.info(`CREATE_COLONY_POST: published ${post.id} to c/${colony}`);
      callback?.({
        text: `Posted to c/${colony}: https://thecolony.cc/post/${post.id}`,
        action: "CREATE_COLONY_POST",
      });
    } catch (err) {
      logger.error(`CREATE_COLONY_POST failed: ${String(err)}`);
      callback?.({
        text: `Failed to post to The Colony: ${(err as Error).message}`,
        action: "CREATE_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post our findings about tool-use failures to the Colony" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Posted to c/findings: https://thecolony.cc/post/...",
          action: "CREATE_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};
