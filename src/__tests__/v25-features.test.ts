/**
 * v0.25.0 — COLONY_HEALTH_REPORT action suite.
 *
 * Covers:
 *   - Validator: DM-safe (not refused from DM origin), accepts health
 *     keywords, rejects unrelated text, rejects missing service.
 *   - Handler output lines: Ollama reachability, LLM-call success rate,
 *     pause state, retry queue depth, notification-digest count,
 *     adaptive-poll multiplier, diversity watchdog peak.
 *   - DM_SAFE_ACTIONS invariant: COLONY_HEALTH_REPORT is allow-listed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import { colonyHealthReportAction } from "../actions/healthReport.js";
import { DM_SAFE_ACTIONS } from "../services/origin.js";
import {
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

// Mock the readiness helper module. Defaults to "reachable"; individual
// tests override with `mockResolvedValue(false)` to exercise the
// unreachable path.
vi.mock("../utils/readiness.js", () => ({
  isOllamaReachable: vi.fn(async () => true),
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as readiness from "../utils/readiness.js";

function taggedMessage(text: string, origin?: "dm" | "post_mention"): Memory {
  const content: Record<string, unknown> = { text };
  if (origin) content.colonyOrigin = origin;
  return { content } as unknown as Memory;
}

describe("COLONY_HEALTH_REPORT — validator", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  it("returns false when the colony service is not registered", async () => {
    const runtime = fakeRuntime(null);
    expect(
      await colonyHealthReportAction.validate(runtime, taggedMessage("are you healthy?")),
    ).toBe(false);
  });

  it("returns false for empty text", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthReportAction.validate(runtime, taggedMessage("   ")),
    ).toBe(false);
  });

  it("accepts common health-check phrasings", async () => {
    const runtime = fakeRuntime(service);
    for (const phrase of [
      "are you healthy?",
      "are you ok?",
      "run a diagnostic",
      "heartbeat check please",
      "health check colony",
    ]) {
      expect(
        await colonyHealthReportAction.validate(runtime, taggedMessage(phrase)),
      ).toBe(true);
    }
  });

  it("rejects unrelated text", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthReportAction.validate(runtime, taggedMessage("hello there")),
    ).toBe(false);
  });

  it("is DM-safe: accepts health-check DMs (not refused by origin guard)", async () => {
    const runtime = fakeRuntime(service);
    expect(
      await colonyHealthReportAction.validate(
        runtime,
        taggedMessage("are you healthy?", "dm"),
      ),
    ).toBe(true);
  });

  it("is listed in DM_SAFE_ACTIONS", () => {
    expect(DM_SAFE_ACTIONS.has("COLONY_HEALTH_REPORT")).toBe(true);
  });
});

describe("COLONY_HEALTH_REPORT — handler output", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.username = "colonist-one";
    vi.mocked(readiness.isOllamaReachable).mockReset();
    vi.mocked(readiness.isOllamaReachable).mockResolvedValue(true);
  });

  async function runHealth(): Promise<string> {
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyHealthReportAction.handler!(
      runtime,
      taggedMessage("are you healthy?"),
      fakeState(),
      {},
      cb,
    );
    return (cb.mock.calls[0]![0] as { text: string }).text;
  }

  it("opens with the agent handle", async () => {
    const text = await runHealth();
    expect(text).toContain("Health report for @colonist-one");
  });

  it("reports Ollama as reachable when the probe returns true", async () => {
    vi.mocked(readiness.isOllamaReachable).mockResolvedValue(true);
    const text = await runHealth();
    expect(text).toContain("Ollama: reachable");
  });

  it("reports Ollama as UNREACHABLE when the probe returns false", async () => {
    vi.mocked(readiness.isOllamaReachable).mockResolvedValue(false);
    const text = await runHealth();
    expect(text).toContain("Ollama: UNREACHABLE");
  });

  it("tolerates the readiness probe throwing (cloud-provider config)", async () => {
    vi.mocked(readiness.isOllamaReachable).mockRejectedValue(new Error("no endpoint"));
    const text = await runHealth();
    expect(text).toContain("Ollama: not configured");
  });

  it("reports no-LLM-activity when the call history is empty in-window", async () => {
    service.llmCallHistory = [];
    const text = await runHealth();
    expect(text).toContain("LLM calls:");
    expect(text).toContain("no activity");
  });

  it("reports LLM success rate when calls are in-window", async () => {
    const now = Date.now();
    service.llmCallHistory = [
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "failure" },
    ];
    const text = await runHealth();
    expect(text).toMatch(/LLM calls .*: 3 succeeded, 1 failed/);
  });

  it("adds a warning indicator when failure rate is high", async () => {
    const now = Date.now();
    service.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "success" },
    ];
    const text = await runHealth();
    expect(text).toContain("🔴");
  });

  it("surfaces pause state when paused", async () => {
    service.isPausedForBackoff = vi.fn(() => true);
    service.pausedUntilTs = Date.now() + 10 * 60_000;
    service.pauseReason = "llm_health";
    const text = await runHealth();
    expect(text).toContain("⏸️ Paused");
    expect(text).toContain("reason: llm_health");
  });

  it("reports 'active (not paused)' when not paused", async () => {
    service.isPausedForBackoff = vi.fn(() => false);
    const text = await runHealth();
    expect(text).toContain("Pause state: active");
  });

  it("reports empty retry queue when post-client exposes one", async () => {
    service.postClient = {
      getRetryQueue: () => [],
    } as never;
    const text = await runHealth();
    expect(text).toContain("Retry queue: empty");
  });

  it("reports retry queue contents when non-empty", async () => {
    service.postClient = {
      getRetryQueue: () => [
        { kind: "post" },
        { kind: "post" },
        { kind: "comment" },
      ],
    } as never;
    const text = await runHealth();
    expect(text).toContain("Retry queue: 3 pending");
    expect(text).toContain("2×post");
    expect(text).toContain("1×comment");
  });

  it("swallows errors from the retry queue accessor", async () => {
    service.postClient = {
      getRetryQueue: () => {
        throw new Error("queue backend down");
      },
    } as never;
    const text = await runHealth();
    // Line should be absent rather than crash — health report is non-throwing.
    expect(text).not.toContain("Retry queue:");
  });

  it("surfaces notification digest count when > 0", async () => {
    service.stats!.notificationDigestsEmitted = 5;
    const text = await runHealth();
    expect(text).toContain("Notification digests this session: 5");
  });

  it("omits the digest line when count is 0", async () => {
    service.stats!.notificationDigestsEmitted = 0;
    const text = await runHealth();
    expect(text).not.toContain("Notification digests");
  });

  it("surfaces adaptive poll multiplier when enabled", async () => {
    service.colonyConfig.adaptivePollEnabled = true;
    service.computeLlmHealthMultiplier!.mockReturnValue(2.5);
    const text = await runHealth();
    expect(text).toContain("Adaptive poll multiplier: 2.50×");
    expect(text).toContain("slowing polls under LLM stress");
  });

  it("omits the adaptive-poll line when disabled", async () => {
    service.colonyConfig.adaptivePollEnabled = false;
    const text = await runHealth();
    expect(text).not.toContain("Adaptive poll");
  });

  it("surfaces diversity watchdog peak when available", async () => {
    service.diversityWatchdog = {
      peakSimilarity: () => 0.75,
    };
    service.colonyConfig.diversityThreshold = 0.8;
    const text = await runHealth();
    expect(text).toContain("Output diversity: peak pairwise 0.75");
    expect(text).toContain("threshold 0.80");
  });

  it("adds a warning on the diversity line when peak is within 90% of threshold", async () => {
    service.diversityWatchdog = {
      peakSimilarity: () => 0.78, // 0.78 >= 0.8 * 0.9 = 0.72
    };
    service.colonyConfig.diversityThreshold = 0.8;
    const text = await runHealth();
    expect(text).toContain("⚠️");
  });

  it("tolerates a null diversity watchdog (not configured)", async () => {
    service.diversityWatchdog = null;
    const text = await runHealth();
    expect(text).not.toContain("Output diversity");
  });

  it("swallows errors from the diversity accessor", async () => {
    service.diversityWatchdog = {
      peakSimilarity: () => {
        throw new Error("ring corrupted");
      },
    };
    const text = await runHealth();
    expect(text).not.toContain("Output diversity");
  });

  it("returns early when service is not registered (non-throwing)", async () => {
    const runtime = fakeRuntime(null);
    const cb = makeCallback();
    await expect(
      colonyHealthReportAction.handler!(
        runtime,
        taggedMessage("are you healthy?"),
        fakeState(),
        {},
        cb,
      ),
    ).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles a null peak-pairwise-similarity return", async () => {
    service.diversityWatchdog = {
      peakSimilarity: () => null,
    };
    const text = await runHealth();
    expect(text).not.toContain("Output diversity");
  });

  it("returns with an 'unknown' handle when service has no username", async () => {
    service.username = undefined;
    const text = await runHealth();
    expect(text).toContain("Health report for (unknown)");
  });
});
