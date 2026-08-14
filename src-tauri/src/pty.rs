//! Pseudoterminals, one per terminal tab.
//!
//! A tab owns a shell; this module owns the pipe to it. `portable-pty` hides
//! the fact that the three platforms disagree entirely about what a
//! pseudoterminal is — `openpty` on Unix, ConPTY on Windows — so everything
//! above this file gets to think in terms of "bytes in, bytes out, and a size".
//!
//! Two things here are less obvious than they look:
//!
//!   - **UTF-8 does not respect read boundaries.** A `read` can end in the
//!     middle of a multi-byte character, and a naive `String::from_utf8_lossy`
//!     on each chunk turns that into a permanent `U+FFFD` in the user's output.
//!     `Decoder` carries the incomplete tail across reads.
//!   - **The reader thread is also the recorder.** Scrollback is appended from
//!     the same bytes on the way past, rather than asked for later from the
//!     frontend, because the frontend is exactly what is not running after a
//!     crash.
//!   - **Recording can be switched off under a running shell.** When tmux is
//!     behind a pane it is already keeping that pane's history, and jterm's copy
//!     would be a second one made out of a full-screen program's redraws — which
//!     is worse than no copy at all, because it is what a restore would show.
//!     See `crate::tmux`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::control::{self, ControlRegistry};
use crate::isolation;
use crate::store::Store;
use crate::tmux;

/// Emitted for every decoded chunk of shell output.
pub const DATA_EVENT: &str = "pty://data";
/// Emitted once, when the shell exits.
pub const EXIT_EVENT: &str = "pty://exit";

/// Read size. Large enough that a flood of output arrives in few chunks — the
/// kernel's own buffering does the coalescing, so the loop can emit once per
/// read and still never sit on data it already has.
const READ_BUF: usize = 32 * 1024;

#[derive(Clone, Serialize)]
struct DataPayload<'a> {
    id: &'a str,
    chunk: &'a str,
}

#[derive(Clone, Serialize)]
struct ExitPayload<'a> {
    id: &'a str,
    /// `None` when the child was signalled rather than exiting on its own.
    code: Option<u32>,
}

/// What the frontend learns about a shell it just started.
#[derive(Serialize)]
pub struct SpawnInfo {
    pub pid: Option<u32>,
    /// The program actually launched, after the fallback chain below.
    pub shell: String,
    pub cwd: String,
    /// The tmux session this pane ended up in, or `None` for a bare shell.
    ///
    /// Reported rather than assumed, because asking for tmux is not the same as
    /// getting it: a settings file that says "tmux" on a machine without tmux
    /// installed gets an ordinary shell, and the frontend has to know which one
    /// it has before it decides whether to restore scrollback over the top.
    pub tmux: Option<String>,
}

/// What a poll of a live pane finds out about it.
#[derive(Serialize)]
pub struct Probe {
    /// Where the shell is, when the platform will say. See `pty_probe`.
    pub cwd: Option<String>,
    /// Whether tmux is between jterm and the shell right now — either because
    /// jterm put it there, or because the user ran it themselves.
    pub tmux: bool,
}

struct Session {
    /// Held only to resize. `MasterPty` is not `Sync`, hence the mutex.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Set when jterm started this pane inside tmux, which settles the recording
    /// question for the pane's whole life — unlike a tmux the user attaches and
    /// later leaves.
    tmux: Option<String>,
    /// Read by the reader thread on every chunk, written by `pty_probe`. An
    /// atomic rather than a message because the reader must not have to wait for
    /// anything to answer "do I write this down?".
    recording: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }
}

/* ── UTF-8 across chunk boundaries ───────────────────────────────────────── */

/// Turns a byte stream into `&str` without ever splitting a character.
#[derive(Default)]
struct Decoder {
    /// Bytes that form the beginning of a character whose remainder has not
    /// arrived yet. Never longer than 3.
    carry: Vec<u8>,
}

impl Decoder {
    /// Append `bytes` and return everything that is now a complete character.
    ///
    /// Genuinely invalid sequences (as opposed to merely incomplete ones) are
    /// replaced rather than dropped, so a program that emits raw binary shifts
    /// the display without desynchronising the stream.
    fn push(&mut self, bytes: &[u8], out: &mut String) {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut rest = &buf[..];

        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    // SAFETY-adjacent: `valid_up_to` is by definition a valid
                    // boundary, so this slice is known-good UTF-8.
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                    match err.error_len() {
                        // A real decoding error: skip the offending bytes and
                        // carry on with what follows.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[valid + bad..];
                        }
                        // Truncated at the end of the buffer. Keep the tail for
                        // the next read to complete.
                        None => {
                            self.carry.extend_from_slice(&rest[valid..]);
                            return;
                        }
                    }
                }
            }
        }
    }
}

