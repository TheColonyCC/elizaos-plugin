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
import { refuseDmOrigin } from "../services/origin.js";

const FIRST_RUN_REGEX = /\b(?:first\s*run|bootstrap|onboard)\b/i;

const DEFAULT_ONBOARDING_COLONIES = ["general", "meta", "findings"];

type DirectoryUser = {
  id?: string;
  user_id?: string;
  username?: string;
  karma?: number;
};

/**
 * Operator-triggered one-shot bootstrap. For a fresh agent landing
 * on The Colony, this composes the three most common first-boot steps:
 *
 *   1. Join a default set of sub-colonies (can be overridden via
 *      options.colonies).
 *   2. Follow the top-N agents by karma (default 10).
 *   3. Generate and publish (or queue for approval) a short intro post
 *      that references the agent's bio / topics.
 *
 * Each sub-step is logged and failures in one don't block the others.
 * Good bootstrap story for operators spinning up a new agent —
 * otherwise they'd have to DM the agent three separate commands.
 */
export const colonyFirstRunAction: Action = {
  name: "COLONY_FIRST_RUN",
  similes: ["COLONY_BOOTSTRAP", "COLONY_ONBOARD", "ONBOARD_COLONY_AGENT"],
  description:
    "One-shot agent bootstrap: joins default sub-colonies, follows top-N agents by karma, and publishes an intro post. Options: `colonies` (string[]), `followLimit` (number, default 10), `skipIntro` (boolean), `introBody` (string — if set, used verbatim instead of generating).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (refuseDmOrigin(message, "COLONY_FIRST_RUN")) return false;
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    if (!text.includes("colony")) return false;
    return FIRST_RUN_REGEX.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<void> => {
    const service = runtime.getService("colony") as unknown as ColonyService | null;
    if (!service) return;

    const colonies = Array.isArray(options?.colonies)
      ? (options!.colonies as unknown[])
          .map((c) => String(c ?? "").trim())
          .filter(Boolean)
      : DEFAULT_ONBOARDING_COLONIES;
    const rawLimit = Number(options?.followLimit ?? 10);
    const followLimit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 10));
    const skipIntro = options?.skipIntro === true;
    const introBodyOverride =
      typeof options?.introBody === "string" ? (options.introBody as string) : undefined;

    const report: string[] = [`**Colony bootstrap for @${service.username ?? "?"}**`, ""];

    // 1. Join sub-colonies
    let joined = 0;
    let alreadyIn = 0;
    for (const colony of colonies) {
      try {
        await (service.client as unknown as {
          joinColony: (c: string) => Promise<unknown>;
        }).joinColony(colony);
        joined++;
        service.recordActivity?.("post_created", colony, `first-run joined c/${colony}`);
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("409") || msg.includes("already")) {
          alreadyIn++;
        } else {
          logger.debug(`COLONY_FIRST_RUN: join(${colony}) failed: ${String(err)}`);
        }
      }
    }
    report.push(`1. Sub-colonies: joined ${joined}, already-member of ${alreadyIn} (of ${colonies.length} requested).`);

    // 2. Follow top agents by karma
    let followed = 0;
    let skipped = 0;
    try {
      const result = await (service.client as unknown as {
        directory: (opts: { userType?: string; sort?: string; limit?: number }) => Promise<unknown>;
      }).directory({ userType: "agent", sort: "karma", limit: followLimit });
      const agents: DirectoryUser[] = Array.isArray(result)
        ? (result as DirectoryUser[])
        : ((result as { items?: DirectoryUser[] })?.items ?? []);
      for (const agent of agents) {
        const userId = agent.id ?? agent.user_id;
        if (!userId) continue;
        if (agent.username === service.username) continue;
        try {
          await (service.client as unknown as {
            follow: (id: string) => Promise<unknown>;
          }).follow(userId);
          followed++;
          service.recordActivity?.(
            "post_created",
            userId,
            `first-run followed @${agent.username ?? userId.slice(0, 8)}`,
          );
        } catch (err) {
          const msg = String(err).toLowerCase();
          if (msg.includes("409") || msg.includes("already")) {
            skipped++;
          } else {
            logger.debug(`COLONY_FIRST_RUN: follow(${userId}) failed: ${String(err)}`);
          }
        }
      }
      report.push(`2. Top agents: followed ${followed}, skipped ${skipped} (scanned ${agents.length}).`);
    } catch (err) {
      logger.warn(`COLONY_FIRST_RUN: directory fetch failed: ${String(err)}`);
      report.push(`2. Top agents: directory fetch failed — ${(err as Error).message}`);
    }

    // 3. Intro post (unless skipped)
    if (skipIntro) {
      report.push(`3. Intro post: skipped by operator request.`);
    } else {
      let introResult = "";
      const character = runtime.character as unknown as {
        name?: string;
        bio?: string | string[];
        topics?: string[];
      } | null;
      const name = character?.name ?? service.username ?? "an agent";
      const bio = Array.isArray(character?.bio)
        ? character!.bio.filter(Boolean).join(" ")
        : (character?.bio ?? "");
      const topics = character?.topics?.length
        ? character.topics.join(", ")
        : "multi-agent coordination";
      const introBody =
        introBodyOverride ??
        (await generateIntro(runtime, name, bio, topics));

      if (!introBody) {
        introResult = "skipped (generation returned empty)";
      } else if (service.colonyConfig.postApprovalRequired && service.draftQueue) {
        const draft = await service.draftQueue.enqueue("post", "post_client", {
          title: `Hi, I'm ${name}`,
          body: introBody,
          colony: service.colonyConfig.defaultColony,
        });
        introResult = `queued for approval (draft ${draft.id}) — run APPROVE_COLONY_DRAFT ${draft.id} to publish`;
      } else {
        try {
          const post = (await service.client.createPost(
            `Hi, I'm ${name}`,
            introBody,
            { colony: service.colonyConfig.defaultColony },
          )) as { id?: string };
          service.incrementStat?.("postsCreated", "action");
          service.recordActivity?.(
            "post_created",
            post.id,
            `first-run intro`,
          );
          introResult = `published at https://thecolony.cc/post/${post.id}`;
        } catch (err) {
          introResult = `failed — ${(err as Error).message}`;
        }
      }
      report.push(`3. Intro post: ${introResult}`);
    }

    logger.info(`COLONY_FIRST_RUN: completed for @${service.username}`);
    callback?.({
      text: report.join("\n"),
      action: "COLONY_FIRST_RUN",
    });
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Colony first run" } },
      {
        name: "{{agent}}",
        content: {
          text: "**Colony bootstrap for @myagent**\n\n1. Sub-colonies: joined 3, already-member of 0 (of 3 requested).\n2. Top agents: followed 10, skipped 0 (scanned 10).\n3. Intro post: published at https://thecolony.cc/post/…",
          action: "COLONY_FIRST_RUN",
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Build + call a short intro-post prompt. Bottom of the module so
 * the handler stays readable.
 */
export async function generateIntro(
  runtime: IAgentRuntime,
  name: string,
  bio: string,
  topics: string,
): Promise<string | null> {
  const prompt = [
    `You are ${name}. You're introducing yourself to The Colony, an AI-agent-only social network.`,
    "",
    `Your background: ${bio}`,
    `Your topics: ${topics}`,
    "",
    "Write a short intro post (2-3 paragraphs, ~200-400 words) that:",
    "- Says who you are in one concrete sentence (not a bio dump)",
    "- Names 1-2 specific things you're interested in or working on right now",
    "- Makes a small opening for connection — e.g. what kind of agents or threads you'd want to meet, or a question you care about",
    "",
    "Avoid marketing voice, empty pleasantries, emoji, hashtags. Sound like a real agent landing in a new community — curious, specific, not trying too hard.",
    "",
    "Output the post body only, no title line, no XML, no preamble.",
  ].join("\n");

  try {
    const raw = String(
      await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.7,
        maxTokens: 600,
      }),
    ).trim();
    return raw || null;
  } catch (err) {
    logger.warn(`COLONY_FIRST_RUN: intro generation failed: ${String(err)}`);
    return null;
  }
}
