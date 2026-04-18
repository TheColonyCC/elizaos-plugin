/**
 * v0.22.0 — per-notification-type routing policy.
 *
 * Motivation: at steady state a busy agent's inbox fills with low-signal
 * events (votes, reactions, follows, tips). Prior to v0.22.0, each one
 * either became its own full `Memory` dispatched through
 * `runtime.messageService.handleMessage` (inflating KV-cache pressure for
 * local-inference agents) or got silently dropped via
 * `COLONY_NOTIFICATION_TYPES_IGNORE` (losing situational awareness).
 *
 * This module introduces a middle level — **coalesce** — that aggregates
 * all notifications of a given type seen in a single poll tick into ONE
 * summary memory, written directly via `runtime.createMemory` without
 * going through `handleMessage`. The agent keeps awareness of activity
 * volume without burning inference budget on per-event ticks.
 *
 * Three policy levels:
 *
 * - `dispatch` — full path through `dispatchPostMention` /
 *   `dispatchDirectMessage` (existing behaviour).
 * - `coalesce` — collected into a per-tick buffer; flushed as a single
 *   summary `Memory` at end of tick. Does not trigger `handleMessage`.
 * - `drop` — mark-read + recorded in the activity log, no memory created.
 *   Supersedes the legacy `COLONY_NOTIFICATION_TYPES_IGNORE` set (which
 *   is still honoured for backwards compatibility).
 *
 * Config: `COLONY_NOTIFICATION_POLICY=vote:coalesce,follow:coalesce,...`
 * When a notification type appears in both the policy map and the legacy
 * ignore set, the explicit policy wins.
 */

import {
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "./colony.service.js";

/**
 * Per-type routing policy. Values are treated case-insensitively at
 * parse time but normalised to lower-case here.
 */
export type NotificationPolicy = "dispatch" | "coalesce" | "drop";

const VALID_POLICIES: ReadonlySet<NotificationPolicy> = new Set([
  "dispatch",
  "coalesce",
  "drop",
]);

/**
 * Parse a `COLONY_NOTIFICATION_POLICY` env value into a type → policy
 * map.
 *
 * Format:
 *   `<type>:<policy>(,<type>:<policy>)*`
 *
 * Both type and policy are trimmed and lower-cased. Entries with an
 * unrecognised policy level are dropped with a debug log — the plugin
 * fails open in that case (treats the type as `dispatch`, matching
 * pre-v0.22 behaviour) rather than throwing, so a config typo in one
 * entry doesn't take the whole interaction client down.
 *
 * Empty / null input returns an empty map.
 */
export function parseNotificationPolicy(
  raw: string | null | undefined,
): Map<string, NotificationPolicy> {
  const out = new Map<string, NotificationPolicy>();
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      logger.debug(
        `COLONY_NOTIFICATION_POLICY: skipping entry without colon (${trimmed})`,
      );
      continue;
    }
    const type = trimmed.slice(0, colon).trim().toLowerCase();
    const policy = trimmed.slice(colon + 1).trim().toLowerCase();
    if (!type) continue;
    if (!VALID_POLICIES.has(policy as NotificationPolicy)) {
      logger.debug(
        `COLONY_NOTIFICATION_POLICY: unknown policy '${policy}' for type '${type}'`,
      );
      continue;
    }
    out.set(type, policy as NotificationPolicy);
  }
  return out;
}

/**
 * Resolve the effective policy for a notification type.
 *
 * Priority order (highest first):
 *   1. Explicit entry in `COLONY_NOTIFICATION_POLICY`
 *   2. Legacy `COLONY_NOTIFICATION_TYPES_IGNORE` → `drop`
 *   3. Default: `dispatch`
 *
 * The legacy ignore set is still honoured so operators upgrading from
 * v0.21 don't have to rewrite their config.
 */
export function resolveNotificationPolicy(
  notifType: string | undefined,
  policyMap: ReadonlyMap<string, NotificationPolicy>,
  legacyIgnore: ReadonlySet<string>,
): NotificationPolicy {
  const key = (notifType ?? "").toLowerCase();
  if (!key) return "dispatch";
  const explicit = policyMap.get(key);
  if (explicit) return explicit;
  if (legacyIgnore.has(key)) return "drop";
  return "dispatch";
}

/**
 * A fresh digest buffer is created at the start of each poll tick; it
 * accumulates coalesced notifications grouped by type, then `flush()` at
 * the end of the tick emits a single summary `Memory` if any entries
 * were collected.
 *
 * Not thread-safe — the interaction client runs ticks serially, so this
 * is fine. Zero entries ⇒ `flush()` is a no-op; no stub digest memory is
 * created on idle ticks.
 */
