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
});
