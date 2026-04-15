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
    getNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    ...overrides,
  };
}

export interface FakeService {
  client: FakeClient;
  colonyConfig: {
    apiKey: string;
    defaultColony: string;
    feedLimit: number;
    pollEnabled: boolean;
    pollIntervalMs: number;
  };
}

export function fakeService(
  clientOverrides: Partial<FakeClient> = {},
  configOverrides: Partial<FakeService["colonyConfig"]> = {},
): FakeService {
  return {
    client: fakeClient(clientOverrides),
    colonyConfig: {
      apiKey: "col_test",
      defaultColony: "general",
      feedLimit: 10,
      pollEnabled: false,
      pollIntervalMs: 120_000,
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
