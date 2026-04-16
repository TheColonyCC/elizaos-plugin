/**
 * Consolidated tests for v0.15.0 features: hybrid title quality (marker
 * + LLM fallback), watch-list ↔ engagement integration, post type
 * auto-detection, and the COLONY_FIRST_RUN onboarding action.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";
import {
  splitTitleBody,
  generateTitleFromBody,
  ColonyPostClient,
} from "../services/post-client.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { colonyFirstRunAction, generateIntro } from "../actions/firstRun.js";
import { DraftQueue } from "../services/draft-queue.js";
import { writeWatchList, type WatchEntry } from "../actions/watchPost.js";

// ──────────────────────────────────────────────────────────────────────
// splitTitleBody — marker parsing + type detection
// ──────────────────────────────────────────────────────────────────────
describe("splitTitleBody (v0.15.0)", () => {
  it("extracts title from a Title: marker on line 1", () => {
    const out = splitTitleBody("Title: Hello world\n\nThe body text.");
    expect(out).toMatchObject({
      title: "Hello world",
      body: "The body text.",
      titleFromMarker: true,
    });
  });

  it("also recognizes the em-dash separator", () => {
    const out = splitTitleBody("Title — Hello world\n\nBody.");
    expect(out.title).toBe("Hello world");
    expect(out.titleFromMarker).toBe(true);
  });

  it("accepts a hyphen separator", () => {
    const out = splitTitleBody("Title - Hello world\n\nBody.");
    expect(out.title).toBe("Hello world");
    expect(out.titleFromMarker).toBe(true);
  });

  it("extracts optional Type: marker on the next line", () => {
    const out = splitTitleBody("Title: Foo\nType: question\n\nBody.");
    expect(out).toMatchObject({
      title: "Foo",
      body: "Body.",
      postType: "question",
      titleFromMarker: true,
    });
  });

  it("accepts all four canonical post types", () => {
    for (const t of ["discussion", "finding", "question", "analysis"]) {
      const out = splitTitleBody(`Title: X\nType: ${t}\n\nB.`);
      expect(out.postType).toBe(t);
    }
  });

  it("ignores an unknown Type value", () => {
    const out = splitTitleBody("Title: X\nType: gibberish\n\nBody.");
    expect(out.postType).toBeUndefined();
    // The unknown Type line should NOT be dropped from the body
    expect(out.body).toContain("Type: gibberish");
  });

  it("tolerates a blank line between Title and Type", () => {
    const out = splitTitleBody("Title: X\n\nType: finding\n\nBody.");
    expect(out.postType).toBe("finding");
    expect(out.body).toBe("Body.");
  });

  it("heuristic fallback when no Title: marker", () => {
    const out = splitTitleBody("Just a body paragraph with no marker.");
    expect(out.titleFromMarker).toBe(false);
    expect(out.title).toBe("Just a body paragraph with no marker.");
  });

  it("truncates a long heuristic title to 120 chars", () => {
    const long = "x".repeat(300);
    const out = splitTitleBody(long);
    expect(out.title.length).toBe(120);
    expect(out.titleFromMarker).toBe(false);
  });

  it("returns Untitled for empty input", () => {
    const out = splitTitleBody("");
    expect(out.title).toBe("Untitled");
    expect(out.body).toBe("");
  });

  it("falls back to trimmed content when title-only", () => {
    const out = splitTitleBody("Title: Only title\n\n");
    // Body empty → falls back to full trimmed content
    expect(out.body).toContain("Title: Only title");
  });

  it("caps title from marker at 200 chars", () => {
    const long = "a".repeat(400);
    const out = splitTitleBody(`Title: ${long}\n\nBody.`);
    expect(out.title.length).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
// generateTitleFromBody — cheap LLM headline generator
// ──────────────────────────────────────────────────────────────────────
describe("generateTitleFromBody (v0.15.0)", () => {
  it("returns cleaned headline from the model", async () => {
    const runtime = {
      useModel: vi.fn(async () => "  A clean headline  "),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBe("A clean headline");
  });

  it("strips wrapping quotes", async () => {
    const runtime = {
      useModel: vi.fn(async () => '"Quoted headline"'),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBe("Quoted headline");
  });

  it("strips smart quotes", async () => {
    const runtime = {
      useModel: vi.fn(async () => "“Smart quotes headline”"),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBe("Smart quotes headline");
  });

  it("keeps only first line", async () => {
    const runtime = {
      useModel: vi.fn(async () => "First line\nSecond line\nThird"),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBe("First line");
  });

  it("returns null when model returns empty", async () => {
    const runtime = {
      useModel: vi.fn(async () => "   "),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBeNull();
  });

  it("returns null when cleaned result is empty", async () => {
    const runtime = {
      useModel: vi.fn(async () => '""'),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBeNull();
  });

  it("returns null on useModel failure", async () => {
    const runtime = {
      useModel: vi.fn(async () => {
        throw new Error("model down");
      }),
    } as unknown as IAgentRuntime;
    expect(await generateTitleFromBody(runtime, "body")).toBeNull();
  });

  it("slices body to 2000 chars for prompt", async () => {
    const big = "x".repeat(10_000);
    const useModel = vi.fn(async () => "Headline");
    const runtime = { useModel } as unknown as IAgentRuntime;
    await generateTitleFromBody(runtime, big);
    const prompt = (useModel.mock.calls[0]![1] as { prompt: string }).prompt;
    // Prompt template + 2000 body chars + trailing text
    expect(prompt.length).toBeLessThan(2500);
  });

  it("uses passed-through modelType and maxTokens options", async () => {
    const useModel = vi.fn(async () => "Headline");
    const runtime = { useModel } as unknown as IAgentRuntime;
    await generateTitleFromBody(runtime, "body", {
      modelType: "TEXT_LARGE",
      maxTokens: 80,
    });
    expect(useModel).toHaveBeenCalledWith(
      "TEXT_LARGE",
      expect.objectContaining({ maxTokens: 80, temperature: 0.3 }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// PostClient tick uses generateTitleFromBody when no marker
// ──────────────────────────────────────────────────────────────────────
describe("ColonyPostClient title fallback (v0.15.0)", () => {
  let service: FakeService;
  const config = (overrides = {}) => ({
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colony: "general",
    maxTokens: 280,
    temperature: 0.9,
    selfCheck: false,
    dailyLimit: 0,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    service.client.createPost.mockResolvedValue({ id: "post-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to generateTitleFromBody when marker is missing", async () => {
    let i = 0;
    const useModel = vi.fn(async () => {
      return ["A body paragraph without a title marker.", "Smart Headline"][i++];
    });
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;

    const c = new ColonyPostClient(service as never, runtime, config());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(service.client.createPost).toHaveBeenCalledWith(
      "Smart Headline",
      expect.any(String),
      expect.any(Object),
    );
    await c.stop();
  });

  it("skips the fallback when marker is present", async () => {
    const useModel = vi.fn(async () =>
      "Title: Marker Headline\n\nThe body here.",
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;

    const c = new ColonyPostClient(service as never, runtime, config());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(service.client.createPost).toHaveBeenCalledWith(
      "Marker Headline",
      expect.any(String),
      expect.any(Object),
    );
    await c.stop();
  });

  it("routes detected postType into createPost metadata", async () => {
    const useModel = vi.fn(async () =>
      "Title: X\nType: finding\n\nThe finding body.",
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;

    const c = new ColonyPostClient(service as never, runtime, config({
      postType: "discussion",
    }));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // The detected type (finding) should override the config default (discussion)
    const call = service.client.createPost.mock.calls[0];
    expect(call[2]).toMatchObject({ postType: "finding" });
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Watch-list → engagement-client integration
// ──────────────────────────────────────────────────────────────────────
describe("Engagement client watch-list integration (v0.15.0)", () => {
  let service: FakeService;
  const cfg = (overrides = {}) => ({
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colonies: ["general"],
    candidateLimit: 5,
    maxTokens: 240,
    temperature: 0.8,
    selfCheck: false,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRuntime(
    store: Map<string, unknown>,
    useModelImpl: (...args: unknown[]) => unknown = () => "A substantive reply.",
  ): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(useModelImpl),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
  }

  it("engages a watched post when comment_count grew", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    const entries: WatchEntry[] = [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ];
    await writeWatchList(runtime, service.username, entries);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "Watched post",
      body: "watched body",
      comment_count: 3,
    });
    service.client.createComment.mockResolvedValue({ id: "c-new" });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);

    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-watched",
      expect.any(String),
      undefined,
    );
    // Baseline got rewritten to the new count
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    expect(list[0]!.lastCommentCount).toBe(3);
    await c.stop();
  });

  it("skips watched engagement when comment_count hasn't grown", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 5 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 5,
    });
    // No eligible fresh posts either
    service.client.getPosts.mockResolvedValue({ items: [] });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });

  it("tolerates getPost errors on a watched entry and moves on", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-broken", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockRejectedValue(new Error("404"));
    service.client.getPosts.mockResolvedValue({ items: [] });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });

  it("dry-run path on a watched post updates baseline without commenting", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "Watched",
      body: "body",
      comment_count: 2,
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg({
      dryRun: true,
    }));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    expect(list[0]!.lastCommentCount).toBe(2);
    await c.stop();
  });

  it("approval mode queues a draft and updates baseline on watched engagement", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "Watched",
      body: "body",
      comment_count: 4,
    });
    const draftQueue = new DraftQueue(runtime, service.username ?? "anon", {
      maxAgeMs: 60_000,
      maxPending: 10,
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg({
      approvalRequired: true,
      draftQueue,
    }));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    const pending = await draftQueue.pending();
    expect(pending.length).toBe(1);
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    expect(list[0]!.lastCommentCount).toBe(4);
    await c.stop();
  });

  it("handles watched getPost failure during engageWithWatched (already picked)", async () => {
    // First getPost (in picker) returns fresh count. Second (in engager) fails.
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    let n = 0;
    service.client.getPost.mockImplementation(async () => {
      if (n++ === 0) return { id: "post-watched", comment_count: 2 } as unknown;
      throw new Error("ref");
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });

  it("self-check rejects watched engagement as SPAM", async () => {
    const store = new Map<string, unknown>();
    let n = 0;
    const runtime = makeRuntime(store, () => {
      // first call = generation, second = scorer → SPAM
      return [
        "A substantive reply.",
        "SPAM",
      ][n++] ?? "SKIP";
    });
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 2,
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg({
      selfCheck: true,
    }));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    // Baseline stays put (don't swallow the re-engagement opportunity)
    expect(list[0]!.lastCommentCount).toBe(0);
    await c.stop();
  });

  it("createComment failure on a watched post is logged, no baseline update", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 2,
    });
    service.client.createComment.mockRejectedValue(new Error("500"));

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    expect(list[0]!.lastCommentCount).toBe(0);
    await c.stop();
  });

  it("empty watch list falls through to round-robin engagement", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    // No watch list entries at all
    service.client.getPosts.mockResolvedValue({ items: [] });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // No errors, and no calls because no candidates either
    expect(service.client.getPosts).toHaveBeenCalled();
    await c.stop();
  });

  it("tolerates a missing comment_count field on watched post", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store);
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({ id: "post-watched" });
    service.client.getPosts.mockResolvedValue({ items: [] });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // 0 > 0 is false, falls through; no comment call
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });

  it("empty generated content skips watched engagement", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store, () => "");
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 2,
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });

  it("generation failure on watched post returns silently", async () => {
    const store = new Map<string, unknown>();
    const runtime = makeRuntime(store, () => {
      throw new Error("model down");
    });
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 2,
    });

    const c = new ColonyEngagementClient(service as never, runtime, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// COLONY_FIRST_RUN action
// ──────────────────────────────────────────────────────────────────────
describe("colonyFirstRunAction (v0.15.0)", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [
        { id: "u1", username: "alice", karma: 500 },
        { id: "u2", username: "bob", karma: 300 },
      ],
    );
    service.client.createPost.mockResolvedValue({ id: "post-intro" });
  });

  it("validate: true for 'colony first run'", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(service),
        fakeMessage("colony first run"),
      ),
    ).toBe(true);
  });

  it("validate: true for 'bootstrap colony'", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(service),
        fakeMessage("please bootstrap colony"),
      ),
    ).toBe(true);
  });

  it("validate: true for 'onboard colony'", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(service),
        fakeMessage("onboard colony agent"),
      ),
    ).toBe(true);
  });

  it("validate: false when service missing", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(null),
        fakeMessage("colony first run"),
      ),
    ).toBe(false);
  });

  it("validate: false on empty text", async () => {
    expect(
      await colonyFirstRunAction.validate(fakeRuntime(service), fakeMessage("")),
    ).toBe(false);
  });

  it("validate: false without 'colony' keyword", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(service),
        fakeMessage("first run bootstrap"),
      ),
    ).toBe(false);
  });

  it("validate: false without first-run/bootstrap/onboard keyword", async () => {
    expect(
      await colonyFirstRunAction.validate(
        fakeRuntime(service),
        fakeMessage("hello colony"),
      ),
    ).toBe(false);
  });

  function runtimeWithModel(model: () => string): IAgentRuntime {
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => model());
    base.character = {
      name: "eliza-test",
      bio: "I help.",
      topics: ["multi-agent coordination"],
    };
    return base as unknown as IAgentRuntime;
  }

  it("joins default colonies, follows top agents, and posts intro", async () => {
    const runtime = runtimeWithModel(() => "Hi I'm here.");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    expect(
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .joinColony,
    ).toHaveBeenCalledTimes(3);
    expect(
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .follow,
    ).toHaveBeenCalledTimes(2);
    expect(service.client.createPost).toHaveBeenCalledWith(
      expect.stringContaining("Hi, I'm"),
      expect.any(String),
      expect.any(Object),
    );
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ action: "COLONY_FIRST_RUN" }),
    );
  });

  it("counts 409 joins as already-member, not failures", async () => {
    (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .joinColony = vi.fn(async () => {
      throw new Error("409 already member");
    });
    const runtime = runtimeWithModel(() => "Intro body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/already-member of 3/);
  });

  it("treats non-409 join errors as failures (not already-member)", async () => {
    (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .joinColony = vi.fn(async () => {
      throw new Error("500 server");
    });
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/joined 0, already-member of 0/);
  });

  it("treats 409 follows as already-following skips", async () => {
    (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .follow = vi.fn(async () => {
      throw new Error("409 conflict");
    });
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/followed 0, skipped 2/);
  });

  it("logs non-409 follow errors but continues", async () => {
    (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
      .follow = vi.fn(async () => {
      throw new Error("500");
    });
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/followed 0, skipped 0/);
  });

  it("skips intro when skipIntro: true", async () => {
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { skipIntro: true },
      cb,
    );
    expect(service.client.createPost).not.toHaveBeenCalled();
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/skipped by operator request/);
  });

  it("uses introBody override verbatim", async () => {
    const runtime = runtimeWithModel(() => "IGNORED");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { introBody: "Custom intro from operator" },
      cb,
    );
    expect(service.client.createPost).toHaveBeenCalledWith(
      expect.any(String),
      "Custom intro from operator",
      expect.any(Object),
    );
  });

  it("queues intro as a draft in approval mode", async () => {
    service.colonyConfig.postApprovalRequired = true;
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "An intro body");
    base.character = { name: "eliza-test", bio: "b", topics: ["t"] };
    const store = new Map<string, unknown>();
    base.getCache = vi.fn(async (k: string) => store.get(k));
    base.setCache = vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    });
    const runtime = base as unknown as IAgentRuntime;
    service.draftQueue = new DraftQueue(runtime, service.username ?? "anon", {
      maxAgeMs: 60_000,
      maxPending: 10,
    }) as unknown as FakeService["draftQueue"];

    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    expect(service.client.createPost).not.toHaveBeenCalled();
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/queued for approval/);
  });

  it("reports intro post failure without crashing", async () => {
    service.client.createPost.mockRejectedValue(new Error("boom"));
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/Intro post: failed — boom/);
  });

  it("reports when generateIntro returns empty", async () => {
    const runtime = runtimeWithModel(() => "");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/skipped \(generation returned empty\)/);
  });

  it("reports directory fetch failure without blocking join/intro", async () => {
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => {
        throw new Error("timeout");
      },
    );
    const runtime = runtimeWithModel(() => "Body");
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/directory fetch failed/);
    // Joins still happened
    expect(
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .joinColony,
    ).toHaveBeenCalled();
  });

  it("accepts options.colonies override", async () => {
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { colonies: ["custom-1", "custom-2"] },
      makeCallback(),
    );
    const join = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).joinColony;
    expect(join).toHaveBeenCalledTimes(2);
    expect((join.mock.calls as unknown[][]).map((c) => c[0])).toEqual([
      "custom-1",
      "custom-2",
    ]);
  });

  it("clamps followLimit to [1,50]", async () => {
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { followLimit: 9999 },
      makeCallback(),
    );
    const dir = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).directory;
    expect(dir).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("falls back to default followLimit on NaN", async () => {
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { followLimit: "xyz" },
      makeCallback(),
    );
    const dir = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).directory;
    expect(dir).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it("skips following self when self appears in directory", async () => {
    service.username = "alice";
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [
        { id: "u1", username: "alice", karma: 500 },
        { id: "u2", username: "bob", karma: 300 },
      ],
    );
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    const follow = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).follow;
    expect(follow).toHaveBeenCalledTimes(1);
  });

  it("handles directory returning { items } wrapper", async () => {
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => ({
        items: [{ id: "u1", username: "x", karma: 100 }],
      }),
    );
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    const follow = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).follow;
    expect(follow).toHaveBeenCalledTimes(1);
  });

  it("handles directory entries without id", async () => {
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [{ username: "noid" }],
    );
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    const follow = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).follow;
    expect(follow).not.toHaveBeenCalled();
  });

  it("handler early-returns when service missing", async () => {
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      fakeRuntime(null),
      fakeMessage("colony first run"),
      fakeState(),
      {},
      cb,
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it("uses character bio as array and topics list", async () => {
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "From generateIntro");
    base.character = {
      name: "eliza-test",
      bio: ["part A", "part B"],
      topics: ["t1", "t2"],
    };
    const runtime = base as unknown as IAgentRuntime;
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(service.client.createPost).toHaveBeenCalledWith(
      expect.any(String),
      "From generateIntro",
      expect.any(Object),
    );
  });

  it("uses default topics placeholder when character.topics missing", async () => {
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro ok");
    base.character = { name: "n", bio: "b" };
    const runtime = base as unknown as IAgentRuntime;
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(service.client.createPost).toHaveBeenCalled();
  });

  it("accepts null character gracefully", async () => {
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro ok");
    base.character = null;
    const runtime = base as unknown as IAgentRuntime;
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(service.client.createPost).toHaveBeenCalled();
  });

  it("sanitizes non-string colony overrides", async () => {
    const runtime = runtimeWithModel(() => "Body");
    await colonyFirstRunAction.handler!(
      runtime,
      fakeMessage("colony first run"),
      fakeState(),
      { colonies: [null, " ok ", "", 42] },
      makeCallback(),
    );
    const join = (
      service.client as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).joinColony;
    // null → "", 42 → "42", " ok " → "ok"
    const args = (join.mock.calls as unknown[][]).map((c) => c[0]);
    expect(args).toContain("ok");
    expect(args).toContain("42");
    expect(args).not.toContain("");
  });
});

// ──────────────────────────────────────────────────────────────────────
// generateIntro helper
// ──────────────────────────────────────────────────────────────────────
describe("generateIntro (v0.15.0)", () => {
  it("returns trimmed model output", async () => {
    const runtime = {
      useModel: vi.fn(async () => "  hello there  "),
    } as unknown as IAgentRuntime;
    expect(await generateIntro(runtime, "N", "b", "t")).toBe("hello there");
  });

  it("returns null when model yields empty", async () => {
    const runtime = {
      useModel: vi.fn(async () => "   "),
    } as unknown as IAgentRuntime;
    expect(await generateIntro(runtime, "N", "b", "t")).toBeNull();
  });

  it("returns null on useModel failure", async () => {
    const runtime = {
      useModel: vi.fn(async () => {
        throw new Error("down");
      }),
    } as unknown as IAgentRuntime;
    expect(await generateIntro(runtime, "N", "b", "t")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Targeted branch-coverage fills for v0.15.0 (restore 100% branches)
// ──────────────────────────────────────────────────────────────────────
describe("branch-coverage fills (v0.15.0)", () => {
  it("firstRun validate: treats undefined message text as empty", async () => {
    const service = fakeService();
    const msg = { content: {} } as unknown as Memory;
    expect(
      await colonyFirstRunAction.validate(fakeRuntime(service), msg),
    ).toBe(false);
  });

  it("firstRun handler: falls back to '?' when service.username missing", async () => {
    const service = fakeService();
    service.username = undefined;
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [],
    );
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro body");
    base.character = { name: "N", bio: "b", topics: ["t"] };
    const cb = makeCallback();
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      { skipIntro: true },
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toContain("@?");
  });

  it("firstRun handler: directory returning { items: undefined }", async () => {
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => ({}) as unknown,
    );
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro");
    base.character = { name: "N", bio: "b", topics: ["t"] };
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      { skipIntro: true },
      makeCallback(),
    );
    expect(
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .follow,
    ).not.toHaveBeenCalled();
  });

  it("firstRun handler: follow activity log falls back to userId slice when username missing", async () => {
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", karma: 100 }],
    );
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro");
    base.character = { name: "N", bio: "b", topics: ["t"] };
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      { skipIntro: true },
      makeCallback(),
    );
    const logged = service.recordActivity as ReturnType<typeof vi.fn>;
    const followCalls = (logged.mock.calls as unknown[][]).filter(
      (c) => String(c[2] ?? "").startsWith("first-run followed"),
    );
    expect(followCalls.length).toBe(1);
    // Expected detail uses the 8-char slice of the uuid
    expect(String(followCalls[0]![2])).toContain("aaaaaaaa");
  });

  it("firstRun handler: uses agent.user_id when agent.id missing", async () => {
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    const followMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).follow = followMock;
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [{ user_id: "fallback-id", username: "x", karma: 100 }],
    );
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro");
    base.character = { name: "N", bio: "b", topics: ["t"] };
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      { skipIntro: true },
      makeCallback(),
    );
    expect(followMock).toHaveBeenCalledWith("fallback-id");
  });

  it("firstRun handler: falls back to service.username when character.name missing", async () => {
    const service = fakeService();
    service.username = "fallback-name";
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [],
    );
    service.client.createPost.mockResolvedValue({ id: "p" });
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro");
    base.character = { bio: "b", topics: ["t"] }; // no name
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(service.client.createPost).toHaveBeenCalledWith(
      expect.stringContaining("Hi, I'm fallback-name"),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("firstRun handler: uses 'an agent' when neither character.name nor service.username", async () => {
    const service = fakeService();
    service.username = undefined;
    (service.client as unknown as Record<string, unknown>).joinColony = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [],
    );
    service.client.createPost.mockResolvedValue({ id: "p" });
    const base = fakeRuntime(service) as unknown as Record<string, unknown>;
    base.useModel = vi.fn(async () => "Intro");
    base.character = {}; // empty
    await colonyFirstRunAction.handler!(
      base as unknown as IAgentRuntime,
      fakeMessage("colony first run"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(service.client.createPost).toHaveBeenCalledWith(
      expect.stringContaining("Hi, I'm an agent"),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("post-client: isDuplicate returns true on exact match", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.client.createPost.mockResolvedValue({ id: "p1" });
    // Pre-seed the recent-posts ring with the generated content
    const existing = "Title: A generated post\n\nA generated post.";
    const store = new Map<string, unknown>();
    store.set(
      "colony/post-client/recent/eliza-test",
      [existing, "  " + existing + "  "],
    );
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => existing),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
    const c = new ColonyPostClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // Dedup hit — no post created
    expect(service.client.createPost).not.toHaveBeenCalled();
    await c.stop();
    vi.useRealTimers();
  });

  it("watchPost: writeWatchList is a no-op when runtime lacks setCache", async () => {
    const rt = {} as unknown as IAgentRuntime;
    await expect(
      writeWatchList(rt, "alice", [
        { postId: "x", addedAt: 0, lastCommentCount: 0 },
      ]),
    ).resolves.toBeUndefined();
  });

  it("engagement-client updateWatchBaseline leaves other entries untouched", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      comment_count: 2,
    });
    service.client.createComment.mockResolvedValue({ id: "c-new" });
    const store = new Map<string, unknown>();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => "A substantive reply."),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
      { postId: "post-other", addedAt: 0, lastCommentCount: 7 },
    ]);
    const c = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    const list = store.get(`colony/watch-list/${service.username}`) as WatchEntry[];
    expect(list.find((e) => e.postId === "post-watched")!.lastCommentCount).toBe(2);
    // Other entry unchanged
    expect(list.find((e) => e.postId === "post-other")!.lastCommentCount).toBe(7);
    await c.stop();
    vi.useRealTimers();
  });

  it("engagement-client: threaded watched engagement (reply_to marker)", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "P",
      body: "B",
      comment_count: 3,
    });
    (service.client as unknown as Record<string, unknown>).getComments = vi.fn(
      async () => ({ items: [{ id: "cmt-42", body: "an existing comment" }] }),
    );
    service.client.createComment.mockResolvedValue({ id: "c-new" });
    const store = new Map<string, unknown>();
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(
        async () => "<reply_to>cmt-42</reply_to>Threaded response body.",
      ),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
    await writeWatchList(runtime, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    const c = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
      threadComments: 3,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-watched",
      expect.any(String),
      "cmt-42",
    );
    await c.stop();
    vi.useRealTimers();
  });

  it("followTopAgents validate: treats undefined text as empty", async () => {
    const { followTopAgentsAction: action } = await import(
      "../actions/followTopAgents.js"
    );
    const service = fakeService();
    const msg = { content: {} } as unknown as Memory;
    expect(await action.validate(fakeRuntime(service), msg)).toBe(false);
  });

  it("followTopAgents handler: uses user_id when id missing", async () => {
    const { followTopAgentsAction: action } = await import(
      "../actions/followTopAgents.js"
    );
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [{ user_id: "uid-only", username: "x", karma: 100 }],
    );
    const followMock = vi.fn(async () => ({}));
    (service.client as unknown as Record<string, unknown>).follow = followMock;
    await action.handler!(
      fakeRuntime(service),
      fakeMessage("follow top agents"),
      fakeState(),
      {},
      makeCallback(),
    );
    expect(followMock).toHaveBeenCalledWith("uid-only");
  });

  it("followTopAgents handler: activity log falls back when username missing", async () => {
    const { followTopAgentsAction: action } = await import(
      "../actions/followTopAgents.js"
    );
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).directory = vi.fn(
      async () => [{ id: "abcdefgh-1111-2222-3333-444444444444", karma: 5 }],
    );
    (service.client as unknown as Record<string, unknown>).follow = vi.fn(
      async () => ({}),
    );
    await action.handler!(
      fakeRuntime(service),
      fakeMessage("follow top agents"),
      fakeState(),
      {},
      makeCallback(),
    );
    const logged = service.recordActivity as ReturnType<typeof vi.fn>;
    const found = (logged.mock.calls as unknown[][]).some((c) =>
      String(c[2] ?? "").includes("abcdefgh"),
    );
    expect(found).toBe(true);
  });
});
