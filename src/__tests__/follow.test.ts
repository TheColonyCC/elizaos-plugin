import { describe, expect, it, beforeEach } from "vitest";
import { followColonyUserAction } from "../actions/follow.js";
import { unfollowColonyUserAction } from "../actions/unfollow.js";
import {
  fakeMessage,
  fakeRuntime,
  fakeService,
  fakeState,
  makeCallback,
  messageWithoutText,
  type FakeService,
} from "./helpers.js";

describe("followColonyUserAction", () => {
  let service: FakeService;
  beforeEach(() => {
    service = fakeService();
  });

  it("validate false when service missing", async () => {
    expect(await followColonyUserAction.validate(fakeRuntime(null), fakeMessage("follow"))).toBe(false);
  });
  it("validate false for empty text", async () => {
    expect(await followColonyUserAction.validate(fakeRuntime(service), fakeMessage(""))).toBe(false);
  });
  it("validate false when text has no follow keyword", async () => {
    expect(await followColonyUserAction.validate(fakeRuntime(service), fakeMessage("hello"))).toBe(false);
  });
  it("validate true when keyword present", async () => {
    expect(await followColonyUserAction.validate(fakeRuntime(service), fakeMessage("follow that agent"))).toBe(true);
  });
  it("validate false on messageWithoutText", async () => {
    expect(await followColonyUserAction.validate(fakeRuntime(service), messageWithoutText())).toBe(false);
  });

  it("handler returns early when service missing", async () => {
    const cb = makeCallback();
    await followColonyUserAction.handler!(fakeRuntime(null), fakeMessage("follow"), fakeState(), {}, cb);
    expect(cb).not.toHaveBeenCalled();
  });
  it("handler prompts when userId is missing", async () => {
    const cb = makeCallback();
    await followColonyUserAction.handler!(fakeRuntime(service), fakeMessage("follow"), fakeState(), {}, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ action: "FOLLOW_COLONY_USER" }));
    expect(service.client.follow).not.toHaveBeenCalled();
  });
  it("handler calls follow with userId", async () => {
    service.client.follow.mockResolvedValue({});
    const cb = makeCallback();
    await followColonyUserAction.handler!(fakeRuntime(service), fakeMessage("follow"), fakeState(), { userId: "u-1" }, cb);
    expect(service.client.follow).toHaveBeenCalledWith("u-1");
    expect(cb.mock.calls[0][0].text).toContain("u-1");
  });
  it("handler reports SDK errors", async () => {
    service.client.follow.mockRejectedValue(new Error("already-following"));
    const cb = makeCallback();
    await followColonyUserAction.handler!(fakeRuntime(service), fakeMessage("follow"), fakeState(), { userId: "u-1" }, cb);
    expect(cb.mock.calls[0][0].text).toContain("already-following");
  });
});

describe("unfollowColonyUserAction", () => {
  let service: FakeService;
  beforeEach(() => {
    service = fakeService();
  });

  it("validate false when service missing", async () => {
    expect(await unfollowColonyUserAction.validate(fakeRuntime(null), fakeMessage("unfollow"))).toBe(false);
  });
  it("validate false for empty text", async () => {
    expect(await unfollowColonyUserAction.validate(fakeRuntime(service), fakeMessage(""))).toBe(false);
  });
  it("validate false when no keyword", async () => {
    expect(await unfollowColonyUserAction.validate(fakeRuntime(service), fakeMessage("hello"))).toBe(false);
  });
  it("validate true when keyword present", async () => {
    expect(await unfollowColonyUserAction.validate(fakeRuntime(service), fakeMessage("unfollow that agent"))).toBe(true);
  });
  it("validate false on messageWithoutText", async () => {
    expect(await unfollowColonyUserAction.validate(fakeRuntime(service), messageWithoutText())).toBe(false);
  });

  it("handler returns early when service missing", async () => {
    const cb = makeCallback();
    await unfollowColonyUserAction.handler!(fakeRuntime(null), fakeMessage("unfollow"), fakeState(), {}, cb);
    expect(cb).not.toHaveBeenCalled();
  });
  it("handler prompts when userId is missing", async () => {
    const cb = makeCallback();
    await unfollowColonyUserAction.handler!(fakeRuntime(service), fakeMessage("unfollow"), fakeState(), {}, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ action: "UNFOLLOW_COLONY_USER" }));
  });
  it("handler calls unfollow with userId", async () => {
    service.client.unfollow.mockResolvedValue({});
    const cb = makeCallback();
    await unfollowColonyUserAction.handler!(fakeRuntime(service), fakeMessage("unfollow"), fakeState(), { userId: "u-1" }, cb);
    expect(service.client.unfollow).toHaveBeenCalledWith("u-1");
  });
  it("handler reports SDK errors", async () => {
    service.client.unfollow.mockRejectedValue(new Error("not-following"));
    const cb = makeCallback();
    await unfollowColonyUserAction.handler!(fakeRuntime(service), fakeMessage("unfollow"), fakeState(), { userId: "u-1" }, cb);
    expect(cb.mock.calls[0][0].text).toContain("not-following");
  });
});
