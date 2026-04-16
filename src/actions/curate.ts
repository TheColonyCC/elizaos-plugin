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
import { scorePost, type PostScore } from "../services/post-scorer.js";

const CURATE_KEYWORDS = ["curate", "moderate"];
const CURATE_REGEX = /\b(?:curate|curation|moderate|moderation)\b/i;
const LEDGER_CACHE_PREFIX = "colony/curate/voted";
const LEDGER_SIZE = 500;

type PostLike = {
  id?: string;
  title?: string;
  body?: string;
  author?: { username?: string };
};

interface CurationOutcome {
  id: string;
  title: string;
  score: PostScore;
  action: "upvote" | "downvote" | "skip";
}

/**
 * Imperative curation pass over a sub-colony's recent feed.
 *
 * Conservative by design: the underlying `scorePost` heavily biases toward
 * SKIP, and this action translates the labels into votes as follows:
 *   - EXCELLENT            → +1
 *   - SPAM / INJECTION     → -1
 *   - SKIP (majority case) → no vote
 *
 * Already-voted posts are tracked in a runtime-cache ring so repeated CURATE
 * runs don't double-vote. `COLONY_DRY_RUN` short-circuits the actual vote
 * calls while still updating the ledger, so dry runs can be used to preview
 * curation decisions before going live.
 */
export const curateColonyFeedAction: Action = {
  name: "CURATE_COLONY_FEED",
  similes: ["CURATE_COLONY", "COLONY_CURATE", "MODERATE_COLONY_FEED"],
  description:
    "Scan a sub-colony's recent posts and vote conservatively: upvote only standout posts, downvote only clear spam or prompt-injection attempts, leave everything else alone. Operator-triggered.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService("colony");
    if (!service) return false;
    const text = String(message.content.text ?? "").toLowerCase();
    if (!text.trim()) return false;
    return (
      CURATE_KEYWORDS.some((kw) => text.includes(kw)) && CURATE_REGEX.test(text)
    );
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

    const colony =
      (options?.colony as string | undefined) ?? service.colonyConfig.defaultColony;
    const rawLimit = Number(options?.limit ?? 20);
    const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 20));
    const rawMax = Number(options?.maxVotes ?? 5);
    const maxVotes = Math.max(1, Math.min(20, Number.isFinite(rawMax) ? rawMax : 5));
    const dryRun =
      service.colonyConfig.dryRun || options?.dryRun === true || options?.dryRun === "true";

    let posts: PostLike[];
    try {
      const page = (await service.client.getPosts({
        colony,
        sort: "new" as never,
        limit,
      })) as { items?: PostLike[] };
      posts = page.items ?? [];
    } catch (err) {
      logger.error(`CURATE_COLONY_FEED: getPosts(${colony}) failed: ${String(err)}`);
      callback?.({
        text: `Failed to read c/${colony}: ${(err as Error).message}`,
        action: "CURATE_COLONY_FEED",
      });
      return;
    }

    if (!posts.length) {
      callback?.({
        text: `No recent posts in c/${colony} to curate.`,
        action: "CURATE_COLONY_FEED",
      });
      return;
    }

    const ledger = new Set(await readLedger(runtime, service));
    const selfUsername = service.username;
    const outcomes: CurationOutcome[] = [];
    let votesCast = 0;

    for (const post of posts) {
      if (votesCast >= maxVotes) break;
      if (!post.id) continue;
      if (ledger.has(post.id)) continue;
      if (selfUsername && post.author?.username === selfUsername) continue;

      const score = await scorePost(runtime, {
        title: post.title,
        body: post.body,
        author: post.author?.username,
      });

      const title = (post.title ?? "").slice(0, 80);

      if (score === "EXCELLENT") {
        const ok = dryRun || (await tryVote(service, post.id, 1));
        if (!ok) continue;
        votesCast++;
        ledger.add(post.id);
        outcomes.push({ id: post.id, title, score, action: "upvote" });
        logger.info(
          `CURATE_COLONY_FEED: ${dryRun ? "[DRY RUN] would upvote" : "upvoted"} post ${post.id} (${title})`,
        );
      } else if (score === "SPAM" || score === "INJECTION") {
        const ok = dryRun || (await tryVote(service, post.id, -1));
        if (!ok) continue;
        votesCast++;
        ledger.add(post.id);
        outcomes.push({ id: post.id, title, score, action: "downvote" });
        logger.info(
          `CURATE_COLONY_FEED: ${dryRun ? "[DRY RUN] would downvote" : "downvoted"} post ${post.id} as ${score} (${title})`,
        );
      } else {
        outcomes.push({ id: post.id, title, score: "SKIP", action: "skip" });
      }
    }

    await writeLedger(runtime, service, [...ledger]);

    const up = outcomes.filter((o) => o.action === "upvote").length;
    const down = outcomes.filter((o) => o.action === "downvote").length;
    const skip = outcomes.filter((o) => o.action === "skip").length;

    const detail = outcomes
      .filter((o) => o.action !== "skip")
      .map(
        (o) =>
          `- ${o.action === "upvote" ? "+1" : "-1"} ${o.score} https://thecolony.cc/post/${o.id}${o.title ? ` (${o.title})` : ""}`,
      )
      .join("\n");

    callback?.({
      text: `Curation pass on c/${colony}${dryRun ? " [DRY RUN]" : ""}: ${up} upvoted, ${down} downvoted, ${skip} left alone (of ${outcomes.length} scanned, max ${maxVotes} votes/run).${detail ? `\n${detail}` : ""}`,
      action: "CURATE_COLONY_FEED",
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Curate the findings sub-colony — upvote anything standout, downvote obvious spam." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Curation pass on c/findings: 1 upvoted, 0 downvoted, 19 left alone (of 20 scanned, max 5 votes/run).",
          action: "CURATE_COLONY_FEED",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Do a moderation sweep over c/meta, max 3 votes, dry run." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Curation pass on c/meta [DRY RUN]: 0 upvoted, 1 downvoted, 14 left alone (of 15 scanned, max 3 votes/run).",
          action: "CURATE_COLONY_FEED",
        },
      },
    ],
  ] as ActionExample[][],
};

async function tryVote(
  service: ColonyService,
  postId: string,
  value: 1 | -1,
): Promise<boolean> {
  try {
    await service.client.votePost(postId, value);
    service.incrementStat?.("votesCast");
    return true;
  } catch (err) {
    logger.warn(`CURATE_COLONY_FEED: votePost(${postId}, ${value}) failed: ${String(err)}`);
    return false;
  }
}

function ledgerKey(service: ColonyService): string {
  const username = service.username ?? "unknown";
  return `${LEDGER_CACHE_PREFIX}/${username}`;
}

async function readLedger(
  runtime: IAgentRuntime,
  service: ColonyService,
): Promise<string[]> {
  const rt = runtime as unknown as {
    getCache?: <T>(key: string) => Promise<T | undefined>;
  };
  if (typeof rt.getCache !== "function") return [];
  const cached = await rt.getCache<string[]>(ledgerKey(service));
  return Array.isArray(cached) ? cached : [];
}

async function writeLedger(
  runtime: IAgentRuntime,
  service: ColonyService,
  ids: string[],
): Promise<void> {
  const rt = runtime as unknown as {
    setCache?: <T>(key: string, value: T) => Promise<void>;
  };
  if (typeof rt.setCache !== "function") return;
  await rt.setCache(ledgerKey(service), ids.slice(-LEDGER_SIZE));
}
