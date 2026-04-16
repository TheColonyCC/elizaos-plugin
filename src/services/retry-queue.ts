/**
 * Tiny per-client retry queue for write operations (createPost,
 * createComment, votePost/voteComment). Backed by `runtime.getCache` so
 * pending retries survive restarts. Transient failures (500s, network
 * blips, sporadic rate-limit 429s that slip past the SDK's own retry
 * logic) don't silently lose content anymore — they land in the queue
 * and replay on the next tick.
 *
 * Scope note: this doesn't replace the SDK's per-request retry config,
 * which handles millisecond-scale transient failures inside a single
 * call. This handles the scale above that: a failure bad enough to
 * abandon the original call but still plausibly recoverable on the next
 * tick (seconds to minutes later).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

export interface RetryEntry {
  id: string;
  kind: "post" | "comment" | "vote_post" | "vote_comment";
  payload: Record<string, unknown>;
  attempts: number;
  firstEnqueuedTs: number;
  nextRetryTs: number;
  lastError?: string;
}

export interface RetryQueueConfig {
  maxAttempts: number;
  maxAgeMs: number;
}

const DEFAULT_BASE_DELAY_MS = 60 * 1000;

export class RetryQueue {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly cacheKey: string,
    private readonly config: RetryQueueConfig,
  ) {}

  async enqueue(
    kind: RetryEntry["kind"],
    payload: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const entry: RetryEntry = {
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      payload,
      attempts: 0,
      firstEnqueuedTs: Date.now(),
      nextRetryTs: Date.now() + DEFAULT_BASE_DELAY_MS,
      lastError: String(error).slice(0, 200),
    };
    const current = await this.read();
    await this.write([...current, entry]);
    logger.debug(`COLONY_RETRY_QUEUE: enqueued ${entry.id} (${kind})`);
  }

  async pending(): Promise<RetryEntry[]> {
    return this.read();
  }

  /**
   * Drain eligible (nextRetryTs <= now) entries from the queue and pass
   * each to the provided executor. Successful entries are removed; failing
   * entries have their attempts + nextRetryTs updated and remain queued
   * until max attempts / max age is exceeded.
   */
  async drain(
    executor: (entry: RetryEntry) => Promise<void>,
  ): Promise<{ succeeded: number; failed: number; dropped: number }> {
    const now = Date.now();
    const all = await this.read();
    if (!all.length) return { succeeded: 0, failed: 0, dropped: 0 };

    let succeeded = 0;
    let failed = 0;
    let dropped = 0;
    const remaining: RetryEntry[] = [];

    for (const entry of all) {
      // Drop entries older than max age or past max attempts
      if (now - entry.firstEnqueuedTs > this.config.maxAgeMs) {
        dropped++;
        logger.warn(
          `COLONY_RETRY_QUEUE: dropping ${entry.id} (${entry.kind}) — exceeded max age`,
        );
        continue;
      }
      if (entry.attempts >= this.config.maxAttempts) {
        dropped++;
        logger.warn(
          `COLONY_RETRY_QUEUE: dropping ${entry.id} (${entry.kind}) — exceeded max attempts (${entry.attempts})`,
        );
        continue;
      }
      // Not yet eligible — keep and move on
      if (entry.nextRetryTs > now) {
        remaining.push(entry);
        continue;
      }
      try {
        await executor(entry);
        succeeded++;
        logger.info(
          `COLONY_RETRY_QUEUE: ${entry.id} (${entry.kind}) succeeded on attempt ${entry.attempts + 1}`,
        );
      } catch (err) {
        failed++;
        const nextAttempts = entry.attempts + 1;
        const backoff = DEFAULT_BASE_DELAY_MS * Math.pow(2, nextAttempts);
        remaining.push({
          ...entry,
          attempts: nextAttempts,
          nextRetryTs: now + backoff,
          lastError: String(err).slice(0, 200),
        });
        logger.debug(
          `COLONY_RETRY_QUEUE: ${entry.id} (${entry.kind}) failed attempt ${nextAttempts}: ${String(err)}`,
        );
      }
    }

    await this.write(remaining);
    return { succeeded, failed, dropped };
  }

  async read(): Promise<RetryEntry[]> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return [];
    const cached = await rt.getCache<RetryEntry[]>(this.cacheKey);
    return Array.isArray(cached) ? cached : [];
  }

  private async write(entries: RetryEntry[]): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    await rt.setCache(this.cacheKey, entries);
  }
}
