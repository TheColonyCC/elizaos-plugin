import { describe, expect, it, beforeEach } from "vitest";
import { searchColonyAction } from "../actions/search.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("searchColonyAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(
        await searchColonyAction.validate(runtime, fakeMessage("search the colony")),
      ).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(await searchColonyAction.validate(runtime, fakeMessage(""))).toBe(false);
    });

    it("returns false when 'colony' not mentioned", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await searchColonyAction.validate(runtime, fakeMessage("search for stuff")),
      ).toBe(false);
    });

    it("returns true when colony + keyword present", async () => {
      const runtime = fakeRuntime(service);
      expect(
        await searchColonyAction.validate(runtime, fakeMessage("search the colony for benchmarks")),
      ).toBe(true);
    });

    it("returns false when message has no text", async () => {
      const runtime = fakeRuntime(service);
      expect(await searchColonyAction.validate(runtime, messageWithoutText())).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x" },
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("prompts when query is empty", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        {},
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ action: "SEARCH_COLONY" }),
      );
      expect(service.client.search).not.toHaveBeenCalled();
    });

    it("formats post and user results", async () => {
      service.client.search.mockResolvedValue({
        items: [
          { id: "p1", title: "Hello", author: { username: "alice" } },
          { id: "p2", title: "World", author: { username: "bob" } },
        ],
        users: [
          { username: "carol", karma: 42 },
        ],
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "hello world", limit: 5, colony: "findings", sort: "newest" },
        cb,
      );
      expect(service.client.search).toHaveBeenCalledWith("hello world", {
        limit: 5,
        colony: "findings",
        sort: "newest",
      });
      const text = cb.mock.calls[0][0].text;
      expect(text).toContain("Hello");
      expect(text).toContain("@alice");
      expect(text).toContain("@carol");
      expect(text).toContain("karma: 42");
    });

    it("reports zero results", async () => {
      service.client.search.mockResolvedValue({ items: [], users: [] });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "obscure" },
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("No results");
    });

    it("handles missing items/users arrays", async () => {
      service.client.search.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x" },
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("No results");
    });

    it("handles posts without title or author", async () => {
      service.client.search.mockResolvedValue({
        items: [{ id: "p3" }],
        users: [{ karma: 0 }],
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x" },
        cb,
      );
      const text = cb.mock.calls[0][0].text;
      expect(text).toContain("(untitled)");
      expect(text).toContain("@unknown");
    });

    it("handles users with username but no karma field", async () => {
      service.client.search.mockResolvedValue({
        items: [],
        users: [{ username: "carol" }],
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "carol" },
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("karma: 0");
    });

    it("clamps limit above 50 to 50 and falls back to 10 on invalid", async () => {
      service.client.search.mockResolvedValue({ items: [], users: [] });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x", limit: 999 },
        cb,
      );
      expect(service.client.search).toHaveBeenCalledWith(
        "x",
        expect.objectContaining({ limit: 50 }),
      );
      service.client.search.mockClear();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x", limit: 0 },
        cb,
      );
      expect(service.client.search).toHaveBeenCalledWith(
        "x",
        expect.objectContaining({ limit: 10 }),
      );
    });

    it("reports SDK errors", async () => {
      service.client.search.mockRejectedValue(new Error("rate-limited"));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await searchColonyAction.handler!(
        runtime,
        fakeMessage("search colony"),
        fakeState(),
        { query: "x" },
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("rate-limited"),
          action: "SEARCH_COLONY",
        }),
      );
    });
  });

  it("exposes metadata", () => {
    expect(searchColonyAction.name).toBe("SEARCH_COLONY");
    expect(searchColonyAction.examples?.length).toBeGreaterThan(0);
  });
});
