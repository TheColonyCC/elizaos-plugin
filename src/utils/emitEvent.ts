/**
 * Structured event emitter for the plugin's key lifecycle moments.
 *
 * When `COLONY_LOG_FORMAT=json`, emits a single JSON line per event that's
 * easy to ingest into ELK/Loki/Datadog. Otherwise falls through to a
 * human-readable log line via the Eliza logger.
 *
 * Scope note: this only wraps the plugin's own important events (posts
 * created, scorer rejections, curation runs, backoff triggers, etc.), NOT
 * every `logger.info` call in the plugin. Startup/debug/diagnostic lines
 * stay text-only. The goal is "machine-parseable agent behavior stream,"
 * not "JSON everything."
 */

import { logger, type IAgentRuntime } from "@elizaos/core";

export type PluginEventLevel = "info" | "warn" | "error";

export interface PluginEvent {
  level: PluginEventLevel;
  event: string;
  /** Arbitrary structured payload merged into the JSON output. */
  [key: string]: unknown;
}

/**
 * Emit a structured event. When logFormat is "json", output is a single
 * JSON line with `{ts, level, event, ...payload}`. Otherwise a readable
 * single-line summary is written via the Eliza logger.
 */
export function emitEvent(
  logFormat: "text" | "json",
  entry: PluginEvent,
  textFallback: string,
): void {
  const { level, event, ...payload } = entry;
  if (logFormat === "json") {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...payload,
    });
    // Emit through Eliza's logger so routing (stdout, file, etc.) is
    // consistent. A downstream JSON-aware sink can match lines that
    // parse as JSON and treat them as structured events.
    logger[level](line);
    return;
  }
  logger[level](textFallback);
}

/**
 * Read the configured log format from the runtime's settings. Safe to call
 * from code that doesn't have the resolved ColonyConfig in scope — falls
 * back to "text" if the setting isn't present.
 */
export function resolveLogFormat(runtime: IAgentRuntime | null | undefined): "text" | "json" {
  if (!runtime) return "text";
  const rt = runtime as unknown as { getSetting?: (k: string) => unknown };
  if (typeof rt.getSetting !== "function") return "text";
  const raw = rt.getSetting("COLONY_LOG_FORMAT");
  if (typeof raw !== "string") return "text";
  return raw.toLowerCase().trim() === "json" ? "json" : "text";
}
