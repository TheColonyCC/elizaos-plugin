import { describe, expect, it, beforeEach } from "vitest";
import { reactColonyAction } from "../actions/react.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("reactColonyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(await reactColonyAction.validate(runtime, fakeMessage("react"))).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(await reactColonyAction.validate(runtime, fakeMessage(""))).toBe(false);
    });

    it("returns true for react keyword", async () => {
      const runtime = fakeRuntime(service);
      expect(await reactColonyAction.validate(runtime, fakeMessage("react fire"))).toBe(true);
    });

    it("returns false when no keyword", async () => {
      const runtime = fakeRuntime(service);
      expect(await reactColonyAction.validate(runtime, fakeMessage("hello there"))).toBe(false);
    });

    it("returns false when message has no text", async () => {
      const runtime = fakeRuntime(service);
      expect(await reactColonyAction.validate(runtime, messageWithoutText())).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await reactColonyAction.handler!(runtime, fakeMessage("react"), fakeState(), {}, cb);
      expect(cb).not.toHaveBeenCalled();
    });

    it("prompts when neither postId nor commentId provided", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(runtime, fakeMessage("react"), fakeState(), {}, cb);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ action: "REACT_COLONY_POST" }),
      );
    });

    it("rejects invalid emoji", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(
        runtime,
        fakeMessage("react"),
        fakeState(),
        { postId: "p1", emoji: "poop" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Invalid reaction emoji"),
        }),
      );
      expect(service.client.reactPost).not.toHaveBeenCalled();
    });

    it("reacts to a post with default thumbs_up emoji", async () => {
      service.client.reactPost.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(
        runtime,
        fakeMessage("react"),
        fakeState(),
        { postId: "p1" },
        cb,
      );
      expect(service.client.reactPost).toHaveBeenCalledWith("p1", "thumbs_up");
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("thumbs_up"),
          action: "REACT_COLONY_POST",
        }),
      );
    });

    it("reacts to a comment with explicit emoji", async () => {
      service.client.reactComment.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(
        runtime,
        fakeMessage("react fire"),
        fakeState(),
        { commentId: "c1", emoji: "fire" },
        cb,
      );
      expect(service.client.reactComment).toHaveBeenCalledWith("c1", "fire");
    });

    it("uppercases user emoji input", async () => {
      service.client.reactPost.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(
        runtime,
        fakeMessage("react"),
        fakeState(),
        { postId: "p1", emoji: "FIRE" },
        cb,
      );
      expect(service.client.reactPost).toHaveBeenCalledWith("p1", "fire");
    });

    it("reports SDK errors", async () => {
      service.client.reactPost.mockRejectedValue(new Error("self-react"));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await reactColonyAction.handler!(
        runtime,
        fakeMessage("react"),
        fakeState(),
        { postId: "p1" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("self-react"),
          action: "REACT_COLONY_POST",
        }),
      );
    });
  });
});
