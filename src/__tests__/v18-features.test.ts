/**
 * Consolidated tests for v0.18.0: COLONY_ENGAGE_LENGTH config that
 * drives both the prompt's length language and the default token cap
 * for autonomous engagement comments. Replaces the v0.17 hard-coded
 * "2-4 sentences" with three operator-tunable presets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { fakeRuntime, fakeService, type FakeService } from "./helpers.js";
import { loadColonyConfig } from "../environment.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";

describe("COLONY_ENGAGE_LENGTH config (v0.18.0)", () => {
  it("defaults to 'medium' with maxTokens 500", () => {
    const rt = fakeRuntime(null, { COLONY_API_KEY: "col_x" });
    const cfg = loadColonyConfig(rt);
    expect(cfg.engageLengthTarget).toBe("medium");
    expect(cfg.engageMaxTokens).toBe(500);
  });

  it("'short' resolves to maxTokens 240 (the v0.17 behavior)", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_LENGTH: "short",
    });
    const cfg = loadColonyConfig(rt);
    expect(cfg.engageLengthTarget).toBe("short");
    expect(cfg.engageMaxTokens).toBe(240);
  });

  it("'long' resolves to maxTokens 800", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_LENGTH: "long",
    });
    const cfg = loadColonyConfig(rt);
    expect(cfg.engageLengthTarget).toBe("long");
    expect(cfg.engageMaxTokens).toBe(800);
  });

  it("normalizes case and whitespace", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_LENGTH: "  LONG  ",
    });
    expect(loadColonyConfig(rt).engageLengthTarget).toBe("long");
  });

  it("falls back to 'medium' on unknown value", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_LENGTH: "supersize",
    });
    expect(loadColonyConfig(rt).engageLengthTarget).toBe("medium");
  });

  it("explicit COLONY_ENGAGE_MAX_TOKENS overrides the length-target default", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_LENGTH: "short", // would normally → 240
      COLONY_ENGAGE_MAX_TOKENS: "1200", // explicit override
    });
    expect(loadColonyConfig(rt).engageMaxTokens).toBe(1200);
  });

  it("explicit override is clamped to [32, 2000]", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ENGAGE_MAX_TOKENS: "9999",
    });
    expect(loadColonyConfig(rt).engageMaxTokens).toBe(2000);
  });
});

describe("Engagement prompt length-target language (v0.18.0)", () => {
  let service: FakeService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
  });

  afterEach(() => vi.useRealTimers());

  function makeRuntime(captureModel: ReturnType<typeof vi.fn>): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: captureModel,
      getCache: vi.fn(async () => []),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
  }

  function clientWithLength(
    rt: IAgentRuntime,
    lengthTarget: "short" | "medium" | "long",
  ): ColonyEngagementClient {
    return new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 500,
      temperature: 0.8,
      selfCheck: false,
      lengthTarget,
    });
  }

  it("'short' prompt asks for 2-4 sentences", async () => {
    const useModel = vi.fn(async () => "Reply text.");
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "T",
          body: "B",
          author: { username: "alice", user_type: "agent" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c" });
    const c = clientWithLength(makeRuntime(useModel), "short");
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).toContain("2-4 sentences");
    expect(prompt).not.toContain("3-4 paragraphs");
    await c.stop();
  });

  it("'medium' prompt asks for 1-2 substantive paragraphs", async () => {
    const useModel = vi.fn(async () => "Reply text.");
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "T",
          body: "B",
          author: { username: "alice", user_type: "agent" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c" });
    const c = clientWithLength(makeRuntime(useModel), "medium");
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).toContain("1-2 paragraphs");
    expect(prompt).toContain("80-200 words");
    await c.stop();
  });

  it("'long' prompt asks for 3-4 paragraphs with concrete claims", async () => {
    const useModel = vi.fn(async () => "Reply text.");
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "T",
          body: "B",
          author: { username: "alice", user_type: "agent" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c" });
    const c = clientWithLength(makeRuntime(useModel), "long");
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).toContain("3-4 paragraphs");
    expect(prompt).toContain("250-450 words");
    await c.stop();
  });

  it("defaults to 'medium' language when lengthTarget is omitted", async () => {
    const useModel = vi.fn(async () => "Reply text.");
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "T",
          body: "B",
          author: { username: "alice", user_type: "agent" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c" });
    const c = new ColonyEngagementClient(service as never, makeRuntime(useModel), {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 500,
      temperature: 0.8,
      selfCheck: false,
      // lengthTarget omitted on purpose
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).toContain("1-2 paragraphs");
    await c.stop();
  });

  it("uses the without-thread variant when no thread comments are fetched", async () => {
    const useModel = vi.fn(async () => "Reply text.");
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "T",
          body: "B",
          author: { username: "alice", user_type: "agent" },
        },
      ],
    });
    // Force thread-comments to 0 → uses the without-thread prompt branch
    service.client.createComment.mockResolvedValue({ id: "c" });
    const c = new ColonyEngagementClient(service as never, makeRuntime(useModel), {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 500,
      temperature: 0.8,
      selfCheck: false,
      lengthTarget: "long",
      threadComments: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    // Both with-thread and without-thread "long" variants mention 3-4
    // paragraphs; the differentiator is that the without-thread variant
    // says "replying to this post" while with-thread mentions commenters.
    expect(prompt).toContain("replying to this post");
    expect(prompt).not.toContain("Engage with specific commenters by name");
    await c.stop();
  });
});
