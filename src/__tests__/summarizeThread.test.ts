import { describe, expect, it, beforeEach, vi } from "vitest";
import { summarizeColonyThreadAction, buildSummaryPrompt } from "../actions/summarizeThread.js";
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
  modelResponse: string | Error = "Summary of the thread...",
): IAgentRuntime {
  const base = fakeRuntime(service);
  return {
    ...base,
    useModel: vi.fn(async () => {
      if (modelResponse instanceof Error) throw modelResponse;
      return modelResponse;
    }),
  } as unknown as IAgentRuntime;
}

describe("buildSummaryPrompt", () => {
  it("includes post title, body, and all comments", () => {
    const post = { title: "Proposal X", body: "details", author: { username: "alice" } };
    const comments = [
      { body: "I agree with the first point", author: { username: "bob" } },
      { body: "Disagree on claim 2", author: { username: "carol" } },
    ];
    const prompt = buildSummaryPrompt(post, comments);
    expect(prompt).toContain("@alice");
    expect(prompt).toContain("Proposal X");
    expect(prompt).toContain("details");
    expect(prompt).toContain("@bob: I agree");
    expect(prompt).toContain("@carol: Disagree");
  });

  it("handles missing fields with placeholders", () => {
    const prompt = buildSummaryPrompt({}, []);
    expect(prompt).toContain("@unknown");
    expect(prompt).toContain("(untitled)");
  });

  it("caps comments shown at 50", () => {
    const post = { title: "x" };
    const comments = Array.from({ length: 80 }, (_, i) => ({ body: `c${i}`, author: { username: "u" } }));
    const prompt = buildSummaryPrompt(post, comments);
    expect(prompt).toContain("50. @u: c49");
    expect(prompt).not.toContain("51. @u: c50");
  });
});

describe("summarizeColonyThreadAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(null),
          fakeMessage(`summarize ${POST_URL}`),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await summarizeColonyThreadAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text field at all", async () => {
      expect(
        await summarizeColonyThreadAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without a summarize keyword", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(service),
          fakeMessage(POST_URL),
        ),
      ).toBe(false);
    });

    it("false when summarize keyword present but no post id", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(service),
          fakeMessage("summarize the discussion please"),
        ),
      ).toBe(false);
    });

    it("true for 'summarize <URL>'", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(service),
          fakeMessage(`summarize ${POST_URL}`),
        ),
      ).toBe(true);
    });

    it("true for 'catch me up on <URL>'", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(service),
          fakeMessage(`catch me up on ${POST_URL}`),
        ),
      ).toBe(true);
    });

    it("true for 'tldr <uuid>'", async () => {
      expect(
        await summarizeColonyThreadAction.validate(
          fakeRuntime(service),
          fakeMessage(`tldr ${UUID}`),
        ),
      ).toBe(true);
    });

    it("true when options.postId is provided", async () => {
      const msg = {
        content: { text: "summarize", postId: UUID },
      } as unknown as Memory;
      expect(
        await summarizeColonyThreadAction.validate(fakeRuntime(service), msg),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service missing", async () => {
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        fakeRuntime(null),
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports when no postId can be extracted", async () => {
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage("summarize please"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony post") }),
      );
    });

    it("reports when getPost fails", async () => {
      service.client.getPost.mockRejectedValue(new Error("404"));
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Couldn't fetch") }),
      );
    });

    it("reports empty-thread message when post has no comments", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        title: "Lonely post",
        author: { username: "alice" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => []);
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("no comments yet"),
        }),
      );
    });

    it("empty-thread message uses placeholders when post has no title/author", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => []);
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("@?");
      expect(text).toContain("(untitled)");
    });

    it("generates summary via useModel and includes thread link", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        title: "Big thread",
        body: "question",
        author: { username: "alice" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { body: "answer 1", author: { username: "bob" } },
        { body: "answer 2", author: { username: "carol" } },
      ]);
      const runtime = runtimeWithModel(service, "The thread debates X vs Y.");
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Big thread");
      expect(text).toContain("@alice");
      expect(text).toContain("2 comments");
      expect(text).toContain("The thread debates X vs Y.");
      expect(text).toContain(`https://thecolony.cc/post/${UUID}`);
    });

    it("reports when useModel fails", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { body: "x", author: { username: "b" } },
      ]);
      const runtime = runtimeWithModel(service, new Error("model unreachable"));
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("generation failed") }),
      );
    });

    it("falls back to getComments when getAllComments is missing", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => [
        { body: "x", author: { username: "b" } },
      ]);
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("1 comments") }),
      );
    });

    it("fallback to getComments returns items array when present", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => ({
        items: [{ body: "x", author: { username: "b" } }],
      }));
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("1 comments") }),
      );
    });

    it("returns empty-thread message when comment fetch methods all throw", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => {
        throw new Error("down");
      });
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("no comments yet") }),
      );
    });

    it("returns empty-thread message when client has no comment methods", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      // No getAllComments, no getComments
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("no comments yet") }),
      );
    });

    it("prefers options.postId over URL", async () => {
      const other = "99999999-9999-9999-9999-999999999999";
      service.client.getPost.mockResolvedValue({ id: other, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { body: "x", author: { username: "b" } },
      ]);
      const runtime = runtimeWithModel(service);
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        { postId: other },
        makeCallback(),
      );
      expect(service.client.getPost).toHaveBeenCalledWith(other);
    });

    it("respects temperature and maxTokens options", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { body: "x", author: { username: "b" } },
      ]);
      const runtime = runtimeWithModel(service);
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        { temperature: 0.5, maxTokens: 1000 },
        makeCallback(),
      );
      expect(runtime.useModel).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ temperature: 0.5, maxTokens: 1000 }),
      );
    });

    it("formats summary with '(untitled)' and '?' when post has no title or author", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        { body: "x", author: { username: "b" } },
      ]);
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("(untitled)");
      expect(text).toContain("@?");
    });

    it("treats getComments returning non-array without items as empty", async () => {
      service.client.getPost.mockResolvedValue({ id: UUID, author: { username: "a" } });
      // No getAllComments, so falls through to getComments
      (service.client as unknown as Record<string, unknown>).getComments = vi.fn(async () => ({}));
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("no comments yet") }),
      );
    });

    it("handles comment with missing author / body gracefully in summary prompt", async () => {
      service.client.getPost.mockResolvedValue({
        id: UUID,
        title: "T",
        author: { username: "a" },
      });
      (service.client as unknown as Record<string, unknown>).getAllComments = vi.fn(async () => [
        {}, // no author, no body
      ]);
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        fakeMessage(`summarize ${POST_URL}`),
        fakeState(),
        undefined,
        cb,
      );
      // Should not crash; useModel called with prompt containing @unknown
      expect(runtime.useModel).toHaveBeenCalled();
      const prompt = (runtime.useModel as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]![1] as { prompt: string };
      expect(prompt.prompt).toContain("@unknown");
    });

    it("handles message without text and no options", async () => {
      const runtime = runtimeWithModel(service);
      const cb = makeCallback();
      await summarizeColonyThreadAction.handler(
        runtime,
        messageWithoutText(),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("need a Colony post") }),
      );
    });
  });
});
