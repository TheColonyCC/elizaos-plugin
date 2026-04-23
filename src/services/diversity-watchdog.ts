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
 * Two modes (v0.29.0):
 *
 * - **Lexical (default, original v0.19 behaviour).** Jaccard similarity
 *   on word-level n-gram shingles. Cheap, dependency-free, robust to
 *   light rewording. Misses rotated-vocabulary near-duplicates — if the
 *   agent replaces "KV cache pressure" with "context window saturation"
 *   the 3-gram shingle set is almost disjoint even though the concept
 *   is identical.
 *
 * - **Semantic (new).** Cosine similarity between embedding vectors of
 *   the generated outputs. Catches rotated-vocabulary and re-framing
 *   cases that Jaccard misses. Requires a `TEXT_EMBEDDING` model to be
 *   available on the runtime; the caller precomputes the embedding and
 *   passes it to `record(text, embedding)`.
 *
 * Mode is config-selected via `COLONY_DIVERSITY_MODE=lexical|semantic|both`.
 * `both` trips if EITHER check trips — stricter, useful on local agents
 * where the model is prone to both surface and conceptual repetition.
 *
 * Pause condition: the last `windowSize` outputs are all pairwise
 * similar above the active-mode threshold. A 3-of-3 trip at 0.8 lexical
 * (or 0.85 semantic) means the last three generations have all
 * substantially overlapped — a clear repetition signal.
 *
 * The watchdog is stateless about *what* to do on a trip: `record()`
 * returns `true` when the caller should pause. Integration in
 * `colony.service.ts`'s `recordGeneratedOutput()` sets
 * `service.pausedUntilTs` and surfaces a `SEMANTIC_REPETITION` pause
 * reason in status output.
 */

export type DiversityMode = "lexical" | "semantic" | "both";

export interface DiversityWatchdogConfig {
  /**
   * Which similarity backend to run.
   *
   * - `"lexical"` — Jaccard on shingles. No embedding needed.
   * - `"semantic"` — cosine on embeddings. Ignores lexical check entirely.
   * - `"both"` — trip if EITHER check trips. Strictest.
   *
   * Default `"lexical"` for backward compatibility with v0.19 – v0.28.
   */
  mode: DiversityMode;
  /** n-gram size for lexical shingles (word-level). Default 3. */
  ngram: number;
  /** Ring-buffer size. When buffer has <windowSize entries, never trips. */
  windowSize: number;
  /**
   * Lexical Jaccard similarity threshold; ≥ counts as "too similar".
   * Default 0.8. Same as v0.19's `threshold`.
   */
  lexicalThreshold: number;
  /**
   * Semantic cosine similarity threshold; ≥ counts as "too similar".
   * Default 0.85. Slightly tighter than lexical because embeddings
   * normalise out vocabulary variance that Jaccard wouldn't forgive.
   */
  semanticThreshold: number;
}

export const DEFAULT_DIVERSITY_CONFIG: DiversityWatchdogConfig = {
  mode: "lexical",
  ngram: 3,
  windowSize: 3,
  lexicalThreshold: 0.8,
  semanticThreshold: 0.85,
};

/**
 * Ring buffer entry. `embedding` is null when the caller couldn't
 * compute one (embedding model unreachable, mode is lexical, etc.); the
 * semantic check silently skips pairs with a null embedding on either
 * side — it cannot compute a similarity from a missing vector.
 */
interface BufferEntry {
  shingles: Set<string>;
  embedding: number[] | null;
}

export class DiversityWatchdog {
  private buffer: BufferEntry[] = [];
  private readonly config: DiversityWatchdogConfig;

