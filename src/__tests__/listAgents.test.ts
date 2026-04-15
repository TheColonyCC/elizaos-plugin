import { describe, expect, it, beforeEach } from "vitest";
import { listColonyAgentsAction } from "../actions/listAgents.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("listColonyAgentsAction", () => {
  let service: FakeService;
  beforeEach(() => {
    service = fakeService();
  });

  describe("validate", () => {
    it("returns false when service missing", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(null), fakeMessage("list colony agents")),
      ).toBe(false);
    });
    it("returns false for empty text", async () => {
      expect(await listColonyAgentsAction.validate(fakeRuntime(service), fakeMessage(""))).toBe(false);
    });
    it("returns false without colony or agent keyword", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(service), fakeMessage("list stuff")),
      ).toBe(false);
    });
    it("returns true with colony + list", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(service), fakeMessage("list colony agents")),
      ).toBe(true);
    });
    it("returns true with 'agent' + browse", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(service), fakeMessage("browse colony agent directory")),
      ).toBe(true);
    });
    it("returns false on messageWithoutText", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(service), messageWithoutText()),
      ).toBe(false);
    });
    it("returns false when agent keyword present but no action keyword", async () => {
      expect(
        await listColonyAgentsAction.validate(fakeRuntime(service), fakeMessage("agent stuff")),
      ).toBe(false);
    });
  });

  describe("handler", () => {
    it("returns early when service missing", async () => {
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(null),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      expect(cb).not.toHaveBeenCalled();
    });

    it("formats directory results with query + sort", async () => {
      service.client.directory.mockResolvedValue({
        items: [
          { username: "alice", display_name: "Alice", karma: 200, bio: "benchmarks" },
          { username: "bob", karma: 100 },
        ],
      });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        { query: "benchmarks", sort: "karma", limit: 5, userType: "agent" },
        cb,
      );
      expect(service.client.directory).toHaveBeenCalledWith({
        query: "benchmarks",
        userType: "agent",
        sort: "karma",
        limit: 5,
      });
      const text = cb.mock.calls[0][0].text;
      expect(text).toContain("Agents matching");
      expect(text).toContain("@alice");
      expect(text).toContain("karma 200");
      expect(text).toContain("@bob");
    });

    it("uses default parameters when options are missing", async () => {
      service.client.directory.mockResolvedValue({
        items: [{ username: "carol", karma: 42 }],
      });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("browse colony directory"),
        fakeState(),
        {},
        cb,
      );
      expect(service.client.directory).toHaveBeenCalledWith(
        expect.objectContaining({ userType: "agent", sort: "karma", limit: 10 }),
      );
      expect(cb.mock.calls[0][0].text).toContain("sorted by karma");
      expect(cb.mock.calls[0][0].text).not.toContain("matching");
    });

    it("clamps limit above 50 to 50 and falls back to 10 on invalid", async () => {
      service.client.directory.mockResolvedValue({ items: [] });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        { limit: 999 },
        cb,
      );
      expect(service.client.directory).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
      service.client.directory.mockClear();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        { limit: 0 },
        cb,
      );
      expect(service.client.directory).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    });

    it("reports empty results with query", async () => {
      service.client.directory.mockResolvedValue({ items: [] });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        { query: "nonexistent" },
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain('matching "nonexistent"');
    });

    it("reports empty results without query", async () => {
      service.client.directory.mockResolvedValue({ items: [] });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      expect(cb.mock.calls[0][0].text).toBe("No agents found on The Colony.");
    });

    it("handles users without display_name, karma, or bio", async () => {
      service.client.directory.mockResolvedValue({
        items: [{ username: "minimal" }],
      });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      const text = cb.mock.calls[0][0].text;
      expect(text).toContain("@minimal");
      expect(text).toContain("karma 0");
    });

    it("handles users with undefined username", async () => {
      service.client.directory.mockResolvedValue({
        items: [{ karma: 10 }],
      });
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("@unknown");
    });

    it("handles missing items array", async () => {
      service.client.directory.mockResolvedValue({});
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("No agents");
    });

    it("reports SDK errors", async () => {
      service.client.directory.mockRejectedValue(new Error("server-5xx"));
      const cb = makeCallback();
      await listColonyAgentsAction.handler!(
        fakeRuntime(service),
        fakeMessage("list colony agents"),
        fakeState(),
        {},
        cb,
      );
      expect(cb.mock.calls[0][0].text).toContain("server-5xx");
    });
  });
});
