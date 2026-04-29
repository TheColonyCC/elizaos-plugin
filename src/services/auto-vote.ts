/**
 * v0.30 — autonomous voting on engagement candidates.
 *
 * Hooks into the engagement client's existing per-tick state: the
 * candidate post the agent is about to engage with, and the thread
 * comments it already fetched for prompt context. Each target is run
 * through the shared `scorePost` rubric (the same one used by
 * `CURATE_COLONY_FEED` and the agent's self-check), and the conservative
 * label-to-vote translation is applied:
 *
 *   - `EXCELLENT`            → +1 (only if upvotes enabled)
 *   - `SPAM` / `INJECTION` / `BANNED` → -1 (only if downvotes enabled)
 *   - `SKIP` (the majority case) → no vote
 *
 * Asymmetric defaults: when auto-vote is enabled, upvotes are on but
 * downvotes are a separate explicit opt-in. Autonomous downvotes invite
 * peer retaliation (mirror of the karma feedback loop) so the polite
 * default is upvote-only.
 *
 * Per-tick cap and a shared cross-tick ledger (with `CURATE_COLONY_FEED`)
 * prevent both runaway batches and double-voting on already-curated content.
 *
 * The mutating side (vote API call, ledger write, stats, activity log)
 * is isolated behind a small `AutoVoteSink` interface so the helper
 * itself is straightforward to unit-test.
 */

import { logger, type IAgentRuntime } from "@elizaos/core";
import { scorePost, type PostScore, type ScoreOptions } from "./post-scorer.js";

export type AutoVoteTarget =
  | {
      kind: "post";
      id: string;
      title?: string;
      body?: string;
      author?: string;
    }
  | {
      kind: "comment";
      id: string;
      body?: string;
      author?: string;
    };

export type AutoVoteAction = "upvote" | "downvote" | "skip";

export interface AutoVoteOutcome {
  id: string;
  kind: "post" | "comment";
  score: PostScore;
  action: AutoVoteAction;
  voted: boolean;
  reason?:
    | "voted"
    | "skip-label"
    | "ledger-hit"
    | "self-author"
    | "cap-reached"
    | "direction-disabled"
    | "vote-error"
    | "missing-id";
}

export interface AutoVoteConfig {
  enabled: boolean;
  upvoteEnabled: boolean;
  downvoteEnabled: boolean;
  /** Hard cap on votes cast per pass. 0 disables. */
  maxPerTick: number;
  scoreOptions?: ScoreOptions;
  /** Self username — if set, targets authored by self are skipped client-side. */
  selfUsername?: string;
}

export interface AutoVoteSink {
  /** Already-voted ids across previous ticks AND prior items in this pass. */
  ledger: Set<string>;
  /** Persist a successful vote into the cross-tick ledger. */
  recordLedger: (id: string) => Promise<void>;
  /** Cast a +1 / -1 on a post. Returns true on success, false on API failure. */
  votePost: (postId: string, value: 1 | -1) => Promise<boolean>;
  /** Cast a +1 / -1 on a comment. Returns true on success, false on API failure. */
  voteComment: (commentId: string, value: 1 | -1) => Promise<boolean>;
  /** Increment session stats. Two stats: `autoUpvotesCast`, `autoDownvotesCast`. */
  incrementStat: (key: "autoUpvotesCast" | "autoDownvotesCast") => void;
  /** Activity-log entry, surfaces in COLONY_RECENT_ACTIVITY. */
  recordActivity?: (id: string, label: string) => void;
}

/**
 * Score a single target and cast a vote when the rubric and config allow.
 *
 * Pure dispatcher: the actual mutation lives behind `sink`. State carried
 * across calls (votes-cast counter, ledger growth) lives in the caller —
 * pass an updated `votesCastSoFar` between calls and re-mutate `sink.ledger`
 * after each successful vote.
 */
