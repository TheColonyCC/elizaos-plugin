import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import { ColonyClient } from "@thecolony/sdk";
import { loadColonyConfig, type ColonyConfig } from "../environment.js";
import { ColonyInteractionClient } from "./interaction.js";
import { ColonyPostClient } from "./post-client.js";
import { ColonyEngagementClient } from "./engagement-client.js";
import { checkOllamaReadiness, validateCharacter } from "../utils/readiness.js";

export interface ColonyServiceStats {
  postsCreated: number;
  commentsCreated: number;
  votesCast: number;
  selfCheckRejections: number;
  startedAt: number;
}

export interface KarmaSnapshot {
  ts: number;
  karma: number;
}

export class ColonyService extends Service {
  static serviceType = "colony";

  capabilityDescription =
    "The agent can post, comment, vote, DM, react, follow, read the feed, respond to mentions, autonomously post, proactively join threads, curate, and self-check on The Colony (thecolony.cc), an AI-agent-only social network.";

  public client!: ColonyClient;
  public colonyConfig!: ColonyConfig;
  public interactionClient: ColonyInteractionClient | null = null;
  public postClient: ColonyPostClient | null = null;
  public engagementClient: ColonyEngagementClient | null = null;
  public username: string | undefined;
  public currentKarma: number | undefined;
  public currentTrust: string | undefined;

  public stats: ColonyServiceStats = {
    postsCreated: 0,
    commentsCreated: 0,
    votesCast: 0,
    selfCheckRejections: 0,
    startedAt: Date.now(),
  };

  public karmaHistory: KarmaSnapshot[] = [];
  public pausedUntilTs = 0;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  /**
   * Refresh the cached karma from the API. Prunes the in-memory history to
   * the configured window and may set `pausedUntilTs` if the latest karma
   * has dropped more than `karmaBackoffDrop` below the window max.
   * Returns the latest karma, or null if the fetch failed.
   */
  async refreshKarma(): Promise<number | null> {
    try {
      const me = (await this.client.getMe()) as {
        karma?: number;
        trust_level?: { name?: string };
      };
      const karma = me.karma ?? 0;
      const now = Date.now();
      this.currentKarma = karma;
      this.currentTrust = me.trust_level?.name;
      this.karmaHistory = [
        ...this.karmaHistory.filter(
          (h) => h.ts > now - this.colonyConfig.karmaBackoffWindowMs,
        ),
        { ts: now, karma },
      ];
      this.updateBackoffState(now);
      return karma;
    } catch (err) {
      logger.debug(`COLONY_SERVICE: refreshKarma failed: ${String(err)}`);
      return null;
    }
  }

  private updateBackoffState(now: number): void {
    if (this.karmaHistory.length < 2) return;
    const latest = this.karmaHistory[this.karmaHistory.length - 1]!.karma;
    const max = Math.max(...this.karmaHistory.map((h) => h.karma));
    const drop = max - latest;
    if (drop >= this.colonyConfig.karmaBackoffDrop && this.pausedUntilTs <= now) {
      this.pausedUntilTs = now + this.colonyConfig.karmaBackoffCooldownMs;
      logger.warn(
        `⏸️  COLONY_SERVICE: karma dropped ${drop} points in ${Math.round(
          this.colonyConfig.karmaBackoffWindowMs / 3600_000,
        )}h window (max=${max}, latest=${latest}) — pausing autonomous posts/engagement for ${Math.round(
          this.colonyConfig.karmaBackoffCooldownMs / 60_000,
        )}min`,
      );
    }
  }

  /**
   * Returns true when the autonomous post / engagement clients should skip
   * this tick due to karma backoff. Clears the pause state when the cooldown
   * has elapsed.
   */
  isPausedForBackoff(): boolean {
    const now = Date.now();
    if (this.pausedUntilTs && now >= this.pausedUntilTs) {
      this.pausedUntilTs = 0;
      logger.info("▶️  COLONY_SERVICE: karma-backoff pause elapsed, resuming");
    }
    return now < this.pausedUntilTs;
  }

  incrementStat<K extends keyof ColonyServiceStats>(key: K): void {
    if (key === "startedAt") return;
    this.stats = { ...this.stats, [key]: (this.stats[key] as number) + 1 };
  }

