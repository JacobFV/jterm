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
- **Folds a tab into a split.** Drag a tab out of the strip and drop it on a
  pane: the tab's panes arrive as a split there, keeping the arrangement they
  already had. Nothing restarts — the shells behind them never notice.
- **Opens more than shells.** A notepad with syntax highlighting and save, a web
  pane, and viewers for images, video, audio and STL meshes. What opens is
  chosen from the file you picked; *where* it opens — a new tab, or a split on
  the side you like — is up to you, in Settings → Files.
- **Changes what a pane is.** Click a pane's kind icon, in its header or in the
  tab strip, to replace it with a terminal, a notepad, a browser or a file — or
  to move another open tab into that slot. Moving a tab in is an even trade: the
  pane it displaces leaves as a tab of its own, so nothing is destroyed.
- **Works through tmux, if you already do.** A terminal can run on a tmux
  session instead of a bare shell, so what survives a crash is the *shell*
  rather than a recording of it — and `Mod+D` splits tmux rather than splitting
  around it. Or attach in **control mode**, where a tmux window becomes a jterm
  tab and a tmux pane becomes a real jterm pane: no nested status bar, no tmux
  drawn inside a box. Either way, from the **+** menu.
- **Changes its colours from the tab.** Right-click any tab — or click its kind
  icon — for **Theme ▸**, and pointing at an entry *applies* it: the terminal you
  are already looking at repaints under the pointer, and leaving the menu puts
  back what you had. Twenty of them, from Gruvbox and Solarized through a
  green phosphor CRT and Windows 3.1's Hotdog Stand, plus ten that are alive —
  a Mandelbrot breathing in and out of itself, a Julia set turning inside out,
  drifting nebulae, aurora, digital rain, a starfield, a lava lamp, a sunflower
  head whose spirals wind and unwind forever, Turing's own reaction–diffusion
  growing the patterns that are on actual animals, and a Lorenz attractor
  tracing the original picture of chaos — drawn behind the panes with the
  terminal translucent over them, in the theme's own colours. They hold still
  under `prefers-reduced-motion`. Each living theme's swatch is that drawing,
  running: a still frame of a fractal tells you nothing about the one thing you
  are choosing it for.
- **And lets you turn all of that down.** Three sliders in **Settings →
  Appearance**, shown only when the theme actually draws something. **Motion**
  at zero settles the drawing and then holds it — a still wallpaper in the
  theme's colours, rather than a choice between weather and giving the theme
  up. **Presence** is how much shows through the terminal, and at zero there is
  no drawing at all. **Reacts to the shell** speeds the weather up while your
  own output is flooding and lets it settle when the prompt comes back, so a
  long build is visible out of the corner of your eye without occupying a pixel
  of chrome; at zero it runs on a plain clock.
- **Remembers what you typed, across every pane.**
  <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> searches every line you have
  submitted at a prompt — in any pane, from any day jterm still has a log for —
  with the directory it was run in and how long ago. The shell's own
  <kbd>Ctrl</kbd>+<kbd>R</kbd> is per-shell and dies with it; this one answers
  "that command, in that repo, some weeks ago, in a tab I have since closed".
  Choosing one **types it at the prompt without running it**, which is the same
  promise the restored draft line makes.

  It is every submitted line, not only shell commands: jterm mirrors what you
  type and cannot tell a shell's prompt from a REPL's or an agent's, so those
  are in there too. Telling them apart needs the shell to say where its prompts
  begin.
- **Settles in a settings window.** Theme, type sizes, cursor, scrollback,
  shell, and every shortcut — in a second window rather than a modal, so you can
  watch the terminal change as you drag.

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
| <kbd>Mod</kbd>+<kbd>=</kbd> / <kbd>Mod</kbd>+<kbd>-</kbd> | Larger / smaller text |
| <kbd>Mod</kbd>+<kbd>0</kbd> | Back to the default text size |
| <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Search what you have typed |
| <kbd>Mod</kbd>+<kbd>,</kbd> | Settings |
| <kbd>F11</kbd> | Full screen |

