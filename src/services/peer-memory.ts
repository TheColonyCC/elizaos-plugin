/**
 * v0.31 — persistent peer-summary memory.
 *
 * Each peer the agent has interacted with gets a small `PeerSummary`
 * record stored in the runtime cache. Updates happen in two phases:
 *
 *   1. Cheap structured update (always): bump `interactionCount`,
 *      update `lastSeen`, increment `topics` counters, push onto the
 *      `recentPositions` ring, recompute `relationship` from
 *      `voteHistory`.
 *   2. Expensive LLM distillation (every K-th interaction): refresh
 *      `styleNotes` via a small-model call.
 *
 * The map is single-record per agent (`colony/peer-memory/<self>`)
 * holding `Record<peerUsername, PeerSummary>`. Same shape as the
 * curate-ledger and watch-list — no semantic retrieval, no PGLite,
 * lookup is by exact username.
 *
 * Privacy: stored summaries are derived metadata, never republished.
 * The prompt injection block instructs the model not to cite the
 * notes verbatim, and `recentPositions` entries are short paraphrases
 * (truncated at 200 chars).
 */

import { ModelType, logger, type IAgentRuntime } from "@elizaos/core";

const PEER_MEMORY_CACHE_PREFIX = "colony/peer-memory";
const RECENT_POSITIONS_RING = 3;
const POSITION_MAX_CHARS = 200;
const STYLE_NOTES_MAX_CHARS = 500;
const TOP_TOPICS_FOR_PROMPT = 3;
const TOP_TOPICS_FOR_DISTILL = 5;

export type PeerObservationKind =
  | "engagement-comment"
  | "watched-comment"
  | "dm-received"
  | "dm-reply-sent"
  | "comment-on-self"
  | "auto-upvote"
  | "auto-downvote"
  | "manual-vote";

export type Relationship = "neutral" | "agreed" | "disagreed" | "mixed";

export interface PeerSummary {
  username: string;
  firstSeen: number;
  lastSeen: number;
  interactionCount: number;
  topics: Record<string, number>;
  voteHistory: { up: number; down: number };
  styleNotes: string;
  recentPositions: string[];
  relationship: Relationship;
}

export interface PeerObservation {
  kind: PeerObservationKind;
  topics?: string[];
  position?: string;
}

interface ServiceLike {
  username?: string;
  colonyConfig?: {
    peerMemoryEnabled?: boolean;
    peerMemoryDistillEvery?: number;
    peerMemoryMaxPeers?: number;
    peerMemoryTtlMs?: number;
  };
  incrementStat?: (key: "peerMemoryDistillations") => void;
  setPeerMemoryEntries?: (n: number) => void;
}

export type PeerMap = Record<string, PeerSummary>;

export function peerMapCacheKey(service: ServiceLike): string {
  const username = service.username ?? "unknown";
  return `${PEER_MEMORY_CACHE_PREFIX}/${username}`;
}

export function newSummary(username: string, now: number): PeerSummary {
  return {
    username,
    firstSeen: now,
    lastSeen: now,
    interactionCount: 0,
    topics: {},
    voteHistory: { up: 0, down: 0 },
    styleNotes: "",
    recentPositions: [],
    relationship: "neutral",
  };
}

/**
 * Pure structured-update phase. Increments counters, updates the
 * `recentPositions` ring, and recomputes `relationship` from the new
 * `voteHistory` totals. Does NOT call the LLM — distillation is a
 * separate phase the caller orchestrates.
 */
export function applyObservation(
  existing: PeerSummary,
  obs: PeerObservation,
  now: number,
): PeerSummary {
  const next: PeerSummary = {
    ...existing,
    lastSeen: now,
    interactionCount: existing.interactionCount + 1,
    topics: { ...existing.topics },
    voteHistory: { ...existing.voteHistory },
    recentPositions: [...existing.recentPositions],
  };

  if (obs.topics?.length) {
    for (const t of obs.topics) {
      const key = String(t).toLowerCase().trim();
      if (!key) continue;
      next.topics[key] = (next.topics[key] ?? 0) + 1;
    }
  }

  if (obs.position) {
    const truncated = obs.position.slice(0, POSITION_MAX_CHARS).trim();
    if (truncated) {
      next.recentPositions = [
        truncated,
        ...next.recentPositions.filter((p) => p !== truncated),
      ].slice(0, RECENT_POSITIONS_RING);
    }
  }

  if (obs.kind === "auto-upvote" || obs.kind === "manual-vote") {
    next.voteHistory.up += 1;
  } else if (obs.kind === "auto-downvote") {
    next.voteHistory.down += 1;
  }

  next.relationship = computeRelationship(
    next.voteHistory,
    next.interactionCount,
  );

  return next;
}

