import { describe, expect, it, beforeEach, vi } from "vitest";
import { rotateColonyKeyAction } from "../actions/rotateKey.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("rotateColonyKeyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await rotateColonyKeyAction.validate(
          fakeRuntime(null),
          fakeMessage("rotate colony api key"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await rotateColonyKeyAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text", async () => {
      expect(
        await rotateColonyKeyAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without the 'colony' token", async () => {
      expect(
        await rotateColonyKeyAction.validate(
          fakeRuntime(service),
          fakeMessage("rotate api key"),
        ),
      ).toBe(false);
    });

    it("false without a rotate+key match", async () => {
      expect(
        await rotateColonyKeyAction.validate(
          fakeRuntime(service),
          fakeMessage("colony is great"),
        ),
      ).toBe(false);
    });

    it("true for 'rotate colony api key'", async () => {
      expect(
        await rotateColonyKeyAction.validate(
          fakeRuntime(service),
          fakeMessage("rotate the colony api key please"),
        ),
      ).toBe(true);
    });

    it("true for 'rotate key on colony'", async () => {
      expect(
        await rotateColonyKeyAction.validate(
          fakeRuntime(service),
          fakeMessage("please rotate key on the colony"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await rotateColonyKeyAction.handler(
        fakeRuntime(null),
        fakeMessage("rotate colony api key"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports the new key when rotation succeeds", async () => {
      service.rotateApiKey = vi.fn(async () => "col_newkey_xxx");
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await rotateColonyKeyAction.handler(
        runtime,
        fakeMessage("rotate colony key"),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.rotateApiKey).toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("col_newkey_xxx"),
        }),
      );
    });

    it("reports failure when rotation returns null", async () => {
      service.rotateApiKey = vi.fn(async () => null);
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await rotateColonyKeyAction.handler(
        runtime,
        fakeMessage("rotate colony key"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("failed") }),
      );
    });

    it("handles service without rotateApiKey method", async () => {
      delete service.rotateApiKey;
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await rotateColonyKeyAction.handler(
        runtime,
        fakeMessage("rotate colony key"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("failed") }),
      );
    });
  });
});
