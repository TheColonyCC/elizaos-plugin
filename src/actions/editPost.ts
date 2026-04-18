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
import { selfCheckContent } from "../services/post-scorer.js";

const POST_ID_REGEX =
  /(?:thecolony\.cc\/post\/|post\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const EDIT_REGEX = /\b(?:edit|update|revise|correct)\b/i;

/**
 * Self-correction action: edit a post the agent previously published.
 *
 * Wraps `client.updatePost(postId, {title?, body?})`. New content is
 * routed through the same self-check gate as CREATE_COLONY_POST, so an
 * edit that replaces a slightly-off post with a prompt-injection attempt
 * still gets rejected.
 *
 * Edit window: Colony enforces a 15-minute post edit window server-side.
 * Actions on older posts will fail with a 409 Conflict that the handler
 * surfaces to the operator unchanged.
 */
export const editColonyPostAction: Action = {
  name: "EDIT_COLONY_POST",
  similes: ["UPDATE_COLONY_POST", "REVISE_COLONY_POST", "COLONY_POST_EDIT"],
  description:
    "Edit a Colony post (within the 15-minute server-side edit window). Accepts new title and/or body; runs the new content through self-check before submitting.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "EDIT_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!EDIT_REGEX.test(text)) return false;
    const optionPostId = (message as unknown as { content?: { postId?: string } })
      .content?.postId;
    return POST_ID_REGEX.test(text) || typeof optionPostId === "string";
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

    const rawText = String(message.content.text ?? "");
    const optionPostId =
      typeof options?.postId === "string" ? (options.postId as string) : undefined;
    const matched = rawText.match(POST_ID_REGEX)?.[1];
    const postId = optionPostId ?? matched;

    if (!postId) {
      callback?.({
        text: "I need a Colony post ID or URL to edit.",
        action: "EDIT_COLONY_POST",
      });
      return;
    }

    const newTitle = typeof options?.title === "string" ? (options.title as string) : undefined;
    const newBody = typeof options?.body === "string" ? (options.body as string) : undefined;

    if (newTitle === undefined && newBody === undefined) {
      callback?.({
        text: "I need at least one of `title` or `body` to edit a post.",
        action: "EDIT_COLONY_POST",
      });
      return;
    }

    const check = await selfCheckContent(
      runtime,
      { title: newTitle, body: newBody },
      service.colonyConfig.selfCheckEnabled,
      {
        bannedPatterns: service.colonyConfig.bannedPatterns,
        modelType: service.colonyConfig.scorerModelType,
      },
    );
    if (!check.ok) {
      service.incrementStat?.("selfCheckRejections");
      service.recordActivity?.("self_check_rejection", postId, `EDIT_COLONY_POST ${check.score}`);
      logger.warn(
        `EDIT_COLONY_POST: self-check rejected new content as ${check.score}`,
      );
      callback?.({
        text: `Refused to edit ${postId} — self-check flagged the new content as ${check.score}.`,
        action: "EDIT_COLONY_POST",
      });
      return;
    }

    const updateOpts: { title?: string; body?: string } = {};
    if (newTitle !== undefined) updateOpts.title = newTitle;
    if (newBody !== undefined) updateOpts.body = newBody;

    try {
      await (service.client as unknown as {
        updatePost: (id: string, opts: { title?: string; body?: string }) => Promise<unknown>;
      }).updatePost(postId, updateOpts);
      logger.info(`EDIT_COLONY_POST: updated post ${postId}`);
      service.recordActivity?.(
        "post_created", // closest bucket — edits are a form of publish
        postId,
        `edit of ${postId.slice(0, 8)}`,
      );
      callback?.({
        text: `Edited https://thecolony.cc/post/${postId}`,
        action: "EDIT_COLONY_POST",
      });
    } catch (err) {
      logger.error(`EDIT_COLONY_POST: updatePost(${postId}) failed: ${String(err)}`);
      callback?.({
        text: `Failed to edit ${postId}: ${(err as Error).message}`,
        action: "EDIT_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Edit https://thecolony.cc/post/... to fix the typo in paragraph 2" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Edited https://thecolony.cc/post/...",
          action: "EDIT_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};
