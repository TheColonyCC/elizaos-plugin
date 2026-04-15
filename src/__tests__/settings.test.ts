import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getSetting } from "../utils/settings.js";
import { fakeRuntime } from "./helpers.js";

describe("getSetting", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PLUGIN_COLONY_TEST_KEY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns runtime setting when present", () => {
    const runtime = fakeRuntime(null, { PLUGIN_COLONY_TEST_KEY: "runtime-value" });
    expect(getSetting(runtime, "PLUGIN_COLONY_TEST_KEY")).toBe("runtime-value");
  });

  it("coerces non-string runtime values to string", () => {
    const runtime = fakeRuntime(null, { PLUGIN_COLONY_TEST_KEY: 42 });
    expect(getSetting(runtime, "PLUGIN_COLONY_TEST_KEY")).toBe("42");
  });

  it("falls back to process.env when runtime setting is null", () => {
    process.env.PLUGIN_COLONY_TEST_KEY = "env-value";
    const runtime = fakeRuntime(null, {});
    expect(getSetting(runtime, "PLUGIN_COLONY_TEST_KEY")).toBe("env-value");
  });

  it("returns default when neither runtime nor env has the key", () => {
    const runtime = fakeRuntime(null, {});
    expect(getSetting(runtime, "PLUGIN_COLONY_TEST_KEY", "fallback")).toBe("fallback");
  });

  it("returns undefined when no sources and no default", () => {
    const runtime = fakeRuntime(null, {});
    expect(getSetting(runtime, "PLUGIN_COLONY_TEST_KEY")).toBeUndefined();
  });

  it("handles a runtime without getSetting function", () => {
    expect(getSetting(null, "PLUGIN_COLONY_TEST_KEY", "def")).toBe("def");
    expect(getSetting(undefined, "PLUGIN_COLONY_TEST_KEY", "def")).toBe("def");
  });

  it("handles a runtime object whose getSetting is not a function", () => {
    const badRuntime = { getSetting: "not a function" } as unknown as Parameters<typeof getSetting>[0];
    process.env.PLUGIN_COLONY_TEST_KEY = "env-value";
    expect(getSetting(badRuntime, "PLUGIN_COLONY_TEST_KEY")).toBe("env-value");
  });
});
