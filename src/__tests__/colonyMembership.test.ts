import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  joinColonyAction,
  leaveColonyAction,
  listColoniesAction,
  resolveColonyName,
} from "../actions/colonyMembership.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";
import type { Memory } from "@elizaos/core";

describe("resolveColonyName", () => {
  it("prefers options.colony", () => {
    expect(resolveColonyName({ colony: "findings" }, "join c/meta")).toBe("findings");
  });
  it("falls back to c/<name> token in text", () => {
    expect(resolveColonyName({}, "please join c/research")).toBe("research");
  });
  it("returns undefined when neither present", () => {
    expect(resolveColonyName({}, "join something")).toBeUndefined();
  });
  it("handles underscore / hyphen slugs", () => {
    expect(resolveColonyName({}, "join c/agent-economy")).toBe("agent-economy");
    expect(resolveColonyName({}, "c/my_colony please")).toBe("my_colony");
  });
});

describe("joinColonyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(async () => ({}));
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(null), fakeMessage("join c/findings")),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without a join keyword", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(service), fakeMessage("c/findings")),
      ).toBe(false);
    });

    it("false without a colony name", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(service), fakeMessage("join please")),
      ).toBe(false);
    });

    it("true for 'join c/findings'", async () => {
      expect(
        await joinColonyAction.validate(fakeRuntime(service), fakeMessage("join c/findings")),
      ).toBe(true);
    });

    it("true when options.colony supplied", async () => {
      const msg = {
        content: { text: "please join", colony: "findings" },
      } as unknown as Memory;
      expect(await joinColonyAction.validate(fakeRuntime(service), msg)).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await joinColonyAction.handler(
        fakeRuntime(null),
        fakeMessage("join c/findings"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no colony resolvable", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await joinColonyAction.handler(
        runtime,
        fakeMessage("join please"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("sub-colony name") }),
      );
    });

    it("calls client.joinColony + reports success", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await joinColonyAction.handler(
        runtime,
        fakeMessage("join c/findings"),
        fakeState(),
        undefined,
        cb,
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).joinColony,
      ).toHaveBeenCalledWith("findings");
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Joined c/findings") }),
      );
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).joinColony = vi.fn(async () => {
        throw new Error("403 forbidden");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await joinColonyAction.handler(
        runtime,
        fakeMessage("join c/private"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to join") }),
      );
    });

    it("records activity", async () => {
      const runtime = fakeRuntime(service);
      await joinColonyAction.handler(
        runtime,
        fakeMessage("join c/findings"),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.recordActivity).toHaveBeenCalledWith(
        "post_created",
        "findings",
        expect.stringContaining("joined"),
      );
    });

    it("handles messageWithoutText + options.colony", async () => {
      const runtime = fakeRuntime(service);
      await joinColonyAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        { colony: "findings" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).joinColony,
      ).toHaveBeenCalledWith("findings");
    });
  });
});

describe("leaveColonyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).leaveColony = vi.fn(async () => ({}));
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await leaveColonyAction.validate(fakeRuntime(null), fakeMessage("leave c/x")),
      ).toBe(false);
    });

    it("false when message has no text", async () => {
      expect(
        await leaveColonyAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without leave keyword", async () => {
      expect(
        await leaveColonyAction.validate(fakeRuntime(service), fakeMessage("c/x")),
      ).toBe(false);
    });

    it("true for 'leave c/x'", async () => {
      expect(
        await leaveColonyAction.validate(fakeRuntime(service), fakeMessage("leave c/findings")),
      ).toBe(true);
    });

    it("true when options.colony supplied", async () => {
      const msg = {
        content: { text: "unsubscribe from it", colony: "noise" },
      } as unknown as Memory;
      expect(await leaveColonyAction.validate(fakeRuntime(service), msg)).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await leaveColonyAction.handler(
        fakeRuntime(null),
        fakeMessage("leave c/x"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no colony resolvable", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await leaveColonyAction.handler(
        runtime,
        fakeMessage("leave"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("sub-colony name") }),
      );
    });

    it("calls client.leaveColony + reports success", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await leaveColonyAction.handler(
        runtime,
        fakeMessage("leave c/noise"),
        fakeState(),
        undefined,
        cb,
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).leaveColony,
      ).toHaveBeenCalledWith("noise");
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Left c/noise") }),
      );
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).leaveColony = vi.fn(async () => {
        throw new Error("404");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await leaveColonyAction.handler(
        runtime,
        fakeMessage("leave c/x"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to leave") }),
      );
    });

    it("handles messageWithoutText + options.colony", async () => {
      const runtime = fakeRuntime(service);
      await leaveColonyAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        { colony: "findings" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).leaveColony,
      ).toHaveBeenCalledWith("findings");
    });
  });
});

describe("listColoniesAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => [
      { id: "a", name: "general", display_name: "General", subscriber_count: 100, post_count: 50 },
      { id: "b", name: "findings", display_name: "findings" },
    ]);
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await listColoniesAction.validate(
          fakeRuntime(null),
          fakeMessage("list colony colonies"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await listColoniesAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text field", async () => {
      expect(
        await listColoniesAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false for unrelated phrasing", async () => {
      expect(
        await listColoniesAction.validate(fakeRuntime(service), fakeMessage("hi")),
      ).toBe(false);
    });

    it("true for 'list sub-colonies'", async () => {
      expect(
        await listColoniesAction.validate(
          fakeRuntime(service),
          fakeMessage("list sub-colonies"),
        ),
      ).toBe(true);
    });

    it("true for 'browse colonies'", async () => {
      expect(
        await listColoniesAction.validate(
          fakeRuntime(service),
          fakeMessage("browse the colonies"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await listColoniesAction.handler(
        fakeRuntime(null),
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("returns formatted list of colonies", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("c/general (General), 50 posts, 100 subs");
      expect(text).toContain("c/findings");
      expect(text).not.toContain("(findings)"); // display_name matches name, so no suffix
    });

    it("handles SDK returning object without items key", async () => {
      (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => ({}));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No sub-colonies") }),
      );
    });

    it("handles SDK returning { items } wrapper", async () => {
      (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => ({
        items: [{ id: "a", name: "meta" }],
      }));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("c/meta");
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => {
        throw new Error("500");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to fetch") }),
      );
    });

    it("reports when zero colonies returned", async () => {
      (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => []);
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("No sub-colonies") }),
      );
    });

    it("clamps limit option", async () => {
      const runtime = fakeRuntime(service);
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        { limit: 9999 },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).getColonies,
      ).toHaveBeenCalledWith(200);
    });

    it("falls back to default on NaN limit", async () => {
      const runtime = fakeRuntime(service);
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        { limit: "abc" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).getColonies,
      ).toHaveBeenCalledWith(50);
    });

    it("handles colony entries with missing name", async () => {
      (service.client as unknown as Record<string, unknown>).getColonies = vi.fn(async () => [
        { id: "nameless" }, // no name
      ]);
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await listColoniesAction.handler(
        runtime,
        fakeMessage("list colonies"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("c/(unknown)");
    });
  });
});
