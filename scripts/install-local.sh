#!/usr/bin/env bash
#
# Install the built app into ~/.local for the current user.
#
# Deliberately not `dpkg -i`: that needs root to put one binary somewhere it
# was already going to be found. Everything here goes under ~/.local, which is
# on the default XDG search path, so the app lands on $PATH and in the
# launcher with no privileges and nothing to undo but three `rm`s.
#
# Run it after `npm run tauri build`. Safe to re-run; it overwrites in place.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=jterm
PREFIX="${PREFIX:-$HOME/.local}"

BIN_DIR="$PREFIX/bin"
ICON_ROOT="$PREFIX/share/icons/hicolor"
DESKTOP_DIR="$PREFIX/share/applications"

# The release binary lands under a target triple when one was named and
# directly under `target/` when it was not, so ask rather than assume.
BINARY="$(find "$REPO/src-tauri/target" -type f -name "$APP" -path '*/release/*' \
          -not -path '*/deps/*' -not -path '*/build/*' -print0 2>/dev/null \
          | xargs -0 ls -t 2>/dev/null | head -1 || true)"

if [[ -z "$BINARY" ]]; then
  echo "No release binary found. Run:  npm run tauri build" >&2
  exit 1
fi

# Never run the binary to interrogate it. A Tauri app has no `--version`
# handler, so asking simply starts the GUI and the installer waits on a window.
echo "installing $APP from ${BINARY#"$REPO"/}"

install -Dm755 "$BINARY" "$BIN_DIR/$APP"

# Icons, at every size the shell might ask for. The name here is what the
# desktop entry's `Icon=` refers to — they must match or the launcher falls
# back to a generic square.
install -Dm644 "$REPO/src-tauri/icons/32x32.png"      "$ICON_ROOT/32x32/apps/$APP.png"
install -Dm644 "$REPO/src-tauri/icons/128x128.png"    "$ICON_ROOT/128x128/apps/$APP.png"
install -Dm644 "$REPO/src-tauri/icons/128x128@2x.png" "$ICON_ROOT/256x256/apps/$APP.png"
install -Dm644 "$REPO/src-tauri/icons/icon.png"       "$ICON_ROOT/512x512/apps/$APP.png"

# StartupWMClass is what ties the running window back to this entry. Without
# it the launcher shows a second, unnamed icon while the app is open, because
# it cannot tell that the window belongs to the thing it launched. Tauri
# derives the WM class from productName, capitalised.
install -Dm644 /dev/stdin "$DESKTOP_DIR/$APP.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=jterm
GenericName=Terminal
Comment=A tabbed terminal that remembers the command you had not run yet
Exec=$BIN_DIR/$APP
Icon=$APP
Terminal=false
Categories=System;TerminalEmulator;
Keywords=shell;prompt;command;console;tmux;
StartupNotify=true
StartupWMClass=Jterm
DESKTOP

# One main category only. `System` and `Utility` are both "main" in the menu
# spec, and listing both makes some shells file the app twice.
# Caches. Both are best-effort: the entry works without them, it just may take
# a login for the shell to notice.
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -qtf "$ICON_ROOT" 2>/dev/null || true

echo
echo "  binary   $BIN_DIR/$APP"
echo "  desktop  $DESKTOP_DIR/$APP.desktop"
echo "  icons    $ICON_ROOT/*/apps/$APP.png"
echo
echo "Run it with:  $APP"
if ! command -v "$APP" >/dev/null; then
  echo "note: $BIN_DIR is not on this shell's PATH yet — open a new shell."
fi
