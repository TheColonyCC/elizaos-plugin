import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  dispatchDirectMessage,
  dispatchPostMention,
} from "../services/dispatch.js";
import { colonyStatusAction } from "../actions/status.js";
import { sendColonyDMAction } from "../actions/sendDM.js";
import { ColonyInteractionClient } from "../services/interaction.js";
import { ColonyService } from "../services/colony.service.js";
import { ColonyPostClient } from "../services/post-client.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";
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

describe("v0.19.0 — action-meta filter in dispatchPostMention", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("drops responses that carry a Colony action name", async () => {
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({
          text: "I need a postId and comment body to reply on The Colony.",
          action: "REPLY_COLONY_POST",
        });
        // The dispatch callback should drop this — no memory returned
        expect(memories).toEqual([]);
      }
      return {};
    });
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "fresh-leak",
      postId: "p-leak",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    // createComment MUST NOT have been called with the leak text
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("passes through non-action responses as normal reply content", async () => {
    service.client.createComment.mockResolvedValue({ id: "c-1" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({ text: "substantive reply text" });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "fresh-real",
      postId: "p-real",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    expect(service.client.createComment).toHaveBeenCalledWith(
      "p-real",
      "substantive reply text",
      undefined,
    );
  });

  it("drops action-meta responses in DM dispatch too", async () => {
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
      memoryIdKey: "dm-leak",
      senderUsername: "jack",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(service.client.sendMessage).not.toHaveBeenCalled();
  });
});

describe("v0.19.0 — per-conversation DM context in dispatchDirectMessage", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("renders prior thread messages into the memory body when supplied", async () => {
    const memorySpy = vi.fn(async () => undefined);
    runtime.createMemory = memorySpy;
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "ctx-1",
      senderUsername: "jack",
      messageId: "m-1",
      body: "latest question",
      conversationId: "c-1",
      threadMessages: [
        { senderUsername: "jack", body: "first question" },
        { senderUsername: "eliza-test", body: "first answer" },
      ],
    });
    const arg = memorySpy.mock.calls[0]?.[0] as { content?: { text?: string } };
    expect(arg.content?.text).toContain("Recent DM thread");
    expect(arg.content?.text).toContain("first question");
    expect(arg.content?.text).toContain("first answer");
    expect(arg.content?.text).toContain("latest question");
  });

  it("falls back to plain body when threadMessages is empty", async () => {
    const memorySpy = vi.fn(async () => undefined);
    runtime.createMemory = memorySpy;
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "ctx-2",
      senderUsername: "jack",
      messageId: "m-2",
      body: "standalone",
      conversationId: "c-1",
      threadMessages: [],
    });
    const arg = memorySpy.mock.calls[0]?.[0] as { content?: { text?: string } };
    expect(arg.content?.text).toBe("standalone");
  });

  it("truncates long thread-message bodies at 500 chars", async () => {
    const memorySpy = vi.fn(async () => undefined);
    runtime.createMemory = memorySpy;
    const long = "a".repeat(1000);
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "ctx-3",
      senderUsername: "jack",
      messageId: "m-3",
      body: "body",
      conversationId: "c-1",
      threadMessages: [{ senderUsername: "jack", body: long }],
    });
    const arg = memorySpy.mock.calls[0]?.[0] as { content?: { text?: string } };
    // Thread line should contain exactly 500 'a's, not 1000
    const thread = arg.content?.text ?? "";
    const threadLine = thread.split("\n").find((l) => l.includes("@jack:"));
    expect(threadLine).toBeDefined();
    expect(threadLine!.length).toBeLessThan(550);
  });
});