/* ── Shell selection ─────────────────────────────────────────────────────── */

/// The program a new tab runs, in falling order of preference.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        // PowerShell 7 if it was installed, then the one that ships with the
        // OS, then the last resort that is always present.
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if which(candidate).is_some() {
                return candidate.to_string();
            }
        }
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    }
    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.is_empty() {
                return shell;
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

#[cfg(windows)]
fn which(program: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn home_dir() -> std::path::PathBuf {
    dirs_next::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/// Start a shell for tab `id`.
///
/// `cwd` is where the tab was when it was last saved; a directory that has
/// since been deleted falls back to home rather than failing the spawn, since
/// refusing to open a tab is a worse answer than opening it somewhere else.
// A Tauri command's parameters are its IPC payload, one argument per field.
// Bundling them into a struct to please the lint would only move the same eight
// names one level down and add a type nothing else would use.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    registry: tauri::State<'_, Arc<PtyRegistry>>,
    store: tauri::State<'_, Arc<Store>>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    tmux: Option<String>,
) -> Result<SpawnInfo, String> {
    // Re-spawning into a live id would orphan the old shell with no way to
    // reach it, so the previous one is closed first.
    pty_kill_inner(&registry, &id);

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|err| format!("could not open a pseudoterminal: {err}"))?;

    // Asked for is not the same as available. A settings file carried to a
    // machine without tmux — or to Windows — falls back to a bare shell rather
    // than failing the spawn, for the same reason a deleted `cwd` does.
    let tmux_session = tmux
        .filter(|name| !name.is_empty())
        .filter(|_| tmux::available());

    let chosen_shell = shell.filter(|s| !s.is_empty());
    let program = chosen_shell.clone().unwrap_or_else(default_shell);

    let working_dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(home_dir);

    // What is actually being run, as a head and a tail rather than one list,
    // because the head is the only part `CommandBuilder` takes by itself — and
    // because it is about to stop being the first thing on the command line.
    let (head, tail): (std::ffi::OsString, Vec<std::ffi::OsString>) =
        match (&tmux_session, tmux::program()) {
            (Some(name), Some(binary)) => (
                binary.clone().into_os_string(),
                tmux::attach_argv(name, &working_dir, chosen_shell.as_deref())
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            ),
            _ => {
                // macOS graphical apps inherit a bare environment, and the
                // user's PATH lives in their login files, so the shell is
                // started as a login one. Linux desktop sessions already export
                // it, and a login shell there reads a different file than an
                // interactive one (`.bash_profile`, not `.bashrc`) — which
                // would surprise people. So this is deliberately not symmetric.
                //
                // Not reached on the tmux path above: `-l` there would be an
                // argument to tmux, which has its own meaning for it, and the
                // login shell question belongs to tmux's `default-command`
                // anyway.
                //
                // Two bindings rather than a `push` behind a `cfg`, because the
                // push is the whole of the macOS vector and clippy rejects
                // building one that way — on macOS only, where nothing builds
                // until CI does.
                #[cfg(target_os = "macos")]
                let tail: Vec<std::ffi::OsString> = vec!["-l".into()];
                #[cfg(not(target_os = "macos"))]
                let tail: Vec<std::ffi::OsString> = Vec::new();

                (program.clone().into(), tail)
            }
        };

    // Put the shell in a cgroup of its own where that is possible, so that a
    // job it starts and cannot pay for is killed without the kill reaching
    // jterm or any other tab. See `crate::isolation` — including why this
    // wrapping does not cost the pid that `pty_probe` depends on.
    //
    // Wrapped on the tmux path too. The client is short-lived there, but it is
    // the process that starts the server when there is not one yet, and a
    // server that inherits jterm's scope puts every tmux-backed pane back in
    // the blast radius this is trying to empty.
    let mut cmd = match isolation::runner() {
        Some(runner) => {
            let mut cmd = CommandBuilder::new(runner);
            for arg in isolation::scope_args(&id) {
                cmd.arg(arg);
            }
            cmd.arg(&head);
            cmd
        }
        None => CommandBuilder::new(&head),
    };
    for arg in &tail {
        cmd.arg(arg);
    }

    cmd.cwd(&working_dir);

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "jterm");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| match &tmux_session {
            Some(name) => format!("could not attach to the tmux session {name}: {err}"),
            None => format!("could not start {program}: {err}"),
        })?;
    let pid = child.process_id();

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("could not read from the shell: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("could not write to the shell: {err}"))?;

    // Dropped explicitly: while this process holds the slave end open, the
    // master never sees EOF, so the reader thread below would block forever
    // after the shell exits.
    drop(pair.slave);

    // A pane that has just become tmux-backed may be carrying a log from when it
    // was not. Nothing will ever be added to it again, and leaving it would make
    // the next launch paint a stale screen above a tmux that is about to redraw
    // the whole thing anyway.
    if tmux_session.is_some() {
        store.drop_scrollback(&id);
    }
    let recording = Arc::new(AtomicBool::new(tmux_session.is_none()));

    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        tmux: tmux_session.clone(),
        recording: recording.clone(),
    });
    registry.sessions.lock().insert(id.clone(), session.clone());

    spawn_reader(
        app,
        registry.inner().clone(),
        (*store).clone(),
        id,
        reader,
        recording,
    );

    Ok(SpawnInfo {
        pid,
        shell: program,
        cwd: working_dir.to_string_lossy().into_owned(),
        tmux: tmux_session,
    })
}

