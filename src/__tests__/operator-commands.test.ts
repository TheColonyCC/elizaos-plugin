import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  handleOperatorCommand,
  parseDurationMs,
} from "../services/operator-commands.js";
import { fakeService, type FakeService } from "./helpers.js";

describe("parseDurationMs", () => {
  it("parses bare numbers as minutes", () => {
    expect(parseDurationMs("30")).toBe(30 * 60_000);
  });

  it("parses 'm' suffix as minutes", () => {
    expect(parseDurationMs("45m")).toBe(45 * 60_000);
  });

  it("parses 'h' suffix as hours", () => {
    expect(parseDurationMs("2h")).toBe(2 * 3_600_000);
  });

  it("parses 's' suffix as seconds", () => {
    expect(parseDurationMs("90s")).toBe(90 * 1_000);
  });

  it("parses fractional values", () => {
    expect(parseDurationMs("1.5h")).toBe(1.5 * 3_600_000);
  });

  it("handles surrounding whitespace", () => {
    expect(parseDurationMs("  10m  ")).toBe(10 * 60_000);
  });

  it("returns null for empty string", () => {
    expect(parseDurationMs("")).toBe(null);
  });

  it("returns null for non-numeric input", () => {
    expect(parseDurationMs("forever")).toBe(null);
  });

  it("returns null for zero", () => {
    expect(parseDurationMs("0")).toBe(null);
  });

  it("returns null for negative numbers", () => {
    expect(parseDurationMs("-5m")).toBe(null);
  });

  it("returns null for unknown unit", () => {
    expect(parseDurationMs("10d")).toBe(null);
  });

  it("is case-insensitive on unit suffix", () => {
    expect(parseDurationMs("2H")).toBe(2 * 3_600_000);
  });
});

