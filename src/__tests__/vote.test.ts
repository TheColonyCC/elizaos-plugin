import { describe, expect, it, beforeEach } from "vitest";
import { voteColonyAction } from "../actions/vote.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("voteColonyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(await voteColonyAction.validate(runtime, fakeMessage("upvote"))).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(await voteColonyAction.validate(runtime, fakeMessage(""))).toBe(false);
    });

    it("returns true for upvote keyword with a structural post target", async () => {
      // v0.21.0: validator now requires a structural target — either a
      // Colony post URL/UUID or an explicit `postId:` argument — so
      // plain "upvote that" doesn't fire.
      const runtime = fakeRuntime(service);
      expect(
        await voteColonyAction.validate(
          runtime,
          fakeMessage("upvote that, postId: 11111111-1111-1111-1111-111111111111"),
        ),
      ).toBe(true);
    });

    it("returns false for bare upvote keyword without a target", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await voteColonyAction.validate(runtime, fakeMessage("upvote that")),
      ).toBe(false);
    });

    it("returns true when message contains a Colony post URL", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await voteColonyAction.validate(
          runtime,
          fakeMessage(
            "upvote https://thecolony.cc/post/11111111-1111-1111-1111-111111111111",
          ),
        ),
      ).toBe(true);
    });

    it("returns false when no vote-related keyword", async () => {
      const runtime = fakeRuntime(service);
      expect(await voteColonyAction.validate(runtime, fakeMessage("hello"))).toBe(false);
    });

    it("returns false when content has no text", async () => {
      const runtime = fakeRuntime(service);
      expect(await voteColonyAction.validate(runtime, messageWithoutText())).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await voteColonyAction.handler!(runtime, fakeMessage("upvote"), fakeState(), {}, cb);
      expect(cb).not.toHaveBeenCalled();
    });

    it("prompts when neither postId nor commentId provided", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await voteColonyAction.handler!(runtime, fakeMessage(""), fakeState(), {}, cb);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ action: "VOTE_COLONY_POST" }),
      );
    });

    it("upvotes a post with default value +1", async () => {
      service.client.votePost.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await voteColonyAction.handler!(
        runtime,
        fakeMessage("upvote"),
        fakeState(),
        { postId: "p1" },
        cb,
      );
      expect(service.client.votePost).toHaveBeenCalledWith("p1", 1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Upvoted"),
          action: "VOTE_COLONY_POST",
        }),
      );
    });

    it("downvotes a comment when value < 0", async () => {
      service.client.voteComment.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await voteColonyAction.handler!(
        runtime,
        fakeMessage("downvote"),
        fakeState(),
        { commentId: "c1", value: -1 },
        cb,
      );
      expect(service.client.voteComment).toHaveBeenCalledWith("c1", -1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Downvoted"),
          action: "VOTE_COLONY_POST",
        }),
      );
    });

    it("coerces string values numerically", async () => {
      service.client.votePost.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await voteColonyAction.handler!(
        runtime,
        fakeMessage("vote"),
        fakeState(),
        { postId: "p2", value: "-1" },
        cb,
      );
      expect(service.client.votePost).toHaveBeenCalledWith("p2", -1);
    });

    it("reports SDK errors", async () => {
      service.client.votePost.mockRejectedValue(new Error("self-vote"));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await voteColonyAction.handler!(
        runtime,
        fakeMessage("upvote"),
        fakeState(),
        { postId: "p1" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("self-vote"),
          action: "VOTE_COLONY_POST",
        }),
      );
    });
  });
});
