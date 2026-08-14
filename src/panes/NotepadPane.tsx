/**
 * The text pane: a scratch note, or a file being edited.
 *
 * One component covers both because they are the same thing at different
 * moments. A note with no path is a buffer that survives crashes and nothing
 * more; give it a path — by opening a file into it, or by saving it — and it
 * becomes an editor for that file. The only difference in behaviour is where
 * `Save` writes, and whether the pane can be dirty relative to something.
 *
 * Two kinds of durability are at work and they are not the same promise:
 *
 *   - The **buffer** is written to the session snapshot continuously, so a
 *     crash never costs what you typed. This happens whether or not the pane
 *     has a file, and whether or not you saved.
 *   - The **file** is only written when you save. A crash therefore leaves the
 *     file untouched and the unsaved buffer recoverable, which is the right way
 *     round: nothing is silently written over your file, and nothing is lost.
 *
 * CodeMirror rather than a `<textarea>` because the pane needed highlighting,
 * and because a textarea's undo history is not something that can be reasoned
 * about once the document is also being restored from a snapshot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Save } from "lucide-react";

import { dialog, files } from "@/lib/ipc";
import { fileName, languageFor } from "@/lib/filetypes";
import { cn } from "@/lib/utils";
import { getContent, updateContent } from "@/state/content";
import { subscribeSettings } from "@/state/settings";
import type { NotepadPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

/**
 * The highlighting palette, built from the same ANSI tokens the terminal uses.
 *
 * Deliberately not one of the ready-made themes: a note pane sitting next to a
 * terminal showing the same source file should not colour it two different
 * ways.
 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--term-magenta)" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "var(--term-magenta)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: "var(--term-fg)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--term-blue)" },
  { tag: [tags.propertyName], color: "var(--term-cyan)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--term-yellow)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--term-bright-yellow)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--term-green)" },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], color: "var(--term-bright-black)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: "var(--term-white)" },
  { tag: [tags.meta, tags.processingInstruction], color: "var(--term-cyan)" },
  { tag: tags.heading, color: "var(--term-bright-yellow)", fontWeight: "600" },
  { tag: tags.link, color: "var(--term-blue)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--term-red)" },
]);

const THEME = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--term-fg)",
      // The same size the terminal is drawn at, and the same variable, so
      // `Mod+=` moves both. A pane showing a file beside a shell printing the
      // same file should not be two sizes of the same font.
      fontSize: "var(--mono-font-size)",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      padding: "8px 0",
      caretColor: "var(--term-cursor)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--term-cursor)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--term-selection)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--term-bright-black)",
      border: "none",
      fontFamily: "var(--font-mono)",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.025)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--term-white)" },
    ".cm-scroller": { overflow: "auto", lineHeight: "1.55" },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

/**
 * Holds the language slot open.
 *
 * The grammar is fetched after the editor already exists, and CodeMirror's
 * configuration is immutable. A compartment is the supported way to swap one
 * extension later without rebuilding the state — rebuilding it would discard
 * the document, the cursor and the undo history along with it.
 */
const languageSlot = new Compartment();

function baseExtensions(onChange: (text: string, caret: number) => void): Extension[] {
  return [
    languageSlot.of([]),
    lineNumbers(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(HIGHLIGHT, { fallback: true }),
    THEME,
    EditorView.lineWrapping,
    // `indentWithTab` goes last so it does not shadow the default bindings.
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;
      onChange(update.state.doc.toString(), update.state.selection.main.head);
    }),
  ];
}