Those are the defaults. All of them can be rebound in **Settings → Keyboard** by
clicking a shortcut and pressing the keys you want; <kbd>Backspace</kbd> removes
one entirely. Taking a chord that is already spoken for unbinds whichever action
had it, rather than leaving two racing for the same key press.

Hold the **+** in the tab bar for Notepad, Open file…, or Browser. Click a
pane's kind icon — the small terminal or page glyph in its header, or on its tab
— to change what that pane holds.

### About zooming

<kbd>Mod</kbd>+<kbd>=</kbd> and <kbd>Mod</kbd>+<kbd>-</kbd> change the type size
of the terminals *and* the text panes, together, because it is one size — the
same one **Settings → Terminal → Font size** shows, moved from the keyboard
rather than kept beside it. Zoom in and the slider has moved; drag the slider
and the next <kbd>Mod</kbd>+<kbd>=</kbd> carries on from where you left it. It
follows that <kbd>Mod</kbd>+<kbd>0</kbd> goes back to the size jterm ships with
rather than to some earlier size of yours, since there is only the one number
and it is not remembering a second.

The interface around them — tabs, the file tree, pane titles — has a size of its
own and does not move, the same way zooming a page does not zoom the browser.
That size is **Settings → Appearance → Interface size**.

<kbd>Mod</kbd>+<kbd>=</kbd>, <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>=</kbd> and the
<kbd>+</kbd> on the numeric keypad are all the same press here, because they are
all the same key; you should not have to know which one the table was written
down with. Going the other way is plain <kbd>Mod</kbd>+<kbd>-</kbd> only —
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>-</kbd> is <kbd>Ctrl</kbd>+<kbd>_</kbd>,
which is readline's undo, and that still belongs to the shell.

### About <kbd>Ctrl</kbd>+<kbd>D</kbd>

Splitting on <kbd>Mod</kbd>+<kbd>D</kbd> comes from iTerm2, where it is
<kbd>⌘</kbd>+<kbd>D</kbd> and costs nothing. On Windows and Linux the same
shortcut is <kbd>Ctrl</kbd>+<kbd>D</kbd> — the shell's end-of-file. Binding it
takes that away, so <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> sends a literal
EOF instead. If you would rather have your EOF back, unbind **Split right** in
Settings → Keyboard and <kbd>Ctrl</kbd>+<kbd>D</kbd> goes back to the shell.

## Settings

A window, not a modal, because nearly everything in it is a thing you adjust
while looking at the result — and five tabs rather than one long page, so the
shortcut table is somewhere you arrive at rather than somewhere you scroll past.
Between them: theme (including following the system), the
interface's type size and the one the terminals and text panes share, font,
line height, cursor shape and blink, scrollback, which shell to start, whether
an opened file becomes a tab or a split and which side that split goes, the
file tree's width and whether it shows dotfiles, and the shortcut table.
Changes are written as you make them and reach the main window immediately —
there is no OK button.

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

`settings.json` sits beside them and is deliberately not part of either. The
session snapshot is this machine at this moment and is rewritten several times a
second; your preferences are the file you would copy to a new machine, and there
is no reason for the two to be able to fail together.

All three live in the platform's data directory —
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

### One tab cannot take the window with it

On Linux, each shell is started in a systemd scope of its own rather than in
jterm's. This is not tidiness — it is the difference between losing a tab and
losing the session.

A tab running something that grows without bound has that process killed by the
kernel's OOM killer, which is survivable. What is not is what systemd does next:
every shell being a member of the *app's* scope means `OOMPolicy=stop`, the
default, answers one member being killed by stopping the whole unit — jterm and
every other tab's shell along with it. The window vanishes while you are typing
somewhere else, and the only record is a line in `journalctl --user` about a
process you never had open.

