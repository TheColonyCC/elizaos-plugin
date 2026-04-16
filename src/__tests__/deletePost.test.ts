import { describe, expect, it, beforeEach, vi } from "vitest";
import { deleteColonyPostAction, deleteColonyCommentAction } from "../actions/deletePost.js";
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

const UUID = "11111111-2222-3333-4444-555555555555";
const POST_URL = `https://thecolony.cc/post/${UUID}`;

describe("deleteColonyPostAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).deletePost = vi.fn(async () => ({}));
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await deleteColonyPostAction.validate(
          fakeRuntime(null),
          fakeMessage(`delete ${POST_URL}`),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await deleteColonyPostAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false without a delete keyword", async () => {
      expect(
        await deleteColonyPostAction.validate(fakeRuntime(service), fakeMessage(POST_URL)),
      ).toBe(false);
    });

    it("false without a post id", async () => {
      expect(
        await deleteColonyPostAction.validate(
          fakeRuntime(service),
          fakeMessage("delete something"),
        ),
      ).toBe(false);
    });

    it("false when message text has no content.text", async () => {
      expect(
        await deleteColonyPostAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false when message asks about a comment (defers to DELETE_COLONY_COMMENT)", async () => {
      expect(
        await deleteColonyPostAction.validate(
          fakeRuntime(service),
          fakeMessage(`delete that comment ${UUID}`),
        ),
      ).toBe(false);
    });

    it("true for delete + URL", async () => {
      expect(
        await deleteColonyPostAction.validate(
          fakeRuntime(service),
          fakeMessage(`delete ${POST_URL}`),
        ),
      ).toBe(true);
    });

    it("true for retract + options.postId", async () => {
      const msg = {
        content: { text: "retract that", postId: UUID },
      } as unknown as Memory;
      expect(await deleteColonyPostAction.validate(fakeRuntime(service), msg)).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await deleteColonyPostAction.handler(
        fakeRuntime(null),
        fakeMessage(`delete ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no postId can be extracted", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await deleteColonyPostAction.handler(
        runtime,
        fakeMessage("delete the post"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony post") }),
      );
    });

    it("calls client.deletePost and reports success", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await deleteColonyPostAction.handler(
        runtime,
        fakeMessage(`delete ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).deletePost,
      ).toHaveBeenCalledWith(UUID);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Deleted post") }),
      );
    });

    it("prefers options.postId over URL match", async () => {
      const other = "99999999-9999-9999-9999-999999999999";
      const runtime = fakeRuntime(service);
      await deleteColonyPostAction.handler(
        runtime,
        fakeMessage(`delete ${POST_URL}`),
        fakeState(),
        { postId: other },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).deletePost,
      ).toHaveBeenCalledWith(other);
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).deletePost = vi.fn(async () => {
        throw new Error("403 forbidden");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await deleteColonyPostAction.handler(
        runtime,
        fakeMessage(`delete ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to delete") }),
      );
    });

    it("records activity on successful delete", async () => {
      const runtime = fakeRuntime(service);
      await deleteColonyPostAction.handler(
        runtime,
        fakeMessage(`delete ${POST_URL}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.recordActivity).toHaveBeenCalledWith(
        "post_created",
        UUID,
        expect.stringContaining("deleted"),
      );
    });

    it("handles messageWithoutText with postId option", async () => {
      const runtime = fakeRuntime(service);
      await deleteColonyPostAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        { postId: UUID },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).deletePost,
      ).toHaveBeenCalled();
    });
  });
});

describe("deleteColonyCommentAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).raw = vi.fn(async () => ({}));
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await deleteColonyCommentAction.validate(
          fakeRuntime(null),
          fakeMessage(`delete comment ${UUID}`),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await deleteColonyCommentAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text", async () => {
      expect(
        await deleteColonyCommentAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false when message lacks 'comment' keyword (defers to DELETE_POST)", async () => {
      expect(
        await deleteColonyCommentAction.validate(
          fakeRuntime(service),
          fakeMessage(`delete ${UUID}`),
        ),
      ).toBe(false);
    });

    it("false when message has 'comment' but no delete keyword", async () => {
      expect(
        await deleteColonyCommentAction.validate(
          fakeRuntime(service),
          fakeMessage(`look at this comment ${UUID}`),
        ),
      ).toBe(false);
    });

    it("false without an id", async () => {
      expect(
        await deleteColonyCommentAction.validate(
          fakeRuntime(service),
          fakeMessage("delete that comment"),
        ),
      ).toBe(false);
    });

    it("true for 'delete comment <uuid>'", async () => {
      expect(
        await deleteColonyCommentAction.validate(
          fakeRuntime(service),
          fakeMessage(`delete comment ${UUID}`),
        ),
      ).toBe(true);
    });

    it("true for 'delete that comment' + options.commentId", async () => {
      const msg = {
        content: { text: "delete that comment", commentId: UUID },
      } as unknown as Memory;
      expect(await deleteColonyCommentAction.validate(fakeRuntime(service), msg)).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await deleteColonyCommentAction.handler(
        fakeRuntime(null),
        fakeMessage(`delete comment ${UUID}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no commentId", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await deleteColonyCommentAction.handler(
        runtime,
        fakeMessage("delete comment"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony comment") }),
      );
    });

    it("calls client.raw DELETE /comments/{id}", async () => {
      const runtime = fakeRuntime(service);
      await deleteColonyCommentAction.handler(
        runtime,
        fakeMessage(`delete comment ${UUID}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).raw,
      ).toHaveBeenCalledWith("DELETE", `/comments/${UUID}`);
    });

    it("prefers options.commentId over message match", async () => {
      const other = "99999999-9999-9999-9999-999999999999";
      const runtime = fakeRuntime(service);
      await deleteColonyCommentAction.handler(
        runtime,
        fakeMessage(`delete comment ${UUID}`),
        fakeState(),
        { commentId: other },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).raw,
      ).toHaveBeenCalledWith("DELETE", `/comments/${other}`);
    });

    it("surfaces SDK error", async () => {
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).raw = vi.fn(async () => {
        throw new Error("403");
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await deleteColonyCommentAction.handler(
        runtime,
        fakeMessage(`delete comment ${UUID}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Failed to delete comment") }),
      );
    });

    it("records activity on successful delete", async () => {
      const runtime = fakeRuntime(service);
      await deleteColonyCommentAction.handler(
        runtime,
        fakeMessage(`delete comment ${UUID}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.recordActivity).toHaveBeenCalledWith(
        "comment_created",
        UUID,
        expect.stringContaining("deleted"),
      );
    });

    it("handles messageWithoutText with commentId option", async () => {
      const runtime = fakeRuntime(service);
      await deleteColonyCommentAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        { commentId: UUID },
        makeCallback(),
      );
      expect(
        (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>).raw,
      ).toHaveBeenCalled();
    });
  });
});
