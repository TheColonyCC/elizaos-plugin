/**
 * Boot-time readiness checks that produce non-fatal warnings when the
 * agent is misconfigured in a way that will silently degrade output
 * quality. All checks here log to the Eliza logger and return a summary;
 * none of them throw. Failure of any of these should still let the agent
 * boot — the goal is to surface problems early, not to block startup.
 */

import { logger, type IAgentRuntime } from "@elizaos/core";

/**
 * Probe the Ollama `/api/tags` endpoint and warn if none of the
 * `OLLAMA_*_MODEL` env vars resolve to a locally-installed model. This
 * catches the "agent boots, first inference fails with 404" class of
 * misconfiguration.
 *
 * Skipped (returns immediately) if `OLLAMA_API_ENDPOINT` isn't set — the
 * agent is presumably using a cloud provider instead.
 *
 * @returns `true` if the probe ran AND every configured model was found,
 *          `false` if a warning was logged. Always resolves; never throws.
 */
export async function checkOllamaReadiness(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const endpoint = getSetting(runtime, "OLLAMA_API_ENDPOINT");
  if (!endpoint) return true;

  const tagsUrl = endpoint.replace(/\/+$/, "") + "/tags";
  let body: unknown;
  try {
    const response = await fetch(tagsUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      logger.warn(
        `COLONY_READINESS: Ollama /api/tags returned ${response.status}. Agent will fail at first inference.`,
      );
      return false;
    }
    body = await response.json();
  } catch (err) {
    logger.warn(
      `COLONY_READINESS: could not reach Ollama at ${tagsUrl}: ${String(err)}. Agent will fail at first inference.`,
    );
    return false;
  }

  const models = (body as { models?: Array<{ name?: string }> })?.models ?? [];
  const installedNames = new Set(
    models.map((m) => m.name ?? "").filter(Boolean),
  );

  const configuredKeys = [
    "OLLAMA_SMALL_MODEL",
    "OLLAMA_MEDIUM_MODEL",
    "OLLAMA_LARGE_MODEL",
    "OLLAMA_EMBEDDING_MODEL",
  ] as const;

  const missing: Array<{ key: string; value: string }> = [];
  for (const key of configuredKeys) {
    const value = getSetting(runtime, key);
    if (!value) continue;
    if (!installedNames.has(value)) {
      missing.push({ key, value });
    }
  }

  if (missing.length) {
    const list = missing
      .map((m) => `${m.key}=${m.value}`)
      .join(", ");
    logger.warn(
      `COLONY_READINESS: the following configured Ollama models are NOT installed locally: ${list}. ` +
        `Run 'ollama pull <model>' for each, or adjust your .env.`,
    );
    return false;
  }

  logger.info(
    `COLONY_READINESS: Ollama reachable at ${endpoint}, all configured models available`,
  );
  return true;
}

/**
 * v0.16.0: fast per-tick reachability probe for the Ollama endpoint. Used
 * by the autonomy loops as a pre-tick gate — if the provider is down, the
 * tick is skipped entirely instead of burning a failed `useModel` call
 * that would emit a model-error string the rest of the pipeline has to
 * catch downstream. Cheaper than the full readiness check: only probes
 * `/api/tags` with a 1-second timeout; doesn't enumerate model names.
 *
 * Results are cached per-runtime with a short TTL (default 30s) so every
 * tick doesn't hammer the probe. A single failure flips the cache to
 * `unreachable` for the TTL; the next probe after the TTL refreshes.
 *
 * Returns `true` when the probe is skipped (no `OLLAMA_API_ENDPOINT`) —
 * the caller treats that as "provider is fine, proceed." This means
 * cloud providers (which set no OLLAMA_* env) always pass the gate;
 * the probe is Ollama-specific by design.
 */
type OllamaReachabilityCache = { until: number; reachable: boolean };
const OLLAMA_REACHABILITY_CACHE = new WeakMap<object, OllamaReachabilityCache>();
const OLLAMA_PROBE_TTL_MS = 30_000;
const OLLAMA_PROBE_TIMEOUT_MS = 1_000;

export async function isOllamaReachable(
  runtime: IAgentRuntime,
  ttlMs: number = OLLAMA_PROBE_TTL_MS,
): Promise<boolean> {
  const endpoint = getSetting(runtime, "OLLAMA_API_ENDPOINT");
  if (!endpoint) return true;

  const cached = OLLAMA_REACHABILITY_CACHE.get(runtime as unknown as object);
  const now = Date.now();
  if (cached && cached.until > now) return cached.reachable;

  const tagsUrl = endpoint.replace(/\/+$/, "") + "/tags";
  let reachable = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(tagsUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      reachable = response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    reachable = false;
  }

  OLLAMA_REACHABILITY_CACHE.set(runtime as unknown as object, {
    until: now + ttlMs,
    reachable,
  });
  return reachable;
}

/**
 * Validate the runtime character's structure for fields that materially
 * affect post quality. Warnings only — missing fields don't block boot.
 *
 * @returns number of warnings emitted.
 */
export function validateCharacter(runtime: IAgentRuntime): number {
  const character = runtime.character as unknown as {
    name?: string;
    bio?: string | string[];
    topics?: string[];
    messageExamples?: unknown[];
    style?: { all?: string[]; post?: string[]; chat?: string[] };
  } | null;

  if (!character) {
    logger.warn(
      "COLONY_READINESS: runtime.character is missing. The agent will post with a generic default voice.",
    );
    return 1;
  }

  let warnings = 0;
  const missingFields: string[] = [];

  if (!character.name) {
    missingFields.push("name");
  }
  const bioText = Array.isArray(character.bio)
    ? character.bio.filter(Boolean).join(" ")
    : (character.bio ?? "");
  if (!bioText.trim()) {
    missingFields.push("bio");
  }
  if (!character.topics?.length) {
    missingFields.push("topics");
  }
  if (!character.messageExamples?.length) {
    missingFields.push("messageExamples");
  }
  if (
    !character.style?.all?.length &&
    !character.style?.post?.length &&
    !character.style?.chat?.length
  ) {
    missingFields.push("style");
  }

  if (missingFields.length) {
    logger.warn(
      `COLONY_READINESS: character is missing fields that affect post quality: ${missingFields.join(", ")}. ` +
        `Autonomous posts will be more generic than they need to be. See the example character in the plugin's docs/example-character.ts.`,
    );
    warnings = missingFields.length;
  }

  return warnings;
}

function getSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const rt = runtime as unknown as {
    getSetting?: (k: string) => unknown;
  };
  if (typeof rt.getSetting !== "function") return undefined;
  const value = rt.getSetting(key);
  if (value === undefined || value === null) return undefined;
  return String(value);
}
