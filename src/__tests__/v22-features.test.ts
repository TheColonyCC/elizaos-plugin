/**
 * v0.22.0 — notification-router test suite.
 *
 * Four concerns:
 *
 *   1. `parseNotificationPolicy` env-string parser (empty, malformed,
 *      case, whitespace, unknown-level fail-open).
 *   2. `resolveNotificationPolicy` priority: explicit policy → legacy
 *      ignore → default dispatch.
 *   3. `NotificationDigestBuffer` lifecycle — add, counts, isEmpty,
 *      flush (empty no-op, non-empty writes memory + bumps stat +
 *      records activity), describeBucket per type + actor-hint branches,
 *      createMemory failure path.
 *   4. `ColonyInteractionClient` tick integration — coalesce buffers
 *      without dispatching, drop short-circuits, dispatch preserves
 *      v0.21 behaviour.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
  NotificationDigestBuffer,
  parseNotificationPolicy,
  resolveNotificationPolicy,
  type NotificationPolicy,
} from "../services/notification-router.js";
import { ColonyInteractionClient } from "../services/interaction.js";
import { fakeService, type FakeService } from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// 1. parseNotificationPolicy
// ─────────────────────────────────────────────────────────────────────────

describe("parseNotificationPolicy", () => {
  it("returns an empty map for null / undefined / empty input", () => {
    expect(parseNotificationPolicy(null).size).toBe(0);
    expect(parseNotificationPolicy(undefined).size).toBe(0);
    expect(parseNotificationPolicy("").size).toBe(0);
  });

  it("parses a single entry", () => {
    const m = parseNotificationPolicy("vote:coalesce");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.size).toBe(1);
  });

  it("parses multiple entries", () => {
    const m = parseNotificationPolicy("vote:coalesce,follow:drop,mention:dispatch");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.get("follow")).toBe("drop");
    expect(m.get("mention")).toBe("dispatch");
  });

  it("trims whitespace around types and levels", () => {
    const m = parseNotificationPolicy("  vote : coalesce , follow : drop  ");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.get("follow")).toBe("drop");
  });

  it("lower-cases both keys and values", () => {
    const m = parseNotificationPolicy("VOTE:COALESCE,Follow:Drop");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.get("follow")).toBe("drop");
  });

  it("drops entries without a colon", () => {
    const m = parseNotificationPolicy("vote,follow:drop");
    expect(m.get("vote")).toBeUndefined();
    expect(m.get("follow")).toBe("drop");
  });

  it("drops entries with unknown policy level (fail-open, not throw)", () => {
    const m = parseNotificationPolicy("vote:coalesce,follow:moonshot");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.get("follow")).toBeUndefined();
  });

  it("drops entries with empty type key", () => {
    const m = parseNotificationPolicy(":drop,vote:coalesce");
    expect(m.get("vote")).toBe("coalesce");
    expect(m.size).toBe(1);
  });

  it("skips empty segments between commas", () => {
    const m = parseNotificationPolicy("vote:coalesce,,,follow:drop,");
    expect(m.size).toBe(2);
  });

  it("last entry wins when a type appears twice", () => {
    const m = parseNotificationPolicy("vote:coalesce,vote:drop");
    expect(m.get("vote")).toBe("drop");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. resolveNotificationPolicy
// ─────────────────────────────────────────────────────────────────────────

describe("resolveNotificationPolicy", () => {
  const empty: ReadonlyMap<string, NotificationPolicy> = new Map();
  const emptyIgnore: ReadonlySet<string> = new Set();

  it("defaults to dispatch when no policy + no ignore entry", () => {
    expect(resolveNotificationPolicy("mention", empty, emptyIgnore)).toBe(
      "dispatch",
    );
  });

  it("returns dispatch for undefined / empty type", () => {
    expect(resolveNotificationPolicy(undefined, empty, emptyIgnore)).toBe(
      "dispatch",
    );
    expect(resolveNotificationPolicy("", empty, emptyIgnore)).toBe("dispatch");
  });

  it("resolves via explicit policy map (case-normalised)", () => {
    const policy = new Map<string, NotificationPolicy>([
      ["vote", "coalesce"],
    ]);
    expect(resolveNotificationPolicy("VOTE", policy, emptyIgnore)).toBe(
      "coalesce",
    );
  });

  it("falls through to legacy ignore set → drop", () => {
    expect(
      resolveNotificationPolicy("vote", empty, new Set(["vote"])),
    ).toBe("drop");
  });

  it("explicit policy wins over legacy ignore", () => {
    const policy = new Map<string, NotificationPolicy>([
      ["vote", "coalesce"],
    ]);
    expect(
      resolveNotificationPolicy("vote", policy, new Set(["vote"])),
    ).toBe("coalesce");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. NotificationDigestBuffer
// ─────────────────────────────────────────────────────────────────────────

interface MockRuntime extends IAgentRuntime {
  agentId: string;
  createMemory: ReturnType<typeof vi.fn>;
}

function mockDigestRuntime(
  overrides: Partial<{
    createMemory: MockRuntime["createMemory"];
  }> = {},
): { runtime: MockRuntime; captured: Memory[] } {
  const captured: Memory[] = [];
  const createMemory =
    overrides.createMemory ??
    vi.fn(async (m: Memory) => {
      captured.push(m);
    });
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000099",
    createMemory,
  } as unknown as MockRuntime;
  return { runtime, captured };
}

describe("NotificationDigestBuffer", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  it("starts empty", () => {
    const buf = new NotificationDigestBuffer();
    expect(buf.isEmpty()).toBe(true);
    expect(buf.counts()).toEqual({});
  });

  it("groups entries by lower-cased type", () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "VOTE", actor: "alice" });
    buf.add({ type: "vote", actor: "bob" });
    buf.add({ type: "follow", actor: "carol" });
    expect(buf.counts()).toEqual({ vote: 2, follow: 1 });
    expect(buf.isEmpty()).toBe(false);
  });

  it("flush() is a no-op when buffer is empty", async () => {
    const buf = new NotificationDigestBuffer();
    const { runtime } = mockDigestRuntime();
    const id = await buf.flush(runtime, service as never);
    expect(id).toBeNull();
    expect(service.incrementStat).not.toHaveBeenCalled();
  });

  it("flush() writes a single memory + bumps the stat + records activity", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "vote", actor: "alice" });
    buf.add({ type: "vote", actor: "bob" });
    const { runtime, captured } = mockDigestRuntime();
    const id = await buf.flush(runtime, service as never);
    expect(id).toBeTruthy();
    expect(captured).toHaveLength(1);
    expect(String(captured[0]!.content.text)).toContain("2 new upvotes");
    expect(service.incrementStat).toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
    expect(service.recordActivity).toHaveBeenCalledWith(
      "post_created",
      undefined,
      expect.stringContaining("notification_digest vote"),
    );
  });

  it("flush() stamps colonyOrigin=post_mention + colonyDigest on the memory", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "vote" });
    const { runtime, captured } = mockDigestRuntime();
    await buf.flush(runtime, service as never);
    const content = captured[0]!.content as unknown as {
      colonyOrigin?: string;
      colonyDigest?: boolean;
    };
    expect(content.colonyOrigin).toBe("post_mention");
    expect(content.colonyDigest).toBe(true);
  });

  it("flush() renders vote / reaction / award / follow / tip_received / unknown specially", async () => {
    const types = ["vote", "reaction", "award", "follow", "tip_received", "custom_type"];
    const expected = [
      "new upvote",
      "new reaction",
      "new reaction",
      "new follower",
      "tip", // reaction/award share phrasing; tip says "tip received"
      "new custom_type notification",
    ];
    for (let i = 0; i < types.length; i++) {
      const buf = new NotificationDigestBuffer();
      buf.add({ type: types[i]! });
      const { runtime, captured } = mockDigestRuntime();
      await buf.flush(runtime, service as never);
      expect(String(captured[0]!.content.text)).toContain(expected[i]!);
    }
  });

  it("appends an actor hint when 1-3 distinct actors seen", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "follow", actor: "alice" });
    buf.add({ type: "follow", actor: "bob" });
    const { runtime, captured } = mockDigestRuntime();
    await buf.flush(runtime, service as never);
    const text = String(captured[0]!.content.text);
    expect(text).toContain("(from @alice, @bob)");
  });

  it("collapses actor hint to '(from N agents)' when > 3 distinct", async () => {
    const buf = new NotificationDigestBuffer();
    for (const a of ["alice", "bob", "carol", "dan", "eve"]) {
      buf.add({ type: "vote", actor: a });
    }
    const { runtime, captured } = mockDigestRuntime();
    await buf.flush(runtime, service as never);
    expect(String(captured[0]!.content.text)).toContain("(from 5 agents)");
  });

  it("omits actor hint when no entries carry an actor", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "vote" });
    const { runtime, captured } = mockDigestRuntime();
    await buf.flush(runtime, service as never);
    const text = String(captured[0]!.content.text);
    expect(text).toContain("1 new upvote");
    expect(text).not.toContain("(from");
  });

  it("returns null when createMemory throws (graceful fail)", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "vote" });
    const createMemory = vi.fn(async () => {
      throw new Error("pglite down");
    });
    const { runtime } = mockDigestRuntime({ createMemory });
    const id = await buf.flush(runtime, service as never);
    expect(id).toBeNull();
  });

  it("skips createMemory call when runtime lacks the method", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "vote" });
    // Runtime without createMemory — simulates very stripped test harnesses.
    const runtime = { agentId: "agent" } as unknown as IAgentRuntime;
    const id = await buf.flush(runtime, service as never);
    // returns the computed id (non-null), skips the persistence side-effect.
    expect(typeof id).toBe("string");
    expect(service.incrementStat).toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
  });

  it("describes one-of-a-type variants without plural 's'", async () => {
    const buf = new NotificationDigestBuffer();
    buf.add({ type: "follow", actor: "alice" });
    const { runtime, captured } = mockDigestRuntime();
    await buf.flush(runtime, service as never);
    const text = String(captured[0]!.content.text);
    expect(text).toContain("1 new follower");
    expect(text).not.toContain("followers");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. ColonyInteractionClient — tick routing integration
// ─────────────────────────────────────────────────────────────────────────

interface TickRuntime extends IAgentRuntime {
  agentId: string;
  getMemoryById: ReturnType<typeof vi.fn>;
  ensureWorldExists: ReturnType<typeof vi.fn>;
  ensureConnection: ReturnType<typeof vi.fn>;
  ensureRoomExists: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  messageService: {
    handleMessage: ReturnType<typeof vi.fn>;
  } | null;
}

function mockTickRuntime(): TickRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000099",
    getMemoryById: vi.fn(async () => null),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    messageService: {
      handleMessage: vi.fn(async () => ({})),
    },
  } as unknown as TickRuntime;
}

function voteNotif(id: string, actor = "someone") {
  return {
    id,
    notification_type: "vote",
    message: `${actor} upvoted your post`,
    post_id: "00000000-0000-0000-0000-000000000001",
    comment_id: null,
    is_read: false,
    created_at: "2026-04-18T17:00:00Z",
    actor: { username: actor },
  };
}

function mentionNotif(id: string) {
  return {
    id,
    notification_type: "mention",
    message: "mentioned you",
    post_id: "00000000-0000-0000-0000-000000000002",
    comment_id: null,
    is_read: false,
    created_at: "2026-04-18T17:00:00Z",
  };
}

describe("ColonyInteractionClient — router integration", () => {
  let service: FakeService;
  let runtime: TickRuntime;
  let client: ColonyInteractionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockTickRuntime();
    client = new ColonyInteractionClient(service as never, runtime, 60_000);
    service.client.listConversations.mockResolvedValue([]);
    // Sane default post response for the dispatch-policy path.
    service.client.getPost.mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000002",
      title: "T",
      body: "B",
      author: { username: "someone" },
    });
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("coalesce policy — buffers multiple vote notifications into one digest memory", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce" as NotificationPolicy],
    ]);
    service.client.getNotifications.mockResolvedValue([
      voteNotif("v1", "alice"),
      voteNotif("v2", "bob"),
      voteNotif("v3", "alice"),
    ]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // dispatch path (getPost) NOT called
    expect(service.client.getPost).not.toHaveBeenCalled();
    // handleMessage NOT called
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
    // digest memory IS written
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const mem = runtime.createMemory.mock.calls[0]![0] as Memory;
    expect(String(mem.content.text)).toContain("3 new upvotes");
    // all three notifications marked read
    expect(service.client.markNotificationRead).toHaveBeenCalledTimes(3);
    // stat bumped
    expect(service.incrementStat).toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
  });

  it("drop policy — skips dispatch AND digest, only marks read", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "drop" as NotificationPolicy],
    ]);
    service.client.getNotifications.mockResolvedValue([voteNotif("v1")]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(service.incrementStat).not.toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
  });

  it("dispatch policy — preserves v0.21 behaviour (getPost + handleMessage)", async () => {
    // Default policy is dispatch for "mention"; confirm the router
    // doesn't regress anything for types that aren't coalesced.
    service.client.getNotifications.mockResolvedValue([mentionNotif("m1")]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.client.getPost).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000002",
    );
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
    // No digest created (nothing coalesced)
    expect(service.incrementStat).not.toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
  });

  it("mixed tick — dispatches one, coalesces others", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce" as NotificationPolicy],
      ["follow", "coalesce" as NotificationPolicy],
    ]);
    service.client.getNotifications.mockResolvedValue([
      voteNotif("v1", "alice"),
      mentionNotif("m1"),
      {
        id: "f1",
        notification_type: "follow",
        message: "followed you",
        post_id: null,
        comment_id: null,
        is_read: false,
        created_at: "2026-04-18T17:00:00Z",
        actor: { username: "carol" },
      },
      voteNotif("v2", "bob"),
    ]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // Mention → dispatch path fires once
    expect(service.client.getPost).toHaveBeenCalledTimes(1);
    expect(runtime.messageService!.handleMessage).toHaveBeenCalledTimes(1);
    // Digest memory written once, covering both coalesced types
    // (createMemory is called from BOTH dispatchPostMention AND the
    // digest flush; filter to just the digest memory.)
    const digestCalls = runtime.createMemory.mock.calls.filter((c) => {
      const content = (c[0] as Memory).content as unknown as {
        colonyDigest?: boolean;
      };
      return content.colonyDigest === true;
    });
    expect(digestCalls).toHaveLength(1);
    const digestText = String(
      (digestCalls[0]![0] as Memory).content.text,
    );
    expect(digestText).toContain("2 new upvotes");
    expect(digestText).toContain("1 new follower");
    // Stat bumped exactly once for the digest
    const digestStatCalls = service.incrementStat!.mock.calls.filter(
      (c) => c[0] === "notificationDigestsEmitted",
    );
    expect(digestStatCalls).toHaveLength(1);
  });

  it("legacy ignore set still works when no explicit policy given for that type", async () => {
    service.colonyConfig.notificationTypesIgnore = new Set(["vote"]);
    service.colonyConfig.notificationPolicy = new Map(); // empty policy
    service.client.getNotifications.mockResolvedValue([voteNotif("v1")]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // Vote falls through legacy ignore → drop → no dispatch / no digest.
    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("explicit coalesce overrides legacy ignore (upgrade path)", async () => {
    service.colonyConfig.notificationTypesIgnore = new Set(["vote"]);
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce" as NotificationPolicy],
    ]);
    service.client.getNotifications.mockResolvedValue([voteNotif("v1")]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    // Coalesce wins — digest memory created.
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const mem = runtime.createMemory.mock.calls[0]![0] as Memory;
    const content = mem.content as unknown as { colonyDigest?: boolean };
    expect(content.colonyDigest).toBe(true);
  });

  it("idle tick (no coalesce notifications) does not emit a digest", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce" as NotificationPolicy],
    ]);
    service.client.getNotifications.mockResolvedValue([]); // nothing
    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.createMemory).not.toHaveBeenCalled();
    expect(service.incrementStat).not.toHaveBeenCalledWith(
      "notificationDigestsEmitted",
    );
  });
});
