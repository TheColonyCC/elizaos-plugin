import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted so the mock factory sees the same instance that the test body does.
const { logSpy } = vi.hoisted(() => ({
  logSpy: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    logger: logSpy,
  };
});

import { emitEvent, resolveLogFormat } from "../utils/emitEvent.js";
import { fakeRuntime } from "./helpers.js";

describe("emitEvent", () => {
  beforeEach(() => {
    logSpy.info.mockReset();
    logSpy.warn.mockReset();
    logSpy.error.mockReset();
  });

  it("emits text when format is 'text'", () => {
    emitEvent("text", { level: "info", event: "post.created" }, "auto post to c/general");
    expect(logSpy.info).toHaveBeenCalledWith("auto post to c/general");
  });

  it("emits JSON line when format is 'json'", () => {
    emitEvent(
      "json",
      { level: "info", event: "post.created", postId: "p1", colony: "general" },
      "auto post to c/general",
    );
    const line = logSpy.info.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("post.created");
    expect(parsed.postId).toBe("p1");
    expect(parsed.colony).toBe("general");
    expect(parsed.level).toBe("info");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("routes warn-level through logger.warn", () => {
    emitEvent("text", { level: "warn", event: "x" }, "warn text");
    expect(logSpy.warn).toHaveBeenCalledWith("warn text");
  });

  it("routes error-level through logger.error", () => {
    emitEvent("json", { level: "error", event: "x" }, "fallback");
    expect(logSpy.error).toHaveBeenCalled();
  });

  it("strips level/event from JSON payload body but keeps them as first-level keys", () => {
    emitEvent(
      "json",
      { level: "info", event: "x", otherField: "val" },
      "t",
    );
    const parsed = JSON.parse(logSpy.info.mock.calls[0]![0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("x");
    expect(parsed.otherField).toBe("val");
  });
});

describe("resolveLogFormat", () => {
  it("returns 'text' when runtime is null", () => {
    expect(resolveLogFormat(null)).toBe("text");
    expect(resolveLogFormat(undefined)).toBe("text");
  });

  it("returns 'text' when getSetting is not a function", () => {
    const rt = {} as unknown as Parameters<typeof resolveLogFormat>[0];
    expect(resolveLogFormat(rt)).toBe("text");
  });

  it("returns 'json' when COLONY_LOG_FORMAT=json", () => {
    const rt = fakeRuntime(null, { COLONY_LOG_FORMAT: "json" });
    expect(resolveLogFormat(rt)).toBe("json");
  });

  it("returns 'text' when COLONY_LOG_FORMAT is anything else", () => {
    expect(resolveLogFormat(fakeRuntime(null, { COLONY_LOG_FORMAT: "text" }))).toBe("text");
    expect(resolveLogFormat(fakeRuntime(null, { COLONY_LOG_FORMAT: "junk" }))).toBe("text");
    expect(resolveLogFormat(fakeRuntime(null, {}))).toBe("text");
  });

  it("handles case-insensitive + whitespace", () => {
    expect(resolveLogFormat(fakeRuntime(null, { COLONY_LOG_FORMAT: "  JSON  " }))).toBe("json");
  });

  it("returns 'text' for non-string setting value", () => {
    const rt = {
      getSetting: (_k: string) => 42,
    } as unknown as Parameters<typeof resolveLogFormat>[0];
    expect(resolveLogFormat(rt)).toBe("text");
  });
});
