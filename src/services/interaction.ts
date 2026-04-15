import {
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";

type Notification = {
  id: string;
  notification_type: string;
  message?: string;
  post_id: string | null;
  comment_id: string | null;
  is_read: boolean;
  created_at?: string;
};

type PostLike = {
  id: string;
  title?: string;
  body?: string;
  author?: { username?: string };
};

type ConversationSummary = {
  id: string;
  other_user?: { username?: string };
  unread_count?: number;
  last_message_preview?: string;
};

type ConversationMessage = {
  id: string;
  sender?: { username?: string };
  body?: string;
  is_read?: boolean;
  created_at?: string;
};

type ConversationDetail = {
  id: string;
  other_user?: { username?: string };
  messages?: ConversationMessage[];
};

function stringToUuid(runtime: IAgentRuntime, base: string): string {
  const anyRuntime = runtime as unknown as {
    createUniqueUuid?: (r: IAgentRuntime, s: string) => string;
  };
  if (typeof anyRuntime.createUniqueUuid === "function") {
    return anyRuntime.createUniqueUuid(runtime, base);
  }
  const agentId = (runtime as { agentId?: string }).agentId ?? "agent";
  return `${agentId}:${base}`;
}

export class ColonyInteractionClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly service: ColonyService,
    private readonly runtime: IAgentRuntime,
    private readonly pollIntervalMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      `🔔 Colony interaction client started (poll every ${this.pollIntervalMs}ms)`,
    );
    void this.loop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.tick();
      } catch (err) {
        logger.warn(`COLONY_INTERACTION tick failed: ${String(err)}`);
      }
      if (!this.isRunning) return;
      await new Promise<void>((resolve) => {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          resolve();
        }, this.pollIntervalMs);
      });
    }
  }

  private async tick(): Promise<void> {
    const notifications = (await this.service.client.getNotifications()) as unknown as Notification[];
    for (const notification of notifications) {
      if (!this.isRunning) return;
      if (notification.is_read) continue;
      await this.processNotification(notification);
    }
    if (!this.isRunning) return;
    await this.tickDMs();
  }

  private async tickDMs(): Promise<void> {
    let conversations: ConversationSummary[];
    try {
      conversations = (await (this.service.client as unknown as {
        listConversations: () => Promise<ConversationSummary[]>;
      }).listConversations()) as ConversationSummary[];
    } catch (err) {
      logger.warn(`COLONY_INTERACTION: listConversations failed: ${String(err)}`);
      return;
    }
    for (const conv of conversations) {
      if (!this.isRunning) return;
      if (!conv.unread_count || conv.unread_count <= 0) continue;
      await this.processConversation(conv);
    }
  }

  private async processConversation(conv: ConversationSummary): Promise<void> {
    const username = conv.other_user?.username;
    if (!username) return;

    let detail: ConversationDetail;
    try {
      detail = (await (this.service.client as unknown as {
        getConversation: (u: string) => Promise<ConversationDetail>;
      }).getConversation(username)) as ConversationDetail;
    } catch (err) {
      logger.warn(
        `COLONY_INTERACTION: failed to fetch conversation with @${username}: ${String(err)}`,
      );
      return;
    }

    const messages = detail.messages ?? [];
    if (!messages.length) return;
    const latest = messages[messages.length - 1]!;
    if (latest.sender?.username === undefined) return;
    if (latest.sender.username === this.agentUsername()) return;

    const memoryId = stringToUuid(this.runtime, `colony-dm-${latest.id}`);
    const runtime = this.runtime as unknown as {
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
      agentId?: string;
    };

    if (typeof runtime.getMemoryById === "function") {
      const existing = await runtime.getMemoryById(memoryId);
      if (existing) return;
    }

    const roomId = stringToUuid(this.runtime, `colony-dm-${username}`);
    const entityId = stringToUuid(this.runtime, `colony-user-${username}`);
    const worldId = stringToUuid(this.runtime, "colony-world");
    const agentId = runtime.agentId ?? "agent";

    if (typeof runtime.ensureWorldExists === "function") {
      await runtime.ensureWorldExists({
        id: worldId,
        name: "The Colony",
        agentId,
        serverId: "thecolony.cc",
      });
    }
    if (typeof runtime.ensureConnection === "function") {
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: username,
        name: username,
        source: "colony",
        type: "DM",
        worldId,
      });
    }
    if (typeof runtime.ensureRoomExists === "function") {
      await runtime.ensureRoomExists({
        id: roomId,
        name: `DM with @${username}`,
        source: "colony",
        type: "DM",
        channelId: detail.id,
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
        text: latest.body ?? "",
        source: "colony",
        channelType: "DM" as never,
      },
      createdAt: latest.created_at
        ? Date.parse(latest.created_at) || Date.now()
        : Date.now(),
    };

    if (typeof runtime.createMemory === "function") {
      await runtime.createMemory(memory, "messages");
    }

    const callback: HandlerCallback = async (response) => {
      const replyText = String(response?.text ?? "").trim();
      if (!replyText) return [];
      try {
        const sent = (await (this.service.client as unknown as {
          sendMessage: (u: string, b: string) => Promise<{ id?: string }>;
        }).sendMessage(username, replyText)) as { id?: string };
        const responseMemory: Memory = {
          id: stringToUuid(
            this.runtime,
            `colony-dm-reply-${sent.id ?? username}`,
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
        if (typeof runtime.createMemory === "function") {
          await runtime.createMemory(responseMemory, "messages");
        }
        return [responseMemory];
      } catch (err) {
        logger.error(
          `COLONY_INTERACTION: failed to send DM reply to @${username}: ${String(err)}`,
        );
        return [];
      }
    };

    if (runtime.messageService && typeof runtime.messageService.handleMessage === "function") {
      try {
        await runtime.messageService.handleMessage(this.runtime, memory, callback);
      } catch (err) {
        logger.warn(
          `COLONY_INTERACTION: handleMessage threw on DM: ${String(err)}`,
        );
      }
    }
  }

  private agentUsername(): string | undefined {
    return (this.service as unknown as { username?: string }).username;
  }

  private async processNotification(notification: Notification): Promise<void> {
    const memoryId = stringToUuid(this.runtime, `colony-notif-${notification.id}`);
    const runtime = this.runtime as unknown as {
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
      agentId?: string;
    };

    if (typeof runtime.getMemoryById === "function") {
      const existing = await runtime.getMemoryById(memoryId);
      if (existing) {
        await this.markRead(notification.id);
        return;
      }
    }

    if (!notification.post_id) {
      await this.markRead(notification.id);
      return;
    }

    let post: PostLike;
    try {
      post = (await (this.service.client as unknown as {
        getPost: (id: string) => Promise<PostLike>;
      }).getPost(notification.post_id)) as PostLike;
    } catch (err) {
      logger.warn(
        `COLONY_INTERACTION: failed to fetch post ${notification.post_id}: ${String(err)}`,
      );
      return;
    }

    const postTitle = post.title ?? "";
    const postBody = post.body ?? "";
    const authorUsername = post.author?.username ?? "unknown";

    const roomId = stringToUuid(this.runtime, `colony-post-${notification.post_id}`);
    const entityId = stringToUuid(this.runtime, `colony-user-${authorUsername}`);
    const worldId = stringToUuid(this.runtime, "colony-world");
    const agentId = runtime.agentId ?? "agent";

    if (typeof runtime.ensureWorldExists === "function") {
      await runtime.ensureWorldExists({
        id: worldId,
        name: "The Colony",
        agentId,
        serverId: "thecolony.cc",
      });
    }
    if (typeof runtime.ensureConnection === "function") {
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: authorUsername,
        name: authorUsername,
        source: "colony",
        type: "FEED",
        worldId,
      });
    }
    if (typeof runtime.ensureRoomExists === "function") {
      await runtime.ensureRoomExists({
        id: roomId,
        name: postTitle || "Colony post",
        source: "colony",
        type: "FEED",
        channelId: notification.post_id,
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
        text: [postTitle, postBody].filter(Boolean).join("\n\n"),
        source: "colony",
        url: `https://thecolony.cc/post/${notification.post_id}`,
      },
      createdAt: notification.created_at
        ? Date.parse(notification.created_at) || Date.now()
        : Date.now(),
    };

    if (typeof runtime.createMemory === "function") {
      await runtime.createMemory(memory, "messages");
    }

    const postId = notification.post_id;
    const callback: HandlerCallback = async (response) => {
      const replyText = String(response?.text ?? "").trim();
      if (!replyText) return [];
      try {
        const comment = (await this.service.client.createComment(
          postId,
          replyText,
        )) as { id?: string };
        const responseMemory: Memory = {
          id: stringToUuid(this.runtime, `colony-comment-${comment.id ?? postId}`) as Memory["id"],
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
        if (typeof runtime.createMemory === "function") {
          await runtime.createMemory(responseMemory, "messages");
        }
        return [responseMemory];
      } catch (err) {
        logger.error(
          `COLONY_INTERACTION: failed to post reply on ${postId}: ${String(err)}`,
        );
        return [];
      }
    };

    if (runtime.messageService && typeof runtime.messageService.handleMessage === "function") {
      try {
        await runtime.messageService.handleMessage(this.runtime, memory, callback);
      } catch (err) {
        logger.warn(
          `COLONY_INTERACTION: handleMessage threw: ${String(err)}`,
        );
      }
    }

    await this.markRead(notification.id);
  }

  private async markRead(notificationId: string): Promise<void> {
    try {
      await (this.service.client as unknown as {
        markNotificationRead: (id: string) => Promise<void>;
      }).markNotificationRead(notificationId);
    } catch (err) {
      logger.warn(
        `COLONY_INTERACTION: failed to mark notification ${notificationId} read: ${String(err)}`,
      );
    }
  }
}
