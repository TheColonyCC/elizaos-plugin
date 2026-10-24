/**
 * v0.41.0 — a dispatched mention stores a COMPACT copy in the room's history
 * (`COLONY_MENTION_MEMORY`, default `compact`).
 *
 * Regression: the stored copy was the dispatched text itself — the whole post,
 * ancestry, "REPLY TARGET" and thread — and plugin-bootstrap's RECENT_MESSAGES
 * puts the room's newest 32 stored memories into each reply prompt. One
 * agent's busy thread reached 298,656 characters of history, and Ollama cut
 * its prompts from the front. These tests read the STORED copy
 * (`createMemory`) and the DISPATCHED copy (`handleMessage`) separately: the
 * fix must shrink the first without touching the second.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  COMPACT_MENTION_POST_CHARS,
  COMPACT_MENTION_TARGET_CHARS,
  compactMentionText,
  dispatchPostMention,
} from "../services/dispatch.js";
import { loadColonyConfig } from "../environment.js";
import { fakeRuntime, fakeService, type FakeService } from "./helpers.js";

const LONG_POST = "A paragraph of the post, repeated to make it long.\n".repeat(400); // 20,400 chars

function mockRuntime() {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getMemoryById: vi.fn(async () => null),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    createMemory: vi.fn(async (_m: Memory, _table: string) => undefined),
    messageService: { handleMessage: vi.fn(async () => ({})) },
  };
}
type Rt = ReturnType<typeof mockRuntime>;
const stored = (rt: Rt, i = 0) => rt.createMemory.mock.calls[i]![0] as Memory;
const dispatched = (rt: Rt, i = 0) => (rt.messageService.handleMessage.mock.calls[i] as unknown[])[1] as Memory;

function reply(n: number) {
  return {
    memoryIdKey: `notif-${n}`,
    postId: "p-busy",
    postTitle: "A busy thread",
    postBody: LONG_POST,
    authorUsername: "op",
    parentCommentId: `c-${n}`,
    targetComment: {
      id: `c-${n}`,
      author: { username: "carol" },
      body: `Question number ${n} for you.`,
      created_at: "2026-10-24T04:33:39Z",
    },
    parentChain: [{ id: "c-root", author: { username: "eve" }, body: "the root comment" }],
    threadComments: [{ author: { username: "dave" }, body: "a side comment" }],
  };
}

describe("v0.41.0 compact stored mention", () => {
  let service: FakeService;
  beforeEach(() => {
    service = fakeService();
  });

  it("stores who said what, not the post, the ancestry or the REPLY TARGET instruction", async () => {
    const rt = mockRuntime();
    await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, reply(1));
    const text = stored(rt).content.text!;
    expect(text).toBe('[on "A busy thread"] @carol (at 2026-10-24T04:33:39Z): Question number 1 for you.');
    expect(text).not.toContain("paragraph of the post");
    expect(text).not.toContain("REPLY TARGET");
    expect(text).not.toContain("@eve");
    expect(text).not.toContain("@dave");
  });

  it("dispatches the full text unchanged, under the same id as the stored copy", async () => {
    const rt = mockRuntime();
    await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, reply(1));
    const full = dispatched(rt);
    expect(full.content.text).toContain(LONG_POST.trim());
    expect(full.content.text).toContain("REPLY TARGET");
    expect(full.content.text).toContain("@eve");
    expect(full.content.text).toContain("@dave");
    const copy = stored(rt);
    expect(copy.id).toBe(full.id);
    expect(copy.roomId).toBe(full.roomId);
    expect(copy.entityId).toBe(full.entityId);
    expect({ ...copy.content, text: undefined }).toEqual({ ...full.content, text: undefined }); // origin, url, source kept
  });

  it("16 replies on one long post: the stored history stays small", async () => {
    const rt = mockRuntime();
    for (let n = 0; n < 16; n++) {
      await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, reply(n));
    }
    const storedChars = rt.createMemory.mock.calls.reduce((s, c) => s + ((c[0] as Memory).content.text?.length ?? 0), 0);
    expect(storedChars).toBeLessThan(16 * 120);
    // The pre-0.41 behaviour on the same input, for scale: every copy carried the post.
    const fullRt = mockRuntime();
    const fullService = fakeService();
    fullService.colonyConfig.mentionMemory = "full";
    for (let n = 0; n < 16; n++) {
      await dispatchPostMention(fullService as never, fullRt as unknown as IAgentRuntime, reply(n));
    }
    const fullChars = fullRt.createMemory.mock.calls.reduce((s, c) => s + ((c[0] as Memory).content.text?.length ?? 0), 0);
    expect(fullChars).toBeGreaterThan(16 * LONG_POST.length);
  });

  it("mentionMemory 'full' stores the dispatched text itself (the pre-0.41 behaviour)", async () => {
    service.colonyConfig.mentionMemory = "full";
    const rt = mockRuntime();
    await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, reply(1));
    expect(stored(rt)).toBe(dispatched(rt));
  });

  it("caps the target body at COMPACT_MENTION_TARGET_CHARS, and names an unknown author", async () => {
    const rt = mockRuntime();
    const r = reply(2);
    r.targetComment = { id: "c-2", body: "x".repeat(5000) } as never;
    await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, r);
    expect(stored(rt).content.text).toBe(`[on "A busy thread"] @unknown: ${"x".repeat(COMPACT_MENTION_TARGET_CHARS)}`);
  });

  it("with no target comment: the post's first 1,000 characters, an exact cut note, and the thread comments", async () => {
    const rt = mockRuntime();
    await dispatchPostMention(service as never, rt as unknown as IAgentRuntime, {
      memoryIdKey: "mention-1",
      postId: "p-mention",
      postTitle: "  Mentioned you here  ",
      postBody: LONG_POST,
      authorUsername: "op",
      threadComments: [{ author: { username: "dave" }, body: "hello" }],
    });
    const text = stored(rt).content.text!;
    const cut = LONG_POST.length - COMPACT_MENTION_POST_CHARS;
    expect(text.startsWith(`[on "Mentioned you here"]\n\n${LONG_POST.slice(0, COMPACT_MENTION_POST_CHARS)} [… ${cut} more characters of the post not stored]`)).toBe(true);
    expect(text).toContain("Recent comments on the thread (1):");
    expect(text).toContain("1. @dave: hello");
    expect(dispatched(rt).content.text).toContain(LONG_POST.trim());
  });

  it("a short post with no target is stored whole, with no cut note", () => {
    expect(compactMentionText({ postId: "p", postTitle: "", postBody: "Short body." }, "")).toBe("[on post p]\n\nShort body.");
    expect(compactMentionText({ postId: "p", postTitle: "T", postBody: undefined as never }, "")).toBe('[on "T"]');
    expect(compactMentionText({ postId: "p", postTitle: "T", postBody: "B", targetComment: { id: "c", author: { username: "x" } } }, "")).toBe('[on "T"] @x: ');
  });
});

describe("v0.41.0 COLONY_MENTION_MEMORY parsing", () => {
  const cfg = (v?: string) =>
    loadColonyConfig(fakeRuntime(null, { COLONY_API_KEY: "col_abc", ...(v === undefined ? {} : { COLONY_MENTION_MEMORY: v }) }));

  it("defaults to compact; 'full' (any case, padded) selects full; anything else falls back to compact", () => {
    expect(cfg().mentionMemory).toBe("compact");
    expect(cfg("full").mentionMemory).toBe("full");
    expect(cfg(" FULL ").mentionMemory).toBe("full");
    expect(cfg("verbatim").mentionMemory).toBe("compact");
    expect(cfg("compact").mentionMemory).toBe("compact");
  });
});
