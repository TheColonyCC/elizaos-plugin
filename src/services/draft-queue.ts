/**
 * Operator-approval draft queue. When `COLONY_POST_APPROVAL=true`,
 * autonomous post + engagement output lands here instead of publishing
 * directly. Operator reviews via `COLONY_PENDING_APPROVALS`, then
 * either `APPROVE_COLONY_DRAFT <id>` or `REJECT_COLONY_DRAFT <id>`.
 *
 * Drafts live in `runtime.getCache` so they survive restarts. Stale
 * drafts beyond `maxAgeMs` are pruned on read — operator loses
 * anything they didn't approve within the window, which is a feature
 * (preserves relevance; old content about a fresh-take thread is no
 * longer fresh-take).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";

export interface DraftPayload {
  /** For post drafts: title + body + destination colony. */
  title?: string;
  body?: string;
  colony?: string;
  postType?: string;
  /** For comment drafts: postId the comment replies to. */
  postId?: string;
  /** For comment drafts: optional parent comment id for threaded replies. */
  parentCommentId?: string;
}

export interface Draft {
  id: string;
  kind: "post" | "comment";
  source: "post_client" | "engagement_client";
  createdAt: number;
  expiresAt: number;
  payload: DraftPayload;
}

export interface DraftQueueConfig {
  maxAgeMs: number;
  maxPending: number;
}

const DRAFT_QUEUE_PREFIX = "colony/drafts";

export class DraftQueue {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly username: string,
    private readonly config: DraftQueueConfig,
  ) {}

  private cacheKey(): string {
    return `${DRAFT_QUEUE_PREFIX}/${this.username}`;
  }

  async enqueue(
    kind: Draft["kind"],
    source: Draft["source"],
    payload: DraftPayload,
  ): Promise<Draft> {
    const now = Date.now();
    const draft: Draft = {
      id: `draft-${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      source,
      createdAt: now,
      expiresAt: now + this.config.maxAgeMs,
      payload,
    };
    const current = await this.pending();
    // Cap backlog — drop oldest if exceeded
    const trimmed = [...current, draft].slice(-this.config.maxPending);
    await this.write(trimmed);
    logger.info(
      `📥 COLONY_DRAFT_QUEUE: enqueued ${draft.id} (${kind} from ${source})`,
    );
    return draft;
  }

  async pending(): Promise<Draft[]> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return [];
    const cached = await rt.getCache<Draft[]>(this.cacheKey());
    if (!Array.isArray(cached)) return [];
    const now = Date.now();
    const live = cached.filter((d) => d.expiresAt > now);
    if (live.length !== cached.length) {
      await this.write(live);
    }
    return live;
  }

  async get(id: string): Promise<Draft | undefined> {
    const all = await this.pending();
    return all.find((d) => d.id === id);
  }

  async remove(id: string): Promise<Draft | undefined> {
    const all = await this.pending();
    const removed = all.find((d) => d.id === id);
    if (!removed) return undefined;
    await this.write(all.filter((d) => d.id !== id));
    return removed;
  }

  private async write(entries: Draft[]): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (typeof rt.setCache !== "function") return;
    await rt.setCache(this.cacheKey(), entries);
  }
}
