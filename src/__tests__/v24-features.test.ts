/**
 * v0.24.0 — operator-ergonomics completion suite.
 *
 * Two features:
 *
 *   1. `ColonyPostClient.tickNow()` — out-of-band tick for the
 *      post-client (mirroring v0.23's engagement-client tickNow).
 *      Wired to a SIGUSR2 handler in `ColonyService.registerShutdownHandlers`.
 *   2. `COLONY_DIAGNOSTICS` surfaces the v0.22 notification-router +
 *      v0.23 adaptive-poll + v0.23 DM-karma-gate signals that had
 *      previously only been in `COLONY_STATUS`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import { ColonyService } from "../services/colony.service.js";
import { colonyDiagnosticsAction } from "../actions/diagnostics.js";

import {
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// 1. ColonyPostClient.tickNow
// ─────────────────────────────────────────────────────────────────────────

function postConfig(overrides: Record<string, unknown> = {}) {
  return {
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colony: "general",
    maxTokens: 280,
    temperature: 0.9,
    selfCheck: false,
    retryQueueEnabled: false,
    ...overrides,
  };
}

describe("ColonyPostClient.tickNow", () => {
  it("invokes tick() and resolves even when tick throws", async () => {
    const { ColonyPostClient } = await import("../services/post-client.js");
    const svc = fakeService();
    const runtime = fakeRuntime(svc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ColonyPostClient(svc as any, runtime, postConfig() as never);
    // Force an internal throw
    (client as unknown as { tick: () => Promise<void> }).tick = vi.fn(async () => {
      throw new Error("ollama offline");
    });
    await expect(client.tickNow()).resolves.toBeUndefined();
  });

  it("resolves cleanly when the tick path is a no-op", async () => {
    const { ColonyPostClient } = await import("../services/post-client.js");
    const svc = fakeService();
    svc.isPausedForBackoff = vi.fn(() => true); // forces tick to return early
    const runtime = fakeRuntime(svc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ColonyPostClient(svc as any, runtime, postConfig() as never);
    await expect(client.tickNow()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. SIGUSR2 post-nudge handler
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyService — SIGUSR2 post-nudge handler registration", () => {
  let svc: ColonyService;

  beforeEach(() => {
    svc = new ColonyService({} as IAgentRuntime);
    svc.colonyConfig = {} as never;
  });

  afterEach(() => {
    // @ts-expect-error private access for test cleanup
    svc.unregisterShutdownHandlers();
  });

  it("registerShutdownHandlers adds SIGUSR2 alongside SIGUSR1 + shutdown signals", () => {
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const sigs = svc.signalHandlersRegistered.map((h) => h.sig);
    expect(sigs).toEqual(expect.arrayContaining(["SIGTERM", "SIGINT", "SIGUSR1", "SIGUSR2"]));
  });

  it("SIGUSR2 handler no-ops when post client isn't running", () => {
    svc.postClient = null;
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const entry = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR2");
    expect(entry).toBeTruthy();
    expect(() => entry!.handler()).not.toThrow();
  });

  it("SIGUSR2 handler calls postClient.tickNow when post client is present", () => {
    const tickNow = vi.fn(async () => undefined);
    svc.postClient = { tickNow } as never;
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const entry = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR2");
    entry!.handler();
    expect(tickNow).toHaveBeenCalled();
  });

  it("SIGUSR1 and SIGUSR2 are independent — one firing doesn't invoke the other's client", () => {
    const postTick = vi.fn(async () => undefined);
    const engageTick = vi.fn(async () => undefined);
    svc.postClient = { tickNow: postTick } as never;
    svc.engagementClient = { tickNow: engageTick } as never;
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const usr1 = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR1");
    // @ts-expect-error private access
    const usr2 = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR2");

    usr1!.handler();
    expect(engageTick).toHaveBeenCalledTimes(1);
    expect(postTick).toHaveBeenCalledTimes(0);

    usr2!.handler();
    expect(engageTick).toHaveBeenCalledTimes(1);
    expect(postTick).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. COLONY_DIAGNOSTICS surfaces v0.22 / v0.23 signals
// ─────────────────────────────────────────────────────────────────────────

describe("COLONY_DIAGNOSTICS — v0.22 / v0.23 metrics surfacing (v0.24)", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.username = "colonist-one";
    service.currentKarma = 100;
    service.currentTrust = "Trusted";
  });

  async function runDiagnostics(): Promise<string> {
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyDiagnosticsAction.handler!(
      runtime,
      { content: { text: "colony diagnostics" } } as Memory,
      fakeState(),
      {},
      cb,
    );
    return (cb.mock.calls[0]![0] as { text: string }).text;
  }

  it("surfaces notification digest count", async () => {
    service.stats!.notificationDigestsEmitted = 12;
    const text = await runDiagnostics();
    expect(text).toContain("Notification digests emitted: 12");
  });

  it("shows the default-policy fallback line when the policy map is empty", async () => {
    service.colonyConfig.notificationPolicy = new Map();
    const text = await runDiagnostics();
    expect(text).toContain("Notification policy: (default");
  });

  it("lists explicit policy entries when the map is non-empty", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce"],
      ["follow", "drop"],
    ]);
    const text = await runDiagnostics();
    expect(text).toContain("Notification policy: vote:coalesce, follow:drop");
  });

  it("surfaces adaptive poll metrics when enabled (even at 1.0×)", async () => {
    service.colonyConfig.adaptivePollEnabled = true;
    service.colonyConfig.adaptivePollMaxMultiplier = 4.0;
    service.colonyConfig.adaptivePollWarnThreshold = 0.25;
    service.colonyConfig.pollIntervalMs = 120_000;
    service.computeLlmHealthMultiplier!.mockReturnValue(2.0);
    const text = await runDiagnostics();
    expect(text).toContain("Adaptive poll: 2.00×");
    expect(text).toContain("effective 240s vs base 120s");
    expect(text).toContain("max 4.0×");
    expect(text).toContain("warn @25%");
  });

  it("shows 'Adaptive poll: disabled' when the feature is off", async () => {
    service.colonyConfig.adaptivePollEnabled = false;
    const text = await runDiagnostics();
    expect(text).toContain("Adaptive poll: disabled");
  });

  it("surfaces the DM karma gate threshold when > 0", async () => {
    service.colonyConfig.dmMinKarma = 5;
    const text = await runDiagnostics();
    expect(text).toContain("DM karma gate: ≥ 5 required");
  });

  it("omits the DM karma gate line when dmMinKarma is 0 (default)", async () => {
    service.colonyConfig.dmMinKarma = 0;
    const text = await runDiagnostics();
    expect(text).not.toContain("DM karma gate");
  });
});
