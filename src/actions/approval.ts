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
import type { Draft } from "../services/draft-queue.js";

const PENDING_REGEX = /\b(?:pending|drafts?|approvals?)\b/i;
const APPROVE_REGEX = /\b(?:approve|publish)\b/i;
const REJECT_REGEX = /\b(?:reject|discard|drop)\b/i;
const DRAFT_ID_REGEX = /\b(draft-\d+-[a-z0-9]+)\b/i;

/**
 * Operator-triggered "list pending draft approvals".
 *
 * When `COLONY_POST_APPROVAL=true`, autonomous post/engagement output
 * is routed through a draft queue instead of being published directly.
 * This action lists everything currently waiting for approval.
 */
export const colonyPendingApprovalsAction: Action = {
  name: "COLONY_PENDING_APPROVALS",
  similes: ["LIST_COLONY_DRAFTS", "COLONY_DRAFTS", "PENDING_COLONY_POSTS"],
  description:
    "List pending draft posts/comments awaiting operator approval. Requires COLONY_POST_APPROVAL=true.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return PENDING_REGEX.test(text);
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

    if (!service.draftQueue) {
      callback?.({
        text: "Draft approval mode is not enabled. Set `COLONY_POST_APPROVAL=true` to route autonomous output through this queue.",
        action: "COLONY_PENDING_APPROVALS",
      });
      return;
    }

    const drafts = await service.draftQueue.pending();
    if (!drafts.length) {
      callback?.({
        text: "No pending drafts.",
        action: "COLONY_PENDING_APPROVALS",
      });
      return;
    }

    const lines = [`${drafts.length} pending drafts (newest last):`];
    for (const d of drafts) {
      lines.push(formatDraft(d));
    }
    callback?.({
      text: lines.join("\n"),
      action: "COLONY_PENDING_APPROVALS",
    });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "List pending colony drafts" } },
      {
        name: "{{agent}}",
        content: {
          text: "3 pending drafts (newest last):\n- draft-… (post, post_client, 12m ago): Title…\n…",
          action: "COLONY_PENDING_APPROVALS",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Operator-triggered "approve and publish this draft." Removes the draft
 * from the queue and publishes via the appropriate SDK call (createPost
 * for post drafts, createComment for comment drafts).
 */
export const approveColonyDraftAction: Action = {
  name: "APPROVE_COLONY_DRAFT",
  similes: ["PUBLISH_COLONY_DRAFT", "COLONY_APPROVE"],
  description:
    "Approve and publish a pending Colony draft. Accepts a draft id from COLONY_PENDING_APPROVALS.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony") && !text.includes("draft")) return false;
    if (!APPROVE_REGEX.test(text)) return false;
    const optionId = (message as unknown as { content?: { draftId?: string } })
      .content?.draftId;
    return DRAFT_ID_REGEX.test(text) || typeof optionId === "string";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service || !service.draftQueue) {
      callback?.({
        text: "Draft approval queue not available.",
        action: "APPROVE_COLONY_DRAFT",
      });
      return;
    }

    const rawText = String(message.content.text ?? "");
    const draftId =
      (typeof options?.draftId === "string" ? (options.draftId as string) : undefined) ??
      rawText.match(DRAFT_ID_REGEX)?.[1];

    if (!draftId) {
      callback?.({
        text: "I need a draft id (e.g. draft-1234...).",
        action: "APPROVE_COLONY_DRAFT",
      });
      return;
    }

    const draft = await service.draftQueue.get(draftId);
    if (!draft) {
      callback?.({
        text: `No pending draft with id ${draftId} (may have expired or already been handled).`,
        action: "APPROVE_COLONY_DRAFT",
      });
      return;
    }

    try {
      if (draft.kind === "post") {
        const { title, body, colony, postType } = draft.payload;
        if (!title || !body) throw new Error("draft missing title/body");
        const post = (await service.client.createPost(title, body, {
          colony: colony ?? service.colonyConfig.defaultColony,
          ...(postType ? { postType: postType as never } : {}),
        })) as { id?: string };
        logger.info(`APPROVE_COLONY_DRAFT: published post draft ${draftId} → ${post.id}`);
        service.incrementStat?.("postsCreated", "action");
        service.recordActivity?.(
          "post_created",
          post.id,
          `approved draft ${draftId}: ${title.slice(0, 60)}`,
        );
        await service.draftQueue.remove(draftId);
        callback?.({
          text: `Published draft ${draftId}: https://thecolony.cc/post/${post.id}`,
          action: "APPROVE_COLONY_DRAFT",
        });
      } else {
        const { postId, body, parentCommentId } = draft.payload;
        if (!postId || !body) throw new Error("draft missing postId/body");
        await service.client.createComment(postId, body, parentCommentId);
        logger.info(`APPROVE_COLONY_DRAFT: published comment draft ${draftId} on ${postId}`);
        service.incrementStat?.("commentsCreated", "action");
        service.recordActivity?.(
          "comment_created",
          postId,
          `approved draft ${draftId}`,
        );
        await service.draftQueue.remove(draftId);
        callback?.({
          text: `Published draft ${draftId} (comment on https://thecolony.cc/post/${postId}).`,
          action: "APPROVE_COLONY_DRAFT",
        });
      }
    } catch (err) {
      logger.error(`APPROVE_COLONY_DRAFT: publish failed for ${draftId}: ${String(err)}`);
      callback?.({
        text: `Failed to publish draft ${draftId}: ${(err as Error).message}`,
        action: "APPROVE_COLONY_DRAFT",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Approve colony draft draft-12345-abc" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Published draft draft-12345-abc: https://thecolony.cc/post/…",
          action: "APPROVE_COLONY_DRAFT",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Operator-triggered "reject and discard this draft." Removes the draft
 * from the queue without publishing.
 */
export const rejectColonyDraftAction: Action = {
  name: "REJECT_COLONY_DRAFT",
  similes: ["DISCARD_COLONY_DRAFT", "COLONY_REJECT"],
  description:
    "Reject and discard a pending Colony draft. Accepts a draft id from COLONY_PENDING_APPROVALS.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony") && !text.includes("draft")) return false;
    if (!REJECT_REGEX.test(text)) return false;
    const optionId = (message as unknown as { content?: { draftId?: string } })
      .content?.draftId;
    return DRAFT_ID_REGEX.test(text) || typeof optionId === "string";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service || !service.draftQueue) {
      callback?.({
        text: "Draft approval queue not available.",
        action: "REJECT_COLONY_DRAFT",
      });
      return;
    }

    const rawText = String(message.content.text ?? "");
    const draftId =
      (typeof options?.draftId === "string" ? (options.draftId as string) : undefined) ??
      rawText.match(DRAFT_ID_REGEX)?.[1];

    if (!draftId) {
      callback?.({
        text: "I need a draft id (e.g. draft-1234...).",
        action: "REJECT_COLONY_DRAFT",
      });
      return;
    }

    const removed = await service.draftQueue.remove(draftId);
    if (!removed) {
      callback?.({
        text: `No pending draft with id ${draftId}.`,
        action: "REJECT_COLONY_DRAFT",
      });
      return;
    }

    logger.info(`REJECT_COLONY_DRAFT: discarded ${draftId}`);
    service.recordActivity?.(
      "self_check_rejection",
      draftId,
      `operator rejected draft (${removed.kind})`,
    );
    callback?.({
      text: `Discarded draft ${draftId} (${removed.kind}).`,
      action: "REJECT_COLONY_DRAFT",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Reject colony draft draft-12345-abc" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Discarded draft draft-12345-abc (post).",
          action: "REJECT_COLONY_DRAFT",
        },
      },
    ],
  ] as ActionExample[][],
};

export function formatDraft(d: Draft): string {
  const ageMin = Math.max(0, Math.round((Date.now() - d.createdAt) / 60_000));
  const expMin = Math.max(0, Math.round((d.expiresAt - Date.now()) / 60_000));
  if (d.kind === "post") {
    const { title, body, colony } = d.payload;
    const preview = (title ?? "").slice(0, 80);
    const bodyLen = (body ?? "").length;
    return `- ${d.id} (post to c/${colony}, ${d.source}, ${ageMin}m old, ${expMin}m until expiry): "${preview}" (${bodyLen} chars)`;
  }
  const { postId, body, parentCommentId } = d.payload;
  const preview = (body ?? "").slice(0, 80);
  const bodyLen = (body ?? "").length;
  const threadHint = parentCommentId ? ` → ${parentCommentId.slice(0, 8)}` : "";
  return `- ${d.id} (comment on ${postId?.slice(0, 8)}${threadHint}, ${d.source}, ${ageMin}m old, ${expMin}m until expiry): "${preview}" (${bodyLen} chars)`;
}
