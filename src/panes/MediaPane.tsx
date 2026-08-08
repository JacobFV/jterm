/**
 * Video and audio.
 *
 * One component for both: an `<audio>` element is a `<video>` element with
 * nothing to draw, and treating them separately would duplicate the whole of
 * this file to remove one CSS class.
 *
 * What plays is decided by the webview, not by this app, and the three
 * platforms do not agree. WebKit on Linux will not play H.264 unless the
 * distribution shipped the codec, and almost nothing plays Matroska. Rather
 * than pretend otherwise, a file that will not play says so and offers to hand
 * itself to a real media player.
 */

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { assetUrl, openPath } from "@/lib/ipc";
import { fileName, isAudio } from "@/lib/filetypes";
import type { MediaPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

export function MediaPane({ pane, visible, onFocus }: PaneProps<MediaPaneState>) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const audioOnly = isAudio(pane.path);

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

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-3">
          {pane.path}
        </span>
        <button
          type="button"
          title="Open in your default player"
          aria-label="Open in your default player"
          onClick={() => void openPath(pane.path)}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-hairline-strong px-1.5 text-[length:var(--fs-10)] text-ink-2 hover:bg-surface-2 hover:text-ink-1"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2">
        {failed ? (
          <p className="max-w-sm px-4 text-center font-mono text-[length:var(--fs-11)] text-ink-3">
            {fileName(pane.path)} will not play here — this window has no codec for it.
            Use <span className="text-ink-1">Open</span> above to play it in your usual
            player.
          </p>
        ) : src ? (
          // `key` on the source path so switching files reloads the element
          // rather than leaving the previous one paused underneath.
          audioOnly ? (
            <audio
              key={src}
              src={src}
              controls
              // Paused when the pane is off screen: a backgrounded tab quietly
              // playing sound is a bug, not a feature.
              autoPlay={false}
              muted={!visible}
              onError={() => setFailed(true)}
              className="w-full max-w-lg"
            />
          ) : (
            <video
              key={src}
              src={src}
              controls
              playsInline
              onError={() => setFailed(true)}
              className="max-h-full max-w-full"
            />
          )
        ) : null}
      </div>
    </div>
  );
}
