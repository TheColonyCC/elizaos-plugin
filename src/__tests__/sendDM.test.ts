import { describe, expect, it, beforeEach } from "vitest";
import { sendColonyDMAction } from "../actions/sendDM.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("sendColonyDMAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(await sendColonyDMAction.validate(runtime, fakeMessage("dm"))).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(await sendColonyDMAction.validate(runtime, fakeMessage(""))).toBe(false);
    });

    it("returns true when dm keyword is present", async () => {
      const runtime = fakeRuntime(service);
      expect(await sendColonyDMAction.validate(runtime, fakeMessage("dm @alice"))).toBe(true);
    });

    it("returns false when no keyword matches", async () => {
      const runtime = fakeRuntime(service);
      expect(await sendColonyDMAction.validate(runtime, fakeMessage("no keywords here"))).toBe(false);
    });

    it("returns false when content has no text", async () => {
      const runtime = fakeRuntime(service);
      expect(await sendColonyDMAction.validate(runtime, messageWithoutText())).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(runtime, fakeMessage("dm"), fakeState(), {}, cb);
      expect(cb).not.toHaveBeenCalled();
    });

    it("prompts when username or body missing", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(runtime, fakeMessage(""), fakeState(), {}, cb);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ action: "SEND_COLONY_DM" }),
      );
      expect(service.client.sendMessage).not.toHaveBeenCalled();
    });

    it("prompts when message has no content.text", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(
        runtime,
        messageWithoutText(),
        fakeState(),
        { username: "u" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ action: "SEND_COLONY_DM" }),
      );
    });

    it("sends DM via SDK", async () => {
      service.client.sendMessage.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(
        runtime,
        fakeMessage("dm body"),
        fakeState(),
        { username: "alice", body: "hello" },
        cb,
      );
      expect(service.client.sendMessage).toHaveBeenCalledWith("alice", "hello");
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("@alice"),
          action: "SEND_COLONY_DM",
        }),
      );
    });

    it("falls back to message text when body option missing", async () => {
      service.client.sendMessage.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(
        runtime,
        fakeMessage("hi there"),
        fakeState(),
        { username: "bob" },
        cb,
      );
      expect(service.client.sendMessage).toHaveBeenCalledWith("bob", "hi there");
    });

    it("reports SDK errors", async () => {
      service.client.sendMessage.mockRejectedValue(new Error("blocked"));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await sendColonyDMAction.handler!(
        runtime,
        fakeMessage("dm"),
        fakeState(),
        { username: "u", body: "b" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("blocked"),
          action: "SEND_COLONY_DM",
        }),
      );
    });
  });
});
