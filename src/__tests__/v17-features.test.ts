/**
 * Consolidated tests for v0.17.0 features: quiet-hours gates, LLM-health
 * auto-pause, per-author reaction cooldown, and the karma-trend display
 * in COLONY_STATUS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";
import { isInQuietHours, parseQuietHours } from "../environment.js";
import { ColonyPostClient } from "../services/post-client.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { colonyStatusAction } from "../actions/status.js";

// ──────────────────────────────────────────────────────────────────────
// parseQuietHours / isInQuietHours
// ──────────────────────────────────────────────────────────────────────
describe("parseQuietHours (v0.17.0)", () => {
  it("returns null for empty / whitespace input", () => {
    expect(parseQuietHours("")).toBeNull();
    expect(parseQuietHours("   ")).toBeNull();
  });

  it("parses a simple non-wrapping window", () => {
    expect(parseQuietHours("9-17")).toEqual({ startHour: 9, endHour: 17 });
  });

  it("parses a midnight-wrapping window", () => {
    expect(parseQuietHours("23-7")).toEqual({ startHour: 23, endHour: 7 });
  });

  it("tolerates whitespace around the dash", () => {
    expect(parseQuietHours(" 23 - 7 ")).toEqual({ startHour: 23, endHour: 7 });
  });

  it("returns null for malformed input", () => {
    for (const bad of ["abc", "23", "-7", "23-", "23-7-9", "23:00-07:00"]) {
      expect(parseQuietHours(bad), `expected '${bad}' to parse to null`).toBeNull();
    }
  });

  it("returns null when endHour equals startHour (empty window)", () => {
    expect(parseQuietHours("5-5")).toBeNull();
  });

  it("returns null for out-of-range hours", () => {
    expect(parseQuietHours("24-7")).toBeNull();
    expect(parseQuietHours("23-24")).toBeNull();
    expect(parseQuietHours("-1-7")).toBeNull(); // becomes "-1-7" → match fails
  });
});

describe("isInQuietHours (v0.17.0)", () => {
  it("returns false when window is null", () => {
    expect(isInQuietHours(null)).toBe(false);
  });

  it("non-wrapping window: 9-17, midday in range, evening out", () => {
    const window = { startHour: 9, endHour: 17 };
    expect(isInQuietHours(window, new Date("2026-04-16T12:00:00Z"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-04-16T08:59:00Z"))).toBe(false);
    expect(isInQuietHours(window, new Date("2026-04-16T17:00:00Z"))).toBe(false);
    expect(isInQuietHours(window, new Date("2026-04-16T16:59:00Z"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-04-16T22:00:00Z"))).toBe(false);
  });

  it("wrapping window: 23-7, late night and early morning in range", () => {
    const window = { startHour: 23, endHour: 7 };
    expect(isInQuietHours(window, new Date("2026-04-16T23:00:00Z"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-04-16T03:00:00Z"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-04-16T06:59:00Z"))).toBe(true);
    expect(isInQuietHours(window, new Date("2026-04-16T07:00:00Z"))).toBe(false);
    expect(isInQuietHours(window, new Date("2026-04-16T22:00:00Z"))).toBe(false);
    expect(isInQuietHours(window, new Date("2026-04-16T12:00:00Z"))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Quiet-hours wired into post + engagement clients
// ──────────────────────────────────────────────────────────────────────
describe("Quiet-hours integration (v0.17.0)", () => {
  let service: FakeService;

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the simulated wall clock to 03:00 UTC so the wrapping window
    // (23-7) covers it.
    vi.setSystemTime(new Date("2026-04-16T03:00:00Z"));
    service = fakeService();
  });

  afterEach(() => vi.useRealTimers());

  function runtime(): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => "should not be called"),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
  }

  it("post-client skips a tick during configured quiet hours", async () => {
    service.colonyConfig.postQuietHours = { startHour: 23, endHour: 7 };
    const rt = runtime();
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(rt.useModel).not.toHaveBeenCalled();
    expect(service.client.createPost).not.toHaveBeenCalled();
    await c.stop();
  });

  it("post-client proceeds outside the quiet window", async () => {
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
    service.colonyConfig.postQuietHours = { startHour: 23, endHour: 7 };
    service.client.createPost.mockResolvedValue({ id: "p-1" });
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => "Title: Day post\n\nLegit body."),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
      getSetting: vi.fn(() => null),
    } as unknown as IAgentRuntime;
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createPost).toHaveBeenCalled();
    await c.stop();
  });

  it("engagement-client skips a tick during quiet hours", async () => {
    service.colonyConfig.engageQuietHours = { startHour: 23, endHour: 7 };
    const rt = runtime();
    service.client.getPosts.mockResolvedValue({ items: [] });
    const c = new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.getPosts).not.toHaveBeenCalled();
    expect(rt.useModel).not.toHaveBeenCalled();
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// LLM-health auto-pause via recordLlmCall
// ──────────────────────────────────────────────────────────────────────
describe("ColonyService LLM-health auto-pause (v0.17.0)", () => {
  it("does nothing when threshold is 0 (default disabled)", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.colonyConfig = { llmFailureThreshold: 0 } as never;
    for (let i = 0; i < 10; i++) svc.recordLlmCall("failure");
    expect(svc.pausedUntilTs).toBe(0);
  });

  it("triggers pause when failure rate crosses threshold", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.colonyConfig = {
      llmFailureThreshold: 0.5,
      llmFailureWindowMs: 60_000,
      llmFailureCooldownMs: 5 * 60_000,
      activityWebhookUrl: "",
    } as never;
    svc.recordLlmCall("success");
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure"); // 2/3 = 67%, ≥ 50% threshold, ≥ 3 samples
    expect(svc.pausedUntilTs).toBeGreaterThan(Date.now());
    expect(svc.pausedUntilTs).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("requires at least 3 samples to avoid small-sample flapping", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.colonyConfig = {
      llmFailureThreshold: 0.5,
      llmFailureWindowMs: 60_000,
      llmFailureCooldownMs: 5 * 60_000,
      activityWebhookUrl: "",
    } as never;
    svc.recordLlmCall("failure"); // 1/1 = 100%
    svc.recordLlmCall("failure"); // 2/2 = 100%
    expect(svc.pausedUntilTs).toBe(0); // not enough samples yet
    svc.recordLlmCall("failure"); // 3/3 = 100% → triggers
    expect(svc.pausedUntilTs).toBeGreaterThan(Date.now());
  });

  it("does not re-trigger while already paused", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.colonyConfig = {
      llmFailureThreshold: 0.5,
      llmFailureWindowMs: 60_000,
      llmFailureCooldownMs: 5 * 60_000,
      activityWebhookUrl: "",
    } as never;
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure");
    const firstPause = svc.pausedUntilTs;
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure");
    // pausedUntilTs unchanged — guard prevents extension while still paused
    expect(svc.pausedUntilTs).toBe(firstPause);
  });

  it("prunes entries past the window", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.colonyConfig = {
      llmFailureThreshold: 0.99,
      llmFailureWindowMs: 50,
      llmFailureCooldownMs: 5 * 60_000,
      activityWebhookUrl: "",
    } as never;
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure");
    svc.recordLlmCall("failure");
    expect(svc.llmCallHistory.length).toBe(3);
    await new Promise((r) => setTimeout(r, 80));
    svc.recordLlmCall("success"); // window expired, only this remains
    expect(svc.llmCallHistory.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Per-author reaction cooldown
// ──────────────────────────────────────────────────────────────────────
describe("Per-author reaction cooldown (v0.17.0)", () => {
  let service: FakeService;
  const cfg = (overrides = {}) => ({
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colonies: ["general"],
    candidateLimit: 5,
    maxTokens: 240,
    temperature: 0.8,
    selfCheck: false,
    reactionMode: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    service.colonyConfig.reactionAuthorLimit = 2;
    service.colonyConfig.reactionAuthorWindowMs = 60 * 60_000;
  });

  afterEach(() => vi.useRealTimers());

  function makeRuntime(
    store: Map<string, unknown>,
    classifierResult: string,
  ): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => classifierResult),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
  }

  it("reacts the first N times, then skips further reactions to same author", async () => {
    const store = new Map<string, unknown>();
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;

    // Three candidate posts from the same author
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "p1", title: "A", body: "b", author: { username: "alice" } },
        { id: "p2", title: "B", body: "b", author: { username: "alice" } },
        { id: "p3", title: "C", body: "b", author: { username: "alice" } },
      ],
    });

    const rt = makeRuntime(store, "REACT_FIRE");
    const c = new ColonyEngagementClient(service as never, rt, cfg());
    await c.start();
    // Three sequential ticks, advancing past the next-tick delay each time
    await vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(2001);
    await vi.advanceTimersByTimeAsync(2001);
    // Limit = 2 → only first two reactions fire; third is skipped
    expect(reactPostMock).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  it("does NOT cool down when limit is 0 (feature disabled)", async () => {
    service.colonyConfig.reactionAuthorLimit = 0;
    const store = new Map<string, unknown>();
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "p1", title: "A", body: "b", author: { username: "alice" } },
        { id: "p2", title: "B", body: "b", author: { username: "alice" } },
        { id: "p3", title: "C", body: "b", author: { username: "alice" } },
        { id: "p4", title: "D", body: "b", author: { username: "alice" } },
      ],
    });
    const rt = makeRuntime(store, "REACT_FIRE");
    const c = new ColonyEngagementClient(service as never, rt, cfg());
    await c.start();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(2001);
    expect(reactPostMock.mock.calls.length).toBe(4);
    await c.stop();
  });

  it("tolerates a candidate without an author username", async () => {
    const store = new Map<string, unknown>();
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p-noauth", title: "X", body: "x" }],
    });
    const rt = makeRuntime(store, "REACT_FIRE");
    const c = new ColonyEngagementClient(service as never, rt, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(reactPostMock).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it("dry-run path still respects the cooldown", async () => {
    const store = new Map<string, unknown>();
    // Pre-seed the per-author cache with 2 recent reactions to alice
    store.set(
      `colony/engagement-client/author-reactions/${service.username}/alice`,
      [Date.now() - 1000, Date.now() - 500],
    );
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p-skip", title: "X", body: "x", author: { username: "alice" } }],
    });
    const rt = makeRuntime(store, "REACT_FIRE");
    const c = new ColonyEngagementClient(service as never, rt, cfg({ dryRun: true }));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(reactPostMock).not.toHaveBeenCalled();
    await c.stop();
  });

  it("prunes timestamps outside the window before checking", async () => {
    const store = new Map<string, unknown>();
    // Pre-seed with old timestamps that should be pruned
    store.set(
      `colony/engagement-client/author-reactions/${service.username}/alice`,
      [Date.now() - 4 * 3600_000, Date.now() - 3 * 3600_000],
    );
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p-fresh", title: "X", body: "x", author: { username: "alice" } }],
    });
    const rt = makeRuntime(store, "REACT_FIRE");
    const c = new ColonyEngagementClient(service as never, rt, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // Window is 1h, both stored entries are older — should NOT be in cooldown
    expect(reactPostMock).toHaveBeenCalledTimes(1);
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Karma trend in COLONY_STATUS
// ──────────────────────────────────────────────────────────────────────
describe("COLONY_STATUS karma trend (v0.17.0)", () => {
  function rtWithCache(service: FakeService): IAgentRuntime {
    const services = new Map<string, unknown>();
    services.set("colony", service);
    return {
      getService: vi.fn((name: string) => services.get(name) ?? null),
      getSetting: vi.fn(() => null),
      getCache: vi.fn(async () => []),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
  }

  it("renders ↗ arrow for rising karma", async () => {
    const service = fakeService();
    service.karmaHistory = [
      { ts: Date.now() - 60_000, karma: 5 },
      { ts: Date.now(), karma: 12 },
    ];
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      rtWithCache(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/Karma trend ↗ up 7/);
  });

  it("renders ↘ arrow for falling karma", async () => {
    const service = fakeService();
    service.karmaHistory = [
      { ts: Date.now() - 60_000, karma: 12 },
      { ts: Date.now(), karma: 5 },
    ];
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      rtWithCache(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/Karma trend ↘ down 7/);
  });

  it("renders → flat with held-at when karma is unchanged", async () => {
    const service = fakeService();
    service.karmaHistory = [
      { ts: Date.now() - 60_000, karma: 7 },
      { ts: Date.now(), karma: 7 },
    ];
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      rtWithCache(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/Karma trend → flat.*held at 7/);
  });

  it("falls back gracefully with single karma sample (no trend line)", async () => {
    const service = fakeService();
    service.karmaHistory = [{ ts: Date.now(), karma: 5 }];
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      rtWithCache(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).not.toContain("Karma trend");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Branch-coverage fills for v0.17.0
// ──────────────────────────────────────────────────────────────────────
describe("environment defaults on NaN input (v0.17.0)", () => {
  it("falls back to 0 for non-numeric COLONY_LLM_FAILURE_THRESHOLD", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_LLM_FAILURE_THRESHOLD: "not-a-number",
    });
    expect(loadColonyConfig(rt).llmFailureThreshold).toBe(0);
  });

  it("falls back to 10min for non-numeric COLONY_LLM_FAILURE_WINDOW_MIN", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_LLM_FAILURE_WINDOW_MIN: "abc",
    });
    expect(loadColonyConfig(rt).llmFailureWindowMs).toBe(10 * 60_000);
  });

  it("falls back to 30min for non-numeric COLONY_LLM_FAILURE_COOLDOWN_MIN", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_LLM_FAILURE_COOLDOWN_MIN: "xyz",
    });
    expect(loadColonyConfig(rt).llmFailureCooldownMs).toBe(30 * 60_000);
  });

  it("falls back to 3 for non-numeric COLONY_REACTION_AUTHOR_LIMIT", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_REACTION_AUTHOR_LIMIT: "abc",
    });
    expect(loadColonyConfig(rt).reactionAuthorLimit).toBe(3);
  });

  it("falls back to 2h for non-numeric COLONY_REACTION_AUTHOR_WINDOW_HOURS", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_REACTION_AUTHOR_WINDOW_HOURS: "xyz",
    });
    expect(loadColonyConfig(rt).reactionAuthorWindowMs).toBe(2 * 3600_000);
  });

  it("clamps llmFailureThreshold > 1 to 1", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_LLM_FAILURE_THRESHOLD: "2.5",
    });
    expect(loadColonyConfig(rt).llmFailureThreshold).toBe(1);
  });

  it("clamps negative llmFailureThreshold to 0", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_LLM_FAILURE_THRESHOLD: "-0.5",
    });
    expect(loadColonyConfig(rt).llmFailureThreshold).toBe(0);
  });
});

describe("recordAuthorReaction missing setCache (v0.17.0)", () => {
  it("is a no-op when runtime has no setCache", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.colonyConfig.reactionAuthorLimit = 5;
    service.colonyConfig.reactionAuthorWindowMs = 60_000;
    const reactPostMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).reactPost = reactPostMock;
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p1", title: "X", body: "x", author: { username: "alice" } }],
    });
    // Runtime intentionally lacks setCache for the reaction-author cache write
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "n", bio: "b", topics: ["t"], style: {} },
      useModel: vi.fn(async () => "REACT_FIRE"),
      getCache: vi.fn(async () => undefined),
      // setCache deliberately undefined
    } as unknown as IAgentRuntime;
    const c = new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
      reactionMode: true,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // Reaction still fires; the cache-write helper is a no-op
    expect(reactPostMock).toHaveBeenCalled();
    await c.stop();
    vi.useRealTimers();
  });
});