So a pane's shell gets its own transient scope with `OOMPolicy=continue`, and
the blast radius becomes the one tab that earned it. Where that cannot be
arranged — no systemd, no user session bus, or any other platform — the shell is
started directly and nothing else changes. One consequence is worth knowing: a
background job you have deliberately disowned now outlives the app rather than
being swept up with it, the same way a tmux session already does.

The same principle applies twice more inside the app. A bug that throws while
one pane is *drawing* stops at that pane, which shows the error while its
siblings carry on and every shell keeps running — rather than unmounting the
whole window and leaving you a blank rectangle with a working terminal
underneath it you cannot reach. And the release build unwinds rather than
aborting on a panic, so a fault in one pty reader or tmux client is that
thread's death rather than the process's.

When something does go wrong, it leaves a note: `panic.log`, beside the session
files, gets a line naming the thread, the source location and the message. An
app launched from a desktop menu has no stderr anyone will ever read, which is
how "it crashes randomly" turns into a report with nothing attached to it.

## tmux

All of the above reconstructs a shell from what jterm wrote down. tmux does not
have to: the shell is in a server process that outlives the app, so what comes
back is the thing itself. Where that is available it is simply better, and jterm
stands down rather than keeping a second copy.

**Settings → tmux → New terminals run on** chooses. On `A tmux session`, each
new terminal is `tmux new-session -A -s jterm-<pane>`; jterm then keeps no
scrollback log for it and replays no draft, because the shell that has the real
command line never stopped running. The command log in `terminals/*.jsonl` is
still written — tmux keeps no such record, so it is the one thing not made
redundant. Terminals already open keep whatever they started on.

Closing a pane ends the session jterm made for it, because closing a pane means
the shell is finished with. Quitting or crashing does not. That asymmetry is the
whole feature: what survives is exactly what you never deliberately closed. A
session you attached to yourself is never ended by jterm — the pane detaches and
leaves it as it was.

**Pane shortcuts drive tmux.** In a tmux-backed pane, splitting, moving the
focus and resizing act on tmux's panes rather than jterm's, so the split lands
in the session that survives and the muscle memory does not have to know which
kind of pane it is aimed at. Moving the focus off the edge of a tmux layout
arrives at the jterm pane next door, so the boundary between the two split trees
is not a trap. Tab shortcuts are never forwarded: a jterm tab is a window of the
app and has no tmux counterpart. Turn the setting off to split jterm *around* a
tmux pane instead. `Mod+Shift+W` always closes the jterm pane, never the tmux
one — routed to `kill-pane` it would destroy a one-pane session and leave a dead
shell behind, which is a keystroke that does not close what it is aimed at.

**+ → tmux session…** lists what is running and offers each of it two ways,
including sessions jterm knows nothing about. That is the case jterm's own
snapshot structurally cannot cover: ssh somewhere, lose the connection, and the
draft it saved belongs to a shell that no longer exists.

### Control mode

The second of those two ways. Everything above puts tmux *inside* a pane — one
pty per pane, tmux drawing its own status line and its own dividers in a box
jterm knows nothing about. Control mode inverts it: one pty runs `tmux -CC`,
tmux stops drawing and starts *describing* itself, and jterm renders the
description with its own panes and its own splits.

**A tmux window becomes a jterm tab; a tmux pane becomes a real terminal in a
real jterm split.** No nested status bar, because nothing is nested. Splitting
with `Mod+D` splits tmux, and the tab strip fills with the session's windows.
Every pane's history is fetched from tmux on arrival, so attaching to a session
left running last week looks like arriving rather than starting.

tmux is the authority throughout. jterm listens for `%layout-change` and
rebuilds those tabs from what tmux says, so a split made in another terminal
attached to the same session appears here too. Tab and pane ids are *derived*
from tmux's own, which is what keeps a layout change from remounting the
terminals inside it — the shells never notice.

Control-mode tabs are **not** in the snapshot. Only the session names are: tmux
is still running and still knows which windows it has, so a saved copy of that
shape could only be right by luck. On the next launch jterm reattaches and the
tabs come back from tmux, correct even if the session changed while jterm was
closed.

