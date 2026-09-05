import { afterEach, describe, expect, it, vi } from "vitest";

import { isLinkActivation, linkTarget } from "./links";

/** The user agent is what `isMacOS` reads; nothing else here touches it. */
function onPlatform(agent: string) {
  vi.stubGlobal("navigator", { userAgent: agent });
}

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

const click = (mods: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  button: 0,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isLinkActivation", () => {
  it("ignores a click with no modifier, so clicking to focus never navigates", () => {
    onPlatform(LINUX);
    expect(isLinkActivation(click())).toBe(false);
  });

  it("opens on Ctrl+click off macOS", () => {
    onPlatform(LINUX);
    expect(isLinkActivation(click({ ctrlKey: true }))).toBe(true);
  });

  it("opens on Cmd+click on macOS, and not on Ctrl+click — which is a right click there", () => {
    onPlatform(MAC);
    expect(isLinkActivation(click({ metaKey: true }))).toBe(true);
    expect(isLinkActivation(click({ ctrlKey: true }))).toBe(false);
  });

  it("ignores anything but the primary button", () => {
    onPlatform(LINUX);
    expect(isLinkActivation(click({ button: 2, ctrlKey: true }))).toBe(false);
  });
});

describe("linkTarget", () => {
  it("passes web addresses through as parsed", () => {
    expect(linkTarget("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(linkTarget("  http://localhost:5173  ")).toBe("http://localhost:5173/");
  });

  it("refuses schemes that would start a program rather than open a page", () => {
    expect(linkTarget("file:///etc/passwd")).toBeNull();
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("vscode://file/tmp/x")).toBeNull();
  });

  it("refuses anything that is not a URL at all", () => {
    expect(linkTarget("example.com")).toBeNull();
    expect(linkTarget("")).toBeNull();
  });
});
