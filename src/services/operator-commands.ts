/**
 * Operator kill-switch: DM-triggered control commands that bypass the
 * LLM entirely.
 *
 * Motivation: when the agent is misbehaving (stuck in a rut, burning
 * karma, posting glitches), the operator needs an emergency-stop
 * reachable without SSH'ing to the host. A plain DM to the bot from
 * a pre-configured owner username, prefixed with `!`, acts on plugin
 * state directly.
 *
 * The commands are parsed and executed by {@link handleOperatorCommand}
 * before the DM is dispatched to `messageService.handleMessage`. If
 * the message isn't a command (or isn't from the configured operator
 * username), the function returns `null` and the caller proceeds with
 * normal dispatch.
 *
 * **Security.** Authentication is by-username. An attacker who can
 * register an account matching `COLONY_OPERATOR_USERNAME` can trigger
 * these commands — so the config should be a username the operator
 * controls (their personal account), and the username should be hard
 * to impersonate. For stronger auth, run the agent behind a webhook
 * gateway and authenticate the webhook signature instead.
 */

import type { ColonyService } from "./colony.service.js";

export interface OperatorCommandResult {
  /** Human-readable confirmation to DM back to the operator. */
  reply: string;
  /** Machine-readable command name (for logging / test assertions). */
  command: string;
}

/**
 * Parse and execute an operator command. Returns a result object if the
 * message was a recognised command from the configured operator, or
 * `null` if the caller should fall through to normal DM dispatch.
 *
 * Unknown commands from the operator DO return a result (with an
 * error-style `reply`) rather than falling through — otherwise a typo'd
 * command would hit the LLM and produce a confusing "I'm not sure what
 * you mean" response that the operator then has to debug.
 */
export async function handleOperatorCommand(
  service: ColonyService,
  senderUsername: string,
  body: string,
): Promise<OperatorCommandResult | null> {
  const operator = service.colonyConfig.operatorUsername;
  if (!operator) return null;
  if (senderUsername.toLowerCase() !== operator) return null;

  const prefix = service.colonyConfig.operatorPrefix;
  const trimmed = body.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const tokens = trimmed.slice(prefix.length).trim().split(/\s+/);
  const command = (tokens.shift() ?? "").toLowerCase();
  const args = tokens;

  switch (command) {
    case "pause":
      return handlePause(service, args);
    case "resume":
      return handleResume(service);
    case "status":
      return handleStatus(service);
    case "drop-last-comment":
    case "drop-last":
      return await handleDropLastComment(service);
    case "archive":
      return await handleConversationState(service, args, "archive");
    case "unarchive":
      return await handleConversationState(service, args, "unarchive");
    case "mute":
      return await handleConversationState(service, args, "mute");
    case "unmute":
      return await handleConversationState(service, args, "unmute");
    case "help":
      return handleHelp(service);
    default:
      return {
        command: "unknown",
        reply: `Unknown operator command: \`${prefix}${command}\`. Try \`${prefix}help\`.`,
      };
  }
}

function handlePause(
  service: ColonyService,
  args: string[],
): OperatorCommandResult {
  const durationStr = args[0];
  const durationMs = durationStr ? parseDurationMs(durationStr) : null;
  if (!durationMs) {
    return {
      command: "pause",
      reply:
        "Pause duration required (e.g. `!pause 30m`, `!pause 2h`, `!pause 45`). " +
        "Bare numbers are minutes. Accepted suffixes: s, m, h.",
    };
  }
  const minutes = Math.round(durationMs / 60_000);
  service.pauseForReason(durationMs, "operator_killswitch", `!pause ${durationStr}`);
  return {
    command: "pause",
    reply: `Paused autonomy for ${minutes}min. Post + engagement loops skip ticks until ${new Date(
      service.pausedUntilTs,
    ).toISOString()}. Use \`!resume\` to clear early.`,
  };
}

function handleResume(service: ColonyService): OperatorCommandResult {
  const wasPaused = service.pausedUntilTs > Date.now();
  service.pausedUntilTs = 0;
  service.pauseReason = null;
  return {
    command: "resume",
    reply: wasPaused
      ? "Pause cleared. Autonomy loops resume on their next tick."
      : "No active pause — autonomy loops were already running.",
  };
}

function handleStatus(service: ColonyService): OperatorCommandResult {
  const now = Date.now();
  const paused = service.pausedUntilTs > now;
  const reason = service.pauseReason ?? "none";
  const remainingMin = paused
    ? Math.ceil((service.pausedUntilTs - now) / 60_000)
    : 0;
  const karma = service.currentKarma ?? "?";
  const llmOk = service.stats.llmCallsSuccess;
  const llmFail = service.stats.llmCallsFailed;
  return {
    command: "status",
    reply: [
      `Status (as of ${new Date(now).toISOString()})`,
      `  paused: ${paused ? `yes (${remainingMin}min, reason=${reason})` : "no"}`,
      `  karma: ${karma}`,
      `  llm: ${llmOk} ok / ${llmFail} failed`,
      `  posts: ${service.stats.postsCreated} total (${service.stats.postsCreatedAutonomous} autonomous)`,
      `  comments: ${service.stats.commentsCreated} total (${service.stats.commentsCreatedAutonomous} autonomous)`,
      `  self-check rejections: ${service.stats.selfCheckRejections}`,
    ].join("\n"),
  };
}

