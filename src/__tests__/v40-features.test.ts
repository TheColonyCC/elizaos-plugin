/**
 * v0.40.0 — the engagement client leaves at most `maxCommentsPerPost`
 * comments on a post (default 1).
 *
 * Regression: the seen ring holds the last 100 candidates, so a post that
 * kept resurfacing in a candidate source aged out of the ring and was
 * commented on again — 31 times on one thread in production. These tests use
 * a KEYED cache, so the seen ring and the commented ledger are genuinely
 * separate stores and "evicted from the ring" can be represented directly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { fakeService, type FakeService } from "./helpers.js";

const SEEN = "colony/engagement-client/seen/eliza-test";
const COMMENTED = "colony/engagement-client/commented/eliza-test";

function keyedRuntime(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    agentId: "00000000-0000-0000-0000-000000000001",
    character: {
      name: "eliza-test",
      bio: "A test agent for engagement",
      topics: ["multi-agent coordination"],
      style: { all: ["Concrete over abstract."], chat: ["Direct."] },
    },
    useModel: vi.fn(async () => "A substantive reply."),
    getCache: vi.fn(async (k: string) => store.get(k)),
    setCache: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
}

function config(overrides = {}) {
  return {
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colonies: ["general"],
    candidateLimit: 5,
    maxTokens: 240,
    temperature: 0.8,
    selfCheck: false,
    ...overrides,
  };
}

const OLD_POST = { id: "post-old", title: "An old thread", body: "B", author: { username: "jeletor" } };
const other = (id: string) => ({ id, body: "x", author: { username: "someone" } });
const mine = (id: string) => ({ id, body: "x", author: { username: "eliza-test" } });

describe("v0.40.0 — one comment per post", () => {
  let service: FakeService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    service.client.getPosts.mockResolvedValue({ items: [OLD_POST] });
    service.client.createComment.mockResolvedValue({ id: "new" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runOneTick(rt: ReturnType<typeof keyedRuntime>, overrides = {}) {
    const c = new ColonyEngagementClient(service as never, rt as never, config(overrides));
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    await c.stop();
  }

  function setComments(fn: (id: string, page?: number) => unknown) {
    const spy = vi.fn(async (id: string, page?: number) => fn(id, page));
    (service.client as unknown as Record<string, unknown>).getComments = spy;
    return spy;
  }

  it("skips a post that already carries a comment by the agent, and marks it seen", async () => {
    setComments(() => ({ items: [other("c1"), mine("c2")], total: 2 }));
    const rt = keyedRuntime();
    await runOneTick(rt);
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(rt.useModel).not.toHaveBeenCalled();
    expect(rt.store.get(SEEN)).toContain("post-old");
  });

  it("control: with maxCommentsPerPost 0 the same inputs DO comment (pre-0.40 behaviour)", async () => {
    setComments(() => ({ items: [other("c1"), mine("c2")], total: 2 }));
    const rt = keyedRuntime();
    await runOneTick(rt, { maxCommentsPerPost: 0 });
    expect(service.client.createComment).toHaveBeenCalledWith("post-old", "A substantive reply.", undefined);
  });

  it("regression: a post evicted from the seen ring is still refused when the ledger has it", async () => {
    const spy = setComments(() => ({ items: [other("c1")], total: 1 }));
    // Seen ring full of 100 other ids — post-old has aged out of it.
    const ring = Array.from({ length: 100 }, (_, i) => `other-${i}`);
    const rt = keyedRuntime({ [SEEN]: ring, [COMMENTED]: ["post-old"] });
    await runOneTick(rt);
    expect(service.client.createComment).not.toHaveBeenCalled();
    // The ledger answered without an API call.
    expect(spy).not.toHaveBeenCalled();
  });

  it("records the post in the commented ledger after a successful comment", async () => {
    setComments(() => ({ items: [other("c1")], total: 1 }));
    const rt = keyedRuntime();
    await runOneTick(rt);
    expect(service.client.createComment).toHaveBeenCalledTimes(1);
    expect(rt.store.get(COMMENTED)).toEqual(["post-old"]);
    expect(rt.store.get(SEEN)).toContain("post-old");
  });

  it("does not record the ledger when createComment fails", async () => {
    setComments(() => ({ items: [], total: 0 }));
    service.client.createComment.mockRejectedValue(new Error("500"));
    const rt = keyedRuntime();
    await runOneTick(rt);
    expect(rt.store.get(COMMENTED)).toBeUndefined();
  });

  it("finds a prior comment beyond the first page", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => other(`p1-${i}`));
    const page2 = [other("p2-0"), mine("p2-1")];
    const spy = setComments((_id, page) => ({ items: page === 2 ? page2 : page1, total: 22 }));
    const rt = keyedRuntime();
    await runOneTick(rt);
    expect(spy).toHaveBeenCalledWith("post-old", 2);
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("stops scanning when the server ignores `page` and serves the same rows again", async () => {
    const spy = setComments(() => ({ items: [other("a"), other("b"), other("c")] }));
    const rt = keyedRuntime();
    await runOneTick(rt);
    // Scan: page 1 (3 new ids), page 2 (0 new ids -> stop) = 2 calls;
    // then fetchThreadComments = 1 call. Not 5 pages of duplicates.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(service.client.createComment).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the prior-comment fetch throws: no comment, candidate NOT marked seen", async () => {
    setComments(() => {
      throw new Error("502 Bad Gateway");
    });
    const rt = keyedRuntime();
    await runOneTick(rt);
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(rt.useModel).not.toHaveBeenCalled();
    expect((rt.store.get(SEEN) as string[] | undefined) ?? []).not.toContain("post-old");
  });

  it("honours a cap above 1: one prior comment allows a second, two block a third", async () => {
    setComments(() => ({ items: [mine("m1"), other("o1")], total: 2 }));
    await runOneTick(keyedRuntime(), { maxCommentsPerPost: 2 });
    expect(service.client.createComment).toHaveBeenCalledTimes(1);

    service.client.createComment.mockClear();
    setComments(() => ({ items: [mine("m1"), mine("m2")], total: 2 }));
    await runOneTick(keyedRuntime(), { maxCommentsPerPost: 2 });
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("falls back to the ledger alone when the client has no getComments", async () => {
    delete (service.client as unknown as Record<string, unknown>).getComments;
    const rt = keyedRuntime({ [COMMENTED]: ["post-old"] });
    await runOneTick(rt);
    expect(service.client.createComment).not.toHaveBeenCalled();

    service.client.createComment.mockClear();
    await runOneTick(keyedRuntime());
    expect(service.client.createComment).toHaveBeenCalledTimes(1);
  });
});
