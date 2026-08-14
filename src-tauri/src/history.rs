//! The record every terminal leaves behind.
//!
//! Each terminal pane owns a file — `terminals/<pane>.jsonl` — that exists for
//! as long as the pane does. One JSON object per line, appended as things
//! happen: the shell starting, each command submitted, the working directory
//! moving, the half-typed line changing, the shell exiting.
//!
//! JSONL rather than JSON because it is the only shape that can be *appended*
//! to safely. A JSON array has to be rewritten to add an element, which means
//! a crash mid-write can cost the whole file; a line-delimited log truncates at
//! worst to the last complete line, and a reader that skips unparseable lines
//! loses only the record that was being written.
//!
//! This is also the substrate for everything else. The unsubmitted prompt is
//! just another record kind, so the same file answers "what was I running" and
//! "what had I typed but not run" — and `export` folds every terminal's log,
//! the workspace layout and the raw scrollback into one file of the same
//! format, which `import` reads back.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::store::Store;

/// A terminal's log is trimmed once it passes this.
const HISTORY_MAX: u64 = 4 * 1024 * 1024;
/// How much is kept when it is trimmed. The gap stops a busy pane from
/// trimming on nearly every write.
const HISTORY_KEEP: usize = 1024 * 1024;

/// Refuse a pane id that could climb out of the directory it names.
///
/// Ids are minted by this app and never typed by a user, but they arrive over
/// IPC and are used to build a path, which is exactly the shape of bug worth
/// closing off rather than reasoning about.
fn safe_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-');
    if ok {
        Ok(id)
    } else {
        Err("invalid pane id".into())
    }
}

fn terminals_dir(store: &Store) -> PathBuf {
    store.root().join("terminals")
}

fn log_path(store: &Store, id: &str) -> PathBuf {
    terminals_dir(store).join(format!("{id}.jsonl"))
}

/// Append one record. `record` is a complete JSON object, already serialised
/// by the caller — the frontend owns the vocabulary of record kinds, and
/// duplicating that enum here would mean changing two files to add one.
pub fn append(store: &Store, id: &str, record: &str) -> Result<(), String> {
    let id = safe_id(id)?;
    let dir = terminals_dir(store);
    let _ = fs::create_dir_all(&dir);

    // A record containing a newline would become two malformed lines; the only
    // safe thing is to refuse it rather than write a corrupt log.
    if record.contains('\n') || record.contains('\r') {
        return Err("a record may not contain a line break".into());
    }

    let path = log_path(store, id);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("cannot open the terminal log: {err}"))?;
    writeln!(file, "{record}").map_err(|err| format!("cannot write the terminal log: {err}"))?;

    if file.metadata().map(|meta| meta.len()).unwrap_or(0) > HISTORY_MAX {
        drop(file);
        trim(&path);
    }
    Ok(())
}

/// Drop the oldest records, keeping whole lines.
fn trim(path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    if text.len() <= HISTORY_KEEP {
        return;
    }
    // Cut at a line break so the file never begins with half a record.
    let tail = &text[text.len() - HISTORY_KEEP..];
    let start = tail.find('\n').map(|index| index + 1).unwrap_or(0);
    let _ = fs::write(path, &tail[start..]);
}

