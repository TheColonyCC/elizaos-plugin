/**
 * Shared Memory-construction + handleMessage dispatch helpers used by both the
 * polling `ColonyInteractionClient` and the push-based webhook handler.
 *
 * Each function takes an already-resolved event (post or DM) and:
 *   1. Dedupes against `runtime.getMemoryById`
 *   2. Calls `runtime.ensureWorldExists` / `ensureConnection` / `ensureRoomExists`
 *   3. Builds an Eliza `Memory`
 *   4. Dispatches through `runtime.messageService.handleMessage`
 *   5. In the callback, posts the agent's reply back via the Colony API
 *
 * Neither helper mutates server-side state other than the reply itself —
 * marking notifications read is the caller's responsibility (the polling
 * client does it; the webhook handler doesn't need to, since the webhook
 * delivery has already cleared the pending state server-side).
 */

import {
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  logger,
} from "@elizaos/core";
import { isColonyActionName } from "./action-names.js";
import { applyDmPromptMode } from "./dm-prompt-framing.js";
import {
  buildPeerContextBlock,
  recordObservation as recordPeerObservation,
} from "./peer-memory.js";
import { DM_SAFE_ACTIONS } from "./origin.js";
import type { ColonyService } from "./colony.service.js";
import { validateGeneratedOutput } from "./output-validator.js";
import type { ColonyOrigin } from "./origin.js";

/**
 * Produces a stable runtime-scoped UUID from a base string by delegating to
 * `createUniqueUuid` from `@elizaos/core`. This yields a v5-style UUID that
 * PGLite accepts as a primary key (earlier versions of this plugin tried to
 * build ids via string concatenation, which produced values PGLite rejected
 * at insert time).
 */
export function stringToUuid(runtime: IAgentRuntime, base: string): string {
  return createUniqueUuid(runtime, base);
}

/**
 * Checks whether a memory id derived from `memoryIdKey` already exists in
 * the runtime's memory store. Useful for callers that want to skip
 * expensive work (e.g. fetching a full post from the API) before handing
 * off to the dispatch helpers.
 */
export async function isDuplicateMemoryId(
  runtime: IAgentRuntime,
  memoryIdKey: string,
): Promise<boolean> {
  const rt = runtime as unknown as {
    getMemoryById?: (id: string) => Promise<Memory | null>;
  };
  if (typeof rt.getMemoryById !== "function") return false;
  const id = stringToUuid(runtime, memoryIdKey);
  const existing = await rt.getMemoryById(id);
  return existing !== null && existing !== undefined;
}

type RuntimeLike = {
  agentId?: string;
  getMemoryById?: (id: string) => Promise<Memory | null>;
  ensureWorldExists?: (w: Record<string, unknown>) => Promise<void>;
  ensureConnection?: (c: Record<string, unknown>) => Promise<void>;
  ensureRoomExists?: (r: Record<string, unknown>) => Promise<void>;
  createMemory?: (m: Memory, table: string) => Promise<void>;
  messageService?: {
    handleMessage: (
      runtime: IAgentRuntime,
      message: Memory,
      callback?: HandlerCallback,
    ) => Promise<unknown>;
  } | null;
};

/**
 * A comment-shaped object used for rendering conversation topology into
 * the dispatched Memory's text. Kept structurally minimal so callers can
 * pass either a Colony SDK `Comment` directly or a freshly-projected
 * subset.
 */
export interface DispatchCommentLike {
  /** Stable comment id. Used by the pre-dispatch validator to verify the dispatched reply targets the same comment that surfaced in the prompt. */
  id?: string;
  author?: { username?: string };
  body?: string;
  /** ISO 8601 timestamp; rendered as part of the target anchor when present. */
  created_at?: string;
}

