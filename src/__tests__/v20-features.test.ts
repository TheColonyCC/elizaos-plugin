import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleOperatorCommand } from "../services/operator-commands.js";
import { colonyStatusAction } from "../actions/status.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

// ── Operator conversation-state commands ───────────────────────────

describe("v0.20.0 — operator conversation-state commands", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService({}, { operatorUsername: "jack", operatorPrefix: "!" });
    const client = service.client as unknown as {
      archiveConversation: ReturnType<typeof vi.fn>;
      unarchiveConversation: ReturnType<typeof vi.fn>;
      muteConversation: ReturnType<typeof vi.fn>;
      unmuteConversation: ReturnType<typeof vi.fn>;
    };
    client.archiveConversation = vi.fn(async () => ({}));
    client.unarchiveConversation = vi.fn(async () => ({}));
    client.muteConversation = vi.fn(async () => ({}));
    client.unmuteConversation = vi.fn(async () => ({}));
  });

  it("!archive @alice calls archiveConversation", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!archive @alice");
    expect(res?.command).toBe("archive");
    expect(res?.reply).toContain("Archived DM thread with @alice");
    const client = service.client as unknown as { archiveConversation: ReturnType<typeof vi.fn> };
    expect(client.archiveConversation).toHaveBeenCalledWith("alice");
  });

  it("!archive alice (no @) also works", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!archive alice");
    expect(res?.command).toBe("archive");
    const client = service.client as unknown as { archiveConversation: ReturnType<typeof vi.fn> };
    expect(client.archiveConversation).toHaveBeenCalledWith("alice");
  });

  it("!unarchive calls unarchiveConversation", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!unarchive @alice");
    expect(res?.command).toBe("unarchive");
    expect(res?.reply).toContain("Unarchived DM thread with @alice");
    const client = service.client as unknown as { unarchiveConversation: ReturnType<typeof vi.fn> };
    expect(client.unarchiveConversation).toHaveBeenCalled();
  });

  it("!mute @alice calls muteConversation", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!mute @alice");
    expect(res?.command).toBe("mute");
    expect(res?.reply).toContain("Muted DM thread with @alice");
    const client = service.client as unknown as { muteConversation: ReturnType<typeof vi.fn> };
    expect(client.muteConversation).toHaveBeenCalled();
  });

  it("!unmute calls unmuteConversation", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!unmute @alice");
    expect(res?.command).toBe("unmute");
    expect(res?.reply).toContain("Unmuted DM thread with @alice");
    const client = service.client as unknown as { unmuteConversation: ReturnType<typeof vi.fn> };
    expect(client.unmuteConversation).toHaveBeenCalled();
  });

  it("archive without username returns usage message", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!archive");
    expect(res?.reply).toContain("Username required");
    const client = service.client as unknown as { archiveConversation: ReturnType<typeof vi.fn> };
    expect(client.archiveConversation).not.toHaveBeenCalled();
  });

  it("mute surfaces SDK errors in the reply", async () => {
    const client = service.client as unknown as { muteConversation: ReturnType<typeof vi.fn> };
    client.muteConversation = vi.fn(async () => {
      throw new Error("conversation not found");
    });
    const res = await handleOperatorCommand(service as never, "jack", "!mute @ghost");
    expect(res?.reply).toContain("Failed to mute @ghost");
    expect(res?.reply).toContain("conversation not found");
  });

  it("!help lists all four new conversation-state commands", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!help");
    expect(res?.reply).toContain("!archive");
    expect(res?.reply).toContain("!unarchive");
    expect(res?.reply).toContain("!mute");
    expect(res?.reply).toContain("!unmute");
  });
});

// ── Engagement rising + trending weight ────────────────────────────

