import { describe, expect, it, beforeEach, vi } from "vitest";
import { colonyDiagnosticsAction, redactKey } from "../actions/diagnostics.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";
import type { IAgentRuntime } from "@elizaos/core";

function runtimeWithCache(
  service: FakeService | null,
  cacheData: Record<string, unknown> = {},
  character: Record<string, unknown> | null = {
    name: "eliza-test",
    bio: "bio",
    topics: ["t"],
    messageExamples: [[]],
    style: { all: ["x"] },
  },
): IAgentRuntime {
  const base = fakeRuntime(service);
  return {
    ...base,
    character,
    getCache: vi.fn(async (k: string) => cacheData[k]),
    setCache: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("redactKey", () => {
  it("returns (missing) for undefined", () => {
    expect(redactKey(undefined)).toBe("(missing)");
  });
  it("returns a safe pattern for short keys", () => {
    expect(redactKey("col_abc")).toBe("col_****");
  });
  it("redacts middle of normal-length keys", () => {
    const result = redactKey("col_1234567890abcdef");
    expect(result).toContain("col_");
    expect(result).toContain("cdef");
    expect(result).toContain("…");
  });
});

describe("colonyDiagnosticsAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.currentKarma = 42;
    service.currentTrust = "Trusted";
    service.interactionClient = null;
    service.postClient = null;
    service.engagementClient = null;
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await colonyDiagnosticsAction.validate(
          fakeRuntime(null),
          fakeMessage("colony diagnostics"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await colonyDiagnosticsAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text field", async () => {
      expect(
        await colonyDiagnosticsAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without the 'colony' token", async () => {
      expect(
        await colonyDiagnosticsAction.validate(fakeRuntime(service), fakeMessage("diagnose this")),
      ).toBe(false);
    });

    it("true for 'colony diagnostics'", async () => {
      expect(
        await colonyDiagnosticsAction.validate(
          fakeRuntime(service),
          fakeMessage("run colony diagnostics"),
        ),
      ).toBe(true);
    });

    it("true for 'debug the colony plugin'", async () => {
      expect(
        await colonyDiagnosticsAction.validate(
          fakeRuntime(service),
          fakeMessage("debug the colony plugin"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service is missing", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        fakeRuntime(null),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("reports handle, karma, config, cache sizes", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service, {
          [`colony/post-client/recent/${service.username}`]: ["a", "b"],
          [`colony/post-client/daily/${service.username}`]: [Date.now()],
          [`colony/engagement-client/seen/${service.username}`]: ["p1", "p2", "p3"],
          [`colony/curate/voted/${service.username}`]: ["v1"],
        }),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Handle: @eliza-test");
      expect(text).toContain("Karma: 42");
      expect(text).toContain("recent posts (dedup): 2 entries");
      expect(text).toContain("post daily ledger: 1 entries");
      expect(text).toContain("engagement seen: 3 entries");
      expect(text).toContain("curate voted: 1 entries");
    });

    it("redacts the API key", async () => {
      service.colonyConfig.apiKey = "col_supersecret1234567890";
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).not.toContain("supersecret");
      expect(text).toContain("API key:");
    });

    it("reports autonomy loop state — enabled variant", async () => {
      service.colonyConfig.pollEnabled = true;
      service.colonyConfig.postEnabled = true;
      service.colonyConfig.engageEnabled = true;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/polling: enabled/);
      expect(text).toMatch(/posting: enabled/);
      expect(text).toMatch(/engagement: enabled/);
    });

    it("reports autonomy loops disabled when flags are off", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/polling: disabled/);
    });

    it("reports self-check and dry-run flags", async () => {
      service.colonyConfig.selfCheckEnabled = true;
      service.colonyConfig.dryRun = true;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("self-check: on");
      expect(text).toContain("dry-run: on");
    });

    it("reports karma backoff parameters", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/karma backoff: drop ≥ 10 over 6h → pause 120min/);
    });

    it("reports pause state when service is paused", async () => {
      service.pausedUntilTs = Date.now() + 45 * 60_000;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Paused for karma backoff");
    });

    it("omits pause line when not paused", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).not.toContain("⏸️");
    });

    it("reports character validation warnings when fields missing", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service, {}, { name: "x" }),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/character: \d+ field\(s\) missing/);
    });

    it("reports character ok when all fields present", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("character: ok");
    });

    it("reports zero cache entries when keys missing", async () => {
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("recent posts (dedup): 0 entries");
    });

    it("reports cache error gracefully", async () => {
      const base = fakeRuntime(service);
      const runtime = {
        ...base,
        character: { name: "x" },
        getCache: vi.fn(async () => {
          throw new Error("cache down");
        }),
      } as unknown as IAgentRuntime;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtime,
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("error (Error: cache down)");
    });

    it("handles runtime without getCache", async () => {
      const runtime = {
        ...fakeRuntime(service),
        character: { name: "x", bio: "b", topics: ["t"], messageExamples: [[]], style: { all: ["a"] } },
      } as unknown as IAgentRuntime;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtime,
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("runtime has no cache");
    });

    it("handles service with no username", async () => {
      service.username = undefined;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("@(unknown)");
    });

    it("shows '?' when karma/trust are undefined", async () => {
      service.currentKarma = undefined;
      service.currentTrust = undefined;
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Karma: ?, trust: ?");
    });

    it("reports Ollama warning when readiness fails", async () => {
      // Override global fetch with a failing endpoint
      const runtime = runtimeWithCache(service);
      (runtime as unknown as { getSetting: (k: string) => unknown }).getSetting = (k: string) =>
        k === "OLLAMA_API_ENDPOINT" ? "http://bad.invalid/api" : null;
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch;
      try {
        const cb = makeCallback();
        await colonyDiagnosticsAction.handler(
          runtime,
          fakeMessage("colony diagnostics"),
          fakeState(),
          undefined,
          cb,
        );
        const text = (cb.mock.calls[0]![0] as { text: string }).text;
        expect(text).toContain("warnings logged");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("shows session stats in the summary", async () => {
      service.stats = {
        postsCreated: 5,
        commentsCreated: 11,
        votesCast: 3,
        selfCheckRejections: 2,
        startedAt: Date.now(),
      };
      const cb = makeCallback();
      await colonyDiagnosticsAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony diagnostics"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("posts=5");
      expect(text).toContain("comments=11");
      expect(text).toContain("votes=3");
      expect(text).toContain("self-check-rejections=2");
    });
  });
});