/**
 * Mechanical relationship state machine. Not LLM-derived — the
 * structured signals from auto-vote outcomes (v0.30) are enough.
 */
export function computeRelationship(
  vh: { up: number; down: number },
  interactionCount: number,
): Relationship {
  if (interactionCount < 3) return "neutral";
  const delta = vh.up - vh.down;
  if (delta >= 2) return "agreed";
  if (delta <= -2) return "disagreed";
  if (vh.up >= 1 && vh.down >= 1) return "mixed";
  return "neutral";
}

/**
 * TTL prune: remove peers we haven't interacted with in `ttlMs`. Pure;
 * caller decides when to call it (typically before each cache write).
 */
export function pruneStale(
  map: PeerMap,
  ttlMs: number,
  now: number,
): PeerMap {
  if (ttlMs <= 0) return map;
  const cutoff = now - ttlMs;
  const out: PeerMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (v.lastSeen >= cutoff) out[k] = v;
  }
  return out;
}

/**
 * LRU-by-`lastSeen` cap. When the map exceeds `maxPeers`, drop the
 * oldest by `lastSeen`. Pure; caller decides cadence.
 */
export function capByLastSeen(map: PeerMap, maxPeers: number): PeerMap {
  if (maxPeers <= 0) return map;
  const entries = Object.entries(map);
  if (entries.length <= maxPeers) return map;
  entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const out: PeerMap = {};
  for (const [k, v] of entries.slice(0, maxPeers)) out[k] = v;
  return out;
}

/**
 * Render a peer summary into the private-context block that gets
 * prepended to engagement / DM-reply prompts. Returns "" when the
 * summary is too thin to be useful (e.g. first interaction with no
 * style notes yet) so the caller can suppress the block cleanly.
 */
export function formatForPrompt(summary: PeerSummary, now: number): string {
  const ageDays = Math.max(
    1,
    Math.round((now - summary.lastSeen) / (24 * 3600_000)),
  );
  const topTopics = Object.entries(summary.topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOPICS_FOR_PROMPT)
    .map(([k]) => k);

  // Even a single prior interaction is worth surfacing — the agent at
  // least knows "we've talked before." Skip only when literally no
  // signal exists (interactionCount = 0, which shouldn't happen since
  // we only have a summary when they've been observed).
  if (summary.interactionCount <= 0) return "";

  const lines: string[] = [
    `Context on @${summary.username} (private — do NOT cite verbatim or reference these notes explicitly):`,
    `- Last interacted: ${ageDays} day${ageDays === 1 ? "" : "s"} ago, ${summary.interactionCount} prior interaction${summary.interactionCount === 1 ? "" : "s"}`,
  ];
  if (topTopics.length) {
    lines.push(`- Topics they care about: ${topTopics.join(", ")}`);
  }
  if (summary.styleNotes) {
    lines.push(`- Notes: ${summary.styleNotes}`);
  }
  if (summary.recentPositions.length) {
    lines.push(`- Recent positions: ${summary.recentPositions.join(" | ")}`);
  }
  lines.push(`- Relationship: ${summary.relationship}`);
  return lines.join("\n");
}

interface CacheRuntime {
  getCache?: <T>(key: string) => Promise<T | undefined>;
  setCache?: <T>(key: string, value: T) => Promise<void>;
}

export async function readPeerMap(
  runtime: IAgentRuntime,
  service: ServiceLike,
): Promise<PeerMap> {
  const rt = runtime as unknown as CacheRuntime;
  if (typeof rt.getCache !== "function") return {};
  const cached = await rt.getCache<PeerMap>(peerMapCacheKey(service));
  return cached && typeof cached === "object" && !Array.isArray(cached)
    ? cached
    : {};
}

export async function writePeerMap(
  runtime: IAgentRuntime,
  service: ServiceLike,
  map: PeerMap,
): Promise<void> {
  const rt = runtime as unknown as CacheRuntime;
  if (typeof rt.setCache !== "function") return;
  await rt.setCache(peerMapCacheKey(service), map);
}

/**
 * Look up a peer summary by username. Returns null when the feature is
 * disabled or no entry exists. Used by prompt-builders that want to
 * inject context for known peers.
 */
export async function getPeerSummary(
  runtime: IAgentRuntime,
  service: ServiceLike,
  username: string | undefined,
): Promise<PeerSummary | null> {
  if (!service.colonyConfig?.peerMemoryEnabled) return null;
  if (!username) return null;
  const map = await readPeerMap(runtime, service);
  return map[username] ?? null;
}

/**
 * Convenience helper: read the peer-summaries for a set of usernames
 * in one cache round-trip. Filters self / unknowns. Returns the
 * formatted prompt blocks ready to prepend to the existing prompt.
 */
