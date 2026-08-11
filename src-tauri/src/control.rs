//! tmux control mode: tmux's panes drawn as jterm's panes.
//!
//! The other tmux integration in this app (see `crate::tmux`) puts tmux *inside*
//! a pane — one pty per pane, tmux drawing its own status line and its own
//! dividers in a box jterm knows nothing about. That works everywhere and is
//! nobody's idea of seamless.
//!
//! Control mode inverts it. One pty runs `tmux -CC`, tmux stops drawing
//! anything and starts *describing* itself instead, and jterm renders the
//! description with its own panes and its own splits. A tmux window becomes a
//! jterm tab; a tmux pane becomes a real xterm.js terminal in a real jterm
//! split. There is no nested status bar because there is nothing nested.
//!
//! ## The protocol, as tmux actually speaks it
//!
//! Everything after the opening `\x1bP1000p` is lines. Two kinds:
//!
//!   - **Blocks.** `%begin <ts> <n> <flags>`, some output, `%end` (or `%error`)
//!     with the same numbers. These are replies to commands *we* sent, in the
//!     order we sent them — which is the only thing that correlates them, hence
//!     `pending` below.
//!   - **Notifications**, arriving whenever tmux feels like it: `%output`,
//!     `%layout-change`, `%window-add`, `%window-close`, `%exit`, and a dozen
//!     others this does not need.
//!
//! `%output %3 <data>` carries a pane's bytes with non-printables written as
//! three-digit octal escapes, which is what `unescape_output` undoes.
//!
//! ## What the rest of the app sees
//!
//! Deliberately, almost nothing new. A control-mode pane's bytes are emitted on
//! `pty://data` under a jterm pane id, exactly like a pane with its own pty, so
//! `TerminalPane` renders one without knowing which it has. The structure —
//! which windows exist and how their panes are arranged — goes out separately on
//! `tmux://windows`, because that is the part with no equivalent in a world
//! where jterm owns the layout.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::pty::{DATA_EVENT, EXIT_EVENT};
use crate::tmux;

/// Emitted whenever the shape of a control session changes.
pub const WINDOWS_EVENT: &str = "tmux://windows";
/// Emitted when a control session ends, however it ended.
pub const CLOSED_EVENT: &str = "tmux://closed";

const READ_BUF: usize = 32 * 1024;

/// Longest `send-keys -H` line built at once.
///
/// A paste is one `write` from the frontend and could be megabytes; tmux would
/// cope with the line but nothing is gained by finding out where it stops.
const SEND_CHUNK: usize = 512;

/// Scrollback asked for when a pane first appears.
///
/// Control mode reports what a pane says *from now on*, so a session attached
/// to after the fact would show empty terminals holding running work. This is
/// the one call that makes attaching look like arriving rather than starting.
const CAPTURE_LINES: u32 = 2000;

/* ── What the frontend is told ───────────────────────────────────────────── */

#[derive(Clone, Serialize)]
struct DataPayload<'a> {
    id: &'a str,
    chunk: &'a str,
}

#[derive(Clone, Serialize)]
struct ExitPayload<'a> {
    id: &'a str,
    code: Option<u32>,
}

/// A tmux layout, as a tree that still has tmux's shape.
///
/// Left n-ary on purpose. tmux splits a window into as many panes as it likes at
/// one level; jterm's tree is binary. Converting between the two is tree work
/// rather than string work, so it happens on the frontend where the tree types
/// live and can be tested against the real ones — this end only has to get the
/// parsing right.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutNode {
    Pane {
        /// The jterm pane id, so the frontend never has to derive one.
        id: String,
        /// tmux's own, as `%3`, for anything aimed back at tmux.
        tmux: String,
        width: u32,
        height: u32,
    },
    Split {
        /// `x` for panes side by side, `y` for panes stacked.
        axis: String,
        width: u32,
        height: u32,
        children: Vec<LayoutNode>,
    },
}

#[derive(Clone, Serialize)]
pub struct WindowInfo {
    /// tmux's window id, as `@0`.
    pub id: String,
    pub name: String,
    pub active: bool,
    pub layout: LayoutNode,
}

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub session: String,
    pub windows: Vec<WindowInfo>,
}

/* ── Pane ids ────────────────────────────────────────────────────────────── */

/// The jterm pane id for a tmux pane.
///
/// Derived rather than allocated, so the same tmux pane is the same jterm pane
/// across a layout change, a reattach, or a restart — which is what stops the
/// terminal component from being torn down and rebuilt every time tmux moves
/// something. `history.rs` will only accept `[A-Za-z0-9-]{1,64}` as a pane id,
/// since these become file names, so the session name is squeezed into that
/// alphabet and truncated.
///
/// Two sessions whose names differ only in punctuation therefore collide. That
/// is accepted: the cost is two panes sharing a scrollback file, and the
/// alternative is a lookup table that has to survive restarts to be worth
/// anything.
pub fn pane_key(session: &str, tmux_pane: &str) -> String {
    let cleaned: String = session
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .take(32)
        .collect();
    let number = tmux_pane.trim_start_matches('%');
    format!("tmux-{cleaned}-{number}")
}

