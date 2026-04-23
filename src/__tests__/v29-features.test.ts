/**
 * v0.29.0 — semantic diversity watchdog + thread-digest retry fix +
 * client-side comment dedup.
 *
 * Three orthogonal features; tested here as the authoritative new-
 * surface set for the release. Composes with v0.19 (lexical watchdog),
 * v0.27 (per-thread digest), and v0.21 (DM-origin tagging) without
 * behavioural changes on the old paths.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

import {
  DiversityWatchdog,
  cosineSimilarity,
} from "../services/diversity-watchdog.js";
import {
  CommentDedupRing,
  DEFAULT_DEDUP_CONFIG,
} from "../services/comment-dedup.js";
import { ColonyService } from "../services/colony.service.js";
import { ColonyInteractionClient } from "../services/interaction.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { loadColonyConfig } from "../environment.js";
import { commentOnColonyPostAction } from "../actions/commentOnPost.js";
import { replyColonyAction } from "../actions/replyComment.js";
import {
  fakeClient,
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
} from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 1a — DiversityWatchdog: semantic mode + threshold alias
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — DiversityWatchdog semantic mode", () => {
  it("lexical mode (default) preserves v0.19 behaviour", () => {
    const w = new DiversityWatchdog({ windowSize: 3, lexicalThreshold: 0.5 });
    w.record("the quick brown fox jumps over the lazy dog");
    w.record("the quick brown fox jumps over the lazy cat");
    expect(w.record("the quick brown fox jumps over the lazy bat")).toBe(true);
    expect(w.mode()).toBe("lexical");
  });

  it("accepts the legacy `threshold` key as an alias for `lexicalThreshold`", () => {
    const w = new DiversityWatchdog({
      windowSize: 2,
      threshold: 0.3,
    } as unknown as ConstructorParameters<typeof DiversityWatchdog>[0]);
    w.record("apple banana cherry");
    expect(w.record("apple banana cherry")).toBe(true);
  });

  it("explicit lexicalThreshold wins over the legacy alias", () => {
    const w = new DiversityWatchdog({
      windowSize: 2,
      threshold: 0.99,
      lexicalThreshold: 0.1,
    } as unknown as ConstructorParameters<typeof DiversityWatchdog>[0]);
    // At lexicalThreshold 0.1, any two non-trivial outputs trip.
    w.record("apple banana cherry date");
    expect(w.record("quite different words entirely here")).toBe(false);
    // Two that share one token should cross the looser 0.1.
    const w2 = new DiversityWatchdog({
      windowSize: 2,
      threshold: 0.99,
      lexicalThreshold: 0.1,
    } as unknown as ConstructorParameters<typeof DiversityWatchdog>[0]);
    w2.record("apple banana cherry date");
    expect(w2.record("apple banana cherry date")).toBe(true);
  });

  it("semantic mode trips when embeddings cluster above threshold", () => {
    const w = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.9,
    });
    // Three near-identical unit vectors — cosine ≈ 1.0.
    const e1 = [1, 0, 0];
    const e2 = [0.99, 0.01, 0];
    const e3 = [0.98, 0.02, 0];
    w.record("alpha", e1);
    w.record("beta", e2);
    expect(w.record("gamma", e3)).toBe(true);
    expect(w.mode()).toBe("semantic");
  });

  it("semantic mode does not trip on diverse embeddings", () => {
    const w = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.9,
    });
    const e1 = [1, 0, 0];
    const e2 = [0, 1, 0];
    const e3 = [0, 0, 1];
    w.record("alpha", e1);
    w.record("beta", e2);
    expect(w.record("gamma", e3)).toBe(false);
  });

  it("semantic mode: any pair with a missing embedding blocks a trip", () => {
    const w = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.8,
    });
    w.record("alpha", [1, 0]);
    w.record("beta", null);
    expect(w.record("gamma", [1, 0])).toBe(false);
  });

  it("both mode trips on lexical match even with diverse embeddings", () => {
    const w = new DiversityWatchdog({
      mode: "both",
      windowSize: 3,
      lexicalThreshold: 0.4,
      semanticThreshold: 0.99,
    });
    // Same shingle set → lexical 1.0, but orthogonal embeddings.
    w.record("apple banana cherry date", [1, 0, 0]);
    w.record("apple banana cherry date", [0, 1, 0]);
    expect(w.record("apple banana cherry date", [0, 0, 1])).toBe(true);
  });

  it("both mode trips on semantic match even with lexically distinct text", () => {
    const w = new DiversityWatchdog({
      mode: "both",
      windowSize: 3,
      lexicalThreshold: 0.99,
      semanticThreshold: 0.9,
    });
    const e1 = [1, 0];
    w.record("alpha beta gamma delta", e1);
    w.record("epsilon zeta eta theta", [0.99, 0.01]);
    expect(w.record("iota kappa lambda mu", [0.98, 0.02])).toBe(true);
  });

  it("both mode with all-null embeddings falls back to lexical only", () => {
    const w = new DiversityWatchdog({
      mode: "both",
      windowSize: 2,
      lexicalThreshold: 0.1,
      semanticThreshold: 0.5,
    });
    w.record("apple banana cherry", null);
    // Lexical threshold 0.1 alone trips on identical text.
    expect(w.record("apple banana cherry", null)).toBe(true);
  });

  it("peakSimilarity uses cosine for semantic, Jaccard for lexical", () => {
    const wSem = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.99,
    });
    wSem.record("a", [1, 0]);
    wSem.record("b", [0.5, 0.5]);
    const peak = wSem.peakSimilarity();
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(0.72);

    const wLex = new DiversityWatchdog({
      mode: "lexical",
      windowSize: 3,
      ngram: 1,
      lexicalThreshold: 0.99,
    });
    // 1-gram shingles: {a,b,c} vs {a,b,d} → |∩|=2, |∪|=4, Jaccard=0.5.
    wLex.record("a b c");
    wLex.record("a b d");
    expect(wLex.peakSimilarity()).toBeCloseTo(0.5, 5);
  });

  it("peakSimilarity falls back to lexical when a pair is missing embeddings", () => {
    const w = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.99,
    });
    w.record("alpha beta", null);
    w.record("alpha beta", null);
    // No embeddings → falls back to lexical Jaccard (1.0 on identical).
    expect(w.peakSimilarity()).toBeCloseTo(1, 5);
  });

  it("peakSimilarity returns 0 on an empty / single-entry ring", () => {
    const w = new DiversityWatchdog({ mode: "lexical", windowSize: 3 });
    expect(w.peakSimilarity()).toBe(0);
    w.record("only one");
    expect(w.peakSimilarity()).toBe(0);
  });

  it("constructor clamps out-of-range thresholds to defaults", () => {
    const w1 = new DiversityWatchdog({
      lexicalThreshold: 0,
      semanticThreshold: 0,
    });
    const w2 = new DiversityWatchdog({
      lexicalThreshold: 1.5,
      semanticThreshold: 2,
    });
    // When passed 0 or >1, config falls back to default. Record 3
    // identical outputs and expect a trip at the default 0.8/0.85.
    w1.record("apple banana cherry");
    w1.record("apple banana cherry");
    expect(w1.record("apple banana cherry")).toBe(true);
    w2.record("apple banana cherry");
    w2.record("apple banana cherry");
    expect(w2.record("apple banana cherry")).toBe(true);
  });

  it("size() + reset() behave as the watchdog contract", () => {
    const w = new DiversityWatchdog({ windowSize: 3 });
    expect(w.size()).toBe(0);
    w.record("alpha");
    w.record("beta");
    expect(w.size()).toBe(2);
    w.reset();
    expect(w.size()).toBe(0);
  });

  it("empty / whitespace-only text is ignored", () => {
    const w = new DiversityWatchdog({ windowSize: 2, lexicalThreshold: 0.1 });
    expect(w.record("")).toBe(false);
    expect(w.record("   ")).toBe(false);
    expect(w.size()).toBe(0);
  });

  it("semantic mode with empty ring returns false (no trip)", () => {
    const w = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.5,
    });
    expect(w.record("alpha", [1, 0])).toBe(false);
    expect(w.record("beta", [0.9, 0.1])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 1b — cosineSimilarity helper
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns the cosine of the angle for non-trivial pairs", () => {
    // a = (1, 0), b = (1, 1) → cosine = 1 / √2 ≈ 0.707
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("returns 0 for zero-norm vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 1c — env config parsing for diversity mode
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — env config: diversityMode + semantic threshold", () => {
  function makeRuntime(overrides: Record<string, string> = {}): IAgentRuntime {
    const settings: Record<string, string> = {
      COLONY_API_KEY: "col_test",
      ...overrides,
    };
    return {
      getSetting: (k: string) => settings[k],
    } as unknown as IAgentRuntime;
  }

  it("defaults diversityMode to 'lexical' and semantic threshold to 0.85", () => {
    const cfg = loadColonyConfig(makeRuntime());
    expect(cfg.diversityMode).toBe("lexical");
    expect(cfg.diversitySemanticThreshold).toBe(0.85);
  });

  it("parses COLONY_DIVERSITY_MODE=semantic", () => {
    const cfg = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_MODE: "semantic" }),
    );
    expect(cfg.diversityMode).toBe("semantic");
  });

  it("parses COLONY_DIVERSITY_MODE=both", () => {
    const cfg = loadColonyConfig(makeRuntime({ COLONY_DIVERSITY_MODE: "BOTH" }));
    expect(cfg.diversityMode).toBe("both");
  });

  it("unknown COLONY_DIVERSITY_MODE falls back to lexical", () => {
    const cfg = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_MODE: "strict" }),
    );
    expect(cfg.diversityMode).toBe("lexical");
  });

  it("parses COLONY_DIVERSITY_SEMANTIC_THRESHOLD in range", () => {
    const cfg = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_SEMANTIC_THRESHOLD: "0.7" }),
    );
    expect(cfg.diversitySemanticThreshold).toBe(0.7);
  });

  it("clamps COLONY_DIVERSITY_SEMANTIC_THRESHOLD to [0, 1]", () => {
    const cfg1 = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_SEMANTIC_THRESHOLD: "-0.5" }),
    );
    expect(cfg1.diversitySemanticThreshold).toBe(0);
    const cfg2 = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_SEMANTIC_THRESHOLD: "2.5" }),
    );
    expect(cfg2.diversitySemanticThreshold).toBe(1);
  });

  it("falls back to 0.85 when COLONY_DIVERSITY_SEMANTIC_THRESHOLD is unparseable", () => {
    const cfg = loadColonyConfig(
      makeRuntime({ COLONY_DIVERSITY_SEMANTIC_THRESHOLD: "not-a-number" }),
    );
    expect(cfg.diversitySemanticThreshold).toBe(0.85);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 1d — ColonyService.recordGeneratedOutput async embedding path
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — ColonyService.recordGeneratedOutput embedding path", () => {
  function makeRuntime(
    embedResult: unknown,
    shouldThrow = false,
  ): IAgentRuntime {
    return {
      useModel: vi.fn(async (_type: string, _params: unknown) => {
        if (shouldThrow) throw new Error("embedding unavailable");
        return embedResult;
      }),
    } as unknown as IAgentRuntime;
  }

  function freshService(
    mode: "lexical" | "semantic" | "both",
    runtime: IAgentRuntime,
  ): ColonyService {
    const s = new ColonyService(runtime);
    s.colonyConfig = {
      diversityMode: mode,
      diversityThreshold: 0.8,
      diversitySemanticThreshold: 0.9,
      diversityWindowSize: 3,
      diversityNgram: 3,
      diversityCooldownMs: 60_000,
    } as unknown as ColonyService["colonyConfig"];
    s.diversityWatchdog = new DiversityWatchdog({
      mode,
      windowSize: 3,
      lexicalThreshold: 0.8,
      semanticThreshold: 0.9,
    });
    return s;
  }

  it("lexical mode does NOT call useModel", async () => {
    const runtime = makeRuntime([1, 0, 0]);
    const svc = freshService("lexical", runtime);
    await svc.recordGeneratedOutput("alpha beta");
    expect((runtime.useModel as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("semantic mode calls useModel with TEXT_EMBEDDING", async () => {
    const runtime = makeRuntime([1, 0, 0, 0]);
    const svc = freshService("semantic", runtime);
    await svc.recordGeneratedOutput("alpha beta");
    const mock = runtime.useModel as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe("TEXT_EMBEDDING");
    expect(mock.mock.calls[0]![1]).toEqual({ text: "alpha beta" });
  });

  it("both mode also calls useModel", async () => {
    const runtime = makeRuntime([1, 0]);
    const svc = freshService("both", runtime);
    await svc.recordGeneratedOutput("alpha beta");
    expect(
      (runtime.useModel as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledTimes(1);
  });

  it("semantic mode: useModel throws → falls back to null embedding, no pause", async () => {
    const runtime = makeRuntime(null, true);
    const svc = freshService("semantic", runtime);
    // Three identical texts should NOT trip semantic-only when embeddings all null.
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    expect(svc.pausedUntilTs).toBe(0);
  });

  it("semantic mode: non-array useModel response → null embedding", async () => {
    const runtime = makeRuntime("not-an-array");
    const svc = freshService("semantic", runtime);
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    expect(svc.pausedUntilTs).toBe(0);
  });

  it("semantic mode: empty-array useModel response → null embedding", async () => {
    const runtime = makeRuntime([]);
    const svc = freshService("semantic", runtime);
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    expect(svc.pausedUntilTs).toBe(0);
  });

  it("semantic mode: non-numeric array → null embedding", async () => {
    const runtime = makeRuntime(["a", "b", "c"]);
    const svc = freshService("semantic", runtime);
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    expect(svc.pausedUntilTs).toBe(0);
  });

  it("semantic mode: identical embeddings + identical text → trips & pauses", async () => {
    const runtime = makeRuntime([1, 0, 0]);
    const svc = freshService("semantic", runtime);
    await svc.recordGeneratedOutput("a");
    await svc.recordGeneratedOutput("b");
    await svc.recordGeneratedOutput("c");
    expect(svc.pausedUntilTs).toBeGreaterThan(Date.now());
    expect(svc.pauseReason).toBe("semantic_repetition");
  });

  it("both mode: useModel fails but watchdog still runs lexical check", async () => {
    const runtime = makeRuntime(null, true);
    const svc = freshService("both", runtime);
    // Identical text → lexical Jaccard 1.0 trips at default 0.8.
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    await svc.recordGeneratedOutput("alpha beta gamma");
    expect(svc.pausedUntilTs).toBeGreaterThan(Date.now());
  });

  it("no-op when watchdog is disabled", async () => {
    const runtime = makeRuntime([1, 0]);
    const svc = new ColonyService(runtime);
    svc.colonyConfig = {
      diversityMode: "semantic",
    } as unknown as ColonyService["colonyConfig"];
    svc.diversityWatchdog = null;
    await svc.recordGeneratedOutput("alpha");
    expect(
      (runtime.useModel as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it("semantic mode: runtime missing → passes null embedding (graceful)", async () => {
    const svc = new ColonyService(undefined as unknown as IAgentRuntime);
    svc.colonyConfig = {
      diversityMode: "semantic",
      diversityThreshold: 0.8,
      diversitySemanticThreshold: 0.9,
      diversityWindowSize: 3,
      diversityCooldownMs: 60_000,
    } as unknown as ColonyService["colonyConfig"];
    svc.diversityWatchdog = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.9,
    });
    // Should not throw even with no runtime.
    await svc.recordGeneratedOutput("alpha beta");
    await svc.recordGeneratedOutput("alpha beta");
    await svc.recordGeneratedOutput("alpha beta");
    expect(svc.pausedUntilTs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 2 — Thread-digest retry abandonment
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — thread-digest retry abandonment", () => {
  /**
   * Two-mention notification fixture pointing at post-X. Matches the
   * v0.27 test shape so the per-thread digest path is taken: ≥ 2
   * notifications on the same post_id with a dispatch-bound type.
   */
  function makeNotifications() {
    return [
      {
        id: "n1",
        notification_type: "mention",
        post_id: "post-X",
        comment_id: null,
        is_read: false,
        actor: { username: "a" },
      },
      {
        id: "n2",
        notification_type: "mention",
        post_id: "post-X",
        comment_id: null,
        is_read: false,
        actor: { username: "b" },
      },
    ];
  }

  async function makeClient(failing: boolean) {
    const client = fakeClient({
      getNotifications: vi.fn(async () => makeNotifications()),
      getPost: vi.fn(async () => ({
        id: "post-X",
        title: "Thread",
        body: "body",
        author: { username: "a" },
      })),
      markNotificationRead: vi.fn(async () => undefined),
    });
    const svc = fakeService(client, {
      notificationDigest: "per-thread",
    } as never);
    const createMemory = failing
      ? vi.fn(async () => {
          throw new Error("PGLite insert failed");
        })
      : vi.fn(async () => undefined);
    const rt = fakeRuntime(svc);
    (rt as unknown as { createMemory: typeof createMemory }).createMemory =
      createMemory;
    (rt as unknown as { getMemoryById: () => Promise<null> }).getMemoryById =
      vi.fn(async () => null);
    (rt as unknown as { ensureWorldExists: () => Promise<void> }).ensureWorldExists =
      vi.fn(async () => undefined);
    (rt as unknown as { ensureConnection: () => Promise<void> }).ensureConnection =
      vi.fn(async () => undefined);
    (rt as unknown as { ensureRoomExists: () => Promise<void> }).ensureRoomExists =
      vi.fn(async () => undefined);
    (rt as unknown as {
      messageService: { handleMessage: ReturnType<typeof vi.fn> };
    }).messageService = {
      handleMessage: vi.fn(async () => undefined),
    };
    const ic = new ColonyInteractionClient(svc as never, rt, 120_000);
    (ic as unknown as { isRunning: boolean }).isRunning = true;
    return { ic, svc, client, createMemory, rt };
  }

  async function tick(ic: ColonyInteractionClient): Promise<void> {
    await (ic as unknown as { tick: () => Promise<void> }).tick();
  }

  it("first failure: notifications NOT marked read, failures map bumped, no abandon", async () => {
    const { ic, svc, client, createMemory } = await makeClient(true);
    await tick(ic);
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(client.markNotificationRead).not.toHaveBeenCalled();
    expect(svc.threadDigestFailures!.size).toBe(1);
    expect(svc.incrementStat).not.toHaveBeenCalledWith(
      "threadDigestAbandonments",
    );
  });

  it("three failures on same key → abandon: notifications marked read + stat bumped", async () => {
    const { ic, svc, client } = await makeClient(true);
    await tick(ic);
    await tick(ic);
    expect(svc.incrementStat).not.toHaveBeenCalledWith(
      "threadDigestAbandonments",
    );
    expect(client.markNotificationRead).not.toHaveBeenCalled();
    await tick(ic);
    expect(svc.incrementStat).toHaveBeenCalledWith(
      "threadDigestAbandonments",
    );
    expect(client.markNotificationRead).toHaveBeenCalledTimes(2);
    expect(svc.threadDigestFailures!.size).toBe(0);
  });

  it("success after failures clears the failure counter", async () => {
    const { ic, svc, client, rt } = await makeClient(true);
    await tick(ic);
    expect(svc.threadDigestFailures!.size).toBe(1);
    // Flip createMemory to succeed; next tick lands the write.
    (rt as unknown as { createMemory: ReturnType<typeof vi.fn> }).createMemory = vi.fn(
      async () => undefined,
    );
    await tick(ic);
    expect(svc.threadDigestFailures!.size).toBe(0);
    expect(svc.incrementStat).toHaveBeenCalledWith("threadDigestsEmitted");
    expect(client.markNotificationRead).toHaveBeenCalledTimes(2);
  });

  it("successful write on first tick leaves the failures map empty", async () => {
    const { ic, svc, client } = await makeClient(false);
    await tick(ic);
    expect(svc.threadDigestFailures!.size).toBe(0);
    expect(svc.incrementStat).toHaveBeenCalledWith("threadDigestsEmitted");
    expect(svc.incrementStat).not.toHaveBeenCalledWith(
      "threadDigestAbandonments",
    );
    expect(client.markNotificationRead).toHaveBeenCalledTimes(2);
  });

  it("a successful write that follows N-1 failures does NOT trip abandonment", async () => {
    const { ic, svc, client, rt } = await makeClient(true);
    await tick(ic);
    await tick(ic);
    expect(svc.threadDigestFailures!.size).toBe(1);
    (rt as unknown as { createMemory: ReturnType<typeof vi.fn> }).createMemory = vi.fn(
      async () => undefined,
    );
    await tick(ic);
    expect(svc.incrementStat).not.toHaveBeenCalledWith(
      "threadDigestAbandonments",
    );
    expect(svc.incrementStat).toHaveBeenCalledWith("threadDigestsEmitted");
    expect(client.markNotificationRead).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 3 — CommentDedupRing + env parsing + action wiring
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — CommentDedupRing", () => {
  it("findDuplicate returns null on an empty ring", () => {
    const r = new CommentDedupRing();
    expect(r.findDuplicate("any text here")).toBeNull();
  });

  it("findDuplicate matches identical bodies above threshold", () => {
    const r = new CommentDedupRing({ threshold: 0.5 });
    r.record("the quick brown fox jumps over");
    const match = r.findDuplicate("the quick brown fox jumps over");
    expect(match).not.toBeNull();
    expect(match!.similarity).toBeCloseTo(1, 5);
  });

  it("findDuplicate returns null when below threshold", () => {
    const r = new CommentDedupRing({ threshold: 0.9 });
    r.record("alpha beta gamma delta");
    expect(r.findDuplicate("epsilon zeta eta theta")).toBeNull();
  });

  it("findDuplicate returns the CLOSEST prior when multiple match", () => {
    const r = new CommentDedupRing({ threshold: 0.3 });
    r.record("alpha beta gamma");
    r.record("alpha beta gamma delta epsilon");
    // Second recorded entry is a better match than the first for this input.
    const match = r.findDuplicate("alpha beta gamma delta epsilon");
    expect(match).not.toBeNull();
    expect(match!.index).toBe(1);
  });

  it("record() + size() + clear() behave as expected", () => {
    const r = new CommentDedupRing();
    expect(r.size()).toBe(0);
    r.record("alpha");
    r.record("beta");
    expect(r.size()).toBe(2);
    r.clear();
    expect(r.size()).toBe(0);
  });

  it("maxSize evicts oldest entries", () => {
    const r = new CommentDedupRing({ maxSize: 2 });
    r.record("alpha one");
    r.record("beta two");
    r.record("gamma three");
    expect(r.size()).toBe(2);
    // Oldest ("alpha one") should be gone.
    expect(r.findDuplicate("alpha one")).toBeNull();
    expect(r.findDuplicate("gamma three")).not.toBeNull();
  });

  it("empty / whitespace-only bodies are ignored on both record and findDuplicate", () => {
    const r = new CommentDedupRing({ threshold: 0.1 });
    r.record("");
    r.record("   ");
    r.record("actual content here");
    expect(r.size()).toBe(1);
    expect(r.findDuplicate("")).toBeNull();
    expect(r.findDuplicate("   ")).toBeNull();
  });

  it("constructor clamps invalid config values to defaults", () => {
    const r = new CommentDedupRing({
      maxSize: -5,
      ngram: -1,
      threshold: 2,
    });
    // maxSize clamped to 1, so ring holds only the newest.
    r.record("first entry");
    r.record("second entry");
    expect(r.size()).toBe(1);
    // threshold fell back to default (0.7) so identical text still matches.
    const match = r.findDuplicate("second entry");
    expect(match).not.toBeNull();
  });

  it("DEFAULT_DEDUP_CONFIG exposes documented values", () => {
    expect(DEFAULT_DEDUP_CONFIG.maxSize).toBe(16);
    expect(DEFAULT_DEDUP_CONFIG.ngram).toBe(3);
    expect(DEFAULT_DEDUP_CONFIG.threshold).toBe(0.7);
  });
});

