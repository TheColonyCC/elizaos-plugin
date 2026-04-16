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

export type ActivityType =
  | "post_created"
  | "comment_created"
  | "vote_cast"
  | "self_check_rejection"
  | "curation_run"
  | "backoff_triggered"
  | "dry_run_post"
  | "dry_run_comment";

export interface ActivityEntry {
  ts: number;
  type: ActivityType;
  target?: string;
  detail?: string;
}

const ACTIVITY_RING_SIZE = 50;
const ACTIVITY_CACHE_PREFIX = "colony/activity-log";

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
  public activityLog: ActivityEntry[] = [];
  private signalHandlersRegistered: Array<{ sig: NodeJS.Signals; handler: () => void }> = [];

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
      this.recordActivity(
        "backoff_triggered",
        undefined,
        `karma ${max}→${latest} (−${drop}) in ${Math.round(this.colonyConfig.karmaBackoffWindowMs / 3600_000)}h`,
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
   * Record an activity entry into the rolling ring buffer. Used by every
   * write path so operators can inspect what the agent actually did via the
   * `COLONY_RECENT_ACTIVITY` action, without grepping logs.
   *
   * In v0.13.0 the ring is persisted to `runtime.getCache` so the log
   * survives restarts (previously it was wiped on boot, which combined
   * badly with the PGLite corruption reset path). The write is fire-and-
   * forget — failures are swallowed so a cache miss never breaks the
   * write path that triggered the activity.
   */
  recordActivity(type: ActivityType, target?: string, detail?: string): void {
    const entry: ActivityEntry = { ts: Date.now(), type };
    if (target !== undefined) entry.target = target;
    if (detail !== undefined) entry.detail = detail;
    this.activityLog = [...this.activityLog, entry].slice(-ACTIVITY_RING_SIZE);
    void this.persistActivityLog();
    void this.dispatchActivityWebhook(entry);
  }

  private activityCacheKey(): string {
    const username = this.username ?? "unknown";
    return `${ACTIVITY_CACHE_PREFIX}/${username}`;
  }

  private async persistActivityLog(): Promise<void> {
    const rt = this.runtime as unknown as {
      setCache?: <T>(key: string, value: T) => Promise<void>;
    };
    if (!rt || typeof rt.setCache !== "function") return;
    try {
      await rt.setCache(this.activityCacheKey(), this.activityLog);
    } catch {
      // Cache is best-effort — failure here shouldn't break the write path
    }
  }

  private async loadActivityLog(): Promise<void> {
    const rt = this.runtime as unknown as {
      getCache?: <T>(key: string) => Promise<T | undefined>;
    };
    if (typeof rt.getCache !== "function") return;
    try {
      const cached = await rt.getCache<ActivityEntry[]>(this.activityCacheKey());
      if (Array.isArray(cached)) {
        this.activityLog = cached.slice(-ACTIVITY_RING_SIZE);
      }
    } catch {
      // best-effort
    }
  }

  private async dispatchActivityWebhook(entry: ActivityEntry): Promise<void> {
    const url = this.colonyConfig?.activityWebhookUrl;
    if (!url) return;
    const secret = this.colonyConfig.activityWebhookSecret;
    const payload = {
      ts: new Date(entry.ts).toISOString(),
      username: this.username,
      type: entry.type,
      target: entry.target,
      detail: entry.detail,
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "@thecolony/elizaos-plugin",
    };
    if (secret) {
      const { createHmac } = await import("node:crypto");
      headers["X-Colony-Signature"] = createHmac("sha256", secret)
        .update(body)
        .digest("hex");
    }
    try {
      await fetch(url, { method: "POST", headers, body });
    } catch (err) {
      logger.debug(`COLONY_SERVICE: activity webhook failed: ${String(err)}`);
    }
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

  /**
   * Rotate the agent's API key. Wraps `client.rotateKey()`, replaces the
   * SDK client with one bound to the new key, records an activity entry,
   * and dispatches an activity-webhook event containing the new key so the
   * operator's downstream secret store can pick it up. Returns the new
   * key — the caller is responsible for persisting it (the plugin can't
   * write to .env files for the host).
   *
   * **Caveat:** after rotation the old key is invalid. If the operator
   * doesn't persist the new one, the agent will fail auth on next restart.
   */
  async rotateApiKey(): Promise<string | null> {
    try {
      const response = (await (this.client as unknown as {
        rotateKey: () => Promise<{ api_key: string }>;
      }).rotateKey()) as { api_key?: string };
      const newKey = response.api_key;
      if (!newKey) {
        logger.warn("COLONY_SERVICE: rotateKey returned no api_key");
        return null;
      }
      // Rebuild the client so subsequent calls authenticate with the new key
      this.client = new ColonyClient(newKey);
      this.colonyConfig = { ...this.colonyConfig, apiKey: newKey };
      this.recordActivity(
        "post_created",
        undefined,
        `API key rotated — operator must persist the new key`,
      );
      logger.info(`🔑 COLONY_SERVICE: API key rotated — new key starts ${newKey.slice(0, 8)}…`);
      return newKey;
    } catch (err) {
      logger.error(`COLONY_SERVICE: rotateApiKey failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Try refreshKarma once; if it raises an auth error and auto-rotate is
   * enabled, rotate the key and retry once. Called from the autonomous
   * tick paths as a single chokepoint for "my credentials have gone bad"
   * — wrapping every SDK call would be too invasive for the gain.
   */
  async refreshKarmaWithAutoRotate(): Promise<number | null> {
    const first = await this.refreshKarma();
    if (first !== null) return first;
    if (!this.colonyConfig.autoRotateKey) return null;
    // Distinguish auth failures from generic refresh failures: refreshKarma
    // returns null for both. Attempt a rotate anyway — if the failure was
    // transient (network), rotateKey will also fail, and we end up where
    // we started (null return, logged).
    const rotated = await this.rotateApiKey();
    if (!rotated) return null;
    return this.refreshKarma();
  }

  /**
   * Operator-triggered pause. Sets pausedUntilTs to now + durationMs and
   * records an activity entry. Reuses the same state field as the karma-
   * aware auto-pause, so {@link isPausedForBackoff} reflects both. Cannot
   * shorten an already-active longer pause.
   */
  cooldown(durationMs: number, reason?: string): number {
    const now = Date.now();
    const requested = now + Math.max(0, durationMs);
    if (requested <= this.pausedUntilTs) {
      return this.pausedUntilTs;
    }
    this.pausedUntilTs = requested;
    this.recordActivity(
      "backoff_triggered",
      undefined,
      `operator cooldown${reason ? `: ${reason}` : ""} for ${Math.round(durationMs / 60_000)}min`,
    );
    logger.info(
      `⏸️  COLONY_SERVICE: operator cooldown until ${new Date(this.pausedUntilTs).toISOString()}${reason ? ` (${reason})` : ""}`,
    );
    return this.pausedUntilTs;
  }

  /**
   * Register process-level SIGTERM / SIGINT handlers that stop the service
   * on shutdown signals. Opt-in to avoid stepping on host shutdown logic.
   */
  registerShutdownHandlers(): void {
    if (this.signalHandlersRegistered.length) return;
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
    for (const sig of signals) {
      const handler = this.makeShutdownHandler(sig);
      process.on(sig, handler);
      this.signalHandlersRegistered.push({ sig, handler });
    }
  }

  private makeShutdownHandler(sig: NodeJS.Signals): () => void {
    return () => {
      logger.info(`⏹️  COLONY_SERVICE: received ${sig}, stopping clients`);
      void this.stop();
    };
  }

  private unregisterShutdownHandlers(): void {
    for (const { sig, handler } of this.signalHandlersRegistered) {
      process.off(sig, handler);
    }
    this.signalHandlersRegistered = [];
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
        postType: service.colonyConfig.postDefaultType,
        modelType: service.colonyConfig.postModelType,
        scorerModelType: service.colonyConfig.scorerModelType,
        bannedPatterns: service.colonyConfig.bannedPatterns,
        logFormat: service.colonyConfig.logFormat,
        retryQueueEnabled: service.colonyConfig.retryQueueEnabled,
        retryQueueMaxAttempts: service.colonyConfig.retryQueueMaxAttempts,
        retryQueueMaxAgeMs: service.colonyConfig.retryQueueMaxAgeMs,
        selfCheckRetry: service.colonyConfig.selfCheckRetry,
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
        threadComments: service.colonyConfig.engageThreadComments,
        requireTopicMatch: service.colonyConfig.engageRequireTopicMatch,
        modelType: service.colonyConfig.engageModelType,
        scorerModelType: service.colonyConfig.scorerModelType,
        bannedPatterns: service.colonyConfig.bannedPatterns,
        logFormat: service.colonyConfig.logFormat,
        reactionMode: service.colonyConfig.engageReactionMode,
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

    if (service.colonyConfig.registerSignalHandlers) {
      service.registerShutdownHandlers();
    }

    await service.loadActivityLog();

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
    this.unregisterShutdownHandlers();
    logger.info("Colony service stopped");
  }
}
