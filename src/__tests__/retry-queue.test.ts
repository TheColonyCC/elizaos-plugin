import { describe, expect, it, vi, beforeEach } from "vitest";
import { RetryQueue, type RetryEntry } from "../services/retry-queue.js";
import type { IAgentRuntime } from "@elizaos/core";

function cacheRuntime(): { runtime: IAgentRuntime; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const runtime = {
    getCache: vi.fn(async (k: string) => store.get(k)),
    setCache: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  } as unknown as IAgentRuntime;
  return { runtime, store };
}

describe("RetryQueue", () => {
  let runtime: IAgentRuntime;
  let queue: RetryQueue;

  beforeEach(() => {
    ({ runtime } = cacheRuntime());
    queue = new RetryQueue(runtime, "test-key", { maxAttempts: 3, maxAgeMs: 60 * 60 * 1000 });
  });

  it("enqueue adds an entry with id/kind/payload/attempts=0", async () => {
    await queue.enqueue("post", { title: "T", body: "B" }, new Error("500"));
    const pending = await queue.pending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.kind).toBe("post");
    expect(pending[0]!.attempts).toBe(0);
    expect(pending[0]!.payload).toEqual({ title: "T", body: "B" });
    expect(pending[0]!.lastError).toContain("500");
  });

  it("drain skips entries whose nextRetryTs is in the future", async () => {
    await queue.enqueue("post", {}, new Error("x"));
    const executor = vi.fn();
    const stats = await queue.drain(executor);
    expect(executor).not.toHaveBeenCalled();
    expect(stats).toEqual({ succeeded: 0, failed: 0, dropped: 0 });
  });

  it("drain runs entries past nextRetryTs; successful ones removed", async () => {
    await queue.enqueue("post", { title: "T" }, new Error("x"));
    // Force nextRetryTs into the past
    const pending = await queue.pending();
    pending[0]!.nextRetryTs = Date.now() - 1000;
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", pending);

    const executor = vi.fn(async () => undefined);
    const stats = await queue.drain(executor);
    expect(executor).toHaveBeenCalled();
    expect(stats.succeeded).toBe(1);
    expect(await queue.pending()).toEqual([]);
  });

  it("drain re-queues failed entries with incremented attempts and backoff", async () => {
    await queue.enqueue("post", { title: "T" }, new Error("x"));
    const pending = await queue.pending();
    pending[0]!.nextRetryTs = Date.now() - 1000;
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", pending);

    const executor = vi.fn(async () => {
      throw new Error("still failing");
    });
    const stats = await queue.drain(executor);
    expect(stats.failed).toBe(1);
    const after = await queue.pending();
    expect(after.length).toBe(1);
    expect(after[0]!.attempts).toBe(1);
    expect(after[0]!.nextRetryTs).toBeGreaterThan(Date.now());
    expect(after[0]!.lastError).toContain("still failing");
  });

  it("drain drops entries past maxAttempts", async () => {
    await queue.enqueue("post", {}, new Error("x"));
    const pending = await queue.pending();
    pending[0]!.attempts = 3; // at max
    pending[0]!.nextRetryTs = Date.now() - 1000;
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", pending);

    const stats = await queue.drain(vi.fn());
    expect(stats.dropped).toBe(1);
    expect(await queue.pending()).toEqual([]);
  });

  it("drain drops entries past maxAge", async () => {
    await queue.enqueue("post", {}, new Error("x"));
    const pending = await queue.pending();
    pending[0]!.firstEnqueuedTs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    pending[0]!.nextRetryTs = Date.now() - 1000;
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", pending);

    const stats = await queue.drain(vi.fn());
    expect(stats.dropped).toBe(1);
  });

  it("drain on empty queue returns zero counts", async () => {
    const stats = await queue.drain(vi.fn());
    expect(stats).toEqual({ succeeded: 0, failed: 0, dropped: 0 });
  });

  it("read returns [] when getCache returns undefined", async () => {
    expect(await queue.read()).toEqual([]);
  });

  it("read returns [] when runtime has no getCache", async () => {
    const rt = {} as unknown as IAgentRuntime;
    const q = new RetryQueue(rt, "k", { maxAttempts: 3, maxAgeMs: 60 * 60 * 1000 });
    expect(await q.read()).toEqual([]);
  });

  it("enqueue is a no-op when runtime has no setCache (just logs)", async () => {
    const rt = {
      getCache: vi.fn(async () => []),
    } as unknown as IAgentRuntime;
    const q = new RetryQueue(rt, "k", { maxAttempts: 3, maxAgeMs: 60 * 60 * 1000 });
    await q.enqueue("post", {}, new Error("x"));
    // No crash; pending is empty since write was a no-op
    expect(await q.read()).toEqual([]);
  });

  it("handles cache returning a non-array value safely", async () => {
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", "garbage" as unknown as RetryEntry[]);
    expect(await queue.read()).toEqual([]);
  });

  it("drain with mixed eligible + ineligible entries processes only eligible ones", async () => {
    await queue.enqueue("post", { title: "eligible" }, new Error("x"));
    await queue.enqueue("post", { title: "future" }, new Error("x"));
    const pending = await queue.pending();
    pending[0]!.nextRetryTs = Date.now() - 1000; // eligible
    pending[1]!.nextRetryTs = Date.now() + 60_000; // future
    const rt = runtime as unknown as {
      setCache: (k: string, v: unknown) => Promise<void>;
    };
    await rt.setCache("test-key", pending);

    const executor = vi.fn(async () => undefined);
    const stats = await queue.drain(executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(stats.succeeded).toBe(1);
    const remaining = await queue.pending();
    expect(remaining.length).toBe(1);
    expect((remaining[0]!.payload as { title: string }).title).toBe("future");
  });
});
