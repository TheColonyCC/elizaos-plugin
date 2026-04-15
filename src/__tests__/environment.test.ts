import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadColonyConfig } from "../environment.js";
import { fakeRuntime } from "./helpers.js";

describe("loadColonyConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.COLONY_API_KEY;
    delete process.env.COLONY_DEFAULT_COLONY;
    delete process.env.COLONY_FEED_LIMIT;
    delete process.env.COLONY_POLL_ENABLED;
    delete process.env.COLONY_POLL_INTERVAL_SEC;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("loads a valid config from runtime settings", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DEFAULT_COLONY: "findings",
      COLONY_FEED_LIMIT: "15",
    });
    const config = loadColonyConfig(runtime);
    expect(config).toEqual({
      apiKey: "col_abc",
      defaultColony: "findings",
      feedLimit: 15,
      pollEnabled: false,
      pollIntervalMs: 120000,
      coldStartWindowMs: 24 * 3600 * 1000,
      postEnabled: false,
      postIntervalMinMs: 5_400_000,
      postIntervalMaxMs: 10_800_000,
      postColony: "findings",
      postMaxTokens: 280,
      postTemperature: 0.9,
    });
  });

  it("parses COLONY_POST_ENABLED + interval vars", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_ENABLED: "true",
      COLONY_POST_INTERVAL_MIN_SEC: "300",
      COLONY_POST_INTERVAL_MAX_SEC: "600",
      COLONY_POST_COLONY: "findings",
      COLONY_POST_MAX_TOKENS: "400",
      COLONY_POST_TEMPERATURE: "0.7",
    });
    const config = loadColonyConfig(runtime);
    expect(config.postEnabled).toBe(true);
    expect(config.postIntervalMinMs).toBe(300_000);
    expect(config.postIntervalMaxMs).toBe(600_000);
    expect(config.postColony).toBe("findings");
    expect(config.postMaxTokens).toBe(400);
    expect(config.postTemperature).toBe(0.7);
  });

  it("clamps COLONY_POST_INTERVAL_MIN_SEC below 60 to 60", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_INTERVAL_MIN_SEC: "10",
    });
    expect(loadColonyConfig(runtime).postIntervalMinMs).toBe(60_000);
  });

  it("falls back COLONY_POST_INTERVAL_MIN_SEC to default on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_INTERVAL_MIN_SEC: "abc",
    });
    expect(loadColonyConfig(runtime).postIntervalMinMs).toBe(5_400_000);
  });

  it("falls back COLONY_POST_INTERVAL_MAX_SEC to default on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_INTERVAL_MAX_SEC: "abc",
    });
    expect(loadColonyConfig(runtime).postIntervalMaxMs).toBe(10_800_000);
  });

  it("clamps COLONY_POST_MAX_TOKENS to sane bounds", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_MAX_TOKENS: "99999",
    });
    expect(loadColonyConfig(runtime).postMaxTokens).toBe(2000);
  });

  it("falls back COLONY_POST_MAX_TOKENS on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_MAX_TOKENS: "abc",
    });
    expect(loadColonyConfig(runtime).postMaxTokens).toBe(280);
  });

  it("clamps COLONY_POST_TEMPERATURE above 2", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_TEMPERATURE: "5",
    });
    expect(loadColonyConfig(runtime).postTemperature).toBe(2);
  });

  it("falls back COLONY_POST_TEMPERATURE on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POST_TEMPERATURE: "abc",
    });
    expect(loadColonyConfig(runtime).postTemperature).toBe(0.9);
  });

  it("parses COLONY_COLD_START_WINDOW_HOURS", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_COLD_START_WINDOW_HOURS: "6",
    });
    expect(loadColonyConfig(runtime).coldStartWindowMs).toBe(6 * 3600 * 1000);
  });

  it("allows COLONY_COLD_START_WINDOW_HOURS=0 to disable the cold-start filter", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_COLD_START_WINDOW_HOURS: "0",
    });
    expect(loadColonyConfig(runtime).coldStartWindowMs).toBe(0);
  });

  it("clamps COLONY_COLD_START_WINDOW_HOURS above 720 to 720", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_COLD_START_WINDOW_HOURS: "9999",
    });
    expect(loadColonyConfig(runtime).coldStartWindowMs).toBe(720 * 3600 * 1000);
  });

  it("falls back to default cold-start when unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_COLD_START_WINDOW_HOURS: "abc",
    });
    expect(loadColonyConfig(runtime).coldStartWindowMs).toBe(24 * 3600 * 1000);
  });

  it("applies defaults when optional settings are missing", () => {
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_abc" });
    const config = loadColonyConfig(runtime);
    expect(config.defaultColony).toBe("general");
    expect(config.feedLimit).toBe(10);
    expect(config.pollEnabled).toBe(false);
    expect(config.pollIntervalMs).toBe(120000);
  });

  it("parses truthy COLONY_POLL_ENABLED values", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      const runtime = fakeRuntime(null, {
        COLONY_API_KEY: "col_abc",
        COLONY_POLL_ENABLED: v,
      });
      expect(loadColonyConfig(runtime).pollEnabled).toBe(true);
    }
  });

  it("treats non-truthy COLONY_POLL_ENABLED as false", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POLL_ENABLED: "maybe",
    });
    expect(loadColonyConfig(runtime).pollEnabled).toBe(false);
  });

  it("clamps COLONY_POLL_INTERVAL_SEC below 30 to 30 seconds", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POLL_INTERVAL_SEC: "5",
    });
    expect(loadColonyConfig(runtime).pollIntervalMs).toBe(30_000);
  });

  it("clamps COLONY_POLL_INTERVAL_SEC above 3600 to 3600 seconds", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POLL_INTERVAL_SEC: "99999",
    });
    expect(loadColonyConfig(runtime).pollIntervalMs).toBe(3_600_000);
  });

  it("falls back to default interval when unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_POLL_INTERVAL_SEC: "abc",
    });
    expect(loadColonyConfig(runtime).pollIntervalMs).toBe(120_000);
  });

  it("throws when COLONY_API_KEY is missing", () => {
    const runtime = fakeRuntime(null, {});
    expect(() => loadColonyConfig(runtime)).toThrow(/COLONY_API_KEY is required/);
  });

  it("throws when COLONY_API_KEY does not start with col_", () => {
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "jwt_eyJhbGci" });
    expect(() => loadColonyConfig(runtime)).toThrow(/must start with 'col_'/);
  });

  it("clamps feedLimit below 1 to 1", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_FEED_LIMIT: "0",
    });
    expect(loadColonyConfig(runtime).feedLimit).toBe(1);
  });

  it("clamps feedLimit above 50 to 50", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_FEED_LIMIT: "999",
    });
    expect(loadColonyConfig(runtime).feedLimit).toBe(50);
  });

  it("falls back to default feedLimit when unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_FEED_LIMIT: "not-a-number",
    });
    expect(loadColonyConfig(runtime).feedLimit).toBe(10);
  });
});