describe("v0.29.0 — env config: comment dedup", () => {
  function makeRuntime(overrides: Record<string, string> = {}): IAgentRuntime {
    const settings: Record<string, string> = {
      COLONY_API_KEY: "col_test",
      ...overrides,
    };
    return {
      getSetting: (k: string) => settings[k],
    } as unknown as IAgentRuntime;
  }

  it("defaults: enabled=true, ringSize=16, threshold=0.7", () => {
    const cfg = loadColonyConfig(makeRuntime());
    expect(cfg.commentDedupEnabled).toBe(true);
    expect(cfg.commentDedupRingSize).toBe(16);
    expect(cfg.commentDedupThreshold).toBe(0.7);
  });

  it("COLONY_COMMENT_DEDUP_ENABLED=false disables", () => {
    const cfg = loadColonyConfig(
      makeRuntime({ COLONY_COMMENT_DEDUP_ENABLED: "false" }),
    );
    expect(cfg.commentDedupEnabled).toBe(false);
  });

  it("COLONY_COMMENT_DEDUP_ENABLED=0 or 'no' disables", () => {
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_ENABLED: "0" }))
        .commentDedupEnabled,
    ).toBe(false);
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_ENABLED: "no" }))
        .commentDedupEnabled,
    ).toBe(false);
  });

  it("COLONY_COMMENT_DEDUP_RING_SIZE parses and clamps", () => {
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_RING_SIZE: "32" }))
        .commentDedupRingSize,
    ).toBe(32);
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_RING_SIZE: "0" }))
        .commentDedupRingSize,
    ).toBe(1);
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_RING_SIZE: "500" }))
        .commentDedupRingSize,
    ).toBe(256);
    expect(
      loadColonyConfig(
        makeRuntime({ COLONY_COMMENT_DEDUP_RING_SIZE: "abc" }),
      ).commentDedupRingSize,
    ).toBe(16);
  });

  it("COLONY_COMMENT_DEDUP_THRESHOLD parses and clamps", () => {
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_THRESHOLD: "0.5" }))
        .commentDedupThreshold,
    ).toBe(0.5);
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_THRESHOLD: "0" }))
        .commentDedupThreshold,
    ).toBe(0.1);
    expect(
      loadColonyConfig(makeRuntime({ COLONY_COMMENT_DEDUP_THRESHOLD: "2.5" }))
        .commentDedupThreshold,
    ).toBe(1);
    expect(
      loadColonyConfig(
        makeRuntime({ COLONY_COMMENT_DEDUP_THRESHOLD: "abc" }),
      ).commentDedupThreshold,
    ).toBe(0.7);
  });
});