pub fn read(store: &Store, id: &str) -> String {
    match safe_id(id) {
        Ok(id) => fs::read_to_string(log_path(store, id)).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

pub fn drop_log(store: &Store, id: &str) {
    if let Ok(id) = safe_id(id) {
        let _ = fs::remove_file(log_path(store, id));
    }
}

/// Delete logs for panes the snapshot no longer mentions.
pub fn prune(store: &Store, keep: &[String]) {
    let Ok(entries) = fs::read_dir(terminals_dir(store)) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !keep.iter().any(|id| id == stem) {
            let _ = fs::remove_file(&path);
        }
    }
}

/* ── Searching every log at once ─────────────────────────────────────────── */

/// One command that matched, and enough to know where it came from.
#[derive(Serialize)]
pub struct Hit {
    /// The pane it was run in, so the caller can say "this tab" if it wants.
    pub pane: String,
    pub text: String,
    pub cwd: Option<String>,
    /// ISO-8601, as the frontend wrote it. Absent on a record old enough to
    /// predate the field, which is why it is an `Option` rather than a default.
    pub at: Option<String>,
}

/// Every command matching `query`, newest first, one entry per distinct text.
///
/// Done here rather than in the frontend because the alternative is shipping
/// every log over the IPC boundary to filter them there — megabytes to answer
/// a question whose answer is twenty lines. The files are already capped by
/// `HISTORY_MAX`, so the whole scan is bounded.
///
/// **Matching is all-terms-must-appear**, case-insensitively, against the
/// command *and* the directory it ran in — so `docker jterm` finds the docker
/// commands run in the jterm checkout without a syntax for saying so. Not
/// fuzzy: a terminal history is something you half-remember, and a fuzzy match
/// over thousands of commands returns confident nonsense. Substring matching
/// fails honestly instead.
///
/// **Deduplicated by text, keeping the most recent.** A command you ran forty
/// times should be one row that says where you last ran it, not forty rows.
pub fn search(store: &Store, query: &str, limit: usize) -> Vec<Hit> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .collect();

    let Ok(entries) = fs::read_dir(terminals_dir(store)) else {
        return Vec::new();
    };

    let mut hits: Vec<Hit> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Some(pane) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };

        for line in text.lines() {
            // A damaged line is skipped rather than failing the search, for the
            // same reason `import` skips one: a log is append-only and the last
            // line of it may have been half-written when the machine died.
            let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if record.get("kind").and_then(Value::as_str) != Some("command") {
                continue;
            }
            let Some(command) = record.get("text").and_then(Value::as_str) else {
                continue;
            };
            if command.trim().is_empty() {
                continue;
            }
            let cwd = record.get("cwd").and_then(Value::as_str);

            let haystack = format!(
                "{} {}",
                command.to_lowercase(),
                cwd.unwrap_or("").to_lowercase()
            );
            if !terms.iter().all(|term| haystack.contains(term.as_str())) {
                continue;
            }

            hits.push(Hit {
                pane: pane.to_string(),
                text: command.to_string(),
                cwd: cwd.map(str::to_string),
                at: record.get("at").and_then(Value::as_str).map(str::to_string),
            });
        }
    }

    // ISO-8601 sorts correctly as text, which is the whole reason the frontend
    // writes it in that form. A record with no timestamp sorts oldest.
    hits.sort_by(|a, b| b.at.cmp(&a.at));

    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut unique: Vec<Hit> = Vec::with_capacity(limit.min(hits.len()));
    for hit in &hits {
        if unique.len() >= limit {
            break;
        }
        if seen.insert(hit.text.as_str()) {
            unique.push(Hit {
                pane: hit.pane.clone(),
                text: hit.text.clone(),
                cwd: hit.cwd.clone(),
                at: hit.at.clone(),
            });
        }
    }
    unique
}

/* ── One file for the whole session ──────────────────────────────────────── */

#[derive(Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub lines: usize,
    pub bytes: u64,
}

fn line(kind: &str, fields: Vec<(&str, Value)>) -> String {
    let mut map = Map::new();
    map.insert("kind".into(), Value::String(kind.into()));
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map).to_string()
}

/// Fold everything on disk into a single JSONL file.
///
/// Same format as a terminal's own log, one record per line, so the export is
/// readable with the same tools — `grep`, `jq -c`, `wc -l` — as the thing it
/// was made from. Order matters on the way back in: the layout has to be known
/// before scrollback can be attached to a pane, so it is written first.
pub fn export(store: &Store, dest: &str) -> Result<ExportSummary, String> {
    let mut out = String::new();
    let mut lines = 0usize;

    let mut push = |text: String| {
        out.push_str(&text);
        out.push('\n');
        lines += 1;
    };

    push(line(
        "meta",
        vec![
            ("app", Value::String("jterm".into())),
            ("version", Value::String(env!("CARGO_PKG_VERSION").into())),
            ("format", Value::from(1)),
        ],
    ));

    // The workspace: tabs, the split layout, and every pane's unsubmitted
    // prompt, exactly as the crash-recovery snapshot holds them.
    if let Some(text) = store.load_session() {
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => push(line("session", vec![("data", value)])),
            // A snapshot that will not parse is still worth carrying across;
            // it is the user's data and the importer can decide.
            Err(_) => push(line("session_raw", vec![("text", Value::String(text))])),
        }
    }

    for id in pane_ids(store) {
        let log = read(store, &id);
        for record in log.lines().filter(|record| !record.trim().is_empty()) {
            // A line that will not parse is left behind rather than carried
            // across as a string; the export is meant to be readable by the
            // same tools as the log, and half a record is not.
            if let Ok(value) = serde_json::from_str::<Value>(record) {
                push(line(
                    "terminal",
                    vec![("pane", Value::String(id.clone())), ("record", value)],
                ));
            }
        }

        let scrollback = store.read_scrollback(&id);
        if !scrollback.is_empty() {
            push(line(
                "scrollback",
                vec![
                    ("pane", Value::String(id.clone())),
                    ("text", Value::String(scrollback)),
                ],
            ));
        }
    }

    let path = PathBuf::from(dest);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, out.as_bytes()).map_err(|err| format!("cannot write {dest}: {err}"))?;

    Ok(ExportSummary {
        path: path.to_string_lossy().into_owned(),
        lines,
        bytes: out.len() as u64,
    })
}

