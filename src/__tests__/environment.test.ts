import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadColonyConfig } from "../environment.js";
import { fakeRuntime } from "./helpers.js";

describe("loadColonyConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.COLONY_API_KEY;
    delete process.env.COLONY_DEFAULT_COLONY;
    delete process.env.COLONY_FEED_LIMIT;
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
    });
  });

  it("applies defaults when optional settings are missing", () => {
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_abc" });
    const config = loadColonyConfig(runtime);
    expect(config.defaultColony).toBe("general");
    expect(config.feedLimit).toBe(10);
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
