/**
 * Artifacts: documents the agent makes for the user to look at.
 *
 * An HTML page, a markdown write-up, an SVG, a Mermaid diagram — shown in a
 * pane of its own rather than pasted into a column a few dozen characters
 * wide. The pane is `panes/ArtifactPane.tsx`; the tools that make and change
 * one are in `lib/mcp.ts`. This is the part of it that needs no DOM, so it can
 * be tested in node: what the formats are, how big one may be, and how an HTML
 * or SVG artifact is wrapped before it goes into its frame.
 *
 * The source itself lives where a notepad's text does — `state/content.ts`,
 * under the pane's id — and so is written into the session snapshot, carried
 * across to another window with the pane, and let go when the pane is closed,
 * all by the machinery that already does those things for notes.
 */

export type ArtifactFormat = "html" | "markdown" | "svg" | "mermaid";

export const ARTIFACT_FORMATS: ArtifactFormat[] = ["html", "markdown", "svg", "mermaid"];

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return typeof value === "string" && ARTIFACT_FORMATS.includes(value as ArtifactFormat);
}

/**
 * The largest artifact accepted, in characters.
 *
 * The source rides in the session snapshot, and the snapshot is rewritten every
 * time anything in the window changes — a keystroke at a prompt included. A
 * megabyte is a long report or a very detailed diagram; past it, what the agent
 * is making belongs in a file it opens with `open_file`, which costs the
 * snapshot nothing. Refused rather than cut short, because the front half of an
 * HTML page is not a smaller version of the page.
 */
export const MAX_ARTIFACT = 1024 * 1024;

/** The longest title kept, matching the cap the snapshot puts on every title. */
export const MAX_ARTIFACT_TITLE = 200;

export const FORMAT_LABEL: Record<ArtifactFormat, string> = {
  html: "HTML",
  markdown: "Markdown",
  svg: "SVG",
  mermaid: "Mermaid",
};

const EXTENSION: Record<ArtifactFormat, string> = {
  html: "html",
  markdown: "md",
  svg: "svg",
  mermaid: "mmd",
};

/** A file name to offer in the save dialog: the title, made safe to be one. */
export function suggestedFileName(title: string | undefined, format: ArtifactFormat): string {
  const stem = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80)
    .toLowerCase();
  return `${stem || "artifact"}.${EXTENSION[format]}`;
}

/* ── The frame an HTML or SVG artifact is drawn in ───────────────────────── */

/**
 * The colours a frame starts out in, before the page says anything.
 *
 * Resolved values, read off the pane: the frame is another document and cannot
 * see the app's custom properties, so `var(--term-bg)` would mean nothing in
 * there.
 */
export interface FramePalette {
  background: string;
  foreground: string;
  link: string;
  dark: boolean;
}

/**
 * Sent up by the frame when a link in it is clicked. See `LINK_SCRIPT`.
 *
 * A key with jterm's name on it rather than a bare string, so a page that posts
 * messages of its own to its parent — plenty of embeddable widgets do — is not
 * mistaken for a link.
 */
export const LINK_MESSAGE = "jtermArtifactLink";

/**
 * Links, sent to the user's browser instead of followed in the frame.
 *
 * A sandboxed frame without `allow-popups` or `allow-top-navigation` can only
 * navigate itself, which would turn the artifact into a cramped browser with no
 * address bar and no way back short of Reload. So a click on a link is turned
 * into a message, and the pane decides whether to open it (`ArtifactPane`). A
 * fragment link is left alone — that is the page scrolling itself — and so is
 * a click the page's own script has already handled, which is how a page that
 * routes its own links keeps working.
 *
 * Anything else is cancelled whether or not it is sent up: a relative link in a
 * `srcdoc` frame resolves against the app's own URL, and the frame would load
 * jterm into itself.
 */
const LINK_SCRIPT = `<script>
addEventListener("click", function (event) {
  if (event.defaultPrevented || event.button !== 0) return;
  var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  var href = anchor.getAttribute("href") || "";
  if (href.charAt(0) === "#") return;
  event.preventDefault();
  if (/^(https?|mailto):/i.test(anchor.href)) {
    parent.postMessage({ ${LINK_MESSAGE}: anchor.href }, "*");
  }
});
</script>`;

/**
 * The document an HTML or SVG artifact is shown as, ready for `srcdoc`.
 *
 * Two things are added to what the agent wrote. A default look — the theme's
 * background, text and link colours — so that a page with no stylesheet is not
 * a white slab in a dark window; it is written with `:where()`, which has no
 * specificity at all, so any rule the page brings wins over it. And the link
 * handler above.
 *
 * Both go just inside `<head>` (or the nearest thing the page has to one)
 * rather than in front of everything, because anything before a doctype puts
 * the page in quirks mode and changes how it lays out.
 */
export function frameDocument(
  format: "html" | "svg",
  source: string,
  palette: FramePalette,
): string {
  const head = `${defaultStyle(palette)}${LINK_SCRIPT}`;
  if (format === "svg") return svgDocument(source, head);
  return injectHead(source, head);
}

function defaultStyle(palette: FramePalette): string {
  const background = cssValue(palette.background, "Canvas");
  const foreground = cssValue(palette.foreground, "CanvasText");
  const link = cssValue(palette.link, "LinkText");
  return (
    `<style>` +
    `:where(:root){color-scheme:${palette.dark ? "dark" : "light"};` +
    `background:${background};color:${foreground};` +
    `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5}` +
    `:where(a){color:${link}}` +
    `</style>`
  );
}

/**
 * A colour, made safe to write into a stylesheet.
 *
 * The values come from the theme, which a user can write themselves; one with
 * a `<` in it could close the style element and start writing markup. Anything
 * outside the characters a colour is spelled with is refused for the fallback.
 */
function cssValue(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed && /^[\w#%(),.\s/-]+$/.test(trimmed) ? trimmed : fallback;
}

function injectHead(html: string, head: string): string {
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}${head}${html.slice(at)}`;
    }
  }
  return `${head}${html}`;
}

/**
 * An SVG, centred in a page of its own and scaled to fit the pane.
 *
 * The XML prolog and doctype an SVG file often starts with mean nothing inline
 * in HTML and are dropped.
 */
function svgDocument(svg: string, head: string): string {
  const body = svg.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!doctype[^>]*>\s*)?/i, "");
  return (
    `<!doctype html><html><head><meta charset="utf-8">${head}` +
    `<style>html,body{height:100%;margin:0}` +
    `body{display:flex;align-items:center;justify-content:center;` +
    `box-sizing:border-box;padding:12px}` +
    `body>svg{max-width:100%;max-height:100%;height:auto}</style>` +
    `</head><body>${body}</body></html>`
  );
}

/**
 * Whether a computed colour is a dark one — for the frame's `color-scheme`,
 * which decides how its scrollbars and form controls are drawn.
 *
 * Takes what `getComputedStyle` gives back, which is `rgb()` or `rgba()`
 * whatever the theme spelled it as. Anything else is taken to be dark, which is
 * what most of the themes are.
 */
export function isDarkColour(computed: string): boolean {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(computed);
  if (!match) return true;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const channel = Number(part) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18;
}
