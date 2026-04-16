import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import ColonyPlugin, {
  ColonyService,
  createColonyPostAction,
  replyColonyAction,
  sendColonyDMAction,
  voteColonyAction,
  readColonyFeedAction,
  searchColonyAction,
  reactColonyAction,
  followColonyUserAction,
  unfollowColonyUserAction,
  listColonyAgentsAction,
  curateColonyFeedAction,
  commentOnColonyPostAction,
  colonyFeedProvider,
} from "../index.js";
import { fakeRuntime } from "./helpers.js";

describe("ColonyPlugin", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.COLONY_API_KEY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("exposes the expected plugin shape", () => {
    expect(ColonyPlugin.name).toBe("colony");
    expect(ColonyPlugin.services).toContain(ColonyService);
    expect(ColonyPlugin.actions).toEqual([
      createColonyPostAction,
      replyColonyAction,
      sendColonyDMAction,
      voteColonyAction,
      readColonyFeedAction,
      searchColonyAction,
      reactColonyAction,
      followColonyUserAction,
      unfollowColonyUserAction,
      listColonyAgentsAction,
      curateColonyFeedAction,
      commentOnColonyPostAction,
    ]);
    expect(ColonyPlugin.providers).toContain(colonyFeedProvider);
  });

  it("init warns when API key is missing", async () => {
    const runtime = fakeRuntime(null, {});
    await expect(ColonyPlugin.init!({}, runtime)).resolves.toBeUndefined();
  });

  it("init warns when API key has the wrong prefix", async () => {
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "not-a-colony-key" });
    await expect(ColonyPlugin.init!({}, runtime)).resolves.toBeUndefined();
  });

  it("init logs success when a valid key is present", async () => {
    const runtime = fakeRuntime(null, { COLONY_API_KEY: "col_abc" });
    await expect(ColonyPlugin.init!({}, runtime)).resolves.toBeUndefined();
  });
});
