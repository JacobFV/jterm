import { describe, expect, it } from "vitest";

import type { UpdateState } from "./ipc";
import { shouldInstallQuietly } from "./updates";

/** A copy that can update itself quietly and has found something newer. */
function found(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    current: "0.8.5",
    unsupported: null,
    install: "quiet",
    available: { version: "0.8.6", notes: null, date: null },
    installing: false,
    installed: null,
    error: null,
    ...overrides,
  };
}

describe("shouldInstallQuietly", () => {
  it("installs what it found when that needs nothing from anyone", () => {
    expect(shouldInstallQuietly(found(), true)).toBe(true);
  });

  it("does nothing when the setting is off", () => {
    expect(shouldInstallQuietly(found(), false)).toBe(false);
  });

  it("never starts a password prompt or closes the app on its own", () => {
    expect(shouldInstallQuietly(found({ install: "password" }), true)).toBe(false);
    expect(shouldInstallQuietly(found({ install: "quits" }), true)).toBe(false);
  });

  it("leaves alone a copy that cannot update, has nothing new, or is already at it", () => {
    expect(shouldInstallQuietly(found({ unsupported: "a development build" }), true)).toBe(false);
    expect(shouldInstallQuietly(found({ available: null }), true)).toBe(false);
    expect(shouldInstallQuietly(found({ installing: true }), true)).toBe(false);
    expect(shouldInstallQuietly(null, true)).toBe(false);
  });
});
