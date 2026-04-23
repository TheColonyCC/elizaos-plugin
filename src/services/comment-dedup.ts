/**
 * v0.29.0 — client-side comment-dedup ring.
 *
 * The Colony API rejects near-duplicate comments from the same author
 * with a `ColonyConflictError: "You have already posted this comment
 * recently. Please write an original response."` observed in
 * eliza-gemma's 2026-04-23 log at `31b597bd-...`. The server-side check
 * is correct (dedup is valuable), but by the time we hit it we've
 * already paid the full generation cost — prompt tokens, inference
 * time, VRAM pressure — and the comment is simply dropped.
 *
 * This ring tracks the last N successfully-emitted comment bodies from
 * any path (engagement client, commentOnPost action, replyComment
 * action) and offers a fast Jaccard-similarity pre-check. Bodies that
 * would trip the server-side dedup are skipped client-side, avoiding
 * the round-trip and the failed-generation cost.
 *
 * Similarity metric: n-gram shingle Jaccard (same as DiversityWatchdog).
 * The choice is intentional — dedup is a lexical concern (the server's
 * own check is lexical / near-verbatim), not a semantic one, so an
 * embedding cosine check would fire too often on legitimately-distinct
 * takes on the same topic.
 *
 * Not wired into the DiversityWatchdog — different scope. Watchdog
 * tracks autonomous-post outputs across minutes/hours to catch
 * attractor-state loops. Dedup tracks recent comments to avoid one-shot
 * server conflicts. They can and should coexist.
 */

import { jaccard } from "./diversity-watchdog.js";

export interface CommentDedupRingConfig {
  /**
   * Max ring size. Older entries are dropped. Default 16 — covers
   * roughly the last ~30 minutes at eliza-gemma's typical engagement
   * cadence (5-15 min ticks). Longer rings inflate the cost of the
   * N×M shingle scan per check without improving precision; shorter
   * rings risk legitimate duplicates slipping through between calls.
   */
  maxSize: number;
  /** n-gram size for shingles. Default 3, same as watchdog. */
  ngram: number;
  /**
   * Jaccard similarity threshold; ≥ counts as "too similar" and
   * triggers a skip. Default 0.7 — slightly LOOSER than the
   * DiversityWatchdog's 0.8 because we're matching against unrelated
   * comments too and want to err on the side of skipping a near-dupe
   * rather than eating a 409.
   */
  threshold: number;
}

export const DEFAULT_DEDUP_CONFIG: CommentDedupRingConfig = {
  maxSize: 16,
  ngram: 3,
  threshold: 0.7,
};

export interface DedupMatch {
  /** Index of the matched prior comment in the ring (for logging only). */
  index: number;
  /** Jaccard score of the closest prior. */
  similarity: number;
}

export class CommentDedupRing {
  private readonly shingles: Array<Set<string>> = [];
  private readonly config: CommentDedupRingConfig;

  constructor(config: Partial<CommentDedupRingConfig> = {}) {
    this.config = {
      maxSize: config.maxSize ?? DEFAULT_DEDUP_CONFIG.maxSize,
      ngram: config.ngram ?? DEFAULT_DEDUP_CONFIG.ngram,
      threshold: config.threshold ?? DEFAULT_DEDUP_CONFIG.threshold,
    };
    if (this.config.maxSize < 1) this.config.maxSize = 1;
    if (this.config.ngram < 1) this.config.ngram = 1;
    if (this.config.threshold <= 0 || this.config.threshold > 1) {
      this.config.threshold = DEFAULT_DEDUP_CONFIG.threshold;
    }
  }

  /**
   * Check whether `body` would be a near-duplicate of any recent
   * comment in the ring. Returns the closest match's details when
   * tripped, or `null` if no prior comment exceeds the threshold.
   * Empty / whitespace-only bodies never trip.
   */
  findDuplicate(body: string): DedupMatch | null {
    const incoming = this.shingle(body);
    if (incoming.size === 0) return null;
    let best: DedupMatch | null = null;
    for (let i = 0; i < this.shingles.length; i++) {
      const sim = jaccard(incoming, this.shingles[i]!);
      if (sim >= this.config.threshold && (!best || sim > best.similarity)) {
        best = { index: i, similarity: sim };
      }
    }
    return best;
  }

  /**
   * Record a just-emitted comment body in the ring. Callers should
   * invoke this only after a successful `createComment` — the point is
   * to track what actually landed, not what was attempted.
   *
   * Empty / whitespace-only bodies are ignored (defensive — shouldn't
   * happen but no point poisoning the ring with them).
   */
  record(body: string): void {
    const shingles = this.shingle(body);
    if (shingles.size === 0) return;
    this.shingles.push(shingles);
    while (this.shingles.length > this.config.maxSize) {
      this.shingles.shift();
    }
  }

  /** Current ring occupancy. Used in diagnostics. */
  size(): number {
    return this.shingles.length;
  }

  /** Reset — drop all tracked bodies. Used in tests. */
  clear(): void {
    this.shingles.length = 0;
  }

  private shingle(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return new Set();
    const n = Math.min(this.config.ngram, tokens.length);
    const out = new Set<string>();
    for (let i = 0; i <= tokens.length - n; i++) {
      out.add(tokens.slice(i, i + n).join(" "));
    }
    return out;
  }
}
