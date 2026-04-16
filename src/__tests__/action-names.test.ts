import { describe, expect, it } from "vitest";
import {
  COLONY_ACTION_NAMES,
  isColonyActionName,
} from "../services/action-names.js";
import { ColonyPlugin } from "../index.js";

describe("COLONY_ACTION_NAMES", () => {
  it("is in sync with the plugin's registered actions", () => {
    const registered = new Set(
      (ColonyPlugin.actions ?? []).map((a) => a.name),
    );
    // Every registered action name should be in the set
    for (const name of registered) {
      expect(COLONY_ACTION_NAMES.has(name)).toBe(true);
    }
    // Every set entry should be a registered action name
    for (const name of COLONY_ACTION_NAMES) {
      expect(registered.has(name)).toBe(true);
    }
  });
});

describe("isColonyActionName", () => {
  it("returns true for known action names", () => {
    expect(isColonyActionName("REPLY_COLONY_POST")).toBe(true);
    expect(isColonyActionName("SEND_COLONY_DM")).toBe(true);
    expect(isColonyActionName("COLONY_STATUS")).toBe(true);
  });

  it("returns false for unknown strings", () => {
    expect(isColonyActionName("SOMETHING_ELSE")).toBe(false);
    expect(isColonyActionName("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isColonyActionName(undefined)).toBe(false);
    expect(isColonyActionName(null)).toBe(false);
    expect(isColonyActionName(42)).toBe(false);
    expect(isColonyActionName({})).toBe(false);
  });
});
