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
import { checkOllamaReadiness, validateCharacter } from "../utils/readiness.js";

const DIAG_KEYWORDS = ["diagnostics", "diagnose", "debug"];
const DIAG_REGEX = /\b(?:diagnostics|diagnose|debug)\b/i;

type CacheReader = <T>(key: string) => Promise<T | undefined>;

/**
 * Operator-facing diagnostics dump — the "what's going on under the hood"
 * answer. Redacts the API key and dumps config, readiness checks, character
 * validation summary, and cache ring sizes for each internal ledger.
 *
 * Intended for troubleshooting — not for normal operation. Output is chatty.
 */
export const colonyDiagnosticsAction: Action = {
  name: "COLONY_DIAGNOSTICS",
  similes: ["COLONY_DEBUG", "DIAGNOSE_COLONY", "COLONY_HEALTHCHECK"],
  description:
    "Run a diagnostics pass on the Colony plugin and report config, readiness checks, character validation, and internal cache state. Use for troubleshooting.",
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
      DIAG_KEYWORDS.some((kw) => text.includes(kw)) && DIAG_REGEX.test(text)
    );
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
    lines.push(`=== Colony plugin diagnostics ===`);
    lines.push(`Handle: @${service.username ?? "(unknown)"}`);
    lines.push(`Karma: ${service.currentKarma ?? "?"}, trust: ${service.currentTrust ?? "?"}`);

    lines.push("");
    lines.push("Config:");
    const cfg = service.colonyConfig;
    lines.push(`- API key: ${redactKey(cfg.apiKey)}`);
    lines.push(`- default colony: ${cfg.defaultColony}, feed limit: ${cfg.feedLimit}`);
    lines.push(`- polling: ${cfg.pollEnabled ? `enabled (${Math.round(cfg.pollIntervalMs / 1000)}s)` : "disabled"}`);
    lines.push(`- posting: ${cfg.postEnabled ? `enabled (${Math.round(cfg.postIntervalMinMs / 1000)}-${Math.round(cfg.postIntervalMaxMs / 1000)}s, c/${cfg.postColony}, daily cap ${cfg.postDailyLimit})` : "disabled"}`);
    lines.push(`- engagement: ${cfg.engageEnabled ? `enabled (${Math.round(cfg.engageIntervalMinMs / 1000)}-${Math.round(cfg.engageIntervalMaxMs / 1000)}s, ${cfg.engageColonies.join(",")})` : "disabled"}`);
    lines.push(`- self-check: ${cfg.selfCheckEnabled ? "on" : "off"}, dry-run: ${cfg.dryRun ? "on" : "off"}`);
    lines.push(`- karma backoff: drop ≥ ${cfg.karmaBackoffDrop} over ${Math.round(cfg.karmaBackoffWindowMs / 3600_000)}h → pause ${Math.round(cfg.karmaBackoffCooldownMs / 60_000)}min`);

    lines.push("");
    lines.push("Readiness:");
    const ollamaOk = await checkOllamaReadiness(runtime);
    lines.push(`- Ollama: ${ollamaOk ? "ok" : "warnings logged (see above)"}`);
    const characterWarnings = validateCharacter(runtime);
    lines.push(`- character: ${characterWarnings === 0 ? "ok" : `${characterWarnings} field(s) missing`}`);

    lines.push("");
    lines.push("Cache ring sizes:");
    const username = service.username ?? "unknown";
    const cacheKeys = [
      { label: "recent posts (dedup)", key: `colony/post-client/recent/${username}` },
      { label: "post daily ledger", key: `colony/post-client/daily/${username}` },
      { label: "engagement seen", key: `colony/engagement-client/seen/${username}` },
      { label: "curate voted", key: `colony/curate/voted/${username}` },
    ];
    const getCache = (runtime as unknown as { getCache?: CacheReader }).getCache;
    for (const { label, key } of cacheKeys) {
      if (typeof getCache !== "function") {
        lines.push(`- ${label}: runtime has no cache, skipping`);
        continue;
      }
      try {
        const cached = await getCache<unknown[]>(key);
        const size = Array.isArray(cached) ? cached.length : 0;
        lines.push(`- ${label}: ${size} entries`);
      } catch (err) {
        lines.push(`- ${label}: error (${String(err)})`);
      }
    }

    lines.push("");
    lines.push(
      `Session stats: posts=${service.stats.postsCreated}, comments=${service.stats.commentsCreated}, votes=${service.stats.votesCast}, self-check-rejections=${service.stats.selfCheckRejections}`,
    );
    // v0.16.0: LLM health surfaces here too for troubleshooting — if Ollama
    // is thrashing and most ticks fail, this is the first place to look.
    const { llmCallsSuccess = 0, llmCallsFailed = 0 } = service.stats;
    lines.push(
      `LLM provider calls: ${llmCallsSuccess} succeeded, ${llmCallsFailed} failed`,
    );
    // v0.24.0: surface notification-router + adaptive-poll signals that
    // operators were previously having to dig out of the status action.
    // Diagnostics should be the superset.
    const digestsEmitted = service.stats.notificationDigestsEmitted ?? 0;
    lines.push(
      `Notification digests emitted: ${digestsEmitted}`,
    );
    if (cfg.notificationPolicy && cfg.notificationPolicy.size > 0) {
      const formatted = Array.from(cfg.notificationPolicy.entries())
        .map(([t, lvl]) => `${t}:${lvl}`)
        .join(", ");
      lines.push(`Notification policy: ${formatted}`);
    } else {
      lines.push(`Notification policy: (default — legacy ignore set only)`);
    }
    if (cfg.adaptivePollEnabled) {
      const mul = service.computeLlmHealthMultiplier?.() ?? 1.0;
      const baseSec = Math.round(cfg.pollIntervalMs / 1000);
      const effectiveSec = Math.round((cfg.pollIntervalMs * mul) / 1000);
      lines.push(
        `Adaptive poll: ${mul.toFixed(2)}× (effective ${effectiveSec}s vs base ${baseSec}s, max ${cfg.adaptivePollMaxMultiplier.toFixed(1)}×, warn @${Math.round(cfg.adaptivePollWarnThreshold * 100)}%)`,
      );
    } else {
      lines.push(`Adaptive poll: disabled`);
    }
    if (cfg.dmMinKarma > 0) {
      lines.push(`DM karma gate: ≥ ${cfg.dmMinKarma} required`);
    }
    if (service.pausedUntilTs > Date.now()) {
      lines.push(
        `⏸️  Paused for karma backoff — ${Math.max(
          1,
          Math.round((service.pausedUntilTs - Date.now()) / 60_000),
        )} min remaining`,
      );
    }

    logger.info(`COLONY_DIAGNOSTICS: produced ${lines.length}-line report`);
    callback?.({ text: lines.join("\n"), action: "COLONY_DIAGNOSTICS" });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Run Colony diagnostics — something seems off." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "=== Colony plugin diagnostics ===\nHandle: @eliza-gemma\n…",
          action: "COLONY_DIAGNOSTICS",
        },
      },
    ],
  ] as ActionExample[][],
};

export function redactKey(key: string | undefined): string {
  if (!key) return "(missing)";
  if (key.length <= 8) return "col_****";
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}
