/**
 * Content-diversity watchdog — a defence against the "stuck in a rut"
 * failure mode where the post loop emits variants of the same thought
 * over and over.
 *
 * v0.16.0's `validateGeneratedOutput` catches provider-error strings and
 * chat-template leakage — both per-output failure modes. This watchdog
 * catches a *sequence* failure: outputs that individually look fine but
 * together are semantically redundant. The classic case is a locally-run
 * small model falling into an attractor state (temperature too low, RNG
 * seeded, cache hot) and re-emitting near-identical posts.
 *
 * Similarity metric: Jaccard similarity on word-level n-gram shingles.
 * Cheap, dependency-free, robust to light rewording. Two outputs that
 * share ≥`threshold` of their shingles are considered "the same thought"
 * for watchdog purposes.
 *
 * Pause condition: the last `windowSize` outputs are all pairwise
 * similar above `threshold` to at least one other in the window. A
 * 3-of-3 trip at 0.8 Jaccard means the last three generations have all
 * substantially overlapped — that's a clear repetition signal.
 *
 * The watchdog is stateless about *what* to do on a trip: `record()`
 * returns `true` when the caller should pause. Integration in
 * `post-client.ts` sets `service.pausedUntilTs` and surfaces a
 * `SEMANTIC_REPETITION` pause reason in status output.
 */

export interface DiversityWatchdogConfig {
  /** n-gram size for shingles (word-level). Default 3. */
  ngram: number;
  /** Ring-buffer size. When buffer has <windowSize entries, never trips. */
  windowSize: number;
  /** Jaccard similarity threshold; ≥ counts as "too similar". Default 0.8. */
  threshold: number;
}

export const DEFAULT_DIVERSITY_CONFIG: DiversityWatchdogConfig = {
  ngram: 3,
  windowSize: 3,
  threshold: 0.8,
};

export class DiversityWatchdog {
  private buffer: Array<Set<string>> = [];
  private readonly config: DiversityWatchdogConfig;

  constructor(config: Partial<DiversityWatchdogConfig> = {}) {
    this.config = {
      ngram: config.ngram ?? DEFAULT_DIVERSITY_CONFIG.ngram,
      windowSize: config.windowSize ?? DEFAULT_DIVERSITY_CONFIG.windowSize,
      threshold: config.threshold ?? DEFAULT_DIVERSITY_CONFIG.threshold,
    };
    if (this.config.ngram < 1) this.config.ngram = 1;
    if (this.config.windowSize < 2) this.config.windowSize = 2;
    if (this.config.threshold <= 0 || this.config.threshold > 1) {
      this.config.threshold = DEFAULT_DIVERSITY_CONFIG.threshold;
    }
  }

  /**
   * Record a generated output in the ring buffer and check whether the
   * window is now saturated with near-duplicates. Returns `true` when
   * the caller should pause the loop.
   *
   * Empty / whitespace-only inputs are ignored — the ring doesn't
   * advance, and no trip is possible.
   */
  record(text: string): boolean {
    const shingles = this.shingle(text);
    if (shingles.size === 0) return false;
    this.buffer.push(shingles);
    while (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
    if (this.buffer.length < this.config.windowSize) return false;
    return this.allPairwiseSimilar();
  }

  /**
   * Reset the ring buffer. Call after handling a trip so the loop can
   * resume without a stale watchdog state (otherwise the pause would
   * re-trigger the next tick on the same three outputs).
   */
  reset(): void {
    this.buffer = [];
  }

  /**
   * Current ring-buffer occupancy. Useful for status output.
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Highest pairwise Jaccard similarity in the current buffer. Surfaced
   * in diagnostics so operators can see "window is borderline" before a
   * trip happens.
   */
  peakSimilarity(): number {
    if (this.buffer.length < 2) return 0;
    let peak = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        const sim = jaccard(this.buffer[i]!, this.buffer[j]!);
        if (sim > peak) peak = sim;
      }
    }
    return peak;
  }

  private shingle(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return new Set();
    // Clamp n so we never slice off the end of a short token list.
    const n = Math.min(this.config.ngram, tokens.length);
    const out = new Set<string>();
    for (let i = 0; i <= tokens.length - n; i++) {
      out.add(tokens.slice(i, i + n).join(" "));
    }
    return out;
  }

  /**
   * True when every pair in the buffer has Jaccard ≥ threshold. This is
   * stricter than "max pair ≥ threshold" — requires the whole window to
   * be a cluster of near-duplicates, not just two outliers dragging
   * the pair-max up.
   */
  private allPairwiseSimilar(): boolean {
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        if (jaccard(this.buffer[i]!, this.buffer[j]!) < this.config.threshold) {
          return false;
        }
      }
    }
    return true;
  }
}

/**
 * Jaccard similarity between two shingle sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both are empty (no information about similarity).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) {
    if (b.has(s)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}
