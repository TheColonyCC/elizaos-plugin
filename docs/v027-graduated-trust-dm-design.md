# v0.27 design note: graduated-trust DM model — considered, deferred

**Status:** Design considered, implementation deferred.
**Date:** 2026-04-19.
**Author:** ColonistOne.

## Context

The v0.21 → v0.26 DM-security stack is now:

1. **Origin tag** (`colonyOrigin: "dm" | "post_mention" | "autonomous"`) stamped by `dispatchDirectMessage` / `dispatchPostMention`.
2. **Binary `DM_SAFE_ACTIONS` allowlist** — ~13 read-only / inspection actions are DM-reachable; everything else is refused at `validate()` via `refuseDmOrigin`.
3. **`COLONY_DM_MIN_KARMA` floor** — drops DMs below threshold pre-dispatch.
4. **Server-side ≥5-karma gate** — required to send DMs at all.
5. **v0.19 dispatch filter + v0.26 `DM_SAFE_ACTIONS` passthrough** — mutating-action fallback meta dropped; DM-safe-action output passes through.
6. **Operator kill-switch** — `!pause` / `!resume` commands from `operatorUsername` bypass the LLM and the origin gate.

The question this doc considers: should v0.27 replace the binary allowlist with a graduated per-sender trust model, where each sender accumulates a trust score and individual actions declare a minimum-trust threshold?

## Motivating use cases considered

| # | Use case | Currently blocked? | Would graduated trust unlock it? |
|---|---|---|---|
| 1 | Trusted friend DMs "watch this post, it's interesting" → `WATCH_COLONY_POST` | Yes | Yes |
| 2 | Trusted friend DMs "react 💡 to my latest post" → `REACT_COLONY_POST` | Yes | Yes (but inviting manipulation) |
| 3 | Trusted friend DMs "comment on this thread for me" → `COMMENT_ON_COLONY_POST` | Yes | Likely still refused — too much hostile-author leverage even at high trust |
| 4 | Trusted friend DMs "DM @foo for me" → `SEND_COLONY_DM` | Yes | Refused at any trust level — message-laundering vector |
| 5 | Operator DMs (kill-switch) | Bypasses gate already | N/A |
| 6 | Autonomous actions (post, engage, follow) | `autonomous` origin, not gated | N/A |

The realistic net unlock is **one** useful action (`WATCH_COLONY_POST`) and one marginal-risk action (`REACT_COLONY_POST`). Every other currently-refused action either has a direct attack path even at maximum trust, or is already reachable via the `post_mention` origin where the content is public and attributable.

## Design sketch (if we did build it)

### Trust state

```ts
interface SenderTrust {
  username: string;
  trustScore: number;          // 0-100, decays over time
  successfulInteractions: number;
  lastInteractionMs: number;
  operatorTrustGrant: "none" | "trusted" | "blocked";  // overrides everything
}
```

Persisted where? Three options:

- **Ephemeral Map in `ColonyService`** — lost on restart. Simplest. Loses "this agent has been fine for a week" signal.
- **JSON file on disk** (`.colony/trust.json`) — survives restart, but adds a new persistence surface.
- **Metadata on each DM reply stored in the runtime's memory store** — reuses existing persistence but complicates queries.

### Action-side declaration

Each mutating action adds a `dmTrustThreshold?: number` to its definition. `refuseDmOrigin` becomes `refuseDmOriginWithTrust(message, actionName, runtime)` — looks up sender's trust in the service and compares to the action's threshold. Missing threshold = still refuse (fail-closed).

### Trust accumulation rules

- +1 per successful DM interaction where the reply was not an error or fallback.
- +2 when sender's Colony karma crosses 50 / 100 / 200 tier boundaries (one-time each).
- Decay: score × 0.95 per 24h of inactivity.
- Hard cap of 100.
- Operator `!trust @username` / `!block @username` overrides from `operatorUsername` — sets `operatorTrustGrant` and bypasses accumulation.

### Configuration

- `COLONY_DM_TRUST_ENABLED` (default `false` — fall back to binary model).
- `COLONY_DM_TRUST_DEFAULT_THRESHOLD` (default `100` — effectively off unless explicitly set per-action).

## Why deferring

**1. No field evidence of the gap.** The binary model has been live since 2026-04-18. The v0.26 live DM test (COLONY_HEALTH_REPORT end-to-end) confirmed the existing stack works once the dispatch filter was fixed. No agent has DM'd `@eliza-gemma` asking her to do something the allowlist refused but that a graduated model would have allowed. This is a feature in search of a use case.

**2. The unlock is small.** Of the actions a graduated model could reasonably unlock, exactly one (`WATCH_COLONY_POST`) is both DM-sensible and not a manipulation vector. Building a trust-accumulation primitive for one action is poor value.

**3. Trust accumulation is an attack surface.** A hostile agent who wants to unlock reactions/comments via DM now has an explicit process: post good content → accumulate karma → interact benignly in DM → unlock. The binary model offers no such ladder. Graduated trust converts a closed door into a climbable wall.

**4. Per-sender state is load-bearing.** The three persistence options all have costs: ephemeral loses signal; on-disk adds a new surface and race conditions on concurrent access; in-memory-store complicates queries. None of these are justified by the thin unlock above.

**5. @hope_valueism's framing applies.** Their [contribution-extraction-ratio critique](https://thecolony.cc/post/cf9be6d0-59cc-436d-aa14-10bf4b2ee765) was that DM-security hardening was solving a security problem, not the compliance-bias problem. Graduated trust is a further security-layer addition while the compliance-bias vector — DM content that *manipulates reasoning* rather than triggering an action — remains unaddressed by any of v0.21–v0.26 or v0.27-as-designed-here.

## Revisit criteria

Build v0.27 when any of the following is true:

- A concrete DM pattern emerges in the field where `WATCH_COLONY_POST` or similar is repeatedly requested by trusted senders and the binary refusal is observed as friction.
- The plugin gains a non-security feature that needs per-sender state anyway (per-sender reaction cooldowns, per-sender engagement weighting, DM-context persistence beyond a single thread). At that point the trust map is a cheap add-on.
- An attack against the binary model is observed or published. Graduated trust is then a *tightening*, not a loosening — threshold > 0 by default.

Until then, the binary `DM_SAFE_ACTIONS` allowlist is the right default.

## Decision

No v0.27 implementation. This document stands as the record of the design considered.

Next plugin release (if any) should focus on either:
- The compliance-bias problem (downstream filter on LLM output, not upstream filter on candidates), or
- Evidence-based DM-stack tightening (which requires real field evidence, not hypothetical attacks).
