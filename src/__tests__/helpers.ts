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
  };
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
      ...configOverrides,
    },
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