export interface CoalescedNotification {
  /** Author username if available on the notification payload. */
  actor?: string;
  /** Optional post id the notification was attached to. */
  postId?: string;
  /** Raw notification type string (lower-cased). */
  type: string;
}

export class NotificationDigestBuffer {
  private readonly buckets = new Map<string, CoalescedNotification[]>();

  /** Add a coalesced notification to the buffer. */
  add(entry: CoalescedNotification): void {
    const key = entry.type.toLowerCase();
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.push({ ...entry, type: key });
    } else {
      this.buckets.set(key, [{ ...entry, type: key }]);
    }
  }

  /** True when no notifications have been buffered. */
  isEmpty(): boolean {
    return this.buckets.size === 0;
  }

  /**
   * Flush the buffer as a single summary `Memory` via
   * `runtime.createMemory`. Does NOT dispatch through
   * `messageService.handleMessage` — the whole point of coalescing is
   * to skip the inference path for low-signal events.
   *
   * Returns the created memory id for observability, or `null` when the
   * buffer was empty (no-op flush).
   */
  async flush(
    runtime: IAgentRuntime,
    service: ColonyService,
  ): Promise<string | null> {
    if (this.isEmpty()) return null;
    const lines: string[] = [];
    const typesSeen: string[] = [];
    for (const [type, bucket] of this.buckets) {
      typesSeen.push(type);
      const count = bucket.length;
      const label = describeBucket(type, count, bucket);
      lines.push(`- ${label}`);
      service.recordActivity?.(
        "post_created",
        undefined,
        `notification_digest ${type}×${count}`,
      );
    }
    const text = [
      "Colony notifications digest (coalesced this tick):",
      ...lines,
    ].join("\n");

    const rt = runtime as unknown as {
      agentId?: string;
      createMemory?: (m: Memory, table: string) => Promise<void>;
    };
    const agentId = rt.agentId ?? "agent";
    const key = `colony-digest-${Date.now()}-${typesSeen.join("+")}`;
    const memoryId = createUniqueUuid(runtime, key);
    const roomId = createUniqueUuid(runtime, "colony-digest-room");

    const memory: Memory = {
      id: memoryId as Memory["id"],
      entityId: agentId as Memory["entityId"],
      agentId: agentId as Memory["agentId"],
      roomId: roomId as Memory["roomId"],
      content: {
        text,
        source: "colony",
        // v0.22.0: mark this memory as a digest so downstream consumers
        // (providers, status action) can identify + format it specially.
        // Origin stays `post_mention` — these ARE public-feed events,
        // just coalesced; not tagging as `"dm"` keeps the v0.21 action
        // guards behaving identically.
        colonyOrigin: "post_mention" as never,
        colonyDigest: true as never,
      },
      createdAt: Date.now(),
    };

    if (typeof rt.createMemory === "function") {
      try {
        await rt.createMemory(memory, "messages");
      } catch (err) {
        logger.warn(
          `COLONY_NOTIFICATION_ROUTER: digest memory write failed: ${String(err)}`,
        );
        return null;
      }
    }

    service.incrementStat?.("notificationDigestsEmitted");
    logger.info(
      `COLONY_NOTIFICATION_ROUTER: emitted digest for ${typesSeen.length} type(s): ${typesSeen.join(", ")}`,
    );
    return String(memoryId);
  }

  /** Snapshot of current buffer size, per type. Exposed for tests. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.buckets) {
      out[k] = v.length;
    }
    return out;
  }
}

/**
 * Render a human-readable label for a single bucket. Handles the common
 * types specifically so the digest reads well; falls back to a generic
 * "N new <type>" for unknown shapes.
 */
function describeBucket(
  type: string,
  count: number,
  bucket: ReadonlyArray<CoalescedNotification>,
): string {
  const actors = new Set<string>();
  for (const e of bucket) {
    if (e.actor) actors.add(e.actor);
  }
  const actorHint =
    actors.size > 0 && actors.size <= 3
      ? ` (from ${Array.from(actors).map((a) => `@${a}`).join(", ")})`
      : actors.size > 3
        ? ` (from ${actors.size} agents)`
        : "";
  switch (type) {
    case "vote":
      return `${count} new upvote${count === 1 ? "" : "s"}${actorHint}`;
    case "reaction":
    case "award":
      return `${count} new reaction${count === 1 ? "" : "s"}${actorHint}`;
    case "follow":
      return `${count} new follower${count === 1 ? "" : "s"}${actorHint}`;
    case "tip_received":
      return `${count} tip${count === 1 ? "" : "s"} received${actorHint}`;
    default:
      return `${count} new ${type} notification${count === 1 ? "" : "s"}${actorHint}`;
  }
}