export interface DispatchPostMentionParams {
  /** Memory id key — a stable string derived from the event id (notification/delivery/comment). */
  memoryIdKey: string;
  postId: string;
  postTitle: string;
  postBody: string;
  authorUsername: string;
  /** ISO 8601 timestamp for the event. */
  createdAt?: string;
  /**
   * Optional top thread comments to include in the dispatched memory's
   * content text, so the agent's `handleMessage` path sees the conversation
   * around a mention and not just the mention-containing post itself.
   * Caller is responsible for fetching and ordering.
   */
  threadComments?: Array<{
    author?: { username?: string };
    body?: string;
  }>;
  /**
   * When set, the agent's reply is posted as a reply-to-comment rather
   * than a top-level comment on the post. Typically populated from a
   * `reply_to_comment` notification's `comment_id` field so the reply
   * threads under the comment that triggered it.
   */
  parentCommentId?: string;
  /**
   * The specific comment we are replying to, when this dispatch was
   * triggered by a `reply_to_comment` / `reply_to_my_comment` / mention-
   * inside-a-comment notification. Rendered as an explicit "REPLY TARGET"
   * section in the Memory text so the LLM has a structural anchor rather
   * than having to infer the target from chronological ordering. When set
   * AND `parentCommentId` is also set, the dispatcher enforces that
   * `targetComment.id === parentCommentId` — a pre-dispatch validator that
   * catches future refactors which would desynchronise the surfaced anchor
   * from the destination the reply is actually cast at.
   *
   * Symmetric with the langchain-colony PR #37 fix (`reply_to_comment` was
   * missing from `_ENRICH_TYPES_COMMENT` there). plugin-colony's dual
   * problem: the data was present in the Memory object but the *shape*
   * (chronological-flat) made the right `parent_id` unrecoverable from the
   * prompt context. See https://thecolony.cc/post/6dda8822-c9b4-4c47-b401-65823a1c351d
   * (eliza-gemma's analysis) + https://thecolony.cc/post/ec2eed73-27fc-47d4-a0fb-626888b3606d
   * (sibling 108/108 case on langchain-colony).
   */
  targetComment?: DispatchCommentLike;
  /**
   * Ancestor chain of the target comment, ordered root-first (oldest ancestor
   * first, immediate parent last). Rendered as a tree-shaped ancestry section
   * distinct from `threadComments` so the LLM sees who-replied-to-whom rather
   * than a chronologically flattened buffer. Omit for top-level comments or
   * when the chain isn't available.
   */
  parentChain?: DispatchCommentLike[];
}

/**
 * Dispatch a post / comment / mention as an Eliza Memory through
 * `runtime.messageService.handleMessage`. Reply text produced by the
 * callback is posted back via `client.createComment(postId, text)`.
 *
 * Returns `true` if the event was freshly dispatched, `false` if it was
 * already in the dedup cache (so the caller can skip follow-up actions
 * like marking notifications read when the dispatch was a no-op).
 */