/* ── The client ──────────────────────────────────────────────────────────── */

/// What a `%begin`/`%end` block's output is for.
///
/// tmux does not label its replies, so the only thing tying one to the command
/// that caused it is arrival order. Every command pushes one of these, and every
/// block pops one.
enum Pending {
    /// A command whose output says nothing worth reading.
    Ignore,
    /// A `list-windows` reply: the session's whole shape.
    Windows,
    /// A `capture-pane` reply: a pane's history, for the pane named here.
    Capture(String),
}

pub struct ControlSession {
    name: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pending: Mutex<std::collections::VecDeque<Pending>>,
    /// The last shape tmux described. Read by `resize`, which needs to know how
    /// much of a window a pane is before it can say how big the window is.
    windows: Mutex<Vec<WindowInfo>>,
    /// The size last asked for, so a dozen panes reporting at once produce one
    /// `refresh-client` rather than a dozen contradicting ones.
    sized: Mutex<Option<(u16, u16)>>,
}

impl ControlSession {
    /// Send one tmux command and say what its reply will mean.
    fn send(&self, command: &str, pending: Pending) {
        // Queued before the write, not after: tmux can answer faster than this
        // thread reaches the next line, and a reply arriving before its slot
        // exists would be matched to whatever was in front of it.
        self.pending.lock().push_back(pending);
        let mut writer = self.writer.lock();
        let _ = writer.write_all(command.as_bytes());
        let _ = writer.write_all(b"\n");
        let _ = writer.flush();
    }

    fn refresh_windows(&self) {
        // Name last: it is the only field that may contain a space.
        self.send(
            &format!(
                "list-windows -t ={} -F '#{{window_id}} #{{window_active}} #{{window_layout}} #{{window_name}}'",
                self.name
            ),
            Pending::Windows,
        );
    }
}

#[derive(Default)]
pub struct ControlRegistry {
    sessions: Mutex<HashMap<String, Arc<ControlSession>>>,
    /// jterm pane id → (session name, `%N`). The reverse of `pane_key`, kept
    /// rather than recomputed because writing to a pane must not depend on
    /// guessing which session it came from.
    routes: Mutex<HashMap<String, (String, String)>>,
}

impl ControlRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn session(&self, name: &str) -> Option<Arc<ControlSession>> {
        self.sessions.lock().get(name).cloned()
    }

    /// The session and tmux pane behind a jterm pane id, if it is a tmux one.
    ///
    /// This is what lets `pty_write` and friends stay one function each: a pane
    /// id either routes here or it is an ordinary pty, and the caller does not
    /// have to know which kind it has before it asks.
    fn route(&self, pane: &str) -> Option<(Arc<ControlSession>, String)> {
        let (session, tmux_pane) = self.routes.lock().get(pane).cloned()?;
        Some((self.session(&session)?, tmux_pane))
    }

    pub fn has(&self, pane: &str) -> bool {
        self.routes.lock().contains_key(pane)
    }
}

/// Numbers each control pty so several sessions can be attached at once.
static NEXT: AtomicU64 = AtomicU64::new(0);

/* ── Attaching ───────────────────────────────────────────────────────────── */

/// Attach to `session` in control mode, creating it if it is not there.
///
/// Returns immediately; the shape of the session arrives on `tmux://windows`
/// once tmux has described it, which is the same path every later change takes.
/// Attaching twice to one session is a no-op rather than a second client —
/// two control clients on one session would each be told about the other's
/// every keystroke.
#[tauri::command]
pub fn tmux_control_attach(
    app: AppHandle,
    registry: tauri::State<'_, Arc<ControlRegistry>>,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if session.is_empty() {
        return Err("a session needs a name".into());
    }
    if !tmux::available() {
        return Err("tmux is not installed".into());
    }
    if registry.session(&session).is_some() {
        return Ok(());
    }
    let binary = tmux::program().ok_or("tmux is not installed")?;

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("could not open a pseudoterminal: {err}"))?;

    let mut cmd = CommandBuilder::new(binary);
    // `-C` twice is control mode with echo off, which is the mode meant here;
    // a single `-C` leaves tmux echoing the commands back.
    cmd.arg("-CC");
    cmd.arg("-u");
    cmd.arg("new-session");
    cmd.arg("-A");
    cmd.arg("-s");
    cmd.arg(&session);
    cmd.arg("-x");
    cmd.arg(cols.max(1).to_string());
    cmd.arg("-y");
    cmd.arg(rows.max(1).to_string());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "jterm");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("could not start tmux: {err}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("could not read from tmux: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("could not write to tmux: {err}"))?;
    drop(pair.slave);

    let client = Arc::new(ControlSession {
        name: session.clone(),
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        pending: Mutex::new(std::collections::VecDeque::new()),
        windows: Mutex::new(Vec::new()),
        sized: Mutex::new(None),
    });
    registry
        .sessions
        .lock()
        .insert(session.clone(), client.clone());

    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let _ = id;
    spawn_reader(app, registry.inner().clone(), client.clone(), reader);

    // The first description of the session. Everything after this one is tmux
    // telling us something changed.
    client.refresh_windows();
    Ok(())
}

