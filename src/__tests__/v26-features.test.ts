/**
 * v0.26.0 — DM-safe-actions passthrough + COLONY_HEALTH_HISTORY.
 *
 * The dispatch-filter passthrough is pinned by additions to
 * `dispatch.test.ts` (it's a direct extension of the v0.19 filter so
 * lives with its original tests). This file focuses on:
 *
 *   1. `ColonyService.takeHealthSnapshot()` — snapshot capture,
 *      ring pruning, computed-field correctness.
 *   2. `COLONY_HEALTH_HISTORY` action — empty-ring no-op, formatted
 *      output, limit option, DM-safe validation.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import { ColonyService } from "../services/colony.service.js";
import { colonyHealthHistoryAction } from "../actions/healthHistory.js";
import { DM_SAFE_ACTIONS } from "../services/origin.js";
import {
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

function taggedMessage(text: string, origin?: "dm" | "post_mention"): Memory {
  const content: Record<string, unknown> = { text };
  if (origin) content.colonyOrigin = origin;
  return { content } as unknown as Memory;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. takeHealthSnapshot
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyService.takeHealthSnapshot", () => {
  let svc: ColonyService;

  beforeEach(() => {
    svc = new ColonyService({} as IAgentRuntime);
    svc.colonyConfig = {
      llmFailureWindowMs: 10 * 60_000,
    } as never;
    svc.llmCallHistory = [];
    svc.healthSnapshots = [];
    svc.stats = {
      postsCreated: 0,
      commentsCreated: 0,
      votesCast: 0,
      selfCheckRejections: 0,
      startedAt: Date.now(),
      postsCreatedAutonomous: 0,
      postsCreatedFromActions: 0,
      commentsCreatedAutonomous: 0,
      commentsCreatedFromActions: 0,
      llmCallsSuccess: 0,
      llmCallsFailed: 0,
      notificationDigestsEmitted: 0,
    };
  });

  it("captures llmSuccessPct=null with 0 calls, llmCalls=0", () => {
    svc.takeHealthSnapshot();
    expect(svc.healthSnapshots.length).toBe(1);
    const [snap] = svc.healthSnapshots;
    expect(snap!.llmSuccessPct).toBeNull();
    expect(snap!.llmCalls).toBe(0);
  });

  it("captures llmSuccessPct as a rounded percent from recent window", () => {
    const now = Date.now();
    svc.llmCallHistory = [
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "failure" },
    ];
    svc.takeHealthSnapshot(now);
    const [snap] = svc.healthSnapshots;
    expect(snap!.llmSuccessPct).toBe(75);
    expect(snap!.llmCalls).toBe(4);
  });

  it("prunes out-of-window LLM calls", () => {
    const now = Date.now();
    svc.llmCallHistory = [
      { ts: now - 20 * 60_000, outcome: "failure" },
      { ts: now - 20 * 60_000, outcome: "failure" },
      { ts: now, outcome: "success" },
    ];
    svc.takeHealthSnapshot(now);
    const [snap] = svc.healthSnapshots;
    // Only the in-window success should count.
    expect(snap!.llmCalls).toBe(1);
    expect(snap!.llmSuccessPct).toBe(100);
  });

  it("captures paused=true with reason when service is paused", () => {
    svc.pausedUntilTs = Date.now() + 60_000;
    svc.pauseReason = "llm_health";
    svc.takeHealthSnapshot();
    const [snap] = svc.healthSnapshots;
    expect(snap!.paused).toBe(true);
    expect(snap!.pauseReason).toBe("llm_health");
  });

  it("captures retryQueueSize when postClient exposes a getRetryQueue", () => {
    svc.postClient = {
      getRetryQueue: () => [{ kind: "post" }, { kind: "post" }],
    } as never;
    svc.takeHealthSnapshot();
    const [snap] = svc.healthSnapshots;
    expect(snap!.retryQueueSize).toBe(2);
  });

  it("leaves retryQueueSize null when postClient is absent", () => {
    svc.postClient = null;
    svc.takeHealthSnapshot();
    const [snap] = svc.healthSnapshots;
    expect(snap!.retryQueueSize).toBeNull();
  });

  it("swallows errors from the retry-queue accessor", () => {
    svc.postClient = {
      getRetryQueue: () => {
        throw new Error("boom");
      },
    } as never;
    expect(() => svc.takeHealthSnapshot()).not.toThrow();
    const [snap] = svc.healthSnapshots;
    expect(snap!.retryQueueSize).toBeNull();
  });

  it("captures digestsEmitted from stats", () => {
    svc.stats.notificationDigestsEmitted = 17;
    svc.takeHealthSnapshot();
    const [snap] = svc.healthSnapshots;
    expect(snap!.digestsEmitted).toBe(17);
  });

  it("caps ring at 50 entries — oldest pruned", () => {
    const base = Date.now() - 1000;
    for (let i = 0; i < 60; i++) {
      svc.takeHealthSnapshot(base + i);
    }
    expect(svc.healthSnapshots.length).toBe(50);
    // First entry should be the 11th sample (i=10), timestamp base+10
    expect(svc.healthSnapshots[0]!.ts).toBe(base + 10);
    expect(svc.healthSnapshots[49]!.ts).toBe(base + 59);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. COLONY_HEALTH_HISTORY action
// ─────────────────────────────────────────────────────────────────────────

describe("COLONY_HEALTH_HISTORY — validator", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  it("returns false when colony service not registered", async () => {
    const runtime = fakeRuntime(null);
    expect(
      await colonyHealthHistoryAction.validate(runtime, taggedMessage("health history")),
    ).toBe(false);
  });

  it("accepts 'health history' phrasing", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(runtime, taggedMessage("show colony health history")),
    ).toBe(true);
  });

  it("accepts 'health trend' phrasing", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(runtime, taggedMessage("colony health trend please")),
    ).toBe(true);
  });

  it("rejects 'history' alone (must mention health)", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(runtime, taggedMessage("show me your post history")),
    ).toBe(false);
  });

  it("is DM-safe: accepts even with DM origin", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(
        runtime,
        taggedMessage("colony health history", "dm"),
      ),
    ).toBe(true);
  });

  it("is listed in DM_SAFE_ACTIONS", () => {
    expect(DM_SAFE_ACTIONS.has("COLONY_HEALTH_HISTORY")).toBe(true);
  });

  it("returns false for empty text", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(runtime, taggedMessage("   ")),
    ).toBe(false);
  });
});

describe("COLONY_HEALTH_HISTORY — handler", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.username = "colonist-one";
  });

  async function runHistory(opts: Record<string, unknown> = {}): Promise<string> {
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyHealthHistoryAction.handler!(
      runtime,
      taggedMessage("colony health history"),
      fakeState(),
      opts,
      cb,
    );
    return (cb.mock.calls[0]![0] as { text: string }).text;
  }

  it("reports empty ring when no snapshots yet", async () => {
    service.healthSnapshots = [];
    const text = await runHistory();
    expect(text).toContain("No health snapshots yet");
  });

  it("formats recent snapshots with timestamp + LLM rate + pause + retry + digests", async () => {
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T10:00:00Z"),
        llmSuccessPct: 100,
        llmCalls: 14,
        paused: false,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      },
      {
        ts: Date.parse("2026-04-19T10:30:00Z"),
        llmSuccessPct: 80,
        llmCalls: 20,
        paused: false,
        pauseReason: null,
        retryQueueSize: 2,
        digestsEmitted: 3,
      },
    ];
    const text = await runHistory();
    expect(text).toContain("Health history for @colonist-one");
    expect(text).toContain("2026-04-19 10:00");
    expect(text).toContain("LLM 100% (14 calls)");
    expect(text).toContain("LLM 80% (20 calls)");
    expect(text).toContain("retry 2");
    expect(text).toContain("3 digests");
    expect(text).toContain("active");
  });

  it("shows 'LLM idle' when snapshot had 0 calls in window", async () => {
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T09:00:00Z"),
        llmSuccessPct: null,
        llmCalls: 0,
        paused: false,
        pauseReason: null,
        retryQueueSize: null,
        digestsEmitted: 0,
      },
    ];
    const text = await runHistory();
    expect(text).toContain("LLM idle");
    expect(text).not.toContain("retry");
  });

  it("surfaces pause state + reason in the history line", async () => {
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T09:30:00Z"),
        llmSuccessPct: 0,
        llmCalls: 5,
        paused: true,
        pauseReason: "llm_health",
        retryQueueSize: 0,
        digestsEmitted: 0,
      },
    ];
    const text = await runHistory();
    expect(text).toContain("⏸️ llm_health");
  });

  it("limits output to N entries when options.limit is supplied", async () => {
    service.healthSnapshots = [];
    for (let i = 0; i < 12; i++) {
      service.healthSnapshots.push({
        ts: Date.parse("2026-04-19T09:00:00Z") + i * 60_000,
        llmSuccessPct: 100,
        llmCalls: 5,
        paused: false,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      });
    }
    const text = await runHistory({ limit: 3 });
    const lineCount = text.split("\n").length;
    // 1 header + 3 entries
    expect(lineCount).toBe(4);
    expect(text).toContain("last 3 of 12 snapshots");
  });

  it("clamps limit to [1, 50]", async () => {
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T09:00:00Z"),
        llmSuccessPct: 100,
        llmCalls: 1,
        paused: false,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      },
    ];
    // limit: 999 → clamped to 50, only 1 snapshot exists
    const text = await runHistory({ limit: 999 });
    expect(text).toContain("last 1 of 1 snapshots");
  });

  it("returns early when service is null", async () => {
    const runtime = fakeRuntime(null);
    const cb = makeCallback();
    await expect(
      colonyHealthHistoryAction.handler!(
        runtime,
        taggedMessage("colony health history"),
        fakeState(),
        {},
        cb,
      ),
    ).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("uses (unknown) handle when service has no username", async () => {
    service.username = undefined;
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T09:00:00Z"),
        llmSuccessPct: 100,
        llmCalls: 1,
        paused: false,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      },
    ];
    const text = await runHistory();
    expect(text).toContain("Health history for (unknown)");
  });

  it("falls back limit to 10 when options.limit is not a finite number", async () => {
    service.healthSnapshots = [];
    for (let i = 0; i < 15; i++) {
      service.healthSnapshots.push({
        ts: Date.parse("2026-04-19T09:00:00Z") + i * 60_000,
        llmSuccessPct: 100,
        llmCalls: 5,
        paused: false,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      });
    }
    const text = await runHistory({ limit: "notanumber" });
    expect(text).toContain("last 10 of 15 snapshots");
  });

  it("falls back to 'paused' label when pauseReason is null", async () => {
    service.healthSnapshots = [
      {
        ts: Date.parse("2026-04-19T09:30:00Z"),
        llmSuccessPct: 100,
        llmCalls: 5,
        paused: true,
        pauseReason: null,
        retryQueueSize: 0,
        digestsEmitted: 0,
      },
    ];
    const text = await runHistory();
    expect(text).toContain("⏸️ paused");
  });

  it("tolerates service without healthSnapshots field (?? [] fallback)", async () => {
    // remove the field entirely — simulates a stripped-down mock
    service.healthSnapshots = undefined as never;
    const text = await runHistory();
    expect(text).toContain("No health snapshots yet");
  });
});

describe("COLONY_HEALTH_HISTORY — validator short-circuits", () => {
  it("short-circuits on keyword-hit without evaluating regex", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    // "health history" is a keyword; phrase is crafted so the regex
    // would ALSO match — but this pins the `keywordHit || regexHit`
    // left-arm path explicitly.
    const ok = await colonyHealthHistoryAction.validate(
      runtime,
      taggedMessage("health history check"),
    );
    expect(ok).toBe(true);
  });

  it("requires 'health' in text even when other trend keywords present", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthHistoryAction.validate(
        runtime,
        taggedMessage("show me the trend over time"),
      ),
    ).toBe(false);
  });

  it("missing content.text field is handled via ?? '' fallback", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    const msg = { content: {} } as unknown as Memory;
    expect(
      await colonyHealthHistoryAction.validate(runtime, msg),
    ).toBe(false);
  });
});

describe("COLONY_HEALTH_REPORT — diversity threshold fallback", () => {
  it("falls back to 0.8 threshold when config doesn't set diversityThreshold", async () => {
    const { colonyHealthReportAction } = await import("../actions/healthReport.js");
    const service = fakeService();
    service.username = "colonist-one";
    service.diversityWatchdog = {
      peakSimilarity: () => 0.6,
    };
    // clear the default threshold to force fallback
    service.colonyConfig.diversityThreshold = undefined as never;
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyHealthReportAction.handler!(
      runtime,
      taggedMessage("are you healthy?"),
      fakeState(),
      {},
      cb,
    );
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    // 0.6 against fallback 0.8 — below warn zone (0.72), no ⚠️ bit on this line
    expect(text).toContain("threshold 0.80");
  });
});