export function NotepadPane({ pane, focused, onMeta, onFocus }: PaneProps<NotepadPaneState>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedTextRef = useRef<string>("");
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  const paneId = pane.id;
  const path = pane.path;
  const [error, setError] = useState<string | null>(null);
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);

  const initialRef = useRef(getContent(paneId));

  const record = useCallback(
    (text: string, caret: number) => {
      updateContent(paneId, { text, caret });
      const dirty = text !== savedTextRef.current;
      // Only reported when it changes: the reducer drops equal patches, but the
      // dispatch itself is not free on every keystroke.
      metaRef.current({ dirty });
    },
    [paneId],
  );

  /* ── The editor itself ────────────────────────────────────────────── */

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialRef.current.text ?? "",
        extensions: baseExtensions(record),
      }),
      parent: host,
    });
    viewRef.current = view;

    const caret = initialRef.current.caret;
    if (typeof caret === "number") {
      const at = Math.min(caret, view.state.doc.length);
      view.dispatch({ selection: { anchor: at } });
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [paneId, record]);

  /**
   * Re-measure when the type size moves.
   *
   * CodeMirror caches the character width and line height it took from the last
   * layout, and the size reaches it as a CSS variable — nothing it wrote, so
   * nothing it is watching. Left alone after a zoom it draws the text at the
   * new size and puts the cursor, the gutter and the scroll height where the
   * old one had them.
   */
  useEffect(() => subscribeSettings(() => viewRef.current?.requestMeasure()), []);

  /* ── The file, when there is one ──────────────────────────────────── */

  useEffect(() => {
    if (!path) {
      savedTextRef.current = "";
      return;
    }
    let cancelled = false;

    void (async () => {
      // Highlighting is chosen from the path and loaded on demand, so a session
      // that never opens a `.rs` file never downloads a Rust grammar.
      const language = await languageFor(path);
      if (cancelled || viewRef.current === null) return;
      if (language) {
        viewRef.current.dispatch({ effects: languageSlot.reconfigure(language) });
      }
    })();

    void (async () => {
      // A pane restored from a snapshot already has the buffer it had at the
      // crash, which may be *newer* than the file. Re-reading would throw that
      // away, so the file is only read when the buffer is empty.
      if (initialRef.current.text !== undefined) return;
      const file = await files.readText(path);
      if (cancelled || file === null || viewRef.current === null) return;
      if (file.lossy) {
        setReadOnlyReason("This file is not text — it is shown repaired and cannot be saved.");
      }
      savedTextRef.current = file.contents;
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: file.contents },
      });
      updateContent(paneId, { text: file.contents, caret: 0 });
      metaRef.current({ dirty: false });
    })();

    return () => {
      cancelled = true;
    };
  }, [path, paneId]);

  useEffect(() => {
    if (focused) viewRef.current?.focus();
  }, [focused]);

  /* ── Saving ───────────────────────────────────────────────────────── */

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (view === null) return;
    if (readOnlyReason) {
      setError(readOnlyReason);
      return;
    }

    const text = view.state.doc.toString();
    // A note with no home is asked where it should live; after that it is an
    // ordinary file-backed pane.
    const target = path ?? (await dialog.save("untitled.txt"));
    if (!target) return;

    try {
      await files.writeText(target, text);
      savedTextRef.current = text;
      setError(null);
      metaRef.current({ path: target, dirty: false });
    } catch (cause) {
      setError(String(cause));
    }
  }, [path, readOnlyReason]);

  // Ctrl/Cmd+S is handled here rather than in the global keymap because it only
  // means anything while a text pane has the keyboard.
  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused, save]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-3">
          {path ? path : "Unsaved note"}
        </span>
        {pane.dirty ? (
          <span className="shrink-0 font-mono text-[length:var(--fs-9)] uppercase tracking-[0.14em] text-warn">
            unsaved
          </span>
        ) : null}
        <button
          type="button"
          title={path ? `Save to ${fileName(path)}` : "Save as…"}
          aria-label="Save"
          onClick={() => void save()}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-hairline-strong px-1.5 text-[length:var(--fs-10)] text-ink-2 hover:bg-surface-2 hover:text-ink-1"
        >
          <Save className="h-3 w-3" />
          Save
        </button>
      </div>

      {error || readOnlyReason ? (
        <p
          className={cn(
            "shrink-0 border-b border-border px-2 py-1 font-mono text-[length:var(--fs-10)]",
            error ? "text-danger" : "text-warn",
          )}
        >
          {error ?? readOnlyReason}
        </p>
      ) : null}

      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
