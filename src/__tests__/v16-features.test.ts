/**
 * Consolidated tests for v0.16.0 features: model-error output filter,
 * LLM-artifact stripping, pre-tick Ollama reachability probe, and the
 * LLM-provider health counters (plus their surfacing via COLONY_STATUS
 * and COLONY_DIAGNOSTICS).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  type FakeService,
} from "./helpers.js";
import {
  looksLikeModelError,
  stripLLMArtifacts,
  validateGeneratedOutput,
} from "../services/output-validator.js";
import { isOllamaReachable } from "../utils/readiness.js";
import { ColonyPostClient } from "../services/post-client.js";
import { ColonyEngagementClient } from "../services/engagement-client.js";
import { dispatchPostMention, dispatchDirectMessage } from "../services/dispatch.js";
import { colonyStatusAction } from "../actions/status.js";
import { colonyDiagnosticsAction } from "../actions/diagnostics.js";

// ──────────────────────────────────────────────────────────────────────
// looksLikeModelError
// ──────────────────────────────────────────────────────────────────────
describe("looksLikeModelError (v0.16.0)", () => {
  it("catches the exact real-incident string", () => {
    expect(
      looksLikeModelError("Error generating text. Please try again later."),
    ).toBe(true);
  });

  it("catches common Ollama / llama.cpp error variants", () => {
    const cases = [
      "Error generating response",
      "Error generating content",
      "An error occurred",
      "Internal error",
      "Failed to generate",
      "Could not generate output",
      "Couldn't generate response",
      "Unable to connect to Ollama",
      "Unable to reach the model server",
      "The model is unavailable",
      "Model is down",
      "Please try again later",
      "Request timed out",
      "Rate limit exceeded",
      "Service unavailable",
      "Timeout",
      "[error]: could not decode",
    ];
    for (const s of cases) {
      expect(looksLikeModelError(s), `expected '${s}' to match`).toBe(true);
    }
  });

  it("catches apology-style model errors", () => {
    expect(looksLikeModelError("I apologize, but I cannot do that.")).toBe(true);
    expect(looksLikeModelError("I'm sorry, but an error occurred.")).toBe(true);
  });

  it("does not flag legitimate content even if it mentions errors", () => {
    const legit = [
      "Today I want to talk about error handling in distributed systems. Error recovery...",
      "Here's my take on rate limiting: good defaults matter more than clever algorithms.",
      "Shipping announcement: the new scoring pipeline is live.",
    ];
    for (const s of legit) {
      expect(looksLikeModelError(s), `expected '${s}' NOT to match`).toBe(false);
    }
  });

  it("refuses to flag long outputs even if they contain a matching substring", () => {
    // A 501-char post that happens to start with "Timeout" — over the 500-char
    // ceiling, so we trust it. (Rare case, but the guardrail means false
    // positives drop real content less often.)
    const long = "Timeout: " + "x".repeat(495);
    expect(long.length).toBeGreaterThan(500);
    expect(looksLikeModelError(long)).toBe(false);
  });

  it("handles empty and whitespace-only input", () => {
    expect(looksLikeModelError("")).toBe(false);
    expect(looksLikeModelError("   \n  ")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// stripLLMArtifacts
// ──────────────────────────────────────────────────────────────────────
describe("stripLLMArtifacts (v0.16.0)", () => {
  it("strips <s> / </s> tokens anywhere", () => {
    expect(stripLLMArtifacts("<s>hello</s>")).toBe("hello");
    expect(stripLLMArtifacts("hi <s>there</s>")).toBe("hi there");
  });

  it("strips [INST] / [/INST] / [SYS] wrappers", () => {
    expect(stripLLMArtifacts("[INST]body[/INST]")).toBe("body");
    expect(stripLLMArtifacts("[SYSTEM]foo[/SYSTEM] bar")).toBe("foo bar");
  });

  it("strips chat-template |im_start|-style tokens", () => {
    expect(stripLLMArtifacts("<|im_start|>content<|im_end|>")).toBe("content");
  });

  it("strips a leading 'Assistant:' role prefix", () => {
    expect(stripLLMArtifacts("Assistant: the reply")).toBe("the reply");
    expect(stripLLMArtifacts("AI: another")).toBe("another");
    expect(stripLLMArtifacts("Gemma: hello")).toBe("hello");
  });

  it("strips meta-preambles like 'Sure, here's…'", () => {
    expect(stripLLMArtifacts("Sure, here's the post: actual content here")).toBe(
      "actual content here",
    );
    expect(stripLLMArtifacts("Okay, here is my reply: body text")).toBe(
      "body text",
    );
    expect(
      stripLLMArtifacts("Certainly! Here's a response for you: the body"),
    ).toBe("the body");
  });

  it("strips a bare 'Reply:' / 'Output:' label", () => {
    expect(stripLLMArtifacts("Reply: my reply body")).toBe("my reply body");
    expect(stripLLMArtifacts("Output: generated output here")).toBe(
      "generated output here",
    );
  });

  it("doesn't stack multiple preamble strips", () => {
    // Even if two preamble patterns overlap, stripLLMArtifacts only strips once.
    const out = stripLLMArtifacts(
      "Sure, here's the post: Reply: actually start here",
    );
    // First strip takes the 'Sure, here's the post:' prefix off.
    // Result keeps "Reply: actually start here" intact — we don't recurse.
    expect(out).toBe("Reply: actually start here");
  });

  it("leaves legitimate content alone", () => {
    const cases = [
      "A substantive post about rate limits",
      "Here is interesting data", // no colon → no preamble match
      "Let's discuss distributed consensus",
    ];
    for (const s of cases) {
      expect(stripLLMArtifacts(s), `expected '${s}' unchanged`).toBe(s);
    }
  });

  it("handles empty input", () => {
    expect(stripLLMArtifacts("")).toBe("");
    expect(stripLLMArtifacts("   ")).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────
// validateGeneratedOutput
// ──────────────────────────────────────────────────────────────────────
describe("validateGeneratedOutput (v0.16.0)", () => {
  it("returns ok:true with stripped content for good output", () => {
    const out = validateGeneratedOutput("Assistant: substantive reply");
    expect(out).toEqual({ ok: true, content: "substantive reply" });
  });

  it("returns model_error for an error string", () => {
    expect(
      validateGeneratedOutput("Error generating text. Please try again later."),
    ).toEqual({ ok: false, reason: "model_error" });
  });

  it("returns empty when stripping removes everything", () => {
    expect(validateGeneratedOutput("<s></s>")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("strips artifacts BEFORE model-error check, catching role-prefixed errors", () => {
    // If the provider echoes "Assistant: Error generating text", we strip
    // the prefix and then correctly identify the remainder as a model error.
    expect(
      validateGeneratedOutput("Assistant: Error generating text."),
    ).toEqual({ ok: false, reason: "model_error" });
  });
});

// ──────────────────────────────────────────────────────────────────────
// post-client integration: model-error reject + recordLlmCall
// ──────────────────────────────────────────────────────────────────────
describe("ColonyPostClient output gate (v0.16.0)", () => {
  let service: FakeService;
  const cfg = (overrides = {}) => ({
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colony: "general",
    maxTokens: 280,
    temperature: 0.9,
    selfCheck: false,
    dailyLimit: 0,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    service.client.createPost.mockResolvedValue({ id: "post-1" });
    service.recordLlmCall = vi.fn();
  });

  afterEach(() => vi.useRealTimers());

  function runtime(modelOutput: string | (() => string)): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () =>
        typeof modelOutput === "function" ? modelOutput() : modelOutput,
      ),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
  }

  it("drops an output matching the real-incident error string", async () => {
    const c = new ColonyPostClient(
      service as never,
      runtime("Error generating text. Please try again later."),
      cfg(),
    );
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createPost).not.toHaveBeenCalled();
    expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
    expect(service.recordLlmCall).toHaveBeenCalledWith("failure");
    await c.stop();
  });

  it("strips 'Assistant:' prefix and still posts a real reply", async () => {
    const rt = runtime("Assistant: Title: Real\n\nA real substantive body.");
    const c = new ColonyPostClient(service as never, rt, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createPost).toHaveBeenCalled();
    expect(service.recordLlmCall).toHaveBeenCalledWith("success");
    await c.stop();
  });

  it("records a failure when useModel itself throws", async () => {
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "n", bio: "b", topics: ["t"], style: {} },
      useModel: vi.fn(async () => {
        throw new Error("model down");
      }),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const c = new ColonyPostClient(service as never, rt, cfg());
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.recordLlmCall).toHaveBeenCalledWith("failure");
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// engagement-client integration
// ──────────────────────────────────────────────────────────────────────
describe("ColonyEngagementClient output gate (v0.16.0)", () => {
  let service: FakeService;
  const cfg = (overrides = {}) => ({
    intervalMinMs: 1000,
    intervalMaxMs: 2000,
    colonies: ["general"],
    candidateLimit: 5,
    maxTokens: 240,
    temperature: 0.8,
    selfCheck: false,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
    service.recordLlmCall = vi.fn();
    service.client.getPosts.mockResolvedValue({
      items: [
        {
          id: "post-x",
          title: "Hello",
          body: "body",
          author: { username: "other", user_type: "agent" },
        },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  function runtime(output: string): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => output),
      getCache: vi.fn(async () => []),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
  }

  it("drops model-error output and does NOT comment", async () => {
    const c = new ColonyEngagementClient(
      service as never,
      runtime("Error generating text. Please try again later."),
      cfg(),
    );
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
    expect(service.recordLlmCall).toHaveBeenCalledWith("failure");
    await c.stop();
  });

  it("strips an 'Assistant:' prefix and still comments", async () => {
    service.client.createComment.mockResolvedValue({ id: "c-1" });
    const c = new ColonyEngagementClient(
      service as never,
      runtime("Assistant: a real reply."),
      cfg(),
    );
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-x",
      "a real reply.",
      undefined,
    );
    expect(service.recordLlmCall).toHaveBeenCalledWith("success");
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// dispatch (reactive replies + DMs)
// ──────────────────────────────────────────────────────────────────────
describe("dispatch output gate (v0.16.0)", () => {
  function makeRuntime(reply: string, overrides: Record<string, unknown> = {}): IAgentRuntime {
    return {
      agentId: "agent-1",
      getMemoryById: vi.fn(async () => null),
      ensureWorldExists: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      ensureRoomExists: vi.fn(async () => undefined),
      createMemory: vi.fn(async () => undefined),
      messageService: {
        handleMessage: vi.fn(async (_r, _m, cb) => {
          await cb({ text: reply });
        }),
      },
      ...overrides,
    } as unknown as IAgentRuntime;
  }

  it("drops a post-mention reply that is a model error", async () => {
    const service = fakeService();
    service.client.createComment.mockResolvedValue({ id: "c-1" });
    const runtime = makeRuntime(
      "Error generating text. Please try again later.",
    );
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "k",
      postId: "post-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "u",
    });
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
  });

  it("strips an Assistant: prefix before posting a reactive reply", async () => {
    const service = fakeService();
    service.client.createComment.mockResolvedValue({ id: "c-1" });
    const runtime = makeRuntime("Assistant: real reply");
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "k2",
      postId: "post-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "u",
    });
    expect(service.client.createComment).toHaveBeenCalledWith(
      "post-1",
      "real reply",
      undefined,
    );
  });

  it("drops a DM reply that is a model error", async () => {
    const service = fakeService();
    (service.client as unknown as Record<string, unknown>).sendMessage = vi.fn(
      async () => ({ id: "m-1" }),
    );
    const runtime = makeRuntime(
      "Error generating text. Please try again later.",
    );
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "dm-k",
      senderUsername: "alice",
      messageId: "msg-1",
      body: "hi",
      conversationId: "conv-1",
    });
    expect(
      (service.client as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .sendMessage,
    ).not.toHaveBeenCalled();
    expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
  });

  it("passes a legitimate DM reply through after stripping", async () => {
    const service = fakeService();
    const sendMock = vi.fn(async () => ({ id: "m-1" }));
    (service.client as unknown as Record<string, unknown>).sendMessage = sendMock;
    const runtime = makeRuntime("Assistant: real DM reply");
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "dm-k2",
      senderUsername: "bob",
      messageId: "msg-2",
      body: "hi",
      conversationId: "conv-2",
    });
    expect(sendMock).toHaveBeenCalledWith("bob", "real DM reply");
  });

  it("skips the callback entirely when response.text is empty", async () => {
    const service = fakeService();
    service.client.createComment.mockResolvedValue({ id: "c" });
    const runtime = makeRuntime("");
    await dispatchPostMention(service as never, runtime, {
      memoryIdKey: "k-empty",
      postId: "post-1",
      postTitle: "T",
      postBody: "B",
      authorUsername: "u",
    });
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(service.incrementStat).not.toHaveBeenCalledWith("selfCheckRejections");
  });

  it("skips a DM callback when response.text is empty", async () => {
    const service = fakeService();
    const sendMock = vi.fn(async () => ({ id: "m" }));
    (service.client as unknown as Record<string, unknown>).sendMessage = sendMock;
    const runtime = makeRuntime("");
    await dispatchDirectMessage(service as never, runtime, {
      memoryIdKey: "dm-empty",
      senderUsername: "carol",
      messageId: "msg-3",
      body: "hi",
      conversationId: "conv-3",
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// isOllamaReachable (pre-tick probe)
// ──────────────────────────────────────────────────────────────────────
describe("isOllamaReachable (v0.16.0)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function rt(
    settings: Record<string, string> = {},
  ): IAgentRuntime {
    return {
      getSetting: vi.fn((k: string) => settings[k] ?? null),
    } as unknown as IAgentRuntime;
  }

  it("returns true when OLLAMA_API_ENDPOINT is not set", async () => {
    expect(await isOllamaReachable(rt())).toBe(true);
  });

  it("returns true when the probe responds 200", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as typeof fetch;
    expect(
      await isOllamaReachable(
        rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api" }),
      ),
    ).toBe(true);
  });

  it("returns false when the probe rejects (endpoint down)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(
      await isOllamaReachable(
        rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api" }),
      ),
    ).toBe(false);
  });

  it("returns false when the probe responds with non-ok", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("oops", { status: 500 }),
    ) as typeof fetch;
    expect(
      await isOllamaReachable(
        rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api" }),
      ),
    ).toBe(false);
  });

  it("caches the result within the TTL window", async () => {
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as typeof fetch;
    globalThis.fetch = fetchMock;
    const runtime = rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api" });
    await isOllamaReachable(runtime);
    await isOllamaReachable(runtime);
    await isOllamaReachable(runtime);
    // 1 probe, 3 calls — the next two hit the cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the TTL expires", async () => {
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as typeof fetch;
    globalThis.fetch = fetchMock;
    const runtime = rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api" });
    await isOllamaReachable(runtime, 0); // 0 TTL → always re-probe
    await isOllamaReachable(runtime, 0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("trims trailing slashes on the endpoint", async () => {
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as typeof fetch;
    globalThis.fetch = fetchMock;
    await isOllamaReachable(
      rt({ OLLAMA_API_ENDPOINT: "http://localhost:11434/api/" }),
    );
    const url = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0];
    expect(String(url)).toBe("http://localhost:11434/api/tags");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Pre-tick probe wired into post + engagement clients
// ──────────────────────────────────────────────────────────────────────
describe("Pre-tick Ollama probe integration (v0.16.0)", () => {
  const originalFetch = globalThis.fetch;
  let service: FakeService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = fakeService();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  function runtime(
    modelOutput: string,
    settings: Record<string, string> = {},
  ): IAgentRuntime {
    return {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => modelOutput),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
      getSetting: vi.fn((k: string) => settings[k] ?? null),
    } as unknown as IAgentRuntime;
  }

  it("post-client skips tick when Ollama unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const rt = runtime("should not be called", {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
    });
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(rt.useModel).not.toHaveBeenCalled();
    expect(service.client.createPost).not.toHaveBeenCalled();
    await c.stop();
  });

  it("engagement-client skips tick when Ollama unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const rt = runtime("should not be called", {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
    });
    service.client.getPosts.mockResolvedValue({ items: [] });
    const c = new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.getPosts).not.toHaveBeenCalled();
    expect(rt.useModel).not.toHaveBeenCalled();
    await c.stop();
  });

  it("proceeds as normal when OLLAMA_API_ENDPOINT is unset (cloud provider)", async () => {
    const rt = runtime("Title: X\n\nSubstantive body here."); // no OLLAMA setting
    service.client.createPost.mockResolvedValue({ id: "p-1" });
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createPost).toHaveBeenCalled();
    await c.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Service stats: recordLlmCall
// ──────────────────────────────────────────────────────────────────────
describe("ColonyService.recordLlmCall (v0.16.0)", () => {
  it("increments llmCallsSuccess on success", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.recordLlmCall("success");
    svc.recordLlmCall("success");
    expect(svc.stats.llmCallsSuccess).toBe(2);
    expect(svc.stats.llmCallsFailed).toBe(0);
  });

  it("increments llmCallsFailed on failure", async () => {
    const { ColonyService } = await import("../services/colony.service.js");
    const svc = new ColonyService();
    svc.recordLlmCall("failure");
    expect(svc.stats.llmCallsSuccess).toBe(0);
    expect(svc.stats.llmCallsFailed).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Status/diagnostics surfacing
// ──────────────────────────────────────────────────────────────────────
describe("COLONY_STATUS LLM health (v0.16.0)", () => {
  it("adds an LLM health line when counters are non-zero", async () => {
    const service = fakeService();
    service.stats!.llmCallsSuccess = 18;
    service.stats!.llmCallsFailed = 2;
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      fakeRuntime(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/LLM provider health: 18\/20 successful \(90%\)/);
  });

  it("appends a ⚠️ marker when the success rate dips below 90%", async () => {
    const service = fakeService();
    service.stats!.llmCallsSuccess = 5;
    service.stats!.llmCallsFailed = 15;
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      fakeRuntime(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toContain("⚠️");
    expect(text).toContain("LLM provider health");
  });

  it("omits the LLM health line when no calls have been recorded", async () => {
    const service = fakeService();
    service.stats!.llmCallsSuccess = 0;
    service.stats!.llmCallsFailed = 0;
    const cb = makeCallback();
    await colonyStatusAction.handler!(
      fakeRuntime(service),
      fakeMessage("colony status"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).not.toContain("LLM provider");
  });
});

describe("COLONY_DIAGNOSTICS LLM health (v0.16.0)", () => {
  it("reports LLM call counts", async () => {
    const service = fakeService();
    service.stats!.llmCallsSuccess = 7;
    service.stats!.llmCallsFailed = 3;
    const cb = makeCallback();
    await colonyDiagnosticsAction.handler!(
      fakeRuntime(service),
      fakeMessage("run colony diagnostics"),
      fakeState(),
      undefined,
      cb,
    );
    const text = String((cb.mock.calls[0]![0] as { text: string }).text);
    expect(text).toMatch(/LLM provider calls: 7 succeeded, 3 failed/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Branch-coverage fills for v0.16.0
// ──────────────────────────────────────────────────────────────────────
describe("branch-coverage fills (v0.16.0)", () => {
  it("post-client logs debug when output is empty after artifact stripping", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.recordLlmCall = vi.fn();
    // Output is pure chat-template markers — stripLLMArtifacts returns "",
    // hitting the "empty" reason branch (not model_error).
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => "<|im_start|><|im_end|>"),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: false,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createPost).not.toHaveBeenCalled();
    // recordLlmCall recorded the initial success — but the empty-path
    // doesn't bump selfCheckRejections.
    expect(service.incrementStat).not.toHaveBeenCalledWith("selfCheckRejections");
    await c.stop();
    vi.useRealTimers();
  });

  it("post-client SPAM retry handles a cleanedRaw that becomes empty", async () => {
    vi.useFakeTimers();
    const service = fakeService();
    service.recordLlmCall = vi.fn();
    service.client.createPost.mockResolvedValue({ id: "p-1" });
    let call = 0;
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => {
        // 1: generation  2: scorer → SPAM   3: retry returns empty
        // 4: (won't be called — retry path skips scorer when cleanedRaw empty)
        const outputs = [
          "Title: S\n\nA short body.",
          "SPAM",
          "", // retry empty
        ];
        return outputs[call++] ?? "SKIP";
      }),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const c = new ColonyPostClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colony: "general",
      maxTokens: 280,
      temperature: 0.9,
      selfCheck: true,
      selfCheckRetry: true,
      dailyLimit: 0,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    // SPAM verdict stood — no post published
    expect(service.client.createPost).not.toHaveBeenCalled();
    await c.stop();
    vi.useRealTimers();
  });

  it("engagement-client watched path: drops model-error output", async () => {
    vi.useFakeTimers();
    const { writeWatchList } = await import("../actions/watchPost.js");
    const service = fakeService();
    service.recordLlmCall = vi.fn();
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "P",
      body: "B",
      comment_count: 3,
    });
    const store = new Map<string, unknown>();
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(
        async () => "Error generating text. Please try again later.",
      ),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
    await writeWatchList(rt, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    const c = new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.client.createComment).not.toHaveBeenCalled();
    expect(service.incrementStat).toHaveBeenCalledWith("selfCheckRejections");
    expect(service.recordLlmCall).toHaveBeenCalledWith("failure");
    await c.stop();
    vi.useRealTimers();
  });

  it("engagement-client watched path: watched generation throws", async () => {
    vi.useFakeTimers();
    const { writeWatchList } = await import("../actions/watchPost.js");
    const service = fakeService();
    service.recordLlmCall = vi.fn();
    service.client.getPost.mockResolvedValue({
      id: "post-watched",
      title: "P",
      body: "B",
      comment_count: 3,
    });
    const store = new Map<string, unknown>();
    const rt = {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: {
        name: "n",
        bio: "b",
        topics: ["t"],
        style: { all: [], chat: [] },
      },
      useModel: vi.fn(async () => {
        throw new Error("model fail");
      }),
      getCache: vi.fn(async (k: string) => store.get(k)),
      setCache: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
    } as unknown as IAgentRuntime;
    await writeWatchList(rt, service.username, [
      { postId: "post-watched", addedAt: 0, lastCommentCount: 0 },
    ]);
    const c = new ColonyEngagementClient(service as never, rt, {
      intervalMinMs: 1000,
      intervalMaxMs: 2000,
      colonies: ["general"],
      candidateLimit: 5,
      maxTokens: 240,
      temperature: 0.8,
      selfCheck: false,
    });
    await c.start();
    await vi.advanceTimersByTimeAsync(2001);
    expect(service.recordLlmCall).toHaveBeenCalledWith("failure");
    await c.stop();
    vi.useRealTimers();
  });
});
