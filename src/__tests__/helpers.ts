import { vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

export interface FakeClient {
  getMe: ReturnType<typeof vi.fn>;
  createPost: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  votePost: ReturnType<typeof vi.fn>;
  voteComment: ReturnType<typeof vi.fn>;
  getPosts: ReturnType<typeof vi.fn>;
  getPost: ReturnType<typeof vi.fn>;
  getNotifications: ReturnType<typeof vi.fn>;
  markNotificationRead: ReturnType<typeof vi.fn>;
  listConversations: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  reactPost: ReturnType<typeof vi.fn>;
  reactComment: ReturnType<typeof vi.fn>;
  follow: ReturnType<typeof vi.fn>;
  unfollow: ReturnType<typeof vi.fn>;
  directory: ReturnType<typeof vi.fn>;
}

export function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getMe: vi.fn(),
    createPost: vi.fn(),
    createComment: vi.fn(),
    sendMessage: vi.fn(),
    votePost: vi.fn(),
    voteComment: vi.fn(),
    getPosts: vi.fn(),
    getPost: vi.fn(),
    getNotifications: vi.fn(async () => []),
    markNotificationRead: vi.fn(async () => undefined),
    listConversations: vi.fn(async () => []),
    getConversation: vi.fn(),
    search: vi.fn(),
    reactPost: vi.fn(),
    reactComment: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn(),
    directory: vi.fn(),
    ...overrides,
  };
}

export interface FakeService {
  client: FakeClient;
  username?: string;
  colonyConfig: {
    apiKey: string;
    defaultColony: string;
    feedLimit: number;
    pollEnabled: boolean;
    pollIntervalMs: number;
    coldStartWindowMs: number;
    notificationTypesIgnore: Set<string>;
    postEnabled: boolean;
    postIntervalMinMs: number;
    postIntervalMaxMs: number;
    postColony: string;
    postMaxTokens: number;
    postTemperature: number;
    engageEnabled: boolean;
    engageIntervalMinMs: number;
    engageIntervalMaxMs: number;
    engageColonies: string[];
    engageCandidateLimit: number;
    engageMaxTokens: number;
    engageTemperature: number;
    dryRun?: boolean;
    postStyleHint?: string;
    postRecentTopicMemory?: boolean;
    engageStyleHint?: string;
    selfCheckEnabled?: boolean;
    postDailyLimit?: number;
    karmaBackoffDrop?: number;
    karmaBackoffWindowMs?: number;
    karmaBackoffCooldownMs?: number;
    engageThreadComments?: number;
    engageRequireTopicMatch?: boolean;
    mentionMinKarma?: number;
    postDefaultType?: string;
    mentionThreadComments?: number;
    bannedPatterns?: RegExp[];
    postModelType?: string;
    engageModelType?: string;
    scorerModelType?: string;
    registerSignalHandlers?: boolean;
    logFormat?: "text" | "json";
    retryQueueEnabled?: boolean;
    retryQueueMaxAttempts?: number;
    retryQueueMaxAgeMs?: number;
    engageReactionMode?: boolean;
    autoRotateKey?: boolean;
    selfCheckRetry?: boolean;
    activityWebhookUrl?: string;
    activityWebhookSecret?: string;
    engageFollowWeight?: "off" | "soft" | "strict";
    engagePreferredAuthors?: string[];
    postApprovalRequired?: boolean;
    postQuietHours?: { startHour: number; endHour: number } | null;
    engageQuietHours?: { startHour: number; endHour: number } | null;
    llmFailureThreshold?: number;
    llmFailureWindowMs?: number;
    llmFailureCooldownMs?: number;
    reactionAuthorLimit?: number;
    reactionAuthorWindowMs?: number;
  };
  draftQueue?: unknown;
  cooldown?: ReturnType<typeof vi.fn>;
  rotateApiKey?: ReturnType<typeof vi.fn>;
  refreshKarmaWithAutoRotate?: ReturnType<typeof vi.fn>;
  incrementStat?: ReturnType<typeof vi.fn>;
  recordActivity?: ReturnType<typeof vi.fn>;
  refreshKarma?: ReturnType<typeof vi.fn>;
  maybeRefreshKarma?: ReturnType<typeof vi.fn>;
  isPausedForBackoff?: ReturnType<typeof vi.fn>;
  activityLog?: Array<{ ts: number; type: string; target?: string; detail?: string }>;
  stats?: {
    postsCreated: number;
    commentsCreated: number;
    votesCast: number;
    selfCheckRejections: number;
    startedAt: number;
    postsCreatedAutonomous?: number;
    postsCreatedFromActions?: number;
    commentsCreatedAutonomous?: number;
    commentsCreatedFromActions?: number;
    llmCallsSuccess?: number;
    llmCallsFailed?: number;
  };
  recordLlmCall?: ReturnType<typeof vi.fn>;
  pausedUntilTs?: number;
  karmaHistory?: Array<{ ts: number; karma: number }>;
  currentKarma?: number;
  currentTrust?: string;
  interactionClient?: unknown;
  postClient?: unknown;
  engagementClient?: unknown;
}

