/**
 * Which window chrome this build is running under.
 *
 * The platforms do not get the same deal, and the difference is load bearing
 * rather than cosmetic:
 *
 *   - macOS keeps `decorations: true` with `titleBarStyle: "Overlay"`, so the
 *     real traffic lights float over the webview. The app draws no buttons and
 *     the OS still owns resizing.
 *   - Windows and Linux run undecorated. The app owns the buttons, the drag
 *     region, and the resize edges.
 *
 * See `src-tauri/tauri.macos.conf.json` for the override that splits them.
 */

/** Width reserved at the strip's left edge for macOS traffic lights. */
export const MACOS_TRAFFIC_LIGHT_INSET_PX = 78;

function userAgent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

export function isMacOS(): boolean {
  // `navigator.platform` is deprecated and `userAgentData` is not in WKWebView,
  // so the user-agent string is what is actually available here.
  return /Mac OS X|Macintosh/.test(userAgent());
}

/**
 * True when the OS draws the window frame — macOS only.
 *
 * Everything the app has to supply itself (window buttons, resize handles) is
 * gated on this being false, so a platform that keeps native chrome never gets
 * a second, redundant set drawn over it.
 */
export function usesNativeWindowChrome(): boolean {
  return isMacOS();
}

export function isWindows(): boolean {
  return /Windows/.test(userAgent());
}

/**
 * Linux, for the purpose of deciding which window buttons to draw.
 *
 * Everything that is not macOS or Windows is treated as Linux here: the app
 * only ships to three platforms, and a wrong guess costs the shape of three
 * buttons rather than anything that matters.
 */
export function isLinux(): boolean {
  return !isMacOS() && !isWindows();
}
