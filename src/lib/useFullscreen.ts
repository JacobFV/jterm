/**
 * Whether *this* window is fullscreen.
 *
 * Everything the app draws in place of a window frame — the buttons at the end
 * of the tab strip, the space held clear for macOS's traffic lights, the resize
 * grips over the edges — is chrome for a window that has edges. A fullscreen
 * window has none, and the OS hides its own frame there for exactly that
 * reason. Drawing ours anyway leaves a close button on a window that is not in
 * a stack of windows, and grips that grab nothing.
 *
 * The state is **asked of the window rather than remembered from the shortcut**,
 * because F11 is not the only way in: a compositor binding, a titlebar
 * double-click on some desktops, and macOS's own green button all put a window
 * fullscreen without the app hearing about it. Tauri has no fullscreen event, so
 * a resize stands in — going fullscreen is always one — which is the same trick
 * `WindowControls` already uses to keep the maximise glyph honest.
 *
 * Per window, not per app: the hook asks whichever webview it is running in, so
 * the settings window answers for itself rather than for the main one.
 *
 * False wherever there is no Tauri window to ask, which is the browser dev build
 * and the tests, and false for the first frame in every case — a moment of
 * chrome that then goes away is a far cheaper mistake than a fullscreen window
 * with no way out because the buttons were hidden before we knew.
 */

import { useEffect, useState } from "react";

import { isTauri } from "./tauri";

export function useIsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const sync = () => {
        void win.isFullscreen().then((value) => {
          if (!disposed) setFullscreen(value);
        });
      };
      sync();
      const stop = await win.onResized(sync);
      if (disposed) stop();
      else unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return fullscreen;
}
