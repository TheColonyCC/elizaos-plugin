import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  dispatchDirectMessage,
  dispatchPostMention,
  isDuplicateMemoryId,
} from "../services/dispatch.js";
import { fakeService, type FakeService } from "./helpers.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

interface MockRuntime extends IAgentRuntime {
  agentId: string;
  getMemoryById: ReturnType<typeof vi.fn>;
  ensureWorldExists: ReturnType<typeof vi.fn>;
  ensureConnection: ReturnType<typeof vi.fn>;
  ensureRoomExists: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  messageService: {
    handleMessage: ReturnType<typeof vi.fn>;
  } | null;
}

function mockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getMemoryById: vi.fn(async () => null),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    messageService: {
      handleMessage: vi.fn(async () => ({})),
    },
    ...overrides,
  } as unknown as MockRuntime;
}

describe("isDuplicateMemoryId", () => {
  it("returns false when runtime has no getMemoryById", async () => {
    const rt = {} as IAgentRuntime;
    expect(await isDuplicateMemoryId(rt, "key")).toBe(false);
  });

  it("returns false when memory is not found", async () => {
    const rt = mockRuntime();
    expect(await isDuplicateMemoryId(rt, "key")).toBe(false);
  });

  it("returns true when memory is found", async () => {
    const rt = mockRuntime({
      getMemoryById: vi.fn(async () => ({ id: "x" }) as unknown as Memory),
    });
    expect(await isDuplicateMemoryId(rt, "key")).toBe(true);
  });
});

describe("dispatchPostMention — internal dedup", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("returns false when an existing memory is found", async () => {
    runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
    const result = await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "dup",
      postId: "p-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    expect(result).toBe(false);
    expect(runtime.ensureWorldExists).not.toHaveBeenCalled();
  });

  it("works without a runtime.getMemoryById", async () => {
    const rt = mockRuntime({ getMemoryById: undefined as unknown as MockRuntime["getMemoryById"] });
    const result = await dispatchPostMention(service as never, rt, {
      memoryIdKey: "new",
      postId: "p-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "alice",
    });
    expect(result).toBe(true);
  });
});

describe("dispatchDirectMessage — internal dedup", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
  });

  it("returns false when an existing memory is found", async () => {
    runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
    const result = await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "dup",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(result).toBe(false);
  });

  it("works without a runtime.getMemoryById", async () => {
    const rt = mockRuntime({ getMemoryById: undefined as unknown as MockRuntime["getMemoryById"] });
    const result = await dispatchDirectMessage(service as never, rt, {
      memoryIdKey: "new",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(result).toBe(true);
  });

  it("handleMessage callback with reply text sends DM and returns memory", async () => {
    service.client.sendMessage.mockResolvedValue({ id: "sent-1" });
    runtime.messageService!.handleMessage = vi.fn(async (_rt, _msg, cb) => {
      if (cb) {
        const memories = await cb({ text: "reply" });
        expect(memories.length).toBe(1);
      }
      return {};
    });
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "fresh",
      senderUsername: "alice",
      messageId: "m-1",
      body: "hi",
      conversationId: "c-1",
    });
    expect(service.client.sendMessage).toHaveBeenCalledWith("alice", "reply");
  });
});