Detaching, from the same panel, takes the tabs away and leaves the session
exactly as it was. Closing a control-mode pane kills tmux's pane, since that is
what closing a pane means everywhere else here.

Two things it does not do. jterm's tab shortcuts are never forwarded — a jterm
tab is a window of the app, and `Mod+T` opening a tmux window would make the tab
strip disagree with itself. And a control-mode tab cannot be folded into another
tab as a split, because its layout is not jterm's to rearrange.

Running `tmux` yourself inside an ordinary pane is noticed too — jterm pauses
its scrollback recording while a tmux client is under the pane's shell, and
resumes when you leave, since otherwise the log fills with a full-screen
program's redraws and a restore paints them back. The pause is written into the
log as a `── tmux ──` line so the gap is not mistaken for a bug. It runs on the
same poll as the working-directory check, so up to one screenful of tmux's first
redraw lands above the marker.

None of this exists on Windows, where tmux does not, or on any machine without
it installed: the settings section and the menu entry are absent, and a settings
file carried from a machine that had it quietly gets an ordinary shell.

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

On Linux, `scripts/install-local.sh` puts a build you just made on your `$PATH`
and in the launcher — binary, icons and desktop entry, all under `~/.local`, so
it needs no root and there is nothing to undo but three `rm`s. Re-running it
over the version you are *currently running* is safe: it replaces the file by
unlinking it first, so the running process keeps the inode it started with and
carries on. You get the new build the next time you open a window.

## Releasing

The version lives in three files; a script keeps them in step and CI refuses a
tag that disagrees with them.

```sh
npm run version 0.3.0
git commit -am "v0.3.0" && git tag -a v0.3.0 -m v0.3.0 && git push --follow-tags
```

That builds macOS (Apple silicon and Intel), Windows, and Linux on both x86_64
and arm64, and attaches the installers to the release. Builds are **not code-signed** — macOS wants
right-click → Open, and Windows SmartScreen wants More info → Run anyway.

Two things that fail quietly if they are wrong, both learned the hard way:

- **The tag must be annotated.** `--follow-tags` pushes annotated tags and only
  those, so a lightweight `git tag v0.3.0` sends the commit, keeps the tag at
  home, and builds nothing — while the push itself reports success.
- **Actions needs a write-capable token.** Creating the release object is the
  one thing the workflow cannot do with a read-only default, and it fails
  *after* all five platforms have built. Settings → Actions → General →
  Workflow permissions must be "Read and write"; `permissions: contents: write`
  in the workflow is not sufficient on its own.

## Layout

```
src/
  state/      tree.ts (split geometry), workspace.ts (tabs and panes),
              snapshot.ts (persistence format), content.ts (buffers, outside React),
              settings.ts (preferences, shared between windows)
  panes/      one file per pane kind, plus registry.tsx
  components/ shell/ — tab strip, window controls, file tree, workspace
              settings/ — the second window
  lib/        draft.ts (the mirrored prompt line), osc.ts, keymap.ts,
              tmux.ts (which panes are in tmux, and what the shortcuts
              mean when they are), tmuxControl.ts (tmux's layout as
              jterm's split tree), …
src-tauri/src/
  pty.rs      pseudoterminals
  tmux.rs     sessions jterm starts, and noticing ones the user starts
  control.rs  the `tmux -CC` protocol, and tmux's layout as a tree
  store.rs    durable snapshots, scrollback and settings
  files.rs    reading and saving edited files
```

One file is worth reading before changing any of the layout code:
[`components/shell/Workspace.tsx`](src/components/shell/Workspace.tsx). Every
pane in the window is rendered from a single flat list rather than from the
split tree or from its tab, and only its rectangle changes when the layout does.
That is what lets a pane be moved — or handed to another tab — without React
unmounting it and taking the live terminal with it.

Built with [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org),
[CodeMirror](https://codemirror.net) and [three.js](https://threejs.org).

MIT licensed.
