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
import { isOllamaReachable } from "../utils/readiness.js";

const HEALTH_KEYWORDS = [
  "health",
  "are you ok",
  "are you okay",
  "are you healthy",
  "diagnostic",
  "heartbeat",
  "check yourself",
];
const HEALTH_REGEX = /\b(?:health|ok|okay|healthy|diagnostic|heartbeat)\b/i;

/**
 * v0.25.0: single-action health readout composing every readiness /
 * state signal the plugin tracks. Differs from `COLONY_STATUS` (which
 * is operator-reporting — session counters, daily-cap, karma trend)
 * and `COLONY_DIAGNOSTICS` (which is a full-fat plugin dump — config,
 * cache sizes, stats). Health is the question "is this agent currently
 * able to do its job", answered in ≤10 lines.
 *
 * DM-safe (read-only): the action appears in `DM_SAFE_ACTIONS` so
 * another agent can DM `@eliza-gemma` asking "are you healthy?" and
 * get a useful answer back. That's the main use case.
 */
export const colonyHealthReportAction: Action = {
  name: "COLONY_HEALTH_REPORT",
  similes: [
    "COLONY_HEALTHCHECK",
    "ARE_YOU_HEALTHY",
    "HEARTBEAT_COLONY",
    "COLONY_HEALTH",
  ],
  description:
    "Report the agent's current runtime health: Ollama reachability, LLM-call success rate, karma-backoff pause state, retry-queue depth, notification-router activity, diversity-watchdog score. One compact readout that composes signals from the subsystems the plugin tracks. Use when asked 'are you healthy?' / 'is the agent ok?' / 'what's your current status?'.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    // v0.25.0: DM-safe action — read-only, so NOT refused from DM
    // origin. The `refuseDmOrigin` helper respects the allowlist.
    if (refuseDmOrigin(message, "COLONY_HEALTH_REPORT")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    const keywordHit = HEALTH_KEYWORDS.some((kw) => text.includes(kw));
    const regexHit = HEALTH_REGEX.test(text);
    return keywordHit && regexHit;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const lines: string[] = [];
    const handle = service.username ? `@${service.username}` : "(unknown)";
    lines.push(`Health report for ${handle}:`);

    // Ollama reachability (cloud-model configs bypass this).
    let ollamaLine = "Ollama: not configured (cloud provider)";
    try {
      const reachable = await isOllamaReachable(runtime);
      ollamaLine = reachable
        ? "Ollama: reachable"
        : "Ollama: UNREACHABLE (local inference will fail)";
    } catch {
      // readiness helper throws only on config-misuse; treat as unconfigured.
    }
    lines.push(`- ${ollamaLine}`);

    // LLM-call success rate over the sliding window.
    const history = service.llmCallHistory ?? [];
    const now = Date.now();
    const windowMs = service.colonyConfig?.llmFailureWindowMs ?? 10 * 60_000;
    const recent = history.filter((e) => e.ts > now - windowMs);
    if (recent.length === 0) {
      lines.push(`- LLM calls: (no activity in last ${Math.round(windowMs / 60_000)}min)`);
    } else {
      const failed = recent.filter((e) => e.outcome === "failure").length;
      const succeeded = recent.length - failed;
      const rate = failed / recent.length;
      const indicator =
        rate === 0 ? "✅" : rate < 0.25 ? "" : rate < 0.5 ? "⚠️ " : "🔴 ";
      lines.push(
        `- ${indicator}LLM calls (last ${Math.round(windowMs / 60_000)}min): ${succeeded} succeeded, ${failed} failed (${Math.round(rate * 100)}%)`,
      );
    }

    // Pause state — karma backoff, LLM-health, operator cooldown, diversity.
    if (service.isPausedForBackoff?.()) {
      const remainingMin = Math.max(
        1,
        Math.round((service.pausedUntilTs - now) / 60_000),
      );
      const reason = service.pauseReason ? ` — reason: ${service.pauseReason}` : "";
      lines.push(
        `- ⏸️ Paused for ${remainingMin}min${reason}`,
      );
    } else {
      lines.push(`- Pause state: active (not paused)`);
    }

    // Retry queue depth. Reads through the post-client if it's running.
    const postClient = service.postClient as unknown as {
      getRetryQueue?: () => ReadonlyArray<{ kind?: string }>;
    } | null;
    if (postClient && typeof postClient.getRetryQueue === "function") {
      try {
        const queue = postClient.getRetryQueue() ?? [];
        if (queue.length === 0) {
          lines.push(`- Retry queue: empty`);
        } else {
          const kinds = new Map<string, number>();
          for (const item of queue) {
            const k = item.kind ?? "unknown";
            kinds.set(k, (kinds.get(k) ?? 0) + 1);
          }
          const breakdown = Array.from(kinds.entries())
            .map(([k, c]) => `${c}×${k}`)
            .join(", ");
          lines.push(`- Retry queue: ${queue.length} pending (${breakdown})`);
        }
      } catch {
        // defensive — shouldn't happen, but health-report must never throw
      }
    }

    // Notification-router digest count (v0.22).
    const digests = service.stats?.notificationDigestsEmitted ?? 0;
    if (digests > 0) {
      lines.push(`- Notification digests this session: ${digests}`);
    }

    // v0.28.0: rate-limit pressure. Unlike STATUS this line always renders —
    // "0 rate limits in 10m" is a positive health signal operators want to see.
    const rlRecent = service.rateLimitHitsInWindow?.(10 * 60_000) ?? 0;
    const rlTotal = service.stats?.rateLimitHits ?? 0;
    const rlWarning = rlRecent >= 3 ? " ⚠️" : "";
    lines.push(
      `- Rate-limit hits: ${rlRecent} in last 10m (${rlTotal} this session)${rlWarning}`,
    );

    // Adaptive-poll multiplier (v0.23) — only worth showing when enabled.
    if (service.colonyConfig?.adaptivePollEnabled) {
      const mul = service.computeLlmHealthMultiplier?.() ?? 1.0;
      const suffix = mul > 1.5 ? " (slowing polls under LLM stress)" : "";
      lines.push(`- Adaptive poll multiplier: ${mul.toFixed(2)}×${suffix}`);
    }

    // Diversity watchdog peak similarity (v0.19; semantic in v0.29).
    const dw = service.diversityWatchdog as unknown as {
      peakSimilarity?: () => number;
    } | null;
    if (dw && typeof dw.peakSimilarity === "function") {
      try {
        const peak = dw.peakSimilarity();
        if (typeof peak === "number") {
          const mode = service.colonyConfig?.diversityMode ?? "lexical";
          const threshold =
            mode === "semantic" || mode === "both"
              ? service.colonyConfig?.diversitySemanticThreshold ?? 0.85
              : service.colonyConfig?.diversityThreshold ?? 0.8;
          const warning = peak >= threshold * 0.9 ? " ⚠️" : "";
          const modeTag = mode === "lexical" ? "" : ` [${mode}]`;
          lines.push(
            `- Output diversity${modeTag}: peak pairwise ${peak.toFixed(2)} (threshold ${threshold.toFixed(2)})${warning}`,
          );
        }
      } catch {
        // defensive
      }
    }

    // v0.26.0: snapshot into the health-history ring. Lazy — grows
    // whenever an operator queries health, which is the time they care
    // about the trend anyway.
    service.takeHealthSnapshot?.();

    const text = lines.join("\n");
    logger.info(`COLONY_HEALTH_REPORT: produced ${lines.length}-line report for ${handle}`);
    callback?.({ text, action: "COLONY_HEALTH_REPORT" });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Are you healthy?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Health report for @eliza-gemma:\n- Ollama: reachable\n- LLM calls (last 10min): 14 succeeded, 0 failed (0%)\n- Pause state: active (not paused)\n- Retry queue: empty",
          action: "COLONY_HEALTH_REPORT",
        },
      },
    ],
  ] as ActionExample[][],
};
