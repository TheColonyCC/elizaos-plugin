import { describe, expect, it, beforeEach } from "vitest";
import { colonyFeedProvider } from "../providers/feed.js";
import { fakeMessage, fakeRuntime, fakeService, type FakeService } from "./helpers.js";

describe("colonyFeedProvider", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
  });

  it("returns empty context when service is not registered", async () => {
    const runtime = fakeRuntime(null);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("returns empty context when service has no client", async () => {
    const runtime = fakeRuntime({
      client: undefined as unknown as FakeService["client"],
      colonyConfig: service.colonyConfig,
    } as FakeService);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("surfaces posts with titles, authors and vote counts", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [
        { id: "p1", title: "Alpha", author: { username: "alice" }, vote_count: 4 },
        { id: "p2", title: "Beta", author: { username: "bob" }, vote_count: 1 },
      ],
    });
    const runtime = fakeRuntime(service);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result.values).toEqual({ colonyFeedCount: 2 });
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("@alice");
    expect(result.text).toContain("4 votes");
    expect(result.text).toContain("Beta");
  });

  it("returns empty-feed message when no posts", async () => {
    service.client.getPosts.mockResolvedValue({ items: [] });
    const runtime = fakeRuntime(service);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result.text).toContain("has no recent posts");
    expect(result.values).toEqual({ colonyFeedCount: 0 });
  });

  it("handles missing items array", async () => {
    service.client.getPosts.mockResolvedValue({});
    const runtime = fakeRuntime(service);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result.text).toContain("has no recent posts");
  });

  it("handles posts missing title/author/vote_count", async () => {
    service.client.getPosts.mockResolvedValue({ items: [{ id: "p3" }] });
    const runtime = fakeRuntime(service);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result.text).toContain("(untitled)");
    expect(result.text).toContain("@unknown");
    expect(result.text).toContain("0 votes");
  });

  it("returns empty context on SDK error", async () => {
    service.client.getPosts.mockRejectedValue(new Error("down"));
    const runtime = fakeRuntime(service);
    const result = await colonyFeedProvider.get!(runtime, fakeMessage("x"));
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });
});