export async function buildPeerContextBlock(
  runtime: IAgentRuntime,
  service: ServiceLike,
  usernames: Array<string | undefined>,
  now: number,
): Promise<string> {
  if (!service.colonyConfig?.peerMemoryEnabled) return "";
  const seen = new Set<string>();
  const candidates = usernames
    .filter((u): u is string => !!u && u !== service.username)
    .filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  if (!candidates.length) return "";
  const map = await readPeerMap(runtime, service);
  const blocks: string[] = [];
  for (const u of candidates) {
    const summary = map[u];
    if (!summary) continue;
    const block = formatForPrompt(summary, now);
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

/**
 * Record a single observation. Two-phase: cheap structured update
 * always runs; LLM distillation runs only every K-th interaction.
 *
 * Non-throwing — peer-memory failures must never crash the engagement
 * or DM path. Distillation failure preserves the existing `styleNotes`.
 */
export async function recordObservation(
  runtime: IAgentRuntime,
  service: ServiceLike,
  peerUsername: string | undefined,
  obs: PeerObservation,
  options: { now?: number; modelType?: string } = {},
): Promise<void> {
  if (!service.colonyConfig?.peerMemoryEnabled) return;
  if (!peerUsername) return;
  if (peerUsername === service.username) return;

  const now = options.now ?? Date.now();
  try {
    const map = await readPeerMap(runtime, service);
    const existing = map[peerUsername] ?? newSummary(peerUsername, now);
    const updated = applyObservation(existing, obs, now);

    const distillEvery = clampDistillEvery(
      service.colonyConfig?.peerMemoryDistillEvery ?? 5,
    );
    if (
      updated.interactionCount > 0 &&
      updated.interactionCount % distillEvery === 0
    ) {
      const distilled = await distillStyleNotes(
        runtime,
        peerUsername,
        updated,
        options.modelType,
      );
      if (distilled !== null) {
        updated.styleNotes = distilled;
        service.incrementStat?.("peerMemoryDistillations");
      }
    }

    map[peerUsername] = updated;
    const ttlMs = service.colonyConfig?.peerMemoryTtlMs ?? 0;
    const maxPeers = service.colonyConfig?.peerMemoryMaxPeers ?? 200;
    const pruned = capByLastSeen(pruneStale(map, ttlMs, now), maxPeers);
    await writePeerMap(runtime, service, pruned);
    service.setPeerMemoryEntries?.(Object.keys(pruned).length);
  } catch (err) {
    logger.warn(`PEER_MEMORY: recordObservation(${peerUsername}) failed: ${String(err)}`);
  }
}

function clampDistillEvery(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

async function distillStyleNotes(
  runtime: IAgentRuntime,
  peerUsername: string,
  summary: PeerSummary,
  modelType: string | undefined,
): Promise<string | null> {
  const topTopics = Object.entries(summary.topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TOPICS_FOR_DISTILL)
    .map(([k]) => k);

  const prompt = [
    "You are maintaining a private memory note about another agent on The Colony social network. The note is for your own reasoning only — it will NOT be shown to the other agent and you must not cite it in public.",
    "",
    `Existing notes about @${peerUsername}:`,
    summary.styleNotes || "(none yet)",
    "",
    "Recent observations:",
    `- topics they care about: ${topTopics.length ? topTopics.join(", ") : "(none yet)"}`,
    `- recent positions (paraphrased): ${
      summary.recentPositions.length ? summary.recentPositions.join(" | ") : "(none yet)"
    }`,
    `- vote history with you: ${summary.voteHistory.up} upvoted, ${summary.voteHistory.down} downvoted`,
    `- interaction count: ${summary.interactionCount}`,
    "",
    "Update the notes. Keep them under 500 characters. Focus on:",
    "- topics and their typical depth (concrete vs abstract)",
    "- their typical posture toward you (agree, disagree, mixed)",
    "- distinctive style markers worth remembering",
    "",
    "Do NOT include verbatim quotes — paraphrase. Do NOT speculate beyond the observations. Output ONLY the updated notes text, no preamble.",
  ].join("\n");

  try {
    const mt = (modelType ?? ModelType.TEXT_SMALL) as never;
    const raw = String(
      await runtime.useModel(mt, {
        prompt,
        temperature: 0.3,
        maxTokens: 200,
      }),
    ).trim();
    if (!raw) return null;
    return raw.slice(0, STYLE_NOTES_MAX_CHARS);
  } catch (err) {
    logger.debug(
      `PEER_MEMORY: distillStyleNotes(${peerUsername}) failed: ${String(err)}`,
    );
    return null;
  }
}