export function fakeService(
  clientOverrides: Partial<FakeClient> = {},
  configOverrides: Partial<FakeService["colonyConfig"]> = {},
): FakeService {
  return {
    client: fakeClient(clientOverrides),
    username: "eliza-test",
    colonyConfig: {
      apiKey: "col_test",
      defaultColony: "general",
      feedLimit: 10,
      pollEnabled: false,
      pollIntervalMs: 120_000,
      coldStartWindowMs: 0,
      notificationTypesIgnore: new Set<string>(),
      postEnabled: false,
      postIntervalMinMs: 5_400_000,
      postIntervalMaxMs: 10_800_000,
      postColony: "general",
      postMaxTokens: 280,
      postTemperature: 0.9,
      engageEnabled: false,
      engageIntervalMinMs: 1_800_000,
      engageIntervalMaxMs: 3_600_000,
      engageColonies: ["general"],
      engageCandidateLimit: 5,
      engageMaxTokens: 240,
      engageTemperature: 0.8,
      dryRun: false,
      postStyleHint: "",
      postRecentTopicMemory: true,
      engageStyleHint: "",
      selfCheckEnabled: false,
      postDailyLimit: 24,
      karmaBackoffDrop: 10,
      karmaBackoffWindowMs: 6 * 3600 * 1000,
      karmaBackoffCooldownMs: 120 * 60 * 1000,
      engageThreadComments: 3,
      engageRequireTopicMatch: false,
      mentionMinKarma: 0,
      postDefaultType: "discussion",
      mentionThreadComments: 3,
      bannedPatterns: [] as RegExp[],
      postModelType: "TEXT_SMALL",
      engageModelType: "TEXT_SMALL",
      scorerModelType: "TEXT_SMALL",
      registerSignalHandlers: false,
      logFormat: "text" as "text" | "json",
      retryQueueEnabled: false,
      retryQueueMaxAttempts: 3,
      retryQueueMaxAgeMs: 60 * 60 * 1000,
      engageReactionMode: false,
      autoRotateKey: false,
      selfCheckRetry: false,
      activityWebhookUrl: "",
      activityWebhookSecret: "",
      engageFollowWeight: "off" as "off" | "soft" | "strict",
      engagePreferredAuthors: [] as string[],
      postApprovalRequired: false,
      postQuietHours: null as { startHour: number; endHour: number } | null,
      engageQuietHours: null as { startHour: number; endHour: number } | null,
      llmFailureThreshold: 0,
      llmFailureWindowMs: 10 * 60_000,
      llmFailureCooldownMs: 30 * 60_000,
      reactionAuthorLimit: 3,
      reactionAuthorWindowMs: 2 * 3600_000,
      ...configOverrides,
    },
    cooldown: vi.fn((ms: number) => Date.now() + ms),
    rotateApiKey: vi.fn(async () => null),
    refreshKarmaWithAutoRotate: vi.fn(async () => null),
    incrementStat: vi.fn(),
    recordActivity: vi.fn(),
    refreshKarma: vi.fn(async () => null),
    maybeRefreshKarma: vi.fn(async () => undefined),
    isPausedForBackoff: vi.fn(() => false),
    activityLog: [],
    stats: {
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
    },
    recordLlmCall: vi.fn(),
    pausedUntilTs: 0,
    karmaHistory: [],
    currentKarma: 0,
    currentTrust: "Newcomer",
    interactionClient: null,
    postClient: null,
    engagementClient: null,
    draftQueue: null,
  };
}

export interface FakeRuntime extends IAgentRuntime {
  _settings: Record<string, string | number | boolean>;
  _services: Map<string, unknown>;
}

export function fakeRuntime(
  service: FakeService | null,
  settings: Record<string, string | number | boolean> = {},
): IAgentRuntime {
  const services = new Map<string, unknown>();
  if (service) services.set("colony", service);
  return {
    getService: vi.fn((name: string) => services.get(name) ?? null),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    _settings: settings,
    _services: services,
  } as unknown as IAgentRuntime;
}

export function fakeMessage(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

export function messageWithoutText(): Memory {
  return { content: {} } as unknown as Memory;
}

export function fakeState(): State {
  return {} as State;
}

export function makeCallback() {
  const fn = vi.fn(async () => []);
  return fn;
}
