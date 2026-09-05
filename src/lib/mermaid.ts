/**
 * Mermaid diagrams, in the pane's own colours.
 *
 * A module of its own so that the library is a chunk of its own: mermaid is
 * well over a megabyte, and most documents contain no diagrams at all. Nothing
 * imports this statically — `MarkdownPreview` reaches it only after it has
 * found a diagram to draw.
 *
 * The palette is taken from the CSS variables in force at the element being
 * drawn into, which is what makes a diagram wear the same theme as the terminal
 * beside it. Mermaid cannot read custom properties itself: it computes derived
 * colours (borders, contrasting label text) from the values it is given, so it
 * needs the resolved values rather than `var(--term-blue)`.
 */

/** Where a failed diagram's message is kept short enough to read in a pane. */
const MAX_ERROR = 300;

let configured = false;

export async function renderMermaid(host: HTMLElement, blocks: HTMLElement[]): Promise<void> {
  const mermaid = (await import("mermaid")).default;

  const styles = getComputedStyle(host);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  // Re-initialised on every run rather than once: the pane's theme can change
  // under it, and mermaid holds the palette in module state.
  mermaid.initialize({
    startOnLoad: false,
    // Labels in a diagram are text from the document, which is a file someone
    // else wrote. Strict is mermaid's own sanitising mode; the SVG that comes
    // back is inserted as markup, so this is load bearing rather than tidy.
    securityLevel: "strict",
    theme: "base",
    fontFamily: token("--font-mono", "monospace"),
    themeVariables: {
      background: token("--term-bg", "#101010"),
      primaryColor: token("--term-bright-black", "#303030"),
      primaryTextColor: token("--term-fg", "#e8e8e8"),
      primaryBorderColor: token("--term-blue", "#5a9bd5"),
      secondaryColor: token("--term-black", "#202020"),
      tertiaryColor: token("--term-black", "#202020"),
      lineColor: token("--term-white", "#b0b0b0"),
      textColor: token("--term-fg", "#e8e8e8"),
      noteBkgColor: token("--term-black", "#202020"),
      noteTextColor: token("--term-fg", "#e8e8e8"),
    },
  });
  configured = true;

  for (const [index, block] of blocks.entries()) {
    const source = block.textContent ?? "";
    const figure = document.createElement("div");
    figure.className = "markdown-mermaid";

    try {
      // The id has to be unique per render: mermaid uses it for the ids inside
      // the SVG, and two diagrams sharing one would cross their arrow markers.
      const { svg } = await mermaid.render(`mermaid-${Date.now().toString(36)}-${index}`, source);
      figure.innerHTML = svg;
    } catch (error) {
      // A diagram that will not parse is shown as the code it was, with the
      // reason under it. Silently dropping it would leave a hole in the
      // document with nothing to say what happened.
      figure.className = "markdown-mermaid-failed";
      const code = document.createElement("pre");
      code.textContent = source;
      const message = document.createElement("p");
      message.textContent = String(error instanceof Error ? error.message : error).slice(
        0,
        MAX_ERROR,
      );
      figure.append(code, message);
    }

    block.replaceWith(figure);
  }
}

/** Whether mermaid has been set up in this window yet. Exported for tests. */
export function isConfigured(): boolean {
  return configured;
}
