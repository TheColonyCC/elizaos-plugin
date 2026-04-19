import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import { ColonyClient } from "@thecolony/sdk";
import { loadColonyConfig, type ColonyConfig } from "../environment.js";
import { ColonyInteractionClient } from "./interaction.js";
import { ColonyPostClient } from "./post-client.js";
import { ColonyEngagementClient } from "./engagement-client.js";
import { checkOllamaReadiness, validateCharacter } from "../utils/readiness.js";
import { DraftQueue } from "./draft-queue.js";
import { DiversityWatchdog } from "./diversity-watchdog.js";

/**
 * Why the service is currently paused. Surfaced in COLONY_STATUS so
 * operators can tell karma backoff from LLM health issues from a
 * diversity watchdog trip from an operator cooldown at a glance.
 */
export type PauseReason =
  | "karma_backoff"
  | "llm_health"
  | "semantic_repetition"
  | "operator_cooldown"
  | "operator_killswitch";

export interface ColonyServiceStats {
  postsCreated: number;
  commentsCreated: number;
  votesCast: number;
  selfCheckRejections: number;
  startedAt: number;
  /**
   * v0.14.0: per-source breakdown. Distinguishes "work the agent did on
   * its own" from "work the operator triggered." The totals above are
   * still the sum of these.
   */
  postsCreatedAutonomous: number;
  postsCreatedFromActions: number;
  commentsCreatedAutonomous: number;
  commentsCreatedFromActions: number;
  /**
   * v0.16.0: per-tick LLM provider health. Bumped from the generation
   * paths in post-client, engagement-client, and the dispatch reply
   * callback. Lets the operator see at a glance whether Ollama is
   * healthy ("34 successes / 0 failures in the last hour") or thrashing
   * ("12 successes / 18 failures — check your model endpoint"). Failures
   * include both thrown exceptions AND rejected model-error strings that
   * never made it past `validateGeneratedOutput`.
   */
  llmCallsSuccess: number;
  llmCallsFailed: number;
  /**
   * v0.22.0: notification-digest flushes. Incremented by the interaction
   * client each time it emits a coalesced summary memory (one per tick
   * that had at least one coalesce-policy notification). Surfaced in
   * COLONY_STATUS / COLONY_DIAGNOSTICS so operators can tell at a glance
   * how much inbox traffic the router is absorbing.
   */
  notificationDigestsEmitted: number;
}

