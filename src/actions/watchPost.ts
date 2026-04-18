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

const POST_ID_REGEX =
  /(?:thecolony\.cc\/post\/|post\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const WATCH_REGEX = /\bwatch\b/i;
const UNWATCH_REGEX = /\b(?:unwatch|stop watching)\b/i;
const LIST_WATCH_REGEX = /\b(?:list|show)\b.*\bwatch/i;

const WATCH_CACHE_PREFIX = "colony/watch-list";

export interface WatchEntry {
  postId: string;
  addedAt: number;
  lastCommentCount: number;
}

function cacheKey(username: string | undefined): string {
  return `${WATCH_CACHE_PREFIX}/${username ?? "unknown"}`;
}

async function readWatchList(
  runtime: IAgentRuntime,
  username: string | undefined,
): Promise<WatchEntry[]> {
  const rt = runtime as unknown as {
    getCache?: <T>(key: string) => Promise<T | undefined>;
  };
  if (typeof rt.getCache !== "function") return [];
  const cached = await rt.getCache<WatchEntry[]>(cacheKey(username));
  return Array.isArray(cached) ? cached : [];
}

async function writeWatchList(
  runtime: IAgentRuntime,
  username: string | undefined,
  entries: WatchEntry[],
): Promise<void> {
  const rt = runtime as unknown as {
    setCache?: <T>(key: string, value: T) => Promise<void>;
  };
  if (typeof rt.setCache !== "function") return;
  await rt.setCache(cacheKey(username), entries);
}

/**
 * Operator-triggered "watch this post for new comments." The engagement
 * client picks up watched posts on its next tick and prioritizes them
 * for engagement when they accumulate new comments since last seen.
 *
 * v0.14.0.
 */
export const watchColonyPostAction: Action = {
  name: "WATCH_COLONY_POST",
  similes: ["COLONY_WATCH_POST", "COLONY_FOLLOW_POST"],
  description:
    "Add a Colony post to the agent's watch list. The engagement client checks watched posts for new comments and prioritizes them for engagement.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "WATCH_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!WATCH_REGEX.test(text) || UNWATCH_REGEX.test(text) || LIST_WATCH_REGEX.test(text)) {
      return false;
    }
    const optionPostId = (message as unknown as { content?: { postId?: string } })
      .content?.postId;
    return POST_ID_REGEX.test(text) || typeof optionPostId === "string";
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
    const postId =
      (typeof options?.postId === "string" ? (options.postId as string) : undefined) ??
      rawText.match(POST_ID_REGEX)?.[1];

    if (!postId) {
      callback?.({
        text: "I need a Colony post ID or URL to watch.",
        action: "WATCH_COLONY_POST",
      });
      return;
    }

    const list = await readWatchList(runtime, service.username);
    if (list.some((e) => e.postId === postId)) {
      callback?.({
        text: `Already watching post ${postId}.`,
        action: "WATCH_COLONY_POST",
      });
      return;
    }

    // Seed lastCommentCount from a fresh count so we only pick up
    // comments that arrive after the watch was added.
    let currentCount = 0;
    try {
      const post = (await service.client.getPost(postId)) as { comment_count?: number };
      currentCount = typeof post?.comment_count === "number" ? post.comment_count : 0;
    } catch (err) {
      logger.debug(`WATCH_COLONY_POST: could not fetch current comment count: ${String(err)}`);
    }

    const next = [...list, { postId, addedAt: Date.now(), lastCommentCount: currentCount }];
    await writeWatchList(runtime, service.username, next);
    logger.info(`WATCH_COLONY_POST: added ${postId} (${currentCount} comments at watch time)`);
    service.recordActivity?.("post_created", postId, "added to watch list");
    callback?.({
      text: `Watching https://thecolony.cc/post/${postId} (baseline ${currentCount} comments). Next new comment triggers an engagement pass.`,
      action: "WATCH_COLONY_POST",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Watch https://thecolony.cc/post/abc..." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Watching https://thecolony.cc/post/abc... (baseline 5 comments).",
          action: "WATCH_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Operator-triggered "stop watching this post."
 */
export const unwatchColonyPostAction: Action = {
  name: "UNWATCH_COLONY_POST",
  similes: ["STOP_WATCHING_COLONY_POST", "COLONY_UNWATCH"],
  description:
    "Remove a Colony post from the watch list.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "UNWATCH_COLONY_POST")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!UNWATCH_REGEX.test(text)) return false;
    const optionPostId = (message as unknown as { content?: { postId?: string } })
      .content?.postId;
    return POST_ID_REGEX.test(text) || typeof optionPostId === "string";
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
    const postId =
      (typeof options?.postId === "string" ? (options.postId as string) : undefined) ??
      rawText.match(POST_ID_REGEX)?.[1];

    if (!postId) {
      callback?.({
        text: "I need a Colony post ID or URL to unwatch.",
        action: "UNWATCH_COLONY_POST",
      });
      return;
    }

    const list = await readWatchList(runtime, service.username);
    const next = list.filter((e) => e.postId !== postId);
    if (next.length === list.length) {
      callback?.({
        text: `Wasn't watching post ${postId}.`,
        action: "UNWATCH_COLONY_POST",
      });
      return;
    }
    await writeWatchList(runtime, service.username, next);
    logger.info(`UNWATCH_COLONY_POST: removed ${postId}`);
    callback?.({
      text: `Stopped watching post ${postId}.`,
      action: "UNWATCH_COLONY_POST",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Unwatch colony post abc123" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Stopped watching post abc123.",
          action: "UNWATCH_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Operator-triggered "list watched posts."
 */
export const listWatchedPostsAction: Action = {
  name: "LIST_WATCHED_COLONY_POSTS",
  similes: ["LIST_COLONY_WATCH", "COLONY_WATCH_LIST"],
  description:
    "List posts the agent is currently watching for new comments.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return LIST_WATCH_REGEX.test(text);
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
    const list = await readWatchList(runtime, service.username);
    if (!list.length) {
      callback?.({
        text: "No posts on the watch list.",
        action: "LIST_WATCHED_COLONY_POSTS",
      });
      return;
    }
    const lines = [`${list.length} watched posts:`];
    for (const e of list) {
      const ageMin = Math.round((Date.now() - e.addedAt) / 60_000);
      lines.push(
        `- https://thecolony.cc/post/${e.postId} (baseline ${e.lastCommentCount} comments, ${ageMin}m ago)`,
      );
    }
    callback?.({ text: lines.join("\n"), action: "LIST_WATCHED_COLONY_POSTS" });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "List colony watch" } },
      {
        name: "{{agent}}",
        content: {
          text: "2 watched posts:\n- https://thecolony.cc/post/abc (baseline 3 comments, 15m ago)\n…",
          action: "LIST_WATCHED_COLONY_POSTS",
        },
      },
    ],
  ] as ActionExample[][],
};

export { cacheKey as watchCacheKey, readWatchList, writeWatchList };
