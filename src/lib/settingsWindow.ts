/**
 * Settings, in a window of its own.
 *
 * It is the same bundle: one `index.html`, and a hash on the URL decides which
 * of the two roots `main.tsx` mounts. That keeps the settings window on the
 * same design tokens, the same window chrome and the same settings store as
 * the app, at the cost of one `if`.
 *
 * A window rather than a sheet over the app because settings here are not a
 * question being asked — they are a thing being adjusted while you watch the
 * effect. Changing the terminal's font size is worth doing with the terminal
 * visible, and a modal is precisely the shape that makes that impossible.
 *
 * The second window is dropped straight into the platform's own conventions:
 * native decorations on macOS with the traffic lights floating over the page,
 * and jterm's own titlebar and resize grips everywhere else — the same split
 * `lib/platform.ts` describes for the main window.
 */

import { usesNativeWindowChrome } from "./platform";
import { isTauri } from "./tauri";

const ROUTE = "#/settings";
const LABEL = "settings";

export function isSettingsRoute(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith(ROUTE);
}

/**
 * Show the settings window, creating it only if it is not already there.
 *
 * Pressing the shortcut twice must raise the window rather than open a second
 * one — two windows editing one file would be a race with nothing to gain.
 */
export async function openSettingsWindow(): Promise<void> {
  if (!isTauri()) {
    // `npm run dev` in a plain browser. A popup is the nearest real window
    // available, and `BroadcastChannel` carries changes back (see
    // `state/settings.ts`).
    window.open(`${window.location.pathname}${ROUTE}`, "jterm-settings", "popup,width=580,height=760");
    return;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing !== null) {
    await existing.setFocus();
    return;
  }

  const native = usesNativeWindowChrome();
  new WebviewWindow(LABEL, {
    url: `index.html${ROUTE}`,
    title: "jterm — Settings",
    width: 580,
    height: 760,
    minWidth: 420,
    minHeight: 380,
    resizable: true,
    center: true,
    decorations: native,
    ...(native ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : {}),
  });
}

/** Close the settings window from inside it. */
export async function closeSettingsWindow(): Promise<void> {
  if (!isTauri()) {
    window.close();
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}
