import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeRuntime } from "./helpers.js";

const { mockGetMe, mockGetNotifications, ColonyClientCtor } = vi.hoisted(() => {
  const getMe = vi.fn();
  const getNotifications = vi.fn(async () => []);
  return {
    mockGetMe: getMe,
    mockGetNotifications: getNotifications,
    ColonyClientCtor: vi.fn(() => ({
      getMe,
      getNotifications,
      markNotificationRead: vi.fn(async () => undefined),
    })),
  };
});

vi.mock("@thecolony/sdk", () => ({
  ColonyClient: ColonyClientCtor,
}));

import { ColonyService } from "../services/colony.service.js";

describe("ColonyService", () => {
  beforeEach(() => {
    ColonyClientCtor.mockClear();
    mockGetMe.mockReset();
  });

  it("has the correct serviceType identifier", () => {
    expect(ColonyService.serviceType).toBe("colony");
  });

  it("start() constructs a client, calls getMe, and returns service", async () => {
    mockGetMe.mockResolvedValue({
      username: "tester",
      karma: 42,
      trust_level: { name: "Trusted" },
    });
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_xyz" });
    const service = await ColonyService.start(runtime);

    expect(ColonyClientCtor).toHaveBeenCalledWith("col_xyz");
    expect(mockGetMe).toHaveBeenCalledTimes(1);
    expect(service.colonyConfig.apiKey).toBe("col_xyz");
    expect(service.colonyConfig.defaultColony).toBe("general");
    expect(service.client).toBeDefined();
  });

  it("start() tolerates a user response missing karma and trust_level", async () => {
    mockGetMe.mockResolvedValue({ username: "newbie" });
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_abc" });
    const service = await ColonyService.start(runtime);
    expect(service.client).toBeDefined();
  });

  it("start() rethrows when getMe fails", async () => {
    mockGetMe.mockRejectedValue(new Error("unauthorized"));
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_bad" });
    await expect(ColonyService.start(runtime)).rejects.toThrow("unauthorized");
  });

  it("start() propagates loadColonyConfig errors when key is missing", async () => {
    const runtime = fakeRuntime(null, {});
    await expect(ColonyService.start(runtime)).rejects.toThrow(/COLONY_API_KEY is required/);
  });

  it("stop() resolves without error when no interaction client is running", async () => {
    mockGetMe.mockResolvedValue({ username: "tester", karma: 0 });
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_xyz" });
    const service = await ColonyService.start(runtime);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("spawns and stops an interaction client when polling is enabled", async () => {
    mockGetMe.mockResolvedValue({ username: "poller", karma: 0 });
    mockGetNotifications.mockResolvedValue([]);
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_xyz",
      COLONY_POLL_ENABLED: "true",
      COLONY_POLL_INTERVAL_SEC: "30",
    });
    const service = await ColonyService.start(runtime);
    expect(service.interactionClient).not.toBeNull();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("spawns and stops a post client when autonomous posting is enabled", async () => {
    mockGetMe.mockResolvedValue({ username: "poster", karma: 0 });
    mockGetNotifications.mockResolvedValue([]);
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_xyz",
      COLONY_POST_ENABLED: "true",
      COLONY_POST_INTERVAL_MIN_SEC: "60",
      COLONY_POST_INTERVAL_MAX_SEC: "120",
    });
    const service = await ColonyService.start(runtime);
    expect(service.postClient).not.toBeNull();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("spawns and stops an engagement client when engagement is enabled", async () => {
    mockGetMe.mockResolvedValue({ username: "engager", karma: 0 });
    mockGetNotifications.mockResolvedValue([]);
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_xyz",
      COLONY_ENGAGE_ENABLED: "true",
      COLONY_ENGAGE_INTERVAL_MIN_SEC: "60",
      COLONY_ENGAGE_INTERVAL_MAX_SEC: "120",
      COLONY_ENGAGE_COLONIES: "general,findings",
    });
    const service = await ColonyService.start(runtime);
    expect(service.engagementClient).not.toBeNull();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("capabilityDescription is set", () => {
    const s = new ColonyService();
    expect(typeof s.capabilityDescription).toBe("string");
    expect(s.capabilityDescription.length).toBeGreaterThan(0);
  });

  describe("stats counters", () => {
    it("incrementStat bumps the named key", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.incrementStat("postsCreated");
      service.incrementStat("postsCreated");
      service.incrementStat("commentsCreated");
      service.incrementStat("votesCast");
      service.incrementStat("selfCheckRejections");
      expect(service.stats.postsCreated).toBe(2);
      expect(service.stats.commentsCreated).toBe(1);
      expect(service.stats.votesCast).toBe(1);
      expect(service.stats.selfCheckRejections).toBe(1);
    });

    it("incrementStat with source=action bumps the action sub-counter (v0.14.0)", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.incrementStat("commentsCreated", "action");
      expect(service.stats.commentsCreated).toBe(1);
      expect(service.stats.commentsCreatedFromActions).toBe(1);
      expect(service.stats.commentsCreatedAutonomous).toBe(0);
    });

    it("incrementStat with source=autonomous bumps the autonomous sub-counter (v0.14.0)", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.incrementStat("postsCreated", "autonomous");
      expect(service.stats.postsCreatedAutonomous).toBe(1);
    });

    it("incrementStat without source ignores sub-counters", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.incrementStat("postsCreated");
      expect(service.stats.postsCreated).toBe(1);
      expect(service.stats.postsCreatedAutonomous).toBe(0);
      expect(service.stats.postsCreatedFromActions).toBe(0);
    });

    it("incrementStat with source for non-posts/comments keys ignores sub-counter", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.incrementStat("votesCast", "action");
      expect(service.stats.votesCast).toBe(1);
    });

    it("postApprovalRequired=true instantiates service.draftQueue (v0.14.0)", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_POST_APPROVAL: "true",
        }),
      );
      expect(service.draftQueue).not.toBeNull();
    });

    it("postApprovalRequired=false leaves service.draftQueue null (v0.14.0)", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      expect(service.draftQueue).toBeNull();
    });

    it("incrementStat ignores startedAt", async () => {
      mockGetMe.mockResolvedValue({ username: "t", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const before = service.stats.startedAt;
      service.incrementStat("startedAt");
      expect(service.stats.startedAt).toBe(before);
    });
  });

  describe("karma backoff", () => {
    it("refreshKarma returns latest karma and updates history", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 100, trust_level: { name: "Trusted" } })
        .mockResolvedValueOnce({ username: "k", karma: 95, trust_level: { name: "Trusted" } });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const karma = await service.refreshKarma();
      expect(karma).toBe(95);
      expect(service.currentKarma).toBe(95);
      expect(service.karmaHistory.length).toBe(2);
    });

    it("refreshKarma returns null on error without throwing", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 10 })
        .mockRejectedValueOnce(new Error("rate limit"));
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const karma = await service.refreshKarma();
      expect(karma).toBeNull();
    });

    it("pauses when karma drops more than threshold in window", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 50 })
        .mockResolvedValueOnce({ username: "k", karma: 35 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_KARMA_BACKOFF_DROP: "10",
        }),
      );
      await service.refreshKarma();
      expect(service.pausedUntilTs).toBeGreaterThan(Date.now());
      expect(service.isPausedForBackoff()).toBe(true);
    });

    it("does not pause when the drop is below threshold", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 50 })
        .mockResolvedValueOnce({ username: "k", karma: 45 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_KARMA_BACKOFF_DROP: "10",
        }),
      );
      await service.refreshKarma();
      expect(service.pausedUntilTs).toBe(0);
      expect(service.isPausedForBackoff()).toBe(false);
    });

    it("isPausedForBackoff clears pause after cooldown elapses", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.pausedUntilTs = Date.now() - 1000;
      expect(service.isPausedForBackoff()).toBe(false);
      expect(service.pausedUntilTs).toBe(0);
    });

    it("does not clear the pause when still in the cooldown", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const future = Date.now() + 10_000;
      service.pausedUntilTs = future;
      expect(service.isPausedForBackoff()).toBe(true);
      expect(service.pausedUntilTs).toBe(future);
    });

    it("does not re-enter pause when already paused", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 100 })
        .mockResolvedValueOnce({ username: "k", karma: 50 })
        .mockResolvedValueOnce({ username: "k", karma: 40 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      await service.refreshKarma();
      const firstPause = service.pausedUntilTs;
      await service.refreshKarma();
      // Second refreshKarma should NOT update pausedUntilTs because we're still paused
      expect(service.pausedUntilTs).toBe(firstPause);
    });

    it("maybeRefreshKarma throttles to at most once per interval", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 10 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      // First call passes (history has only startup entry)
      await service.maybeRefreshKarma(60_000);
      const after1 = service.karmaHistory.length;
      // Immediate second call is throttled
      await service.maybeRefreshKarma(60_000);
      expect(service.karmaHistory.length).toBe(after1);
    });

    it("maybeRefreshKarma refreshes when last snapshot is stale", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 10 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      // Forge an old timestamp
      service.karmaHistory = [{ ts: Date.now() - 60 * 60 * 1000, karma: 9 }];
      await service.maybeRefreshKarma(60_000);
      expect(service.karmaHistory.length).toBeGreaterThan(1);
    });

    it("updateBackoffState does nothing with fewer than 2 history entries", async () => {
      // Set a tiny window so the startup seed gets pruned before the new
      // snapshot is added — leaving history at length 1 when
      // updateBackoffState runs.
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 10 })
        .mockResolvedValueOnce({ username: "k", karma: 50 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_KARMA_BACKOFF_WINDOW_HOURS: "1",
        }),
      );
      // Force the startup entry to be ancient so the filter drops it
      service.karmaHistory = [{ ts: 0, karma: 10 }];
      await service.refreshKarma();
      // History has exactly 1 entry (new) → guard trips, no pause
      expect(service.karmaHistory.length).toBe(1);
      expect(service.pausedUntilTs).toBe(0);
    });

    it("refreshKarma defaults karma to 0 when me.karma is missing", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 5 })
        .mockResolvedValueOnce({ username: "k" }); // no karma field
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      await service.refreshKarma();
      expect(service.currentKarma).toBe(0);
    });
  });

  describe("activity log (v0.11.0)", () => {
    it("recordActivity appends to the ring with ts/type", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.recordActivity("post_created", "p1", "hello");
      expect(service.activityLog.length).toBe(1);
      expect(service.activityLog[0]!.type).toBe("post_created");
      expect(service.activityLog[0]!.target).toBe("p1");
      expect(service.activityLog[0]!.detail).toBe("hello");
      expect(service.activityLog[0]!.ts).toBeGreaterThan(0);
    });

    it("recordActivity omits optional fields when unset", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.recordActivity("backoff_triggered");
      expect(service.activityLog[0]).toMatchObject({ type: "backoff_triggered" });
      expect(service.activityLog[0]!.target).toBeUndefined();
      expect(service.activityLog[0]!.detail).toBeUndefined();
    });

    it("activity log is capped at 50 entries (oldest dropped)", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      for (let i = 0; i < 60; i++) {
        service.recordActivity("post_created", `p${i}`);
      }
      expect(service.activityLog.length).toBe(50);
      // First 10 dropped, so p10 is the oldest in the ring
      expect(service.activityLog[0]!.target).toBe("p10");
      expect(service.activityLog[49]!.target).toBe("p59");
    });

    it("records backoff_triggered activity when karma drops enough", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 100 })
        .mockResolvedValueOnce({ username: "k", karma: 50 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_KARMA_BACKOFF_DROP: "10",
        }),
      );
      await service.refreshKarma();
      const backoffEntry = service.activityLog.find((e) => e.type === "backoff_triggered");
      expect(backoffEntry).toBeDefined();
      expect(backoffEntry!.detail).toContain("−50");
    });
  });

  describe("cooldown (v0.12.0)", () => {
    it("sets pausedUntilTs and records activity", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const before = service.activityLog.length;
      const expiry = service.cooldown(30 * 60_000, "operator test");
      expect(expiry).toBeGreaterThan(Date.now());
      expect(service.isPausedForBackoff()).toBe(true);
      expect(service.activityLog.length).toBe(before + 1);
      const entry = service.activityLog[service.activityLog.length - 1]!;
      expect(entry.type).toBe("backoff_triggered");
      expect(entry.detail).toContain("operator cooldown: operator test");
    });

    it("is non-cumulative — can't shorten an existing longer pause", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const first = service.cooldown(60 * 60_000);
      const second = service.cooldown(5 * 60_000);
      expect(second).toBe(first);
      expect(service.isPausedForBackoff()).toBe(true);
    });

    it("extends pause when new cooldown is longer", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const first = service.cooldown(10 * 60_000);
      const second = service.cooldown(60 * 60_000);
      expect(second).toBeGreaterThan(first);
    });

    it("clamps negative durations to 0", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      // Negative duration → max with 0 → requested equals now → expiry remains 0 (no pause)
      const expiry = service.cooldown(-5_000);
      // now+0 === current time, pausedUntilTs stays 0 (since !(now <= 0))
      expect(expiry).toBe(service.pausedUntilTs);
    });

    it("cooldown without reason omits the reason-qualifier", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.cooldown(30 * 60_000);
      const entry = service.activityLog[service.activityLog.length - 1]!;
      expect(entry.detail).not.toContain("operator cooldown:");
    });
  });

  describe("shutdown handlers (v0.12.0)", () => {
    it("does not register signal handlers when COLONY_REGISTER_SIGNAL_HANDLERS=false", async () => {
      const before = process.listenerCount("SIGTERM");
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      expect(process.listenerCount("SIGTERM")).toBe(before);
      await service.stop();
    });

    it("registers and then cleans up SIGTERM / SIGINT listeners when enabled", async () => {
      const beforeTerm = process.listenerCount("SIGTERM");
      const beforeInt = process.listenerCount("SIGINT");
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_REGISTER_SIGNAL_HANDLERS: "true",
        }),
      );
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
      await service.stop();
      // After stop, handlers removed
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    });

    it("registerShutdownHandlers is idempotent", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_REGISTER_SIGNAL_HANDLERS: "true",
        }),
      );
      const count1 = process.listenerCount("SIGTERM");
      service.registerShutdownHandlers();
      service.registerShutdownHandlers();
      expect(process.listenerCount("SIGTERM")).toBe(count1);
      await service.stop();
    });

    it("SIGTERM handler calls service.stop when triggered", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_REGISTER_SIGNAL_HANDLERS: "true",
        }),
      );
      const stopSpy = vi.spyOn(service, "stop");
      // Fire SIGTERM — Node's process emitter synchronously invokes listeners
      process.emit("SIGTERM");
      // stopSpy should have been called by the handler
      expect(stopSpy).toHaveBeenCalled();
      // clean up listener and state
      await service.stop();
    });
  });

  describe("activity log persistence (v0.13.0)", () => {
    it("loads the ring buffer from runtime cache on start", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const existing = [
        { ts: Date.now() - 60_000, type: "post_created", target: "old-p" },
      ];
      const store = new Map<string, unknown>();
      store.set("colony/activity-log/k", existing);
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      rt.getCache = vi.fn(async (k: string) => store.get(k));
      rt.setCache = vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      });
      const service = await ColonyService.start(runtime);
      expect(service.activityLog).toEqual(existing);
    });

    it("writes on each recordActivity call", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const setCache = vi.fn(async () => undefined);
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      rt.getCache = vi.fn(async () => undefined);
      rt.setCache = setCache;
      const service = await ColonyService.start(runtime);
      service.recordActivity("post_created", "p1");
      // Give the fire-and-forget persistence time to run
      await new Promise((r) => setTimeout(r, 0));
      expect(setCache).toHaveBeenCalledWith(
        "colony/activity-log/k",
        expect.arrayContaining([expect.objectContaining({ type: "post_created" })]),
      );
    });

    it("tolerates cache load returning non-array", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      rt.getCache = vi.fn(async () => "garbage");
      rt.setCache = vi.fn();
      const service = await ColonyService.start(runtime);
      expect(service.activityLog).toEqual([]);
    });

    it("tolerates cache load throwing", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      rt.getCache = vi.fn(async () => {
        throw new Error("cache down");
      });
      rt.setCache = vi.fn();
      const service = await ColonyService.start(runtime);
      expect(service.activityLog).toEqual([]);
    });

    it("tolerates cache write throwing (fire-and-forget)", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      rt.getCache = vi.fn(async () => undefined);
      rt.setCache = vi.fn(async () => {
        throw new Error("cache down");
      });
      const service = await ColonyService.start(runtime);
      // Should not throw
      service.recordActivity("post_created", "p");
      await new Promise((r) => setTimeout(r, 0));
      expect(service.activityLog.length).toBe(1);
    });

    it("no-op when runtime lacks getCache/setCache", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      service.recordActivity("post_created", "p");
      expect(service.activityLog.length).toBe(1);
    });

    it("uses 'unknown' cache key when service has no username (v0.13.0)", async () => {
      mockGetMe.mockResolvedValue({}); // no username
      const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_a" });
      const rt = runtime as unknown as Record<string, unknown>;
      const setCache = vi.fn(async () => undefined);
      rt.getCache = vi.fn(async () => undefined);
      rt.setCache = setCache;
      const service = await ColonyService.start(runtime);
      service.recordActivity("post_created", "p");
      await new Promise((r) => setTimeout(r, 0));
      expect(setCache).toHaveBeenCalledWith(
        "colony/activity-log/unknown",
        expect.any(Array),
      );
    });
  });

  describe("rotateApiKey (v0.13.0)", () => {
    it("returns new key and rebuilds client on success", async () => {
      const rotateKey = vi.fn(async () => ({ api_key: "col_newkey" }));
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      ColonyClientCtor.mockImplementation(() => ({
        getMe: mockGetMe,
        getNotifications: mockGetNotifications,
        markNotificationRead: vi.fn(async () => undefined),
        rotateKey,
      }));
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      const newKey = await service.rotateApiKey();
      expect(newKey).toBe("col_newkey");
      expect(service.colonyConfig.apiKey).toBe("col_newkey");
      expect(rotateKey).toHaveBeenCalled();
    });

    it("returns null when rotateKey throws", async () => {
      const rotateKey = vi.fn(async () => {
        throw new Error("403");
      });
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      ColonyClientCtor.mockImplementation(() => ({
        getMe: mockGetMe,
        getNotifications: mockGetNotifications,
        markNotificationRead: vi.fn(async () => undefined),
        rotateKey,
      }));
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      expect(await service.rotateApiKey()).toBeNull();
    });

    it("returns null when rotateKey response has no api_key", async () => {
      const rotateKey = vi.fn(async () => ({}));
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      ColonyClientCtor.mockImplementation(() => ({
        getMe: mockGetMe,
        getNotifications: mockGetNotifications,
        markNotificationRead: vi.fn(async () => undefined),
        rotateKey,
      }));
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      expect(await service.rotateApiKey()).toBeNull();
    });
  });

  describe("refreshKarmaWithAutoRotate (v0.13.0)", () => {
    it("returns karma on first success", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 5 })
        .mockResolvedValueOnce({ username: "k", karma: 10 });
      const service = await ColonyService.start(
        fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
      );
      expect(await service.refreshKarmaWithAutoRotate()).toBe(10);
    });

    it("returns null without attempting rotation when autoRotateKey is false", async () => {
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 5 })
        .mockRejectedValueOnce(new Error("auth"));
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_AUTO_ROTATE_KEY: "false",
        }),
      );
      expect(await service.refreshKarmaWithAutoRotate()).toBeNull();
    });

    it("attempts rotation when autoRotateKey is true and refresh fails", async () => {
      const rotateKey = vi.fn(async () => ({ api_key: "col_new" }));
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 5 }) // startup
        .mockRejectedValueOnce(new Error("auth")) // initial refresh fails
        .mockResolvedValueOnce({ username: "k", karma: 15 }); // post-rotate refresh
      ColonyClientCtor.mockImplementation(() => ({
        getMe: mockGetMe,
        getNotifications: mockGetNotifications,
        markNotificationRead: vi.fn(async () => undefined),
        rotateKey,
      }));
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_AUTO_ROTATE_KEY: "true",
        }),
      );
      expect(await service.refreshKarmaWithAutoRotate()).toBe(15);
      expect(rotateKey).toHaveBeenCalled();
    });

    it("returns null when rotation itself fails", async () => {
      const rotateKey = vi.fn(async () => {
        throw new Error("revoked");
      });
      mockGetMe
        .mockResolvedValueOnce({ username: "k", karma: 5 })
        .mockRejectedValueOnce(new Error("auth"));
      ColonyClientCtor.mockImplementation(() => ({
        getMe: mockGetMe,
        getNotifications: mockGetNotifications,
        markNotificationRead: vi.fn(async () => undefined),
        rotateKey,
      }));
      const service = await ColonyService.start(
        fakeRuntime(null, {
          COLONY_API_KEY: "col_a",
          COLONY_AUTO_ROTATE_KEY: "true",
        }),
      );
      expect(await service.refreshKarmaWithAutoRotate()).toBeNull();
    });
  });

  describe("activity webhook (v0.13.0)", () => {
    async function flushPromises() {
      // Multiple macrotask ticks so the fire-and-forget fetch has time
      // to await its hmac compute + fetch call in full.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it("POSTs to the webhook URL on recordActivity", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const fetchSpy = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy;
      try {
        const service = await ColonyService.start(
          fakeRuntime(null, {
            COLONY_API_KEY: "col_a",
            COLONY_ACTIVITY_WEBHOOK_URL: "https://example.com/hook",
            COLONY_ACTIVITY_WEBHOOK_SECRET: "shh",
          }),
        );
        service.recordActivity("post_created", "p1", "details");
        await flushPromises();
        expect(fetchSpy).toHaveBeenCalledWith(
          "https://example.com/hook",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "Content-Type": "application/json",
              "X-Colony-Signature": expect.any(String),
            }),
          }),
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("does not POST when webhook URL is empty", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const fetchSpy = vi.fn();
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const service = await ColonyService.start(
          fakeRuntime(null, { COLONY_API_KEY: "col_a" }),
        );
        service.recordActivity("post_created", "p1");
        await flushPromises();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("swallows fetch errors", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const fetchSpy = vi.fn(async () => {
        throw new Error("network");
      });
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const service = await ColonyService.start(
          fakeRuntime(null, {
            COLONY_API_KEY: "col_a",
            COLONY_ACTIVITY_WEBHOOK_URL: "https://example.com/hook",
          }),
        );
        service.recordActivity("post_created", "p1");
        await flushPromises();
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("omits signature header when no secret configured", async () => {
      mockGetMe.mockResolvedValue({ username: "k", karma: 0 });
      const fetchSpy = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy;
      try {
        const service = await ColonyService.start(
          fakeRuntime(null, {
            COLONY_API_KEY: "col_a",
            COLONY_ACTIVITY_WEBHOOK_URL: "https://example.com/hook",
          }),
        );
        service.recordActivity("post_created", "p1");
        await flushPromises();
        const call = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
        const headers = (call![1] as { headers: Record<string, string> }).headers;
        expect(headers["X-Colony-Signature"]).toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