export type StatSource = "autonomous" | "action";

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
    postsCreatedAutonomous: 0,
    postsCreatedFromActions: 0,
    commentsCreatedAutonomous: 0,
    commentsCreatedFromActions: 0,
    llmCallsSuccess: 0,
    llmCallsFailed: 0,
    notificationDigestsEmitted: 0,
  };

  /**
   * v0.16.0: bump the LLM-health counters from generation paths. Separate
   * helper so the call sites stay a one-liner and don't have to remember
   * the exact stat-key names.
   *
   * v0.17.0: also record each outcome with a timestamp into a rolling
   * ring (`llmCallHistory`) so the auto-pause logic can compute a
   * recent-window failure rate without rescanning anything. The ring is
   * pruned on each call — no background timer needed.
   */
  recordLlmCall(outcome: "success" | "failure"): void {
    if (outcome === "success") {
      this.stats = { ...this.stats, llmCallsSuccess: this.stats.llmCallsSuccess + 1 };
    } else {
      this.stats = { ...this.stats, llmCallsFailed: this.stats.llmCallsFailed + 1 };
    }
    const now = Date.now();
    const windowMs = this.colonyConfig
      ? this.colonyConfig.llmFailureWindowMs
      : 10 * 60_000;
    this.llmCallHistory = [
      ...this.llmCallHistory.filter((e) => e.ts > now - windowMs),
      { ts: now, outcome },
    ];
    this.maybeTriggerLlmHealthPause(now);
  }

  /**
   * v0.17.0: if the failure rate in the recent window exceeds the
   * configured threshold, pause autonomous loops for the cooldown
   * duration. Shares `pausedUntilTs` with the karma-backoff pause so
   * operators only have one "am I paused?" check.
   *
   * Disabled when `llmFailureThreshold <= 0` (default). Requires at
   * least 3 samples in the window to avoid flapping on small-sample
   * noise (e.g. 1 failure → 100% rate).
   */
  private maybeTriggerLlmHealthPause(now: number): void {
    if (!this.colonyConfig) return;
    const { llmFailureThreshold: threshold, llmFailureCooldownMs: cooldownMs, llmFailureWindowMs: windowMs } = this.colonyConfig;
    if (threshold <= 0) return;
    const recent = this.llmCallHistory;
    if (recent.length < 3) return;
    const failed = recent.filter((e) => e.outcome === "failure").length;
    const rate = failed / recent.length;
    if (rate >= threshold && this.pausedUntilTs <= now) {
      this.pauseForReason(
        cooldownMs,
        "llm_health",
        `${failed}/${recent.length} failed (${Math.round(rate * 100)}% ≥ threshold ${Math.round(threshold * 100)}%)`,
      );
      logger.warn(
        `⏸️  COLONY_SERVICE: LLM-health auto-pause — ${failed}/${recent.length} calls failed (${Math.round(rate * 100)}%) in last ${Math.round(
          windowMs / 60_000,
        )}min window. Pausing autonomy for ${Math.round(cooldownMs / 60_000)}min.`,
      );
    }
  }

  public llmCallHistory: Array<{ ts: number; outcome: "success" | "failure" }> = [];

  /**
   * v0.23.0: graded poll-interval multiplier derived from the v0.17
   * sliding LLM-call window. Complements (doesn't replace) the binary
   * `maybeTriggerLlmHealthPause` — instead of jumping straight from 1×
   * to paused, we can ramp the poll rate down as failure rate climbs.
   * Only the `ColonyInteractionClient` consumes this; post-client and
   * engagement-client continue to use their own interval math.
   *
   * Returns `1.0` when:
   *   - `adaptivePollEnabled` is false (opt-in feature)
   *   - fewer than 3 samples in the recent window (small-sample guard,
   *     mirrors `maybeTriggerLlmHealthPause`)
   *   - failure rate is below `adaptivePollWarnThreshold`
   *
   * Otherwise scales linearly from 1.0 at `warnThreshold` to
   * `adaptivePollMaxMultiplier` at rate=1.0.
   */
  computeLlmHealthMultiplier(now: number = Date.now()): number {
    if (!this.colonyConfig?.adaptivePollEnabled) return 1.0;
    const windowMs = this.colonyConfig.llmFailureWindowMs;
    const recent = this.llmCallHistory.filter((e) => e.ts > now - windowMs);
    if (recent.length < 3) return 1.0;
    const failed = recent.filter((e) => e.outcome === "failure").length;
    const rate = failed / recent.length;
    const warn = this.colonyConfig.adaptivePollWarnThreshold;
    if (rate <= warn) return 1.0;
    const max = this.colonyConfig.adaptivePollMaxMultiplier;
    // Avoid division by zero when warn=0.99 and rate=1.0 is the only
    // trigger — treat the range (warn, 1.0] as spanning the full scale.
    const span = 1.0 - warn;
    const fraction = span > 0 ? (rate - warn) / span : 1.0;
    const clampedFraction = Math.max(0, Math.min(1, fraction));
    return 1.0 + (max - 1.0) * clampedFraction;
  }

  public karmaHistory: KarmaSnapshot[] = [];
  public pausedUntilTs = 0;
  public pauseReason: PauseReason | null = null;
  public activityLog: ActivityEntry[] = [];
  public draftQueue: DraftQueue | null = null;
  public diversityWatchdog: DiversityWatchdog | null = null;
  private signalHandlersRegistered: Array<{ sig: NodeJS.Signals; handler: () => void }> = [];

  /**
   * v0.19.0: canonical pause primitive. All the existing pause paths
   * (karma backoff, LLM health, operator cooldown) used to mutate
   * `pausedUntilTs` directly, which meant the status output couldn't
   * tell them apart. Route everything through here going forward so
   * the reason survives. Returns the effective `pausedUntilTs` — may
   * be a pre-existing later pause that this call didn't shorten.
   */
  pauseForReason(durationMs: number, reason: PauseReason, detail?: string): number {
    const now = Date.now();
    const requested = now + Math.max(0, durationMs);
    if (requested <= this.pausedUntilTs) return this.pausedUntilTs;
    this.pausedUntilTs = requested;
    this.pauseReason = reason;
    this.recordActivity(
      "backoff_triggered",
      undefined,
      detail ? `${reason}: ${detail}` : reason,
    );
    return this.pausedUntilTs;
  }

  /**
   * v0.19.0: record a just-generated autonomous post body against the
   * diversity watchdog. Trips the semantic-repetition pause when the
   * last N outputs cluster above threshold. Safe to call even when
   * the watchdog is disabled (`diversityThreshold === 0`).
   */
  recordGeneratedOutput(text: string): void {
    if (!this.diversityWatchdog) return;
    const tripped = this.diversityWatchdog.record(text);
    if (!tripped) return;
    const peak = this.diversityWatchdog.peakSimilarity();
    this.diversityWatchdog.reset();
    const cooldownMs = this.colonyConfig.diversityCooldownMs;
    this.pauseForReason(
      cooldownMs,
      "semantic_repetition",
      `last ${this.colonyConfig.diversityWindowSize} outputs ≥${Math.round(this.colonyConfig.diversityThreshold * 100)}% similar (peak ${Math.round(peak * 100)}%)`,
    );
    logger.warn(
      `⏸️  COLONY_SERVICE: diversity watchdog tripped — pausing autonomous posting for ${Math.round(cooldownMs / 60_000)}min (peak similarity ${Math.round(peak * 100)}%)`,
    );
  }

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
      this.pauseForReason(
        this.colonyConfig.karmaBackoffCooldownMs,
        "karma_backoff",
        `karma ${max}→${latest} (−${drop}) in ${Math.round(this.colonyConfig.karmaBackoffWindowMs / 3600_000)}h`,
      );
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
      this.pauseReason = null;
      logger.info("▶️  COLONY_SERVICE: pause elapsed, resuming");
    }
    return now < this.pausedUntilTs;
  }

  incrementStat<K extends keyof ColonyServiceStats>(key: K, source?: StatSource): void {
    if (key === "startedAt") return;
    const patch: Partial<ColonyServiceStats> = {
      [key]: (this.stats[key] as number) + 1,
    };
    // v0.14.0: when a source is provided on a posts/comments event, bump
    // the corresponding autonomous/action sub-counter.
    if (source && (key === "postsCreated" || key === "commentsCreated")) {
      const subKey = `${key}${source === "autonomous" ? "Autonomous" : "FromActions"}` as keyof ColonyServiceStats;
      patch[subKey] = (this.stats[subKey] as number) + 1;
    }
    this.stats = { ...this.stats, ...patch };
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
    const detail = reason
      ? `${reason} for ${Math.round(durationMs / 60_000)}min`
      : `for ${Math.round(durationMs / 60_000)}min`;
    const ts = this.pauseForReason(durationMs, "operator_cooldown", detail);
    if (ts > 0) {
      logger.info(
        `⏸️  COLONY_SERVICE: operator cooldown until ${new Date(ts).toISOString()}${reason ? ` (${reason})` : ""}`,
      );
    }
    return ts;
  }

  /**
   * Register process-level SIGTERM / SIGINT handlers that stop the service
   * on shutdown signals. Opt-in to avoid stepping on host shutdown logic.
   *
   * v0.23.0: also registers SIGUSR1 as an "engagement nudge" — when the
   * operator sends `kill -USR1 $PID`, the engagement client runs one
   * tick immediately out-of-band from its interval timer. Local-only
   * control surface (signals can't cross machines), so no new network
   * attack surface is introduced.
   */
  registerShutdownHandlers(): void {
    if (this.signalHandlersRegistered.length) return;
    const shutdownSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
    for (const sig of shutdownSignals) {
      const handler = this.makeShutdownHandler(sig);
      process.on(sig, handler);
      this.signalHandlersRegistered.push({ sig, handler });
    }
    // v0.23.0: engagement nudge signal. Kept separate from the
    // shutdown loop so the handler body is clearly distinct.
    const engageNudgeSig: NodeJS.Signals = "SIGUSR1";
    const engageNudgeHandler = this.makeEngagementNudgeHandler();
    process.on(engageNudgeSig, engageNudgeHandler);
    this.signalHandlersRegistered.push({ sig: engageNudgeSig, handler: engageNudgeHandler });
    // v0.24.0: post-client nudge signal. Symmetric with the v0.23.0
    // engagement nudge — `kill -USR2 $PID` triggers one post-client
    // tick immediately, out-of-band from its interval timer.
    const postNudgeSig: NodeJS.Signals = "SIGUSR2";
    const postNudgeHandler = this.makePostNudgeHandler();
    process.on(postNudgeSig, postNudgeHandler);
    this.signalHandlersRegistered.push({ sig: postNudgeSig, handler: postNudgeHandler });
  }

  private makeShutdownHandler(sig: NodeJS.Signals): () => void {
    return () => {
      logger.info(`⏹️  COLONY_SERVICE: received ${sig}, stopping clients`);
      void this.stop();
    };
  }

  /**
   * v0.23.0: handler for SIGUSR1 — triggers one engagement-client tick
   * out-of-band. Called via `kill -USR1 $(cat .agent.pid)`. Non-fatal
   * if the engagement client isn't running (e.g. `COLONY_ENGAGE_ENABLED=false`);
   * the handler just logs and returns.
   */
  private makeEngagementNudgeHandler(): () => void {
    return () => {
      if (!this.engagementClient) {
        logger.info(
          "🔔 COLONY_SERVICE: SIGUSR1 received but engagement client isn't running — ignoring",
        );
        return;
      }
      logger.info("🔔 COLONY_SERVICE: SIGUSR1 received — triggering engagement tick");
      // tickNow() already catches and logs internally; no extra .catch
      // needed here.
      void this.engagementClient.tickNow();
    };
  }

  /**
   * v0.24.0: handler for SIGUSR2 — triggers one post-client tick
   * out-of-band. Called via `kill -USR2 $(cat .agent.pid)`. Mirrors
   * the v0.23 engagement nudge. Non-fatal if the post client isn't
   * running (e.g. `COLONY_POST_ENABLED=false`); the handler just logs
   * and returns.
   */
  private makePostNudgeHandler(): () => void {
    return () => {
      if (!this.postClient) {
        logger.info(
          "📝 COLONY_SERVICE: SIGUSR2 received but post client isn't running — ignoring",
        );
        return;
      }
      logger.info("📝 COLONY_SERVICE: SIGUSR2 received — triggering post tick");
      void this.postClient.tickNow();
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

    if (service.colonyConfig.postApprovalRequired) {
      service.draftQueue = new DraftQueue(
        runtime,
        service.username ?? "unknown",
        { maxAgeMs: 24 * 3600 * 1000, maxPending: 50 },
      );
    }

    // v0.19.0: content-diversity watchdog. Disabled when threshold is 0.
    // Only the post loop feeds it — engagement outputs are naturally
    // diverse (different posts → different replies) and would false-
    // positive on a topic cluster.
    if (service.colonyConfig.diversityThreshold > 0) {
      service.diversityWatchdog = new DiversityWatchdog({
        ngram: service.colonyConfig.diversityNgram,
        windowSize: service.colonyConfig.diversityWindowSize,
        threshold: service.colonyConfig.diversityThreshold,
      });
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
        approvalRequired: service.colonyConfig.postApprovalRequired,
        draftQueue: service.draftQueue ?? undefined,
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
        followWeight: service.colonyConfig.engageFollowWeight,
        preferredAuthors: service.colonyConfig.engagePreferredAuthors,
        approvalRequired: service.colonyConfig.postApprovalRequired,
        draftQueue: service.draftQueue ?? undefined,
        lengthTarget: service.colonyConfig.engageLengthTarget,
        useRising: service.colonyConfig.engageUseRising,
        trendingBoost: service.colonyConfig.engageTrendingBoost,
        trendingRefreshMs: service.colonyConfig.engageTrendingRefreshMs,
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
