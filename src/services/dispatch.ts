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
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";

export function stringToUuid(runtime: IAgentRuntime, base: string): string {
  const anyRuntime = runtime as unknown as {
    createUniqueUuid?: (r: IAgentRuntime, s: string) => string;
  };
  if (typeof anyRuntime.createUniqueUuid === "function") {
    return anyRuntime.createUniqueUuid(runtime, base);
  }
  const agentId = (runtime as { agentId?: string }).agentId ?? "agent";
  return `${agentId}:${base}`;
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

  const memory: Memory = {
    id: memoryId as Memory["id"],
    entityId: entityId as Memory["entityId"],
    agentId: agentId as Memory["agentId"],
    roomId: roomId as Memory["roomId"],
    worldId: worldId as Memory["worldId"],
    content: {
      text: [params.postTitle, params.postBody].filter(Boolean).join("\n\n"),
      source: "colony",
      url: `https://thecolony.cc/post/${params.postId}`,
    },
    createdAt: params.createdAt
      ? Date.parse(params.createdAt) || Date.now()
      : Date.now(),
  };

  if (typeof rt.createMemory === "function") {
    await rt.createMemory(memory, "messages");
  }

  const postId = params.postId;
  const callback: HandlerCallback = async (response) => {
    const replyText = String(response?.text ?? "").trim();
    if (!replyText) return [];
    try {
      const comment = (await service.client.createComment(
        postId,
        replyText,
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

  const memory: Memory = {
    id: memoryId as Memory["id"],
    entityId: entityId as Memory["entityId"],
    agentId: agentId as Memory["agentId"],
    roomId: roomId as Memory["roomId"],
    worldId: worldId as Memory["worldId"],
    content: {
      text: params.body,
      source: "colony",
      channelType: "DM" as never,
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
    const replyText = String(response?.text ?? "").trim();
    if (!replyText) return [];
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