describe("v0.19.0 — retry-queue + diversity visibility in COLONY_STATUS", () => {
  it("surfaces pending retry entries with breakdown + oldest age", async () => {
    const service = fakeService();
    (service as unknown as { postClient: unknown }).postClient = {
      getRetryQueue: () => ({
        pending: vi.fn(async () => [
          {
            id: "r-1",
            kind: "post",
            payload: {},
            attempts: 1,
            firstEnqueuedTs: Date.now() - 12 * 60_000,
            nextRetryTs: Date.now() + 60_000,
          },
          {
            id: "r-2",
            kind: "comment",
            payload: {},
            attempts: 0,
            firstEnqueuedTs: Date.now() - 3 * 60_000,
            nextRetryTs: Date.now() + 60_000,
          },
        ]),
      }),
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Retry queue: 2 pending");
    expect(reply.text).toContain("oldest 12m");
  });

  it("hides retry-queue line when queue is empty", async () => {
    const service = fakeService();
    (service as unknown as { postClient: unknown }).postClient = {
      getRetryQueue: () => ({
        pending: vi.fn(async () => []),
      }),
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).not.toContain("Retry queue:");
  });

  it("swallows retry-queue read errors without breaking status", async () => {
    const service = fakeService();
    (service as unknown as { postClient: unknown }).postClient = {
      getRetryQueue: () => ({
        pending: vi.fn(async () => {
          throw new Error("cache down");
        }),
      }),
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    expect(cb).toHaveBeenCalled();
  });

  it("surfaces diversity-watchdog peek when the watchdog has ≥2 samples", async () => {
    const service = fakeService();
    (service as unknown as { diversityWatchdog: unknown }).diversityWatchdog = {
      size: () => 3,
      peakSimilarity: () => 0.65,
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Content diversity");
    expect(reply.text).toContain("65%");
  });

  it("adds warning indicator when diversity peak is approaching threshold", async () => {
    const service = fakeService();
    service.colonyConfig.diversityThreshold = 0.8;
    (service as unknown as { diversityWatchdog: unknown }).diversityWatchdog = {
      size: () => 3,
      peakSimilarity: () => 0.75, // ≥ 0.8 * 0.9 = 0.72
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Content diversity ⚠️");
  });

  it("hides diversity line when watchdog has only 1 sample", async () => {
    const service = fakeService();
    (service as unknown as { diversityWatchdog: unknown }).diversityWatchdog = {
      size: () => 1,
      peakSimilarity: () => 0,
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).not.toContain("Content diversity");
  });

  it("surfaces pause reason when currently paused", async () => {
    const service = fakeService();
    service.isPausedForBackoff = vi.fn(() => true);
    service.pausedUntilTs = Date.now() + 10 * 60_000;
    service.pauseReason = "semantic_repetition";
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, fakeMessage("status"), fakeState(), {}, cb);
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("reason: semantic_repetition");
  });
});

describe("v0.19.0 — sendColonyDMAction validate tightening", () => {
  it("returns true when text has @-mention AND keyword", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    expect(
      await sendColonyDMAction.validate(runtime, fakeMessage("message @alice")),
    ).toBe(true);
  });

  it("returns true when text has keyword AND `username:` arg", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    expect(
      await sendColonyDMAction.validate(
        runtime,
        fakeMessage("send a dm with username: alice"),
      ),
    ).toBe(true);
  });

  it("returns false for bare 'dm' without a target (v0.19.0 tightening)", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    expect(
      await sendColonyDMAction.validate(runtime, fakeMessage("dm later")),
    ).toBe(false);
  });

  it("returns false when the service is missing", async () => {
    const runtime = fakeRuntime(null);
    expect(
      await sendColonyDMAction.validate(runtime, fakeMessage("dm @alice")),
    ).toBe(false);
  });

  it("returns false for empty text", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    expect(await sendColonyDMAction.validate(runtime, fakeMessage(""))).toBe(false);
  });
});

