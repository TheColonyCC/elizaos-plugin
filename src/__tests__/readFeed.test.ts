import { describe, expect, it, beforeEach } from "vitest";
import { readColonyFeedAction } from "../actions/readFeed.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("readColonyFeedAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      const runtime = fakeRuntime(null);
      expect(await readColonyFeedAction.validate(runtime, fakeMessage("read colony feed"))).toBe(false);
    });

    it("returns false for empty text", async () => {
      const runtime = fakeRuntime(service);
      expect(await readColonyFeedAction.validate(runtime, fakeMessage(""))).toBe(false);
    });

    it("returns false when 'colony' not mentioned", async () => {
      const runtime = fakeRuntime(service);
      expect(await readColonyFeedAction.validate(runtime, fakeMessage("read latest feed"))).toBe(false);
    });

    it("returns true when colony + keyword both present", async () => {
      const runtime = fakeRuntime(service);
      expect(await readColonyFeedAction.validate(runtime, fakeMessage("read colony feed"))).toBe(true);
    });

    it("returns false when keywords absent even with 'colony'", async () => {
      const runtime = fakeRuntime(service);
      expect(await readColonyFeedAction.validate(runtime, fakeMessage("colony stuff"))).toBe(false);
    });

    it("returns false when content has no text", async () => {
      const runtime = fakeRuntime(service);
      expect(await readColonyFeedAction.validate(runtime, messageWithoutText())).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const runtime = fakeRuntime(null);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(runtime, fakeMessage("read colony"), fakeState(), {}, cb);
      expect(cb).not.toHaveBeenCalled();
    });

    it("formats recent posts into a text list", async () => {
      service.client.getPosts.mockResolvedValue({
        items: [
          { id: "p1", title: "First", author: { username: "alice" } },
          { id: "p2", title: "Second", author: { username: "bob" } },
        ],
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony feed"),
        fakeState(),
        {},
        cb,
      );
      expect(service.client.getPosts).toHaveBeenCalledWith({
        colony: "general",
        limit: 10,
        sort: "new",
      });
      const call = cb.mock.calls[0][0];
      expect(call.text).toContain("First");
      expect(call.text).toContain("@alice");
      expect(call.text).toContain("Second");
    });

    it("handles empty feed gracefully", async () => {
      service.client.getPosts.mockResolvedValue({ items: [] });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        { colony: "findings", limit: 5 },
        cb,
      );
      expect(service.client.getPosts).toHaveBeenCalledWith({
        colony: "findings",
        limit: 5,
        sort: "new",
      });
      expect(cb.mock.calls[0][0].text).toContain("No recent posts");
    });

    it("falls back to default limit when option is zero", async () => {
      service.client.getPosts.mockResolvedValue({ items: [] });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        { limit: 0 },
        cb,
      );
      expect(service.client.getPosts).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    });

    it("accepts a custom sort option", async () => {
      service.client.getPosts.mockResolvedValue({ items: [] });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        { sort: "top" },
        cb,
      );
      expect(service.client.getPosts).toHaveBeenCalledWith(
        expect.objectContaining({ sort: "top" }),
      );
    });

    it("handles posts with missing title and author gracefully", async () => {
      service.client.getPosts.mockResolvedValue({
        items: [{ id: "p3" }],
      });
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        {},
        cb,
      );
      const text = cb.mock.calls[0][0].text;
      expect(text).toContain("(untitled)");
      expect(text).toContain("@unknown");
    });

    it("handles missing items array gracefully", async () => {
      service.client.getPosts.mockResolvedValue({});
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        {},
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("No recent posts");
    });

    it("reports SDK errors", async () => {
      service.client.getPosts.mockRejectedValue(new Error("rate-limited"));
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await readColonyFeedAction.handler!(
        runtime,
        fakeMessage("read colony"),
        fakeState(),
        {},
        cb,
      );
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("rate-limited"),
          action: "READ_COLONY_FEED",
        }),
      );
    });
  });
});
