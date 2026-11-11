//! The sidebar's Git tab: what has changed, and the handful of things you do
//! about it without leaving the window.
//!
//! Everything goes through the `git` binary rather than a library. The user's
//! git is the one that already knows their credential helpers, their hooks,
//! their `safe.directory` list and whatever `core.fsmonitor` they set up — a
//! reimplementation would disagree with the terminal next to it about what the
//! repository looks like, which is the one thing this tab must never do.
//!
//! Three settings on every invocation, each for a failure that is otherwise
//! silent:
//!
//!   - `GIT_TERMINAL_PROMPT=0`. There is no terminal behind these processes. A
//!     push that wants a password would otherwise wait forever on a prompt
//!     nobody can see, and the button would simply never come back.
//!   - `GIT_OPTIONAL_LOCKS=0`. `status` refreshes the index as a courtesy and
//!     takes `index.lock` to do it. Polled from a sidebar, that courtesy is how
//!     the user's own `git commit` in the pane beside it fails with "another git
//!     process seems to be running".
//!   - `LC_ALL=C`, so the few messages that are parsed are in the language they
//!     were parsed in.
//!
//! Every command is `async` and does its work on the blocking pool: a pull over
//! a slow network is seconds, and a synchronous Tauri command runs on the main
//! thread — the one drawing the window.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// What a status poll is willing to report. A repository with a hundred
/// thousand untracked files has no useful list to draw, and serialising it
/// would stall the sidebar for the privilege of a scrollbar nobody drags.
const MAX_FILES: usize = 5000;
/// A diff drawn in a 220-pixel sidebar is for glancing at. Past this it is cut,
/// and says so.
const MAX_DIFF_BYTES: usize = 512 * 1024;
/// A diff *pane* is for reading, so it gets far more — but not without limit.
/// The text crosses IPC as one string and is parsed in one go, and a
/// regenerated lockfile or a vendored directory can be hundreds of megabytes.
/// Four is a few hundred thousand lines, more than anyone reads, and still
/// arrives in well under a second.
const MAX_VIEW_BYTES: usize = 4 * 1024 * 1024;
/// Untracked files are diffed one `git` process each, so a directory of build
/// output nobody ignored would otherwise be thousands of processes.
const MAX_UNTRACKED: usize = 200;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitFile {
    /// Relative to the repository root, with forward slashes, as git says it.
    pub path: String,
    /// Where a rename came from.
    pub orig: Option<String>,
    /// The index column of `git status --short`: `M`, `A`, `D`, `R`, `.`…
    pub staged: char,
    /// The worktree column. `?` for untracked, `U`-ish pairs for conflicts.
    pub unstaged: char,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitStatus {
    pub root: String,
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub truncated: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// "3 hours ago", as git words it.
    pub when: String,
}

/// What a diff pane compares. See `DiffPaneState` in `src/state/workspace.ts`.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffSource {
    /// The worktree against the index — the sidebar's "Changes" — plus
    /// untracked files, which are changes too as far as anyone reading is
    /// concerned.
    Worktree,
    /// The index against `HEAD` — the sidebar's "Staged".
    Staged,
    /// One commit against its first parent.
    Commit,
}

/// A diff for a pane: the raw text, and enough around it to say what it is.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffView {
    /// The repository's top level, which may be above the directory asked about.
    pub root: String,
    /// Unified diff text, cut at a line boundary when it was too long.
    pub text: String,
    /// True when `text` stops short of the whole diff.
    pub truncated: bool,
    /// Untracked files that exist but were not diffed, past `MAX_UNTRACKED` or
    /// past the size cap.
    pub untracked_omitted: usize,
    /// For a commit, who and when and why.
    pub commit: Option<GitCommitDetail>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitCommitDetail {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// ISO 8601, for a tooltip.
    pub date: String,
    /// "3 hours ago", as git words it.
    pub when: String,
    pub subject: String,
    pub body: String,
}

/* ── Running git ─────────────────────────────────────────────────────────── */