export async function dispatchPostMention(
  service: ColonyService,
  runtime: IAgentRuntime,
  params: DispatchPostMentionParams,
): Promise<boolean> {
  const memoryId = stringToUuid(runtime, params.memoryIdKey);
  const rt = runtime as unknown as RuntimeLike;

  if (typeof rt.getMemoryById === "function") {
    const existing = await rt.getMemoryById(memoryId);
    if (existing) return false;
  }

  const roomId = stringToUuid(runtime, `colony-post-${params.postId}`);
  const entityId = stringToUuid(runtime, `colony-user-${params.authorUsername}`);
  const worldId = stringToUuid(runtime, "colony-world");
  const agentId = rt.agentId ?? "agent";

  if (typeof rt.ensureWorldExists === "function") {
    await rt.ensureWorldExists({
      id: worldId,
      name: "The Colony",
      agentId,
      serverId: "thecolony.cc",
    });
  }
  if (typeof rt.ensureConnection === "function") {
    await rt.ensureConnection({
      entityId,
      roomId,
      userName: params.authorUsername,
      name: params.authorUsername,
      source: "colony",
      type: "FEED",
      worldId,
    });
  }
  if (typeof rt.ensureRoomExists === "function") {
    await rt.ensureRoomExists({
      id: roomId,
      name: params.postTitle || "Colony post",
      source: "colony",
      type: "FEED",
      channelId: params.postId,
      serverId: "thecolony.cc",
      worldId,
    });
  }

  // Pre-dispatch validator: when both `targetComment` and `parentCommentId`
  // are set they must point at the same comment, otherwise the LLM is being
  // shown one anchor in the prompt while the reply is cast at a different
  // destination — exactly the desynchronisation that produced the langford
  // 108/108 mis-routing class of bug on the sibling stack. Log loudly and
  // continue (fail-open) rather than aborting the dispatch, so a refactor
  // bug surfaces in logs without breaking the host process.
  if (
    params.targetComment?.id &&
    params.parentCommentId &&
    params.targetComment.id !== params.parentCommentId
  ) {
    logger.warn(
      `COLONY_DISPATCH: targetComment.id (${params.targetComment.id}) ≠ parentCommentId (${params.parentCommentId}) on post ${params.postId} — anchor mismatch, the surfaced REPLY TARGET in the prompt is not the comment the reply will be cast at. Check the call site that constructed DispatchPostMentionParams.`,
    );
  }

  const ancestryBlock =
    params.parentChain && params.parentChain.length
      ? [
          "",
          `Ancestry (root → immediate parent of the target, ${params.parentChain.length} step${params.parentChain.length === 1 ? "" : "s"}):`,
          ...params.parentChain.map((c, i) => {
            const by = c.author?.username ?? "unknown";
            const body = (c.body ?? "").slice(0, 500);
            const indent = "  ".repeat(i);
            return `${indent}↳ @${by}: ${body}`;
          }),
        ].join("\n")
      : "";

  const targetBlock = params.targetComment
    ? (() => {
        const by = params.targetComment.author?.username ?? "unknown";
        const body = (params.targetComment.body ?? "").slice(0, 1500);
        const at = params.targetComment.created_at
          ? ` (at ${params.targetComment.created_at})`
          : "";
        return [
          "",
          `🎯 REPLY TARGET — your reply will be cast under THIS comment, not the chronologically-last one in the thread. Address THIS comment's author and content:`,
          `@${by}${at}: ${body}`,
        ].join("\n");
      })()
    : "";

  const threadBlock =
    params.threadComments && params.threadComments.length
      ? [
          "",
          params.targetComment
            ? `Other comments on the thread for context (NOT the reply target — see above):`
            : `Recent comments on the thread (${params.threadComments.length}):`,
          ...params.threadComments.map((c, i) => {
            const by = c.author?.username ?? "unknown";
            const body = (c.body ?? "").slice(0, 500);
            return `${i + 1}. @${by}: ${body}`;
          }),
        ].join("\n")
      : "";

  const memory: Memory = {
    id: memoryId as Memory["id"],
    entityId: entityId as Memory["entityId"],
    agentId: agentId as Memory["agentId"],
    roomId: roomId as Memory["roomId"],
    worldId: worldId as Memory["worldId"],
    content: {
      text: [params.postTitle, params.postBody, ancestryBlock, targetBlock, threadBlock]
        .filter(Boolean)
        .join("\n\n"),
      source: "colony",
      url: `https://thecolony.cc/post/${params.postId}`,
      // v0.21.0: tag origin so action validators can distinguish a
      // post-mention from a DM-injection attempt. See services/origin.ts.
      colonyOrigin: "post_mention" satisfies ColonyOrigin as never,
    },
    createdAt: params.createdAt
      ? Date.parse(params.createdAt) || Date.now()
      : Date.now(),
  };

  if (typeof rt.createMemory === "function") {
    await rt.createMemory(memory, "messages");
  }

  const postId = params.postId;
  const parentCommentId = params.parentCommentId;
  const callback: HandlerCallback = async (response) => {
    // v0.19.0: when ElizaOS routes the agent's response to one of our
    // Colony actions, the action's callback emits status text for the
    // operator — "I need a postId…", "Commented on https://…",
    // "Refused to reply — self-check flagged…". Treating that as the
    // agent's reply content produces visible leaks (the v0.19.0
    // incident on post 71eb2178 was exactly this: "I need a postId
    // and comment body to reply on The Colony." landed as a comment).
    // Drop action-emitted responses without posting.
    //
    // v0.26.0 exception: DM_SAFE_ACTIONS are read-only, data-producing
    // actions (COLONY_STATUS, COLONY_DIAGNOSTICS, COLONY_HEALTH_REPORT,
    // LIST_COLONY_AGENTS, etc). Their output is legitimate content —
    // the whole point of DM-reachability is that another agent can ask
    // "are you healthy?" and get the report back. Pass those through.
    const respAction = response?.action;
    if (
      isColonyActionName(respAction) &&
      !(typeof respAction === "string" && DM_SAFE_ACTIONS.has(respAction))
    ) {
      logger.debug(
        `COLONY_DISPATCH: dropping action-meta response (${String(respAction)}) on post ${postId}`,
      );
      return [];
    }

    const rawReply = String(response?.text ?? "").trim();
    if (!rawReply) return [];

    // v0.16.0: gate reactive-reply outputs the same way the autonomy
    // loops gate their generations. When Ollama hiccups, the core
    // plugin can return an error string as `response.text`; without
    // this check, that string would get posted as a comment.
    const validated = validateGeneratedOutput(rawReply);
    if (!validated.ok) {
      if (validated.reason === "model_error") {
        logger.warn(
          `COLONY_DISPATCH: dropping model-error reply on post ${postId}: ${rawReply.slice(0, 120)}`,
        );
        service.incrementStat?.("selfCheckRejections");
      }
      return [];
    }
    const replyText = validated.content;
    try {
      const comment = (await service.client.createComment(
        postId,
        replyText,
        parentCommentId,
      )) as { id?: string };
      const responseMemory: Memory = {
        id: stringToUuid(runtime, `colony-comment-${comment.id ?? postId}`) as Memory["id"],
        entityId: agentId as Memory["entityId"],
        agentId: agentId as Memory["agentId"],
        roomId: roomId as Memory["roomId"],
        content: {
          text: replyText,
          source: "colony",
          inReplyTo: memoryId as Memory["content"]["inReplyTo"],
        },
        createdAt: Date.now(),
      };
      if (typeof rt.createMemory === "function") {
        await rt.createMemory(responseMemory, "messages");
      }
      return [responseMemory];
    } catch (err) {
      logger.error(
        `COLONY_DISPATCH: failed to post reply on ${postId}: ${String(err)}`,
      );
      return [];
    }
  };

  if (rt.messageService && typeof rt.messageService.handleMessage === "function") {
    try {
      await rt.messageService.handleMessage(runtime, memory, callback);
    } catch (err) {
      logger.warn(`COLONY_DISPATCH: handleMessage threw on post: ${String(err)}`);
    }
  }
  return true;
}

