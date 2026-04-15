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

function notif(overrides: Record<string, unknown> = {}) {
  return {
    id: "notif-1",
    notification_type: "reply",
    message: "someone replied",
    post_id: "post-1",
    comment_id: null,
    is_read: false,
    created_at: "2026-04-15T18:00:00Z",
    ...overrides,
  };
}

describe("ColonyInteractionClient", () => {
  let service: FakeService;
  let runtime: MockRuntime;
  let client: ColonyInteractionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockRuntime();
    client = new ColonyInteractionClient(service as never, runtime, 60_000);
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("start() is idempotent", async () => {
    service.client.getNotifications.mockResolvedValue([]);
    await client.start();
    await client.start(); // second call should be a no-op
    expect(service.client.getNotifications).toHaveBeenCalledTimes(1);
  });

  it("stop() before start() is a no-op", async () => {
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("ignores already-read notifications", async () => {
    service.client.getNotifications.mockResolvedValue([notif({ is_read: true })]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).not.toHaveBeenCalled();
  });

  it("skips notifications already stored as memories (dedup)", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    runtime.getMemoryById = vi.fn(async () => ({ id: "anything" }) as never);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("marks non-post notifications as read without fetching", async () => {
    service.client.getNotifications.mockResolvedValue([notif({ post_id: null })]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("processes a new notification end-to-end: fetch → ensure → memory → handleMessage → reply → mark", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "Hello",
      body: "World",
      author: { username: "alice" },
    });
    service.client.createComment.mockResolvedValue({ id: "comment-1" });

    runtime.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          await callback({ text: "Thanks for the mention!" });
        }
        return { didRespond: true };
      },
    );

    await client.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(service.client.getPost).toHaveBeenCalledWith("post-1");
    expect(runtime.ensureWorldExists).toHaveBeenCalled();
    expect(runtime.ensureConnection).toHaveBeenCalled();
    expect(runtime.ensureRoomExists).toHaveBeenCalled();
    expect(runtime.createMemory).toHaveBeenCalled();
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-1",
      "Thanks for the mention!",
    );
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("callback with empty text is a no-op", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "Hello",
      body: "World",
      author: { username: "alice" },
    });
    runtime.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          const memories = await callback({ text: "   " });
          expect(memories).toEqual([]);
        }
        return {};
      },
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("callback handles createComment failure without crashing", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "Hi",
      body: "Body",
      author: { username: "alice" },
    });
    service.client.createComment.mockRejectedValue(new Error("rate-limited"));
    runtime.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          const memories = await callback({ text: "reply" });
          expect(memories).toEqual([]);
        }
        return {};
      },
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("callback without createMemory runtime still returns a memory list", async () => {
    const runtimeNoCreate = mockRuntime({
      createMemory: undefined as unknown as MockRuntime["createMemory"],
    });
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    service.client.createComment.mockResolvedValue({ id: "c1" });
    runtimeNoCreate.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          const memories = await callback({ text: "hi" });
          expect(memories.length).toBe(1);
        }
        return {};
      },
    );
    const c = new ColonyInteractionClient(service as never, runtimeNoCreate, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });

  it("createComment response without an id still yields a memory", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    service.client.createComment.mockResolvedValue({});
    runtime.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          const memories = await callback({ text: "hi" });
          expect(memories.length).toBe(1);
        }
        return {};
      },
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("callback with no response.text is treated as empty", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    runtime.messageService!.handleMessage = vi.fn(
      async (_rt, _msg, callback) => {
        if (callback) {
          const memories = await callback({});
          expect(memories).toEqual([]);
        }
        return {};
      },
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("skips getPost failures and continues", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockRejectedValue(new Error("not found"));
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Should NOT have marked read because we couldn't fetch the post
    expect(service.client.markNotificationRead).not.toHaveBeenCalled();
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
  });

  it("tolerates getNotifications failure and retries next tick", async () => {
    service.client.getNotifications
      .mockRejectedValueOnce(new Error("api-down"))
      .mockResolvedValueOnce([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(2);
  });

  it("handleMessage errors are caught and notification still marked read", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    runtime.messageService!.handleMessage = vi.fn(async () => {
      throw new Error("llm-down");
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("markNotificationRead failure is logged and swallowed", async () => {
    service.client.getNotifications.mockResolvedValue([notif({ post_id: null })]);
    service.client.markNotificationRead.mockRejectedValue(new Error("forbidden"));
    await expect(client.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("works when runtime has no getMemoryById", async () => {
    const rt = mockRuntime({
      getMemoryById: undefined as unknown as MockRuntime["getMemoryById"],
    });
    service.client.getNotifications.mockResolvedValue([notif({ post_id: null })]);
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalled();
    await c.stop();
  });

  it("works when runtime has no ensureWorldExists / ensureConnection / ensureRoomExists", async () => {
    const rt = mockRuntime({
      ensureWorldExists: undefined as unknown as MockRuntime["ensureWorldExists"],
      ensureConnection: undefined as unknown as MockRuntime["ensureConnection"],
      ensureRoomExists: undefined as unknown as MockRuntime["ensureRoomExists"],
    });
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "",
      body: "",
      author: undefined,
    });
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalled();
    await c.stop();
  });

  it("works when runtime has no messageService", async () => {
    const rt = mockRuntime({ messageService: null });
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalled();
    await c.stop();
  });

  it("stop() during a pending timeout clears it", async () => {
    service.client.getNotifications.mockResolvedValue([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Loop is now waiting on setTimeout; stop should cancel it
    await client.stop();
    // Advancing timers further should not fire the tick again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(1);
  });

  it("loop exits cleanly if stopped between tick and sleep", async () => {
    service.client.getNotifications.mockImplementation(async () => {
      await client.stop();
      return [];
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(1);
  });

  it("stops mid-tick iteration when service is stopped", async () => {
    service.client.getNotifications.mockResolvedValue([
      notif({ id: "n1", post_id: null }),
      notif({ id: "n2", post_id: null }),
    ]);
    service.client.markNotificationRead.mockImplementation(async () => {
      await client.stop();
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("handles a notification without created_at gracefully", async () => {
    service.client.getNotifications.mockResolvedValue([
      notif({ created_at: undefined }),
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).toHaveBeenCalled();
  });

  it("uses the 'Colony post' fallback name when post has no title", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "",
      body: "",
      author: { username: "alice" },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.ensureRoomExists).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Colony post" }),
    );
  });

  it("handles a post with undefined title, body, and author fields", async () => {
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({ id: "post-1" });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).toHaveBeenCalled();
    const memoryCall = runtime.createMemory.mock.calls[0][0];
    expect(memoryCall.content.text).toBe("");
  });

  it("handles an unparseable created_at timestamp", async () => {
    service.client.getNotifications.mockResolvedValue([
      notif({ created_at: "not-a-date" }),
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.createMemory).toHaveBeenCalled();
  });

  it("works when runtime has no agentId", async () => {
    const rt = mockRuntime({ agentId: undefined as unknown as string });
    service.client.getNotifications.mockResolvedValue([notif()]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "u" },
    });
    const c = new ColonyInteractionClient(service as never, rt, 60_000);
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    await c.stop();
  });
});
