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
import { refuseDmOrigin } from "../services/origin.js";

const HISTORY_KEYWORDS = [
  "health history",
  "health trend",
  "healthcheck history",
  "heartbeat history",
  "recent health",
];
const HISTORY_REGEX = /\b(?:history|trend|recent|over time|log)\b/i;

/**
 * v0.26.0: rolling-log companion to `COLONY_HEALTH_REPORT`. Where the
 * health report is a snapshot ("how are you right now?"), this action
 * is a trend ("how have you been?"). Reads the ring that
 * `service.takeHealthSnapshot()` appends to on every health-report
 * invocation and formats the most recent N entries.
 *
 * DM-safe (read-only): another agent can DM `@eliza-gemma` with
 * "health history please" to see how her readiness has moved over
 * recent snapshots. Useful for spotting drift that a single health
 * check would miss.
 */
export const colonyHealthHistoryAction: Action = {
  name: "COLONY_HEALTH_HISTORY",
  similes: [
    "COLONY_HEALTH_TREND",
    "HEALTH_HISTORY_COLONY",
    "HEALTH_LOG_COLONY",
  ],
  description:
    "Report a short history of the agent's runtime health — last N health snapshots with timestamp, LLM success rate, pause state, retry-queue size, digest count. Companion to COLONY_HEALTH_REPORT (snapshot). Use when someone asks 'how have you been?' or 'any recent issues?'.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "COLONY_HEALTH_HISTORY")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    // Must mention "health" (so it doesn't collide with other actions
    // that use "history" for different things), AND one of the
    // trend-keywords.
    if (!text.includes("health")) return false;
    const keywordHit = HISTORY_KEYWORDS.some((kw) => text.includes(kw));
    const regexHit = HISTORY_REGEX.test(text);
    return keywordHit || regexHit;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const rawLimit = Number(options?.limit ?? 10);
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 10),
    );

    const snaps = service.healthSnapshots ?? [];
    if (snaps.length === 0) {
      const text = "No health snapshots yet. Ring populates when COLONY_HEALTH_REPORT is queried.";
      callback?.({ text, action: "COLONY_HEALTH_HISTORY" });
      return;
    }

    const recent = snaps.slice(-limit);
    const handle = service.username ? `@${service.username}` : "(unknown)";
    const lines: string[] = [
      `Health history for ${handle} (last ${recent.length} of ${snaps.length} snapshots):`,
    ];
    for (const s of recent) {
      const ts = new Date(s.ts).toISOString().replace("T", " ").slice(0, 16);
      const llm =
        s.llmSuccessPct === null
          ? "LLM idle"
          : `LLM ${s.llmSuccessPct}% (${s.llmCalls} calls)`;
      const pauseBit = s.paused
        ? `⏸️ ${s.pauseReason ?? "paused"}`
        : "active";
      const queueBit =
        s.retryQueueSize === null
          ? ""
          : `, retry ${s.retryQueueSize}`;
      const digestBit = s.digestsEmitted > 0 ? `, ${s.digestsEmitted} digests` : "";
      lines.push(`- ${ts}  ${llm}, ${pauseBit}${queueBit}${digestBit}`);
    }

    const text = lines.join("\n");
    logger.info(
      `COLONY_HEALTH_HISTORY: reported ${recent.length} snapshots for ${handle}`,
    );
    callback?.({ text, action: "COLONY_HEALTH_HISTORY" });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Show colony health history" } },
      {
        name: "{{agent}}",
        content: {
          text: "Health history for @eliza-gemma (last 3 of 12 snapshots):\n- 2026-04-19 10:05  LLM 100% (14 calls), active\n- 2026-04-19 10:32  LLM 92% (26 calls), active, retry 0\n- 2026-04-19 11:01  LLM 100% (18 calls), active",
          action: "COLONY_HEALTH_HISTORY",
        },
      },
    ],
  ] as ActionExample[][],
};
