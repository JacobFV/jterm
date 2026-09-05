/**
 * An image viewer.
 *
 * The file is loaded through the `asset:` protocol rather than read into
 * memory and turned into a data URL — a 40 megapixel photo would otherwise
 * become a 60 MB base64 string on its way through IPC, for a picture the
 * platform can decode straight from disk.
 *
 * Zoom starts at "fit", because that is the answer to "what is in this file".
 * Clicking switches to 1:1, which is the answer to "is this pixel right".
 *
 * An SVG has a second honest answer — it is a text file — so for those the pane
 * also offers the source. Drawn as text in the pane, never handed to anything
 * that would execute it: an `<img>` cannot run script in an SVG, and the source
 * view is exactly that, source.
 */

import { useEffect, useState } from "react";
import { assetUrl, files } from "@/lib/ipc";
import { extensionOf, fileName } from "@/lib/filetypes";
import { cn } from "@/lib/utils";
import type { ImagePaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

export function ImagePane({ pane, onFocus }: PaneProps<ImagePaneState>) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const vector = extensionOf(pane.path) === "svg";
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void assetUrl(pane.path).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pane.path]);

  // Read only once the source is actually asked for: most pictures are not
  // SVGs, and most SVGs are looked at rather than read.
  useEffect(() => {
    if (!showSource || source !== null) return;
    let cancelled = false;
    void files.readText(pane.path).then((file) => {
      if (!cancelled) setSource(file?.contents ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [showSource, source, pane.path]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-3">
          {pane.path}
        </span>
        {dimensions ? (
          <span className="shrink-0 font-mono text-[length:var(--fs-10)] text-ink-4">
            {dimensions.width}×{dimensions.height}
          </span>
        ) : null}
        {vector ? (
          <button
            type="button"
            title={showSource ? "Show the picture" : "Show the SVG source"}
            onClick={() => setShowSource((value) => !value)}
            className="shrink-0 rounded-sm border border-hairline-strong px-1.5 text-[length:var(--fs-10)] text-ink-2 hover:bg-surface-2 hover:text-ink-1"
          >
            {showSource ? "Preview" : "Raw"}
          </button>
        ) : null}
        {showSource ? null : (
          <button
            type="button"
            onClick={() => setActualSize((value) => !value)}
            className="shrink-0 rounded-sm border border-hairline-strong px-1.5 text-[length:var(--fs-10)] text-ink-2 hover:bg-surface-2 hover:text-ink-1"
          >
            {actualSize ? "Fit" : "1:1"}
          </button>
        )}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1",
          showSource
            ? "overflow-hidden"
            : actualSize
              ? "overflow-auto"
              : "flex items-center justify-center overflow-hidden p-3",
        )}
      >
        {showSource ? (
          <pre className="h-full w-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[length:var(--fs-11)] text-ink-2">
            {source ?? ""}
          </pre>
        ) : failed ? (
          <p className="p-4 font-mono text-[length:var(--fs-11)] text-danger">
            {fileName(pane.path)} could not be displayed.
          </p>
        ) : src ? (
          <img
            src={src}
            alt={fileName(pane.path)}
            onLoad={(event) =>
              setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            className={cn(
              // A checkerboard would be busier than this palette wants; a plain
              // dark ground is enough to read transparency against.
              actualSize ? "max-w-none" : "max-h-full max-w-full object-contain",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