/// Leave a control session without ending it.
#[tauri::command]
pub fn tmux_control_detach(registry: tauri::State<'_, Arc<ControlRegistry>>, session: String) {
    let Some(client) = registry.session(&session) else {
        return;
    };
    client.send("detach-client", Pending::Ignore);
    // Not killed here. tmux answers `detach-client` with `%exit`, and the
    // reader tears the session down when it sees it — going through the same
    // path as a session that ended on its own.
}

/// Which sessions are attached in control mode right now.
#[tauri::command]
pub fn tmux_control_attached(registry: tauri::State<'_, Arc<ControlRegistry>>) -> Vec<String> {
    registry.sessions.lock().keys().cloned().collect()
}

/* ── Talking to a pane ───────────────────────────────────────────────────── */

/// Send bytes to a control-mode pane. Returns false if it is not one.
pub fn write(registry: &ControlRegistry, pane: &str, data: &str) -> bool {
    let Some((client, tmux_pane)) = registry.route(pane) else {
        return false;
    };
    // Hex rather than `send-keys -l`: the literal form still interprets the
    // argument as a string tmux has opinions about, and what arrives here is
    // arbitrary bytes — a paste, a control character, half a UTF-8 sequence.
    for chunk in data.as_bytes().chunks(SEND_CHUNK) {
        let mut command = format!("send-keys -t {tmux_pane} -H");
        for byte in chunk {
            command.push_str(&format!(" {byte:02x}"));
        }
        client.send(&command, Pending::Ignore);
    }
    true
}

