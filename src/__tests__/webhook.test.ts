import { describe, expect, it, vi, beforeEach } from "vitest";
import { fakeService, type FakeService } from "./helpers.js";
import type { IAgentRuntime, Memory } from "@elizaos/core";

const { verifyAndParseWebhookMock } = vi.hoisted(() => ({
  verifyAndParseWebhookMock: vi.fn(),
}));

vi.mock("@thecolony/sdk", () => ({
  verifyAndParseWebhook: verifyAndParseWebhookMock,
}));

import { verifyAndDispatchWebhook } from "../services/webhook.js";

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

describe("verifyAndDispatchWebhook", () => {
  let service: FakeService;
  let runtime: MockRuntime;

  beforeEach(() => {
    service = fakeService();
    runtime = mockRuntime();
    verifyAndParseWebhookMock.mockReset();
  });

  it("rejects missing signature", async () => {
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      null,
      "secret",
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing signature");
  });

  it("rejects empty signature", async () => {
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      "",
      "secret",
    );
    expect(res.ok).toBe(false);
  });

  it("rejects failed signature verification", async () => {
    verifyAndParseWebhookMock.mockRejectedValue(new Error("hmac mismatch"));
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      "sig",
      "secret",
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("hmac mismatch");
  });

  it("handles a non-Error verification failure", async () => {
    verifyAndParseWebhookMock.mockRejectedValue("plain string");
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      "sig",
      "secret",
    );
    expect(res.ok).toBe(false);
  });

  describe("mention event", () => {
    it("dispatches a mention with post lookup", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "mention",
        delivery_id: "d-1",
        payload: {
          id: "notif-1",
          post_id: "post-1",
          created_at: "2026-04-15T18:00:00Z",
        },
      });
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "Hello",
        body: "World",
        author: { username: "alice" },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(true);
      expect(res.event).toBe("mention");
      expect(res.deliveryId).toBe("d-1");
      expect(runtime.messageService!.handleMessage).toHaveBeenCalled();
    });

    it("skips mention without post_id", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "mention",
        payload: { id: "notif-1", post_id: null },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(false);
      expect(service.client.getPost).not.toHaveBeenCalled();
    });

    it("skips already-processed mentions via dedup", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "mention",
        payload: { id: "notif-1", post_id: "post-1" },
      });
      runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(false);
      expect(service.client.getPost).not.toHaveBeenCalled();
    });

    it("reports failure when getPost throws", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "mention",
        payload: { id: "notif-1", post_id: "post-1" },
      });
      service.client.getPost.mockRejectedValue(new Error("not found"));
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not found");
    });

    it("handles mention with bare-minimum post (no title/body/author)", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "mention",
        payload: { id: "notif-bare", post_id: "post-bare" },
      });
      service.client.getPost.mockResolvedValue({ id: "post-bare" });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });
  });

  describe("comment_created event", () => {
    it("dispatches a comment as a post mention with thread context", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "new comment body",
          author: { username: "bob" },
          created_at: "2026-04-15T18:00:00Z",
        },
      });
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "Original",
        body: "Original body",
        author: { username: "alice" },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(true);
      expect(service.client.getPost).toHaveBeenCalledWith("post-1");
    });

    it("skips comment without post_id", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: { id: "comment-1", post_id: null },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
    });

    it("skips comments authored by the agent itself", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "self",
          author: { username: "eliza-test" },
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
      expect(service.client.getPost).not.toHaveBeenCalled();
    });

    it("dispatches when service has no username (no self filter)", async () => {
      service.username = undefined;
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "hi",
          author: { username: "bob" },
        },
      });
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });

    it("skips already-processed comments via dedup", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "hi",
          author: { username: "bob" },
        },
      });
      runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
      expect(service.client.getPost).not.toHaveBeenCalled();
    });

    it("reports failure when getPost throws", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "hi",
          author: { username: "bob" },
        },
      });
      service.client.getPost.mockRejectedValue(new Error("api-down"));
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(false);
    });

    it("handles comment with undefined author username", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: {
          id: "comment-1",
          post_id: "post-1",
          body: "hi",
          author: {},
        },
      });
      service.client.getPost.mockResolvedValue({
        id: "post-1",
        title: "T",
        body: "B",
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });

    it("handles bare-minimum comment + post (no body/author fields)", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "comment_created",
        payload: { id: "c-bare", post_id: "p-bare" },
      });
      service.client.getPost.mockResolvedValue({ id: "p-bare" });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });
  });

  describe("direct_message event", () => {
    it("dispatches a DM", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-1",
          conversation_id: "conv-1",
          sender: { username: "alice" },
          body: "hello",
          created_at: "2026-04-15T18:00:00Z",
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.ok).toBe(true);
      expect(res.dispatched).toBe(true);
      expect(runtime.createMemory).toHaveBeenCalled();
    });

    it("skips DM with no sender username", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: { id: "msg-1", sender: {} },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
    });

    it("skips DM from the agent itself", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-1",
          sender: { username: "eliza-test" },
          body: "self",
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
    });

    it("dispatches DM when service has no username (no self filter)", async () => {
      service.username = undefined;
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-1",
          sender: { username: "alice" },
          body: "hi",
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });

    it("skips already-processed DMs via dedup", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-1",
          sender: { username: "alice" },
          body: "hi",
        },
      });
      runtime.getMemoryById = vi.fn(async () => ({ id: "x" }) as unknown as Memory);
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(false);
    });

    it("handles DM with no body", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-empty",
          sender: { username: "alice" },
          conversation_id: "conv-1",
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
    });

    it("handles DM without conversation_id (falls back to dm-{sender})", async () => {
      verifyAndParseWebhookMock.mockResolvedValue({
        event: "direct_message",
        payload: {
          id: "msg-1",
          sender: { username: "alice" },
          body: "hi",
        },
      });
      const res = await verifyAndDispatchWebhook(
        service as never,
        runtime,
        "{}",
        "sig",
        "secret",
      );
      expect(res.dispatched).toBe(true);
      expect(runtime.ensureRoomExists).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "dm-alice" }),
      );
    });
  });

  it("accepts informational events without dispatching", async () => {
    verifyAndParseWebhookMock.mockResolvedValue({
      event: "post_created",
      delivery_id: "d-99",
      payload: { id: "post-1" },
    });
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      "sig",
      "secret",
    );
    expect(res.ok).toBe(true);
    expect(res.dispatched).toBe(false);
    expect(res.event).toBe("post_created");
    expect(res.deliveryId).toBe("d-99");
  });

  it("handles informational events without a delivery_id", async () => {
    verifyAndParseWebhookMock.mockResolvedValue({
      event: "bid_received",
      payload: {},
    });
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      "{}",
      "sig",
      "secret",
    );
    expect(res.ok).toBe(true);
    expect(res.dispatched).toBe(false);
  });

  it("accepts a Uint8Array rawBody", async () => {
    verifyAndParseWebhookMock.mockResolvedValue({
      event: "post_created",
      payload: { id: "p1" },
    });
    const bytes = new TextEncoder().encode('{"event":"post_created"}');
    const res = await verifyAndDispatchWebhook(
      service as never,
      runtime,
      bytes,
      "sig",
      "secret",
    );
    expect(res.ok).toBe(true);
  });
});
