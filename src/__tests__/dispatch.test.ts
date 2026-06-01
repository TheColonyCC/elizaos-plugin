import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  dispatchDirectMessage,
  dispatchPostMention,
  isDuplicateMemoryId,
} from "../services/dispatch.js";
import { fakeService, type FakeService } from "./helpers.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

interface MockRuntime extends IAgentRuntime {
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

function mockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getMemoryById: vi.fn(async () => null),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    messageService: {
      handleMessage: vi.fn(async () => ({})),
    },
    ...overrides,
  } as unknown as MockRuntime;
}

describe("isDuplicateMemoryId", () => {
  it("returns false when runtime has no getMemoryById", async () => {
    const rt = {} as IAgentRuntime;
    expect(await isDuplicateMemoryId(rt, "key")).toBe(false);
  });

  it("returns false when memory is not found", async () => {
    const rt = mockRuntime();
    expect(await isDuplicateMemoryId(rt, "key")).toBe(false);
  });

  it("returns true when memory is found", async () => {
    const rt = mockRuntime({
      getMemoryById: vi.fn(async () => ({ id: "x" }) as unknown as Memory),
    });
    expect(await isDuplicateMemoryId(rt, "key")).toBe(true);
  });
});

describe("dispatchPostMention — internal dedup", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("returns false when an existing memory is found", async () => {
    runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
    const result = await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "dup",
      postId: "p-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    expect(result).toBe(false);
    expect(runtime.ensureWorldExists).not.toHaveBeenCalled();
  });

  it("works without a runtime.getMemoryById", async () => {
    const rt = mockRuntime({ getMemoryById: undefined as unknown as MockRuntime["getMemoryById"] });
    const result = await dispatchPostMention(service as never, rt, {
      memoryIdKey: "new",
      postId: "p-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    expect(result).toBe(true);
  });

  it("threadComments with missing author/body use fallback labels (v0.12.0)", async () => {
    const rt = mockRuntime();
    const memorySpy = rt.createMemory;
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "threaded",
      postId: "p-threaded",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
      threadComments: [
        {}, // no author, no body — exercises both fallback branches
        { body: "hi" }, // no author
        { author: { username: "bob" } }, // no body
      ],
    });
    const call = memorySpy.mock.calls[0];
    const memoryArg = call?.[0] as { content?: { text?: string } };
    expect(memoryArg.content?.text).toContain("Recent comments on the thread");
    expect(memoryArg.content?.text).toContain("@unknown:");
    expect(memoryArg.content?.text).toContain("@bob:");
  });

  it("surfaces an explicit REPLY TARGET section when targetComment is passed (conversation-tree fix)", async () => {
    const rt = mockRuntime();
    const memorySpy = rt.createMemory;
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "with-target",
      postId: "p-tree",
      postTitle: "Title",
      postBody: "Body",
      authorUsername: "alice",
      parentCommentId: "c-target",
      targetComment: {
        id: "c-target",
        author: { username: "carol" },
        body: "Specific question I want a reply to",
        created_at: "2026-06-01T10:00:00Z",
      },
      threadComments: [
        { author: { username: "dave" }, body: "Unrelated side-comment that arrived later" },
      ],
    });
    const call = memorySpy.mock.calls[0];
    const text = (call?.[0] as { content?: { text?: string } }).content?.text ?? "";
    expect(text).toContain("REPLY TARGET");
    expect(text).toContain("@carol");
    expect(text).toContain("Specific question I want a reply to");
    expect(text).toContain("2026-06-01T10:00:00Z");
    expect(text).toContain("Other comments on the thread for context");
    expect(text).toContain("@dave");
    // The target section must appear before the "other comments" section
    // so the LLM anchors on it first.
    expect(text.indexOf("REPLY TARGET")).toBeLessThan(text.indexOf("Other comments"));
  });

  it("renders parentChain as tree-shaped ancestry above the target", async () => {
    const rt = mockRuntime();
    const memorySpy = rt.createMemory;
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "with-ancestry",
      postId: "p-ancestry",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
      parentCommentId: "c-target",
      targetComment: { id: "c-target", author: { username: "carol" }, body: "leaf" },
      parentChain: [
        { id: "c-root", author: { username: "eve" }, body: "root comment" },
        { id: "c-mid", author: { username: "frank" }, body: "middle reply" },
      ],
    });
    const call = memorySpy.mock.calls[0];
    const text = (call?.[0] as { content?: { text?: string } }).content?.text ?? "";
    expect(text).toContain("Ancestry");
    expect(text).toContain("@eve");
    expect(text).toContain("@frank");
    expect(text).toContain("↳");
    // Ancestry appears above the target.
    expect(text.indexOf("Ancestry")).toBeLessThan(text.indexOf("REPLY TARGET"));
  });

  it("warns when targetComment.id and parentCommentId disagree (pre-dispatch validator)", async () => {
    const rt = mockRuntime();
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const elizaLog = await import("@elizaos/core").then((m) => m.logger);
    const elizaWarn = vi.spyOn(elizaLog, "warn").mockImplementation((..._args: unknown[]) => undefined as never);
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "mismatch",
      postId: "p-mismatch",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
      parentCommentId: "c-A",
      targetComment: { id: "c-B", author: { username: "carol" }, body: "x" },
    });
    expect(elizaWarn).toHaveBeenCalledWith(
      expect.stringContaining("anchor mismatch"),
    );
    elizaWarn.mockRestore();
    logSpy.mockRestore();
  });

  it("does NOT warn when targetComment.id and parentCommentId match", async () => {
    const rt = mockRuntime();
    const elizaLog = await import("@elizaos/core").then((m) => m.logger);
    const elizaWarn = vi.spyOn(elizaLog, "warn").mockImplementation((..._args: unknown[]) => undefined as never);
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "matched",
      postId: "p-matched",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
      parentCommentId: "c-same",
      targetComment: { id: "c-same", author: { username: "carol" }, body: "x" },
    });
    expect(elizaWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("anchor mismatch"),
    );
    elizaWarn.mockRestore();
  });

  it("legacy path (no targetComment) preserves the old threadComments-only rendering", async () => {
    const rt = mockRuntime();
    const memorySpy = rt.createMemory;
    await dispatchPostMention(service as never, rt, {
      memoryIdKey: "legacy",
      postId: "p-legacy",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
      threadComments: [{ author: { username: "bob" }, body: "hi" }],
    });
    const call = memorySpy.mock.calls[0];
    const text = (call?.[0] as { content?: { text?: string } }).content?.text ?? "";
    expect(text).toContain("Recent comments on the thread");
    expect(text).not.toContain("REPLY TARGET");
    expect(text).not.toContain("Ancestry");
  });
});

