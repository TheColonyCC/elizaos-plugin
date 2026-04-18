import { type IAgentRuntime, logger } from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";
import {
  dispatchDirectMessage,
  dispatchPostMention,
  isDuplicateMemoryId,
} from "./dispatch.js";
import {
  NotificationDigestBuffer,
  resolveNotificationPolicy,
} from "./notification-router.js";
import { handleOperatorCommand } from "./operator-commands.js";

type Notification = {
  id: string;
  notification_type: string;
  message?: string;
  post_id: string | null;
  comment_id: string | null;
  is_read: boolean;
  created_at?: string;
  /**
   * v0.22.0: optional actor info used by the notification digest so
   * coalesced summaries can name the top contributors. Present on the
   * Colony API for most notification types (vote, reaction, follow,
   * mention); absent is fine — the digest falls back to an anonymous
   * count.
   */
  actor?: { username?: string } | null;
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
    const policyMap = this.service.colonyConfig.notificationPolicy;
    // v0.22.0: per-tick digest buffer for coalesced types. Flushed as a
    // single summary memory at the bottom of the tick.
    const digest = new NotificationDigestBuffer();
    const notifications = (await this.service.client.getNotifications()) as unknown as Notification[];
    for (const notification of notifications) {
      if (!this.isRunning) return;
      if (notification.is_read) continue;
      if (this.isColdStartNotification(notification.created_at)) {
        await this.markRead(notification.id);
        continue;
      }
      const typeKey = (notification.notification_type ?? "").toLowerCase();
      const policy = resolveNotificationPolicy(typeKey, policyMap, ignoreTypes);
      if (policy === "drop") {
        await this.markRead(notification.id);
        continue;
      }
      if (policy === "coalesce") {
        digest.add({
          type: typeKey,
          actor: notification.actor?.username ?? undefined,
          postId: notification.post_id ?? undefined,
        });
        await this.markRead(notification.id);
        continue;
      }
      // policy === "dispatch" (v0.21 behaviour)
      await this.processNotification(notification);
    }
    await digest.flush(this.runtime, this.service);
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

    // v0.19.0: operator kill-switch. DMs from the configured operator
    // that start with the command prefix bypass the LLM entirely and
    // act on plugin state directly. Intercept before dispatch so the
    // message service never sees them. Dedup-key insertion via the
    // memoryId is skipped — operator commands are cheap and safe to
    // replay, and skipping the dedup step avoids a whole failure mode
    // where an errored command looks handled on retry.
    const operatorResult = await handleOperatorCommand(
      this.service,
      username,
      latest.body ?? "",
    );
    if (operatorResult !== null) {
      logger.info(
        `COLONY_INTERACTION: operator command '${operatorResult.command}' from @${username}`,
      );
      try {
        await (this.service.client as unknown as {
          sendMessage: (u: string, b: string) => Promise<unknown>;
        }).sendMessage(username, operatorResult.reply);
      } catch (err) {
        logger.warn(
          `COLONY_INTERACTION: failed to send operator-command reply: ${String(err)}`,
        );
      }
      return;
    }

    // v0.19.0: per-conversation DM context. When enabled, include the
    // last N messages of the thread in the dispatched memory so the
    // agent's reply has multi-turn coherence. Off by default
    // (dmContextMessages === 0) preserves v0.18 behaviour.
    const contextCount = this.service.colonyConfig.dmContextMessages;
    const threadMessages =
      contextCount > 0
        ? messages
            .slice(-contextCount - 1, -1)
            .filter((m) => typeof m.body === "string" && m.body.length > 0)
            .map((m) => ({
              senderUsername: m.sender?.username ?? "?",
              body: m.body ?? "",
            }))
        : undefined;

    await dispatchDirectMessage(this.service, this.runtime, {
      memoryIdKey: dmMemoryIdKey,
      senderUsername: username,
      messageId: latest.id,
      body: latest.body ?? "",
      conversationId: detail.id,
      createdAt: latest.created_at,
      threadMessages,
    });

    // v0.20.0: mark the conversation read server-side so the DM-unread
    // counter stays in sync with what the agent has actually
    // processed. Best-effort — a failure here shouldn't undo the
    // successful dispatch. Requires @thecolony/sdk ^0.2.0.
    try {
      await (this.service.client as unknown as {
        markConversationRead: (u: string) => Promise<unknown>;
      }).markConversationRead(username);
    } catch (err) {
      logger.debug(
        `COLONY_INTERACTION: markConversationRead(@${username}) failed (non-fatal): ${String(err)}`,
      );
    }
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

    const threadComments = await this.fetchThreadComments(notification.post_id);

    // v0.14.0: thread the reply under the originating comment when the
    // notification was for a reply-to-comment. Otherwise the agent would
    // reply to the root post, losing the conversation's thread structure.
    const isReplyToComment =
      notifType === "reply_to_comment" || notifType === "reply_to_my_comment";
    const parentCommentId =
      isReplyToComment && typeof notification.comment_id === "string"
        ? notification.comment_id
        : undefined;

    await dispatchPostMention(this.service, this.runtime, {
      memoryIdKey,
      postId: notification.post_id,
      postTitle: post.title ?? "",
      postBody: post.body ?? "",
      authorUsername: post.author?.username ?? "unknown",
      createdAt: notification.created_at,
      threadComments,
      parentCommentId,
    });

    await this.markRead(notification.id);
  }

  /**
   * Fetch up to `mentionThreadComments` top-level comments on the
   * mention-bearing post, so the dispatched memory includes the
   * conversation around the mention rather than just the post itself.
   * Best-effort: errors are swallowed and the dispatch proceeds without
   * thread context.
   */
  private async fetchThreadComments(
    postId: string,
  ): Promise<Array<{ author?: { username?: string }; body?: string }>> {
    const count = this.service.colonyConfig.mentionThreadComments;
    if (!count || count <= 0) return [];
    const client = this.service.client as unknown as {
      getComments?: (id: string, page?: number) => Promise<unknown>;
    };
    if (typeof client.getComments !== "function") return [];
    try {
      const result = await client.getComments(postId, 1);
      const items = Array.isArray(result)
        ? (result as Array<{ author?: { username?: string }; body?: string }>)
        : (result as { items?: Array<{ author?: { username?: string }; body?: string }> })?.items ?? [];
      return items.slice(0, count);
    } catch (err) {
      logger.debug(
        `COLONY_INTERACTION: getComments(${postId}) failed, dispatching without thread context: ${String(err)}`,
      );
      return [];
    }
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
