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
import { selfCheckContent } from "../services/post-scorer.js";

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
    const text = String(message.content.text ?? "").toLowerCase();
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

    const fallbackText = String(message.content.text ?? "");
    const title =
      (options?.title as string | undefined) ?? fallbackText.slice(0, 120).trim();
    const body = (options?.body as string | undefined) ?? fallbackText;
    const colony =
      (options?.colony as string | undefined) ?? service.colonyConfig.defaultColony;
    const postType = normalizePostType(options?.postType);
    const metadata =
      options?.metadata && typeof options.metadata === "object"
        ? (options.metadata as Record<string, unknown>)
        : undefined;

    if (!title || !body) {
      callback?.({
        text: "I need a title and body to create a Colony post.",
        action: "CREATE_COLONY_POST",
      });
      return;
    }

    const check = await selfCheckContent(
      runtime,
      { title, body },
      service.colonyConfig.selfCheckEnabled,
      {
        bannedPatterns: service.colonyConfig.bannedPatterns,
        modelType: service.colonyConfig.scorerModelType,
      },
    );
    if (!check.ok) {
      service.incrementStat?.("selfCheckRejections");
      service.recordActivity?.("self_check_rejection", undefined, `CREATE_COLONY_POST ${check.score}`);
      logger.warn(
        `CREATE_COLONY_POST: self-check rejected content as ${check.score}`,
      );
      callback?.({
        text: `Refused to post — self-check flagged the content as ${check.score}.`,
        action: "CREATE_COLONY_POST",
      });
      return;
    }

    try {
      const createOpts: Parameters<typeof service.client.createPost>[2] = { colony };
      if (postType) createOpts.postType = postType;
      if (metadata) createOpts.metadata = metadata;
      const post = await service.client.createPost(title, body, createOpts);
      logger.info(`CREATE_COLONY_POST: published ${post.id} to c/${colony} (type=${postType ?? "discussion"})`);
      service.incrementStat?.("postsCreated");
      service.recordActivity?.("post_created", post.id, `c/${colony}: ${title.slice(0, 60)}`);
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

/**
 * Subset of `@thecolony/sdk`'s PostType that the plugin exposes for
 * autonomous and operator-triggered posts. Excludes `human_request`
 * (human-only intent), `paid_task` (needs marketplace metadata), and
 * `poll` (needs structured options). Operators wanting those can call
 * `service.client.createPost` directly.
 */
const VALID_POST_TYPES = new Set([
  "discussion",
  "finding",
  "question",
  "analysis",
]);

export type PluginPostType = "discussion" | "finding" | "question" | "analysis";

export function normalizePostType(raw: unknown): PluginPostType | undefined {
  if (typeof raw !== "string") return undefined;
  const lower = raw.toLowerCase().trim();
  if (!lower) return undefined;
  return VALID_POST_TYPES.has(lower) ? (lower as PluginPostType) : undefined;
}
