/**
 * Clipboard access that works in a webview.
 *
 * `navigator.clipboard` is the right API and is tried first, but it is gated on
 * permissions and a user gesture that a synthetic keyboard shortcut does not
 * always satisfy — and on Linux WebKit `readText` is frequently unavailable
 * outright. Tauri's clipboard plugin goes through the platform instead and has
 * none of those conditions, so it is the fallback.
 */

import { isTauri } from "./tauri";

export async function writeClipboard(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* Fall through to the platform clipboard. */
  }
  if (!isTauri()) return;
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

export async function readClipboard(): Promise<string> {
  try {
    const text = await navigator.clipboard.readText();
    if (typeof text === "string") return text;
  } catch {
    /* Fall through to the platform clipboard. */
  }
  if (!isTauri()) return "";
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}