/// Pump shell output to the frontend and to the scrollback log.
fn spawn_reader(
    app: AppHandle,
    registry: Arc<PtyRegistry>,
    store: Arc<Store>,
    id: String,
    mut reader: Box<dyn Read + Send>,
    recording: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut decoder = Decoder::default();
        let mut buf = vec![0u8; READ_BUF];
        let mut text = String::new();

        loop {
            let read = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                // A closed PTY surfaces as an error on some platforms and as
                // EOF on others; both mean the same thing here.
                Err(_) => break,
            };

            // Recorded before it is displayed. If the machine dies between the
            // two, the log is ahead of the screen rather than behind it, which
            // is the harmless direction.
            //
            // Unless tmux is behind this pane, in which case the history is
            // already being kept by something that will still be running after
            // the crash this log exists for.
            if recording.load(Ordering::Relaxed) {
                store.append_scrollback(&id, &buf[..read]);
            }

            text.clear();
            decoder.push(&buf[..read], &mut text);
            if !text.is_empty() {
                let _ = app.emit(
                    DATA_EVENT,
                    DataPayload {
                        id: &id,
                        chunk: &text,
                    },
                );
            }
        }

        store.flush_scrollback(&id);

        let session = registry.sessions.lock().remove(&id);
        let code = session.and_then(|session| {
            let mut child = session.child.lock();
            child.wait().ok().map(|status| status.exit_code())
        });
        let _ = app.emit(EXIT_EVENT, ExitPayload { id: &id, code });
    });
}

/// Send keystrokes (or pasted text) to the shell.
///
/// A control-mode pane has no pty of its own — its bytes go to tmux as a
/// `send-keys` on the one pty the whole session shares. Answered here rather
/// than by a second command the frontend would have to choose between, so a
/// pane is a pane no matter what is behind it.
#[tauri::command]
pub fn pty_write(
    registry: tauri::State<'_, Arc<PtyRegistry>>,
    control: tauri::State<'_, Arc<ControlRegistry>>,
    id: String,
    data: String,
) -> Result<(), String> {
    if control::write(&control, &id, &data) {
        return Ok(());
    }
    let Some(session) = registry.get(&id) else {
        // The shell exited between the keystroke and its delivery. Not an
        // error worth surfacing — the tab already shows that it is dead.
        return Ok(());
    };
    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|err| format!("could not write to the shell: {err}"))
}

/// Tell the shell the window changed shape, so it re-wraps and `$COLUMNS` is
/// right. Without this, full-screen programs paint at the wrong size.
#[tauri::command]
pub fn pty_resize(
    registry: tauri::State<'_, Arc<PtyRegistry>>,
    control: tauri::State<'_, Arc<ControlRegistry>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // For a control-mode pane this sizes the *client* rather than the pane —
    // tmux lays its own panes out inside whatever jterm offers, and hands the
    // result back as a layout change.
    if control::resize(&control, &id, cols, rows) {
        return Ok(());
    }
    let Some(session) = registry.get(&id) else {
        return Ok(());
    };
    // Bound rather than chained: as a tail expression the guard would outlive
    // the `Arc` it borrows from.
    let master = session.master.lock();
    let result = master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    });
    result.map_err(|err| format!("could not resize the terminal: {err}"))
}

/// End the shell behind a tab that is closing.
#[tauri::command]
pub fn pty_kill(
    registry: tauri::State<'_, Arc<PtyRegistry>>,
    control: tauri::State<'_, Arc<ControlRegistry>>,
    id: String,
) -> Result<(), String> {
    // Closing a control-mode pane means killing tmux's pane; there is no pty
    // here to end, and leaving tmux's would leave a pane nothing is showing.
    if control::kill(&control, &id) {
        return Ok(());
    }
    pty_kill_inner(&registry, &id);
    Ok(())
}