describe("v0.20.0 — engagement trending-tag cache", () => {
  it("getTrendingTagCache exposes the cached tags after refresh", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService({}, { engageTrendingBoost: true });
    (service.client as unknown as { getTrendingTags: ReturnType<typeof vi.fn> }).getTrendingTags =
      vi.fn(async () => ({
        items: [{ name: "Rate-Limits" }, { name: "Ollama" }, { name: "Attestation" }],
      }));
    const runtime = fakeRuntime(service, {});
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      trendingBoost: true,
      trendingRefreshMs: 60_000,
    });
    // Trigger a refresh by calling the private method directly via cast.
    await (client as unknown as { maybeRefreshTrendingTags: () => Promise<void> }).maybeRefreshTrendingTags();
    const cache = client.getTrendingTagCache();
    expect(cache).not.toBeNull();
    expect(cache?.tags).toContain("rate-limits");
    expect(cache?.tags).toContain("ollama");
  });

  it("getTrendingTagCache returns null before any refresh", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    const runtime = fakeRuntime(service, {});
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
    });
    expect(client.getTrendingTagCache()).toBeNull();
  });

  it("maybeRefreshTrendingTags swallows SDK errors without throwing", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    (service.client as unknown as { getTrendingTags: ReturnType<typeof vi.fn> }).getTrendingTags =
      vi.fn(async () => {
        throw new Error("trending service down");
      });
    const runtime = fakeRuntime(service, {});
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      trendingBoost: true,
    });
    await (client as unknown as { maybeRefreshTrendingTags: () => Promise<void> }).maybeRefreshTrendingTags();
    expect(client.getTrendingTagCache()).toBeNull();
  });

  it("maybeRefreshTrendingTags respects the TTL", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    const spy = vi.fn(async () => ({ items: [{ name: "a" }] }));
    (service.client as unknown as { getTrendingTags: ReturnType<typeof vi.fn> }).getTrendingTags = spy;
    const runtime = fakeRuntime(service, {});
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      trendingBoost: true,
      trendingRefreshMs: 60_000,
    });
    await (client as unknown as { maybeRefreshTrendingTags: () => Promise<void> }).maybeRefreshTrendingTags();
    await (client as unknown as { maybeRefreshTrendingTags: () => Promise<void> }).maybeRefreshTrendingTags();
    // Second call within TTL → no extra API hit
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── Engagement client — rising + trending paths through tick ───────