struct Output {
    ok: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    hide_console(&mut cmd);
    cmd
}

/// A console window flashing up for every poll, on a GUI app, on Windows.
/// Shared with `github.rs`, whose `gh` is a console program for the same
/// reason `git` is.
pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn spawn_error(err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => "git is not installed, or not on the PATH".to_string(),
        _ => format!("could not run git: {err}"),
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let out = command(cwd, args).output().map_err(spawn_error)?;
    Ok(Output {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Run git, keeping at most `limit` bytes of what it prints, and say whether
/// that was all of it.
///
/// `output()` would read everything first and cap afterwards, which for a diff
/// of a 2 GB log file is 2 GB of memory to keep 4 MB of it. This stops reading
/// at the limit and kills git, so the cap bounds the memory as well as the
/// answer. Stderr is drained on a thread of its own: a git that filled that
/// pipe while only stdout was being read would block, and so would this.
///
/// A killed git does not exit successfully, so `ok` is true for a cut-off read
/// — the cut was this function's doing, not git's.
fn git_capped(cwd: &Path, args: &[&str], limit: usize) -> Result<(Output, bool), String> {
    let mut child = command(cwd, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    let mut stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_end(&mut text);
        }
        text
    });
    let mut stdout = Vec::new();
    if let Some(pipe) = child.stdout.take() {
        // One byte past the limit is how "exactly the limit" and "more" differ.
        pipe.take(limit as u64 + 1)
            .read_to_end(&mut stdout)
            .map_err(|err| format!("could not read git's output: {err}"))?;
    }
    let truncated = stdout.len() > limit;
    if truncated {
        let _ = child.kill();
        stdout.truncate(limit);
    }
    let status = child
        .wait()
        .map_err(|err| format!("git did not finish: {err}"))?;
    let stderr = errors.join().unwrap_or_default();
    Ok((
        Output {
            ok: truncated || status.success(),
            code: status.code(),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        },
        truncated,
    ))
}

/// Run git and hand back stdout, or git's own words for why it did not work.
fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if out.ok {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else if out.stderr.is_empty() {
        Err(format!("git {} failed", args.first().unwrap_or(&"")))
    } else {
        Err(out.stderr)
    }
}

/// The repository `cwd` is in, or `None` when it is in none.
fn toplevel(cwd: &Path) -> Option<PathBuf> {
    let out = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    if !out.ok {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

/// Paths coming back from the frontend are git's own paths going back to git,
/// after a `--`. Refused rather than cleaned when they could not have come from
/// a status list: absolute, or climbing out of the repository.
fn checked_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    if paths.is_empty() {
        return Err("no files given".into());
    }
    paths
        .iter()
        .map(|path| {
            let bad = path.is_empty()
                || path.contains('\0')
                || Path::new(path).is_absolute()
                || path.split(['/', '\\']).any(|part| part == "..");
            if bad {
                Err(format!("refusing an unexpected path: {path}"))
            } else {
                Ok(path.as_str())
            }
        })
        .collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("git task failed: {err}"))?
}

/* ── Parsing ─────────────────────────────────────────────────────────────── */

/// `git status --porcelain=v2 --branch -z`, read.
///
/// Version 2 rather than the short format because it is the one git promises
/// to keep stable, and `-z` because a path with a space, a quote or a newline
/// in it is quoted in every other mode and has to be unquoted to be handed
/// back. With `-z` a path is bytes up to a NUL, and a rename's original path is
/// the *next* NUL-terminated field rather than something after a tab.
pub fn parse_status(raw: &[u8], root: String) -> GitStatus {
    let mut status = GitStatus {
        root,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        truncated: false,
    };
    let text = String::from_utf8_lossy(raw);
    let mut fields = text.split('\0');

    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            if let Some(head) = header.strip_prefix("branch.head ") {
                status.branch = (head != "(detached)").then(|| head.to_string());
            } else if let Some(up) = header.strip_prefix("branch.upstream ") {
                status.upstream = Some(up.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        status.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        status.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if status.files.len() >= MAX_FILES {
            status.truncated = true;
            // A rename still owns the field after it; skipping it keeps the
            // stream aligned should anything be read past this point.
            if record.starts_with("2 ") {
                fields.next();
            }
            continue;
        }

        let kind = record.as_bytes()[0];
        match kind {
            // `1 XY sub mH mI mW hH hI path`
            b'1' => {
                if let Some((xy, path)) = split_entry(record, 8) {
                    status.files.push(entry(xy, path, None, false));
                }
            }
            // `2 XY sub mH mI mW hH hI Xscore path` then `origPath` as its own field.
            b'2' => {
                let orig = fields.next().map(str::to_string);
                if let Some((xy, path)) = split_entry(record, 9) {
                    status.files.push(entry(xy, path, orig, false));
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
            b'u' => {
                if let Some((xy, path)) = split_entry(record, 10) {
                    status.files.push(entry(xy, path, None, true));
                }
            }
            b'?' => {
                if let Some(path) = record.get(2..) {
                    status.files.push(GitFile {
                        path: path.to_string(),
                        orig: None,
                        staged: '.',
                        unstaged: '?',
                        untracked: true,
                        conflicted: false,
                    });
                }
            }
            // `!` is ignored files, which were not asked for.
            _ => {}
        }
    }
    status
}

/// The `XY` column and the path of a porcelain v2 entry with `before` fields
/// ahead of the path. `splitn` rather than `split`, because the path is the
/// remainder and may itself contain spaces.
fn split_entry(record: &str, before: usize) -> Option<(&str, &str)> {
    let mut parts = record.splitn(before + 1, ' ');
    let _kind = parts.next()?;
    let xy = parts.next()?;
    let path = parts.nth(before - 2)?;
    (xy.len() == 2 && !path.is_empty()).then_some((xy, path))
}

fn entry(xy: &str, path: &str, orig: Option<String>, conflicted: bool) -> GitFile {
    let mut chars = xy.chars();
    GitFile {
        path: path.to_string(),
        orig,
        staged: chars.next().unwrap_or('.'),
        unstaged: chars.next().unwrap_or('.'),
        untracked: false,
        conflicted,
    }
}

/// `git log` with unit and record separators, which no subject line contains.
pub fn parse_log(raw: &str) -> Vec<GitCommit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let mut parts = record.trim_start_matches('\n').split('\x1f');
            let hash = parts.next()?.to_string();
            if hash.is_empty() {
                return None;
            }
            Some(GitCommit {
                hash,
                short: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                when: parts.next()?.trim_end().to_string(),
            })
        })
        .collect()
}

fn cap(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… diff truncated\n");
    }
    text
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/// The repository `cwd` is in and what has changed in it, or `None` for a
/// directory that is not in one — which is an ordinary answer for a sidebar
/// following a shell around, not an error.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    blocking(move || {
        let Some(root) = toplevel(Path::new(&cwd)) else {
            return Ok(None);
        };
        let out = git_ok_bytes(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )?;
        Ok(Some(parse_status(
            &out,
            root.to_string_lossy().into_owned(),
        )))
    })
    .await
}

