/**
 * v0.23.0 — operator control + runtime adaptation suite.
 *
 * Four features covered:
 *
 *   1. `ColonyService.computeLlmHealthMultiplier()` — graded poll
 *      multiplier derived from the v0.17 sliding LLM-call window.
 *   2. `ColonyInteractionClient.currentInterval()` consumes the
 *      multiplier when `adaptivePollEnabled` is true.
 *   3. `ColonyEngagementClient.tickNow()` runs an out-of-band tick and
 *      swallows errors (used by the SIGUSR1 nudge handler).
 *   4. `ColonyInteractionClient.processConversation()` drops low-karma
 *      DMs when `dmMinKarma > 0` (v0.23 DM gate).
 *   5. `COLONY_STATUS` surfaces notification-digest / router-policy /
 *      adaptive-poll metrics.
 *
 * Signal-handler registration is smoke-tested by importing and
 * invoking the constructor-adjacent logic — we don't actually fire
 * process signals from the test runner.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import { ColonyService } from "../services/colony.service.js";
import { ColonyInteractionClient } from "../services/interaction.js";
import { colonyStatusAction } from "../actions/status.js";

import {
  fakeClient,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// 0. Environment parsing for v0.23 config vars
// ─────────────────────────────────────────────────────────────────────────

describe("loadColonyConfig — v0.23 config parsing", () => {
  it("falls back adaptivePollMaxMultiplier to 4.0 on unparseable input", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_MAX_MULTIPLIER: "not-a-number",
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.adaptivePollMaxMultiplier).toBe(4.0);
  });

  it("clamps adaptivePollMaxMultiplier to [1.0, 20.0]", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const hi = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_MAX_MULTIPLIER: "100",
    }));
    expect(hi.adaptivePollMaxMultiplier).toBe(20.0);
    const lo = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_MAX_MULTIPLIER: "0.1",
    }));
    expect(lo.adaptivePollMaxMultiplier).toBe(1.0);
  });

  it("falls back adaptivePollWarnThreshold to 0.25 on unparseable input", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_WARN_THRESHOLD: "garbage",
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.adaptivePollWarnThreshold).toBe(0.25);
  });

  it("clamps adaptivePollWarnThreshold to [0, 0.99]", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const hi = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_WARN_THRESHOLD: "5",
    }));
    expect(hi.adaptivePollWarnThreshold).toBe(0.99);
    const lo = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_ADAPTIVE_POLL_WARN_THRESHOLD: "-0.5",
    }));
    expect(lo.adaptivePollWarnThreshold).toBe(0);
  });

  it("falls back dmMinKarma to 0 on unparseable input or negative values", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const garbage = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_DM_MIN_KARMA: "not-a-number",
    }));
    expect(garbage.dmMinKarma).toBe(0);
    const negative = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_DM_MIN_KARMA: "-5",
    }));
    expect(negative.dmMinKarma).toBe(0);
  });

  it("accepts a positive dmMinKarma", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    const cfg = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_x",
      COLONY_DM_MIN_KARMA: "10",
    }));
    expect(cfg.dmMinKarma).toBe(10);
  });

  it("accepts adaptivePollEnabled aliases (true/1/yes)", async () => {
    const { loadColonyConfig } = await import("../environment.js");
    for (const v of ["true", "1", "yes", "TRUE", "Yes"]) {
      const cfg = loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_x",
        COLONY_ADAPTIVE_POLL_ENABLED: v,
      }));
      expect(cfg.adaptivePollEnabled).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 1. computeLlmHealthMultiplier
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyService.computeLlmHealthMultiplier", () => {
  let svc: ColonyService;

  beforeEach(() => {
    svc = new ColonyService({} as IAgentRuntime);
    svc.colonyConfig = {
      adaptivePollEnabled: true,
      adaptivePollMaxMultiplier: 4.0,
      adaptivePollWarnThreshold: 0.25,
      llmFailureWindowMs: 10 * 60_000,
    } as never;
    svc.llmCallHistory = [];
  });

  it("returns 1.0 when disabled", () => {
    svc.colonyConfig = {
      ...svc.colonyConfig,
      adaptivePollEnabled: false,
    } as never;
    expect(svc.computeLlmHealthMultiplier()).toBe(1.0);
  });

  it("returns 1.0 with fewer than 3 samples (small-sample guard)", () => {
    const now = Date.now();
    svc.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
    ];
    expect(svc.computeLlmHealthMultiplier(now)).toBe(1.0);
  });

  it("returns 1.0 when failure rate is at or below warnThreshold", () => {
    const now = Date.now();
    // 1 failure in 4 calls = 25% exactly — at the threshold, no slowdown
    svc.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
    ];
    expect(svc.computeLlmHealthMultiplier(now)).toBe(1.0);
  });

  it("scales linearly between warnThreshold and 1.0", () => {
    const now = Date.now();
    // 50% failure with warn=0.25 and max=4 → 1 + 3 * (0.5-0.25)/0.75 = 2.0
    svc.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
    ];
    const m = svc.computeLlmHealthMultiplier(now);
    expect(m).toBeCloseTo(2.0, 5);
  });

  it("hits max multiplier at 100% failure rate", () => {
    const now = Date.now();
    svc.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
    ];
    expect(svc.computeLlmHealthMultiplier(now)).toBe(4.0);
  });

  it("prunes samples outside the sliding window", () => {
    const now = Date.now();
    const tenMin = 10 * 60_000;
    // Three failures from BEFORE the window — should be ignored
    svc.llmCallHistory = [
      { ts: now - tenMin * 2, outcome: "failure" },
      { ts: now - tenMin * 2, outcome: "failure" },
      { ts: now - tenMin * 2, outcome: "failure" },
      { ts: now, outcome: "success" },
      { ts: now, outcome: "success" },
    ];
    // Only 2 in-window samples → small-sample guard → 1.0
    expect(svc.computeLlmHealthMultiplier(now)).toBe(1.0);
  });

  it("handles warnThreshold=0.99 without division-by-zero", () => {
    svc.colonyConfig = {
      ...svc.colonyConfig,
      adaptivePollWarnThreshold: 0.99,
    } as never;
    const now = Date.now();
    svc.llmCallHistory = [
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
      { ts: now, outcome: "failure" },
    ];
    // rate=1.0, warn=0.99, span=0.01, fraction=(1-0.99)/0.01=1.0 → max
    expect(svc.computeLlmHealthMultiplier(now)).toBe(4.0);
  });

  it("defaults `now` to Date.now() when not supplied", () => {
    svc.llmCallHistory = [
      { ts: Date.now(), outcome: "failure" },
      { ts: Date.now(), outcome: "failure" },
      { ts: Date.now(), outcome: "failure" },
    ];
    expect(svc.computeLlmHealthMultiplier()).toBe(4.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. currentInterval() consumes the multiplier
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyInteractionClient.currentInterval — adaptive poll wiring", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  it("multiplies poll interval by service.computeLlmHealthMultiplier()", async () => {
    service.computeLlmHealthMultiplier!.mockReturnValue(2.5);
    const runtime = fakeRuntime(service);
    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    // Private method — tested via a sanity reach-in. There is no public
    // accessor and we don't want to expose one just for tests.
    const effective = (client as unknown as { currentInterval: () => number }).currentInterval();
    expect(effective).toBe(60_000 * 2.5);
    expect(service.computeLlmHealthMultiplier).toHaveBeenCalled();
  });

  it("falls back to 1× when computeLlmHealthMultiplier returns 1.0 (default)", () => {
    // fakeService stubs it to 1.0
    const runtime = fakeRuntime(service);
    const client = new ColonyInteractionClient(service as never, runtime, 60_000);
    const effective = (client as unknown as { currentInterval: () => number }).currentInterval();
    expect(effective).toBe(60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. engagement-client tickNow()
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyEngagementClient.tickNow", () => {
  it("invokes tick() and resolves even when tick throws", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    // Build a minimal service-like shape
    const svc = fakeService();
    svc.colonyConfig.engageColonies = ["general"];
    const runtime = fakeRuntime(svc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ColonyEngagementClient(svc as any, runtime, {
      colonies: [], // empty triggers early return inside tick
    } as never);
    await expect(client.tickNow()).resolves.toBeUndefined();
  });

  it("swallows tick errors instead of propagating them to the signal caller", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const svc = fakeService();
    const runtime = fakeRuntime(svc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ColonyEngagementClient(svc as any, runtime, {
      colonies: ["general"],
    } as never);
    // Force an internal throw by stubbing out the private tick
    (client as unknown as { tick: () => Promise<void> }).tick = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(client.tickNow()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. DM karma gate
// ─────────────────────────────────────────────────────────────────────────

interface TickRuntime extends IAgentRuntime {
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

function mockDmRuntime(): TickRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000099",
    getMemoryById: vi.fn(async () => null),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    messageService: {
      handleMessage: vi.fn(async () => ({})),
    },
  } as unknown as TickRuntime;
}

function convoWithMessage(fromUsername: string, body: string) {
  return {
    id: "conv-1",
    other_user: { username: fromUsername },
    unread_count: 1,
    last_message_preview: body,
  };
}

function conversationDetail(fromUsername: string, body: string) {
  return {
    id: "conv-1",
    other_user: { username: fromUsername },
    messages: [
      { id: "m1", sender: { username: fromUsername }, body, is_read: false },
    ],
  };
}

describe("ColonyInteractionClient — DM karma gate (v0.23)", () => {
  let service: FakeService;
  let runtime: TickRuntime;
  let client: ColonyInteractionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockDmRuntime();
    client = new ColonyInteractionClient(service as never, runtime, 60_000);
    service.client.getNotifications.mockResolvedValue([]);
    service.client.listConversations.mockResolvedValue([convoWithMessage("lowkarma", "hey")]);
    service.client.getConversation.mockResolvedValue(conversationDetail("lowkarma", "hey"));
    // client.getUser default not set — needs per-test config
    service.client.markNotificationRead.mockResolvedValue(undefined);
    // markConversationRead used by the gate
    (service.client as unknown as { markConversationRead: ReturnType<typeof vi.fn> }).markConversationRead = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it("allows DM through when dmMinKarma=0 (default)", async () => {
    service.colonyConfig.dmMinKarma = 0;
    service.client.getUser.mockResolvedValue({ karma: 0 });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
  });

  it("drops DM when sender karma < dmMinKarma", async () => {
    service.colonyConfig.dmMinKarma = 10;
    service.client.getUser.mockResolvedValue({ karma: 4 });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
    expect(service.recordActivity).toHaveBeenCalledWith(
      "self_check_rejection",
      "lowkarma",
      expect.stringContaining("dm_karma_gate"),
    );
    expect((service.client as unknown as { markConversationRead: ReturnType<typeof vi.fn> }).markConversationRead)
      .toHaveBeenCalledWith("lowkarma");
  });

  it("allows DM when sender karma meets exactly the threshold", async () => {
    service.colonyConfig.dmMinKarma = 10;
    service.client.getUser.mockResolvedValue({ karma: 10 });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
  });

  it("fails open when getUser throws — fetchUserKarma returns null, gate skips", async () => {
    service.colonyConfig.dmMinKarma = 10;
    service.client.getUser.mockRejectedValue(new Error("offline"));
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
  });

  it("swallows markConversationRead failure during a gate drop", async () => {
    service.colonyConfig.dmMinKarma = 10;
    service.client.getUser.mockResolvedValue({ karma: 1 });
    (service.client as unknown as { markConversationRead: ReturnType<typeof vi.fn> }).markConversationRead = vi.fn(async () => {
      throw new Error("read-mark failed");
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.messageService!.handleMessage).not.toHaveBeenCalled();
    // No throw, no unhandled rejection — the gate dropped cleanly.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. COLONY_STATUS surfaces router + adaptive-poll metrics
// ─────────────────────────────────────────────────────────────────────────

describe("COLONY_STATUS — v0.23 metrics surfacing", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.username = "colonist-one";
    service.currentKarma = 100;
    service.currentTrust = "Trusted";
  });

  it("does not surface notification policy when the map is empty", async () => {
    service.colonyConfig.notificationPolicy = new Map();
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain("Notification policy");
  });

  it("surfaces the policy map when non-empty", async () => {
    service.colonyConfig.notificationPolicy = new Map([
      ["vote", "coalesce"],
      ["follow", "drop"],
    ]);
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("Notification policy: vote:coalesce, follow:drop");
  });

  it("surfaces digest count when > 0", async () => {
    service.stats!.notificationDigestsEmitted = 7;
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("Notification digests emitted: 7");
  });

  it("does NOT surface digest count when still 0", async () => {
    service.stats!.notificationDigestsEmitted = 0;
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain("Notification digests");
  });

  it("surfaces adaptive-poll multiplier when enabled (even at 1.0×)", async () => {
    service.colonyConfig.adaptivePollEnabled = true;
    service.colonyConfig.pollIntervalMs = 120_000;
    service.computeLlmHealthMultiplier!.mockReturnValue(1.5);
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).toContain("Adaptive poll: 1.50×");
    expect(text).toContain("effective interval 180s");
  });

  it("does NOT surface adaptive-poll when disabled", async () => {
    service.colonyConfig.adaptivePollEnabled = false;
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(runtime, { content: { text: "colony status" } } as Memory, fakeState(), {}, cb);
    const text = (cb.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain("Adaptive poll");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. SIGUSR1 nudge handler — smoke test
// ─────────────────────────────────────────────────────────────────────────

describe("ColonyService — SIGUSR1 nudge handler registration", () => {
  let svc: ColonyService;

  beforeEach(() => {
    svc = new ColonyService({} as IAgentRuntime);
    svc.colonyConfig = {} as never;
  });

  afterEach(() => {
    // @ts-expect-error private access for test cleanup
    svc.unregisterShutdownHandlers();
  });

  it("registerShutdownHandlers adds SIGUSR1 alongside SIGTERM/SIGINT", () => {
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const sigs = svc.signalHandlersRegistered.map((h) => h.sig);
    expect(sigs).toEqual(expect.arrayContaining(["SIGTERM", "SIGINT", "SIGUSR1"]));
  });

  it("SIGUSR1 handler no-ops when engagement client isn't running", () => {
    svc.engagementClient = null;
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const nudgeEntry = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR1");
    expect(nudgeEntry).toBeTruthy();
    // Invoking with no engagement client should not throw
    expect(() => nudgeEntry!.handler()).not.toThrow();
  });

  it("SIGUSR1 handler calls tickNow when engagement client is present", () => {
    const tickNow = vi.fn(async () => undefined);
    svc.engagementClient = { tickNow } as never;
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    const nudgeEntry = svc.signalHandlersRegistered.find((h) => h.sig === "SIGUSR1");
    nudgeEntry!.handler();
    expect(tickNow).toHaveBeenCalled();
  });

  it("registerShutdownHandlers is idempotent", () => {
    svc.registerShutdownHandlers();
    svc.registerShutdownHandlers();
    // @ts-expect-error private access
    expect(svc.signalHandlersRegistered.length).toBe(3);
  });
});