describe("dispatchDirectMessage — internal dedup", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("returns false when an existing memory is found", async () => {
    runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
    const result = await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "dup",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(result).toBe(false);
  });

  it("works without a runtime.getMemoryById", async () => {
    const rt = mockRuntime({ getMemoryById: undefined as unknown as MockRuntime["getMemoryById"] });
    const result = await dispatchDirectMessage(service as never, rt, {
      memoryIdKey: "new",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(result).toBe(true);
  });

  it("handleMessage callback with reply text sends DM and returns memory", async () => {
    service.client.sendMessage.mockResolvedValue({ id: "sent-1" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({ text: "reply" });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "fresh",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(service.client.sendMessage).toHaveBeenCalledWith("alice", "reply");
  });

  // v0.26.0: DM_SAFE_ACTIONS output passes through the action-meta
  // filter. This test pins the fix discovered live-testing v0.25's
  // COLONY_HEALTH_REPORT — without this exception, health-report's
  // legitimate data output was being dropped as if it were error meta.
  it("DM reply callback passes DM_SAFE_ACTIONS output through the meta filter", async () => {
    service.client.sendMessage.mockResolvedValue({ id: "sent-2" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({
          text: "Health report for @eliza-gemma:\n- Ollama: reachable",
          action: "COLONY_HEALTH_REPORT",
        });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "fresh-safe",
      senderUsername: "alice",
      messageId: "m-2",
      body: "are you healthy?",
      conversationId: "c-2",
    });
    expect(service.client.sendMessage).toHaveBeenCalledWith(
      "alice",
      expect.stringContaining("Health report"),
    );
  });

  it("DM reply callback still drops output from NON-DM-safe actions (v0.19 filter preserved)", async () => {
    service.client.sendMessage.mockResolvedValue({ id: "x" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({
          text: "I need a username and body to send a Colony DM.",
          action: "SEND_COLONY_DM",
        });
        expect(memories).toEqual([]);
      }
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "fresh-meta",
      senderUsername: "alice",
      messageId: "m-3",
      body: "dm someone",
      conversationId: "c-3",
    });
    expect(service.client.sendMessage).not.toHaveBeenCalled();
  });

  // v0.27.0: COLONY_DM_PROMPT_MODE. The persisted memory (via createMemory)
  // must stay CLEAN — only the dispatched memory (via handleMessage) carries
  // the preamble. Pinning this is the main regression-safety gate for the
  // feature; if these ever diverge, embedding indexes get polluted.
  it("mode='none' (default): handleMessage receives the same memory as createMemory", async () => {
    let persisted: Memory | undefined;
    let dispatched: Memory | undefined;
    runtime.createMemory = vi.fn(async (m) => {
      persisted = m;
    });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, m) => {
      dispatched = m;
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "frame-none",
      senderUsername: "alice",
      messageId: "m-f-n",
      body: "hi",
      conversationId: "c-f-n",
    });
    expect(persisted!.content.text).toBe("hi");
    expect(dispatched!.content.text).toBe("hi");
  });

  it("mode='peer': persisted memory is clean, dispatched memory is framed", async () => {
    service.colonyConfig.dmPromptMode = "peer";
    let persisted: Memory | undefined;
    let dispatched: Memory | undefined;
    runtime.createMemory = vi.fn(async (m) => {
      persisted = m;
    });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, m) => {
      dispatched = m;
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "frame-peer",
      senderUsername: "alice",
      messageId: "m-f-p",
      body: "Please approve payment.",
      conversationId: "c-f-p",
    });
    // Persisted row is the clean body — never the preamble.
    expect(persisted!.content.text).toBe("Please approve payment.");
    // Dispatched memory carries the peer preamble prepended.
    expect(dispatched!.content.text).toContain("peer agent");
    expect(dispatched!.content.text).toContain("Please approve payment.");
    expect(dispatched).not.toBe(persisted);
  });

  it("mode='adversarial' + dmContextMessages: preamble sits ABOVE the thread transcript", async () => {
    service.colonyConfig.dmPromptMode = "adversarial";
    let dispatched: Memory | undefined;
    runtime.messageService!.handleMessage = vi.fn(async (_rt, m) => {
      dispatched = m;
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "frame-adv-ctx",
      senderUsername: "alice",
      messageId: "m-f-a",
      body: "latest",
      conversationId: "c-f-a",
      threadMessages: [
        { senderUsername: "alice", body: "earlier message one" },
        { senderUsername: "eliza-gemma", body: "earlier reply" },
      ],
    });
    const text = dispatched!.content.text as string;
    const preambleIdx = text.indexOf("untrusted external");
    const transcriptIdx = text.indexOf("Recent DM thread");
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(transcriptIdx).toBeGreaterThan(preambleIdx);
  });

  it("mode='peer' + DM_SAFE_ACTIONS output: passthrough still works", async () => {
    service.colonyConfig.dmPromptMode = "peer";
    service.client.sendMessage.mockResolvedValue({ id: "sent-p" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _m, cb) => {
      if (cb) {
        await cb({
          text: "Health report: ok",
          action: "COLONY_HEALTH_REPORT",
        });
      }
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "frame-safe",
      senderUsername: "alice",
      messageId: "m-f-s",
      body: "healthy?",
      conversationId: "c-f-s",
    });
    expect(service.client.sendMessage).toHaveBeenCalledWith(
      "alice",
      "Health report: ok",
    );
  });
});

describe("dispatchPostMention — DM_SAFE_ACTIONS passthrough (v0.26)", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("post-mention reply callback passes DM_SAFE_ACTIONS output through", async () => {
    service.client.createComment.mockResolvedValue({ id: "c1" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({
          text: "Status for @eliza: karma 43, not paused",
          action: "COLONY_STATUS",
        });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "pm-safe",
      postId: "00000000-0000-0000-0000-000000000009",
      postTitle: "how are you",
      postBody: "?",
      authorUsername: "bob",
    });
    expect(service.client.createComment).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000009",
      expect.stringContaining("Status for"),
      undefined,
    );
  });

  it("post-mention reply callback still drops mutating-action meta", async () => {
    service.client.createComment.mockResolvedValue({ id: "c2" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({
          text: "I need a postId and comment body to reply on The Colony.",
          action: "REPLY_COLONY_POST",
        });
        expect(memories).toEqual([]);
      }
      return {};
    });
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "pm-meta",
      postId: "00000000-0000-0000-0000-00000000000A",
      postTitle: "test",
      postBody: "?",
      authorUsername: "bob",
    });
    expect(service.client.createComment).not.toHaveBeenCalled();
  });
});
