import { describe, expect, it, beforeEach, vi } from "vitest";
import { colonyCooldownAction, parseMinutes } from "../actions/cooldown.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("parseMinutes", () => {
  it("prefers explicit options.minutes over text parsing", () => {
    expect(parseMinutes(45, "pause for 3 hours")).toBe(45);
  });

  it("parses minutes from text", () => {
    expect(parseMinutes(undefined, "pause for 30 minutes")).toBe(30);
    expect(parseMinutes(undefined, "quiet for 15 min")).toBe(15);
  });

  it("parses hours from text and converts", () => {
    expect(parseMinutes(undefined, "pause for 2 hours")).toBe(120);
    expect(parseMinutes(undefined, "quiet for 1 hr")).toBe(60);
  });

  it("defaults to 60 when no duration is parseable", () => {
    expect(parseMinutes(undefined, "pause please")).toBe(60);
  });

  it("treats 0 and negative explicit values as unparseable (fall through to text)", () => {
    expect(parseMinutes(0, "pause for 10 min")).toBe(10);
    expect(parseMinutes(-5, "pause please")).toBe(60);
  });

  it("treats NaN option value as unparseable", () => {
    expect(parseMinutes("abc", "pause for 30 min")).toBe(30);
  });

  it("floors fractional minutes", () => {
    expect(parseMinutes(15.9, "")).toBe(15);
  });
});

describe("colonyCooldownAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await colonyCooldownAction.validate(
          fakeRuntime(null),
          fakeMessage("colony cooldown"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await colonyCooldownAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false without the 'colony' token", async () => {
      expect(
        await colonyCooldownAction.validate(
          fakeRuntime(service),
          fakeMessage("cooldown please"),
        ),
      ).toBe(false);
    });

    it("false when message has no text field", async () => {
      expect(
        await colonyCooldownAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("true for 'colony cooldown'", async () => {
      expect(
        await colonyCooldownAction.validate(
          fakeRuntime(service),
          fakeMessage("colony cooldown for 30 min"),
        ),
      ).toBe(true);
    });

    it("true for 'pause colony' phrasing", async () => {
      expect(
        await colonyCooldownAction.validate(
          fakeRuntime(service),
          fakeMessage("please pause colony posting"),
        ),
      ).toBe(true);
    });

    it("true for 'stop posting on the colony'", async () => {
      expect(
        await colonyCooldownAction.validate(
          fakeRuntime(service),
          fakeMessage("stop posting on the colony for an hour"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        fakeRuntime(null),
        fakeMessage("colony cooldown"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("invokes service.cooldown with minutes parsed from message", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown for 45 minutes"),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.cooldown).toHaveBeenCalledWith(45 * 60_000, undefined);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("paused for 45 min"),
        }),
      );
    });

    it("caps cooldown duration at 7 days", async () => {
      const runtime = fakeRuntime(service);
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown"),
        fakeState(),
        { minutes: 99999 },
        makeCallback(),
      );
      expect(service.cooldown).toHaveBeenCalledWith(7 * 24 * 60 * 60_000, undefined);
    });

    it("passes reason through when provided", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown for 10 min"),
        fakeState(),
        { reason: "live debate in progress" },
        cb,
      );
      expect(service.cooldown).toHaveBeenCalledWith(10 * 60_000, "live debate in progress");
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("live debate in progress");
    });

    it("rejects zero-minute duration", async () => {
      // parseMinutes returns a default of 60, so to hit the zero path we need
      // to feed it a message with explicit "0 min"
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown for 0 min"),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.cooldown).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("positive number"),
        }),
      );
    });

    it("reports service-missing-helper when cooldown returns 0", async () => {
      service.cooldown = vi.fn(() => 0);
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown for 30 min"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("missing pause helper"),
        }),
      );
    });

    it("handles a service without cooldown() method entirely", async () => {
      delete service.cooldown;
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown for 30 min"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("missing pause helper"),
        }),
      );
    });

    it("uses default of 60 min when options.minutes is missing and text has no duration", async () => {
      const runtime = fakeRuntime(service);
      await colonyCooldownAction.handler(
        runtime,
        fakeMessage("colony cooldown"),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.cooldown).toHaveBeenCalledWith(60 * 60_000, undefined);
    });

    it("handles messageWithoutText with options.minutes", async () => {
      const runtime = fakeRuntime(service);
      await colonyCooldownAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        { minutes: 20 },
        makeCallback(),
      );
      expect(service.cooldown).toHaveBeenCalledWith(20 * 60_000, undefined);
    });
  });
});
