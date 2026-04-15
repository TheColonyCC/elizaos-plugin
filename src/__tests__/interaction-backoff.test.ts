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

function mockRuntime(): MockRuntime {
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
  } as unknown as MockRuntime;
}

class ColonyRateLimitError extends Error {
  retryAfter?: number;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "ColonyRateLimitError";
    this.retryAfter = retryAfter;
  }
}

describe("ColonyInteractionClient — rate-limit backoff", () => {
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

  it("doubles the effective interval on a rate-limit error", async () => {
    service.client.getNotifications
      .mockRejectedValueOnce(new ColonyRateLimitError("too many", 30))
      .mockResolvedValue([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // After failure, next tick should fire at 2x interval (120_000 ms)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(2);
  });

  it("resets backoff after a successful tick", async () => {
    service.client.getNotifications
      .mockRejectedValueOnce(new ColonyRateLimitError("too many"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Tick 2 fires at 120_000 ms due to backoff
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(2);
    // Backoff is now reset — tick 3 should fire at the base 60_000 ms
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(3);
  });

  it("caps backoff at the max multiplier", async () => {
    service.client.getNotifications.mockRejectedValue(new ColonyRateLimitError("persistent"));
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Six consecutive failures → multiplier should cap at 16
    for (let i = 0; i < 6; i++) {
      const currentMultiplier = Math.min(16, Math.pow(2, i + 1));
      await vi.advanceTimersByTimeAsync(60_000 * currentMultiplier);
    }
    // After capping, subsequent ticks should fire at 16x (960_000 ms)
    const callsBeforeCap = service.client.getNotifications.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000 * 16);
    expect(service.client.getNotifications.mock.calls.length).toBeGreaterThan(
      callsBeforeCap,
    );
  });

  it("does not back off on non-rate-limit errors", async () => {
    service.client.getNotifications
      .mockRejectedValueOnce(new Error("generic"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Next tick should fire at base 60_000 ms (no backoff)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(2);
  });

  it("detects rate-limit errors by constructor name when name field is missing", async () => {
    class LegacyRateLimitError extends Error {
      constructor() {
        super("legacy");
      }
    }
    Object.defineProperty(LegacyRateLimitError, "name", { value: "ColonyRateLimitError" });
    const err = new LegacyRateLimitError();
    Object.defineProperty(err, "name", { value: "OtherError" }); // strip instance name
    service.client.getNotifications
      .mockRejectedValueOnce(err)
      .mockResolvedValue([]);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.client.getNotifications).toHaveBeenCalledTimes(2);
  });
});

describe("ColonyInteractionClient — cold-start window", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = mockRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks stale notifications read without processing them", async () => {
    service = fakeService({}, { coldStartWindowMs: 3600 * 1000 });
    const staleNotif = {
      id: "n-old",
      notification_type: "reply",
      post_id: "p-old",
      comment_id: null,
      is_read: false,
      created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    };
    const freshNotif = {
      id: "n-new",
      notification_type: "reply",
      post_id: "p-new",
      comment_id: null,
      is_read: false,
      created_at: new Date(Date.now() - 30 * 1000).toISOString(),
    };
    service.client.getNotifications.mockResolvedValue([staleNotif, freshNotif]);
    service.client.getPost.mockResolvedValue({ id: "p-new", title: "T", body: "B", author: { username: "alice" } });

    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.markNotificationRead).toHaveBeenCalledWith("n-old");
    expect(service.client.getPost).toHaveBeenCalledWith("p-new");
    expect(service.client.getPost).not.toHaveBeenCalledWith("p-old");
    await client.stop();
  });

  it("does not filter when coldStartWindowMs is 0", async () => {
    service = fakeService({}, { coldStartWindowMs: 0 });
    const old = {
      id: "n-1",
      notification_type: "reply",
      post_id: "p-1",
      comment_id: null,
      is_read: false,
      created_at: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(),
    };
    service.client.getNotifications.mockResolvedValue([old]);
    service.client.getPost.mockResolvedValue({ id: "p-1", title: "T", body: "B", author: { username: "alice" } });
    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).toHaveBeenCalled();
    await client.stop();
  });

  it("treats notifications without created_at as fresh (processes them)", async () => {
    service = fakeService({}, { coldStartWindowMs: 3600 * 1000 });
    const notif = {
      id: "n-undated",
      notification_type: "reply",
      post_id: "p-1",
      comment_id: null,
      is_read: false,
    };
    service.client.getNotifications.mockResolvedValue([notif]);
    service.client.getPost.mockResolvedValue({ id: "p-1", title: "T", body: "B", author: { username: "alice" } });
    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).toHaveBeenCalled();
    await client.stop();
  });

  it("treats notifications with unparseable created_at as fresh", async () => {
    service = fakeService({}, { coldStartWindowMs: 3600 * 1000 });
    const notif = {
      id: "n-bad-date",
      notification_type: "reply",
      post_id: "p-1",
      comment_id: null,
      is_read: false,
      created_at: "not-a-date",
    };
    service.client.getNotifications.mockResolvedValue([notif]);
    service.client.getPost.mockResolvedValue({ id: "p-1", title: "T", body: "B", author: { username: "alice" } });
    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.client.getPost).toHaveBeenCalled();
    await client.stop();
  });
});