  constructor(
    config: Partial<DiversityWatchdogConfig> & { threshold?: number } = {},
  ) {
    // v0.29.0: `threshold` in v0.19–v0.28 meant the lexical Jaccard
    // threshold. Accept it as an alias for `lexicalThreshold` so
    // existing callers (and the DEFAULT_DIVERSITY_CONFIG shape) continue
    // to work unchanged. Explicit `lexicalThreshold` wins if both are
    // provided.
    this.config = {
      mode: config.mode ?? DEFAULT_DIVERSITY_CONFIG.mode,
      ngram: config.ngram ?? DEFAULT_DIVERSITY_CONFIG.ngram,
      windowSize: config.windowSize ?? DEFAULT_DIVERSITY_CONFIG.windowSize,
      lexicalThreshold:
        config.lexicalThreshold ??
        config.threshold ??
        DEFAULT_DIVERSITY_CONFIG.lexicalThreshold,
      semanticThreshold:
        config.semanticThreshold ?? DEFAULT_DIVERSITY_CONFIG.semanticThreshold,
    };
    if (this.config.ngram < 1) this.config.ngram = 1;
    if (this.config.windowSize < 2) this.config.windowSize = 2;
    if (this.config.lexicalThreshold <= 0 || this.config.lexicalThreshold > 1) {
      this.config.lexicalThreshold = DEFAULT_DIVERSITY_CONFIG.lexicalThreshold;
    }
    if (
      this.config.semanticThreshold <= 0 ||
      this.config.semanticThreshold > 1
    ) {
      this.config.semanticThreshold = DEFAULT_DIVERSITY_CONFIG.semanticThreshold;
    }
  }

  /**
   * Record a generated output in the ring buffer and check whether the
   * window is now saturated with near-duplicates. Returns `true` when
   * the caller should pause the loop.
   *
   * `embedding` is optional. In `lexical` mode it's ignored entirely.
   * In `semantic` or `both` mode, passing `null` means the semantic
   * check silently skips this entry's pairs (cosine can't be computed
   * from a missing vector) — the lexical check still runs in `both`.
   *
   * Empty / whitespace-only inputs are ignored — the ring doesn't
   * advance, and no trip is possible.
   */
  record(text: string, embedding: number[] | null = null): boolean {
    const shingles = this.shingle(text);
    if (shingles.size === 0) return false;
    this.buffer.push({ shingles, embedding });
    while (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
    if (this.buffer.length < this.config.windowSize) return false;
    const mode = this.config.mode;
    if ((mode === "lexical" || mode === "both") && this.allPairwiseLexical()) {
      return true;
    }
    if ((mode === "semantic" || mode === "both") && this.allPairwiseSemantic()) {
      return true;
    }
    return false;
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
   * Active mode. Read-only for diagnostics.
   */
  mode(): DiversityMode {
    return this.config.mode;
  }

  /**
   * Highest pairwise similarity in the current buffer, using the mode's
   * primary metric (lexical Jaccard for `lexical`, cosine for
   * `semantic` and `both` — in `both` we report the semantic peak since
   * it's the more interesting signal for operators tuning the
   * watchdog). Surfaced in diagnostics so operators can see "window is
   * borderline" before a trip happens. Pairs where semantic cosine is
   * inapplicable (missing embeddings) fall back to the lexical score so
   * the peak remains meaningful.
   */
  peakSimilarity(): number {
    if (this.buffer.length < 2) return 0;
    let peak = 0;
    const useSemantic =
      this.config.mode === "semantic" || this.config.mode === "both";
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        const a = this.buffer[i]!;
        const b = this.buffer[j]!;
        let sim: number;
        if (useSemantic && a.embedding && b.embedding) {
          sim = cosineSimilarity(a.embedding, b.embedding);
        } else {
          sim = jaccard(a.shingles, b.shingles);
        }
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
   * True when every pair in the buffer has Jaccard ≥ lexicalThreshold.
   * Stricter than "max pair ≥ threshold" — requires the whole window to
   * be a cluster of near-duplicates, not just two outliers dragging the
   * pair-max up.
   */
  private allPairwiseLexical(): boolean {
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        if (
          jaccard(this.buffer[i]!.shingles, this.buffer[j]!.shingles) <
          this.config.lexicalThreshold
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * True when every pair in the buffer has cosine ≥ semanticThreshold.
   * Pairs where either embedding is missing count as "below threshold"
   * — we don't trip on absent evidence. If every entry is missing an
   * embedding, this returns false (no trip) and the caller relying on
   * `both` mode still gets the lexical check.
   */
  private allPairwiseSemantic(): boolean {
    for (let i = 0; i < this.buffer.length; i++) {
      for (let j = i + 1; j < this.buffer.length; j++) {
        const a = this.buffer[i]!.embedding;
        const b = this.buffer[j]!.embedding;
        if (!a || !b) return false;
        if (cosineSimilarity(a, b) < this.config.semanticThreshold) {
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

/**
 * Cosine similarity between two dense embedding vectors. Returns 0 when
 * either is empty or has a zero norm (degenerate vectors don't have a
 * defined direction). Mismatched lengths also return 0 — a precondition
 * violation that shouldn't silently degrade into a nonsense similarity.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
