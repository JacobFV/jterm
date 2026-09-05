/**
 * A rendered markdown document, drawn in the pane itself.
 *
 * Plain DOM, deliberately — no iframe and no second webview. Nested webviews
 * are unreliable under WebKitGTK (see `BrowserPane`), and a preview that only
 * worked on macOS and Windows would be worse than none. Drawing it here also
 * means the document inherits the pane's theme tokens, so a README in a
 * Solarized pane is Solarized.
 *
 * Everything the parser could not know is fixed up afterwards, against the real
 * DOM, in `decorate`:
 *
 *   - **Images** are rewritten to `asset:` URLs, resolved against the
 *     document's own directory, because `<img src="diagram.svg">` in a file on
 *     disk means the file beside it and the webview cannot read a bare path.
 *   - **Mermaid** blocks become SVG. The library is over a megabyte, so it is
 *     imported only when a document actually contains a diagram — most do not.
 *   - **Links** are handed to the opener plugin on click. A preview is not a
 *     browser, and must not quietly become one.
 *
 * The render is generation-guarded: it is asynchronous in three places, and a
 * document that changed while an old render was still resolving must not have
 * the old one land on top of it.
 */

import { useEffect, useRef } from "react";

import { assetUrl, openExternal } from "@/lib/ipc";
import { directoryOf, mermaidBlocks, renderMarkdown, resolveRelative } from "@/lib/markdown";
import { linkTarget } from "@/lib/links";

export function MarkdownPreview({ text, path }: { text: string; path?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Bumped by every render; a slow one that comes back stale is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const mine = ++generation.current;
    const dir = path ? directoryOf(path) : "";

    void (async () => {
      const html = await renderMarkdown(text);
      if (generation.current !== mine || hostRef.current === null) return;
      host.innerHTML = html;
      await decorate(host, dir, () => generation.current === mine);
    })();
  }, [text, path]);

  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      // Links go to the real browser rather than anywhere in here. Caught on
      // the container rather than bound per link, because the content is
      // replaced wholesale on every render and listeners would go with it.
      onClick={(event) => {
        const anchor = (event.target as HTMLElement | null)?.closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return;
        event.preventDefault();
        const target = linkTarget(href);
        if (target !== null) void openExternal(target);
      }}
    >
      <div ref={hostRef} className="markdown mx-auto max-w-[68ch] px-4 py-3" />
    </div>
  );
}

/**
 * The three passes that need the DOM rather than the markup.
 *
 * `alive` is checked after every await: each of these yields, and a preview
 * whose document has moved on in the meantime should stop rather than decorate
 * a tree that is no longer on screen.
 */
async function decorate(host: HTMLElement, dir: string, alive: () => boolean): Promise<void> {
  for (const image of [...host.querySelectorAll("img")]) {
    const source = image.getAttribute("src");
    const resolved = source === null ? null : resolveRelative(dir, source);
    if (resolved === null) continue;
    const url = await assetUrl(resolved);
    if (!alive()) return;
    image.setAttribute("src", url);
  }

  const diagrams = mermaidBlocks(host);
  if (diagrams.length === 0) return;

  const { renderMermaid } = await import("@/lib/mermaid");
  if (!alive()) return;
  await renderMermaid(host, diagrams);
}
