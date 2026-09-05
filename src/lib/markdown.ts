/**
 * Markdown, turned into something safe to put on the page.
 *
 * The whole of the risk here is in one sentence: a markdown file is a file
 * *somebody else wrote*, and this app's DOM is a Tauri webview with the IPC
 * bridge in it. HTML in a README that reached the page unfiltered would be
 * script running with the app's own reach — able to call into the backend,
 * read the session, spawn a shell. So everything goes through DOMPurify before
 * it is anywhere near the document, and nothing is ever assembled by hand from
 * a string.
 *
 * Rendering is deliberately not done in a webview or an iframe. WebKitGTK's
 * nested webviews are unreliable on Linux — the browser pane is the standing
 * evidence — and a viewer that only works on two platforms is not a viewer.
 * This is plain DOM in the pane, drawn with the pane's own theme tokens.
 *
 * Three things are then patched up afterwards, in the DOM rather than in the
 * markup, because each needs to know something the parser does not:
 *
 *   - **Relative images** need the file's directory, and the `asset:` URL that
 *     lets the webview read outside its origin.
 *   - **Mermaid** is a whole parser of its own and a megabyte of it, so the
 *     library is fetched only if a diagram is actually on the page.
 *   - **Links** have to leave through the opener plugin. A markdown pane is not
 *     a browser and must never become one.
 */

import { marked } from "marked";

/** Files this pane offers a preview for. */
const MARKDOWN = new Set(["md", "markdown", "mdx", "mkd", "mdown"]);

export function isMarkdownPath(path: string | undefined): boolean {
  if (!path) return false;
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && MARKDOWN.has(name.slice(dot + 1).toLowerCase());
}

/** The directory a file lives in, keeping the separator the path already uses. */
export function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * Whether a link or image target points somewhere outside the file system.
 *
 * `http:` and `data:` are for the browser and the page respectively; anything
 * with a scheme is left alone rather than being treated as a file name that
 * happens to contain a colon.
 */
export function hasScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * A path in a markdown file, resolved against the file's own directory.
 *
 * `null` for anything that is not a relative file path — a URL, a fragment, an
 * empty string — which is the caller's signal to leave it exactly as it is.
 *
 * `..` is honoured because documentation does use it (`../images/x.png`), and
 * climbing out of the directory is not a privilege boundary here: the pane can
 * already open any file the user can, and the user is the one who opened this
 * document.
 */
export function resolveRelative(dir: string, target: string): string | null {
  if (!target || target.startsWith("#") || hasScheme(target)) return null;

  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const absolute = target.startsWith("/") || /^[a-z]:[\\/]/i.test(target);
  const base = absolute ? "" : dir;
  const rooted = absolute ? target.startsWith("/") : base.startsWith("/");

  const parts: string[] = [];
  for (const piece of `${base}${base && !absolute ? separator : ""}${target}`.split(/[\\/]/)) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }

  const joined = parts.join(separator);
  return rooted ? `${separator === "\\" ? "\\" : "/"}${joined}` : joined;
}

/**
 * Markdown to HTML, sanitised.
 *
 * Sanitising happens here rather than at the call site so there is no version
 * of this function that returns markup nobody has checked. The import is lazy
 * for one dull reason: DOMPurify binds itself to a `window` at module scope,
 * and this module is also loaded by tests that run in Node.
 */
export async function renderMarkdown(text: string): Promise<string> {
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  const { default: DOMPurify } = await import("dompurify");
  return DOMPurify.sanitize(html, {
    // Mermaid's output is SVG, and so is half of what a README embeds.
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    // Kept out on purpose: a document deciding it should be full-screen, or
    // pointing an `<a>` at a frame that does not exist here.
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset", "formaction", "target"],
  });
}

/** Every mermaid block the renderer left behind, as `<pre>` elements. */
export function mermaidBlocks(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll("pre > code.language-mermaid")]
    .map((code) => code.parentElement)
    .filter((pre): pre is HTMLElement => pre !== null);
}