fn git_ok_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(cwd, args)?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(out.stderr)
    }
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = checked_paths(&paths)?;
        let mut args = vec!["add", "--all", "--"];
        args.extend(paths);
        git_ok(Path::new(&root), &args).map(|_| ())
    })
    .await
}

/// Take files back out of the index, keeping what is in the worktree.
///
/// `reset` rather than `restore --staged`: on a repository with no commits yet
/// there is no HEAD to restore from, and `restore` refuses where `reset` simply
/// empties the index entry — which is exactly what unstaging means there.
#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = checked_paths(&paths)?;
        let mut args = vec!["reset", "-q", "--"];
        args.extend(paths);
        git_ok(Path::new(&root), &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    blocking(move || {
        if message.trim().is_empty() {
            return Err("a commit needs a message".into());
        }
        git_ok(Path::new(&root), &["commit", "-m", &message])
    })
    .await
}

/// One file's diff, as text.
///
/// Untracked files have nothing to diff against, so they are compared with the
/// empty file — which `--no-index` reports by exiting 1, meaning "differs",
/// rather than 0.
#[tauri::command]
pub async fn git_diff(
    root: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    blocking(move || {
        let path = checked_paths(std::slice::from_ref(&path))?[0].to_string();
        let root = Path::new(&root);
        let text = if untracked {
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            let out = git(
                root,
                &["diff", "--no-color", "--no-index", "--", null, &path],
            )?;
            if !out.ok && out.code != Some(1) {
                return Err(out.stderr);
            }
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else if staged {
            git_ok(root, &["diff", "--no-color", "--cached", "--", &path])?
        } else {
            git_ok(root, &["diff", "--no-color", "--", &path])?
        };
        Ok(cap(text, MAX_DIFF_BYTES))
    })
    .await
}

/// Options every diff a pane reads is produced with, whatever the user's config.
///
/// Each one is there because a setting someone is entitled to have would
/// otherwise change the text into something the parser cannot read:
/// `diff.external` hands the diff to another program, `diff.noprefix` and
/// `diff.mnemonicPrefix` change the `a/`/`b/` that names are read by, `color.ui
/// = always` puts escape codes in it, and `diff.renames = false` turns a rename
/// into a deletion and an addition.
const DIFF_FLAGS: [&str; 5] = [
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-M",
];

/// A revision from the frontend, about to be an argument to git.
///
/// Refused rather than cleaned when it begins with `-`, which git would read as
/// an option — `--output=…` writes a file. Everything else is git's to judge,
/// and `rev-parse` says so in its own words when it does not like it.
fn checked_rev(rev: &str) -> Result<&str, String> {
    let bad = rev.is_empty()
        || rev.len() > 256
        || rev.starts_with('-')
        || rev.chars().any(|c| c == '\0' || c.is_whitespace());
    if bad {
        Err(format!("refusing an unexpected revision: {rev}"))
    } else {
        Ok(rev)
    }
}

/// The repository `cwd` is in, `None` when it is in none, and an error when the
/// question could not be asked — no git, or no such directory. The sidebar can
/// treat those alike; a pane that says "not a repository" when the truth is
/// "git is not installed" sends someone looking in the wrong place.
fn repository(cwd: &Path) -> Result<Option<PathBuf>, String> {
    if !cwd.is_dir() {
        return Err(format!("{} is not a directory", cwd.display()));
    }
    let out = git(cwd, &["rev-parse", "--show-toplevel"])?;
    if !out.ok {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!text.is_empty()).then(|| PathBuf::from(text)))
}