fn pty_kill_inner(registry: &PtyRegistry, id: &str) {
    let session = registry.sessions.lock().remove(id);
    if let Some(session) = session {
        let _ = session.child.lock().kill();
    }
}

/// Look at a live pane: where its shell is, and whether tmux is in front of it.
///
/// Two questions in one call because they are asked together, on the same poll,
/// about the same process — and the pid has to be taken out from under the same
/// lock either way.
///
/// **Where.** Only Linux answers directly. Elsewhere the frontend learns the
/// working directory from the OSC 7 sequence the shell emits, which is why
/// `cwd` coming back `None` is an ordinary outcome rather than a failure.
///
/// **Whether.** A pane jterm put in tmux answers yes for its whole life. A pane
/// the user ran `tmux` inside answers yes only while that client is there, and
/// recording resumes on its own when they leave — which is the "briefly naked
/// in between sessions" case, and it needs no separate handling because leaving
/// tmux is simply the moment this stops finding a client.
#[tauri::command]
pub fn pty_probe(
    registry: tauri::State<'_, Arc<PtyRegistry>>,
    control: tauri::State<'_, Arc<ControlRegistry>>,
    store: tauri::State<'_, Arc<Store>>,
    id: String,
) -> Probe {
    // A control-mode pane is in tmux by construction, and has no process of its
    // own on this side to read a directory from.
    if control.has(&id) {
        return Probe {
            cwd: None,
            tmux: true,
        };
    }
    let Some(session) = registry.get(&id) else {
        return Probe {
            cwd: None,
            tmux: false,
        };
    };
    let pid = session.child.lock().process_id();

    // A pane jterm started in tmux is settled without asking the process table:
    // it is tmux, and it cannot stop being tmux without the shell exiting.
    let in_tmux = session.tmux.is_some() || pid.is_some_and(tmux::has_client);

    // Only the second kind of tmux can change the answer under a running shell,
    // and only that kind leaves a log that a resume would append to.
    if session.tmux.is_none() {
        let was = session.recording.swap(!in_tmux, Ordering::Relaxed);
        if was && in_tmux {
            // A gap in the log with nothing to explain it reads as a bug on the
            // next launch. One dim line costs a few bytes and says what happened
            // to the output that is missing between here and the resume.
            //
            // It also marks off the untidy part. This runs on a poll, so tmux's
            // first redraw — one screenful, arriving before anything had reason
            // to look — is already in the log above it. Bounded by the poll
            // interval and self-describing, which is the cheap answer; the
            // expensive one is asking the process table on every chunk of
            // output, which would be a `/proc` read per keystroke echo.
            store.append_scrollback(&id, TMUX_GAP_MARKER.as_bytes());
            store.flush_scrollback(&id);
        }
    }

    let cwd = pid.and_then(|pid| {
        #[cfg(target_os = "linux")]
        {
            std::fs::read_link(format!("/proc/{pid}/cwd"))
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Consumed so the binding is not flagged as unused off Linux.
            let _ = pid;
            None
        }
    });

    Probe { cwd, tmux: in_tmux }
}

/// Written into the log where recording stops because tmux took over.
const TMUX_GAP_MARKER: &str = "\r\n\x1b[2m── tmux ──\x1b[0m\r\n";

#[cfg(test)]
mod tests {
    use super::Decoder;

    #[test]
    fn holds_a_character_split_across_reads() {
        let mut decoder = Decoder::default();
        let mut out = String::new();
        // "é" is 0xC3 0xA9; deliver the halves in separate reads.
        decoder.push(&[b'a', 0xC3], &mut out);
        assert_eq!(out, "a", "the incomplete character must not be emitted yet");
        out.clear();
        decoder.push(&[0xA9, b'b'], &mut out);
        assert_eq!(out, "éb");
    }

    #[test]
    fn replaces_genuinely_invalid_bytes_and_keeps_going() {
        let mut decoder = Decoder::default();
        let mut out = String::new();
        decoder.push(&[b'a', 0xFF, b'b'], &mut out);
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn survives_a_four_byte_character_split_three_ways() {
        let mut decoder = Decoder::default();
        let mut out = String::new();
        // U+1F600, 0xF0 0x9F 0x98 0x80.
        for byte in [0xF0u8, 0x9F, 0x98] {
            decoder.push(&[byte], &mut out);
            assert!(out.is_empty());
        }
        decoder.push(&[0x80], &mut out);
        assert_eq!(out, "😀");
    }
}
