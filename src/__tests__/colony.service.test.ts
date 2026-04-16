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
});