describe("v0.29.0 — comment dedup wiring into action paths", () => {
  const POST_UUID = "11111111-2222-3333-4444-555555555555";
  const POST_URL = `https://thecolony.cc/post/${POST_UUID}`;

  function runtimeWithModel(
    service: ReturnType<typeof fakeService>,
    response: string,
  ): IAgentRuntime {
    const base = fakeRuntime(service);
    return {
      ...base,
      character: {
        name: "eliza-test",
        bio: "A test agent.",
        topics: ["AI agents"],
        style: { all: ["Direct."], chat: ["Concrete."] },
      },
      useModel: vi.fn(async () => response),
    } as unknown as IAgentRuntime;
  }

  it("commentOnPost skips when dedup ring matches the model's generated body", async () => {
    const service = fakeService();
    const body = "This is the planned comment body.";
    const ring = new CommentDedupRing({ threshold: 0.5 });
    ring.record(body);
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;
    service.client.getPost = vi.fn(async () => ({
      id: POST_UUID,
      title: "t",
      body: "b",
      author: { username: "other" },
    })) as unknown as typeof service.client.getPost;

    const runtime = runtimeWithModel(service, body);
    const cb = makeCallback();
    await commentOnColonyPostAction.handler(
      runtime,
      fakeMessage(`comment on ${POST_URL}`),
      fakeState(),
      undefined,
      cb,
    );
    expect(service.incrementStat).toHaveBeenCalledWith("commentDedupSkips");
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("commentOnPost proceeds + records on the ring when nothing matches", async () => {
    const service = fakeService();
    const ring = new CommentDedupRing({ threshold: 0.5 });
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;
    service.client.getPost = vi.fn(async () => ({
      id: POST_UUID,
      title: "t",
      body: "b",
      author: { username: "other" },
    })) as unknown as typeof service.client.getPost;
    service.client.createComment = vi.fn(async () => ({
      id: "c1",
    })) as unknown as typeof service.client.createComment;

    const body = "A substantive reply.";
    const runtime = runtimeWithModel(service, body);
    await commentOnColonyPostAction.handler(
      runtime,
      fakeMessage(`comment on ${POST_URL}`),
      fakeState(),
      undefined,
      makeCallback(),
    );
    expect(service.client.createComment).toHaveBeenCalled();
    expect(ring.size()).toBe(1);
  });

  it("commentOnPost with dedup ring null (feature off) fires createComment unchanged", async () => {
    const service = fakeService();
    service.commentDedupRing = null;
    service.client.getPost = vi.fn(async () => ({
      id: POST_UUID,
      title: "t",
      body: "b",
      author: { username: "other" },
    })) as unknown as typeof service.client.getPost;
    service.client.createComment = vi.fn(async () => ({
      id: "c2",
    })) as unknown as typeof service.client.createComment;

    const runtime = runtimeWithModel(service, "Another reply.");
    await commentOnColonyPostAction.handler(
      runtime,
      fakeMessage(`comment on ${POST_URL}`),
      fakeState(),
      undefined,
      makeCallback(),
    );
    expect(service.client.createComment).toHaveBeenCalled();
    expect(service.incrementStat).not.toHaveBeenCalledWith("commentDedupSkips");
  });

  it("replyColonyAction skips when dedup ring matches the explicit body", async () => {
    const service = fakeService();
    const body = "Scheduled check-in, nothing to report.";
    const ring = new CommentDedupRing({ threshold: 0.5 });
    ring.record(body);
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;
    const runtime = fakeRuntime(service);
    await replyColonyAction.handler!(
      runtime,
      fakeMessage(`reply postId: ${POST_UUID}`),
      fakeState(),
      { postId: POST_UUID, body },
      makeCallback(),
    );
    expect(service.incrementStat).toHaveBeenCalledWith("commentDedupSkips");
    expect(service.client.createComment).not.toHaveBeenCalled();
  });

  it("replyColonyAction proceeds + records on the ring when nothing matches", async () => {
    const service = fakeService();
    const ring = new CommentDedupRing({ threshold: 0.5 });
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;
    service.client.createComment = vi.fn(async () => ({
      id: "c-3",
    })) as unknown as typeof service.client.createComment;
    const runtime = fakeRuntime(service);
    const body = "Freshly generated distinct reply.";
    await replyColonyAction.handler!(
      runtime,
      fakeMessage(`reply postId: ${POST_UUID}`),
      fakeState(),
      { postId: POST_UUID, body },
      makeCallback(),
    );
    expect(service.client.createComment).toHaveBeenCalled();
    expect(ring.size()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 4 — engagement-client integration
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — engagement-client comment dedup integration", () => {
  function mockRuntime(modelResponse = "A substantive reply.") {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "eliza-test",
        bio: "A test agent.",
        topics: ["AI agents"],
        style: { all: ["Direct."], chat: ["Concrete."] },
      },
      useModel: vi.fn(async () => modelResponse),
      getCache: vi.fn(async () => []),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
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

  it("skips on dedup match, marks seen, bumps stat, does NOT call createComment", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    const ring = new CommentDedupRing({ threshold: 0.3 });
    ring.record("A substantive reply.");
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;

    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-dup",
          title: "t",
          body: "b",
          author: { username: "alice" },
        },
      ],
    });

    const runtime = mockRuntime();
    const client = new ColonyEngagementClient(
      service as never,
      runtime,
      config(),
    );
    try {
      await client.start();
      await vi.advanceTimersByTimeAsync(2001);
      expect(service.incrementStat).toHaveBeenCalledWith("commentDedupSkips");
      expect(service.client.createComment).not.toHaveBeenCalled();
      const setCacheCalls = (
        runtime as unknown as { setCache: ReturnType<typeof vi.fn> }
      ).setCache.mock.calls;
      // markSeen writes the seen-set to cache.
      expect(setCacheCalls.length).toBeGreaterThan(0);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it("proceeds normally + records on ring when no dedup match", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    const ring = new CommentDedupRing({ threshold: 0.5 });
    service.commentDedupRing = ring as unknown as NonNullable<
      typeof service.commentDedupRing
    >;
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-new",
          title: "t",
          body: "b",
          author: { username: "alice" },
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c1" });

    const runtime = mockRuntime();
    const client = new ColonyEngagementClient(
      service as never,
      runtime,
      config(),
    );
    try {
      await client.start();
      await vi.advanceTimersByTimeAsync(2001);
      expect(service.client.createComment).toHaveBeenCalled();
      expect(ring.size()).toBe(1);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Index exports — regression guard for CommentDedupRing being public.
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — public surface", () => {
  it("CommentDedupRing + cosineSimilarity are exported from the plugin entry", async () => {
    const plugin = await import("../index.js");
    expect(typeof plugin.CommentDedupRing).toBe("function");
    expect(typeof plugin.cosineSimilarity).toBe("function");
    expect(plugin.DEFAULT_DEDUP_CONFIG.threshold).toBe(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Feature 5 — STATUS + HEALTH_REPORT surface when diversityMode is non-lexical
// ─────────────────────────────────────────────────────────────────────────

describe("v0.29.0 — STATUS / HEALTH_REPORT diversity mode display", () => {
  it("STATUS renders `[semantic]` tag and semantic threshold when mode is semantic", async () => {
    const { colonyStatusAction } = await import("../actions/status.js");
    const service = fakeService();
    const wd = new DiversityWatchdog({
      mode: "semantic",
      windowSize: 3,
      semanticThreshold: 0.9,
    });
    // Seed the ring with 2 entries so size() >= 2 triggers the render.
    wd.record("alpha", [1, 0]);
    wd.record("beta", [0.5, 0.5]);
    service.diversityWatchdog = wd as unknown as NonNullable<
      typeof service.diversityWatchdog
    >;
    service.colonyConfig.diversityMode = "semantic";
    service.colonyConfig.diversitySemanticThreshold = 0.9;
    service.colonyConfig.diversityThreshold = 0.8;

    const runtime = fakeRuntime(service);
    const cb = vi.fn(async () => undefined) as unknown as Parameters<
      NonNullable<typeof colonyStatusAction.handler>
    >[4];
    const spyText: string[] = [];
    const capturingCb = (async (content: { text?: string }) => {
      if (content.text) spyText.push(content.text);
      return undefined;
    }) as typeof cb;

    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("status"),
      fakeState(),
      undefined,
      capturingCb,
    );
    const text = spyText.join("\n");
    expect(text).toContain("[semantic]");
    // 90% threshold → 0.9 → "threshold 90%"
    expect(text).toMatch(/threshold 90%/);
  });

  it("STATUS renders `[both]` tag when mode is both", async () => {
    const { colonyStatusAction } = await import("../actions/status.js");
    const service = fakeService();
    const wd = new DiversityWatchdog({ mode: "both", windowSize: 3 });
    wd.record("a");
    wd.record("b");
    service.diversityWatchdog = wd as unknown as NonNullable<
      typeof service.diversityWatchdog
    >;
    service.colonyConfig.diversityMode = "both";

    const runtime = fakeRuntime(service);
    const spyText: string[] = [];
    const capturingCb = async (content: { text?: string }) => {
      if (content.text) spyText.push(content.text);
      return undefined;
    };
    await colonyStatusAction.handler!(
      runtime,
      fakeMessage("status"),
      fakeState(),
      undefined,
      capturingCb as never,
    );
    expect(spyText.join("\n")).toContain("[both]");
  });

  it("HEALTH_REPORT uses semantic threshold when mode is semantic", async () => {
    const { colonyHealthReportAction } = await import(
      "../actions/healthReport.js"
    );
    const service = fakeService();
    // Mock watchdog with a peak just under semantic threshold.
    service.diversityWatchdog = {
      peakSimilarity: () => 0.88,
    } as unknown as NonNullable<typeof service.diversityWatchdog>;
    service.colonyConfig.diversityMode = "semantic";
    service.colonyConfig.diversitySemanticThreshold = 0.9;
    service.colonyConfig.diversityThreshold = 0.8;
    service.currentKarma = 42;

    const runtime = fakeRuntime(service);
    const spyText: string[] = [];
    const capturingCb = async (content: { text?: string }) => {
      if (content.text) spyText.push(content.text);
      return undefined;
    };
    await colonyHealthReportAction.handler!(
      runtime,
      fakeMessage("health"),
      fakeState(),
      undefined,
      capturingCb as never,
    );
    const text = spyText.join("\n");
    expect(text).toContain("[semantic]");
    // 0.9 threshold, peak 0.88 → 0.88 >= 0.9 * 0.9 = 0.81 → warning ⚠️
    expect(text).toContain("⚠️");
  });
});
