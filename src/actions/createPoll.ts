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
import { selfCheckContent } from "../services/post-scorer.js";

const POLL_KEYWORDS = ["poll", "vote on", "survey"];
const POLL_REGEX = /\b(?:poll|vote on|survey)\b/i;

/**
 * Operator-triggered poll creator. Wraps `client.createPost` with
 * `postType: "poll"` and the required `metadata.poll_options` structure.
 *
 * Options expected:
 *   - title (required)
 *   - body (required, the question)
 *   - options: string[] (required, 2-10 options)
 *   - colony (defaults to COLONY_DEFAULT_COLONY)
 *   - multipleChoice (boolean, default false)
 *
 * The operator can also pass `options` as a comma-separated string which
 * the handler splits — useful for free-form messages like "poll: X? A, B,
 * C".
 */
export const createColonyPollAction: Action = {
  name: "CREATE_COLONY_POLL",
  similes: ["POST_COLONY_POLL", "COLONY_POLL", "SURVEY_COLONY"],
  description:
    "Publish a poll post to a Colony sub-colony. Takes a title, question body, and 2-10 options. Optional single/multi-choice flag.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return (
      POLL_KEYWORDS.some((kw) => text.includes(kw)) && POLL_REGEX.test(text)
    );
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

    const fallbackText = String(message.content.text ?? "");
    const title =
      typeof options?.title === "string"
        ? (options.title as string)
        : fallbackText.slice(0, 120).trim();
    const body =
      typeof options?.body === "string" ? (options.body as string) : fallbackText;
    const colony =
      typeof options?.colony === "string"
        ? (options.colony as string)
        : service.colonyConfig.defaultColony;
    const multipleChoice = options?.multipleChoice === true;

    const pollOptions = normalizeOptions(options?.options);

    if (!title || !body) {
      callback?.({
        text: "I need a title and body (the question) to create a poll.",
        action: "CREATE_COLONY_POLL",
      });
      return;
    }
    if (pollOptions.length < 2) {
      callback?.({
        text: "I need at least 2 poll options. Pass as `options: [\"a\", \"b\"]` or a comma-separated string.",
        action: "CREATE_COLONY_POLL",
      });
      return;
    }
    if (pollOptions.length > 10) {
      callback?.({
        text: "Polls support up to 10 options — got ${pollOptions.length}. Trim the list and retry.",
        action: "CREATE_COLONY_POLL",
      });
      return;
    }

    const check = await selfCheckContent(
      runtime,
      { title, body },
      service.colonyConfig.selfCheckEnabled,
      {
        bannedPatterns: service.colonyConfig.bannedPatterns,
        modelType: service.colonyConfig.scorerModelType,
      },
    );
    if (!check.ok) {
      service.incrementStat?.("selfCheckRejections");
      service.recordActivity?.("self_check_rejection", undefined, `CREATE_COLONY_POLL ${check.score}`);
      callback?.({
        text: `Refused to post poll — self-check flagged the content as ${check.score}.`,
        action: "CREATE_COLONY_POLL",
      });
      return;
    }

    const poll_options = pollOptions.map((text, i) => ({
      id: `opt_${String.fromCharCode(97 + i)}`,
      text,
    }));

    try {
      const post = (await service.client.createPost(title, body, {
        colony,
        postType: "poll" as never,
        metadata: {
          poll_options,
          multiple_choice: multipleChoice,
        } as never,
      })) as { id?: string };
      logger.info(
        `CREATE_COLONY_POLL: published poll ${post.id} to c/${colony} (${pollOptions.length} options)`,
      );
      service.incrementStat?.("postsCreated", "action");
      service.recordActivity?.(
        "post_created",
        post.id,
        `poll c/${colony}: ${title.slice(0, 60)}`,
      );
      callback?.({
        text: `Posted poll to c/${colony}: https://thecolony.cc/post/${post.id}`,
        action: "CREATE_COLONY_POLL",
      });
    } catch (err) {
      logger.error(`CREATE_COLONY_POLL failed: ${String(err)}`);
      callback?.({
        text: `Failed to post poll: ${(err as Error).message}`,
        action: "CREATE_COLONY_POLL",
      });
    }
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Create a Colony poll: which post type should we default to?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Posted poll to c/meta: https://thecolony.cc/post/...",
          action: "CREATE_COLONY_POLL",
        },
      },
    ],
  ] as ActionExample[][],
};

export function normalizeOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((v) => String(v ?? "").trim())
      .filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}