describe("v0.20.0 — engagement tick uses rising + trending", () => {
  it("useRising=true routes candidate fetch through getRisingPosts", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    const risingSpy = vi.fn(async () => ({ items: [] }));
    const getPostsSpy = vi.fn(async () => ({ items: [] }));
    (service.client as unknown as {
      getRisingPosts: ReturnType<typeof vi.fn>;
    }).getRisingPosts = risingSpy;
    service.client.getPosts = getPostsSpy;
    service.username = "eliza-test";
    const runtime = fakeRuntime(service, {});
    runtime.character = { name: "Eliza", topics: [] } as never;
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      useRising: true,
    });
    // Directly trigger a tick via the private method.
    await (client as unknown as { tick: () => Promise<void> }).tick();
    expect(risingSpy).toHaveBeenCalled();
    expect(getPostsSpy).not.toHaveBeenCalled();
  });

  it("tick with useRising=true returns cleanly when getRisingPosts throws", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    (service.client as unknown as { getRisingPosts: ReturnType<typeof vi.fn> }).getRisingPosts =
      vi.fn(async () => {
        throw new Error("rising service down");
      });
    const runtime = fakeRuntime(service);
    (runtime as unknown as { character: unknown }).character = { name: "E", topics: [] };
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      useRising: true,
    });
    // Tick should catch + log + return without crashing
    await (client as unknown as { tick: () => Promise<void> }).tick();
  });

  it("applyTrendingWeight reorders candidates by trending × topics overlap", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    (service.client as unknown as { getTrendingTags: ReturnType<typeof vi.fn> }).getTrendingTags =
      vi.fn(async () => ({
        items: [{ name: "rate-limits" }, { name: "ollama" }],
      }));
    const runtime = fakeRuntime(service, {});
    runtime.character = { name: "Eliza", topics: ["rate-limits", "ollama"] } as never;
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      trendingBoost: true,
    });
    await (
      client as unknown as { maybeRefreshTrendingTags: () => Promise<void> }
    ).maybeRefreshTrendingTags();
    const apply = (
      client as unknown as {
        applyTrendingWeight: (posts: Array<{ id: string; tags?: string[] }>) => Array<{ id: string; tags?: string[] }>;
      }
    ).applyTrendingWeight;
    const candidates = [
      { id: "low", tags: ["unrelated"] },
      { id: "high", tags: ["rate-limits", "ollama"] },
      { id: "mid", tags: ["rate-limits"] },
    ];
    const ordered = apply.call(client, candidates);
    expect(ordered[0]?.id).toBe("high");
  });

  it("tick with trendingBoost=true exercises both the void-refresh and the reorder paths", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    service.username = "eliza-test";
    (service.client as unknown as { getTrendingTags: ReturnType<typeof vi.fn> }).getTrendingTags =
      vi.fn(async () => ({ items: [{ name: "rate-limits" }] }));
    service.client.getPosts = vi.fn(async () => ({
      items: [
        { id: "a", title: "rate limits under load", body: "", author: { username: "alice" }, tags: ["rate-limits"] },
      ],
    })) as never;
    const runtime = fakeRuntime(service);
    (runtime as unknown as { character: unknown }).character = {
      name: "E",
      topics: ["rate-limits"],
    };
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
      trendingBoost: true,
    });
    await (client as unknown as { tick: () => Promise<void> }).tick();
    // The trending-tag refresh is fire-and-forget; await a microtask tick to let it land.
    await new Promise((r) => setImmediate(r));
  });

  it("applyTrendingWeight is identity when cache empty or topics empty", async () => {
    const { ColonyEngagementClient } = await import("../services/engagement-client.js");
    const service = fakeService();
    const runtime = fakeRuntime(service, {});
    runtime.character = { name: "E", topics: [] } as never;
    const client = new ColonyEngagementClient(service as never, runtime, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      dryRun: true,
      selfCheck: false,
      threadComments: 3,
      requireTopicMatch: false,
    });
    const apply = (
      client as unknown as {
        applyTrendingWeight: (posts: Array<{ id: string }>) => Array<{ id: string }>;
      }
    ).applyTrendingWeight;
    const input = [{ id: "a" }, { id: "b" }];
    // Cache is null → identity
    expect(apply.call(client, input).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

// ── commentOnPost uses getPostContext ──────────────────────────────

describe("v0.20.0 — commentOnPost adopts getPostContext", () => {
  it("uses getPostContext response when the endpoint succeeds", async () => {
    const { commentOnColonyPostAction } = await import("../actions/commentOnPost.js");
    const service = fakeService();
    (service.client as unknown as { getPostContext: ReturnType<typeof vi.fn> }).getPostContext =
      vi.fn(async () => ({
        post: { id: "p1", title: "from context", body: "body" },
        author: { username: "alice" },
        colony: { name: "general" },
        comments: [],
      }));
    // If getPostContext succeeds, getPost must NOT be called.
    const getPostSpy = vi.fn();
    service.client.getPost = getPostSpy;
    // Stub useModel via the runtime to return something valid, so the
    // comment path can proceed through generation + createComment.
    service.client.createComment.mockResolvedValue({ id: "c1" });
    const runtime = fakeRuntime(service);
    (runtime as unknown as { useModel: ReturnType<typeof vi.fn> }).useModel = vi.fn(
      async () => "A substantive reply",
    );
    (runtime as unknown as { character: unknown }).character = {
      name: "Eliza",
      bio: "An agent",
      topics: ["rate-limits"],
      style: { all: ["concise"] },
    };
    const cb = makeCallback();
    await commentOnColonyPostAction.handler!(
      runtime,
      fakeMessage("Comment on https://thecolony.cc/post/11111111-2222-3333-4444-555555555555"),
      fakeState(),
      { postId: "11111111-2222-3333-4444-555555555555" },
      cb,
    );
    // getPost should never have been called — context path won.
    expect(getPostSpy).not.toHaveBeenCalled();
  });
});

describe("v0.20.0 — commentOnPost: getPostContext falls back when response lacks 'post' key", () => {
  it("treats the raw response as a PostLike when no nested 'post' field is present", async () => {
    const { commentOnColonyPostAction } = await import("../actions/commentOnPost.js");
    const service = fakeService();
    // Simulate a server variant that returns the post fields at the top level
    // rather than nested under `post`. Our code should accept either.
    (service.client as unknown as { getPostContext: ReturnType<typeof vi.fn> }).getPostContext =
      vi.fn(async () => ({
        id: "p1",
        title: "flat response",
        body: "body",
        author: { username: "alice" },
      }));
    service.client.createComment.mockResolvedValue({ id: "c1" });
    const runtime = fakeRuntime(service);
    (runtime as unknown as { useModel: ReturnType<typeof vi.fn> }).useModel = vi.fn(
      async () => "A reply",
    );
    (runtime as unknown as { character: unknown }).character = {
      name: "Eliza",
      bio: "b",
      topics: [],
      style: { all: [] },
    };
    const cb = makeCallback();
    await commentOnColonyPostAction.handler!(
      runtime,
      fakeMessage("Comment on https://thecolony.cc/post/22222222-3333-4444-5555-666666666666"),
      fakeState(),
      { postId: "22222222-3333-4444-5555-666666666666" },
      cb,
    );
    // Should have called createComment on the right post
    expect(service.client.createComment).toHaveBeenCalled();
  });
});

// ── COLONY_STATUS surfaces engagement trend state ──────────────────

describe("v0.20.0 — COLONY_STATUS visibility", () => {
  it("surfaces 'Engagement source: rising' when engageUseRising=true", async () => {
    const service = fakeService({}, { engageUseRising: true });
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("colony status"),
      fakeState(),
      {},
      cb,
    );
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Engagement source: rising");
  });

  it("truncates trending tags with '+N more' when cache has >8 entries", async () => {
    const service = fakeService({}, { engageTrendingBoost: true });
    const many = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
    (service as unknown as { engagementClient: unknown }).engagementClient = {
      getTrendingTagCache: () => ({ tags: many, fetchedAt: Date.now() }),
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("colony status"),
      fakeState(),
      {},
      cb,
    );
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("+4 more");
  });

  it("surfaces trending-tags line when boost enabled and cache populated", async () => {
    const service = fakeService({}, { engageTrendingBoost: true });
    (service as unknown as { engagementClient: unknown }).engagementClient = {
      getTrendingTagCache: () => ({
        tags: ["rate-limits", "ollama", "attestation"],
        fetchedAt: Date.now() - 3 * 60_000,
      }),
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("colony status"),
      fakeState(),
      {},
      cb,
    );
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Trending tags");
    expect(reply.text).toContain("rate-limits");
  });

  it("shows 'not cached yet' when boost on but cache empty", async () => {
    const service = fakeService({}, { engageTrendingBoost: true });
    (service as unknown as { engagementClient: unknown }).engagementClient = {
      getTrendingTagCache: () => null,
    };
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("colony status"),
      fakeState(),
      {},
      cb,
    );
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).toContain("Trending tags: (not cached yet");
  });

  it("omits trend lines when both features disabled", async () => {
    const service = fakeService();
    const runtime = fakeRuntime(service);
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("colony status"),
      fakeState(),
      {},
      cb,
    );
    const reply = cb.mock.calls[0]?.[0] as { text?: string };
    expect(reply.text).not.toContain("Engagement source: rising");
    expect(reply.text).not.toContain("Trending tags");
  });
});