/// Every pane that has left something on disk, from either directory.
fn pane_ids(store: &Store) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for (dir, ext) in [
        (terminals_dir(store), "jsonl"),
        (store.root().join("scrollback"), "log"),
    ] {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|found| found != ext) {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                if !ids.iter().any(|seen| seen == stem) {
                    ids.push(stem.to_string());
                }
            }
        }
    }
    ids.sort();
    ids
}

/// Read an exported file back, replacing what is on disk.
///
/// Returns the session snapshot so the caller can restore the workspace in
/// memory without a relaunch. Unparseable lines are skipped rather than
/// failing the import: one bad record should not cost the other thousand.
pub fn import(store: &Store, src: &str) -> Result<Option<String>, String> {
    let text = fs::read_to_string(src).map_err(|err| format!("cannot read {src}: {err}"))?;

    let mut session: Option<String> = None;
    let mut logs: Vec<(String, String)> = Vec::new();
    let mut scrollbacks: Vec<(String, String)> = Vec::new();

    for raw in text.lines() {
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        match record.get("kind").and_then(Value::as_str) {
            Some("session") => {
                if let Some(data) = record.get("data") {
                    session = Some(data.to_string());
                }
            }
            Some("session_raw") => {
                if let Some(Value::String(text)) = record.get("text") {
                    session = Some(text.clone());
                }
            }
            Some("terminal") => {
                if let (Some(Value::String(pane)), Some(inner)) =
                    (record.get("pane"), record.get("record"))
                {
                    logs.push((pane.clone(), inner.to_string()));
                }
            }
            Some("scrollback") => {
                if let (Some(Value::String(pane)), Some(Value::String(text))) =
                    (record.get("pane"), record.get("text"))
                {
                    scrollbacks.push((pane.clone(), text.clone()));
                }
            }
            _ => {}
        }
    }

    // Written only once the whole file has parsed, so a truncated export
    // cannot leave the app with half of one session and half of another.
    let _ = fs::create_dir_all(terminals_dir(store));
    for (pane, _) in &logs {
        if let Ok(id) = safe_id(pane) {
            let _ = fs::remove_file(log_path(store, id));
        }
    }
    for (pane, record) in &logs {
        let _ = append(store, pane, record);
    }
    for (pane, text) in &scrollbacks {
        store.replace_scrollback(pane, text.as_bytes());
    }
    if let Some(snapshot) = &session {
        store
            .save_session(snapshot)
            .map_err(|err| format!("cannot restore the session: {err}"))?;
    }

    Ok(session)
}

