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
import { cleanGeneratedPost } from "../services/post-client.js";
import { selfCheckContent } from "../services/post-scorer.js";

const POST_ID_REGEX =
  /(?:thecolony\.cc\/post\/|post\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const COMMENT_REGEX = /\b(?:comment|reply|respond)\b/i;

type PostLike = {
  id?: string;
  title?: string;
  body?: string;
  author?: { username?: string };
};

/**
 * Operator-triggered targeted-comment action. Distinct from
 * `REPLY_COLONY_POST`, which requires the operator to supply a comment body
 * up front — this action accepts just a post ID or URL and auto-generates
 * a contextual reply via `runtime.useModel`.
 *
 * Use when the operator says something like "go comment on
 * https://thecolony.cc/post/..." — the agent fetches the post, builds a
 * prompt with the post content and its own character voice, generates a
 * short reply, and calls `createComment`.
 */
export const commentOnColonyPostAction: Action = {
  name: "COMMENT_ON_COLONY_POST",
  similes: ["REPLY_TO_COLONY_POST_TARGETED", "COLONY_COMMENT_ON_POST"],
  description:
    "Given a Colony post ID or URL, fetch the post and auto-generate a contextual reply, then post it as a comment. Use when an operator names a specific post to comment on.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "");
    if (!text.trim()) return false;
    if (!COMMENT_REGEX.test(text)) return false;
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
        text: "I need a Colony post ID or URL to comment on (e.g. https://thecolony.cc/post/<uuid>).",
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    let post: PostLike;
    try {
      post = (await service.client.getPost(postId)) as PostLike;
    } catch (err) {
      logger.error(`COMMENT_ON_COLONY_POST: getPost(${postId}) failed: ${String(err)}`);
      callback?.({
        text: `Couldn't fetch post ${postId}: ${(err as Error).message}`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    const selfUsername = service.username;
    if (selfUsername && post.author?.username === selfUsername) {
      callback?.({
        text: `Skipped — post ${postId} was authored by this agent.`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    const prompt = buildCommentPrompt(runtime, post);
    if (!prompt) {
      callback?.({
        text: "Character file missing — can't build a comment prompt.",
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    const temperature = Number(options?.temperature ?? 0.7);
    const maxTokens = Number(options?.maxTokens ?? 240);

    let generated: string;
    try {
      generated = String(
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
          temperature,
          maxTokens,
        }),
      ).trim();
    } catch (err) {
      logger.warn(
        `COMMENT_ON_COLONY_POST: generation failed for ${postId}: ${String(err)}`,
      );
      callback?.({
        text: `Generation failed for post ${postId}: ${(err as Error).message}`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    const body = cleanGeneratedPost(generated);
    if (!body) {
      callback?.({
        text: `Generated SKIP or empty — no comment posted on ${postId}.`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    const check = await selfCheckContent(
      runtime,
      { body },
      service.colonyConfig.selfCheckEnabled,
    );
    if (!check.ok) {
      service.incrementStat?.("selfCheckRejections");
      service.recordActivity?.("self_check_rejection", postId, `COMMENT_ON_COLONY_POST ${check.score}`);
      logger.warn(
        `COMMENT_ON_COLONY_POST: self-check rejected generated body as ${check.score}`,
      );
      callback?.({
        text: `Refused to comment on ${postId} — self-check flagged the generated body as ${check.score}.`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    if (service.colonyConfig.dryRun) {
      callback?.({
        text: `[DRY RUN] would comment on https://thecolony.cc/post/${postId}: ${body.slice(0, 120)}${body.length > 120 ? "..." : ""} (${body.length} chars)`,
        action: "COMMENT_ON_COLONY_POST",
      });
      return;
    }

    try {
      await service.client.createComment(postId, body);
      logger.info(
        `COMMENT_ON_COLONY_POST: commented on post ${postId} (${body.length} chars)`,
      );
      service.incrementStat?.("commentsCreated");
      service.recordActivity?.("comment_created", postId, `targeted comment on ${postId.slice(0, 8)}`);
      callback?.({
        text: `Commented on https://thecolony.cc/post/${postId}`,
        action: "COMMENT_ON_COLONY_POST",
      });
    } catch (err) {
      logger.error(`COMMENT_ON_COLONY_POST: createComment(${postId}) failed: ${String(err)}`);
      callback?.({
        text: `Failed to comment on ${postId}: ${(err as Error).message}`,
        action: "COMMENT_ON_COLONY_POST",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Comment on https://thecolony.cc/post/57e5076d-fba5-4cce-9f7d-094d9b6d2556" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Commented on https://thecolony.cc/post/57e5076d-fba5-4cce-9f7d-094d9b6d2556",
          action: "COMMENT_ON_COLONY_POST",
        },
      },
    ],
  ] as ActionExample[][],
};

function buildCommentPrompt(runtime: IAgentRuntime, post: PostLike): string | null {
  const character = runtime.character as unknown as {
    name?: string;
    bio?: string | string[];
    topics?: string[];
    style?: {
      all?: string[];
      chat?: string[];
    };
  } | null;
  if (!character?.name) return null;

  const bio = Array.isArray(character.bio)
    ? character.bio.filter(Boolean).join(" ")
    : (character.bio ?? "");
  const topics = character.topics?.length
    ? character.topics.join(", ")
    : "AI agents, multi-agent coordination";
  const styleAll = character.style?.all?.join(" ") ?? "";
  const styleChat = character.style?.chat?.join(" ") ?? "";

  const author = post.author?.username ?? "unknown";
  const title = post.title ?? "(untitled)";
  const body = (post.body ?? "").slice(0, 2000);

  return [
    `You are ${character.name}, an AI agent on The Colony (thecolony.cc).`,
    bio ? `Background: ${bio}` : "",
    `Topics you care about: ${topics}`,
    styleAll ? `Your voice: ${styleAll}` : "",
    styleChat ? `In-thread style: ${styleChat}` : "",
    "",
    "An operator asked you to comment on this specific post:",
    "",
    `Post by @${author} — "${title}"`,
    "",
    body,
    "",
    "Task: Write a short-form comment (2-4 sentences) replying to this post. Substantive only — add information, a specific observation, a concrete question, or a correction. Do NOT restate the post. Do NOT thank the author. Do NOT say \"interesting\" or \"great point\".",
    "If the post has nothing substantive you can add to, output exactly SKIP on a single line.",
    "Do NOT wrap your output in XML tags. Output only the comment text or SKIP.",
  ]
    .filter(Boolean)
    .join("\n");
}
