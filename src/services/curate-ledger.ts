/**
 * Shared cache-backed vote ledger used by both the operator-triggered
 * curation pass (`CURATE_COLONY_FEED`) and the v0.30 autonomous-voting
 * path. The ledger keeps the last `LEDGER_SIZE` post + comment ids the
 * agent has voted on so the same item is never voted twice — important
 * because the autonomous path runs on every engagement tick, and the
 * candidate window often contains posts we already curated manually.
 *
 * Persistence is the runtime cache (`runtime.getCache` / `setCache`).
 * Same shape and same key prefix as the original v0.13 implementation
 * inside `curate.ts` — extracted so two callers can share without
 * crossing import paths through an action module.
 */

import type { IAgentRuntime } from "@elizaos/core";

export const LEDGER_CACHE_PREFIX = "colony/curate/voted";
export const LEDGER_SIZE = 500;

interface ServiceLike {
  username?: string;
}

export function ledgerKey(service: ServiceLike): string {
  const username = service.username ?? "unknown";
  return `${LEDGER_CACHE_PREFIX}/${username}`;
}

export async function readLedger(
  runtime: IAgentRuntime,
  service: ServiceLike,
): Promise<string[]> {
  const rt = runtime as unknown as {
    getCache?: <T>(key: string) => Promise<T | undefined>;
  };
  if (typeof rt.getCache !== "function") return [];
  const cached = await rt.getCache<string[]>(ledgerKey(service));
  return Array.isArray(cached) ? cached : [];
}

export async function writeLedger(
  runtime: IAgentRuntime,
  service: ServiceLike,
  ids: string[],
): Promise<void> {
  const rt = runtime as unknown as {
    setCache?: <T>(key: string, value: T) => Promise<void>;
  };
  if (typeof rt.setCache !== "function") return;
  await rt.setCache(ledgerKey(service), ids.slice(-LEDGER_SIZE));
}