describe("handleOperatorCommand", () => {
  let service: FakeService;

  beforeEach(() => {
    service = fakeService({}, { operatorUsername: "jack", operatorPrefix: "!" });
    // The real pauseForReason mutates pausedUntilTs + pauseReason; the fake
    // service only assigns pausedUntilTs. For kill-switch tests, promote it
    // to the production contract.
    service.pauseForReason = vi.fn((ms: number, reason: string) => {
      service.pausedUntilTs = Date.now() + ms;
      service.pauseReason = reason;
      return service.pausedUntilTs;
    });
  });

  it("returns null when operatorUsername is unset", async () => {
    service.colonyConfig.operatorUsername = "";
    const res = await handleOperatorCommand(service as never, "jack", "!pause 30m");
    expect(res).toBe(null);
  });

  it("returns null for non-operator senders", async () => {
    const res = await handleOperatorCommand(service as never, "someone-else", "!pause 30m");
    expect(res).toBe(null);
  });

  it("is case-insensitive on sender username", async () => {
    const res = await handleOperatorCommand(service as never, "Jack", "!pause 30m");
    expect(res).not.toBe(null);
  });

  it("returns null for non-command text from operator", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "hello");
    expect(res).toBe(null);
  });

  it("executes !pause with a duration", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!pause 30m");
    expect(res?.command).toBe("pause");
    expect(res?.reply).toContain("Paused autonomy for 30min");
    expect(service.pausedUntilTs).toBeGreaterThan(Date.now());
  });

  it("returns usage message when !pause has no duration", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!pause");
    expect(res?.command).toBe("pause");
    expect(res?.reply).toContain("duration required");
    expect(service.pausedUntilTs).toBe(0);
  });

  it("returns usage message when !pause duration is unparseable", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!pause forever");
    expect(res?.command).toBe("pause");
    expect(res?.reply).toContain("duration required");
  });

  it("executes !resume when paused", async () => {
    service.pausedUntilTs = Date.now() + 10 * 60_000;
    service.pauseReason = "operator_cooldown";
    const res = await handleOperatorCommand(service as never, "jack", "!resume");
    expect(res?.command).toBe("resume");
    expect(res?.reply).toContain("Pause cleared");
    expect(service.pausedUntilTs).toBe(0);
    expect(service.pauseReason).toBe(null);
  });

  it("executes !resume when not currently paused", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!resume");
    expect(res?.command).toBe("resume");
    expect(res?.reply).toContain("No active pause");
  });

  it("executes !status and includes key fields", async () => {
    service.pausedUntilTs = Date.now() + 20 * 60_000;
    service.pauseReason = "karma_backoff";
    service.currentKarma = 17;
    const res = await handleOperatorCommand(service as never, "jack", "!status");
    expect(res?.command).toBe("status");
    expect(res?.reply).toContain("paused: yes");
    expect(res?.reply).toContain("reason=karma_backoff");
    expect(res?.reply).toContain("karma: 17");
  });

  it("!status shows 'paused: no' when unpaused", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!status");
    expect(res?.reply).toContain("paused: no");
  });

  it("!status shows '?' for karma when currentKarma is undefined", async () => {
    service.currentKarma = undefined;
    const res = await handleOperatorCommand(service as never, "jack", "!status");
    expect(res?.reply).toContain("karma: ?");
  });

  it("!status shows reason=none when not paused and no prior reason", async () => {
    service.pauseReason = null;
    const res = await handleOperatorCommand(service as never, "jack", "!status");
    expect(res?.reply).toContain("paused: no");
  });

  it("executes !help listing all commands", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!help");
    expect(res?.command).toBe("help");
    expect(res?.reply).toContain("!pause");
    expect(res?.reply).toContain("!resume");
    expect(res?.reply).toContain("!status");
    expect(res?.reply).toContain("!drop-last");
  });

  it("returns unknown-command reply for unrecognised commands", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!detonate");
    expect(res?.command).toBe("unknown");
    expect(res?.reply).toContain("Unknown operator command");
  });

  it("!drop-last-comment reports no recent comment when activity log is empty", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last-comment");
    expect(res?.command).toBe("drop-last-comment");
    expect(res?.reply).toContain("No recent comment");
  });

  it("!drop-last alias works", async () => {
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last");
    expect(res?.command).toBe("drop-last-comment");
  });

  // v0.20.0: the "deleteComment unavailable" path was removed — the
  // plugin now requires @thecolony/sdk ^0.2.0 which has the method
  // on the public surface. Test deleted with the fallback code.

  it("!drop-last-comment deletes the latest comment when the SDK supports it", async () => {
    (service.client as unknown as { deleteComment: ReturnType<typeof vi.fn> }).deleteComment = vi.fn(async () => ({}));
    service.activityLog!.push({
      ts: Date.now(),
      type: "comment_created",
      target: "cmt-aaaabbbb",
      detail: "reply on p-1",
    });
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last-comment");
    expect(res?.command).toBe("drop-last-comment");
    expect(res?.reply).toContain("Deleted comment cmt-aaaa");
    const client = service.client as unknown as { deleteComment: ReturnType<typeof vi.fn> };
    expect(client.deleteComment).toHaveBeenCalledWith("cmt-aaaabbbb");
  });

  it("!drop-last-comment falls back to 'no detail' when activity has no detail", async () => {
    (service.client as unknown as { deleteComment: ReturnType<typeof vi.fn> }).deleteComment = vi.fn(async () => ({}));
    service.activityLog!.push({
      ts: Date.now(),
      type: "comment_created",
      target: "cmt-aaaabbbb",
      // detail intentionally omitted
    });
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last-comment");
    expect(res?.reply).toContain("no detail");
  });

  it("!drop-last-comment surfaces SDK errors", async () => {
    (service.client as unknown as { deleteComment: ReturnType<typeof vi.fn> }).deleteComment = vi.fn(async () => {
      throw new Error("permission denied");
    });
    service.activityLog!.push({
      ts: Date.now(),
      type: "comment_created",
      target: "cmt-aaaabbbb",
      detail: "reply",
    });
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last-comment");
    expect(res?.reply).toContain("Failed to delete comment cmt-aaaa");
    expect(res?.reply).toContain("permission denied");
  });

  it("!drop-last-comment reports no recent comment when the latest entry has no target", async () => {
    service.activityLog!.push({
      ts: Date.now(),
      type: "comment_created",
      // target intentionally omitted
      detail: "reply",
    });
    const res = await handleOperatorCommand(service as never, "jack", "!drop-last-comment");
    expect(res?.reply).toContain("No recent comment");
  });

  it("!pause with a pre-existing longer pause keeps the longer one", async () => {
    service.pausedUntilTs = Date.now() + 2 * 3_600_000; // 2h
    service.pauseForReason = vi.fn((ms: number, reason: string) => {
      const requested = Date.now() + ms;
      if (requested <= (service.pausedUntilTs ?? 0)) {
        return service.pausedUntilTs ?? 0;
      }
      service.pausedUntilTs = requested;
      service.pauseReason = reason;
      return requested;
    });
    const res = await handleOperatorCommand(service as never, "jack", "!pause 30m");
    expect(res?.command).toBe("pause");
    expect(res?.reply).toContain("Paused autonomy for 30min");
  });
});
