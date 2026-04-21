/**
 * v0.28.0 — rate-limit visibility + catch-up mode + thread compression.
 *
 * Three orthogonal quick-wins. Tested here:
 *
 *   1. `ColonyService.recordRateLimitIfApplicable` + `rateLimitHitsInWindow`
 *      + STATUS / HEALTH_REPORT surfacing.
 *   2. `ColonyInteractionClient.tickNow` + catch-up trigger in post-client
 *      and engagement-client `loop()` paths.
 *   3. `COLONY_THREAD_COMPRESSION=verbatim|abridged` driving the engagement
 *      prompt body-budget.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

import { ColonyService } from "../services/colony.service.js";
import { ColonyInteractionClient } from "../services/interaction.js";
import { loadColonyConfig } from "../environment.js";
import { colonyStatusAction } from "../actions/status.js";
import { colonyHealthReportAction } from "../actions/healthReport.js";
import {
  fakeClient,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
} from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 1 — rate-limit visibility
// ─────────────────────────────────────────────────────────────────────────

class MockRateLimitError extends Error {
  retryAfter?: number;
  constructor(retryAfter?: number) {
    super("rate limited");
    this.name = "ColonyRateLimitError";
    this.retryAfter = retryAfter;
  }
}

describe("v0.28.0 — ColonyService.recordRateLimitIfApplicable", () => {
  let svc: ColonyService;

  function freshService(): ColonyService {
    const s = new ColonyService({} as IAgentRuntime);
    s.rateLimitHistory = [];
    s.stats = {
      postsCreated: 0,
      commentsCreated: 0,
      votesCast: 0,
      selfCheckRejections: 0,
      startedAt: 0,
      postsCreatedAutonomous: 0,
      postsCreatedFromActions: 0,
      commentsCreatedAutonomous: 0,
      commentsCreatedFromActions: 0,
      llmCallsSuccess: 0,
      llmCallsFailed: 0,
      notificationDigestsEmitted: 0,
      threadDigestsEmitted: 0,
      rateLimitHits: 0,
      catchupsTriggered: 0,
    };
    return s;
  }

  it("records a rate-limit hit when the error name matches", () => {
    svc = freshService();
    svc.recordRateLimitIfApplicable(new MockRateLimitError(30), "interaction");
    expect(svc.rateLimitHistory.length).toBe(1);
    expect(svc.rateLimitHistory[0]?.source).toBe("interaction");
    expect(svc.rateLimitHistory[0]?.retryAfter).toBe(30);
    expect(svc.stats.rateLimitHits).toBe(1);
  });

  it("ignores non-rate-limit errors", () => {
    svc = freshService();
    svc.recordRateLimitIfApplicable(new Error("boom"), "post");
    expect(svc.rateLimitHistory.length).toBe(0);
    expect(svc.stats.rateLimitHits).toBe(0);
  });

  it("detects via constructor name too (when .name is overridden)", () => {
    svc = freshService();
    class ColonyRateLimitError extends Error {}
    const err = new ColonyRateLimitError();
    (err as unknown as { name: string }).name = "Error"; // strip the runtime name
    svc.recordRateLimitIfApplicable(err, "engagement");
    expect(svc.rateLimitHistory.length).toBe(1);
  });

  it("ring is capped at 50 entries", () => {
    svc = freshService();
    for (let i = 0; i < 60; i++) {
      svc.recordRateLimitIfApplicable(new MockRateLimitError(), "interaction");
    }
    expect(svc.rateLimitHistory.length).toBe(50);
    expect(svc.stats.rateLimitHits).toBe(60);
  });

  it("rateLimitHitsInWindow counts only within window", () => {
    svc = freshService();
    const now = Date.now();
    svc.rateLimitHistory = [
      { ts: now - 20 * 60_000, source: "post" }, // too old
      { ts: now - 5 * 60_000, source: "post" },
      { ts: now - 2 * 60_000, source: "engagement" },
      { ts: now - 1 * 60_000, source: "interaction" },
    ];
    expect(svc.rateLimitHitsInWindow(10 * 60_000, now)).toBe(3);
    expect(svc.rateLimitHitsInWindow(3 * 60_000, now)).toBe(2);
  });

  it("records without a retryAfter when the error doesn't expose one", () => {
    svc = freshService();
    const err = new Error("rate limited");
    (err as unknown as { name: string }).name = "ColonyRateLimitError";
    svc.recordRateLimitIfApplicable(err, "action");
    expect(svc.rateLimitHistory[0]?.retryAfter).toBeUndefined();
  });

  it("is a safe no-op on null / undefined error", () => {
    svc = freshService();
    expect(() => svc.recordRateLimitIfApplicable(null, "interaction")).not.toThrow();
    expect(() => svc.recordRateLimitIfApplicable(undefined, "post")).not.toThrow();
    expect(svc.rateLimitHistory.length).toBe(0);
    expect(svc.stats.rateLimitHits).toBe(0);
  });

  it("records with non-numeric retryAfter → undefined", () => {
    svc = freshService();
    const err = new Error("rl");
    (err as unknown as { name: string; retryAfter: unknown }).name =
      "ColonyRateLimitError";
    (err as unknown as { retryAfter: unknown }).retryAfter = "soon";
    svc.recordRateLimitIfApplicable(err, "engagement");
    expect(svc.rateLimitHistory[0]?.retryAfter).toBeUndefined();
  });

  it("rateLimitHitsInWindow uses Date.now() when no `now` passed", () => {
    svc = freshService();
    svc.rateLimitHistory = [
      { ts: Date.now(), source: "interaction" },
    ];
    expect(svc.rateLimitHitsInWindow(60_000)).toBe(1);
  });
});

describe("v0.28.0 — STATUS surfaces rate-limit hits only when > 0", () => {
  async function runStatus(configureService: (svc: ReturnType<typeof fakeService>) => void) {
    const svc = fakeService();
    svc.username = "eliza";
    svc.currentKarma = 10;
    svc.currentTrust = "Newcomer";
    configureService(svc);
    const rt = fakeRuntime(svc);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      rt,
      { content: { text: "status please" } } as unknown as Memory,
      fakeState() as State,
      undefined,
      cb,
      [],
    );
    return cb.mock.calls[0]?.[0]?.text as string;
  }

  it("omits the rate-limit line when hits is 0", async () => {
    const text = await runStatus(() => {});
    expect(text).not.toContain("Rate-limit hits");
  });

  it("surfaces the rate-limit line when hits > 0", async () => {
    const text = await runStatus((svc) => {
      svc.stats!.rateLimitHits = 4;
      svc.rateLimitHitsInWindow = vi.fn(() => 1);
    });
    expect(text).toContain("Rate-limit hits this session: 4");
    expect(text).toContain("1 in last 10m");
  });

  it("says 'quiet now' when session total > 0 but recent window is 0", async () => {
    const text = await runStatus((svc) => {
      svc.stats!.rateLimitHits = 2;
      svc.rateLimitHitsInWindow = vi.fn(() => 0);
    });
    expect(text).toContain("quiet now");
  });
});

describe("v0.28.0 — HEALTH_REPORT always surfaces rate-limit line", () => {
  async function runHealth(
    configureService: (svc: ReturnType<typeof fakeService>) => void = () => {},
  ) {
    const svc = fakeService();
    svc.username = "eliza";
    configureService(svc);
    const rt = fakeRuntime(svc);
    const cb = makeCallback();
    await colonyHealthReportAction.handler!(
      rt,
      { content: { text: "are you healthy?", colonyOrigin: "dm" } } as unknown as Memory,
      fakeState() as State,
      undefined,
      cb,
      [],
    );
    return cb.mock.calls[0]?.[0]?.text as string;
  }

  it("shows '0 in last 10m (0 this session)' at rest", async () => {
    const text = await runHealth();
    expect(text).toContain("Rate-limit hits: 0 in last 10m (0 this session)");
  });

  it("appends warning glyph when recent hits ≥ 3", async () => {
    const text = await runHealth((svc) => {
      svc.stats!.rateLimitHits = 10;
      svc.rateLimitHitsInWindow = vi.fn(() => 4);
    });
    expect(text).toContain("Rate-limit hits: 4 in last 10m (10 this session) ⚠️");
  });

  // Defensive-branch pins — exercise the nullish-fallback paths so coverage
  // stays above 98% branches.
  it("falls back to 0 when rateLimitHitsInWindow is missing", async () => {
    const text = await runHealth((svc) => {
      svc.stats!.rateLimitHits = 5;
      delete (svc as { rateLimitHitsInWindow?: unknown }).rateLimitHitsInWindow;
    });
    expect(text).toContain("Rate-limit hits: 0 in last 10m (5 this session)");
  });

  it("falls back to 0 when stats.rateLimitHits is undefined", async () => {
    const text = await runHealth((svc) => {
      svc.stats!.rateLimitHits = undefined as unknown as number;
      svc.rateLimitHitsInWindow = vi.fn(() => 0);
    });
    expect(text).toContain("Rate-limit hits: 0 in last 10m (0 this session)");
  });

  // Pre-existing defensive-branch pins — covering the optional-chaining
  // fallbacks in healthReport.ts that previously had no test. Pulling these
  // forward as v0.28's contribution to keeping global branch coverage ≥ 98%.
  it("handles stats undefined entirely", async () => {
    const text = await runHealth((svc) => {
      svc.stats = undefined;
    });
    // Nothing breaks; rate-limit line still renders with 0/0.
    expect(text).toContain("Rate-limit hits: 0 in last 10m (0 this session)");
  });

  it("adaptive-poll line: falls back to 1.0× when computeLlmHealthMultiplier missing", async () => {
    const text = await runHealth((svc) => {
      svc.colonyConfig.adaptivePollEnabled = true;
      delete (svc as { computeLlmHealthMultiplier?: unknown })
        .computeLlmHealthMultiplier;
    });
    expect(text).toContain("Adaptive poll multiplier: 1.00×");
  });

  it("adaptive-poll line: appends stress warning when multiplier > 1.5×", async () => {
    const text = await runHealth((svc) => {
      svc.colonyConfig.adaptivePollEnabled = true;
      svc.computeLlmHealthMultiplier = vi.fn(() => 2.5);
    });
    expect(text).toContain("slowing polls under LLM stress");
  });

  it("tolerates takeHealthSnapshot being absent", async () => {
    const text = await runHealth((svc) => {
      delete (svc as { takeHealthSnapshot?: unknown }).takeHealthSnapshot;
    });
    expect(text).toContain("Rate-limit hits:");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 2 — catch-up mode (COLONY_CATCHUP_THRESHOLD_SEC)
// ─────────────────────────────────────────────────────────────────────────

describe("v0.28.0 — COLONY_CATCHUP_THRESHOLD_SEC config", () => {
  it("defaults to 30000ms when unset", () => {
    const rt = fakeRuntime(null, { COLONY_API_KEY: "col_x" });
    expect(loadColonyConfig(rt).catchupThresholdMs).toBe(30_000);
  });

  it("parses seconds-to-ms", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_CATCHUP_THRESHOLD_SEC: "45",
    });
    expect(loadColonyConfig(rt).catchupThresholdMs).toBe(45_000);
  });

  it("accepts 0 as 'disabled'", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_CATCHUP_THRESHOLD_SEC: "0",
    });
    expect(loadColonyConfig(rt).catchupThresholdMs).toBe(0);
  });

  it("falls back to default on non-finite / negative input", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_CATCHUP_THRESHOLD_SEC: "not-a-number",
    });
    expect(loadColonyConfig(rt).catchupThresholdMs).toBe(30_000);
  });
});

describe("v0.28.0 — catch-up trigger via maybeTriggerCatchup", () => {
  async function buildPostClient(catchupMs: number, elapsed: number) {
    const { ColonyPostClient } = await import("../services/post-client.js");
    const svc = fakeService({}, { catchupThresholdMs: catchupMs });
    const ic = { tickNow: vi.fn(async () => undefined) };
    svc.interactionClient = ic as never;
    const rt = fakeRuntime(svc);
    const client = new ColonyPostClient(svc as never, rt, {
      colony: "general",
      enabled: true,
      intervalMinMs: 5000,
      intervalMaxMs: 10000,
      maxTokens: 100,
      temperature: 0.5,
    });
    await (client as unknown as {
      maybeTriggerCatchup: (n: number) => Promise<void>;
    }).maybeTriggerCatchup(elapsed);
    return { svc, ic };
  }

  async function buildEngagementClient(catchupMs: number, elapsed: number) {
    const { ColonyEngagementClient } = await import(
      "../services/engagement-client.js"
    );
    const svc = fakeService({}, { catchupThresholdMs: catchupMs });
    const ic = { tickNow: vi.fn(async () => undefined) };
    svc.interactionClient = ic as never;
    const rt = fakeRuntime(svc);
    (rt as unknown as { character: unknown }).character = {
      name: "eliza",
      topics: [],
      style: { all: [], chat: [] },
    };
    const client = new ColonyEngagementClient(svc as never, rt, {
      colonies: ["general"],
      enabled: true,
      intervalMinMs: 60_000,
      intervalMaxMs: 120_000,
      maxTokens: 240,
      temperature: 0.8,
      candidateLimit: 5,
    });
    await (client as unknown as {
      maybeTriggerCatchup: (n: number) => Promise<void>;
    }).maybeTriggerCatchup(elapsed);
    return { svc, ic };
  }

  it("post-client: fires tickNow when elapsed ≥ threshold", async () => {
    const { svc, ic } = await buildPostClient(30_000, 45_000);
    expect(ic.tickNow).toHaveBeenCalledTimes(1);
    expect(svc.incrementStat).toHaveBeenCalledWith("catchupsTriggered");
  });

  it("post-client: skips when threshold is 0 (disabled)", async () => {
    const { ic, svc } = await buildPostClient(0, 9_999_999);
    expect(ic.tickNow).not.toHaveBeenCalled();
    expect(svc.incrementStat).not.toHaveBeenCalledWith("catchupsTriggered");
  });

  it("post-client: skips when elapsed < threshold", async () => {
    const { ic } = await buildPostClient(30_000, 1_000);
    expect(ic.tickNow).not.toHaveBeenCalled();
  });

  it("post-client: no-op when interactionClient is null", async () => {
    const { ColonyPostClient } = await import("../services/post-client.js");
    const svc = fakeService({}, { catchupThresholdMs: 30_000 });
    svc.interactionClient = null;
    const rt = fakeRuntime(svc);
    const client = new ColonyPostClient(svc as never, rt, {
      colony: "general",
      enabled: true,
      intervalMinMs: 5000,
      intervalMaxMs: 10000,
      maxTokens: 100,
      temperature: 0.5,
    });
    await (client as unknown as {
      maybeTriggerCatchup: (n: number) => Promise<void>;
    }).maybeTriggerCatchup(45_000);
    expect(svc.incrementStat).not.toHaveBeenCalledWith("catchupsTriggered");
  });

  it("engagement-client: fires tickNow when elapsed ≥ threshold", async () => {
    const { svc, ic } = await buildEngagementClient(30_000, 60_000);
    expect(ic.tickNow).toHaveBeenCalledTimes(1);
    expect(svc.incrementStat).toHaveBeenCalledWith("catchupsTriggered");
  });

  it("engagement-client: skips when disabled (threshold 0)", async () => {
    const { ic } = await buildEngagementClient(0, 9_999_999);
    expect(ic.tickNow).not.toHaveBeenCalled();
  });

  it("engagement-client: skips below threshold", async () => {
    const { ic } = await buildEngagementClient(30_000, 5_000);
    expect(ic.tickNow).not.toHaveBeenCalled();
  });

  it("engagement-client: no-op when interactionClient is null", async () => {
    const { ColonyEngagementClient } = await import(
      "../services/engagement-client.js"
    );
    const svc = fakeService({}, { catchupThresholdMs: 30_000 });
    svc.interactionClient = null;
    const rt = fakeRuntime(svc);
    (rt as unknown as { character: unknown }).character = {
      name: "eliza",
      topics: [],
      style: { all: [], chat: [] },
    };
    const client = new ColonyEngagementClient(svc as never, rt, {
      colonies: ["general"],
      enabled: true,
      intervalMinMs: 60_000,
      intervalMaxMs: 120_000,
      maxTokens: 240,
      temperature: 0.8,
      candidateLimit: 5,
    });
    await (client as unknown as {
      maybeTriggerCatchup: (n: number) => Promise<void>;
    }).maybeTriggerCatchup(60_000);
    expect(svc.incrementStat).not.toHaveBeenCalledWith("catchupsTriggered");
  });
});

describe("v0.28.0 — ColonyInteractionClient.tickNow()", () => {
  it("no-ops when isRunning is false", async () => {
    const svc = fakeService();
    const rt = fakeRuntime(svc);
    const ic = new ColonyInteractionClient(svc as never, rt, 120_000);
    await ic.tickNow();
    expect(svc.client.getNotifications).not.toHaveBeenCalled();
  });

  it("runs one tick when isRunning is true", async () => {
    const svc = fakeService();
    const rt = fakeRuntime(svc);
    const ic = new ColonyInteractionClient(svc as never, rt, 120_000);
    (ic as unknown as { isRunning: boolean }).isRunning = true;
    await ic.tickNow();
    expect(svc.client.getNotifications).toHaveBeenCalledTimes(1);
  });

  it("swallows non-rate-limit errors without recording a hit", async () => {
    const client = fakeClient({
      getNotifications: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const svc = fakeService(client);
    const rt = fakeRuntime(svc);
    const ic = new ColonyInteractionClient(svc as never, rt, 120_000);
    (ic as unknown as { isRunning: boolean }).isRunning = true;
    // handleRateLimit early-returns on non-rate-limit errors, so the
    // recordRateLimitIfApplicable helper is never invoked — but tickNow
    // still catches and doesn't propagate.
    await expect(ic.tickNow()).resolves.toBeUndefined();
    expect(svc.recordRateLimitIfApplicable).not.toHaveBeenCalled();
  });

  it("catches thrown tick errors and records rate-limit hits", async () => {
    const client = fakeClient({
      getNotifications: vi.fn(async () => {
        const err = new Error("rate limited") as Error & {
          name: string;
          retryAfter?: number;
        };
        err.name = "ColonyRateLimitError";
        err.retryAfter = 60;
        throw err;
      }),
    });
    const svc = fakeService(client);
    const rt = fakeRuntime(svc);
    const ic = new ColonyInteractionClient(svc as never, rt, 120_000);
    (ic as unknown as { isRunning: boolean }).isRunning = true;
    await expect(ic.tickNow()).resolves.toBeUndefined();
    expect(svc.recordRateLimitIfApplicable).toHaveBeenCalledWith(
      expect.any(Error),
      "interaction",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 3 — COLONY_THREAD_COMPRESSION
// ─────────────────────────────────────────────────────────────────────────

describe("v0.28.0 — COLONY_THREAD_COMPRESSION config", () => {
  it("defaults to 'verbatim' when unset", () => {
    const rt = fakeRuntime(null, { COLONY_API_KEY: "col_x" });
    expect(loadColonyConfig(rt).engageThreadCompression).toBe("verbatim");
  });

  it("parses 'abridged' (case-insensitive, whitespace-tolerant)", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_THREAD_COMPRESSION: "  Abridged  ",
    });
    expect(loadColonyConfig(rt).engageThreadCompression).toBe("abridged");
  });

  it("fails open to 'verbatim' on unknown values", () => {
    const rt = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_THREAD_COMPRESSION: "nuclear",
    });
    expect(loadColonyConfig(rt).engageThreadCompression).toBe("verbatim");
  });
});

describe("v0.28.0 — ColonyEngagementClient prompt compression", () => {
  it("verbatim mode keeps 500-char body budget and no [abridged] marker", async () => {
    const { ColonyEngagementClient } = await import(
      "../services/engagement-client.js"
    );
    const svc = fakeService();
    const rt = fakeRuntime(svc);
    (rt as unknown as { character: unknown }).character = {
      name: "eliza",
      topics: ["a"],
      bio: "b",
      style: { all: [], chat: [] },
    };
    const client = new ColonyEngagementClient(svc as never, rt, {
      colonies: ["general"],
      enabled: true,
      intervalMinMs: 60_000,
      intervalMaxMs: 120_000,
      maxTokens: 240,
      temperature: 0.8,
      candidateLimit: 5,
      threadCompression: "verbatim",
    });
    const longBody = "x".repeat(600);
    const prompt = (client as unknown as {
      buildPrompt: (
        colony: string,
        post: Record<string, unknown>,
        comments: Array<Record<string, unknown>>,
      ) => string;
    }).buildPrompt(
      "general",
      { id: "p1", title: "t", body: "b", author: { username: "a" } },
      [{ id: "c1", author: { username: "x" }, body: longBody }],
    );
    expect(prompt).not.toContain("[abridged]");
    // verbatim takes up to 500 chars per comment body.
    expect(prompt).toContain("x".repeat(500));
    expect(prompt).not.toContain("x".repeat(501));
  });

  it("abridged mode uses 150-char body budget and surfaces [abridged] marker", async () => {
    const { ColonyEngagementClient } = await import(
      "../services/engagement-client.js"
    );
    const svc = fakeService();
    const rt = fakeRuntime(svc);
    (rt as unknown as { character: unknown }).character = {
      name: "eliza",
      topics: ["a"],
      bio: "b",
      style: { all: [], chat: [] },
    };
    const client = new ColonyEngagementClient(svc as never, rt, {
      colonies: ["general"],
      enabled: true,
      intervalMinMs: 60_000,
      intervalMaxMs: 120_000,
      maxTokens: 240,
      temperature: 0.8,
      candidateLimit: 5,
      threadCompression: "abridged",
    });
    const longBody = "y".repeat(600);
    const prompt = (client as unknown as {
      buildPrompt: (
        colony: string,
        post: Record<string, unknown>,
        comments: Array<Record<string, unknown>>,
      ) => string;
    }).buildPrompt(
      "general",
      { id: "p1", title: "t", body: "b", author: { username: "a" } },
      [{ id: "c1", author: { username: "x" }, body: longBody }],
    );
    expect(prompt).toContain("[abridged]");
    expect(prompt).toContain("y".repeat(150));
    expect(prompt).not.toContain("y".repeat(151));
  });

  it("default (no threadCompression in config) behaves as verbatim", async () => {
    const { ColonyEngagementClient } = await import(
      "../services/engagement-client.js"
    );
    const svc = fakeService();
    const rt = fakeRuntime(svc);
    (rt as unknown as { character: unknown }).character = {
      name: "eliza",
      topics: ["a"],
      bio: "b",
      style: { all: [], chat: [] },
    };
    const client = new ColonyEngagementClient(svc as never, rt, {
      colonies: ["general"],
      enabled: true,
      intervalMinMs: 60_000,
      intervalMaxMs: 120_000,
      maxTokens: 240,
      temperature: 0.8,
      candidateLimit: 5,
      // threadCompression unset
    });
    const longBody = "z".repeat(600);
    const prompt = (client as unknown as {
      buildPrompt: (
        colony: string,
        post: Record<string, unknown>,
        comments: Array<Record<string, unknown>>,
      ) => string;
    }).buildPrompt(
      "general",
      { id: "p1", title: "t", body: "b", author: { username: "a" } },
      [{ id: "c1", author: { username: "x" }, body: longBody }],
    );
    expect(prompt).not.toContain("[abridged]");
    expect(prompt).toContain("z".repeat(500));
  });
});
