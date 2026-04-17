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
      engageMaxTokens: 500,
      engageTemperature: 0.8,
      engageStyleHint: "",
      selfCheckEnabled: true,
      postDailyLimit: 24,
      karmaBackoffDrop: 10,
      karmaBackoffWindowMs: 6 * 3600 * 1000,
      karmaBackoffCooldownMs: 120 * 60 * 1000,
      engageThreadComments: 3,
      engageRequireTopicMatch: false,
      mentionMinKarma: 0,
      postDefaultType: "discussion",
      mentionThreadComments: 3,
      bannedPatterns: [],
      postModelType: "TEXT_SMALL",
      engageModelType: "TEXT_SMALL",
      scorerModelType: "TEXT_SMALL",
      registerSignalHandlers: false,
      logFormat: "text",
      retryQueueEnabled: true,
      retryQueueMaxAttempts: 3,
      retryQueueMaxAgeMs: 60 * 60 * 1000,
      engageReactionMode: false,
      autoRotateKey: false,
      selfCheckRetry: false,
      activityWebhookUrl: "",
      activityWebhookSecret: "",
      engageFollowWeight: "off",
      engagePreferredAuthors: [],
      postApprovalRequired: false,
      postQuietHours: null,
      engageQuietHours: null,
      llmFailureThreshold: 0,
      llmFailureWindowMs: 10 * 60_000,
      llmFailureCooldownMs: 30 * 60_000,
      reactionAuthorLimit: 3,
      reactionAuthorWindowMs: 2 * 3600_000,
      engageLengthTarget: "medium",
      diversityWindowSize: 3,
      diversityThreshold: 0.8,
      diversityNgram: 3,
      diversityCooldownMs: 60 * 60_000,
      operatorUsername: "",
      operatorPrefix: "!",
      dmContextMessages: 0,
      engageUseRising: false,
      engageTrendingBoost: false,
      engageTrendingRefreshMs: 15 * 60_000,
    });
  });

  it("v0.19.0 — parses and clamps diversity settings", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DIVERSITY_WINDOW: "100", // clamp to 20
      COLONY_DIVERSITY_THRESHOLD: "2.5", // clamp to 1
      COLONY_DIVERSITY_NGRAM: "99", // clamp to 8
      COLONY_DIVERSITY_COOLDOWN_MIN: "0", // invalid, fallback to 60
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.diversityWindowSize).toBe(20);
    expect(cfg.diversityThreshold).toBe(1);
    expect(cfg.diversityNgram).toBe(8);
    expect(cfg.diversityCooldownMs).toBe(60 * 60_000);
  });

  it("v0.19.0 — falls back to defaults on unparseable diversity settings", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DIVERSITY_WINDOW: "not-a-number",
      COLONY_DIVERSITY_THRESHOLD: "nope",
      COLONY_DIVERSITY_NGRAM: "NaN",
      COLONY_DIVERSITY_COOLDOWN_MIN: "forever",
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.diversityWindowSize).toBe(3);
    expect(cfg.diversityThreshold).toBe(0.8);
    expect(cfg.diversityNgram).toBe(3);
    expect(cfg.diversityCooldownMs).toBe(60 * 60_000);
  });

  it("v0.19.0 — parses operator kill-switch and DM context settings", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_OPERATOR_USERNAME: "  Jack  ",
      COLONY_OPERATOR_PREFIX: "!!",
      COLONY_DM_CONTEXT_MESSAGES: "8",
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.operatorUsername).toBe("jack");
    expect(cfg.operatorPrefix).toBe("!!");
    expect(cfg.dmContextMessages).toBe(8);
  });

  it("v0.19.0 — falls back to '!' when COLONY_OPERATOR_PREFIX is empty", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_OPERATOR_PREFIX: "",
    });
    const cfg = loadColonyConfig(runtime);
    expect(cfg.operatorPrefix).toBe("!");
  });

  it("parses COLONY_ENGAGE_FOLLOW_WEIGHT=soft (v0.14.0 branch)", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_FOLLOW_WEIGHT: "soft",
    });
    expect(loadColonyConfig(runtime).engageFollowWeight).toBe("soft");
  });

  it("v0.19.0 — clamps COLONY_DM_CONTEXT_MESSAGES and falls back on garbage", () => {
    const clamp = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DM_CONTEXT_MESSAGES: "100",
    });
    expect(loadColonyConfig(clamp).dmContextMessages).toBe(50);
    const garbage = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_DM_CONTEXT_MESSAGES: "nonsense",
    });
    expect(loadColonyConfig(garbage).dmContextMessages).toBe(0);
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

  it("falls back engage max tokens on unparseable (v0.18.0: medium-target default = 500)", () => {
    const runtime = fakeRuntime(null, {
      COLONY_API_KEY: "col_abc",
      COLONY_ENGAGE_MAX_TOKENS: "abc",
    });
    // v0.18.0: when explicit value is unparseable, falls back to the
    // length-target's default (medium → 500).
    expect(loadColonyConfig(runtime).engageMaxTokens).toBe(500);
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

  // v0.11.0 vars
  it("parses COLONY_ENGAGE_THREAD_COMMENTS and clamps to 0-10", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_THREAD_COMMENTS: "5",
      })).engageThreadComments,
    ).toBe(5);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_THREAD_COMMENTS: "99",
      })).engageThreadComments,
    ).toBe(10);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_THREAD_COMMENTS: "-1",
      })).engageThreadComments,
    ).toBe(0);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_THREAD_COMMENTS: "abc",
      })).engageThreadComments,
    ).toBe(3);
  });

  it("parses COLONY_ENGAGE_REQUIRE_TOPIC_MATCH as boolean", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_REQUIRE_TOPIC_MATCH: "true",
      })).engageRequireTopicMatch,
    ).toBe(true);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_REQUIRE_TOPIC_MATCH: "off",
      })).engageRequireTopicMatch,
    ).toBe(false);
  });

  it("parses COLONY_MENTION_MIN_KARMA and clamps", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_MIN_KARMA: "5",
      })).mentionMinKarma,
    ).toBe(5);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_MIN_KARMA: "99999",
      })).mentionMinKarma,
    ).toBe(10_000);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_MIN_KARMA: "abc",
      })).mentionMinKarma,
    ).toBe(0);
  });

  it("parses COLONY_POST_DEFAULT_TYPE with fallback to discussion", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DEFAULT_TYPE: "finding",
      })).postDefaultType,
    ).toBe("finding");
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DEFAULT_TYPE: "nonsense",
      })).postDefaultType,
    ).toBe("discussion");
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_DEFAULT_TYPE: "  ANALYSIS  ",
      })).postDefaultType,
    ).toBe("analysis");
  });

  // v0.12.0
  it("parses COLONY_MENTION_THREAD_COMMENTS and clamps", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_THREAD_COMMENTS: "5",
      })).mentionThreadComments,
    ).toBe(5);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_THREAD_COMMENTS: "99",
      })).mentionThreadComments,
    ).toBe(10);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_MENTION_THREAD_COMMENTS: "abc",
      })).mentionThreadComments,
    ).toBe(3);
  });

  it("parses COLONY_BANNED_PATTERNS into RegExp array", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_BANNED_PATTERNS: "acme, foo\\.bar",
    }));
    expect(c.bannedPatterns.length).toBe(2);
    expect(c.bannedPatterns[0]!.test("Acme launch")).toBe(true);
    expect(c.bannedPatterns[1]!.test("foo.bar site")).toBe(true);
  });

  it("skips invalid regexes in banned patterns without crashing", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_BANNED_PATTERNS: "acme, [unclosed, foo",
    }));
    expect(c.bannedPatterns.length).toBe(2);
  });

  it("ignores blank pattern entries", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_BANNED_PATTERNS: "acme,   , foo",
    }));
    expect(c.bannedPatterns.length).toBe(2);
  });

  it("parses model-type env vars with TEXT_SMALL fallback", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_POST_MODEL_TYPE: "TEXT_LARGE",
      COLONY_ENGAGE_MODEL_TYPE: "text_large",
      COLONY_SCORER_MODEL_TYPE: "TEXT_SMALL",
    }));
    expect(c.postModelType).toBe("TEXT_LARGE");
    expect(c.engageModelType).toBe("TEXT_LARGE");
    expect(c.scorerModelType).toBe("TEXT_SMALL");
  });

  it("falls back to TEXT_SMALL on invalid model types", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_POST_MODEL_TYPE: "TEXT_GIGANTIC",
    }));
    expect(c.postModelType).toBe("TEXT_SMALL");
  });

  it("parses COLONY_REGISTER_SIGNAL_HANDLERS as boolean", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_REGISTER_SIGNAL_HANDLERS: "true",
      })).registerSignalHandlers,
    ).toBe(true);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_REGISTER_SIGNAL_HANDLERS: "no",
      })).registerSignalHandlers,
    ).toBe(false);
  });

  it("parses COLONY_LOG_FORMAT", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_LOG_FORMAT: "json",
      })).logFormat,
    ).toBe("json");
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_LOG_FORMAT: "text",
      })).logFormat,
    ).toBe("text");
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_LOG_FORMAT: "garbage",
      })).logFormat,
    ).toBe("text");
  });

  it("parses COLONY_ENGAGE_FOLLOW_WEIGHT soft value (v0.14.0)", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_FOLLOW_WEIGHT: "soft",
      })).engageFollowWeight,
    ).toBe("soft");
  });

  it("parses COLONY_POST_APPROVAL (v0.14.0)", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_POST_APPROVAL: "true",
      })).postApprovalRequired,
    ).toBe(true);
  });

  // v0.13.0
  it("parses retry queue vars", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_RETRY_QUEUE_ENABLED: "false",
      COLONY_RETRY_QUEUE_MAX_ATTEMPTS: "5",
      COLONY_RETRY_QUEUE_MAX_AGE_MIN: "30",
    }));
    expect(c.retryQueueEnabled).toBe(false);
    expect(c.retryQueueMaxAttempts).toBe(5);
    expect(c.retryQueueMaxAgeMs).toBe(30 * 60 * 1000);
  });

  it("clamps retry queue bounds", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_RETRY_QUEUE_MAX_ATTEMPTS: "999",
      })).retryQueueMaxAttempts,
    ).toBe(10);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_RETRY_QUEUE_MAX_ATTEMPTS: "0",
      })).retryQueueMaxAttempts,
    ).toBe(1);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_RETRY_QUEUE_MAX_AGE_MIN: "99999",
      })).retryQueueMaxAgeMs,
    ).toBe(10_080 * 60 * 1000);
  });

  it("falls back retry queue vars on unparseable", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_RETRY_QUEUE_MAX_ATTEMPTS: "abc",
      COLONY_RETRY_QUEUE_MAX_AGE_MIN: "xyz",
    }));
    expect(c.retryQueueMaxAttempts).toBe(3);
    expect(c.retryQueueMaxAgeMs).toBe(60 * 60 * 1000);
  });

  it("parses COLONY_ENGAGE_REACTION_MODE", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_ENGAGE_REACTION_MODE: "true",
      })).engageReactionMode,
    ).toBe(true);
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
      })).engageReactionMode,
    ).toBe(false);
  });

  it("parses COLONY_AUTO_ROTATE_KEY", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_AUTO_ROTATE_KEY: "true",
      })).autoRotateKey,
    ).toBe(true);
  });

  it("parses COLONY_SELF_CHECK_RETRY", () => {
    expect(
      loadColonyConfig(fakeRuntime(null, {
        COLONY_API_KEY: "col_a",
        COLONY_SELF_CHECK_RETRY: "1",
      })).selfCheckRetry,
    ).toBe(true);
  });

  it("parses activity webhook vars", () => {
    const c = loadColonyConfig(fakeRuntime(null, {
      COLONY_API_KEY: "col_a",
      COLONY_ACTIVITY_WEBHOOK_URL: "https://example.com/hook",
      COLONY_ACTIVITY_WEBHOOK_SECRET: "shh",
    }));
    expect(c.activityWebhookUrl).toBe("https://example.com/hook");
    expect(c.activityWebhookSecret).toBe("shh");
  });
});
