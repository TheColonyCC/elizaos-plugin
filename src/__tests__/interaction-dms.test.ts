import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ColonyInteractionClient } from "../services/interaction.js";
import { fakeService, type FakeService } from "./helpers.js";
import type { IAgentRuntime } from "@elizaos/core";

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

function dmConv(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    other_user: { username: "alice" },
    unread_count: 1,
    last_message_preview: "hi",
    ...overrides,
  };
}

function dmDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    other_user: { username: "alice" },
    messages: [
      {
        id: "msg-1",
        sender: { username: "alice" },
        body: "hello there",
        created_at: "2026-04-15T18:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("ColonyInteractionClient — DM handling", () => {
  let service: FakeService;
  let runtime: MockRuntime;
  let client: ColonyInteractionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockRuntime();
    client = new ColonyInteractionClient(service as never, runtime, 60_000);
    service.client.getNotifications.mockResolvedValue([]);
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("processes a new DM end-to-end and posts a reply via sendMessage", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    service.client.sendMessage.mockResolvedValue({ id: "msg-2" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, callback) => {
      if (callback) {
        await callback({ text: "hello back" });
      }
      return {};
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.client.listConversations).toHaveBeenCalled();
    expect(service.client.getConversation).toHaveBeenCalledWith("alice");
    expect(runtime.ensureRoomExists).toHaveBeenCalledWith(
      expect.objectContaining({ type: "DM" }),
    );
    expect(runtime.createMemory).toHaveBeenCalled();
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
    expect(service.client.sendMessage).toHaveBeenCalledWith("alice", "hello back");
  });

  it("skips conversations with zero unread messages", async () => {
    service.client.listConversations.mockResolvedValue([
      dmConv({ unread_count: 0 }),
    ]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getConversation).not.toHaveBeenCalled();
  });

  it("skips conversations with no other_user", async () => {
    service.client.listConversations.mockResolvedValue([
      { id: "conv-x", unread_count: 1 },
    ]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getConversation).not.toHaveBeenCalled();
  });

  it("tolerates listConversations failure and continues next tick", async () => {
    service.client.listConversations
      .mockRejectedValueOnce(new Error("list-down"))
      .mockResolvedValueOnce([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.listConversations).toHaveBeenCalledTimes(2);
  });

  it("tolerates getConversation failure", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockRejectedValue(new Error("not-found"));
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.sendMessage).not.toHaveBeenCalled();
  });

  it("skips empty conversations", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
      messages: [],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("skips conversations with undefined messages array", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("works when runtime has no agentId during DM dispatch", async () => {
    const rt = mockRuntime({ agentId: undefined as unknown as string });
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });

  it("skips messages where the latest sender has no username", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
      messages: [{ id: "m1", sender: {}, body: "hi" }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("skips messages sent by the agent itself", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
      messages: [
        { id: "m1", sender: { username: "eliza-test" }, body: "self echo" },
      ],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("dedupes against runtime.getMemoryById", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    runtime.getMemoryById = vi.fn(async () => ({ id: "any" }) as never);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("callback with no response.text is treated as empty", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, callback) => {
      if (callback) {
        const memories = await callback({});
        expect(memories).toEqual([]);
      }
      return {};
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.sendMessage).not.toHaveBeenCalled();
  });

  it("callback with empty text is a no-op", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, callback) => {
      if (callback) {
        const memories = await callback({ text: "  " });
        expect(memories).toEqual([]);
      }
      return {};
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.sendMessage).not.toHaveBeenCalled();
  });

  it("callback handles sendMessage failure", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    service.client.sendMessage.mockRejectedValue(new Error("forbidden"));
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, callback) => {
      if (callback) {
        const memories = await callback({ text: "reply" });
        expect(memories).toEqual([]);
      }
      return {};
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("sendMessage response without an id still produces a memory", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    service.client.sendMessage.mockResolvedValue({});
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, callback) => {
      if (callback) {
        const memories = await callback({ text: "ok" });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("handles a message with undefined body and undefined created_at", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
      messages: [{ id: "m1", sender: { username: "alice" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).toHaveBeenCalled();
  });

  it("handles unparseable created_at", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue({
      id: "conv-1",
      other_user: { username: "alice" },
      messages: [
        {
          id: "m1",
          sender: { username: "alice" },
          body: "hi",
          created_at: "not-a-date",
        },
      ],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).toHaveBeenCalled();
  });

  it("works when runtime has no ensureWorldExists / ensureConnection / ensureRoomExists", async () => {
    const rt = mockRuntime({
      ensureWorldExists: undefined as unknown as MockRuntime["ensureWorldExists"],
      ensureConnection: undefined as unknown as MockRuntime["ensureConnection"],
      ensureRoomExists: undefined as unknown as MockRuntime["ensureRoomExists"],
    });
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });

  it("works when runtime has no createMemory or messageService", async () => {
    const rt = mockRuntime({
      createMemory: undefined as unknown as MockRuntime["createMemory"],
      messageService: null,
    });
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });

  it("works when runtime has no getMemoryById", async () => {
    const rt = mockRuntime({
      getMemoryById: undefined as unknown as MockRuntime["getMemoryById"],
    });
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });

  it("handleMessage error during DM is caught", async () => {
    service.client.listConversations.mockResolvedValue([dmConv()]);
    service.client.getConversation.mockResolvedValue(dmDetail());
    runtime.messageService!.handleMessage = vi.fn(async () => {
      throw new Error("llm-down");
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Should not crash — just log and move on
  });

  it("stops mid-DM-loop when service is stopped", async () => {
    service.client.listConversations.mockResolvedValue([
      dmConv({ id: "c1" }),
      dmConv({ id: "c2", other_user: { username: "bob" } }),
    ]);
    service.client.getConversation.mockImplementation(async () => {
      await client.stop();
      return dmDetail();
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getConversation).toHaveBeenCalledTimes(1);
  });

  it("does not run tickDMs if stopped after notifications", async () => {
    service.client.getNotifications.mockImplementation(async () => {
      await client.stop();
      return [];
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.listConversations).not.toHaveBeenCalled();
  });
});
