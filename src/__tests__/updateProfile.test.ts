import { describe, expect, it, beforeEach, vi } from "vitest";
import { updateColonyProfileAction } from "../actions/updateProfile.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("updateColonyProfileAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).updateProfile = vi.fn(async () => ({}));
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await updateColonyProfileAction.validate(
          fakeRuntime(null),
          fakeMessage("update colony profile"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await updateColonyProfileAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text", async () => {
      expect(
        await updateColonyProfileAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false for unrelated message", async () => {
      expect(
        await updateColonyProfileAction.validate(
          fakeRuntime(service),
          fakeMessage("hello world"),
        ),
      ).toBe(false);
    });

    it("true for 'update colony profile'", async () => {
      expect(
        await updateColonyProfileAction.validate(
          fakeRuntime(service),
          fakeMessage("update colony profile to reflect new capabilities"),
        ),
      ).toBe(true);
    });

    it("true for 'edit bio'", async () => {
      expect(
        await updateColonyProfileAction.validate(
          fakeRuntime(service),
          fakeMessage("edit my bio on colony"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await updateColonyProfileAction.handler(
        fakeRuntime(null),
        fakeMessage("update colony profile"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no fields supplied", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update colony profile"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("at least one of"),
        }),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile,
      ).not.toHaveBeenCalled();
    });

    it("updates displayName only", async () => {
      const runtime = fakeRuntime(service);
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { displayName: "New Name" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile,
      ).toHaveBeenCalledWith({ displayName: "New Name" });
    });

    it("updates bio only", async () => {
      const runtime = fakeRuntime(service);
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { bio: "New bio" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile,
      ).toHaveBeenCalledWith({ bio: "New bio" });
    });

    it("updates capabilities (object) only", async () => {
      const runtime = fakeRuntime(service);
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { capabilities: { skills: ["writing"] } },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile,
      ).toHaveBeenCalledWith({ capabilities: { skills: ["writing"] } });
    });

    it("updates multiple fields at once", async () => {
      const runtime = fakeRuntime(service);
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { displayName: "N", bio: "B" },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile,
      ).toHaveBeenCalledWith({ displayName: "N", bio: "B" });
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).updateProfile = vi.fn(async () => {
        throw new Error("429 rate-limited");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { bio: "B" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to update") }),
      );
    });

    it("records activity with updated-field list", async () => {
      const runtime = fakeRuntime(service);
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { bio: "B" },
        makeCallback(),
      );
      expect(service.recordActivity).toHaveBeenCalledWith(
        "post_created",
        service.username,
        expect.stringContaining("bio"),
      );
    });

    it("ignores non-string displayName / bio", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { displayName: 42, bio: null },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("at least one of") }),
      );
    });

    it("ignores non-object capabilities", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await updateColonyProfileAction.handler(
        runtime,
        fakeMessage("update profile"),
        fakeState(),
        { capabilities: "not-an-object" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("at least one of") }),
      );
    });
  });
});
