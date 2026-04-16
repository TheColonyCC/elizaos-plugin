import { describe, expect, it } from "vitest";
import {
  DiversityWatchdog,
  jaccard,
} from "../services/diversity-watchdog.js";

describe("jaccard", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(1);
  });

  it("computes correct fraction for partial overlap", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} size 2; union = {a,b,c,d} size 4 → 0.5
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });
});

describe("DiversityWatchdog", () => {
  it("applies defaults for unspecified config", () => {
    const w = new DiversityWatchdog();
    // Two nearly-identical inputs shouldn't trip (window of 3 not full).
    // Repeating identical bodies to guarantee all-pairs above default
    // threshold 0.8.
    expect(w.record("the quick brown fox jumps over the lazy dog")).toBe(false);
    expect(w.record("the quick brown fox jumps over the lazy dog")).toBe(false);
    expect(w.record("the quick brown fox jumps over the lazy dog")).toBe(true);
  });

  it("clamps invalid config values", () => {
    const w = new DiversityWatchdog({
      ngram: 0,
      windowSize: 1,
      threshold: 1.5,
    });
    // windowSize should have been raised to 2. Two identical entries trip.
    expect(w.record("hello world again here")).toBe(false);
    expect(w.record("hello world again here")).toBe(true);
  });

  it("normalises threshold 0 to default", () => {
    const w = new DiversityWatchdog({ threshold: 0 });
    // With default 0.8 threshold, three identical inputs trip.
    w.record("the cat sat on the mat");
    w.record("the cat sat on the mat");
    expect(w.record("the cat sat on the mat")).toBe(true);
  });

  it("normalises out-of-range threshold to default", () => {
    const w = new DiversityWatchdog({ threshold: -0.2 });
    w.record("the cat sat on the mat");
    w.record("the cat sat on the mat");
    expect(w.record("the cat sat on the mat")).toBe(true);
  });

  it("does not trip when inputs are diverse enough", () => {
    const w = new DiversityWatchdog({ windowSize: 3, threshold: 0.8 });
    expect(w.record("discussing rate limits in distributed systems")).toBe(
      false,
    );
    expect(w.record("a reflection on karma systems and trust tiers")).toBe(
      false,
    );
    expect(w.record("thoughts on consensus protocols and byzantine faults")).toBe(
      false,
    );
  });

  it("trips when three outputs cluster above threshold", () => {
    const w = new DiversityWatchdog({ windowSize: 3, threshold: 0.5 });
    w.record("the quick brown fox jumps over the lazy dog");
    w.record("the quick brown fox jumps over the lazy cat");
    expect(
      w.record("the quick brown fox jumps over the lazy bat"),
    ).toBe(true);
  });

  it("requires ALL pairs (not just max) to be similar", () => {
    const w = new DiversityWatchdog({ windowSize: 3, threshold: 0.7 });
    // Two highly-similar + one outlier → NOT a trip
    w.record("the cat sat on the mat today");
    w.record("the cat sat on the mat yesterday");
    expect(
      w.record("orthogonal thought about distributed cache invalidation"),
    ).toBe(false);
  });

  it("ignores empty inputs", () => {
    const w = new DiversityWatchdog();
    expect(w.record("")).toBe(false);
    expect(w.record("   ")).toBe(false);
    expect(w.size()).toBe(0);
  });

  it("reset clears the buffer", () => {
    const w = new DiversityWatchdog({ windowSize: 2, threshold: 0.5 });
    w.record("the quick brown fox");
    w.record("the quick brown fox");
    expect(w.size()).toBe(2);
    w.reset();
    expect(w.size()).toBe(0);
    // Reset should let the loop resume without immediate re-trip
    expect(w.record("the quick brown fox")).toBe(false);
  });

  it("peakSimilarity returns 0 before 2 entries", () => {
    const w = new DiversityWatchdog();
    expect(w.peakSimilarity()).toBe(0);
    w.record("hello there general kenobi");
    expect(w.peakSimilarity()).toBe(0);
  });

  it("peakSimilarity returns max pairwise after ≥2 entries", () => {
    const w = new DiversityWatchdog({ ngram: 2, windowSize: 3 });
    w.record("the quick brown fox");
    w.record("the quick brown fox");
    w.record("totally different story here");
    // Two identical entries are pair 1.0; an outlier pushes the minimum
    // pairwise to 0 but peak stays at 1.
    expect(w.peakSimilarity()).toBe(1);
  });

  it("rolls the window to drop oldest entries", () => {
    const w = new DiversityWatchdog({ windowSize: 2, threshold: 0.8 });
    w.record("entirely unique first entry here");
    w.record("cluster about rate limiting in distributed systems");
    w.record("cluster about rate limiting in distributed systems clone");
    // First has been rolled off; the remaining 2 are similar → trip
    expect(w.size()).toBe(2);
  });

  it("short texts produce a single shingle rather than empty set", () => {
    const w = new DiversityWatchdog({ ngram: 5, windowSize: 2, threshold: 0.5 });
    // Input has fewer tokens than the ngram size
    const tripped = w.record("short");
    expect(tripped).toBe(false);
    // Second identical short input fills the window and trips
    expect(w.record("short")).toBe(true);
  });
});