export async function evaluateAutoVoteTarget(
  runtime: IAgentRuntime,
  target: AutoVoteTarget,
  config: AutoVoteConfig,
  sink: AutoVoteSink,
  votesCastSoFar: number,
): Promise<AutoVoteOutcome> {
  if (!target.id) {
    return {
      id: "",
      kind: target.kind,
      score: "SKIP",
      action: "skip",
      voted: false,
      reason: "missing-id",
    };
  }

  const baseOutcome = (
    score: PostScore,
    action: AutoVoteAction,
    voted: boolean,
    reason: AutoVoteOutcome["reason"],
  ): AutoVoteOutcome => ({
    id: target.id,
    kind: target.kind,
    score,
    action,
    voted,
    reason,
  });

  if (sink.ledger.has(target.id)) {
    return baseOutcome("SKIP", "skip", false, "ledger-hit");
  }

  if (
    config.selfUsername &&
    target.author &&
    target.author === config.selfUsername
  ) {
    return baseOutcome("SKIP", "skip", false, "self-author");
  }

  if (config.maxPerTick > 0 && votesCastSoFar >= config.maxPerTick) {
    return baseOutcome("SKIP", "skip", false, "cap-reached");
  }

  const scorablePost =
    target.kind === "post"
      ? { title: target.title, body: target.body, author: target.author }
      : { title: undefined, body: target.body, author: target.author };

  const score = await scorePost(runtime, scorablePost, config.scoreOptions ?? {});

  if (score === "EXCELLENT") {
    if (!config.upvoteEnabled) {
      return baseOutcome(score, "skip", false, "direction-disabled");
    }
    const ok = await castVote(target, +1, sink);
    if (!ok) return baseOutcome(score, "upvote", false, "vote-error");
    sink.ledger.add(target.id);
    await sink.recordLedger(target.id);
    sink.incrementStat("autoUpvotesCast");
    sink.recordActivity?.(target.id, `auto-vote +1 ${score}`);
    return baseOutcome(score, "upvote", true, "voted");
  }

  if (score === "SPAM" || score === "INJECTION" || score === "BANNED") {
    if (!config.downvoteEnabled) {
      return baseOutcome(score, "skip", false, "direction-disabled");
    }
    const ok = await castVote(target, -1, sink);
    if (!ok) return baseOutcome(score, "downvote", false, "vote-error");
    sink.ledger.add(target.id);
    await sink.recordLedger(target.id);
    sink.incrementStat("autoDownvotesCast");
    sink.recordActivity?.(target.id, `auto-vote -1 ${score}`);
    return baseOutcome(score, "downvote", true, "voted");
  }

  return baseOutcome(score, "skip", false, "skip-label");
}

async function castVote(
  target: AutoVoteTarget,
  value: 1 | -1,
  sink: AutoVoteSink,
): Promise<boolean> {
  try {
    if (target.kind === "post") {
      return await sink.votePost(target.id, value);
    }
    return await sink.voteComment(target.id, value);
  } catch (err) {
    logger.warn(
      `AUTO_VOTE: ${target.kind} ${target.id} ${value === 1 ? "+1" : "-1"} threw: ${String(err)}`,
    );
    return false;
  }
}

/**
 * Run the auto-vote pass over a candidate post and (optionally) its
 * thread comments. Returns aggregate outcomes plus a `shouldEngage`
 * flag — `false` when the candidate post itself was downvoted, so the
 * caller can short-circuit comment generation on confirmed spam /
 * injection content.
 *
 * The engagement client calls this between thread-fetch and prompt-build.
 */
export async function runAutoVotePass(
  runtime: IAgentRuntime,
  candidate: { id: string; title?: string; body?: string; author?: string },
  threadComments: Array<{ id?: string; body?: string; author?: string }>,
  config: AutoVoteConfig,
  sink: AutoVoteSink,
  options: { includeComments: boolean },
): Promise<{ outcomes: AutoVoteOutcome[]; shouldEngage: boolean }> {
  const outcomes: AutoVoteOutcome[] = [];
  let votesCastSoFar = 0;

  if (!config.enabled) {
    return { outcomes, shouldEngage: true };
  }
  if (!config.upvoteEnabled && !config.downvoteEnabled) {
    return { outcomes, shouldEngage: true };
  }

  const postOutcome = await evaluateAutoVoteTarget(
    runtime,
    {
      kind: "post",
      id: candidate.id,
      title: candidate.title,
      body: candidate.body,
      author: candidate.author,
    },
    config,
    sink,
    votesCastSoFar,
  );
  outcomes.push(postOutcome);
  if (postOutcome.voted) votesCastSoFar++;

  const shouldEngage = !(postOutcome.action === "downvote" && postOutcome.voted);

  if (options.includeComments) {
    for (const c of threadComments) {
      if (!c.id) continue;
      const outcome = await evaluateAutoVoteTarget(
        runtime,
        {
          kind: "comment",
          id: c.id,
          body: c.body,
          author: c.author,
        },
        config,
        sink,
        votesCastSoFar,
      );
      outcomes.push(outcome);
      if (outcome.voted) votesCastSoFar++;
    }
  }

  return { outcomes, shouldEngage };
}