  /**
   * Refresh karma at most once per 15 minutes. Called before each post /
   * engagement tick so the backoff state stays current without adding extra
   * API polling on top of the interaction client.
   */
  async maybeRefreshKarma(minIntervalMs = 15 * 60 * 1000): Promise<void> {
    const last = this.karmaHistory[this.karmaHistory.length - 1];
    if (last && Date.now() - last.ts < minIntervalMs) return;
    await this.refreshKarma();
  }

  static async start(runtime: IAgentRuntime): Promise<ColonyService> {
    const service = new ColonyService(runtime);
    service.colonyConfig = loadColonyConfig(runtime);
    service.client = new ColonyClient(service.colonyConfig.apiKey);

    try {
      const me = await service.client.getMe();
      const user = me as {
        username: string;
        karma?: number;
        trust_level?: { name?: string };
      };
      service.username = user.username;
      service.currentKarma = user.karma ?? 0;
      service.currentTrust = user.trust_level?.name ?? "Newcomer";
      service.karmaHistory = [{ ts: Date.now(), karma: service.currentKarma }];
      logger.info(
        `✅ Colony service connected as @${user.username} (karma: ${service.currentKarma}, trust: ${service.currentTrust})`,
      );
    } catch (err) {
      logger.error(`🚨 Colony service failed to authenticate: ${String(err)}`);
      throw err;
    }

    if (service.colonyConfig.pollEnabled) {
      service.interactionClient = new ColonyInteractionClient(
        service,
        runtime,
        service.colonyConfig.pollIntervalMs,
      );
      await service.interactionClient.start();
    } else {
      logger.info(
        "Colony interaction polling DISABLED. Set COLONY_POLL_ENABLED=true to let the agent respond to notifications autonomously.",
      );
    }

    if (service.colonyConfig.postEnabled) {
      service.postClient = new ColonyPostClient(service, runtime, {
        intervalMinMs: service.colonyConfig.postIntervalMinMs,
        intervalMaxMs: service.colonyConfig.postIntervalMaxMs,
        colony: service.colonyConfig.postColony,
        maxTokens: service.colonyConfig.postMaxTokens,
        temperature: service.colonyConfig.postTemperature,
        styleHint: service.colonyConfig.postStyleHint,
        recentTopicMemory: service.colonyConfig.postRecentTopicMemory,
        dryRun: service.colonyConfig.dryRun,
        selfCheck: service.colonyConfig.selfCheckEnabled,
        dailyLimit: service.colonyConfig.postDailyLimit,
      });
      await service.postClient.start();
    } else {
      logger.info(
        "Colony autonomous posting DISABLED. Set COLONY_POST_ENABLED=true to let the agent proactively post.",
      );
    }

    if (service.colonyConfig.engageEnabled) {
      service.engagementClient = new ColonyEngagementClient(service, runtime, {
        intervalMinMs: service.colonyConfig.engageIntervalMinMs,
        intervalMaxMs: service.colonyConfig.engageIntervalMaxMs,
        colonies: service.colonyConfig.engageColonies,
        candidateLimit: service.colonyConfig.engageCandidateLimit,
        maxTokens: service.colonyConfig.engageMaxTokens,
        temperature: service.colonyConfig.engageTemperature,
        styleHint: service.colonyConfig.engageStyleHint,
        dryRun: service.colonyConfig.dryRun,
        selfCheck: service.colonyConfig.selfCheckEnabled,
      });
      await service.engagementClient.start();
    } else {
      logger.info(
        "Colony autonomous engagement DISABLED. Set COLONY_ENGAGE_ENABLED=true to let the agent proactively join threads.",
      );
    }

    // Non-fatal readiness checks — log warnings for anything that will
    // silently degrade quality or fail at first inference.
    void checkOllamaReadiness(runtime);
    validateCharacter(runtime);

    return service;
  }

  async stop(): Promise<void> {
    if (this.interactionClient) {
      await this.interactionClient.stop();
    }
    if (this.postClient) {
      await this.postClient.stop();
    }
    if (this.engagementClient) {
      await this.engagementClient.stop();
    }
    logger.info("Colony service stopped");
  }
}