/// Tell tmux how big jterm is showing this session, in cells.
///
/// The size belongs to the *client*, not to a pane: tmux lays a window out
/// inside whatever the attached client offers, so this is how jterm's window
/// shape reaches tmux's arithmetic. A pane's own size is then tmux's business,
/// and comes back as a `%layout-change`.
pub fn resize(registry: &ControlRegistry, pane: &str, cols: u16, rows: u16) -> bool {
    let Some((client, tmux_pane)) = registry.route(pane) else {
        return false;
    };

    // What arrives is one *pane's* size, and what tmux needs is the whole
    // client's. Scaling by the share tmux itself gave that pane is what turns
    // one into the other — and it converges rather than oscillating, because
    // jterm laid the pane out from that very share in the first place.
    let scaled = scale_to_client(&client.windows.lock(), &tmux_pane, cols, rows);
    let Some((client_cols, client_rows)) = scaled else {
        return true;
    };

    // Every pane in the window reports within a frame of every other, and they
    // all scale to the same answer. Only the first is worth sending.
    let mut sized = client.sized.lock();
    if *sized == Some((client_cols, client_rows)) {
        return true;
    }
    *sized = Some((client_cols, client_rows));
    drop(sized);

    let master = client.master.lock();
    let _ = master.resize(PtySize {
        rows: client_rows,
        cols: client_cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    drop(master);
    client.send(
        &format!("refresh-client -C {client_cols}x{client_rows}"),
        Pending::Ignore,
    );
    true
}

/// Turn one pane's cell size into the size of the client showing it.
///
/// `None` when the pane is not in any known layout — which happens in the gap
/// between a pane first speaking and the `list-windows` that describes it, and
/// is a reason to do nothing rather than to guess.
fn scale_to_client(
    windows: &[WindowInfo],
    tmux_pane: &str,
    cols: u16,
    rows: u16,
) -> Option<(u16, u16)> {
    for window in windows {
        let (window_w, window_h) = match &window.layout {
            LayoutNode::Pane { width, height, .. } => (*width, *height),
            LayoutNode::Split { width, height, .. } => (*width, *height),
        };
        if let Some((pane_w, pane_h)) = find_pane(&window.layout, tmux_pane) {
            let scale = |cells: u16, part: u32, whole: u32| -> u16 {
                if part == 0 {
                    return cells.max(1);
                }
                let value = (u32::from(cells) * whole + part / 2) / part;
                value.clamp(1, u32::from(u16::MAX)) as u16
            };
            return Some((scale(cols, pane_w, window_w), scale(rows, pane_h, window_h)));
        }
    }
    None
}

fn find_pane(node: &LayoutNode, tmux_pane: &str) -> Option<(u32, u32)> {
    match node {
        LayoutNode::Pane {
            tmux,
            width,
            height,
            ..
        } => (tmux == tmux_pane).then_some((*width, *height)),
        LayoutNode::Split { children, .. } => children
            .iter()
            .find_map(|child| find_pane(child, tmux_pane)),
    }
}

/// Ask tmux for what a pane already has on screen.
///
/// Pulled by the pane rather than pushed when the layout arrives, and the
/// ordering is the reason: the layout is what *causes* the pane to be created,
/// so anything sent alongside it is sent to a component that does not exist yet
/// and is simply dropped. The pane asking once it is listening is the only
/// order that works.
///
/// Without this an attached session shows a screenful of nothing until its
/// programs happen to print something — which for a session left running is
/// most of the point of attaching to it.
#[tauri::command]
pub fn tmux_control_capture(registry: tauri::State<'_, Arc<ControlRegistry>>, pane: String) {
    let Some((client, tmux_pane)) = registry.route(&pane) else {
        return;
    };
    client.send(
        &format!("capture-pane -p -e -J -t {tmux_pane} -S -{CAPTURE_LINES}"),
        Pending::Capture(pane),
    );
}

/// Close a control-mode pane, which means killing tmux's.
pub fn kill(registry: &ControlRegistry, pane: &str) -> bool {
    let Some((client, tmux_pane)) = registry.route(pane) else {
        return false;
    };
    client.send(&format!("kill-pane -t {tmux_pane}"), Pending::Ignore);
    registry.routes.lock().remove(pane);
    true
}

/// Run a pane command against the tmux pane a jterm pane stands for.
///
/// The same shortcuts `crate::tmux` forwards for an in-a-pane tmux, aimed at a
/// pane id instead of at a session — here jterm knows exactly which tmux pane
/// the user is looking at, because it drew it.
#[tauri::command]
pub fn tmux_control_pane_command(
    registry: tauri::State<'_, Arc<ControlRegistry>>,
    pane: String,
    action: String,
) -> bool {
    let Some((client, tmux_pane)) = registry.route(&pane) else {
        return false;
    };
    let Some(words) = crate::tmux::pane_argv(&action) else {
        return false;
    };
    let line: Vec<String> = words.into_iter().map(quote).collect();
    client.send(
        &format!("{} -t {tmux_pane}", line.join(" ")),
        Pending::Ignore,
    );
    true
}

/// Quote a word for tmux's own command parser.
///
/// The two tmux paths in this app are not equivalent, and this is where the
/// difference bites. `crate::tmux` hands its words to `Command::new` as argv,
/// so tmux never parses them; control mode sends a *line* down the client's
/// stdin, and tmux parses it — at which point `#` begins a comment. The split
/// commands carry `-c #{pane_current_path}`, so unquoted they lose their
/// argument and tmux answers "-c expects an argument" into a `%error` block
/// nothing was watching.
fn quote(word: &str) -> String {
    // Flags and bare words are left alone: quoting a command name is legal but
    // makes the line harder to read in a log, and these are the only shapes
    // `pane_argv` produces.
    if word
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/'))
    {
        return word.to_string();
    }
    let escaped = word.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/* ── Reading what tmux says ──────────────────────────────────────────────── */

fn spawn_reader(
    app: AppHandle,
    registry: Arc<ControlRegistry>,
    client: Arc<ControlSession>,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        let mut line = Vec::<u8>::new();
        let mut state = Parser::default();

        loop {
            let read = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            for &byte in &buf[..read] {
                if byte == b'\n' {
                    let text = String::from_utf8_lossy(&line).replace('\r', "");
                    line.clear();
                    if !state.line(&app, &registry, &client, strip_wrapper(&text)) {
                        // `%exit`: tmux has finished with us.
                        finish(&app, &registry, &client);
                        return;
                    }
                } else {
                    line.push(byte);
                }
            }
        }

        finish(&app, &registry, &client);
    });
}

/// Drop the DCS the whole conversation is wrapped in.
///
/// tmux opens with `\x1bP1000p` on the same line as its first `%begin` and
/// closes with a String Terminator after `%exit`; neither is part of the
/// line-based protocol inside.
fn strip_wrapper(line: &str) -> &str {
    let line = line.strip_prefix("\u{1b}P1000p").unwrap_or(line);
    line.trim_end_matches("\u{1b}\\")
}

fn finish(app: &AppHandle, registry: &ControlRegistry, client: &ControlSession) {
    registry.sessions.lock().remove(&client.name);

    // Every pane of this session is now gone as far as the window is concerned.
    // Told individually as well as collectively: a pane component listens for
    // its own exit, and the workspace listens for the session's.
    let mut routes = registry.routes.lock();
    let dead: Vec<String> = routes
        .iter()
        .filter(|(_, (session, _))| session == &client.name)
        .map(|(pane, _)| pane.clone())
        .collect();
    for pane in &dead {
        routes.remove(pane);
    }
    drop(routes);

    for pane in dead {
        let _ = app.emit(
            EXIT_EVENT,
            ExitPayload {
                id: &pane,
                code: None,
            },
        );
    }
    let _ = app.emit(CLOSED_EVENT, &client.name);
    let _ = client.child.lock().kill();
}

/// Where the reader is in the block/notification grammar.
#[derive(Default)]
struct Parser {
    /// Lines of the block being read, when inside one.
    block: Option<Vec<String>>,
    /// Whether the block being read is a reply to something jterm asked.
    ///
    /// tmux opens the conversation with a `%begin`/`%end` pair of its own,
    /// before any command has been sent. Treating that as a reply consumes the
    /// slot queued for the first real command, and every reply after it is
    /// matched to the wrong question — which shows up as a session that
    /// attaches and then never appears, because the `list-windows` describing
    /// it was read as the answer to nothing. The third field of `%begin` is a
    /// flag set only on replies, and telling them apart is its whole purpose.
    solicited: bool,
    /// Windows learned from the last `list-windows`, kept so a `%layout-change`
    /// can revise one of them without asking for all of them again.
    windows: Vec<WindowInfo>,
}

impl Parser {
    /// Handle one line. Returns false when the session is over.
    fn line(
        &mut self,
        app: &AppHandle,
        registry: &ControlRegistry,
        client: &ControlSession,
        line: &str,
    ) -> bool {
        if let Some(block) = self.block.as_mut() {
            if line.starts_with("%end ") || line.starts_with("%error ") {
                let lines = self.block.take().unwrap_or_default();
                if !self.solicited {
                    // tmux talking to itself. Nothing was asked, so nothing is
                    // waiting, and popping here would rob the next reply.
                    return true;
                }
                let what = client.pending.lock().pop_front();
                // An `%error` block's lines are the message rather than the
                // reply, so nothing is read out of it — but its slot is still
                // consumed, or every later reply would be off by one.
                if !line.starts_with("%error ") {
                    self.reply(app, registry, client, what, lines);
                }
                return true;
            }
            block.push(line.to_string());
            return true;
        }

        if let Some(rest) = line.strip_prefix("%begin ") {
            self.block = Some(Vec::new());
            self.solicited = rest.split(' ').nth(2).is_some_and(|flags| flags != "0");
            return true;
        }
        if let Some(rest) = line.strip_prefix("%output ") {
            self.output(app, registry, client, rest);
            return true;
        }
        if line.starts_with("%layout-change ") || line.starts_with("%window-renamed ") {
            // Both change what a window is, and both are cheapest to answer by
            // asking tmux to describe the session again — one round trip
            // against the alternative of a second parser for a second format.
            client.refresh_windows();
            return true;
        }
        if line.starts_with("%window-add ")
            || line.starts_with("%window-close ")
            || line.starts_with("%unlinked-window-close ")
            || line.starts_with("%session-window-changed ")
        {
            client.refresh_windows();
            return true;
        }
        if line == "%exit" || line.starts_with("%exit ") {
            return false;
        }
        true
    }

    /// `%output %3 <escaped bytes>`
    fn output(
        &mut self,
        app: &AppHandle,
        registry: &ControlRegistry,
        client: &ControlSession,
        rest: &str,
    ) {
        let Some((tmux_pane, data)) = rest.split_once(' ') else {
            // A pane that printed nothing at all still announces itself.
            return;
        };
        let id = pane_key(&client.name, tmux_pane);
        // Registered on first sight rather than only from the layout: output can
        // arrive for a pane before the `list-windows` describing it comes back,
        // and a keystroke aimed at that pane in between must still find its way.
        registry
            .routes
            .lock()
            .insert(id.clone(), (client.name.clone(), tmux_pane.to_string()));

        let chunk = unescape_output(data);
        if chunk.is_empty() {
            return;
        }
        let _ = app.emit(
            DATA_EVENT,
            DataPayload {
                id: &id,
                chunk: &chunk,
            },
        );
    }

    fn reply(
        &mut self,
        app: &AppHandle,
        registry: &ControlRegistry,
        client: &ControlSession,
        what: Option<Pending>,
        lines: Vec<String>,
    ) {
        match what {
            Some(Pending::Windows) => {
                self.windows = lines
                    .iter()
                    .filter_map(|line| parse_window_line(&client.name, line))
                    .collect();
                *client.windows.lock() = self.windows.clone();
                // The window may have changed shape, so the size last sent is
                // no longer known to be the one tmux is working from.
                *client.sized.lock() = None;

                // Every pane in the new shape is routable, and any pane never
                // seen before gets its history asked for. Both have to happen
                // before the frontend hears about the layout, or the pane it
                // mounts would come up blank and unwritable.
                let mut routes = registry.routes.lock();
                for window in &self.windows {
                    for (id, tmux_pane) in panes_of(&window.layout) {
                        routes.insert(id, (client.name.clone(), tmux_pane));
                    }
                }
                drop(routes);

                let _ = app.emit(
                    WINDOWS_EVENT,
                    SessionInfo {
                        session: client.name.clone(),
                        windows: self.windows.clone(),
                    },
                );
            }

            Some(Pending::Capture(pane)) => {
                // `capture-pane` returns the pane's whole height, blank rows
                // included, so a pane holding three lines of output comes back
                // as three lines and forty of nothing. Written out as-is that
                // is a screen of content followed by a gap, with the live
                // prompt stranded at the bottom.
                let end = lines
                    .iter()
                    .rposition(|line| !line.trim().is_empty())
                    .map_or(0, |at| at + 1);
                let lines = &lines[..end];
                if lines.is_empty() {
                    return;
                }
                // Joined rather than terminated: the last line is where the
                // cursor is, and a newline after it would push the prompt tmux
                // is about to redraw onto a line of its own.
                let text = lines.join("\r\n");
                let _ = app.emit(
                    DATA_EVENT,
                    DataPayload {
                        id: &pane,
                        chunk: &text,
                    },
                );
            }

            Some(Pending::Ignore) | None => {}
        }
    }
}

/// `@0 1 bb62,80x24,0,0,0 window name here`
fn parse_window_line(session: &str, line: &str) -> Option<WindowInfo> {
    let mut parts = line.splitn(4, ' ');
    let id = parts.next()?.to_string();
    if !id.starts_with('@') {
        return None;
    }
    let active = parts.next()? == "1";
    let layout = parse_layout(session, parts.next()?)?;
    let name = parts.next().unwrap_or_default().to_string();
    Some(WindowInfo {
        id,
        name,
        active,
        layout,
    })
}

/// Every (jterm pane id, `%N`) in a layout, depth first.
fn panes_of(node: &LayoutNode) -> Vec<(String, String)> {
    match node {
        LayoutNode::Pane { id, tmux, .. } => vec![(id.clone(), tmux.clone())],
        LayoutNode::Split { children, .. } => children.iter().flat_map(panes_of).collect(),
    }
}

/* ── The layout string ───────────────────────────────────────────────────── */

/// Parse a tmux layout, e.g. `bb62,158x40,0,0{79x40,0,0,0,78x40,80,0,1}`.
///
/// After a four-digit checksum it is cells: `WxH,x,y` followed by either `,N`
/// for a pane numbered N, or a bracketed list of child cells. `{}` puts the
/// children side by side and `[]` stacks them — which is the opposite way round
/// from how it reads, since the braces describe the *dividers*' direction.
pub fn parse_layout(session: &str, text: &str) -> Option<LayoutNode> {
    // The checksum is tmux's own integrity check on the rest, and is not
    // something this has any use for.
    let body = text.split_once(',')?.1;
    let bytes = body.as_bytes();
    let mut at = 0usize;
    let node = parse_cell(session, bytes, &mut at)?;
    Some(node)
}

fn parse_cell(session: &str, bytes: &[u8], at: &mut usize) -> Option<LayoutNode> {
    let width = parse_u32(bytes, at)?;
    expect(bytes, at, b'x')?;
    let height = parse_u32(bytes, at)?;
    expect(bytes, at, b',')?;
    let _x = parse_u32(bytes, at)?;
    expect(bytes, at, b',')?;
    let _y = parse_u32(bytes, at)?;

    match bytes.get(*at) {
        Some(b',') => {
            *at += 1;
            let number = parse_u32(bytes, at)?;
            let tmux = format!("%{number}");
            Some(LayoutNode::Pane {
                id: pane_key(session, &tmux),
                tmux,
                width,
                height,
            })
        }
        Some(&open @ (b'{' | b'[')) => {
            *at += 1;
            let close = if open == b'{' { b'}' } else { b']' };
            let axis = if open == b'{' { "x" } else { "y" };
            let mut children = Vec::new();
            loop {
                children.push(parse_cell(session, bytes, at)?);
                match bytes.get(*at) {
                    Some(b',') => *at += 1,
                    Some(&ch) if ch == close => {
                        *at += 1;
                        break;
                    }
                    _ => return None,
                }
            }
            // A split with one child is not a split. tmux does not produce them,
            // but a malformed string should not become a tree with a degenerate
            // node the frontend then has to defend against.
            if children.len() == 1 {
                return children.pop();
            }
            Some(LayoutNode::Split {
                axis: axis.to_string(),
                width,
                height,
                children,
            })
        }
        _ => None,
    }
}

fn parse_u32(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let start = *at;
    while matches!(bytes.get(*at), Some(ch) if ch.is_ascii_digit()) {
        *at += 1;
    }
    if start == *at {
        return None;
    }
    std::str::from_utf8(&bytes[start..*at]).ok()?.parse().ok()
}

fn expect(bytes: &[u8], at: &mut usize, want: u8) -> Option<()> {
    if bytes.get(*at) == Some(&want) {
        *at += 1;
        Some(())
    } else {
        None
    }
}

/* ── `%output` escaping ──────────────────────────────────────────────────── */

/// Undo tmux's escaping of a pane's bytes.
///
/// Printable ASCII travels as itself; anything else is a backslash and three
/// octal digits. A byte sequence that is not valid UTF-8 on its own — half a
/// character, split across two `%output` lines — is replaced rather than
/// dropped, which shifts the display for one character instead of desyncing
/// everything after it.
fn unescape_output(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0usize;

    while at < bytes.len() {
        if bytes[at] == b'\\' && at + 3 < bytes.len() {
            let digits = &bytes[at + 1..at + 4];
            if digits.iter().all(|ch| (b'0'..=b'7').contains(ch)) {
                let value = digits
                    .iter()
                    .fold(0u32, |acc, ch| acc * 8 + u32::from(ch - b'0'));
                out.push(value as u8);
                at += 4;
                continue;
            }
        }
        if bytes[at] == b'\\' && bytes.get(at + 1) == Some(&b'\\') {
            out.push(b'\\');
            at += 2;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_pane_window_is_a_bare_leaf() {
        let node = parse_layout("work", "bb62,80x24,0,0,0").expect("a valid layout");
        assert_eq!(
            node,
            LayoutNode::Pane {
                id: "tmux-work-0".into(),
                tmux: "%0".into(),
                width: 80,
                height: 24,
            }
        );
    }

    #[test]
    fn braces_are_side_by_side_and_brackets_are_stacked() {
        // The pair tmux actually emitted for a `split-window -h` and a `-v`.
        let across = parse_layout("w", "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}").unwrap();
        let down = parse_layout("w", "419a,80x24,0,0[80x12,0,0,1,80x11,0,13,2]").unwrap();
        match across {
            LayoutNode::Split { axis, .. } => assert_eq!(axis, "x"),
            _ => panic!("a split-window -h is a split"),
        }
        match down {
            LayoutNode::Split { axis, .. } => assert_eq!(axis, "y"),
            _ => panic!("a split-window -v is a split"),
        }
    }

    #[test]
    fn keeps_the_sizes_the_ratios_are_worked_out_from() {
        let node = parse_layout("w", "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}").unwrap();
        let LayoutNode::Split {
            children,
            width,
            height,
            ..
        } = node
        else {
            panic!("a split")
        };
        assert_eq!((width, height), (80, 24));
        assert_eq!(children.len(), 2);
        match &children[0] {
            LayoutNode::Pane { width, tmux, .. } => {
                assert_eq!(*width, 40);
                assert_eq!(tmux, "%0");
            }
            _ => panic!("a leaf"),
        }
    }

    #[test]
    fn nests_a_split_inside_a_split() {
        // Three panes: one down the left, two stacked on the right.
        let node = parse_layout(
            "w",
            "abcd,80x24,0,0{40x24,0,0,0,39x24,41,0[39x12,41,0,1,39x11,41,13,2]}",
        )
        .expect("a valid nested layout");
        let LayoutNode::Split { children, .. } = &node else {
            panic!("a split")
        };
        assert_eq!(children.len(), 2);
        let LayoutNode::Split { axis, children, .. } = &children[1] else {
            panic!("the second child is itself a split")
        };
        assert_eq!(axis, "y");
        assert_eq!(children.len(), 2);
        assert_eq!(
            panes_of(&node)
                .into_iter()
                .map(|(_, tmux)| tmux)
                .collect::<Vec<_>>(),
            vec!["%0", "%1", "%2"],
        );
    }

    #[test]
    fn a_layout_with_more_than_two_panes_at_one_level_survives() {
        // tmux is happy to put three panes in a row; jterm's tree is binary, so
        // the frontend has to fold this — but nothing may be lost on the way.
        let node = parse_layout("w", "aaaa,90x24,0,0{30x24,0,0,0,30x24,31,0,1,28x24,62,0,2}")
            .expect("a valid three-way layout");
        let LayoutNode::Split { children, .. } = &node else {
            panic!("a split")
        };
        assert_eq!(children.len(), 3);
    }

    #[test]
    fn refuses_a_layout_it_cannot_read() {
        assert!(parse_layout("w", "").is_none());
        assert!(parse_layout("w", "bb62").is_none());
        assert!(parse_layout("w", "bb62,80x24,0,0{40x24,0,0,0").is_none());
        assert!(parse_layout("w", "bb62,notasize,0,0,0").is_none());
    }

    #[test]
    fn unescapes_the_octal_tmux_writes() {
        // Straight from a real `%output` line.
        assert_eq!(
            unescape_output("\\033[?2004hhello\\015\\012"),
            "\u{1b}[?2004hhello\r\n"
        );
        // A backslash the pane actually printed.
        assert_eq!(unescape_output("c:\\\\path"), "c:\\path");
        // Not an escape: too few digits, and a digit outside octal.
        assert_eq!(unescape_output("\\01"), "\\01");
        assert_eq!(unescape_output("\\098"), "\\098");
    }

    #[test]
    fn pane_ids_are_derived_and_legal_as_file_names() {
        let id = pane_key("my work: session", "%12");
        assert_eq!(id, "tmux-my-work--session-12");
        // `history.rs` will not accept anything else.
        assert!(id.len() <= 64);
        assert!(id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
        // The same pane is the same id every time, which is what stops a layout
        // change from remounting a live terminal.
        assert_eq!(pane_key("work", "%3"), pane_key("work", "%3"));
    }

    #[test]
    fn a_window_line_parses_into_a_window() {
        let window =
            parse_window_line("work", "@2 1 bb62,80x24,0,0,5 my window").expect("a valid line");
        assert_eq!(window.id, "@2");
        assert!(window.active);
        // The name is taken last precisely because it may hold spaces.
        assert_eq!(window.name, "my window");
    }

    #[test]
    fn ignores_a_line_that_is_not_a_window() {
        assert!(parse_window_line("w", "").is_none());
        assert!(parse_window_line("w", "no leading at-sign 1 bb62,80x24,0,0,0").is_none());
    }

    #[test]
    fn quotes_the_words_tmuxs_own_parser_would_mangle() {
        // The one that matters: `#` opens a comment in tmux's parser, so the
        // split commands silently lost their `-c` argument until this existed.
        assert_eq!(quote("#{pane_current_path}"), "\"#{pane_current_path}\"");
        // Flags and plain words are left legible.
        assert_eq!(quote("split-window"), "split-window");
        assert_eq!(quote("-v"), "-v");
        assert_eq!(quote("/home/someone"), "/home/someone");
        // Anything with a quote or a backslash in it stays one word.
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn every_pane_action_survives_quoting_intact() {
        // A word list that came back unquoted where it needed quoting is a
        // command tmux rejects into a `%error` nothing reads, so the failure is
        // invisible — which is exactly why this is asserted rather than tried.
        for action in ["split-right", "split-down", "zoom", "focus-left", "grow-up"] {
            let words = crate::tmux::pane_argv(action).expect("a known action");
            let line: Vec<String> = words.into_iter().map(quote).collect();
            assert!(!line.join(" ").contains(" #"), "{action} left a bare #");
        }
    }

    #[test]
    fn tells_tmuxs_opening_block_from_a_reply_to_a_command() {
        // The lines tmux really sends. The first pair is unprompted — treating
        // it as a reply consumes the slot queued for the first real command and
        // every answer after it lands on the wrong question.
        let flags = |line: &str| {
            line.strip_prefix("%begin ")
                .and_then(|rest| rest.split(' ').nth(2))
                .is_some_and(|flags| flags != "0")
        };
        assert!(!flags("%begin 1786410547 264 0"));
        assert!(flags("%begin 1786410550 270 1"));
        // A `%begin` with nothing after it is not a reply either.
        assert!(!flags("%begin"));
    }

    #[test]
    fn strips_the_dcs_wrapper_the_conversation_arrives_in() {
        assert_eq!(strip_wrapper("\u{1b}P1000p%begin 1 2 0"), "%begin 1 2 0");
        assert_eq!(strip_wrapper("%exit\u{1b}\\"), "%exit");
        assert_eq!(strip_wrapper("%output %0 hi"), "%output %0 hi");
    }
}
