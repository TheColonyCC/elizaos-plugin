/**
 * Regression: the thread digest wrote into a room it never created.
 *
 * `memories.room_id` carries FK `fk_room -> rooms.id`. Every other Colony path
 * (dispatchPostMention, dispatchDm) calls ensureWorldExists/ensureRoomExists
 * before writing; flushGroup did not, so it depended on some other path having
 * created the room first. When that assumption failed the insert was rejected,
 * retried three times, then abandoned — and its notifications were marked read
 * anyway, so the backlog looked healthy while the digest was silently lost.
 *
 * Observed on eliza-gemma: 113 write failures / 37 abandonments, 2026-05-01 to
 * 2026-08-03, undiagnosable because the catch stringified the error and dropped
 * the driver's cause.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ThreadDigestBuffer,
  computeThreadDigestDedupKey,
  describeDbError,
  type StagedThreadNotification,
} from "../services/notification-router";

const AGENT_ID = "f31340ef-7984-406b-9fd9-eb180eda4ff5";
const ABSENT_ROOM = "260008a6-f9c0-490d-9ce6-8f133c0c2c7b";

const staged: StagedThreadNotification[] = [
  { id: "n1", postId: "p1", type: "mention", actor: "alice" },
  { id: "n2", postId: "p1", type: "reply_to_comment", actor: "bob" },
];

function fakeService() {
  return { incrementStat: vi.fn(), recordActivity: vi.fn() };
}

/** A runtime whose store enforces the real FK: no room row, no memory. */
function fkEnforcingRuntime() {
  const rooms = new Set<string>();
  const worlds = new Set<string>();
  const memories: Array<{ roomId: string }> = [];
  return {
    rooms,
    worlds,
    memories,
    rt: {
      agentId: AGENT_ID,
      ensureWorldExists: vi.fn(async (w: Record<string, unknown>) => {
        worlds.add(String(w.id));
      }),
      ensureRoomExists: vi.fn(async (r: Record<string, unknown>) => {
        rooms.add(String(r.id));
      }),
      createMemory: vi.fn(async (m: { roomId: string }) => {
        if (!rooms.has(String(m.roomId))) {
          // Shaped like the real driver error: Drizzle wraps, pg supplies cause.
          const cause = Object.assign(
            new Error(
              'insert or update on table "memories" violates foreign key constraint "fk_room"',
            ),
            {
              code: "23503",
              constraint: "fk_room",
              table_name: "memories",
              detail: `Key (room_id)=(${m.roomId}) is not present in table "rooms".`,
            },
          );
          throw Object.assign(
            new Error('Failed query: insert into "memories" ...'),
            { cause },
          );
        }
        memories.push(m);
      }),
    },
  };
}

describe("thread digest / room foreign key", () => {
  it("creates the room before writing the digest", async () => {
    const { rt, rooms, memories } = fkEnforcingRuntime();
    const svc = fakeService();
    const id = await new ThreadDigestBuffer().flushGroup(
      rt as never,
      svc as never,
      "p1",
      staged,
      { title: "Quantization notes" },
    );

    expect(rt.ensureRoomExists).toHaveBeenCalledTimes(1);
    expect(rt.ensureWorldExists).toHaveBeenCalledTimes(1);
    expect(id).not.toBeNull(); // the write succeeded
    expect(memories).toHaveLength(1);
    expect(rooms.has(memories[0]!.roomId)).toBe(true);
    expect(svc.incrementStat).toHaveBeenCalledWith("threadDigestsEmitted");
  });

  it("CONTROL: the same store still rejects a write into an uncreated room", async () => {
    // Without this the test above would pass against a store that enforces
    // nothing, and the regression would be undetectable.
    const { rt } = fkEnforcingRuntime();
    await expect(rt.createMemory({ roomId: ABSENT_ROOM })).rejects.toThrow(
      /Failed query/,
    );
  });

  it("CONTROL: a failed write still returns null and counts no stat", async () => {
    const { rt } = fkEnforcingRuntime();
    const svc = fakeService();
    rt.ensureRoomExists = vi.fn(async () => undefined); // room never actually created
    const id = await new ThreadDigestBuffer().flushGroup(
      rt as never,
      svc as never,
      "p1",
      staged,
      null,
    );
    expect(id).toBeNull();
    expect(svc.incrementStat).not.toHaveBeenCalled();
  });

  it("uses the same room id dispatchPostMention uses", async () => {
    // Digests must land in the SAME room as the individual posts, or the fix
    // trades an FK violation for a silently orphaned conversation history.
    const { rt, memories } = fkEnforcingRuntime();
    await new ThreadDigestBuffer().flushGroup(
      rt as never,
      fakeService() as never,
      "p1",
      staged,
      null,
    );
    const roomArg = (rt.ensureRoomExists as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(roomArg.channelId).toBe("p1");
    expect(roomArg.type).toBe("FEED");
    expect(String(roomArg.id)).toBe(memories[0]!.roomId);
  });
});

describe("describeDbError", () => {
  it("surfaces the driver cause that String(err) discards", () => {
    const cause = Object.assign(new Error("violates foreign key constraint"), {
      code: "23503",
      constraint: "fk_room",
      table_name: "memories",
      detail: 'Key (room_id)=(abc) is not present in table "rooms".',
    });
    const err = Object.assign(
      new Error('Failed query: insert into "memories" ...'),
      { cause },
    );

    const described = describeDbError(err);
    expect(described).toContain("code=23503");
    expect(described).toContain("constraint=fk_room");
    expect(described).toContain("not present in table");

    // CONTROL — this is precisely what the old code emitted, and why three
    // months of failures were indistinguishable from one another.
    expect(String(err)).not.toContain("fk_room");
  });

  it("CONTROL: a plain error is still rendered, not swallowed", () => {
    expect(describeDbError(new Error("boom"))).toContain("boom");
  });

  it("terminates on a self-referential cause chain", () => {
    const e: Error & { cause?: unknown } = new Error("loop");
    e.cause = e;
    expect(() => describeDbError(e)).not.toThrow();
  });
});

describe("dedup key is unchanged by this fix", () => {
  it("same post + same notif set -> same key", () => {
    expect(computeThreadDigestDedupKey("p1", staged)).toBe(
      computeThreadDigestDedupKey("p1", [...staged].reverse()),
    );
  });
});
