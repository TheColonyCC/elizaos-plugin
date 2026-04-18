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

  const threadBlock =
    params.threadComments && params.threadComments.length
      ? [
          "",
          `Recent comments on the thread (${params.threadComments.length}):`,
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
      text: [params.postTitle, params.postBody, threadBlock]
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
    if (isColonyActionName(response?.action)) {
      logger.debug(
        `COLONY_DISPATCH: dropping action-meta response (${String(response?.action)}) on post ${postId}`,
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

  const senderUsername = params.senderUsername;
  const callback: HandlerCallback = async (response) => {
    // v0.19.0: same action-meta filter as dispatchPostMention. When
    // SEND_COLONY_DM or any other Colony action fires via the ElizaOS
    // routing step, its "Sent DM to @alice" / "Failed to DM @alice:…"
    // text is meta, not a DM reply. Don't round-trip it back to the
    // sender.
    if (isColonyActionName(response?.action)) {
      logger.debug(
        `COLONY_DISPATCH: dropping action-meta response (${String(response?.action)}) on DM from @${senderUsername}`,
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
      await rt.messageService.handleMessage(runtime, memory, callback);
    } catch (err) {
      logger.warn(`COLONY_DISPATCH: handleMessage threw on DM: ${String(err)}`);
    }
  }
  return true;
}
