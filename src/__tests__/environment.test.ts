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
      notificationTypesIgnore: new Set(["vote", "follow", "award", "tip_received"]),
      dryRun: false,
      postEnabled: false,
      postIntervalMinMs: 5_400_000,
      postIntervalMaxMs: 10_800_000,
      postColony: "findings",
      postMaxTokens: 280,
      postTemperature: 0.9,
      postStyleHint: "",
      postRecentTopicMemory: true,
      engageEnabled: false,
      engageIntervalMinMs: 1_800_000,
      engageIntervalMaxMs: 3_600_000,
      engageColonies: ["findings"],
      engageCandidateLimit: 5,
      engageMaxTokens: 240,
      engageTemperature: 0.8,
      engageStyleHint: "",
      selfCheckEnabled: true,
      postDailyLimit: 24,
      karmaBackoffDrop: 10,
      karmaBackoffWindowMs: 6 * 3600 * 1000,
      karmaBackoffCooldownMs: 120 * 60 * 1000,
    });
  });

  it("parses COLONY_DRY_RUN and new v0.8.0 style/topic vars", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DRY_RUN: "true",
      COLONY_POST_STYLE_HINT: "3-6 paragraphs with numbers",
      COLONY_ENGAGE_STYLE_HINT: "2 sentences max",
      COLONY_POST_RECENT_TOPIC_MEMORY: "false",
    });
    const config = loadColonyConfig(runtime);
    expect(config.dryRun).toBe(true);
    expect(config.postStyleHint).toBe("3-6 paragraphs with numbers");
    expect(config.engageStyleHint).toBe("2 sentences max");
    expect(config.postRecentTopicMemory).toBe(false);
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

  it("parses COLONY_NOTIFICATION_TYPES_IGNORE into a normalized Set", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_NOTIFICATION_TYPES_IGNORE: "Vote, FOLLOW , award, ",
    });
    const config = loadColonyConfig(runtime);
    expect(config.notificationTypesIgnore).toEqual(new Set(["vote", "follow", "award"]));
  });

  it("allows an empty COLONY_NOTIFICATION_TYPES_IGNORE to disable the filter", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_NOTIFICATION_TYPES_IGNORE: "",
    });
    expect(loadColonyConfig(runtime).notificationTypesIgnore.size).toBe(0);
  });

  it("parses COLONY_ENGAGE_* vars", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_ENABLED: "true",
      COLONY_ENGAGE_INTERVAL_MIN_SEC: "300",
      COLONY_ENGAGE_INTERVAL_MAX_SEC: "900",
      COLONY_ENGAGE_COLONIES: " findings , general ",
      COLONY_ENGAGE_CANDIDATE_LIMIT: "8",
      COLONY_ENGAGE_MAX_TOKENS: "500",
      COLONY_ENGAGE_TEMPERATURE: "0.7",
    });
    const config = loadColonyConfig(runtime);
    expect(config.engageEnabled).toBe(true);
    expect(config.engageIntervalMinMs).toBe(300_000);
    expect(config.engageIntervalMaxMs).toBe(900_000);
    expect(config.engageColonies).toEqual(["findings", "general"]);
    expect(config.engageCandidateLimit).toBe(8);
    expect(config.engageMaxTokens).toBe(500);
    expect(config.engageTemperature).toBe(0.7);
  });

  it("clamps engage candidate limit above 20 to 20", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_CANDIDATE_LIMIT: "9999",
    });
    expect(loadColonyConfig(runtime).engageCandidateLimit).toBe(20);
  });

  it("falls back engage candidate limit on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_CANDIDATE_LIMIT: "abc",
    });
    expect(loadColonyConfig(runtime).engageCandidateLimit).toBe(5);
  });

  it("falls back engage interval min/max on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_INTERVAL_MIN_SEC: "abc",
      COLONY_ENGAGE_INTERVAL_MAX_SEC: "xyz",
    });
    const config = loadColonyConfig(runtime);
    expect(config.engageIntervalMinMs).toBe(1_800_000);
    expect(config.engageIntervalMaxMs).toBe(3_600_000);
  });

  it("falls back engage max tokens on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_MAX_TOKENS: "abc",
    });
    expect(loadColonyConfig(runtime).engageMaxTokens).toBe(240);
  });

  it("falls back engage temperature on unparseable", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_TEMPERATURE: "abc",
    });
    expect(loadColonyConfig(runtime).engageTemperature).toBe(0.8);
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

  it("parses COLONY_SELF_CHECK_ENABLED aliases", () => {
    for (const v of ["true", "1", "yes"]) {
      const runtime = fakeRuntime(null, {
        COLONY_API_KEY: "col_abc",
        COLONY_SELF_CHECK_ENABLED: v,
      });
      expect(loadColonyConfig(runtime).selfCheckEnabled).toBe(true);
    }
  });

  it("treats non-truthy COLONY_SELF_CHECK_ENABLED as disabled", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_SELF_CHECK_ENABLED: "off",
    });
    expect(loadColonyConfig(runtime).selfCheckEnabled).toBe(false);
  });

  it("parses and clamps COLONY_POST_DAILY_LIMIT", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DAILY_LIMIT: "40",
      })).postDailyLimit,
    ).toBe(40);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DAILY_LIMIT: "0",
      })).postDailyLimit,
    ).toBe(1);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DAILY_LIMIT: "99999",
      })).postDailyLimit,
    ).toBe(500);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DAILY_LIMIT: "abc",
      })).postDailyLimit,
    ).toBe(24);
  });

  it("parses and clamps karma backoff vars", () => {
    const config = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_KARMA_BACKOFF_DROP: "25",
      COLONY_KARMA_BACKOFF_WINDOW_HOURS: "12",
      COLONY_KARMA_BACKOFF_COOLDOWN_MIN: "60",
    }));
    expect(config.karmaBackoffDrop).toBe(25);
    expect(config.karmaBackoffWindowMs).toBe(12 * 3600 * 1000);
    expect(config.karmaBackoffCooldownMs).toBe(60 * 60 * 1000);
  });

  it("falls back karma backoff vars on unparseable", () => {
    const config = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_KARMA_BACKOFF_DROP: "abc",
      COLONY_KARMA_BACKOFF_WINDOW_HOURS: "xyz",
      COLONY_KARMA_BACKOFF_COOLDOWN_MIN: "?",
    }));
    expect(config.karmaBackoffDrop).toBe(10);
    expect(config.karmaBackoffWindowMs).toBe(6 * 3600 * 1000);
    expect(config.karmaBackoffCooldownMs).toBe(120 * 60 * 1000);
  });

  it("clamps karma backoff window/cooldown to max", () => {
    const config = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_KARMA_BACKOFF_WINDOW_HOURS: "99999",
      COLONY_KARMA_BACKOFF_COOLDOWN_MIN: "99999",
    }));
    expect(config.karmaBackoffWindowMs).toBe(168 * 3600 * 1000);
    expect(config.karmaBackoffCooldownMs).toBe(10_080 * 60 * 1000);
  });
});
