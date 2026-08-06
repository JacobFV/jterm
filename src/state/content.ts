/**
 * Pane contents, deliberately outside React.
 *
 * The two things in here — a terminal's unsubmitted command line and a
 * notepad's text — change on every keystroke. Holding them in React state
 * would re-render every open pane per character typed, and a terminal that
 * stutters while you type is not worth the architectural tidiness.
 *
 * So they are a plain mutable map. Writers call `update`, which marks the
 * store dirty; the persistence layer subscribes and decides when that becomes
 * a disk write. Nothing here re-renders anything.
 */

export interface PaneContent {
  /** A terminal's typed-but-not-yet-submitted line. */
  draft?: string;
  /** A notepad's full text. */
  text?: string;
  /** A notepad's caret, so a restored note reopens where you left it. */
  caret?: number;
}

type Listener = () => void;

const contents = new Map<string, PaneContent>();
const listeners = new Set<Listener>();

export function getContent(paneId: string): PaneContent {
  return contents.get(paneId) ?? {};
}

export function updateContent(paneId: string, patch: PaneContent): void {
  const current = contents.get(paneId) ?? {};
  const next = { ...current, ...patch };
  // Writers fire on every keystroke; most of those genuinely change something,
  // but the guard keeps a no-op edit from scheduling a disk write.
  if (
    current.draft === next.draft &&
    current.text === next.text &&
    current.caret === next.caret
  ) {
    return;
  }
  contents.set(paneId, next);
  for (const listener of listeners) listener();
}

export function dropContent(paneId: string): void {
  if (contents.delete(paneId)) {
    for (const listener of listeners) listener();
  }
}

/** Contents for the panes still open, so closed panes are not carried forward. */
export function snapshotContent(livePaneIds: Iterable<string>): Record<string, PaneContent> {
  const out: Record<string, PaneContent> = {};
  for (const paneId of livePaneIds) {
    const content = contents.get(paneId);
    if (!content) continue;
    if (content.draft || content.text) out[paneId] = content;
  }
  return out;
}

export function loadContent(record: Record<string, PaneContent>): void {
  contents.clear();
  for (const [paneId, content] of Object.entries(record)) {
    contents.set(paneId, content);
  }
}

export function onContentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