/// Where a capped read is cut: the last whole line inside `limit`, so the
/// parser is never handed half of one.
fn cut_at_line(mut bytes: Vec<u8>, truncated: bool) -> String {
    if truncated {
        if let Some(end) = bytes.iter().rposition(|&b| b == b'\n') {
            bytes.truncate(end + 1);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Run one diff into what is left of `budget`, appending to `text`. Returns
/// whether it was cut. `allow_one` is for `--no-index`, which exits 1 to mean
/// "the files differ" — the answer it was asked for, not a failure.
fn diff_into(
    root: &Path,
    args: &[&str],
    budget: &mut usize,
    text: &mut String,
    allow_one: bool,
) -> Result<bool, String> {
    let (out, truncated) = git_capped(root, args, *budget)?;
    if !out.ok && !(allow_one && out.code == Some(1)) {
        return Err(if out.stderr.is_empty() {
            "git diff failed".into()
        } else {
            out.stderr
        });
    }
    let chunk = cut_at_line(out.stdout, truncated);
    *budget = budget.saturating_sub(chunk.len());
    text.push_str(&chunk);
    Ok(truncated)
}

/// The body of `git_diff_view`, synchronous and with the cap as a parameter so
/// the tests can make it small.
fn diff_view(
    cwd: &Path,
    source: DiffSource,
    rev: Option<&str>,
    path: Option<&str>,
    limit: usize,
) -> Result<Option<GitDiffView>, String> {
    let Some(root) = repository(cwd)? else {
        return Ok(None);
    };
    let path = match path {
        Some(path) => Some(checked_paths(&[path.to_string()])?[0].to_string()),
        None => None,
    };
    let mut budget = limit;
    let mut text = String::new();
    let mut untracked_omitted = 0;
    let mut commit = None;

    let mut args: Vec<&str> = Vec::new();
    let mut truncated = match source {
        DiffSource::Worktree | DiffSource::Staged => {
            args.push("diff");
            args.extend(DIFF_FLAGS);
            if source == DiffSource::Staged {
                args.push("--cached");
            }
            args.push("--");
            if let Some(path) = &path {
                args.push(path);
            }
            diff_into(&root, &args, &mut budget, &mut text, false)?
        }
        DiffSource::Commit => {
            let rev = checked_rev(rev.unwrap_or("HEAD"))?;
            // Peeled, so a tag names the commit it points at, and so a
            // revision that happens to share a name with a file is read as the
            // revision.
            let peeled = format!("{rev}^{{commit}}");
            let meta = git_ok(
                &root,
                &[
                    "show",
                    "-s",
                    "--no-color",
                    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%s%x1f%b",
                    &peeled,
                    "--",
                ],
            )?;
            commit = parse_commit_detail(&meta);
            // `-m --first-parent` shows a merge as what it brought in, against
            // the branch it was merged into. Without it a merge shows a
            // combined diff of only its conflict resolutions, which is rarely
            // what was meant and which the parser does not read.
            args.extend(["show", "--format="]);
            args.extend(DIFF_FLAGS);
            args.extend(["-m", "--first-parent", &peeled, "--"]);
            if let Some(path) = &path {
                args.push(path);
            }
            diff_into(&root, &args, &mut budget, &mut text, false)?
        }
    };

    if source == DiffSource::Worktree {
        let mut list = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
        if let Some(path) = &path {
            list.push(path);
        }
        let raw = git_ok_bytes(&root, &list)?;
        let untracked: Vec<String> = String::from_utf8_lossy(&raw)
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect();
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        for (index, name) in untracked.iter().enumerate() {
            if truncated || index >= MAX_UNTRACKED {
                untracked_omitted = untracked.len() - index;
                break;
            }
            let mut args = vec!["diff"];
            args.extend(DIFF_FLAGS);
            args.extend(["--no-index", "--", null, name]);
            truncated = diff_into(&root, &args, &mut budget, &mut text, true)?;
        }
    }

    Ok(Some(GitDiffView {
        root: root.to_string_lossy().into_owned(),
        text,
        truncated,
        untracked_omitted,
        commit,
    }))
}

fn parse_commit_detail(raw: &str) -> Option<GitCommitDetail> {
    let mut parts = raw.splitn(8, '\x1f');
    let hash = parts.next()?.trim().to_string();
    if hash.is_empty() {
        return None;
    }
    Some(GitCommitDetail {
        hash,
        short: parts.next()?.to_string(),
        author: parts.next()?.to_string(),
        email: parts.next()?.to_string(),
        date: parts.next()?.to_string(),
        when: parts.next()?.to_string(),
        subject: parts.next()?.to_string(),
        body: parts.next().unwrap_or("").trim_end().to_string(),
    })
}

/// A diff to read in a pane: the working tree, the index, or a commit,
/// optionally narrowed to one path, cut at `MAX_VIEW_BYTES`.
///
/// `cwd` may be anywhere inside the repository; the top level is found and
/// handed back. `None` means it is in no repository, which a pane says plainly,
/// as opposed to git being missing, which is an error and says that instead.
#[tauri::command]
pub async fn git_diff_view(
    cwd: String,
    source: DiffSource,
    rev: Option<String>,
    path: Option<String>,
) -> Result<Option<GitDiffView>, String> {
    blocking(move || {
        diff_view(
            Path::new(&cwd),
            source,
            rev.as_deref(),
            path.as_deref(),
            MAX_VIEW_BYTES,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_log(root: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    blocking(move || {
        let count = format!("-n{}", limit.unwrap_or(30).clamp(1, 200));
        let out = git(
            Path::new(&root),
            &["log", &count, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e"],
        )?;
        // A branch with no commits yet is an empty history, not a failure.
        if !out.ok {
            return Ok(Vec::new());
        }
        Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
}

/// `push`, `pull --ff-only`, `fetch` or `init` — the actions that take no files.
///
/// `--ff-only` because a pull that decides to merge opens an editor for the
/// merge message, and there is no terminal here for it to open in.
#[tauri::command]
pub async fn git_action(cwd: String, action: String) -> Result<String, String> {
    blocking(move || {
        let args: &[&str] = match action.as_str() {
            "push" => &["push"],
            "pull" => &["pull", "--ff-only"],
            "fetch" => &["fetch", "--prune"],
            "init" => &["init"],
            _ => return Err(format!("unknown git action: {action}")),
        };
        let out = git(Path::new(&cwd), args)?;
        // Push and pull report progress on stderr even when they succeed.
        let said = [
            String::from_utf8_lossy(&out.stdout).trim(),
            out.stderr.as_str(),
        ]
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
        if out.ok {
            Ok(said)
        } else {
            Err(if said.is_empty() {
                format!("git {action} failed")
            } else {
                said
            })
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_headers_and_every_kind_of_entry() {
        let raw = "# branch.oid 1234\0# branch.head main\0# branch.upstream origin/main\0\
                   # branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 aaa bbb src/has space.rs\0\
                   1 A. N... 000000 100644 100644 000 ccc new.txt\0\
                   2 R. N... 100644 100644 100644 ddd eee R100 renamed.rs\0old name.rs\0\
                   u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.rs\0\
                   ? untracked dir/file\0";
        let status = parse_status(raw.as_bytes(), "/repo".into());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "src/has space.rs",
                "new.txt",
                "renamed.rs",
                "conflict.rs",
                "untracked dir/file"
            ]
        );
        assert_eq!(status.files[0].unstaged, 'M');
        assert_eq!(status.files[1].staged, 'A');
        assert_eq!(status.files[2].orig.as_deref(), Some("old name.rs"));
        assert!(status.files[3].conflicted);
        assert!(status.files[4].untracked);
    }

    #[test]
    fn calls_a_detached_head_no_branch() {
        let status = parse_status(b"# branch.head (detached)\0", "/r".into());
        assert_eq!(status.branch, None);
        assert!(status.files.is_empty());
    }

    #[test]
    fn reads_log_records_with_awkward_subjects() {
        let raw = "abc\x1fa\x1ffix: a | b, \"c\"\x1fJo\x1f2 days ago\x1e\n\
                   def\x1fd\x1fsecond\x1fAl\x1f3 weeks ago\x1e\n";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "fix: a | b, \"c\"");
        assert_eq!(log[1].when, "3 weeks ago");
    }

    #[test]
    fn refuses_paths_that_could_not_have_come_from_status() {
        assert!(checked_paths(&["src/main.rs".into()]).is_ok());
        assert!(checked_paths(&[]).is_err());
        assert!(checked_paths(&["../outside".into()]).is_err());
        assert!(checked_paths(&["/etc/passwd".into()]).is_err());
        assert!(checked_paths(&["a/../../b".into()]).is_err());
    }

    #[test]
    fn works_against_a_real_repository() {
        let dir = std::env::temp_dir().join(format!("jterm-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if git_ok(&dir, &["init", "-q"]).is_err() {
            // No git on this machine; nothing here can be exercised.
            return;
        }
        std::fs::write(dir.join("a file.txt"), "hello\n").unwrap();
        let root = toplevel(&dir).expect("a repository");
        let raw = git_ok_bytes(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )
        .unwrap();
        let status = parse_status(&raw, root.to_string_lossy().into_owned());
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].untracked);
        assert_eq!(status.files[0].path, "a file.txt");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_revisions_that_git_would_read_as_options() {
        assert!(checked_rev("HEAD~2").is_ok());
        assert!(checked_rev("v1.0^{commit}").is_ok());
        assert!(checked_rev("--output=/tmp/x").is_err());
        assert!(checked_rev("").is_err());
        assert!(checked_rev("a b").is_err());
    }

    #[test]
    fn cuts_a_capped_read_at_the_last_whole_line() {
        assert_eq!(cut_at_line(b"one\ntwo\nthr".to_vec(), true), "one\ntwo\n");
        assert_eq!(cut_at_line(b"one\ntwo".to_vec(), false), "one\ntwo");
    }

    #[test]
    fn diffs_the_worktree_the_index_and_a_commit() {
        let dir = std::env::temp_dir().join(format!("jterm-git-view-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        if git_ok(&dir, &["init", "-q"]).is_err() {
            return;
        }
        let commit = |message: &str| {
            git_ok(
                &dir,
                &[
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    message,
                ],
            )
            .unwrap();
        };
        std::fs::write(dir.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_ok(&dir, &["add", "."]).unwrap();
        commit("first");

        std::fs::write(dir.join("tracked.txt"), "one\nTWO\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "staged\n").unwrap();
        git_ok(&dir, &["add", "staged.txt"]).unwrap();
        std::fs::write(dir.join("sub/new.txt"), "brand new\n").unwrap();

        // Asked from a subdirectory: the root is still the top level.
        let worktree = diff_view(&dir.join("sub"), DiffSource::Worktree, None, None, 1 << 20)
            .unwrap()
            .unwrap();
        assert!(Path::new(&worktree.root).ends_with(dir.file_name().unwrap()));
        assert!(worktree.text.contains("+TWO"));
        assert!(
            worktree.text.contains("+brand new"),
            "untracked files are included"
        );
        assert!(!worktree.text.contains("+staged"));
        assert!(!worktree.truncated);

        let staged = diff_view(&dir, DiffSource::Staged, None, None, 1 << 20)
            .unwrap()
            .unwrap();
        assert!(staged.text.contains("+staged"));
        assert!(!staged.text.contains("+TWO"));

        let one = diff_view(
            &dir,
            DiffSource::Worktree,
            None,
            Some("tracked.txt"),
            1 << 20,
        )
        .unwrap()
        .unwrap();
        assert!(one.text.contains("+TWO") && !one.text.contains("brand new"));

        commit("second");
        let shown = diff_view(&dir, DiffSource::Commit, Some("HEAD"), None, 1 << 20)
            .unwrap()
            .unwrap();
        let detail = shown.commit.expect("commit detail");
        assert_eq!(detail.subject, "second");
        assert_eq!(detail.author, "t");
        // Only what was staged went into it; the unstaged edit is not part of it.
        assert!(shown.text.contains("+staged") && !shown.text.contains("+TWO"));
        assert!(shown.text.trim_start().starts_with("diff --git"));

        // A cap smaller than the diff cuts it at a line and says so.
        let cut = diff_view(&dir, DiffSource::Commit, Some("HEAD"), None, 40)
            .unwrap()
            .unwrap();
        assert!(cut.truncated);
        assert!(cut.text.len() <= 40);
        assert!(cut.text.is_empty() || cut.text.ends_with('\n'));

        assert!(diff_view(&dir, DiffSource::Commit, Some("--help"), None, 1 << 20).is_err());
        assert!(diff_view(&dir, DiffSource::Worktree, None, Some("../x"), 1 << 20).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn calls_a_directory_outside_any_repository_none() {
        let dir = std::env::temp_dir().join(format!("jterm-git-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The temp directory might itself be inside a repository on some
        // machine; only assert when it is not.
        if toplevel(&dir).is_none() {
            assert_eq!(
                diff_view(&dir, DiffSource::Worktree, None, None, 1024).unwrap(),
                None
            );
        }
        assert!(diff_view(&dir.join("missing"), DiffSource::Worktree, None, None, 1024).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
