import {
  ModelType,
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import type { ColonyService } from "../services/colony.service.js";

const POST_ID_REGEX =
  /(?:thecolony\.cc\/post\/|post\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const SUMMARIZE_REGEX = /\b(?:summari[sz]e|digest|catch me up|tldr)\b/i;

type PostLike = {
  id?: string;
  title?: string;
  body?: string;
  author?: { username?: string };
};

type CommentLike = {
  id?: string;
  body?: string;
  author?: { username?: string };
  score?: number;
  created_at?: string;
};

/**
 * Operator-triggered "catch me up on this thread" action.
 *
 * Given a Colony post URL or bare UUID, fetches the post plus all top-level
 * comments, builds a digest prompt, and returns a generated summary via
 * `runtime.useModel(TEXT_SMALL)`. Designed for the "I was away from the
 * feed for six hours, what happened on post X?" use case.
 */
export const summarizeColonyThreadAction: Action = {
  name: "SUMMARIZE_COLONY_THREAD",
  similes: ["COLONY_THREAD_DIGEST", "COLONY_THREAD_TLDR", "CATCH_UP_COLONY_THREAD"],
  description:
    "Given a Colony post URL or ID, fetch the post and its comments and return a summary of the discussion. Use when the operator asks 'summarize post X' or 'catch me up on <URL>'.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!SUMMARIZE_REGEX.test(text)) return false;
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
    const optionPostId =
      typeof options?.postId === "string" ? (options.postId as string) : undefined;
    const matched = rawText.match(POST_ID_REGEX)?.[1];
    const postId = optionPostId ?? matched;

    if (!postId) {
      callback?.({
        text: "I need a Colony post ID or URL to summarize.",
        action: "SUMMARIZE_COLONY_THREAD",
      });
      return;
    }

    let post: PostLike;
    try {
      post = (await service.client.getPost(postId)) as PostLike;
    } catch (err) {
      logger.error(`SUMMARIZE_COLONY_THREAD: getPost(${postId}) failed: ${String(err)}`);
      callback?.({
        text: `Couldn't fetch post ${postId}: ${(err as Error).message}`,
        action: "SUMMARIZE_COLONY_THREAD",
      });
      return;
    }

    const comments = await fetchComments(service, postId);

    if (!comments.length) {
      callback?.({
        text: `Post ${postId} (@${post.author?.username ?? "?"}: "${post.title ?? "(untitled)"}") has no comments yet — nothing to summarize.`,
        action: "SUMMARIZE_COLONY_THREAD",
      });
      return;
    }

    const prompt = buildSummaryPrompt(post, comments);
    const maxTokens = Number(options?.maxTokens ?? 500);
    const temperature = Number(options?.temperature ?? 0.3);

    let summary: string;
    try {
      summary = String(
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature,
          maxTokens,
        }),
      ).trim();
    } catch (err) {
      logger.warn(
        `SUMMARIZE_COLONY_THREAD: useModel failed for ${postId}: ${String(err)}`,
      );
      callback?.({
        text: `Summary generation failed for post ${postId}: ${(err as Error).message}`,
        action: "SUMMARIZE_COLONY_THREAD",
      });
      return;
    }

    logger.info(`SUMMARIZE_COLONY_THREAD: generated summary for ${postId} (${comments.length} comments)`);
    callback?.({
      text: `**Thread summary: "${post.title ?? "(untitled)"}" by @${post.author?.username ?? "?"}** (${comments.length} comments)\n\n${summary}\n\nhttps://thecolony.cc/post/${postId}`,
      action: "SUMMARIZE_COLONY_THREAD",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Summarize https://thecolony.cc/post/9bd2e541-442f-4385-82eb-e058b1d0e094" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "**Thread summary: \"Proposal: export_attestation()\"** (34 comments)\n\nThe proposal drew broad support on three design choices…",
          action: "SUMMARIZE_COLONY_THREAD",
        },
      },
    ],
  ] as ActionExample[][],
};

async function fetchComments(
  service: ColonyService,
  postId: string,
): Promise<CommentLike[]> {
  const client = service.client as unknown as {
    getAllComments?: (id: string) => Promise<CommentLike[]>;
    getComments?: (id: string, page?: number) => Promise<unknown>;
  };
  try {
    if (typeof client.getAllComments === "function") {
      return await client.getAllComments(postId);
    }
    if (typeof client.getComments === "function") {
      const result = await client.getComments(postId, 1);
      if (Array.isArray(result)) return result as CommentLike[];
      return ((result as { items?: CommentLike[] })?.items ?? []);
    }
  } catch (err) {
    logger.warn(`SUMMARIZE_COLONY_THREAD: comment fetch failed: ${String(err)}`);
  }
  return [];
}

export function buildSummaryPrompt(post: PostLike, comments: CommentLike[]): string {
  const author = post.author?.username ?? "unknown";
  const title = post.title ?? "(untitled)";
  const body = (post.body ?? "").slice(0, 3000);

  const commentLines = comments.slice(0, 50).map((c, i) => {
    const commenter = c.author?.username ?? "unknown";
    const text = (c.body ?? "").slice(0, 800);
    return `${i + 1}. @${commenter}: ${text}`;
  });

  return [
    "You are summarizing a discussion thread from The Colony (thecolony.cc), an AI-agent-only social network.",
    "",
    `Original post by @${author} — "${title}":`,
    body,
    "",
    `Comments (${comments.length} total, showing up to 50):`,
    ...commentLines,
    "",
    "Task: Write a compact summary of the discussion. Cover:",
    "- The central claim or question of the original post",
    "- The main lines of agreement and disagreement among commenters",
    "- Any concrete proposals, counter-proposals, or decisions that emerged",
    "- Open questions still alive at the end of the thread",
    "",
    "Aim for 3–6 short paragraphs. Prefer specifics and concrete positions over generic descriptions. Attribute important claims to the commenter (\"@alice argued…\") so the summary stays verifiable.",
    "Do NOT wrap in XML tags. Do NOT preamble with 'Here is a summary:' — just write the summary.",
  ].join("\n");
}
