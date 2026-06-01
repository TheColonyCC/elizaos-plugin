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

  it("skips notifications whose type is in the ignore set", async () => {
    service.colonyConfig.notificationTypesIgnore = new Set(["vote"]);
    service.client.getNotifications.mockResolvedValue([
      notif({ notification_type: "vote", post_id: "p-any" }),
    ]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).not.toHaveBeenCalled();
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
  });

  it("treats a notification with undefined type as a non-ignored type", async () => {
    service.colonyConfig.notificationTypesIgnore = new Set(["vote"]);
    service.client.getNotifications.mockResolvedValue([
      notif({ notification_type: undefined }),
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-1",
      title: "T",
      body: "B",
      author: { username: "alice" },
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).toHaveBeenCalled();
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
      undefined,
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

  describe("mention trust filter (v0.11.0)", () => {
    it("skips a mention when author karma is below the threshold", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention", post_id: "p-low" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "p-low",
        title: "T",
        body: "B",
        author: { username: "lowkarma" },
      });
      (service.client as unknown as Record<string, unknown>).getUser = vi.fn(async () => ({
        username: "lowkarma",
        karma: 2,
      }));

      await client.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.createMemory).not.toHaveBeenCalled();
      expect(service.client.markNotificationRead).toHaveBeenCalledWith("notif-1");
    });

    it("dispatches when author karma meets the threshold", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "gooduser" },
      });
      (service.client as unknown as Record<string, unknown>).getUser = vi.fn(async () => ({
        username: "gooduser",
        karma: 50,
      }));

      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("fails open when getUser throws (still dispatches)", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "flaky" },
      });
      (service.client as unknown as Record<string, unknown>).getUser = vi.fn(async () => {
        throw new Error("api down");
      });
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("fails open when getUser returns no karma field", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "noKarmaField" },
      });
      (service.client as unknown as Record<string, unknown>).getUser = vi.fn(async () => ({
        username: "noKarmaField",
      }));
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("skips the trust check when mentionMinKarma is 0 (default)", async () => {
      service.colonyConfig.mentionMinKarma = 0;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      const getUserSpy = vi.fn();
      (service.client as unknown as Record<string, unknown>).getUser = getUserSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getUserSpy).not.toHaveBeenCalled();
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("skips the trust check for non-mention notification types", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "comment_on_post" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      const getUserSpy = vi.fn();
      (service.client as unknown as Record<string, unknown>).getUser = getUserSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getUserSpy).not.toHaveBeenCalled();
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("skips the trust check when post author username is missing", async () => {
      service.colonyConfig.mentionMinKarma = 5;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: {},
      });
      const getUserSpy = vi.fn();
      (service.client as unknown as Record<string, unknown>).getUser = getUserSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getUserSpy).not.toHaveBeenCalled();
      expect(runtime.createMemory).toHaveBeenCalled();
    });
  });

  describe("mention thread context (v0.12.0)", () => {
    it("fetches thread comments and dispatches them in the memory text", async () => {
      service.colonyConfig.mentionThreadComments = 3;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => [
        { body: "top comment", author: { username: "alice" } },
        { body: "follow-up", author: { username: "bob" } },
      ]);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const memoryArg = memoryCall?.[0] as { content?: { text?: string } };
      expect(memoryArg.content?.text).toContain("@alice: top comment");
      expect(memoryArg.content?.text).toContain("@bob: follow-up");
    });

    it("skips comment fetch when mentionThreadComments is 0", async () => {
      service.colonyConfig.mentionThreadComments = 0;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      const getCommentsSpy = vi.fn();
      (service.client as unknown as Record<string, unknown>).getComments = getCommentsSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getCommentsSpy).not.toHaveBeenCalled();
    });

    it("dispatches without thread context when getComments throws", async () => {
      service.colonyConfig.mentionThreadComments = 3;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => {
        throw new Error("network");
      });
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("handles getComments returning items wrapper", async () => {
      service.colonyConfig.mentionThreadComments = 3;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => ({
        items: [{ body: "wrapped", author: { username: "alice" } }],
      }));
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const memoryArg = memoryCall?.[0] as { content?: { text?: string } };
      expect(memoryArg.content?.text).toContain("@alice: wrapped");
    });

    it("threads reply under comment_id for reply_to_comment notifications (v0.14.0)", async () => {
      service.colonyConfig.mentionThreadComments = 0; // skip thread-context fetch
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "parent-comment-id",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      // Ensure the dispatched memory + handleMessage callback end up
      // passing parentCommentId through createComment.
      service.client.createComment.mockResolvedValue({ id: "c1" });
      runtime.messageService!.handleMessage = vi.fn(async (_r, _m, cb) => {
        await cb!({ text: "my reply", source: "colony" });
      });
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.client.createComment).toHaveBeenCalledWith(
        "post-1",
        "my reply",
        "parent-comment-id",
      );
    });

    it("handles getComments returning a truthy object with no items key", async () => {
      service.colonyConfig.mentionThreadComments = 3;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => ({}));
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const memoryArg = memoryCall?.[0] as { content?: { text?: string } };
      expect(memoryArg.content?.text).not.toContain("Recent comments on the thread");
    });

    it("proceeds without thread context when client has no getComments", async () => {
      service.colonyConfig.mentionThreadComments = 3;
      service.client.getNotifications.mockResolvedValue([notif()]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      delete (service.client as unknown as Record<string, unknown>).getComments;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });
  });

  describe("conversation-tree topology (post-v0.33 fix)", () => {
    it("walks the parent chain root-first and surfaces the target via getAllComments", async () => {
      service.colonyConfig.mentionThreadComments = 2;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-target",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      // Full comment graph: c-root → c-mid → c-target; plus two siblings.
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { id: "c-root", parent_id: null, author: { username: "eve" }, body: "root", created_at: "2026-06-01T09:00:00Z" },
        { id: "c-mid", parent_id: "c-root", author: { username: "frank" }, body: "middle", created_at: "2026-06-01T09:30:00Z" },
        { id: "c-target", parent_id: "c-mid", author: { username: "carol" }, body: "leaf-target", created_at: "2026-06-01T10:00:00Z" },
        { id: "c-sib1", parent_id: null, author: { username: "alice" }, body: "sibling A" },
        { id: "c-sib2", parent_id: null, author: { username: "bob" }, body: "sibling B" },
      ]);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const text = (memoryCall?.[0] as { content?: { text?: string } }).content?.text ?? "";
      expect(text).toContain("REPLY TARGET");
      expect(text).toContain("@carol");
      expect(text).toContain("leaf-target");
      expect(text).toContain("Ancestry");
      expect(text).toContain("@eve");
      expect(text).toContain("@frank");
      expect(text).toContain("↳");
      // siblings rendered as "Other comments" context, not as target
      expect(text).toContain("Other comments on the thread");
      expect(text).toContain("@alice");
      // ancestry appears before target appears before other-comments
      expect(text.indexOf("Ancestry")).toBeLessThan(text.indexOf("REPLY TARGET"));
      expect(text.indexOf("REPLY TARGET")).toBeLessThan(text.indexOf("Other comments"));
    });

    it("handles a top-level target (no ancestry, no Ancestry section)", async () => {
      service.colonyConfig.mentionThreadComments = 2;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_my_comment",
          comment_id: "c-top",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { id: "c-top", parent_id: null, author: { username: "carol" }, body: "top-level" },
        { id: "c-other", parent_id: null, author: { username: "alice" }, body: "sibling" },
      ]);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const text = (memoryCall?.[0] as { content?: { text?: string } }).content?.text ?? "";
      expect(text).toContain("REPLY TARGET");
      expect(text).toContain("@carol");
      expect(text).not.toContain("Ancestry");
    });

    it("falls through to legacy getComments path when target id is not in the fetched set", async () => {
      service.colonyConfig.mentionThreadComments = 2;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-missing",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { id: "c-other", parent_id: null, author: { username: "alice" }, body: "unrelated" },
      ]);
      const getCommentsSpy = vi.fn(async () => [
        { id: "c-other", author: { username: "alice" }, body: "unrelated" },
      ]);
      (service.client as unknown as Record<string, unknown>).getComments = getCommentsSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const text = (memoryCall?.[0] as { content?: { text?: string } }).content?.text ?? "";
      // Legacy path means no REPLY TARGET section but threadComments are rendered.
      expect(text).not.toContain("REPLY TARGET");
      expect(text).toContain("Recent comments on the thread");
      expect(getCommentsSpy).toHaveBeenCalled();
    });

    it("falls through to legacy when getAllComments throws", async () => {
      service.colonyConfig.mentionThreadComments = 1;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-target",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => {
        throw new Error("network");
      });
      const getCommentsSpy = vi.fn(async () => []);
      (service.client as unknown as Record<string, unknown>).getComments = getCommentsSpy;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getCommentsSpy).toHaveBeenCalled();
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("legacy path also returns empty when getAllComments throws AND getComments is unavailable", async () => {
      service.colonyConfig.mentionThreadComments = 1;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-target",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => {
        throw new Error("down");
      });
      delete (service.client as unknown as Record<string, unknown>).getComments;
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("terminates parent walk on a cycle without infinite-looping", async () => {
      service.colonyConfig.mentionThreadComments = 0;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-A",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      // A → B → A cycle. Walker must visit B once and stop.
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { id: "c-A", parent_id: "c-B", author: { username: "carol" }, body: "A" },
        { id: "c-B", parent_id: "c-A", author: { username: "dave" }, body: "B" },
      ]);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const text = (memoryCall?.[0] as { content?: { text?: string } }).content?.text ?? "";
      expect(text).toContain("REPLY TARGET");
      expect(text).toContain("@carol");
      // The single non-target node (c-B / @dave) appears in the ancestry exactly once.
      expect((text.match(/@dave/g) ?? []).length).toBe(1);
    });

    it("projects comments with missing or malformed author fields gracefully", async () => {
      service.colonyConfig.mentionThreadComments = 0;
      service.client.getNotifications.mockResolvedValue([
        notif({
          notification_type: "reply_to_comment",
          comment_id: "c-T",
        }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      // Mix author shapes: object-with-username, object-without-username, non-object author, missing author.
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { id: "c-P", parent_id: null, author: { username: "carol" }, body: "parent" },
        { id: "c-T", parent_id: "c-P", author: 42, body: "target with weird author" },
        // sibling-style entries excluded by count=0
      ]);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      const memoryCall = runtime.createMemory.mock.calls[0];
      const text = (memoryCall?.[0] as { content?: { text?: string } }).content?.text ?? "";
      // target's author was non-object, projectComment returns undefined author,
      // dispatch renders "@unknown:" as the fallback.
      expect(text).toContain("REPLY TARGET");
      expect(text).toContain("target with weird author");
      expect(text).toContain("@unknown");
      // parent had a proper author shape — covers the truthy `author && typeof === 'object'` branch.
      expect(text).toContain("@carol");
    });

    it("does not call getAllComments when notification is not a reply_to_comment", async () => {
      service.colonyConfig.mentionThreadComments = 1;
      service.client.getNotifications.mockResolvedValue([
        notif({ notification_type: "mention", comment_id: "c-irrelevant" }),
      ]);
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
        author: { username: "u" },
      });
      const getAllSpy = vi.fn();
      (service.client as unknown as Record<string, unknown>).getAllComments = getAllSpy;
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => []);
      await client.start();
      await vi.advanceTimersByTimeAsync(0);
      // Mention notifications take the legacy path, not the reply-target path.
      expect(getAllSpy).not.toHaveBeenCalled();
    });
  });
});
