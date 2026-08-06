/**
 * Which pane opens a given file.
 *
 * By extension, which is a guess — but the alternative is sniffing content,
 * which means reading part of every file before knowing whether it is the kind
 * of file worth reading. For a viewer that opens what the user just pointed at,
 * the extension is what the user meant.
 *
 * Anything unrecognised opens in the editor. That is deliberately the fallback
 * rather than an error: a `Dockerfile`, a `.env`, a `Makefile` and a file with
 * no extension at all are all text, and refusing them would be wrong far more
 * often than opening a binary in the editor is.
 */

import type { PaneKind } from "@/state/workspace";

const IMAGE = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff",
]);

const MEDIA = new Set([
  "mp4", "webm", "mkv", "mov", "m4v", "ogv", "avi",
  "mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus",
]);

const MODEL = new Set(["stl"]);

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // A leading dot is the start of a hidden file's name, not an extension:
  // `.gitignore` has no extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function kindForPath(path: string): PaneKind {
  const extension = extensionOf(path);
  if (IMAGE.has(extension)) return "image";
  if (MEDIA.has(extension)) return "media";
  if (MODEL.has(extension)) return "model";
  return "notepad";
}

/** True when the media file is sound only, so the pane draws no picture. */
export function isAudio(path: string): boolean {
  return ["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"].includes(extensionOf(path));
}

/**
 * The CodeMirror language for a file, loaded on demand.
 *
 * Every grammar is a dynamic import: bundling a dozen of them into the initial
 * load would cost every launch of the app for a feature most sessions never
 * touch.
 */
export async function languageFor(path: string) {
  const extension = extensionOf(path);
  const name = fileName(path).toLowerCase();

  switch (true) {
    case ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension):
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: extension.startsWith("ts"),
        jsx: extension.endsWith("x"),
      });
    case extension === "py" || extension === "pyi":
      return (await import("@codemirror/lang-python")).python();
    case extension === "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case ["json", "jsonc", "webmanifest"].includes(extension):
      return (await import("@codemirror/lang-json")).json();
    case ["html", "htm", "vue", "svelte"].includes(extension):
      return (await import("@codemirror/lang-html")).html();
    case ["css", "scss", "less"].includes(extension):
      return (await import("@codemirror/lang-css")).css();
    case ["md", "markdown", "mdx"].includes(extension):
      return (await import("@codemirror/lang-markdown")).markdown();
    case ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"].includes(extension):
      return (await import("@codemirror/lang-cpp")).cpp();
    case ["yml", "yaml"].includes(extension):
      return (await import("@codemirror/lang-yaml")).yaml();
    case extension === "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case ["xml", "svg", "xsl", "plist"].includes(extension):
      return (await import("@codemirror/lang-xml")).xml();
    // Files whose *name* is the type. Common enough to be worth the special
    // case, since none of them has an extension to go on.
    case name === "dockerfile" || name.startsWith("dockerfile."):
      return (await import("@codemirror/lang-yaml")).yaml();
    default:
      return null;
  }
}
