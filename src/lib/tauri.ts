/**
 * Whether the app is running inside the Tauri shell or in a plain browser.
 *
 * `npm run dev` opens on localhost with no backend behind it, which is a useful
 * way to work on the chrome. Everything that would call into Rust checks this
 * first and degrades to an inert version rather than throwing.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