/* ── Commands ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn history_append(
    store: tauri::State<'_, Arc<Store>>,
    id: String,
    record: String,
) -> Result<(), String> {
    append(&store, &id, &record)
}

#[tauri::command]
pub fn history_read(store: tauri::State<'_, Arc<Store>>, id: String) -> String {
    read(&store, &id)
}

#[tauri::command]
pub fn history_drop(store: tauri::State<'_, Arc<Store>>, id: String) {
    drop_log(&store, &id);
}

#[tauri::command]
pub fn history_prune(store: tauri::State<'_, Arc<Store>>, keep: Vec<String>) {
    prune(&store, &keep);
}

/// `limit` is capped here rather than trusted: the caller is the frontend, and
/// a list nobody can read is not a better answer than a list they can.
#[tauri::command]
pub fn history_search(
    store: tauri::State<'_, Arc<Store>>,
    query: String,
    limit: Option<usize>,
) -> Vec<Hit> {
    search(&store, &query, limit.unwrap_or(80).min(500))
}

#[tauri::command]
pub fn history_export(
    store: tauri::State<'_, Arc<Store>>,
    path: String,
) -> Result<ExportSummary, String> {
    export(&store, &path)
}

#[tauri::command]
pub fn history_import(
    store: tauri::State<'_, Arc<Store>>,
    path: String,
) -> Result<Option<String>, String> {
    import(&store, &path)
}

/// Where a terminal's own log lives, so the app can show the user the path.
#[tauri::command]
pub fn history_path(store: tauri::State<'_, Arc<Store>>, id: String) -> Result<String, String> {
    let id = safe_id(&id)?;
    Ok(log_path(&store, id).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Arc<Store>, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "jterm-hist-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        (Store::open(root.clone()), root)
    }

    #[test]
    fn appends_one_record_per_line() {
        let (store, root) = temp_store();
        append(&store, "abc", r#"{"kind":"command","text":"ls"}"#).unwrap();
        append(&store, "abc", r#"{"kind":"command","text":"pwd"}"#).unwrap();
        let text = read(&store, "abc");
        assert_eq!(text.lines().count(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_a_record_that_would_break_the_line_format() {
        let (store, root) = temp_store();
        assert!(append(&store, "abc", "{\"a\":\"one\ntwo\"}").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_a_pane_id_that_is_a_path() {
        let (store, root) = temp_store();
        assert!(append(&store, "../escape", "{}").is_err());
        assert!(append(&store, "", "{}").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_finds_commands_across_every_pane_newest_first() {
        let (store, root) = temp_store();
        append(
            &store,
            "paneone",
            r#"{"kind":"command","at":"2026-01-01T00:00:00Z","text":"cargo build","cwd":"/a"}"#,
        )
        .unwrap();
        append(
            &store,
            "panetwo",
            r#"{"kind":"command","at":"2026-02-01T00:00:00Z","text":"cargo test","cwd":"/b"}"#,
        )
        .unwrap();

        let hits = search(&store, "cargo", 10);
        assert_eq!(hits.len(), 2, "both panes are searched");
        assert_eq!(hits[0].text, "cargo test", "newest first");
        assert_eq!(hits[0].pane, "panetwo");
        assert_eq!(hits[1].cwd.as_deref(), Some("/a"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_term_has_to_appear_and_the_directory_counts_as_text() {
        let (store, root) = temp_store();
        append(
            &store,
            "abc",
            r#"{"kind":"command","at":"2026-01-01T00:00:00Z","text":"docker ps","cwd":"/home/me/jterm"}"#,
        )
        .unwrap();
        append(
            &store,
            "abc",
            r#"{"kind":"command","at":"2026-01-02T00:00:00Z","text":"docker ps","cwd":"/home/me/other"}"#,
        )
        .unwrap();

        // The directory is part of the haystack, so this narrows to one of them
        // without needing a syntax for saying "in this folder".
        assert_eq!(search(&store, "docker jterm", 10).len(), 1);
        // Every term must appear; one that does not eliminates the row.
        assert!(search(&store, "docker nonesuch", 10).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn one_row_per_command_however_often_it_was_run() {
        let (store, root) = temp_store();
        for day in 1..=5 {
            append(
                &store,
                "abc",
                &format!(
                    r#"{{"kind":"command","at":"2026-01-0{day}T00:00:00Z","text":"make","cwd":"/w"}}"#
                ),
            )
            .unwrap();
        }
        let hits = search(&store, "make", 10);
        assert_eq!(hits.len(), 1, "deduplicated by text");
        assert_eq!(
            hits[0].at.as_deref(),
            Some("2026-01-05T00:00:00Z"),
            "the most recent one is kept"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_everything_that_is_not_a_command() {
        let (store, root) = temp_store();
        append(
            &store,
            "abc",
            r#"{"kind":"draft","at":"2026-01-01T00:00:00Z","text":"cargo half-typed"}"#,
        )
        .unwrap();
        append(
            &store,
            "abc",
            r#"{"kind":"spawn","at":"2026-01-01T00:00:00Z","shell":"/bin/cargo"}"#,
        )
        .unwrap();
        append(&store, "abc", "this line is not json at all").unwrap();
        assert!(
            search(&store, "cargo", 10).is_empty(),
            "a draft is what you did not run, and must not come back as if you had"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_round_trip_preserves_the_session_and_the_logs() {
        let (store, root) = temp_store();
        store
            .save_session(r#"{"version":1,"workspace":{"tabs":[]}}"#)
            .unwrap();
        append(&store, "abc", r#"{"kind":"command","text":"make"}"#).unwrap();
        store.append_scrollback("abc", b"hello world\n");
        store.flush_scrollback("abc");

        let dest = root.join("export.jsonl");
        let summary = export(&store, dest.to_str().unwrap()).unwrap();
        assert!(summary.lines >= 4, "meta + session + record + scrollback");

        // Wipe, then read it back.
        drop_log(&store, "abc");
        store.drop_scrollback("abc");
        let restored = import(&store, dest.to_str().unwrap()).unwrap();

        assert!(restored.is_some());
        assert!(read(&store, "abc").contains("make"));
        assert!(store.read_scrollback("abc").contains("hello world"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_skips_a_damaged_line_rather_than_failing() {
        let (store, root) = temp_store();
        let dest = root.join("broken.jsonl");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &dest,
            "{\"kind\":\"meta\"}\nthis is not json\n{\"kind\":\"terminal\",\"pane\":\"abc\",\"record\":{\"kind\":\"command\",\"text\":\"ok\"}}\n",
        )
        .unwrap();
        import(&store, dest.to_str().unwrap()).unwrap();
        assert!(read(&store, "abc").contains("ok"));
        let _ = fs::remove_dir_all(root);
    }
}
