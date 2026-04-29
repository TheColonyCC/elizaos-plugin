/**
 * v0.31.0 — persistent peer-summary memory.
 *
 * Each interacted-with peer gets a small `PeerSummary` record in the
 * runtime cache. The engagement and DM paths inject a private context
 * block into the prompt for known peers; observation-recording happens
 * on every successful interaction; an LLM distillation pass refreshes
 * `styleNotes` every K-th observation.
 *
 * Tests below exercise the pure helpers, the recordObservation flow,
 * the engagement + DM integration, the observability surfaces, and
 * the env-var parser. Mirrors the v0.30 test layout.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";

import {
  applyObservation,
  buildPeerContextBlock,
  capByLastSeen,
  computeRelationship,
  formatForPrompt,
  getPeerSummary,
  newSummary,
  peerMapCacheKey,
  pruneStale,
  readPeerMap,
  recordObservation,
  writePeerMap,
  type PeerMap,
  type PeerSummary,
} from "../services/peer-memory.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { dispatchDirectMessage } from "../services/dispatch.js";
import { loadColonyConfig } from "../environment.js";
import { colonyStatusAction } from "../actions/status.js";
import { colonyDiagnosticsAction } from "../actions/diagnostics.js";
import { colonyHealthReportAction } from "../actions/healthReport.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";

interface MockRuntime extends IAgentRuntime {
  useModel: ReturnType<typeof vi.fn>;
  getCache: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;
  agentId: string;
  character: {
    name: string;
    bio?: string | string[];
    topics?: string[];
    style?: { all?: string[]; chat?: string[] };
  };
}

function mockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: {
      name: "eliza-test",
      bio: "A test agent",
      topics: ["multi-agent coordination"],
      style: { all: [], chat: [] },
    },
    useModel: vi.fn(async () => ""),
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as MockRuntime;
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — newSummary", () => {
  it("returns a fresh PeerSummary at default state", () => {
    const s = newSummary("alice", 1000);
    expect(s.username).toBe("alice");
    expect(s.firstSeen).toBe(1000);
    expect(s.lastSeen).toBe(1000);
    expect(s.interactionCount).toBe(0);
    expect(s.topics).toEqual({});
    expect(s.voteHistory).toEqual({ up: 0, down: 0 });
    expect(s.styleNotes).toBe("");
    expect(s.recentPositions).toEqual([]);
    expect(s.relationship).toBe("neutral");
  });
});

describe("v0.31.0 — applyObservation", () => {
  const base = newSummary("alice", 1000);

  it("bumps interactionCount + lastSeen", () => {
    const next = applyObservation(base, { kind: "engagement-comment" }, 2000);
    expect(next.interactionCount).toBe(1);
    expect(next.lastSeen).toBe(2000);
    expect(next.firstSeen).toBe(1000);
  });

  it("increments topics counter on each provided topic", () => {
    const a = applyObservation(base, { kind: "engagement-comment", topics: ["security", "DMs"] }, 2000);
    const b = applyObservation(a, { kind: "engagement-comment", topics: ["security"] }, 3000);
    expect(b.topics).toEqual({ security: 2, dms: 1 });
  });

  it("ignores empty / whitespace-only topics", () => {
    const next = applyObservation(base, { kind: "engagement-comment", topics: ["", "   ", "real"] }, 2000);
    expect(next.topics).toEqual({ real: 1 });
  });

  it("pushes onto recentPositions ring (max 3, dedup)", () => {
    let s = applyObservation(base, { kind: "engagement-comment", position: "first" }, 2000);
    s = applyObservation(s, { kind: "engagement-comment", position: "second" }, 3000);
    s = applyObservation(s, { kind: "engagement-comment", position: "third" }, 4000);
    s = applyObservation(s, { kind: "engagement-comment", position: "fourth" }, 5000);
    expect(s.recentPositions).toEqual(["fourth", "third", "second"]);
  });

  it("dedups the same position to the front", () => {
    let s = applyObservation(base, { kind: "engagement-comment", position: "x" }, 2000);
    s = applyObservation(s, { kind: "engagement-comment", position: "y" }, 3000);
    s = applyObservation(s, { kind: "engagement-comment", position: "x" }, 4000);
    expect(s.recentPositions).toEqual(["x", "y"]);
  });

  it("truncates positions longer than 200 chars", () => {
    const long = "a".repeat(500);
    const next = applyObservation(base, { kind: "engagement-comment", position: long }, 2000);
    expect(next.recentPositions[0]?.length).toBe(200);
  });

  it("ignores empty position (whitespace-only)", () => {
    const next = applyObservation(base, { kind: "engagement-comment", position: "   " }, 2000);
    expect(next.recentPositions).toEqual([]);
  });

  it("auto-upvote increments voteHistory.up", () => {
    const next = applyObservation(base, { kind: "auto-upvote" }, 2000);
    expect(next.voteHistory).toEqual({ up: 1, down: 0 });
  });

  it("auto-downvote increments voteHistory.down", () => {
    const next = applyObservation(base, { kind: "auto-downvote" }, 2000);
    expect(next.voteHistory).toEqual({ up: 0, down: 1 });
  });

  it("manual-vote tallies as upvote", () => {
    const next = applyObservation(base, { kind: "manual-vote" }, 2000);
    expect(next.voteHistory.up).toBe(1);
  });

  it("non-vote kinds leave voteHistory unchanged", () => {
    const next = applyObservation(base, { kind: "dm-received" }, 2000);
    expect(next.voteHistory).toEqual({ up: 0, down: 0 });
  });

  it("does NOT mutate the existing summary", () => {
    const before = JSON.parse(JSON.stringify(base));
    applyObservation(base, { kind: "engagement-comment", topics: ["x"] }, 2000);
    expect(base).toEqual(before);
  });
});

describe("v0.31.0 — computeRelationship", () => {
  it("under 3 interactions stays neutral", () => {
    expect(computeRelationship({ up: 5, down: 0 }, 2)).toBe("neutral");
  });

  it(">= 2 net upvotes after 3 interactions → agreed", () => {
    expect(computeRelationship({ up: 3, down: 1 }, 4)).toBe("agreed");
  });

  it(">= 2 net downvotes after 3 interactions → disagreed", () => {
    expect(computeRelationship({ up: 0, down: 3 }, 3)).toBe("disagreed");
  });

  it("at least 1 of each within band → mixed", () => {
    expect(computeRelationship({ up: 1, down: 1 }, 5)).toBe("mixed");
  });

  it("inside-band but no votes → neutral", () => {
    expect(computeRelationship({ up: 1, down: 0 }, 3)).toBe("neutral");
  });
});

describe("v0.31.0 — pruneStale + capByLastSeen", () => {
  it("pruneStale removes entries older than ttl", () => {
    const map: PeerMap = {
      old: { ...newSummary("old", 0), lastSeen: 1000 },
      fresh: { ...newSummary("fresh", 0), lastSeen: 9000 },
    };
    const out = pruneStale(map, 5000, 10_000);
    expect(out).toHaveProperty("fresh");
    expect(out).not.toHaveProperty("old");
  });

  it("pruneStale with ttl=0 is a no-op", () => {
    const map: PeerMap = {
      old: { ...newSummary("old", 0), lastSeen: 1000 },
    };
    expect(pruneStale(map, 0, 999_999_999)).toBe(map);
  });

  it("capByLastSeen drops oldest when over cap", () => {
    const map: PeerMap = {
      a: { ...newSummary("a", 0), lastSeen: 1000 },
      b: { ...newSummary("b", 0), lastSeen: 2000 },
      c: { ...newSummary("c", 0), lastSeen: 3000 },
    };
    const out = capByLastSeen(map, 2);
    expect(Object.keys(out).sort()).toEqual(["b", "c"]);
  });

  it("capByLastSeen with maxPeers=0 is a no-op", () => {
    const map: PeerMap = { a: newSummary("a", 0) };
    expect(capByLastSeen(map, 0)).toBe(map);
  });

  it("capByLastSeen below cap is identity", () => {
    const map: PeerMap = {
      a: { ...newSummary("a", 0), lastSeen: 1 },
    };
    expect(capByLastSeen(map, 10)).toBe(map);
  });
});

describe("v0.31.0 — formatForPrompt", () => {
  it("returns empty string for zero-interaction summary", () => {
    expect(formatForPrompt(newSummary("alice", 1000), 2000)).toBe("");
  });

  it("renders all fields when populated", () => {
    const s: PeerSummary = {
      username: "alice",
      firstSeen: 1000,
      lastSeen: 1000,
      interactionCount: 5,
      topics: { security: 4, dms: 2, ml: 1 },
      voteHistory: { up: 3, down: 0 },
      styleNotes: "concrete examples preferred",
      recentPositions: ["arguing for X", "skeptical of Y"],
      relationship: "agreed",
    };
    const block = formatForPrompt(s, 1000 + 3 * 24 * 3600_000);
    expect(block).toContain("@alice");
    expect(block).toContain("3 days ago");
    expect(block).toContain("5 prior interactions");
    expect(block).toContain("security, dms, ml");
    expect(block).toContain("concrete examples preferred");
    expect(block).toContain("arguing for X");
    expect(block).toContain("Relationship: agreed");
  });

  it("uses singular forms when count = 1", () => {
    const s: PeerSummary = {
      ...newSummary("bob", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const block = formatForPrompt(s, 1000 + 24 * 3600_000);
    expect(block).toContain("1 day ago");
    expect(block).toContain("1 prior interaction");
    expect(block).not.toContain("1 prior interactions");
  });

  it("suppresses styleNotes line when empty", () => {
    const s: PeerSummary = {
      ...newSummary("alice", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const block = formatForPrompt(s, 1000);
    expect(block).not.toContain("Notes:");
  });

  it("suppresses topics line when no topics tallied", () => {
    const s: PeerSummary = {
      ...newSummary("alice", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const block = formatForPrompt(s, 1000);
    expect(block).not.toContain("Topics they care about:");
  });

  it("suppresses recent-positions line when empty", () => {
    const s: PeerSummary = {
      ...newSummary("alice", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const block = formatForPrompt(s, 1000);
    expect(block).not.toContain("Recent positions:");
  });

  it("clamps recent-day count to at least 1", () => {
    const s: PeerSummary = {
      ...newSummary("alice", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const block = formatForPrompt(s, 1000); // same instant
    expect(block).toContain("1 day ago");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cache layer
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — cache layer", () => {
  it("peerMapCacheKey includes username", () => {
    expect(peerMapCacheKey({ username: "elizagemma" })).toBe(
      "colony/peer-memory/elizagemma",
    );
  });

  it("peerMapCacheKey falls back to 'unknown' when missing", () => {
    expect(peerMapCacheKey({})).toBe("colony/peer-memory/unknown");
  });

  it("readPeerMap returns {} when runtime has no getCache", async () => {
    const rt = {} as unknown as IAgentRuntime;
    const out = await readPeerMap(rt, { username: "alice" });
    expect(out).toEqual({});
  });

  it("readPeerMap returns {} when cache value is not an object", async () => {
    const rt = {
      getCache: vi.fn(async () => "not a map" as unknown),
    } as unknown as IAgentRuntime;
    const out = await readPeerMap(rt, { username: "alice" });
    expect(out).toEqual({});
  });

  it("readPeerMap returns {} when cache value is an array", async () => {
    const rt = {
      getCache: vi.fn(async () => [] as unknown),
    } as unknown as IAgentRuntime;
    const out = await readPeerMap(rt, { username: "alice" });
    expect(out).toEqual({});
  });

  it("readPeerMap returns the cached object", async () => {
    const map: PeerMap = { bob: newSummary("bob", 1000) };
    const rt = {
      getCache: vi.fn(async () => map),
    } as unknown as IAgentRuntime;
    expect(await readPeerMap(rt, { username: "alice" })).toEqual(map);
  });

  it("writePeerMap no-ops when runtime has no setCache", async () => {
    const rt = {} as unknown as IAgentRuntime;
    await expect(
      writePeerMap(rt, { username: "alice" }, {}),
    ).resolves.toBeUndefined();
  });

  it("writePeerMap calls setCache with the proper key", async () => {
    const setCache = vi.fn(async () => undefined);
    const rt = { setCache } as unknown as IAgentRuntime;
    const map: PeerMap = { bob: newSummary("bob", 1000) };
    await writePeerMap(rt, { username: "alice" }, map);
    expect(setCache).toHaveBeenCalledWith("colony/peer-memory/alice", map);
  });
});

describe("v0.31.0 — getPeerSummary", () => {
  it("returns null when peer-memory disabled", async () => {
    const rt = mockRuntime({
      getCache: vi.fn(async () => ({ bob: newSummary("bob", 1000) })),
    });
    const result = await getPeerSummary(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: false } },
      "bob",
    );
    expect(result).toBeNull();
  });

  it("returns null when username is missing", async () => {
    const rt = mockRuntime();
    const result = await getPeerSummary(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      undefined,
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown peer", async () => {
    const rt = mockRuntime({
      getCache: vi.fn(async () => ({})),
    });
    const result = await getPeerSummary(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      "stranger",
    );
    expect(result).toBeNull();
  });

  it("returns the summary for known peer", async () => {
    const bob = newSummary("bob", 1000);
    const rt = mockRuntime({
      getCache: vi.fn(async () => ({ bob })),
    });
    const result = await getPeerSummary(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      "bob",
    );
    expect(result).toEqual(bob);
  });
});

describe("v0.31.0 — buildPeerContextBlock", () => {
  function setupRuntime(map: PeerMap): MockRuntime {
    return mockRuntime({ getCache: vi.fn(async () => map) });
  }

  it("returns empty when peer-memory disabled", async () => {
    const rt = setupRuntime({ bob: newSummary("bob", 1000) });
    const block = await buildPeerContextBlock(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: false } },
      ["bob"],
      2000,
    );
    expect(block).toBe("");
  });

  it("returns empty when no candidate is a known peer", async () => {
    const rt = setupRuntime({});
    const block = await buildPeerContextBlock(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      ["stranger"],
      2000,
    );
    expect(block).toBe("");
  });

  it("filters out self and dedups", async () => {
    const bob: PeerSummary = {
      ...newSummary("bob", 1000),
      interactionCount: 2,
      lastSeen: 1000,
    };
    const rt = setupRuntime({ bob });
    const block = await buildPeerContextBlock(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      ["alice", "bob", "bob", undefined],
      2000,
    );
    expect(block).toContain("@bob");
    expect(block.match(/@bob/g)?.length).toBe(1);
  });

  it("composes blocks for multiple known peers", async () => {
    const bob: PeerSummary = {
      ...newSummary("bob", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const carol: PeerSummary = {
      ...newSummary("carol", 1000),
      interactionCount: 1,
      lastSeen: 1000,
    };
    const rt = setupRuntime({ bob, carol });
    const block = await buildPeerContextBlock(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      ["bob", "carol"],
      2000,
    );
    expect(block).toContain("@bob");
    expect(block).toContain("@carol");
  });

  it("returns empty when given no usernames", async () => {
    const rt = setupRuntime({ bob: newSummary("bob", 1000) });
    const block = await buildPeerContextBlock(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      [],
      2000,
    );
    expect(block).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// recordObservation flow
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — recordObservation", () => {
  it("no-op when peer-memory disabled", async () => {
    const setCache = vi.fn(async () => undefined);
    const rt = mockRuntime({ setCache });
    await recordObservation(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: false } },
      "bob",
      { kind: "engagement-comment" },
    );
    expect(setCache).not.toHaveBeenCalled();
  });

  it("no-op when username missing", async () => {
    const setCache = vi.fn(async () => undefined);
    const rt = mockRuntime({ setCache });
    await recordObservation(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      undefined,
      { kind: "engagement-comment" },
    );
    expect(setCache).not.toHaveBeenCalled();
  });

  it("no-op when peer is self", async () => {
    const setCache = vi.fn(async () => undefined);
    const rt = mockRuntime({ setCache });
    await recordObservation(
      rt,
      { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
      "alice",
      { kind: "engagement-comment" },
    );
    expect(setCache).not.toHaveBeenCalled();
  });

  it("first observation creates a new summary in the map", async () => {
    let map: PeerMap = {};
    const setCache = vi.fn(async (_key: string, value: PeerMap) => {
      map = value;
    });
    const getCache = vi.fn(async () => map);
    const rt = mockRuntime({ getCache, setCache });
    const setEntries = vi.fn();
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true },
        setPeerMemoryEntries: setEntries,
      },
      "bob",
      { kind: "engagement-comment", topics: ["security"] },
      { now: 5000 },
    );
    expect(map.bob).toBeTruthy();
    expect(map.bob?.interactionCount).toBe(1);
    expect(map.bob?.topics.security).toBe(1);
    expect(setEntries).toHaveBeenCalledWith(1);
  });

  it("distillation runs every K-th interaction (K=3)", async () => {
    let map: PeerMap = {};
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "concise, technical");
    const incrementStat = vi.fn();
    const rt = mockRuntime({ getCache, setCache, useModel });

    for (let i = 0; i < 6; i++) {
      await recordObservation(
        rt,
        {
          username: "alice",
          colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 3 },
          incrementStat,
        },
        "bob",
        { kind: "engagement-comment" },
        { now: 1000 + i * 100 },
      );
    }
    // Distillation runs at interactionCount = 3 and 6 → 2 calls.
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(incrementStat).toHaveBeenCalledWith("peerMemoryDistillations");
    expect(incrementStat.mock.calls.length).toBe(2);
    expect(map.bob?.styleNotes).toBe("concise, technical");
  });

  it("distillation prompt includes topics + positions when populated", async () => {
    let map: PeerMap = {
      bob: {
        ...newSummary("bob", 1000),
        interactionCount: 4,
        topics: { security: 3, ml: 1 },
        recentPositions: ["claimed X is faster than Y"],
      },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "tight notes");
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
      },
      "bob",
      { kind: "engagement-comment", topics: ["security"] },
      { now: 5000 },
    );
    const prompt = useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("topics they care about: security");
    expect(prompt).toContain("recent positions (paraphrased): claimed X is faster than Y");
  });

  it("distillation prompt handles peer with no topics or positions yet", async () => {
    let map: PeerMap = {
      bob: { ...newSummary("bob", 1000), interactionCount: 4 },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "fresh notes");
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
      },
      "bob",
      // No topics, no position — exercises the (none yet) branches in
      // the distillation prompt builder.
      { kind: "engagement-comment" },
      { now: 5000 },
    );
    expect(useModel).toHaveBeenCalled();
    const prompt = useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("(none yet)");
    expect(map.bob?.styleNotes).toBe("fresh notes");
  });

  it("distillation between K-th interactions does NOT call useModel", async () => {
    let map: PeerMap = {};
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "x");
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
      },
      "bob",
      { kind: "engagement-comment" },
      { now: 1000 },
    );
    expect(useModel).not.toHaveBeenCalled();
  });

  it("distillation failure preserves existing styleNotes", async () => {
    let map: PeerMap = {
      bob: {
        ...newSummary("bob", 1000),
        interactionCount: 4,
        styleNotes: "previous notes",
      },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => {
      throw new Error("model down");
    });
    const incrementStat = vi.fn();
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
        incrementStat,
      },
      "bob",
      { kind: "engagement-comment" },
      { now: 5000 },
    );
    // 5th interaction triggered distillation, useModel threw, notes preserved.
    expect(useModel).toHaveBeenCalled();
    expect(map.bob?.styleNotes).toBe("previous notes");
    // Distillation counter NOT bumped on failure.
    expect(incrementStat).not.toHaveBeenCalled();
  });

  it("distillation returning empty string preserves existing styleNotes", async () => {
    let map: PeerMap = {
      bob: {
        ...newSummary("bob", 1000),
        interactionCount: 4,
        styleNotes: "kept",
      },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "  ");
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
      },
      "bob",
      { kind: "engagement-comment" },
      { now: 5000 },
    );
    expect(map.bob?.styleNotes).toBe("kept");
  });

  it("distillation truncates style notes longer than 500 chars", async () => {
    let map: PeerMap = {
      bob: { ...newSummary("bob", 1000), interactionCount: 4 },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const long = "x".repeat(800);
    const useModel = vi.fn(async () => long);
    const rt = mockRuntime({ getCache, setCache, useModel });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: { peerMemoryEnabled: true, peerMemoryDistillEvery: 5 },
      },
      "bob",
      { kind: "engagement-comment" },
      { now: 5000 },
    );
    expect(map.bob?.styleNotes.length).toBe(500);
  });

  it("distillation distillEvery clamps non-finite to default 5", async () => {
    let map: PeerMap = {};
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const useModel = vi.fn(async () => "ok");
    const rt = mockRuntime({ getCache, setCache, useModel });
    for (let i = 0; i < 5; i++) {
      await recordObservation(
        rt,
        {
          username: "alice",
          colonyConfig: {
            peerMemoryEnabled: true,
            peerMemoryDistillEvery: NaN,
          },
        },
        "bob",
        { kind: "engagement-comment" },
        { now: 1000 + i * 100 },
      );
    }
    // NaN → default 5 → distillation fires on the 5th observation.
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("TTL pruning removes stale entries on write", async () => {
    let map: PeerMap = {
      old: { ...newSummary("old", 0), lastSeen: 0 },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const rt = mockRuntime({ getCache, setCache });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: {
          peerMemoryEnabled: true,
          peerMemoryTtlMs: 1000,
        },
      },
      "fresh",
      { kind: "engagement-comment" },
      { now: 10_000 },
    );
    expect(map).not.toHaveProperty("old");
    expect(map).toHaveProperty("fresh");
  });

  it("MAX_PEERS cap drops the oldest on write", async () => {
    let map: PeerMap = {
      a: { ...newSummary("a", 0), lastSeen: 1000 },
      b: { ...newSummary("b", 0), lastSeen: 2000 },
    };
    const setCache = vi.fn(async (_k: string, v: PeerMap) => {
      map = v;
    });
    const getCache = vi.fn(async () => map);
    const rt = mockRuntime({ getCache, setCache });
    await recordObservation(
      rt,
      {
        username: "alice",
        colonyConfig: {
          peerMemoryEnabled: true,
          peerMemoryMaxPeers: 2,
        },
      },
      "c",
      { kind: "engagement-comment" },
      { now: 3000 },
    );
    expect(Object.keys(map).sort()).toEqual(["b", "c"]);
  });

  it("swallows internal errors gracefully", async () => {
    const rt = mockRuntime({
      getCache: vi.fn(async () => {
        throw new Error("cache down");
      }),
    });
    await expect(
      recordObservation(
        rt,
        { username: "alice", colonyConfig: { peerMemoryEnabled: true } },
        "bob",
        { kind: "engagement-comment" },
      ),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Engagement client integration
// ─────────────────────────────────────────────────────────────────────────

function eClientConfig(overrides = {}) {
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

describe("v0.31.0 — engagement-client integration", () => {
  let service: FakeService;
  let runtime: MockRuntime;
  let client: ColonyEngagementClient;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    runtime = mockRuntime();
  });

  afterEach(async () => {
    if (client) await client.stop();
    vi.useRealTimers();
  });

  it("peer-memory disabled: no peer-context injection in prompt", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p1", title: "X", body: "Y", author: { username: "bob" } }],
    });
    runtime.getCache = vi.fn(async () => ({
      bob: { ...newSummary("bob", 1000), interactionCount: 5 },
    }));
    runtime.useModel = vi.fn(async () => "A reply.");
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig(),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    expect(prompt).not.toContain("Context on @bob");
  });

  it("peer-memory enabled, known peer: context injected into prompt", async () => {
    service.client.getPosts.mockResolvedValue({
      items: [{ id: "p1", title: "X", body: "Y", author: { username: "bob" } }],
    });
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === "colony/peer-memory/eliza-test") {
        return {
          bob: {
            ...newSummary("bob", 1000),
            interactionCount: 5,
            lastSeen: Date.now(),
            topics: { security: 3 },
            styleNotes: "concrete examples preferred",
            relationship: "agreed" as const,
          },
        };
      }
      return [];
    });
    runtime.useModel = vi.fn(async () => "A reply.");
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig({
        peerMemoryEnabled: false,
      }),
    );
    // Override config to enable peer-memory via the service's
    // colonyConfig (engagement client looks at service.colonyConfig
    // through buildPeerContextBlock).
    service.colonyConfig.peerMemoryEnabled = true;
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("Context on @bob");
    expect(prompt).toContain("concrete examples preferred");
  });

  it("peer-memory enabled, unknown peer: no context block, but observation recorded", async () => {
    let map: PeerMap = {};
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === "colony/peer-memory/eliza-test") return map;
      return [];
    });
    runtime.setCache = vi.fn(async (key: string, v: unknown) => {
      if (key === "colony/peer-memory/eliza-test") {
        map = v as PeerMap;
      }
    });
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "X",
          body: "Y",
          author: { username: "stranger" },
          tags: ["security"],
        },
      ],
    });
    service.client.createComment.mockResolvedValue({ id: "c1" });
    runtime.useModel = vi.fn(async () => "A reply.");
    service.colonyConfig.peerMemoryEnabled = true;
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig(),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    const prompt = runtime.useModel.mock.calls[0][1].prompt as string;
    expect(prompt).not.toContain("Context on @stranger");
    // After createComment success, a peer-memory observation should land.
    expect(map.stranger).toBeTruthy();
    expect(map.stranger?.interactionCount).toBe(1);
    expect(map.stranger?.topics.security).toBe(1);
  });

  it("watched-engagement createComment success records peer observation", async () => {
    let map: PeerMap = {};
    const watchKey = "colony/watch-list/eliza-test";
    const peerKey = "colony/peer-memory/eliza-test";
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === peerKey) return map;
      if (key === watchKey) {
        return [{ postId: "w1", addedAt: 0, lastCommentCount: 0 }];
      }
      return [];
    });
    runtime.setCache = vi.fn(async (key: string, v: unknown) => {
      if (key === peerKey) map = v as PeerMap;
    });
    // First getPost (in picker) returns updated count; second (in engager)
    // returns the post body. Uses tags/title undefined to exercise the
    // `?? []` and `?? ""` fallback branches in the recordObservation call.
    let getPostN = 0;
    service.client.getPost.mockImplementation(async () => {
      if (getPostN++ === 0) {
        return { id: "w1", comment_count: 5 };
      }
      return {
        id: "w1",
        body: "watched body content",
        author: { username: "watched-author" },
      };
    });
    service.client.createComment.mockResolvedValue({ id: "wc-1" });
    runtime.useModel = vi.fn(async () => "watched reply");
    service.colonyConfig.peerMemoryEnabled = true;
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig({
        threadComments: 0,
      }),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalled();
    expect(map["watched-author"]).toBeTruthy();
    expect(map["watched-author"]?.interactionCount).toBe(1);
    // Position falls through to body slice when title is missing.
    expect(map["watched-author"]?.recentPositions[0]).toContain(
      "watched body content",
    );
  });

  it("watched-engagement with no post.author silently skips peer observation", async () => {
    let map: PeerMap = {};
    const watchKey = "colony/watch-list/eliza-test";
    const peerKey = "colony/peer-memory/eliza-test";
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === peerKey) return map;
      if (key === watchKey) {
        return [{ postId: "w2", addedAt: 0, lastCommentCount: 0 }];
      }
      return [];
    });
    runtime.setCache = vi.fn(async (key: string, v: unknown) => {
      if (key === peerKey) map = v as PeerMap;
    });
    let getPostN = 0;
    service.client.getPost.mockImplementation(async () => {
      if (getPostN++ === 0) return { id: "w2", comment_count: 5 };
      // No author, no title, no body — exercises the `?.` and `??`
      // fallback branches in the recordPeerObservation call site.
      return { id: "w2", title: "x", tags: ["t"] };
    });
    service.client.createComment.mockResolvedValue({ id: "wc-2" });
    runtime.useModel = vi.fn(async () => "watched reply");
    service.colonyConfig.peerMemoryEnabled = true;
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig({
        threadComments: 0,
      }),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalled();
    // No author → recordPeerObservation early-returns; map stays empty.
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("auto-vote on a thread comment records observation under that comment's author", async () => {
    let map: PeerMap = {};
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === "colony/peer-memory/eliza-test") return map;
      if (key === "colony/curate/voted/eliza-test") return [];
      return [];
    });
    runtime.setCache = vi.fn(async (key: string, v: unknown) => {
      if (key === "colony/peer-memory/eliza-test") {
        map = v as PeerMap;
      }
    });
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "X",
          body: "Y",
          author: { username: "alice" },
        },
      ],
    });
    const cl = service.client as unknown as {
      getComments: ReturnType<typeof vi.fn>;
    };
    cl.getComments = vi.fn(async () => ({
      items: [{ id: "c1", body: "great point", author: { username: "carol" } }],
    }));
    let n = 0;
    runtime.useModel = vi.fn(async () => {
      n++;
      // Score order: post → SKIP, comment → EXCELLENT; then comment generation.
      if (n === 1) return "SKIP";
      if (n === 2) return "EXCELLENT";
      return "A reply.";
    });
    service.colonyConfig.peerMemoryEnabled = true;
    service.colonyConfig.autoVoteEnabled = true;
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig({
        autoVoteEnabled: true,
        autoDownvoteEnabled: false,
        autoVoteMaxPerTick: 5,
        autoVoteIncludeComments: true,
        threadComments: 3,
      }),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.voteComment).toHaveBeenCalledWith("c1", 1);
    // The auto-upvote observation lands under the comment's author, not
    // the post's author.
    expect(map.carol).toBeTruthy();
    expect(map.carol?.voteHistory.up).toBeGreaterThanOrEqual(1);
  });

  it("auto-vote upvote also records peer observation", async () => {
    let map: PeerMap = {};
    runtime.getCache = vi.fn(async (key: string) => {
      if (key === "colony/peer-memory/eliza-test") return map;
      if (key === "colony/curate/voted/eliza-test") return [];
      return [];
    });
    runtime.setCache = vi.fn(async (key: string, v: unknown) => {
      if (key === "colony/peer-memory/eliza-test") {
        map = v as PeerMap;
      }
    });
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "p1",
          title: "X",
          body: "Y",
          author: { username: "bob" },
          tags: ["AI"],
        },
      ],
    });
    let n = 0;
    runtime.useModel = vi.fn(async () => {
      n++;
      return n === 1 ? "EXCELLENT" : "A reply.";
    });
    service.colonyConfig.peerMemoryEnabled = true;
    service.colonyConfig.autoVoteEnabled = true;
    client = new ColonyEngagementClient(
      service as never,
      runtime,
      eClientConfig({
        autoVoteEnabled: true,
        autoDownvoteEnabled: false,
        autoVoteIncludeComments: false,
      }),
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(map.bob).toBeTruthy();
    expect(map.bob?.voteHistory.up).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DM dispatch integration
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — DM dispatch integration", () => {
  function dmRuntime(map: PeerMap, captured: { framedText?: string }) {
    return mockRuntime({
      getCache: vi.fn(async (key: string) => {
        if (key === "colony/peer-memory/eliza-test") return map;
        return undefined;
      }),
      setCache: vi.fn(async (key: string, v: unknown) => {
        if (key === "colony/peer-memory/eliza-test") {
          Object.assign(map, v as PeerMap);
        }
      }),
      messageService: {
        handleMessage: vi.fn(
          async (
            _runtime: unknown,
            mem: { content: { text?: string } },
          ) => {
            captured.framedText = mem.content?.text ?? "";
            return [];
          },
        ),
      },
      ensureWorldExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      createMemory: vi.fn(async () => undefined),
      getMemoryById: vi.fn(async () => null),
    } as unknown as Partial<MockRuntime>);
  }

  it("dispatches with peer block when sender is a known peer", async () => {
    const map: PeerMap = {
      bob: {
        ...newSummary("bob", 1000),
        interactionCount: 4,
        lastSeen: Date.now(),
        styleNotes: "prefers terse replies",
      },
    };
    const captured: { framedText?: string } = {};
    const rt = dmRuntime(map, captured);
    const service = fakeService();
    service.username = "eliza-test";
    service.colonyConfig.peerMemoryEnabled = true;
    service.colonyConfig.dmPromptMode = "none";
    const client = service.client as unknown as {
      sendMessage: ReturnType<typeof vi.fn>;
      markConversationRead: ReturnType<typeof vi.fn>;
    };
    client.sendMessage = vi.fn(async () => ({ id: "msg-1" }));
    client.markConversationRead = vi.fn(async () => undefined);
    const fresh = await dispatchDirectMessage(
      service as never,
      rt as never,
      {
        senderUsername: "bob",
        body: "hey, thoughts on X?",
        memoryIdKey: "dm-bob-1",
        conversationId: "conv-1",
      },
    );
    expect(fresh).toBe(true);
    expect(captured.framedText).toContain("Context on @bob");
    expect(captured.framedText).toContain("prefers terse replies");
    expect(captured.framedText).toContain("hey, thoughts on X?");
    // Observation recorded on receipt.
    expect(map.bob?.interactionCount).toBe(5);
  });

  it("dispatches without peer block when sender is unknown", async () => {
    const map: PeerMap = {};
    const captured: { framedText?: string } = {};
    const rt = dmRuntime(map, captured);
    const service = fakeService();
    service.username = "eliza-test";
    service.colonyConfig.peerMemoryEnabled = true;
    service.colonyConfig.dmPromptMode = "none";
    const client = service.client as unknown as {
      sendMessage: ReturnType<typeof vi.fn>;
      markConversationRead: ReturnType<typeof vi.fn>;
    };
    client.sendMessage = vi.fn(async () => ({ id: "msg-1" }));
    client.markConversationRead = vi.fn(async () => undefined);
    await dispatchDirectMessage(service as never, rt as never, {
      senderUsername: "stranger",
      body: "first contact",
      memoryIdKey: "dm-stranger-1",
      conversationId: "conv-2",
    });
    expect(captured.framedText).not.toContain("Context on @stranger");
    expect(captured.framedText).toContain("first contact");
    // First DM creates a baseline entry for the new peer.
    expect(map.stranger?.interactionCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — observability surfaces", () => {
  it("STATUS quiet when peer-memory disabled", async () => {
    const service = fakeService();
    service.username = "eliza-test";
    const cb = makeCallback();
    await colonyStatusAction.handler(
      fakeRuntime(service as never),
      fakeMessage("status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).not.toContain("Peer memory");
  });

  it("STATUS surfaces entries + distillations when enabled", async () => {
    const service = fakeService({}, { peerMemoryEnabled: true });
    service.username = "eliza-test";
    if (service.stats) {
      service.stats.peerMemoryEntries = 7;
      service.stats.peerMemoryDistillations = 2;
    }
    const cb = makeCallback();
    await colonyStatusAction.handler(
      fakeRuntime(service as never),
      fakeMessage("status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("Peer memory: 7 entries, 2 distillations");
  });

  it("STATUS uses singular forms when count = 1", async () => {
    const service = fakeService({}, { peerMemoryEnabled: true });
    service.username = "eliza-test";
    if (service.stats) {
      service.stats.peerMemoryEntries = 1;
      service.stats.peerMemoryDistillations = 1;
    }
    const cb = makeCallback();
    await colonyStatusAction.handler(
      fakeRuntime(service as never),
      fakeMessage("status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("Peer memory: 1 entry, 1 distillation");
  });

  it("DIAGNOSTICS always renders peer-memory line (off → 'disabled')", async () => {
    const service = fakeService();
    service.username = "eliza-test";
    const cb = makeCallback();
    await colonyDiagnosticsAction.handler(
      fakeRuntime(service as never),
      fakeMessage("diagnostics"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("Peer memory: disabled");
  });

  it("DIAGNOSTICS renders full config dump when enabled", async () => {
    const service = fakeService(
      {},
      {
        peerMemoryEnabled: true,
        peerMemoryDistillEvery: 7,
        peerMemoryMaxPeers: 50,
        peerMemoryTtlMs: 30 * 24 * 3600_000,
      },
    );
    service.username = "eliza-test";
    if (service.stats) {
      service.stats.peerMemoryEntries = 12;
      service.stats.peerMemoryDistillations = 3;
    }
    const cb = makeCallback();
    await colonyDiagnosticsAction.handler(
      fakeRuntime(service as never),
      fakeMessage("diagnostics"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("Peer memory: enabled");
    expect(text).toContain("cap 50");
    expect(text).toContain("distill every 7");
    expect(text).toContain("TTL 30d");
    expect(text).toContain("12 entries, 3 distillations");
  });

  it("HEALTH_REPORT quiet when peer-memory disabled", async () => {
    const service = fakeService();
    service.username = "eliza-test";
    const cb = makeCallback();
    await colonyHealthReportAction.handler(
      fakeRuntime(service as never),
      fakeMessage("health"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).not.toContain("Peer memory");
  });

  it("HEALTH_REPORT renders peer-memory line when enabled", async () => {
    const service = fakeService({}, { peerMemoryEnabled: true });
    service.username = "eliza-test";
    if (service.stats) {
      service.stats.peerMemoryEntries = 4;
      service.stats.peerMemoryDistillations = 1;
    }
    const cb = makeCallback();
    await colonyHealthReportAction.handler(
      fakeRuntime(service as never),
      fakeMessage("health"),
      fakeState(),
      undefined,
      cb,
    );
    const text = (cb.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain("Peer memory: 4 entries (1 distillations this session)");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Environment — env-var defaults + clamping
// ─────────────────────────────────────────────────────────────────────────

describe("v0.31.0 — loadColonyConfig peer-memory knobs", () => {
  function rt(settings: Record<string, string>): IAgentRuntime {
    return {
      getSetting: (key: string) => settings[key] ?? null,
    } as unknown as IAgentRuntime;
  }

  it("defaults: disabled, K=5, max=200, TTL=90d", () => {
    const cfg = loadColonyConfig(rt({ COLONY_API_KEY: "col_x" }));
    expect(cfg.peerMemoryEnabled).toBe(false);
    expect(cfg.peerMemoryDistillEvery).toBe(5);
    expect(cfg.peerMemoryMaxPeers).toBe(200);
    expect(cfg.peerMemoryTtlMs).toBe(90 * 24 * 3600_000);
  });

  it("COLONY_PEER_MEMORY_ENABLED=true flips master switch", () => {
    const cfg = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_ENABLED: "true" }),
    );
    expect(cfg.peerMemoryEnabled).toBe(true);
  });

  it("COLONY_PEER_MEMORY_ENABLED=1 flips master switch", () => {
    const cfg = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_ENABLED: "1" }),
    );
    expect(cfg.peerMemoryEnabled).toBe(true);
  });

  it("distill-every clamps to [1, 50]", () => {
    const high = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_DISTILL_EVERY: "999" }),
    );
    expect(high.peerMemoryDistillEvery).toBe(50);
    const low = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_DISTILL_EVERY: "0" }),
    );
    expect(low.peerMemoryDistillEvery).toBe(1);
  });

  it("distill-every non-numeric falls back to default 5", () => {
    const cfg = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_DISTILL_EVERY: "banana" }),
    );
    expect(cfg.peerMemoryDistillEvery).toBe(5);
  });

  it("max-peers clamps to [10, 1000]", () => {
    const high = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_MAX_PEERS: "9999" }),
    );
    expect(high.peerMemoryMaxPeers).toBe(1000);
    const low = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_MAX_PEERS: "1" }),
    );
    expect(low.peerMemoryMaxPeers).toBe(10);
  });

  it("max-peers non-numeric falls back to default 200", () => {
    const cfg = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_MAX_PEERS: "x" }),
    );
    expect(cfg.peerMemoryMaxPeers).toBe(200);
  });

  it("TTL-days clamps to [1, 365]", () => {
    const high = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_TTL_DAYS: "9999" }),
    );
    expect(high.peerMemoryTtlMs).toBe(365 * 24 * 3600_000);
    const low = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_TTL_DAYS: "0" }),
    );
    expect(low.peerMemoryTtlMs).toBe(1 * 24 * 3600_000);
  });

  it("TTL-days non-numeric falls back to default 90d", () => {
    const cfg = loadColonyConfig(
      rt({ COLONY_API_KEY: "col_x", COLONY_PEER_MEMORY_TTL_DAYS: "x" }),
    );
    expect(cfg.peerMemoryTtlMs).toBe(90 * 24 * 3600_000);
  });
});