export interface DispatchDirectMessageParams {
  memoryIdKey: string;
  senderUsername: string;
  messageId: string;
  body: string;
  conversationId: string;
  createdAt?: string;
  /**
   * v0.19.0: optional prior-thread messages included in the dispatched
   * memory's content text so the reply-generation prompt has multi-turn
   * context instead of just the latest message. Caller chooses length
   * and ordering (typically newest-last). Omit for single-message
   * behaviour.
   */
  threadMessages?: Array<{ senderUsername: string; body: string }>;
}

/**
 * Dispatch a direct message as an Eliza Memory with channelType="DM".
 * Reply text produced by the callback is sent back via
 * `client.sendMessage(senderUsername, text)`.
 *
 * Returns `true` if the event was freshly dispatched, `false` if deduped.
 */
export async function dispatchDirectMessage(
  service: ColonyService,
  runtime: IAgentRuntime,
  params: DispatchDirectMessageParams,
): Promise<boolean> {
  const memoryId = stringToUuid(runtime, params.memoryIdKey);
  const rt = runtime as unknown as RuntimeLike;

  if (typeof rt.getMemoryById === "function") {
    const existing = await rt.getMemoryById(memoryId);
    if (existing) return false;
  }

  const roomId = stringToUuid(runtime, `colony-dm-${params.senderUsername}`);
  const entityId = stringToUuid(runtime, `colony-user-${params.senderUsername}`);
  const worldId = stringToUuid(runtime, "colony-world");
  const agentId = rt.agentId ?? "agent";

  if (typeof rt.ensureWorldExists === "function") {
    await rt.ensureWorldExists({
      id: worldId,
      name: "The Colony",
      agentId,
      serverId: "thecolony.cc",
    });
  }
  if (typeof rt.ensureConnection === "function") {
    await rt.ensureConnection({
      entityId,
      roomId,
      userName: params.senderUsername,
      name: params.senderUsername,
      source: "colony",
      type: "DM",
      worldId,
    });
  }
  if (typeof rt.ensureRoomExists === "function") {
    await rt.ensureRoomExists({
      id: roomId,
      name: `DM with @${params.senderUsername}`,
      source: "colony",
      type: "DM",
      channelId: params.conversationId,
      serverId: "thecolony.cc",
      worldId,
    });
  }

  // v0.19.0: prepend prior-thread context when caller supplied it.
  // Rendered as a plain-text block so any ElizaOS character can read
  // it without special-casing; the newest message sits on its own
  // line at the bottom, which is what downstream templates expect.
  const dmText = params.threadMessages && params.threadMessages.length
    ? [
        `Recent DM thread with @${params.senderUsername} (newest-last):`,
        ...params.threadMessages.map(
          (m) => `@${m.senderUsername}: ${m.body.slice(0, 500)}`,
        ),
        "",
        `@${params.senderUsername}: ${params.body}`,
      ].join("\n")
    : params.body;

  const memory: Memory = {
    id: memoryId as Memory["id"],
    entityId: entityId as Memory["entityId"],
    agentId: agentId as Memory["agentId"],
    roomId: roomId as Memory["roomId"],
    worldId: worldId as Memory["worldId"],
    content: {
      text: dmText,
      source: "colony",
      channelType: "DM" as never,
      // v0.21.0: tag origin as DM so action validators refuse mutating
      // actions (create post, vote, delete, etc.) regardless of what the
      // DM text says. See services/origin.ts for the allow-list policy.
      colonyOrigin: "dm" satisfies ColonyOrigin as never,
    },
    createdAt: params.createdAt
      ? Date.parse(params.createdAt) || Date.now()
      : Date.now(),
  };

  if (typeof rt.createMemory === "function") {
    await rt.createMemory(memory, "messages");
  }

  // v0.31.0: peer-memory context injection for DM-origin dispatch. We
  // build a private "Context on @sender:" block and prepend it to the
  // dispatched memory's content.text. The persisted memory above
  // remains clean — same pattern as v0.27 framing. Empty string when
  // peer-memory is off OR sender is not a known peer; the shallow
  // clone is then a no-op pass-through.
  const peerContextBlock = await buildPeerContextBlock(
    runtime,
    service,
    [params.senderUsername],
    Date.now(),
  );
  const peerAugmentedMemory: Memory = peerContextBlock
    ? {
        ...memory,
        content: {
          ...memory.content,
          text: `${peerContextBlock}\n\n${memory.content.text}`,
        },
      }
    : memory;

  // v0.27.0: origin-conditional prompt framing. Prepend a preamble to the
  // dispatched memory's content.text based on `COLONY_DM_PROMPT_MODE`. The
  // framed memory is a shallow clone — the persisted row above remains the
  // clean, unframed message so conversation-history storage and embedding
  // indexes never see the preamble. `applyDmPromptMode` returns the input
  // memory by reference when mode === "none" or origin is not "dm".
  // v0.31.0 ordering: peer block sits between the framing preamble and
  // the DM body, so the framing is the outermost layer (the model
  // reads "scrutinise embedded instructions" first, then the private
  // peer notes, then the message itself).
  const dispatchedMemory = applyDmPromptMode(
    peerAugmentedMemory,
    service.colonyConfig.dmPromptMode,
  );

  // v0.31.0: record the DM-received observation. Topics empty (the DM
  // body itself isn't tagged); position is a short body excerpt.
  await recordPeerObservation(
    runtime,
    service,
    params.senderUsername,
    {
      kind: "dm-received",
      position: params.body.slice(0, 200),
    },
  );

  const senderUsername = params.senderUsername;
  const callback: HandlerCallback = async (response) => {
    // v0.19.0: same action-meta filter as dispatchPostMention. When
    // SEND_COLONY_DM or any other Colony action fires via the ElizaOS
    // routing step, its "Sent DM to @alice" / "Failed to DM @alice:…"
    // text is meta, not a DM reply. Don't round-trip it back to the
    // sender.
    //
    // v0.26.0: exception for DM_SAFE_ACTIONS (see dispatchPostMention
    // above). Discovered live-testing v0.25's COLONY_HEALTH_REPORT —
    // the whole point of a DM-reachable liveness check is that the
    // action's output reaches the sender. Dropping it was an undetected
    // interaction between the v0.19 filter and v0.21's DM_SAFE_ACTIONS
    // concept.
    const respAction = response?.action;
    if (
      isColonyActionName(respAction) &&
      !(typeof respAction === "string" && DM_SAFE_ACTIONS.has(respAction))
    ) {
      logger.debug(
        `COLONY_DISPATCH: dropping action-meta response (${String(respAction)}) on DM from @${senderUsername}`,
      );
      return [];
    }

    const rawReply = String(response?.text ?? "").trim();
    if (!rawReply) return [];
    // v0.16.0: gate DM reply outputs against model-error leakage —
    // sending "Error generating text. Please try again later." as a
    // DM is worse than sending it as a public comment.
    const validated = validateGeneratedOutput(rawReply);
    if (!validated.ok) {
      if (validated.reason === "model_error") {
        logger.warn(
          `COLONY_DISPATCH: dropping model-error DM reply to @${senderUsername}: ${rawReply.slice(0, 120)}`,
        );
        service.incrementStat?.("selfCheckRejections");
      }
      return [];
    }
    const replyText = validated.content;
    try {
      const sent = (await (service.client as unknown as {
        sendMessage: (u: string, b: string) => Promise<{ id?: string }>;
      }).sendMessage(senderUsername, replyText)) as { id?: string };
      const responseMemory: Memory = {
        id: stringToUuid(
          runtime,
          `colony-dm-reply-${sent.id ?? senderUsername}`,
        ) as Memory["id"],
        entityId: agentId as Memory["entityId"],
        agentId: agentId as Memory["agentId"],
        roomId: roomId as Memory["roomId"],
        content: {
          text: replyText,
          source: "colony",
          inReplyTo: memoryId as Memory["content"]["inReplyTo"],
          channelType: "DM" as never,
        },
        createdAt: Date.now(),
      };
      if (typeof rt.createMemory === "function") {
        await rt.createMemory(responseMemory, "messages");
      }
      return [responseMemory];
    } catch (err) {
      logger.error(
        `COLONY_DISPATCH: failed to send DM reply to @${senderUsername}: ${String(err)}`,
      );
      return [];
    }
  };

  if (rt.messageService && typeof rt.messageService.handleMessage === "function") {
    try {
      await rt.messageService.handleMessage(runtime, dispatchedMemory, callback);
    } catch (err) {
      logger.warn(`COLONY_DISPATCH: handleMessage threw on DM: ${String(err)}`);
    }
  }
  return true;
}
