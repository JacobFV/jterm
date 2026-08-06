# jterm

A tabbed terminal with tmux-style splits, where a pane can also be a notepad, a
browser, or a viewer.

The point of it is the half-typed command. You are composing a long `rsync`, or
a `git commit -m` with a message you thought about, and the machine dies. Every
other terminal loses that. This one writes it to disk as you type and types it
back at the prompt when you reopen — never with a newline attached, so nothing
runs on your behalf.

**[Download](https://jacobfv.github.io/jterm/)** ·
[Releases](https://github.com/JacobFV/jterm/releases)

---

## What it does

- **Remembers unsubmitted input.** Every prompt's current line is mirrored from
  your keystrokes, saved on a short timer, and restored on launch.
- **Restores scrollback.** Each pane's output is recorded as it arrives, so a
  recovered session shows what was on screen rather than a bare shell.
- **Splits like tmux.** Split, zoom, move focus by direction, resize from the
  keyboard, and drag a pane by its grip to rearrange the layout.
- **Opens more than shells.** A notepad with syntax highlighting and save, a web
  pane, and viewers for images, video, audio and STL meshes. What opens is
  chosen from the file you picked.

## Keys

`Mod` is <kbd>⌘</kbd> on macOS and <kbd>Ctrl</kbd> everywhere else.

| | |
|---|---|
| <kbd>Mod</kbd>+<kbd>D</kbd> | Split right |
| <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> | Split down |
| <kbd>Mod</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> | Send EOF to the shell |
| <kbd>Mod</kbd>+<kbd>Enter</kbd> | Zoom the focused pane |
| <kbd>Mod</kbd>+<kbd>Alt</kbd>+arrows | Move focus between panes |
| <kbd>Mod</kbd>+<kbd>Shift</kbd>+arrows | Resize the focused pane |
| <kbd>Mod</kbd>+<kbd>T</kbd> / <kbd>Mod</kbd>+<kbd>1…9</kbd> | New tab / go to tab |
| <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Close pane |
| <kbd>Mod</kbd>+<kbd>S</kbd> | Save (in a text pane) |
| <kbd>F11</kbd> | Full screen |

Hold the **+** in the tab bar for Notepad, Open file…, or Browser.

### About <kbd>Ctrl</kbd>+<kbd>D</kbd>

Splitting on <kbd>Mod</kbd>+<kbd>D</kbd> comes from iTerm2, where it is
<kbd>⌘</kbd>+<kbd>D</kbd> and costs nothing. On Windows and Linux the same
shortcut is <kbd>Ctrl</kbd>+<kbd>D</kbd> — the shell's end-of-file. Binding it
takes that away, so <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> sends a literal
EOF instead. If you would rather have your EOF back, `SPLIT_RIGHT` in
[`src/lib/keymap.ts`](src/lib/keymap.ts) is the one line to change.

## How the crash-safety works

Two files, with deliberately different durability:

- `session.json` — tabs, layout, notepad buffers, and the unsubmitted line at
  each prompt. Small, and written through a temporary file that is `fsync`'d and
  then renamed, so a crash mid-write leaves the previous complete snapshot
  rather than half of the new one. Written on a 200 ms debounce with a 1 s
  ceiling, so continuous typing cannot defer it indefinitely.
- `scrollback/<pane>.log` — raw shell output, appended and flushed periodically.
  Losing the last half-second of this costs nothing, and paying an `fsync` per
  chunk of `cargo build` output would make the terminal slow.

Both live in the platform's data directory —
`~/.local/share/jterm`, `~/Library/Application Support/…`,
`%APPDATA%\…`.

The prompt line itself is reconstructed from your keystrokes, since the line
belongs to the shell's readline and there is nothing to ask for it. Tab
completion and history recall rewrite that line where the app cannot see, so
both mark the draft untrusted; the restored text is never submitted, so the
worst case is text on screen you can edit or clear.

Text panes are different on purpose: the **buffer** is saved continuously, the
**file** only when you save. A crash therefore leaves your file untouched and
your unsaved work recoverable.

## Known limits

- **Browser panes are iframes.** A real embedded webview was built first and
  removed: Tauri's GTK backend only puts webviews in a `GtkBox`, so `set_bounds`
  is a no-op on Linux and a child webview cannot be positioned over a pane.
  Sites that send `X-Frame-Options: DENY` will not load; the pane offers to open
  them in your real browser instead. Localhost dev servers and most docs sites
  work. See [`src/panes/BrowserPane.tsx`](src/panes/BrowserPane.tsx).
- **Working directory restore needs OSC 7.** bash and zsh on macOS and most
  Linux distributions emit it already; PowerShell does not, so a restored
  Windows tab opens at home. Linux additionally reads `/proc`.
- **Media playback is the webview's.** WebKitGTK will not play H.264 without the
  system codec, and nothing plays Matroska. Those panes say so and offer your
  default player.

## Building

Needs Node 22 and a Rust toolchain, plus [Tauri's system
dependencies](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # run it
npm test               # frontend tests
npm run tauri build    # installers in src-tauri/target/release/bundle
cd src-tauri && cargo test
```

## Releasing

The version lives in three files; a script keeps them in step and CI refuses a
tag that disagrees with them.

```sh
npm run version 0.2.0
git commit -am "v0.2.0" && git tag v0.2.0 && git push --follow-tags
```

That builds macOS (Apple silicon and Intel), Windows, and Linux on both x86_64
and arm64, and attaches the installers to the release. Builds are **not code-signed** — macOS wants
right-click → Open, and Windows SmartScreen wants More info → Run anyway.

## Layout

```
src/
  state/      tree.ts (split geometry), workspace.ts (tabs and panes),
              snapshot.ts (persistence format), content.ts (buffers, outside React)
  panes/      one file per pane kind, plus registry.tsx
  components/ shell/ — tab strip, window controls, pane grid
  lib/        draft.ts (the mirrored prompt line), osc.ts, keymap.ts, …
src-tauri/src/
  pty.rs      pseudoterminals
  store.rs    durable snapshots and scrollback
  files.rs    reading and saving edited files
```

Built with [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org),
[CodeMirror](https://codemirror.net) and [three.js](https://threejs.org).

MIT licensed.
