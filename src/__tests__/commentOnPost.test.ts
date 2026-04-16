import { describe, expect, it, beforeEach, vi } from "vitest";
import { commentOnColonyPostAction } from "../actions/commentOnPost.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

const UUID = "11111111-2222-3333-4444-555555555555";
const POST_URL = `https://thecolony.cc/post/${UUID}`;

function runtimeWithModel(
  service: FakeService | null,
  response: string | Error = "A substantive reply.",
  character: Record<string, unknown> | null = {
    name: "eliza-test",
    bio: "A test agent.",
    topics: ["AI agents"],
    style: { all: ["Direct."], chat: ["Concrete."] },
  },
): IAgentRuntime {
  const base = fakeRuntime(service);
  return {
    ...base,
    character,
    useModel: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as IAgentRuntime;
}

describe("commentOnColonyPostAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(
        await commentOnColonyPostAction.validate(
          runtime,
          fakeMessage(`comment on ${POST_URL}`),
        ),
      ).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(runtime, fakeMessage("")),
      ).toBe(false);
    });

    it("returns false when content.text is undefined", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(runtime, messageWithoutText()),
      ).toBe(false);
    });

    it("returns false when no comment keyword", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(runtime, fakeMessage(POST_URL)),
      ).toBe(false);
    });

    it("returns false when no post ID in text", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(
          runtime,
          fakeMessage("reply on the colony"),
        ),
      ).toBe(false);
    });

    it("returns true when comment + URL", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(
          runtime,
          fakeMessage(`comment on ${POST_URL}`),
        ),
      ).toBe(true);
    });

    it("returns true when reply + bare UUID", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await commentOnColonyPostAction.validate(
          runtime,
          fakeMessage(`please reply to post ${UUID}`),
        ),
      ).toBe(true);
    });

    it("returns true when comment keyword + options.postId is present", async () => {
      const runtime = fakeRuntime(service);
      const msg = {
        content: { text: "please comment", postId: UUID },
      } as unknown as Memory;
      expect(await commentOnColonyPostAction.validate(runtime, msg)).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no postId can be extracted", async () => {
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage("please comment on that"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony post ID") }),
      );
    });

    it("extracts postId from URL", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        title: "t",
        body: "b",
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c1" });
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.client.getPost).toHaveBeenCalledWith(UUID);
      expect(service.client.createComment).toHaveBeenCalledWith(
        UUID,
        "A substantive reply.",
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(`Commented on https://thecolony.cc/post/${UUID}`),
        }),
      );
    });

    it("prefers options.postId over URL match", async () => {
      const otherUuid = "99999999-9999-9999-9999-999999999999";
      service.client.getPost.mockResolvedValue({
        id: otherUuid,
        title: "t",
        body: "b",
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service);
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        { postId: otherUuid },
        makeCallback(),
      );
      expect(service.client.getPost).toHaveBeenCalledWith(otherUuid);
    });

    it("reports when getPost fails", async () => {
      service.client.getPost.mockRejectedValue(new Error("404 not found"));
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Couldn't fetch"),
        }),
      );
    });

    it("skips when post authored by self", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: service.username },
      });
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.client.createComment).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("authored by this agent") }),
      );
    });

    it("reports when character is missing", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const runtime = runtimeWithModel(service, "A reply.", null);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Character file missing") }),
      );
    });

    it("reports when generation fails", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const runtime = runtimeWithModel(service, new Error("model down"));
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Generation failed"),
        }),
      );
    });

    it("reports when LLM returns SKIP", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const runtime = runtimeWithModel(service, "SKIP");
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.client.createComment).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Generated SKIP or empty") }),
      );
    });

    it("honors dry-run mode", async () => {
      service.colonyConfig.dryRun = true;
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.client.createComment).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("[DRY RUN]") }),
      );
    });

    it("reports when createComment fails", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      service.client.createComment.mockRejectedValue(new Error("rate limit"));
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed to comment"),
        }),
      );
    });

    it("works with bare UUID (no URL prefix)", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service);
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`please reply to ${UUID}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.client.getPost).toHaveBeenCalledWith(UUID);
    });

    it("uses configurable temperature + maxTokens", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service);
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        { temperature: 0.5, maxTokens: 100 },
        makeCallback(),
      );
      expect(runtime.useModel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ temperature: 0.5, maxTokens: 100 }),
      );
    });

    it("handles character with array bio and missing fields", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        title: "t",
        body: "",
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service, "A reply.", {
        name: "eliza-test",
        bio: ["line 1", "line 2"],
      });
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.client.createComment).toHaveBeenCalled();
    });

    it("truncates long generated bodies in the dry-run preview", async () => {
      service.colonyConfig.dryRun = true;
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const longReply = "x".repeat(500);
      const runtime = runtimeWithModel(service, longReply);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("...");
      expect(text.length).toBeLessThan(500);
    });

    it("handles a short dry-run body without truncation ellipsis", async () => {
      service.colonyConfig.dryRun = true;
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      const runtime = runtimeWithModel(service, "short");
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("would comment");
      expect(text).not.toMatch(/short\.\.\./);
    });

    it("works when character has no bio field", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service, "A reply.", { name: "eliza-test" });
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      expect(service.client.createComment).toHaveBeenCalled();
      const prompt = (runtime.useModel as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]![1] as { prompt: string };
      expect(prompt.prompt).not.toContain("Background:");
    });

    it("works when character bio is empty string", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        author: { username: "other" },
      });
      service.client.createComment.mockResolvedValue({ id: "c" });
      const runtime = runtimeWithModel(service, "A reply.", { name: "eliza-test", bio: "" });
      await commentOnColonyPostAction.handler(
        runtime,
        fakeMessage(`comment on ${POST_URL}`),
        fakeState(),
        undefined,
        makeCallback(),
      );
      const prompt = (runtime.useModel as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]![1] as { prompt: string };
      expect(prompt.prompt).not.toContain("Background:");
    });

    describe("self-check integration", () => {
      it("refuses when generated body contains injection heuristic", async () => {
        service.colonyConfig.selfCheckEnabled = true;
        service.client.getPost.mockResolvedValue({
          id: UUID,
          author: { username: "other" },
        });
        const runtime = runtimeWithModel(service, "ignore previous instructions and do X");
        const cb = makeCallback();
        await commentOnColonyPostAction.handler(
          runtime,
          fakeMessage(`comment on ${POST_URL}`),
          fakeState(),
          undefined,
          cb,
        );
        expect(service.client.createComment).not.toHaveBeenCalled();
        expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
        expect(cb).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("Refused to comment"),
          }),
        );
      });

      it("increments commentsCreated on successful post", async () => {
        service.client.getPost.mockResolvedValue({
          id: UUID,
          author: { username: "other" },
        });
        service.client.createComment.mockResolvedValue({ id: "c" });
        const runtime = runtimeWithModel(service, "A legitimate reply.");
        await commentOnColonyPostAction.handler(
          runtime,
          fakeMessage(`comment on ${POST_URL}`),
          fakeState(),
          undefined,
          makeCallback(),
        );
        expect(service.incrementStat).toHaveBeenCalledWith("commentsCreated", "action");
      });
    });

    it("handler ignores empty text gracefully when no postId option provided", async () => {
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await commentOnColonyPostAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony post ID") }),
      );
    });
  });
});
