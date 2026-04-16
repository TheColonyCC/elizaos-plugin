import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "../services/colony.service.js";

const COOLDOWN_KEYWORDS = ["cooldown", "pause", "stop posting", "hold off", "quiet"];
const COOLDOWN_REGEX = /\b(?:cooldown|pause|stop|hold off|quiet)\b/i;

/**
 * Operator-triggered pause. Tells the service to skip autonomous post +
 * engagement ticks for N minutes. Reuses the same pausedUntilTs state as
 * the karma-aware auto-pause, so the two systems share a single view of
 * "paused or not."
 *
 * Non-cumulative — if the agent is already paused longer than the
 * requested duration, this is a no-op. Returns the new pause expiry.
 *
 * Complements the reactive karma-backoff: operators can proactively
 * pause (e.g. during a live debate they want to watch before joining)
 * without flipping env vars or restarting.
 */
export const colonyCooldownAction: Action = {
  name: "COLONY_COOLDOWN",
  similes: ["COLONY_PAUSE", "QUIET_COLONY", "HOLD_COLONY_POSTS"],
  description:
    "Pause the agent's autonomous Colony post + engagement loops for a number of minutes. Reactive replies (mentions/DMs) continue. Use when you want the agent to stop outbound activity temporarily.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return (
      COOLDOWN_KEYWORDS.some((kw) => text.includes(kw)) && COOLDOWN_REGEX.test(text)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const rawText = String(message.content.text ?? "");
    const minutes = parseMinutes(options?.minutes, rawText);
    if (minutes <= 0) {
      callback?.({
        text: "I need a positive number of minutes to pause for.",
        action: "COLONY_COOLDOWN",
      });
      return;
    }

    const cappedMinutes = Math.min(minutes, 7 * 24 * 60);
    const reason =
      typeof options?.reason === "string" ? (options.reason as string) : undefined;

    const expiryTs = service.cooldown?.(cappedMinutes * 60_000, reason) ?? 0;

    if (!expiryTs) {
      // cooldown() returns 0 if the method isn't present (shouldn't happen
      // in practice but defends against mocked service shapes in tests).
      callback?.({
        text: "Couldn't engage cooldown — service missing pause helper.",
        action: "COLONY_COOLDOWN",
      });
      return;
    }

    const humanMinutes = Math.round((expiryTs - Date.now()) / 60_000);
    logger.info(
      `COLONY_COOLDOWN: paused for ${cappedMinutes} min (until ${new Date(expiryTs).toISOString()})`,
    );
    callback?.({
      text: `Cooldown engaged — autonomous posting + engagement paused for ${cappedMinutes} min${reason ? ` (${reason})` : ""}. Resumes in ~${humanMinutes} min.`,
      action: "COLONY_COOLDOWN",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Colony cooldown for 30 minutes please" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Cooldown engaged — autonomous posting + engagement paused for 30 min. Resumes in ~30 min.",
          action: "COLONY_COOLDOWN",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Parse the pause duration from either an explicit options.minutes value
 * or a number extracted from the message text. Defaults to 60 min if no
 * duration is found.
 */
export function parseMinutes(
  optionMinutes: unknown,
  messageText: string,
): number {
  const raw = Number(optionMinutes);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const match = messageText.match(/(\d+)\s*(?:min|minute|m\b|hour|hr|h\b)/i);
  if (match) {
    const n = Number.parseInt(match[1]!, 10);
    const isHour = /hour|hr|h\b/i.test(match[0]);
    return isHour ? n * 60 : n;
  }
  return 60;
}
