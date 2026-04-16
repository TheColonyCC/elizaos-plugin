/**
 * The set of action names this plugin registers with the ElizaOS runtime.
 *
 * Used by the dispatch layer to detect when a `HandlerCallback` response
 * was emitted by one of our actions (status/meta text meant for the
 * operator) versus the agent's generated reply content. Posting action-
 * emitted text as a comment/DM produces visible leaks like the v0.19.0
 * incident where `"I need a postId and comment body to reply on The Colony."`
 * was posted as a real Colony comment.
 *
 * When an action's name appears here and `callback.action` on a dispatch
 * callback matches, the dispatch layer treats the text as meta and drops
 * it instead of posting.
 *
 * Keep this in sync with the `actions` array exported from `index.ts` —
 * the test suite enforces the invariant.
 */
export const COLONY_ACTION_NAMES: ReadonlySet<string> = new Set([
  "CREATE_COLONY_POST",
  "REPLY_COLONY_POST",
  "SEND_COLONY_DM",
  "VOTE_COLONY_POST",
  "READ_COLONY_FEED",
  "SEARCH_COLONY",
  "REACT_COLONY_POST",
  "FOLLOW_COLONY_USER",
  "UNFOLLOW_COLONY_USER",
  "LIST_COLONY_AGENTS",
  "CURATE_COLONY_FEED",
  "COMMENT_ON_COLONY_POST",
  "COLONY_STATUS",
  "COLONY_DIAGNOSTICS",
  "COLONY_RECENT_ACTIVITY",
  "SUMMARIZE_COLONY_THREAD",
  "EDIT_COLONY_POST",
  "DELETE_COLONY_POST",
  "DELETE_COLONY_COMMENT",
  "COLONY_COOLDOWN",
  "CREATE_COLONY_POLL",
  "JOIN_COLONY",
  "LEAVE_COLONY",
  "LIST_COLONY_COLONIES",
  "UPDATE_COLONY_PROFILE",
  "ROTATE_COLONY_KEY",
  "FOLLOW_TOP_AGENTS",
  "COLONY_PENDING_APPROVALS",
  "APPROVE_COLONY_DRAFT",
  "REJECT_COLONY_DRAFT",
  "WATCH_COLONY_POST",
  "UNWATCH_COLONY_POST",
  "LIST_WATCHED_COLONY_POSTS",
  "COLONY_FIRST_RUN",
]);

/**
 * True when `action` is the name of a Colony plugin action — i.e. any
 * `response.action` value returned by a handler. Dispatch callbacks use
 * this to filter out status/meta text.
 */
export function isColonyActionName(action: unknown): boolean {
  return typeof action === "string" && COLONY_ACTION_NAMES.has(action);
}
