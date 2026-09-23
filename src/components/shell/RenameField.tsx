/**
 * The label of a tab or a pane header, made editable in place.
 *
 * In place rather than in a dialog because the label is exactly where the
 * name will be read afterwards, and a name is short enough that the room the
 * label already has is room enough to type it.
 *
 * It sits inside things that treat a press as the start of a drag and a key as
 * a request to select the tab, so it keeps every press and every key to itself.
 * Enter or leaving the field keeps what was typed; Escape keeps nothing.
 */

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export function RenameField({
  initial,
  onDone,
  className,
}: {
  /** What the field starts holding, selected so that typing replaces it. */
  initial: string;
  /** The text typed, or `null` when the edit was abandoned. */
  onDone: (value: string | null) => void;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Set once an answer has been given. Enter commits and then unmounts the
   * field, and the unmount blurs it — without this the blur would answer a
   * second time, and an Escape would be followed by a commit of what it
   * abandoned.
   */
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (value: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(value);
  };

  const hold = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      aria-label="Name"
      spellCheck={false}
      maxLength={200}
      onPointerDown={hold}
      onMouseDown={hold}
      onClick={hold}
      onDoubleClick={hold}
      onContextMenu={hold}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
      }}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-brand bg-surface-0 px-1 text-ink-1 outline-none",
        className,
      )}
    />
  );
}
