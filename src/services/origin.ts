/**
 * v0.21.0 — Message-origin tagging for DM-injection hardening.
 *
 * Prior to v0.21.0 every dispatched memory rode through
 * `runtime.messageService.handleMessage` carrying `content.source = "colony"`
 * with no distinction between "this message arrived via a Colony DM" and
 * "this message arrived via a post-mention notification". Action validators
 * could only check against the text of the message, which left every
 * mutating action (create post, delete post, vote, update profile, send DM,
 * etc.) reachable from a maliciously-crafted DM that happened to contain
 * the right keyword + a fabricated structural token.
 *
 * This module threads a `colonyOrigin` tag through the dispatch layer into
 * the `Memory` object and exposes a `refuseDmOrigin(message, actionName)`
 * guard that action validators call as their first check. Actions in
 * `DM_SAFE_ACTIONS` are read-only / informational and permitted from DM
 * origin; everything else is refused regardless of what the DM text says.
 *
 * The tag is not a replacement for the content-based validators the
 * actions already carry — it's a layer in front of them. Defence in depth.
 */

import type { Memory } from "@elizaos/core";

/**
 * The three paths through which a message arrives at action-routing:
 *
 * - `"dm"` — an inbound DM dispatched by `dispatchDirectMessage`. Treated
 *   as potentially hostile: the sender is any agent on Colony who has
 *   ≥ 5 karma (the server-side DM-send gate).
 * - `"post_mention"` — a post-mention / comment-reply notification
 *   dispatched by `dispatchPostMention`. Public-facing and tied to a post
 *   context; much harder to use as a covert injection channel because the
 *   payload is visible in the thread.
 * - `"autonomous"` — reserved for memories the plugin itself constructs
 *   (e.g. post-client / engagement-client internal flows). Not currently
 *   tagged by v0.21.0 dispatchers but reserved for future use so consumers
 *   can discriminate operator-triggered actions from agent self-initiated
 *   ones.
 */
export type ColonyOrigin = "dm" | "post_mention" | "autonomous";

/**
 * Shape of the tag we stamp onto `Memory.content`. Kept narrow so
 * `as unknown as …` casts in dispatchers and readers stay honest.
 */
export interface ColonyOriginTag {
  colonyOrigin?: ColonyOrigin;
}

/**
 * Read the origin tag off a memory. Returns `undefined` when the tag is
 * missing or carries an unrecognised value — callers must treat missing as
 * "unknown origin" and decide policy accordingly. The action validators in
 * v0.21.0 fail-closed: missing origin + mutating action = refuse.
 */
export function getColonyOrigin(message: Memory): ColonyOrigin | undefined {
  const content = message?.content as unknown as ColonyOriginTag | undefined;
  const raw = content?.colonyOrigin;
  if (raw === "dm" || raw === "post_mention" || raw === "autonomous") {
    return raw;
  }
  return undefined;
}

/**
 * True iff the memory was tagged as originating from a DM. Used by
 * mutating actions' validators as their first gate.
 */
export function isDmOrigin(message: Memory): boolean {
  return getColonyOrigin(message) === "dm";
}

/**
 * Canonical action names that are safe to fire from DM origin. These are
 * read-only / informational actions — they fetch, search, summarise, or
 * report plugin state but do not mutate remote state on Colony.
 *
 * Keep this set in sync with `src/index.ts` — the test suite asserts that
 * every member refers to a real registered action, and every registered
 * action not listed here must be refuse-DM-origin in its validate() or
 * have a documented reason to be exempt.
 */
export const DM_SAFE_ACTIONS: ReadonlySet<string> = new Set([
  // Read-only Colony queries
  "READ_COLONY_FEED",
  "SEARCH_COLONY",
  "LIST_COLONY_AGENTS",
  "LIST_COLONY_COLONIES",
  "CURATE_COLONY_FEED",
  "SUMMARIZE_COLONY_THREAD",
  // Plugin-state inspection
  "COLONY_STATUS",
  "COLONY_DIAGNOSTICS",
  "COLONY_HEALTH_REPORT",
  "COLONY_RECENT_ACTIVITY",
  "LIST_WATCHED_COLONY_POSTS",
  "COLONY_PENDING_APPROVALS",
]);

/**
 * DM-origin guard for action validators. Returns `true` when the action
 * should refuse the message on origin grounds alone. Call as the first
 * line in `validate()`:
 *
 * ```ts
 * if (refuseDmOrigin(message, "CREATE_COLONY_POST")) return false;
 * ```
 *
 * Semantics:
 *   - Message tagged as DM + action NOT in `DM_SAFE_ACTIONS` → refuse.
 *   - Message tagged as post_mention or autonomous → never refused here.
 *   - Message with missing/unknown origin → never refused here. Legacy
 *     code paths and direct action invocations (operator typing in a
 *     local shell) don't carry the tag and must continue to work. Actions
 *     that need strict operator-only semantics should layer additional
 *     guards; this helper only closes the DM-injection vector.
 */
export function refuseDmOrigin(message: Memory, actionName: string): boolean {
  return isDmOrigin(message) && !DM_SAFE_ACTIONS.has(actionName);
}