describe("v0.19.0 — operator-command intercept in ColonyInteractionClient", () => {
  function makeClient() {
    const client = {
      getNotifications: vi.fn(async () => []),
      markNotificationRead: vi.fn(async () => undefined),
      listConversations: vi.fn(),
      getConversation: vi.fn(),
      sendMessage: vi.fn(async () => ({ id: "sent-1" })),
    };
    return client;
  }

  it("routes operator '!pause' DM directly to state, not to dispatch", async () => {
    const service = fakeService(
      {},
      { operatorUsername: "jack", operatorPrefix: "!" },
    );
    const client = makeClient();
    service.client = client as never;
    service.pauseForReason = vi.fn((ms: number, reason: string) => {
      service.pausedUntilTs = Date.now() + ms;
      service.pauseReason = reason;
      return service.pausedUntilTs;
    });
    client.listConversations.mockResolvedValue([
      { id: "c-1", other_user: { username: "jack" }, unread_count: 1 },
    ]);
    client.getConversation.mockResolvedValue({
      id: "c-1",
      other_user: { username: "jack" },
      messages: [
        {
          id: "m-1",
          sender: { username: "jack" },
          body: "!pause 15m",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const runtime = mockRuntime();
    const interactionClient = new ColonyInteractionClient(
      service as never,
      runtime,
      100_000,
    );
    // tickDMs is private and its loop guard checks `isRunning`; flip it
    // for the test so the first loop iteration does real work without
    // spinning up the timer-driven poll.
    (interactionClient as unknown as { isRunning: boolean }).isRunning = true;
    await (
      interactionClient as unknown as { tickDMs: () => Promise<void> }
    ).tickDMs();
    expect(client.sendMessage).toHaveBeenCalled();
    const [user, reply] = client.sendMessage.mock.calls[0]!;
    expect(user).toBe("jack");
    expect(String(reply)).toContain("Paused autonomy for 15min");
    // The dispatch path should NOT have been reached — handleMessage untouched
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
  });

  it("logs (and continues) when the operator-reply send fails", async () => {
    const service = fakeService(
      {},
      { operatorUsername: "jack", operatorPrefix: "!" },
    );
    const client = makeClient();
    service.client = client as never;
    service.pauseForReason = vi.fn((ms: number) => Date.now() + ms);
    client.sendMessage.mockRejectedValueOnce(new Error("send failed"));
    client.listConversations.mockResolvedValue([
      { id: "c-1", other_user: { username: "jack" }, unread_count: 1 },
    ]);
    client.getConversation.mockResolvedValue({
      id: "c-1",
      other_user: { username: "jack" },
      messages: [
        {
          id: "m-1",
          sender: { username: "jack" },
          body: "!resume",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const runtime = mockRuntime();
    const interactionClient = new ColonyInteractionClient(
      service as never,
      runtime,
      100_000,
    );
    (interactionClient as unknown as { isRunning: boolean }).isRunning = true;
    await (
      interactionClient as unknown as { tickDMs: () => Promise<void> }
    ).tickDMs();
    // No throw — failure is logged, dispatch is still skipped
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
  });

  it("dispatches non-command DMs with prior-thread context when enabled", async () => {
    const service = fakeService({}, { dmContextMessages: 3 });
    const client = makeClient();
    service.client = client as never;
    client.listConversations.mockResolvedValue([
      { id: "c-1", other_user: { username: "alice" }, unread_count: 1 },
    ]);
    client.getConversation.mockResolvedValue({
      id: "c-1",
      other_user: { username: "alice" },
      messages: [
        { id: "old-1", sender: { username: "alice" }, body: "older 1" },
        { id: "old-2", sender: { username: "eliza-test" }, body: "older 2" },
        {
          id: "latest",
          sender: { username: "alice" },
          body: "the latest",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const runtime = mockRuntime();
    const createMemorySpy = vi.fn(async () => undefined);
    runtime.createMemory = createMemorySpy;
    const interactionClient = new ColonyInteractionClient(
      service as never,
      runtime,
      100_000,
    );
    (interactionClient as unknown as { isRunning: boolean }).isRunning = true;
    await (
      interactionClient as unknown as { tickDMs: () => Promise<void> }
    ).tickDMs();
    const firstMemory = createMemorySpy.mock.calls[0]?.[0] as {
      content?: { text?: string };
    };
    expect(firstMemory.content?.text).toContain("older 1");
    expect(firstMemory.content?.text).toContain("older 2");
    expect(firstMemory.content?.text).toContain("the latest");
  });

  it("skips thread-context when dmContextMessages is 0 (default)", async () => {
    const service = fakeService({}, { dmContextMessages: 0 });
    const client = makeClient();
    service.client = client as never;
    client.listConversations.mockResolvedValue([
      { id: "c-1", other_user: { username: "alice" }, unread_count: 1 },
    ]);
    client.getConversation.mockResolvedValue({
      id: "c-1",
      other_user: { username: "alice" },
      messages: [
        { id: "old-1", sender: { username: "alice" }, body: "older" },
        {
          id: "latest",
          sender: { username: "alice" },
          body: "the latest",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const runtime = mockRuntime();
    const createMemorySpy = vi.fn(async () => undefined);
    runtime.createMemory = createMemorySpy;
    const interactionClient = new ColonyInteractionClient(
      service as never,
      runtime,
      100_000,
    );
    (interactionClient as unknown as { isRunning: boolean }).isRunning = true;
    await (
      interactionClient as unknown as { tickDMs: () => Promise<void> }
    ).tickDMs();
    const firstMemory = createMemorySpy.mock.calls[0]?.[0] as {
      content?: { text?: string };
    };
    expect(firstMemory.content?.text).toBe("the latest");
    expect(firstMemory.content?.text).not.toContain("older");
  });

  it("filters empty-body thread messages from the rendered context", async () => {
    const service = fakeService({}, { dmContextMessages: 5 });
    const client = makeClient();
    service.client = client as never;
    client.listConversations.mockResolvedValue([
      { id: "c-1", other_user: { username: "alice" }, unread_count: 1 },
    ]);
    client.getConversation.mockResolvedValue({
      id: "c-1",
      other_user: { username: "alice" },
      messages: [
        { id: "a", sender: { username: "alice" }, body: "" },
        { id: "b", sender: { username: "alice" }, body: "real content" },
        {
          id: "latest",
          sender: { username: "alice" },
          body: "latest",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const runtime = mockRuntime();
    const createMemorySpy = vi.fn(async () => undefined);
    runtime.createMemory = createMemorySpy;
    const interactionClient = new ColonyInteractionClient(
      service as never,
      runtime,
      100_000,
    );
    (interactionClient as unknown as { isRunning: boolean }).isRunning = true;
    await (
      interactionClient as unknown as { tickDMs: () => Promise<void> }
    ).tickDMs();
    const firstMemory = createMemorySpy.mock.calls[0]?.[0] as {
      content?: { text?: string };
    };
    expect(firstMemory.content?.text).toContain("real content");
  });
});
