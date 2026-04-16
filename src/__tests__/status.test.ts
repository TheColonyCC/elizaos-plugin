import { describe, expect, it, beforeEach, vi } from "vitest";
import { colonyStatusAction } from "../actions/status.js";
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
): IAgentRuntime {
  const base = fakeRuntime(service);
  return {
    ...base,
    getCache: vi.fn(async (k: string) => cacheData[k]),
    setCache: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("colonyStatusAction", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService();
    service.currentKarma = 42;
    service.currentTrust = "Trusted";
  });

  describe("validate", () => {
    it("false when service missing", async () => {
      expect(
        await colonyStatusAction.validate(
          fakeRuntime(null),
          fakeMessage("colony status"),
        ),
      ).toBe(false);
    });

    it("false for empty text", async () => {
      expect(
        await colonyStatusAction.validate(fakeRuntime(service), fakeMessage("")),
      ).toBe(false);
    });

    it("false when message has no text field", async () => {
      expect(
        await colonyStatusAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });

    it("false without the 'colony' token", async () => {
      expect(
        await colonyStatusAction.validate(fakeRuntime(service), fakeMessage("status report")),
      ).toBe(false);
    });

    it("true for 'colony status'", async () => {
      expect(
        await colonyStatusAction.validate(fakeRuntime(service), fakeMessage("colony status")),
      ).toBe(true);
    });

    it("true for 'how are you doing on the colony?'", async () => {
      expect(
        await colonyStatusAction.validate(
          fakeRuntime(service),
          fakeMessage("how are you doing on the colony?"),
        ),
      ).toBe(true);
    });

    it("true for 'give me a colony report'", async () => {
      expect(
        await colonyStatusAction.validate(
          fakeRuntime(service),
          fakeMessage("give me a colony report"),
        ),
      ).toBe(true);
    });
  });

  describe("handler", () => {
    it("returns silently when service is missing", async () => {
      const cb = makeCallback();
      await colonyStatusAction.handler(
        fakeRuntime(null),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("calls refreshKarma and reports handle + karma + trust", async () => {
      const runtime = runtimeWithCache(service);
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtime,
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      expect(service.refreshKarma).toHaveBeenCalled();
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("@eliza-test");
      expect(text).toContain("karma: 42");
      expect(text).toContain("trust: Trusted");
    });

    it("includes session stats", async () => {
      service.stats = {
        postsCreated: 3,
        commentsCreated: 8,
        votesCast: 2,
        selfCheckRejections: 1,
        startedAt: Date.now() - 7260_000, // 2h 1m ago
      };
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("3 posts");
      expect(text).toContain("8 comments");
      expect(text).toContain("2 votes");
      expect(text).toContain("1 self-check rejections");
      expect(text).toContain("2h");
    });

    it("shows 0/cap when no posts today", async () => {
      service.colonyConfig.postDailyLimit = 24;
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("0/24 used");
    });

    it("counts daily ledger entries within 24h window", async () => {
      const now = Date.now();
      const ledger = [now - 1000, now - 3600_000, now - 25 * 3600 * 1000];
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service, {
          [`colony/post-client/daily/${service.username}`]: ledger,
        }),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      // 2 entries within 24h (the 25h-ago one is excluded)
      expect(text).toMatch(/2\/\d+ used/);
    });

    it("reports paused state", async () => {
      service.isPausedForBackoff = vi.fn(() => true);
      service.pausedUntilTs = Date.now() + 30 * 60_000;
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      // v0.17.0: pause line consolidated to "Paused — resuming…" (the
      // pause may now come from karma OR llm-health backoff).
      expect(text).toContain("Paused — resuming");
    });

    it("reports karma trend with range when history spans values (v0.17.0)", async () => {
      service.karmaHistory = [
        { ts: Date.now() - 60_000, karma: 40 },
        { ts: Date.now(), karma: 42 },
      ];
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/Karma trend ↗ up 2.*range 40…42/);
    });

    it("reports flat karma trend when max equals min (v0.17.0)", async () => {
      service.karmaHistory = [
        { ts: Date.now() - 60_000, karma: 42 },
        { ts: Date.now(), karma: 42 },
      ];
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      // No range line, but the new flat-trend line is present
      expect(text).toMatch(/Karma trend → flat.*held at 42/);
      expect(text).not.toContain("range ");
    });

    it("lists active autonomy loops", async () => {
      service.interactionClient = {};
      service.postClient = {};
      service.engagementClient = {};
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("polling, posting, engagement");
    });

    it("reports 'none' when no loops running", async () => {
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("Active autonomy loops: none");
    });

    it("handles missing username gracefully", async () => {
      service.username = undefined;
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("(unknown handle)");
    });

    it("formats uptime with days for very long sessions", async () => {
      service.stats = {
        postsCreated: 0,
        commentsCreated: 0,
        votesCast: 0,
        selfCheckRejections: 0,
        startedAt: Date.now() - 2 * 86400_000 - 3 * 3600_000,
      };
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/2d \d+h/);
    });

    it("formats uptime as minutes when session is short", async () => {
      service.stats = {
        postsCreated: 0,
        commentsCreated: 0,
        votesCast: 0,
        selfCheckRejections: 0,
        startedAt: Date.now() - 5 * 60_000,
      };
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toMatch(/uptime 5m/);
    });

    it("works when runtime has no cache", async () => {
      const runtime = fakeRuntime(service);
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtime,
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("0/24 used");
    });

    it("handles empty ledger cache", async () => {
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service, {
          [`colony/post-client/daily/${service.username}`]: [],
        }),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("0/24 used");
    });

    it("reports per-source stat breakdown when non-zero (v0.14.0)", async () => {
      service.stats = {
        postsCreated: 5,
        commentsCreated: 3,
        votesCast: 0,
        selfCheckRejections: 0,
        startedAt: Date.now(),
        postsCreatedAutonomous: 3,
        postsCreatedFromActions: 2,
        commentsCreatedAutonomous: 2,
        commentsCreatedFromActions: 1,
      };
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("By source");
      expect(text).toContain("3 autonomous / 2 from actions");
      expect(text).toContain("2 autonomous / 1 from actions");
    });

    it("defaults karma to 0 when currentKarma undefined", async () => {
      service.currentKarma = undefined;
      service.currentTrust = undefined;
      const cb = makeCallback();
      await colonyStatusAction.handler(
        runtimeWithCache(service),
        fakeMessage("colony status"),
        fakeState(),
        undefined,
        cb,
      );
      const text = (cb.mock.calls[0]![0] as { text: string }).text;
      expect(text).toContain("karma: 0");
      expect(text).toContain("trust: Newcomer");
    });
  });
});
