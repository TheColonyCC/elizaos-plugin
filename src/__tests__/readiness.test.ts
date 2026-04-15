import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkOllamaReadiness, validateCharacter } from "../utils/readiness.js";
import { fakeRuntime } from "./helpers.js";
import type { IAgentRuntime } from "@elizaos/core";

describe("checkOllamaReadiness", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true immediately when OLLAMA_API_ENDPOINT is unset", async () => {
    const runtime = fakeRuntime(null, {});
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns false when the Ollama endpoint is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(false);
  });

  it("returns false on non-2xx responses", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(false);
  });

  it("returns true when all configured models are present", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { name: "gemma4:31b-it-q4_K_M" },
          { name: "nomic-embed-text" },
        ],
      }),
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "gemma4:31b-it-q4_K_M",
      OLLAMA_EMBEDDING_MODEL: "nomic-embed-text",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(true);
  });

  it("returns false when one of the configured models is missing", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ name: "gemma4:31b-it-q4_K_M" }],
      }),
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "gemma4:31b-it-q4_K_M",
      OLLAMA_EMBEDDING_MODEL: "nomic-embed-text", // not installed
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(false);
  });

  it("returns true when no model env vars are set at all", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(true);
  });

  it("handles an endpoint with a trailing slash", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api/",
    });
    await checkOllamaReadiness(runtime);
    expect(spy).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );
  });

  it("handles models entries with missing name field", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{}, { name: "gemma4:31b-it-q4_K_M" }] }),
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "gemma4:31b-it-q4_K_M",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(true);
  });

  it("handles missing models field in response gracefully", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const runtime = fakeRuntime(null, {
      OLLAMA_API_ENDPOINT: "http://localhost:11434/api",
      OLLAMA_SMALL_MODEL: "gemma4:31b-it-q4_K_M",
    });
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(false);
  });

  it("handles runtime without getSetting function", async () => {
    const runtime = {} as IAgentRuntime;
    const result = await checkOllamaReadiness(runtime);
    expect(result).toBe(true);
  });
});

describe("validateCharacter", () => {
  it("returns 0 warnings for a fully-populated character", () => {
    const runtime = {
      character: {
        name: "good",
        bio: ["Rich bio"],
        topics: ["t"],
        messageExamples: [[]],
        style: { all: ["Be concrete"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBe(0);
  });

  it("returns 1 when character is missing entirely", () => {
    const runtime = {} as IAgentRuntime;
    expect(validateCharacter(runtime)).toBe(1);
  });

  it("warns about missing name", () => {
    const runtime = {
      character: {
        bio: "x",
        topics: ["t"],
        messageExamples: [[]],
        style: { all: ["x"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("warns about missing bio (empty array)", () => {
    const runtime = {
      character: {
        name: "x",
        bio: [],
        topics: ["t"],
        messageExamples: [[]],
        style: { all: ["x"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("warns about missing bio (empty string)", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "",
        topics: ["t"],
        messageExamples: [[]],
        style: { all: ["x"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("warns about missing topics", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "x",
        topics: [],
        messageExamples: [[]],
        style: { all: ["x"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("warns about missing messageExamples", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "x",
        topics: ["t"],
        messageExamples: [],
        style: { all: ["x"] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("warns about missing style (all sub-fields empty)", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "x",
        topics: ["t"],
        messageExamples: [[]],
        style: {},
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(0);
  });

  it("accepts style with only chat populated", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "x",
        topics: ["t"],
        messageExamples: [[]],
        style: { chat: ["Direct."] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBe(0);
  });

  it("accepts style with only post populated", () => {
    const runtime = {
      character: {
        name: "x",
        bio: "x",
        topics: ["t"],
        messageExamples: [[]],
        style: { post: ["Lead with the point."] },
      },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBe(0);
  });

  it("returns multiple warnings when multiple fields are missing", () => {
    const runtime = {
      character: { name: "x" },
    } as unknown as IAgentRuntime;
    expect(validateCharacter(runtime)).toBeGreaterThan(1);
  });
});
