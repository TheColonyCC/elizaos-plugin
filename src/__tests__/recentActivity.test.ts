import { describe, expect, it, beforeEach, vi } from "vitest";
import { colonyRecentActivityAction, formatEntry } from "../actions/recentActivity.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("formatEntry", () => {
  it("formats a recent entry with target and detail", () => {
    const e = {
      ts: Date.now() - 5000,
      type: "post_created" as const,
      target: "abcdef12-3456",
      detail: "c/general: hello",
    };
    expect(formatEntry(e)).toBe("- 5s ago · post_created abcdef12 · c/general: hello");
  });

  it("formats minute-scale age", () => {
    const e = { ts: Date.now() - 2 * 60_000, type: "vote_cast" as const };
    expect(formatEntry(e)).toMatch(/^- 2m ago · vote_cast/);
  });

  it("formats hour-scale age with minutes", () => {
    const e = { ts: Date.now() - (2 * 3600_000 + 15 * 60_000), type: "post_created" as const };
    expect(formatEntry(e)).toMatch(/^- 2h15m ago/);
  });

  it("formats hour-scale age without minutes", () => {
    const e = { ts: Date.now() - 3 * 3600_000, type: "post_created" as const };
    expect(formatEntry(e)).toMatch(/^- 3h ago/);
  });

  it("formats day-scale age", () => {
    const e = { ts: Date.now() - (2 * 86_400_000 + 3 * 3600_000), type: "post_created" as const };
    expect(formatEntry(e)).toMatch(/^- 2d3h ago/);
  });

  it("omits target and detail when missing", () => {
    const e = { ts: Date.now(), type: "backoff_triggered" as const };
    const formatted = formatEntry(e);
    expect(formatted).toContain("backoff_triggered");
    expect(formatted).not.toContain("·  ·");
  });
});

describe("colonyRecentActivityAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.activityLog = [];
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await colonyRecentActivityAction.validate(
          fakeRuntime(null),
          fakeMessage("colony activity"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await colonyRecentActivityAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text field", async () => {
      expect(
        await colonyRecentActivityAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without the 'colony' token", async () => {
      expect(
        await colonyRecentActivityAction.validate(
          fakeRuntime(service),
          fakeMessage("what have you done?"),
        ),
      ).toBe(false);
    });

    it("true for 'colony activity'", async () => {
      expect(
        await colonyRecentActivityAction.validate(
          fakeRuntime(service),
          fakeMessage("show colony activity"),
        ),
      ).toBe(true);
    });

    it("true for 'what have you done on the colony'", async () => {
      expect(
        await colonyRecentActivityAction.validate(
          fakeRuntime(service),
          fakeMessage("what have you done on the colony today"),
        ),
      ).toBe(true);
    });

    it("true for 'recent colony activity'", async () => {
      expect(
        await colonyRecentActivityAction.validate(
          fakeRuntime(service),
          fakeMessage("recent colony activity please"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(null),
        fakeMessage("colony activity"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports empty-log state when log is empty", async () => {
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("empty") }),
      );
    });

    it("returns recent entries newest-first", async () => {
      service.activityLog = [
        { ts: Date.now() - 3 * 60_000, type: "post_created", target: "post123", detail: "old" },
        { ts: Date.now() - 1 * 60_000, type: "vote_cast", target: "vote456", detail: "new" },
      ];
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      const newIdx = text.indexOf("vote_cast");
      const oldIdx = text.indexOf("post_created");
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it("respects limit option", async () => {
      service.activityLog = Array.from({ length: 30 }, (_, i) => ({
        ts: Date.now() - i * 60_000,
        type: "post_created" as const,
        target: `p${i}`,
      }));
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        { limit: 5 },
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Last 5");
    });

    it("clamps limit to max 50", async () => {
      service.activityLog = Array.from({ length: 5 }, (_, i) => ({
        ts: Date.now() - i * 1000,
        type: "post_created" as const,
      }));
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        { limit: 9999 },
        cb,
      );
      // With only 5 entries, returns 5 regardless of cap
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Last 5");
    });

    it("falls back to default on NaN limit", async () => {
      service.activityLog = Array.from({ length: 3 }, () => ({
        ts: Date.now(),
        type: "vote_cast" as const,
      }));
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        { limit: "abc" },
        cb,
      );
      expect(cb).toHaveBeenCalled();
    });

    it("filters by type option", async () => {
      service.activityLog = [
        { ts: Date.now() - 10_000, type: "post_created", target: "p1" },
        { ts: Date.now() - 5_000, type: "vote_cast", target: "v1" },
        { ts: Date.now() - 1_000, type: "post_created", target: "p2" },
      ];
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        { type: "vote_cast" },
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("vote_cast");
      expect(text).not.toContain("post_created");
    });

    it("reports 'no entries for type' when filter has no matches", async () => {
      service.activityLog = [{ ts: Date.now(), type: "post_created" }];
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        { type: "curation_run" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No 'curation_run' entries") }),
      );
    });

    it("handles service without activityLog property", async () => {
      service.activityLog = undefined;
      const cb = makeCallback();
      await colonyRecentActivityAction.handler(
        fakeRuntime(service),
        fakeMessage("colony activity"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("empty") }),
      );
    });
  });
});
