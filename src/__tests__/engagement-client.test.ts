import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { fakeService, type FakeService } from "./helpers.js";
import type { IAgentRuntime } from "@elizaos/core";

interface MockRuntime extends IAgentRuntime {
  agentId: string;
  character: {
    name: string;
    bio?: string | string[];
    topics?: string[];
    style?: { all?: string[]; chat?: string[] };
  };
  useModel: ReturnType<typeof vi.fn>;
  getCache: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;
}

function mockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: {
      name: "eliza-test",
      bio: "A test agent for engagement",
      topics: ["multi-agent coordination"],
      style: { all: ["Concrete over abstract."], chat: ["Direct."] },
    },
    useModel: vi.fn(async () => "A substantive reply."),
    getCache: vi.fn(async () => []),
    setCache: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as MockRuntime;
}

function config(overrides = {}) {
  return {
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colonies: ["general"],
    candidateLimit: 5,
    maxTokens: 240,
    temperature: 0.8,
    ...overrides,
  };
}

describe("ColonyEngagementClient", () => {
  let service: FakeService;
  let runtime: MockRuntime;
  let client: ColonyEngagementClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockRuntime();
    client = new ColonyEngagementClient(service as never, runtime, config());
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("start() is idempotent", async () => {
    await client.start();
    await client.start();
  });

  it("stop() before start() is a no-op", async () => {
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("joins a thread end-to-end: fetch → pick → generate → createComment → mark seen", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-1",
          title: "Hello",
          body: "World",
          author: { username: "alice" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c-1" });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.getPosts).toHaveBeenCalledWith({
      colony: "general",
      sort: "new",
      limit: 5,
    });
    expect(runtime.useModel).toHaveBeenCalled();
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-1",
      "A substantive reply.",
    );
    const seenCall = runtime.setCache.mock.calls[0];
    expect(seenCall[1]).toContain("post-1");
  });

  it("skips empty candidate lists", async () => {
    service.client.getPosts.mockResolvedValue({ items: [] });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("handles missing items array", async () => {
    service.client.getPosts.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("tolerates getPosts throwing", async () => {
    service.client.getPosts.mockRejectedValue(new Error("api-down"));
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("skips posts authored by the agent itself", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-self",
          title: "Self",
          body: "Body",
          author: { username: "eliza-test" },
        },
      ],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("skips posts already in the seen cache", async () => {
    runtime.getCache = vi.fn(async () => ["post-seen"]);
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-seen",
          title: "Old",
          body: "Body",
          author: { username: "alice" },
        },
      ],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("picks the first unseen non-self post when multiple candidates exist", async () => {
    runtime.getCache = vi.fn(async () => ["post-seen"]);
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "post-seen", title: "Old", body: "", author: { username: "alice" } },
        { id: "post-self", title: "Self", body: "", author: { username: "eliza-test" } },
        { id: "post-new", title: "New", body: "Body", author: { username: "bob" } },
      ],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-new",
      "A substantive reply.",
    );
  });

  it("marks post as seen even when LLM returns SKIP (so we don't retry)", async () => {
    runtime.useModel = vi.fn(async () => "SKIP");
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "post-skip", title: "T", body: "B", author: { username: "alice" } },
      ],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(runtime.setCache).toHaveBeenCalled();
    const seenCall = runtime.setCache.mock.calls[0];
    expect(seenCall[1]).toContain("post-skip");
  });

  it("tolerates generation failing", async () => {
    runtime.useModel = vi.fn(async () => {
      throw new Error("model-down");
    });
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-x", title: "T", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    // Do NOT mark seen on generation failure — we might get a different outcome next time
    expect(runtime.setCache).not.toHaveBeenCalled();
  });

  it("tolerates createComment failing (does not mark seen)", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-fail", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockRejectedValue(new Error("rate-limited"));
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.setCache).not.toHaveBeenCalled();
  });

  it("round-robins through configured colonies", async () => {
    const multiClient = new ColonyEngagementClient(
      service as never,
      runtime,
      config({ colonies: ["alpha", "beta", "gamma"] }),
    );
    service.client.getPosts.mockResolvedValue({ items: [] });
    await multiClient.start();
    await vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(2001);
    const colonies = service.client.getPosts.mock.calls.map(
      (c) => (c[0] as { colony: string }).colony,
    );
    expect(colonies.slice(0, 3)).toEqual(["alpha", "beta", "gamma"]);
    await multiClient.stop();
  });

  it("skips the tick when no colonies are configured", async () => {
    const emptyClient = new ColonyEngagementClient(
      service as never,
      runtime,
      config({ colonies: [] }),
    );
    await emptyClient.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.getPosts).not.toHaveBeenCalled();
    await emptyClient.stop();
  });

  it("strips XML wrappers from the generated comment", async () => {
    runtime.useModel = vi.fn(async () => "<post>wrapped reply</post>");
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-1", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-1",
      "wrapped reply",
    );
  });

  it("returns silently when character has no name", async () => {
    runtime.character = { name: undefined as unknown as string };
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-1", title: "T", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
    // Still marks seen so we don't retry
    expect(runtime.setCache).toHaveBeenCalled();
  });

  it("returns silently when character is null", async () => {
    (runtime as unknown as { character: unknown }).character = null;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-1", title: "T", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("handles bio as an array", async () => {
    runtime.character.bio = ["Line one.", "Line two."];
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("Line one. Line two.");
  });

  it("handles bio as a string", async () => {
    runtime.character.bio = "Single string bio.";
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("Single string bio.");
  });

  it("handles character without bio / topics / style", async () => {
    runtime.character = { name: "minimal" };
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).toHaveBeenCalled();
  });

  it("truncates very long post bodies in the prompt", async () => {
    const longBody = "x".repeat(5000);
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: longBody, author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    // The body is truncated to 1500 chars so the prompt shouldn't contain the full 5000
    expect(prompt.length).toBeLessThan(4000);
  });

  it("uses min when max equals min", async () => {
    const c = new ColonyEngagementClient(
      service as never,
      runtime,
      config({ intervalMinMs: 1000, intervalMaxMs: 1000 }),
    );
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await c.start();
    await vi.advanceTimersByTimeAsync(1001);
    expect(service.client.createComment).toHaveBeenCalled();
    await c.stop();
  });

  it("handles posts without title / body / author", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "bare" }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalledWith(
      "bare",
      "A substantive reply.",
    );
  });

  it("skips posts with no id", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [{ title: "No id", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("does not mark the same post seen twice", async () => {
    runtime.getCache = vi.fn(async () => ["post-x"]);
    // First call: post-x is seen, we pick post-y
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "post-x", title: "T", body: "B", author: { username: "a" } },
        { id: "post-y", title: "T", body: "B", author: { username: "a" } },
      ],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const seenCall = runtime.setCache.mock.calls[0];
    expect(seenCall[1]).toContain("post-y");
  });

  it("tolerates getCache returning non-array", async () => {
    runtime.getCache = vi.fn(async () => "not-array" as unknown as string[]);
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalled();
  });

  it("works when runtime has no getCache or setCache", async () => {
    const rt = mockRuntime({
      getCache: undefined as unknown as MockRuntime["getCache"],
      setCache: undefined as unknown as MockRuntime["setCache"],
    });
    const c = new ColonyEngagementClient(service as never, rt, config());
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalled();
    await c.stop();
  });

  it("skips posts already existing in cached seen list", async () => {
    // Mock cache to already contain post-1 so markSeen short-circuits
    let cache = ["post-1"];
    runtime.getCache = vi.fn(async () => cache);
    runtime.setCache = vi.fn(async (_k, v) => {
      cache = v as string[];
    });
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "post-1", title: "T", body: "B", author: { username: "a" } },
        { id: "post-2", title: "T", body: "B", author: { username: "a" } },
      ],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    // It should pick post-2 (not cached) and mark it seen
    expect(service.client.createComment).toHaveBeenCalledWith("post-2", "A substantive reply.");
    expect(cache).toContain("post-2");
  });

  it("handles 'unknown' when service has no username", async () => {
    service.username = undefined;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const seenCall = runtime.setCache.mock.calls[0];
    expect(seenCall[0]).toContain("/unknown");
  });

  it("stops cleanly mid-tick when stop() is called during generation", async () => {
    runtime.useModel = vi.fn(async () => {
      await client.stop();
      return "A substantive reply.";
    });
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    service.client.createComment.mockResolvedValue({});
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    // Subsequent advances shouldn't trigger more ticks
    await vi.advanceTimersByTimeAsync(5000);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
  });

  it("catches unexpected errors in the outer tick loop", async () => {
    runtime.getCache = vi.fn(async () => {
      throw new Error("cache corrupted");
    });
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p", title: "T", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    // Does not crash
  });

  it("does not add duplicate entries when markSeen is called for an already-cached id", async () => {
    let cache: string[] = [];
    runtime.getCache = vi.fn(async () => cache);
    runtime.setCache = vi.fn(async (_k, v) => {
      cache = v as string[];
    });
    runtime.useModel = vi.fn(async () => "SKIP");
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "post-dup", title: "T", body: "B", author: { username: "a" } }],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(cache).toEqual(["post-dup"]);
  });
});
