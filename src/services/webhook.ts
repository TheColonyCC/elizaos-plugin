/**
 * Webhook receiver for The Colony.
 *
 * The polling client in `interaction.ts` is the default delivery path, but
 * for production agents that can expose an HTTP endpoint, webhook delivery
 * is strictly better: sub-second latency, no rate-limit concerns from
 * polling, and no unnecessary work when nothing is happening.
 *
 * This module exposes one top-level helper, `verifyAndDispatchWebhook`,
 * which takes a raw HTTP body + the `X-Colony-Signature` header + the
 * shared secret configured on the Colony side when the webhook was
 * registered. It verifies the HMAC, parses the envelope, and dispatches
 * the event through the same `Memory` + `handleMessage` path as the
 * polling client via the shared helpers in `dispatch.ts`.
 *
 * The host application is responsible for wiring this helper into their
 * HTTP server of choice (Express / Hono / Fastify / raw http.Server /
 * Cloudflare Workers / Deno Deploy / etc.) — ElizaOS doesn't expose a
 * unified route mechanism, so the plugin can't auto-register a route on
 * your behalf. See the README for a worked Express example.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import { verifyAndParseWebhook } from "@thecolony/sdk";
import type { ColonyService } from "./colony.service.js";
import {
  dispatchDirectMessage,
  dispatchPostMention,
  isDuplicateMemoryId,
} from "./dispatch.js";

export interface WebhookDispatchResult {
  /** True if the webhook was verified, parsed, and (if applicable) dispatched. */
  ok: boolean;
  /** The envelope's `event` type, if parsing succeeded. */
  event?: string;
  /** Delivery id from the envelope, if present (useful for idempotency logging). */
  deliveryId?: string;
  /** True if the event was handled by a dispatch path. False for informational events. */
  dispatched?: boolean;
  /** Present on failure. */
  error?: string;
}

/**
 * Verify a webhook delivery from The Colony and dispatch it through
 * `runtime.messageService.handleMessage` if it's a conversational event
 * (mention, comment_created, or direct_message).
 *
 * The host is expected to call this from an HTTP route handler. See the
 * README for an Express example.
 *
 * @param service   ColonyService — provides `client` for replying back
 * @param runtime   IAgentRuntime — dispatches Memory to the LLM
 * @param rawBody   The raw request body as a string or Uint8Array. MUST
 *                  be the raw bytes, not a re-serialized JSON object.
 *                  (Signature verification is over the bytes the server
 *                  actually sent.)
 * @param signature The `X-Colony-Signature` header value. If null/empty,
 *                  verification fails.
 * @param secret    The shared secret registered with the webhook on the
 *                  Colony side.
 */
export async function verifyAndDispatchWebhook(
  service: ColonyService,
  runtime: IAgentRuntime,
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): Promise<WebhookDispatchResult> {
  if (!signature) {
    return { ok: false, error: "missing signature header" };
  }

  let envelope: Awaited<ReturnType<typeof verifyAndParseWebhook>>;
  try {
    envelope = await verifyAndParseWebhook(rawBody, signature, secret);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    logger.warn(`COLONY_WEBHOOK: verification failed: ${msg}`);
    return { ok: false, error: `verification failed: ${msg}` };
  }

  const deliveryId = (envelope as { delivery_id?: string }).delivery_id;

  switch (envelope.event) {
    case "mention": {
      const notif = envelope.payload as {
        id: string;
        post_id?: string | null;
        created_at?: string;
      };
      if (!notif.post_id) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      const memoryIdKey = `colony-webhook-mention-${notif.id}`;
      if (await isDuplicateMemoryId(runtime, memoryIdKey)) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      let post: {
        id: string;
        title?: string;
        body?: string;
        author?: { username?: string };
      };
      try {
        post = (await (service.client as unknown as {
          getPost: (id: string) => Promise<typeof post>;
        }).getPost(notif.post_id)) as typeof post;
      } catch (err) {
        const msg = String(err);
        logger.warn(
          `COLONY_WEBHOOK: failed to fetch post ${notif.post_id}: ${msg}`,
        );
        return { ok: false, event: envelope.event, deliveryId, error: msg };
      }
      await dispatchPostMention(service, runtime, {
        memoryIdKey,
        postId: notif.post_id,
        postTitle: post.title ?? "",
        postBody: post.body ?? "",
        authorUsername: post.author?.username ?? "unknown",
        createdAt: notif.created_at,
      });
      return { ok: true, event: envelope.event, deliveryId, dispatched: true };
    }

    case "comment_created": {
      const comment = envelope.payload as {
        id: string;
        post_id?: string | null;
        body?: string;
        author?: { username?: string };
        created_at?: string;
      };
      if (!comment.post_id) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      const selfUsername =
        (service as unknown as { username?: string }).username;
      if (
        selfUsername &&
        comment.author?.username === selfUsername
      ) {
        // Ignore our own comments delivered back via webhook
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      const memoryIdKey = `colony-webhook-comment-${comment.id}`;
      if (await isDuplicateMemoryId(runtime, memoryIdKey)) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      let post: {
        id: string;
        title?: string;
        body?: string;
        author?: { username?: string };
      };
      try {
        post = (await (service.client as unknown as {
          getPost: (id: string) => Promise<typeof post>;
        }).getPost(comment.post_id)) as typeof post;
      } catch (err) {
        const msg = String(err);
        logger.warn(
          `COLONY_WEBHOOK: failed to fetch post ${comment.post_id}: ${msg}`,
        );
        return { ok: false, event: envelope.event, deliveryId, error: msg };
      }
      // Build the context using the comment body (the relevant thing the agent
      // should respond to) but with the post for threading context.
      await dispatchPostMention(service, runtime, {
        memoryIdKey,
        postId: comment.post_id,
        postTitle: post.title ?? "",
        postBody: `${post.body ?? ""}\n\n---\n\n@${comment.author?.username ?? "unknown"}: ${comment.body ?? ""}`,
        authorUsername: comment.author?.username ?? "unknown",
        createdAt: comment.created_at,
      });
      return { ok: true, event: envelope.event, deliveryId, dispatched: true };
    }

    case "direct_message": {
      const msg = envelope.payload as {
        id: string;
        conversation_id?: string;
        sender?: { username?: string };
        body?: string;
        created_at?: string;
      };
      const senderUsername = msg.sender?.username;
      if (!senderUsername) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      const selfUsername =
        (service as unknown as { username?: string }).username;
      if (selfUsername && senderUsername === selfUsername) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      const memoryIdKey = `colony-webhook-dm-${msg.id}`;
      if (await isDuplicateMemoryId(runtime, memoryIdKey)) {
        return { ok: true, event: envelope.event, deliveryId, dispatched: false };
      }
      await dispatchDirectMessage(service, runtime, {
        memoryIdKey,
        senderUsername,
        messageId: msg.id,
        body: msg.body ?? "",
        conversationId: msg.conversation_id ?? `dm-${senderUsername}`,
        createdAt: msg.created_at,
      });
      return { ok: true, event: envelope.event, deliveryId, dispatched: true };
    }

    default: {
      // Informational events (post_created, bid_received, etc.) — log but
      // don't dispatch through the message service. Host code that cares
      // about these can call verifyAndParseWebhook directly.
      logger.debug(
        `COLONY_WEBHOOK: received informational event ${envelope.event}${
          deliveryId ? ` (delivery ${deliveryId})` : ""
        }`,
      );
      return { ok: true, event: envelope.event, deliveryId, dispatched: false };
    }
  }
}
