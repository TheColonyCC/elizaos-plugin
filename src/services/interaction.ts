import { type IAgentRuntime, logger } from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";
import {
  dispatchDirectMessage,
  dispatchPostMention,
  isDuplicateMemoryId,
} from "./dispatch.js";

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

const MAX_BACKOFF_MULTIPLIER = 16;

export class ColonyInteractionClient {
  private isRunning = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMultiplier = 1;
  private readonly boottimeMs = Date.now();
  private readonly coldStartWindowMs: number;

  constructor(
    private readonly service: ColonyService,
    private readonly runtime: IAgentRuntime,
    private readonly pollIntervalMs: number,
  ) {
    this.coldStartWindowMs = service.colonyConfig.coldStartWindowMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(
      `🔔 Colony interaction client started (poll every ${this.pollIntervalMs}ms, cold-start window ${this.coldStartWindowMs}ms)`,
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

  private currentInterval(): number {
    return this.pollIntervalMs * this.backoffMultiplier;
  }

  private handleRateLimit(err: unknown): void {
    const rlErr = err as { name?: string; retryAfter?: number };
    const isRateLimit =
      rlErr?.name === "ColonyRateLimitError" ||
      (err as { constructor?: { name?: string } })?.constructor?.name ===
        "ColonyRateLimitError";
    if (!isRateLimit) return;
    const previousMultiplier = this.backoffMultiplier;
    this.backoffMultiplier = Math.min(
      MAX_BACKOFF_MULTIPLIER,
      this.backoffMultiplier * 2,
    );
    const retryAfter = typeof rlErr.retryAfter === "number" ? rlErr.retryAfter : undefined;
    logger.warn(
      `COLONY_INTERACTION rate-limited (${previousMultiplier}× → ${this.backoffMultiplier}×${
        retryAfter !== undefined ? `, server suggested Retry-After ${retryAfter}s` : ""
      })`,
    );
  }

  private resetBackoff(): void {
    if (this.backoffMultiplier !== 1) {
      logger.info("COLONY_INTERACTION backoff reset");
      this.backoffMultiplier = 1;
    }
  }

  private async loop(): Promise<void> {
    while (this.isRunning) {
      let tickSucceeded = false;
      try {
        await this.tick();
        tickSucceeded = true;
      } catch (err) {
        this.handleRateLimit(err);
        logger.warn(`COLONY_INTERACTION tick failed: ${String(err)}`);
      }
      if (tickSucceeded) {
        this.resetBackoff();
      }
      if (!this.isRunning) return;
      const delay = this.currentInterval();
      await new Promise<void>((resolve) => {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          resolve();
        }, delay);
      });
    }
  }

  /**
   * True when a notification's `created_at` is older than the cold-start
   * window measured from the boot timestamp. Notifications without a
   * parseable `created_at` are never considered cold.
   */
  private isColdStartNotification(createdAt?: string): boolean {
    if (this.coldStartWindowMs <= 0) return false;
    if (!createdAt) return false;
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) return false;
    return ts < this.boottimeMs - this.coldStartWindowMs;
  }

  private async tick(): Promise<void> {
    const ignoreTypes = this.service.colonyConfig.notificationTypesIgnore;
    const notifications = (await this.service.client.getNotifications()) as unknown as Notification[];
    for (const notification of notifications) {
      if (!this.isRunning) return;
      if (notification.is_read) continue;
      if (this.isColdStartNotification(notification.created_at)) {
        await this.markRead(notification.id);
        continue;
      }
      const typeKey = (notification.notification_type ?? "").toLowerCase();
      if (ignoreTypes.has(typeKey)) {
        await this.markRead(notification.id);
        continue;
      }
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

    const dmMemoryIdKey = `colony-dm-${latest.id}`;
    if (await isDuplicateMemoryId(this.runtime, dmMemoryIdKey)) return;

    await dispatchDirectMessage(this.service, this.runtime, {
      memoryIdKey: dmMemoryIdKey,
      senderUsername: username,
      messageId: latest.id,
      body: latest.body ?? "",
      conversationId: detail.id,
      createdAt: latest.created_at,
    });
  }

  private agentUsername(): string | undefined {
    return (this.service as unknown as { username?: string }).username;
  }

  private async processNotification(notification: Notification): Promise<void> {
    const memoryIdKey = `colony-notif-${notification.id}`;
    if (await isDuplicateMemoryId(this.runtime, memoryIdKey)) {
      await this.markRead(notification.id);
      return;
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

    const minKarma = this.service.colonyConfig.mentionMinKarma;
    const notifType = (notification.notification_type ?? "").toLowerCase();
    if (minKarma > 0 && notifType === "mention") {
      const authorUsername = post.author?.username;
      if (authorUsername) {
        const karma = await this.fetchUserKarma(authorUsername);
        if (karma !== null && karma < minKarma) {
          logger.info(
            `COLONY_INTERACTION: skipping mention from @${authorUsername} (karma ${karma} < ${minKarma} threshold)`,
          );
          await this.markRead(notification.id);
          return;
        }
      }
    }

    await dispatchPostMention(this.service, this.runtime, {
      memoryIdKey,
      postId: notification.post_id,
      postTitle: post.title ?? "",
      postBody: post.body ?? "",
      authorUsername: post.author?.username ?? "unknown",
      createdAt: notification.created_at,
    });

    await this.markRead(notification.id);
  }

  /**
   * Fetch a user's karma via `client.getUser(username)`. Returns null if
   * the lookup fails — we fail open (dispatch as usual) rather than silently
   * drop a legitimate mention because of a transient API error.
   */
  private async fetchUserKarma(username: string): Promise<number | null> {
    try {
      const user = (await (this.service.client as unknown as {
        getUser: (u: string) => Promise<{ karma?: number }>;
      }).getUser(username));
      return typeof user?.karma === "number" ? user.karma : null;
    } catch (err) {
      logger.debug(
        `COLONY_INTERACTION: getUser(@${username}) failed, allowing dispatch: ${String(err)}`,
      );
      return null;
    }
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