/**
 * Delete the most recent comment the agent created. Useful as a
 * one-shot recovery when the agent has posted something visibly wrong
 * and the operator wants it gone without opening a browser.
 *
 * Looks up the latest `comment_created` entry in the activity log — if
 * the log has been pruned (50-entry ring) or the comment was created
 * before this session, the command fails gracefully. No partial state
 * or retry queue interaction.
 */
async function handleDropLastComment(
  service: ColonyService,
): Promise<OperatorCommandResult> {
  const recent = service.activityLog
    .filter((e) => e.type === "comment_created" && typeof e.target === "string")
    .slice(-1)[0];
  if (!recent || typeof recent.target !== "string") {
    return {
      command: "drop-last-comment",
      reply:
        "No recent comment found in the activity log. The log only covers this session's last 50 entries — earlier comments must be deleted via the web UI.",
    };
  }
  const commentId = recent.target;
  try {
    // v0.20.0: SDK-native deleteComment (requires @thecolony/sdk ^0.2.0).
    // Replaced the v0.19.0 as-unknown-as shim now that the SDK exposes
    // the method on the public surface.
    await service.client.deleteComment(commentId);
    return {
      command: "drop-last-comment",
      reply: `Deleted comment ${commentId.slice(0, 8)}… (${recent.detail ?? "no detail"})`,
    };
  } catch (err) {
    return {
      command: "drop-last-comment",
      reply: `Failed to delete comment ${commentId.slice(0, 8)}…: ${(err as Error).message}`,
    };
  }
}

function handleHelp(service: ColonyService): OperatorCommandResult {
  const p = service.colonyConfig.operatorPrefix;
  return {
    command: "help",
    reply: [
      `Operator commands (bypass the LLM, only from @${service.colonyConfig.operatorUsername}):`,
      `  ${p}pause <dur>      — pause autonomy (30m, 2h, 60s, or bare minutes)`,
      `  ${p}resume            — clear any active pause`,
      `  ${p}status            — compact status snapshot`,
      `  ${p}drop-last         — delete the most recent comment this session posted`,
      `  ${p}archive @user     — archive the DM thread with @user`,
      `  ${p}unarchive @user   — restore a previously archived thread`,
      `  ${p}mute @user        — mute DM notifications from @user`,
      `  ${p}unmute @user      — restore DM notifications from @user`,
      `  ${p}help              — this message`,
    ].join("\n"),
  };
}

type ConversationStateCommand = "archive" | "unarchive" | "mute" | "unmute";

/**
 * v0.20.0: DM-thread state operator commands.
 *
 * Each wraps the corresponding SDK method on `service.client`:
 *   - archive:   client.archiveConversation(username)
 *   - unarchive: client.unarchiveConversation(username)
 *   - mute:      client.muteConversation(username)
 *   - unmute:    client.unmuteConversation(username)
 *
 * Accepts `@alice`, `alice`, or `username: alice` as arg[0]. The @ is
 * stripped for the SDK call. No-op if the username is empty — returns
 * a usage message instead of hitting the API with a blank path.
 */
async function handleConversationState(
  service: ColonyService,
  args: string[],
  action: ConversationStateCommand,
): Promise<OperatorCommandResult> {
  const raw = args[0];
  const username = raw?.replace(/^@/, "").trim();
  if (!username) {
    const p = service.colonyConfig.operatorPrefix;
    return {
      command: action,
      reply: `Username required (e.g. \`${p}${action} @alice\` or \`${p}${action} alice\`).`,
    };
  }
  const client = service.client as unknown as {
    archiveConversation: (u: string) => Promise<unknown>;
    unarchiveConversation: (u: string) => Promise<unknown>;
    muteConversation: (u: string) => Promise<unknown>;
    unmuteConversation: (u: string) => Promise<unknown>;
  };
  try {
    if (action === "archive") await client.archiveConversation(username);
    else if (action === "unarchive") await client.unarchiveConversation(username);
    else if (action === "mute") await client.muteConversation(username);
    else await client.unmuteConversation(username);
    const verb = { archive: "Archived", unarchive: "Unarchived", mute: "Muted", unmute: "Unmuted" }[action];
    return {
      command: action,
      reply: `${verb} DM thread with @${username}.`,
    };
  } catch (err) {
    return {
      command: action,
      reply: `Failed to ${action} @${username}: ${(err as Error).message}`,
    };
  }
}

/**
 * Parse a duration string. Accepts:
 *   - `"60"` → 60 minutes (bare number defaults to minutes)
 *   - `"30m"` → 30 minutes
 *   - `"2h"` → 2 hours
 *   - `"45s"` → 45 seconds
 * Returns null on anything unparseable or non-positive.
 */
export function parseDurationMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([smh]?)$/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (value <= 0) return null;
  // match[2] captures the unit, always defined (possibly empty) via the `?` group.
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000;
  return value * multiplier;
}
