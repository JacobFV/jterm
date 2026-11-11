//! Pull requests and issues: the sidebar's GitHub tool and the `pr` and
//! `issue` panes.
//!
//! Everything goes through the user's own `gh`, for the reason `git.rs` goes
//! through their `git`. It already holds their login, knows their enterprise
//! hosts, honours `GH_HOST` and `gh repo set-default`, and works out which
//! repository a directory belongs to from its remotes exactly the way the `gh`
//! in the terminal beside the pane does. jterm keeps no token, speaks no HTTP
//! to GitHub, and so has nothing of its own to leak or get wrong.
//!
//! Only `--json` output is ever parsed. gh's human output is for humans and
//! changes between releases; the JSON fields are a documented interface. The
//! decoding below is lenient on purpose — every field is optional, unknown
//! fields are ignored — because a gh a few versions older or newer than the one
//! the fixtures were captured from should cost a blank where a field was, not
//! the whole pane.
//!
//! Settings on every invocation, each closing a way for a GUI app to hang on a
//! question nobody can see or to be handed text it cannot read:
//!
//!   - `GH_PROMPT_DISABLED=1`, and stdin closed unless a comment body is being
//!     fed to it. gh asks things — which remote, which merge method, are you
//!     sure — and with no terminal behind it the asking is a wait forever.
//!   - `GIT_TERMINAL_PROMPT=0`, for the git that `gh pr checkout` runs.
//!   - `GH_NO_UPDATE_NOTIFIER`, `GH_NO_EXTENSION_UPDATE_NOTIFIER`: a "new
//!     release" notice is noise on stderr, which is read for error messages.
//!   - `NO_COLOR=1`, `GH_PAGER=` and no `GH_FORCE_TTY`, so a user who forces
//!     colour or a pager in their shell profile does not get escape codes in
//!     a diff or a `less` waiting on a pipe.
//!   - `LC_ALL=C`, so the git messages gh passes through are in the language
//!     `classify` reads them in.
//!
//! Arguments are only ever numbers and fixed words chosen here. The one free
//! text — a comment's body — goes in on stdin through `--body-file -`, never
//! on the command line, so nothing in it can be read as a flag and nothing is
//! ever handed to a shell.
//!
//! Every command is `async` and runs on the blocking pool, and every read has a
//! deadline: gh's own HTTP client will wait a long time on a network that has
//! gone quiet, and a pane saying "reading…" forever is worse than one saying
//! the network did not answer.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

/// What one JSON answer may be. A pull request with a few hundred long review
/// comments is a megabyte or two; past this something is wrong, and parsing a
/// cut-off document would fail anyway.
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;
/// A pull request's diff in a pane: the same cap, for the same reasons, as a
/// diff pane's (`MAX_VIEW_BYTES` in `git.rs`).
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
/// Only the first part of stderr is ever shown, and a gh that wrote megabytes
/// of it must not be buffered whole.
const MAX_STDERR_BYTES: usize = 64 * 1024;
/// GitHub refuses a comment longer than this, so it is refused here first, in
/// words, rather than in an API error.
const MAX_COMMENT_CHARS: usize = 65_536;
/// How many open pull requests and issues the sidebar lists. Enough for any
/// list someone scrolls; a repository with thousands has a website for that.
const LIST_LIMIT: &str = "50";
/// A read that has not answered in this long is not going to.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// A checkout fetches a branch and a merge may wait on GitHub; both get longer.
const ACTION_TIMEOUT: Duration = Duration::from_secs(180);

/* ── Errors ──────────────────────────────────────────────────────────────── */

/// Why gh could not answer, sorted into the cases that each need the user to
/// do something different. A pane draws its empty state from `kind` and shows
/// `message` — gh's own words, usually — underneath.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GhErrorKind {
    /// No `gh` on the PATH: install it.
    Missing,
    /// gh has no login for this host, or the one it has was refused: `gh auth
    /// login`.
    Auth,
    /// The directory is not in a git repository at all.
    NotRepo,
    /// A repository, but none of its remotes is on a GitHub host gh knows.
    NotGithub,
    /// No such pull request or issue in this repository.
    NotFound,
    /// The network, or GitHub, did not answer.
    Offline,
    /// The request itself was refused before gh was run: a bad number, an
    /// empty comment, a directory that does not exist.
    Invalid,
    /// Anything else, in gh's words.
    Failed,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GhError {
    pub kind: GhErrorKind,
    pub message: String,
}

impl GhError {
    fn new(kind: GhErrorKind, message: impl Into<String>) -> Self {
        GhError {
            kind,
            message: message.into(),
        }
    }
}

/// gh's stderr, sorted into a kind.
///
/// gh has no machine-readable errors, so this is the one place its words are
/// read rather than its JSON. The phrases are its own and have been stable for
/// years; anything unrecognised is `Failed` with the text intact, which is the
/// safe way for this to go out of date. Order matters: "none of the git remotes
/// … please use `gh auth login`" mentions logging in but is about remotes.
pub fn classify(stderr: &str, code: Option<i32>) -> GhError {
    let text = stderr.trim();
    let lower = text.to_lowercase();
    let message = if text.is_empty() {
        "gh failed without saying why".to_string()
    } else {
        text.to_string()
    };
    let has = |needle: &str| lower.contains(needle);

    let kind = if has("not a git repository") || has("unable to find git executable") {
        GhErrorKind::NotRepo
    } else if has("no git remotes found")
        || has("none of the git remotes configured for this repository")
        || has("could not determine base repo")
    {
        GhErrorKind::NotGithub
    } else if has("could not resolve to") || (has("not found") && has("http 404")) {
        GhErrorKind::NotFound
    } else if has("error connecting to")
        || has("dial tcp")
        || has("no such host")
        || has("i/o timeout")
        || has("tls handshake timeout")
        || has("connection refused")
        || has("connection reset")
        || has("network is unreachable")
    {
        GhErrorKind::Offline
    } else if code == Some(4)
        || has("gh auth login")
        || has("http 401")
        || has("bad credentials")
        || has("authentication required")
    {
        // gh exits 4 for "you need to log in", and says so in a sentence that
        // ends in `gh auth login` — which is what the empty state will say.
        GhErrorKind::Auth
    } else {
        GhErrorKind::Failed
    };
    GhError { kind, message }
}

fn spawn_error(err: std::io::Error) -> GhError {
    match err.kind() {
        std::io::ErrorKind::NotFound => GhError::new(
            GhErrorKind::Missing,
            "gh, the GitHub CLI, is not installed or not on the PATH",
        ),
        _ => GhError::new(GhErrorKind::Failed, format!("could not run gh: {err}")),
    }
}

/* ── Checking what comes in ──────────────────────────────────────────────── */

/// A pull request or issue number, about to be an argument to gh. A number is
/// all it can be, and never zero.
fn checked_number(number: u64) -> Result<String, GhError> {
    if number == 0 || number > 1_000_000_000 {
        return Err(GhError::new(
            GhErrorKind::Invalid,
            format!("{number} is not a pull request or issue number"),
        ));
    }
    Ok(number.to_string())
}

fn checked_dir(cwd: &str) -> Result<&Path, GhError> {
    let path = Path::new(cwd);
    if cwd.is_empty() || !path.is_dir() {
        return Err(GhError::new(
            GhErrorKind::Invalid,
            format!("{cwd} is not a directory"),
        ));
    }
    Ok(path)
}

/// A comment's body: something to say, and no more than GitHub will take.
fn checked_body(body: &str) -> Result<&str, GhError> {
    if body.trim().is_empty() {
        return Err(GhError::new(
            GhErrorKind::Invalid,
            "a comment needs some text",
        ));
    }
    let chars = body.chars().count();
    if chars > MAX_COMMENT_CHARS {
        return Err(GhError::new(
            GhErrorKind::Invalid,
            format!("a comment can be at most {MAX_COMMENT_CHARS} characters; this is {chars}"),
        ));
    }
    Ok(body)
}

/* ── Running gh ──────────────────────────────────────────────────────────── */

struct Run {
    stdout: Vec<u8>,
    truncated: bool,
}

/// Run gh in `cwd` and hand back what it printed, or why it failed.
///
/// `input` is written to its stdin and the pipe closed; without it stdin is
/// closed from the start, so anything that tries to read a reply gets end of
/// file at once rather than a wait. Stdout is read up to `limit` and then
/// let go and gh killed, so a cap bounds memory as well as the answer — the
/// same arrangement as `git_capped`. Stderr has a thread of its own so that a
/// gh which filled that pipe while stdout was being read does not stall both.
fn gh(
    cwd: &Path,
    args: &[&str],
    input: Option<&str>,
    limit: usize,
    timeout: Duration,
) -> Result<Run, GhError> {
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env_remove("GH_FORCE_TTY")
        .env_remove("CLICOLOR_FORCE")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::git::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(spawn_error)?;

    // Written from a thread and dropped there, which is what closes the pipe:
    // a body bigger than the pipe's buffer would otherwise block this thread
    // on a gh that is itself blocked writing to a stdout nobody is reading yet.
    let writer = match (input, child.stdin.take()) {
        (Some(text), Some(mut pipe)) => {
            let text = text.to_string();
            Some(std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            }))
        }
        _ => None,
    };

    let mut stderr = child.stderr.take();
    let errors = std::thread::spawn(move || {
        let mut text = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.take(MAX_STDERR_BYTES as u64).read_to_end(&mut text);
            // Whatever is past the cap is drained rather than left in the pipe,
            // where it would block gh before it could exit.
            let _ = std::io::copy(pipe, &mut std::io::sink());
        }
        text
    });

    let cut = Arc::new(AtomicBool::new(false));
    let mut stdout = child.stdout.take();
    let reader = {
        let cut = Arc::clone(&cut);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = stdout.take() {
                // One byte past the limit is how "exactly the limit" and
                // "more" differ.
                let _ = pipe.take(limit as u64 + 1).read_to_end(&mut bytes);
            }
            if bytes.len() > limit {
                bytes.truncate(limit);
                cut.store(true, Ordering::SeqCst);
            }
            bytes
        })
    };

    // Polled rather than waited on, so there is a deadline that works the same
    // on every platform without a signal or a second process to enforce it.
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(err) => {
                return Err(GhError::new(
                    GhErrorKind::Failed,
                    format!("gh did not finish: {err}"),
                ))
            }
        }
        if cut.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GhError::new(
                GhErrorKind::Offline,
                format!(
                    "gh did not answer within {} seconds — is the network up?",
                    timeout.as_secs()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stdout = reader.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&errors.join().unwrap_or_default()).into_owned();
    let truncated = cut.load(Ordering::SeqCst);

    // A gh killed for printing too much did not fail; the cut was ours.
    match status {
        Some(status) if !status.success() && !truncated => Err(classify(&stderr, status.code())),
        _ => Ok(Run { stdout, truncated }),
    }
}

/// Run gh and decode its `--json` answer.
fn gh_json<T: for<'de> Deserialize<'de>>(cwd: &Path, args: &[&str]) -> Result<T, GhError> {
    let run = gh(cwd, args, None, MAX_JSON_BYTES, READ_TIMEOUT)?;
    if run.truncated {
        return Err(GhError::new(
            GhErrorKind::Failed,
            "GitHub's answer was too large to read",
        ));
    }
    decode(&run.stdout)
}

fn decode<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, GhError> {
    serde_json::from_slice(bytes).map_err(|err| {
        GhError::new(
            GhErrorKind::Failed,
            format!("could not read gh's answer: {err}"),
        )
    })
}

/// Run gh for its effect, and hand back whatever it said about it.
fn gh_action(cwd: &Path, args: &[&str], input: Option<&str>) -> Result<String, GhError> {
    let run = gh(cwd, args, input, MAX_JSON_BYTES, ACTION_TIMEOUT)?;
    Ok(String::from_utf8_lossy(&run.stdout).trim().to_string())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, GhError> + Send + 'static,
) -> Result<T, GhError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| GhError::new(GhErrorKind::Failed, format!("gh task failed: {err}")))?
}

/* ── What gh says, as it says it ─────────────────────────────────────────── */
//
// Every field optional: see the module comment. Unknown fields are ignored by
// serde's default, which is the other half of the same tolerance.

#[derive(Deserialize, Default)]
struct RawActor {
    login: Option<String>,
    name: Option<String>,
    is_bot: Option<bool>,
    /// A team, in `reviewRequests`, has a slug where a user has a login.
    slug: Option<String>,
}

#[derive(Deserialize)]
struct RawLabel {
    name: Option<String>,
    color: Option<String>,
    description: Option<String>,
}

/// One entry of `statusCheckRollup`: a `CheckRun` (Actions and other GitHub
/// apps) or a `StatusContext` (the older commit-status API), told apart by
/// which fields they have.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheck {
    #[serde(rename = "__typename")]
    typename: Option<String>,
    name: Option<String>,
    context: Option<String>,
    workflow_name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
    details_url: Option<String>,
    target_url: Option<String>,
    description: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    id: Option<String>,
    author: Option<RawActor>,
    author_association: Option<String>,
    body: Option<String>,
    created_at: Option<String>,
    url: Option<String>,
    is_minimized: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    id: Option<String>,
    author: Option<RawActor>,
    author_association: Option<String>,
    body: Option<String>,
    state: Option<String>,
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
struct RawRef {
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    name_with_owner: Option<String>,
    url: Option<String>,
    merge_commit_allowed: Option<bool>,
    squash_merge_allowed: Option<bool>,
    rebase_merge_allowed: Option<bool>,
    viewer_permission: Option<String>,
    default_branch_ref: Option<RawRef>,
    has_issues_enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPull {
    number: Option<u64>,
    title: Option<String>,
    state: Option<String>,
    is_draft: Option<bool>,
    author: Option<RawActor>,
    base_ref_name: Option<String>,
    head_ref_name: Option<String>,
    head_repository_owner: Option<RawActor>,
    is_cross_repository: Option<bool>,
    body: Option<String>,
    labels: Option<Vec<RawLabel>>,
    assignees: Option<Vec<RawActor>>,
    review_requests: Option<Vec<RawActor>>,
    review_decision: Option<String>,
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
    /// Only counted. Each one carries its authors and messages, none of which
    /// the pane shows.
    commits: Option<Vec<IgnoredAny>>,
    comments: Option<Vec<RawComment>>,
    reviews: Option<Vec<RawReview>>,
    status_check_rollup: Option<Vec<RawCheck>>,
    url: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    merged_at: Option<String>,
    closed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssue {
    number: Option<u64>,
    title: Option<String>,
    state: Option<String>,
    state_reason: Option<String>,
    author: Option<RawActor>,
    labels: Option<Vec<RawLabel>>,
    assignees: Option<Vec<RawActor>>,
    body: Option<String>,
    comments: Option<Vec<RawComment>>,
    url: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    closed_at: Option<String>,
}

/* ── What the frontend is handed ─────────────────────────────────────────── */
//
// Mirrored in `src/lib/ipc.ts`. Enumerations from GitHub are lower-cased —
// `changes_requested`, `conflicting` — and an empty one is `None`.

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub login: String,
    pub name: Option<String>,
    pub bot: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    /// Six hex digits, as GitHub stores it, without the `#`.
    pub color: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name_with_owner: String,
    pub url: String,
    /// Whichever of `merge`, `squash` and `rebase` the repository allows, in
    /// that order.
    pub merge_methods: Vec<&'static str>,
    /// `admin`, `maintain`, `write`, `triage`, `read`, or `None` when gh did
    /// not say.
    pub permission: Option<String>,
    pub default_branch: Option<String>,
    pub issues_enabled: bool,
}

/// One check on a pull request's head commit, whichever API it came from.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// The Actions workflow it belongs to, for a check run that has one.
    pub workflow: Option<String>,
    /// `pass`, `fail`, `pending`, `skipped`, `cancelled` or `neutral` — the
    /// six things a person needs to tell apart. See `check_bucket`.
    pub bucket: &'static str,
    /// GitHub's own word for it, lower-cased: `in_progress`, `timed_out`…
    pub detail: Option<String>,
    pub url: Option<String>,
    pub description: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckSummary {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub pending: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: Person,
    pub association: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
    pub url: Option<String>,
    /// Hidden on GitHub as spam, off-topic or outdated.
    pub minimized: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub author: Person,
    pub association: Option<String>,
    pub body: String,
    /// `approved`, `changes_requested`, `commented`, `dismissed`, `pending`.
    pub state: Option<String>,
    pub submitted_at: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub number: u64,
    pub title: String,
    pub author: Person,
    pub draft: bool,
    pub head_ref: String,
    pub base_ref: String,
    pub labels: Vec<Label>,
    pub checks: CheckSummary,
    pub review_decision: Option<String>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    pub author: Person,
    pub labels: Vec<Label>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u64,
    pub title: String,
    /// `open`, `closed` or `merged`. A draft is open, with `draft` set.
    pub state: &'static str,
    pub draft: bool,
    pub author: Person,
    pub base_ref: String,
    pub head_ref: String,
    /// The fork's owner, for a pull request from one: `them:branch`.
    pub head_owner: Option<String>,
    pub cross_repository: bool,
    pub body: String,
    pub labels: Vec<Label>,
    pub assignees: Vec<Person>,
    /// Logins of people, and `org/slug` of teams, asked to review.
    pub review_requests: Vec<String>,
    pub review_decision: Option<String>,
    /// `mergeable`, `conflicting` or `unknown` — GitHub works it out lazily,
    /// so a pull request nobody has looked at lately is often `unknown`.
    pub mergeable: Option<String>,
    /// `clean`, `blocked`, `behind`, `dirty`, `unstable`, `draft`…
    pub merge_state: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub commits: usize,
    pub comments: Vec<Comment>,
    pub reviews: Vec<Review>,
    pub checks: Vec<Check>,
    pub url: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    /// `open` or `closed`.
    pub state: &'static str,
    /// Why it was closed: `completed`, `not_planned`, `duplicate`…
    pub state_reason: Option<String>,
    pub author: Person,
    pub labels: Vec<Label>,
    pub assignees: Vec<Person>,
    pub body: String,
    pub comments: Vec<Comment>,
    pub url: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub closed_at: Option<String>,
}

/// What the sidebar shows for a directory.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Lists {
    pub repo: Repo,
    pub pulls: Vec<PullSummary>,
    /// Empty, not missing, for a repository with issues turned off — the
    /// sidebar says which from `repo.issues_enabled`.
    pub issues: Vec<IssueSummary>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PullView {
    pub repo: Repo,
    pub pull: Pull,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct IssueView {
    pub repo: Repo,
    pub issue: Issue,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PullDiff {
    /// Unified diff text; `parseDiff` reads it. Cut at a line when too long.
    pub text: String,
    pub truncated: bool,
}

/* ── From one to the other ───────────────────────────────────────────────── */

/// An enumeration from GitHub, lower-cased, or `None` when empty.
fn word(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

fn text(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn person(raw: Option<RawActor>) -> Person {
    let raw = raw.unwrap_or_default();
    Person {
        // GitHub's own name for an account that has been deleted.
        login: text(raw.login).unwrap_or_else(|| "ghost".to_string()),
        name: text(raw.name),
        bot: raw.is_bot.unwrap_or(false),
    }
}

fn people(raw: Option<Vec<RawActor>>) -> Vec<Person> {
    raw.unwrap_or_default()
        .into_iter()
        .map(|actor| person(Some(actor)))
        .collect()
}

fn labels(raw: Option<Vec<RawLabel>>) -> Vec<Label> {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|label| {
            Some(Label {
                name: text(label.name)?,
                // Only a colour that is one, since it ends up in a style.
                color: label
                    .color
                    .filter(|c| c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit())),
                description: text(label.description),
            })
        })
        .collect()
}

fn comments(raw: Option<Vec<RawComment>>) -> Vec<Comment> {
    raw.unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, comment)| Comment {
            id: text(comment.id).unwrap_or_else(|| format!("comment-{index}")),
            author: person(comment.author),
            association: word(comment.author_association),
            body: comment.body.unwrap_or_default(),
            created_at: text(comment.created_at),
            url: text(comment.url),
            minimized: comment.is_minimized.unwrap_or(false),
        })
        .collect()
}

/// The six states a check can be in, as far as anyone reading it cares.
///
/// A check run has a `status` (is it finished?) and, once finished, a
/// `conclusion`; a commit status has only a `state`. These are the same
/// buckets `gh pr checks` sorts them into, with "cancel" spelled out.
fn check_bucket(raw: &RawCheck) -> &'static str {
    let upper = |value: &Option<String>| value.as_deref().unwrap_or("").to_uppercase();
    let is_status_context = raw.typename.as_deref() == Some("StatusContext")
        || (raw.status.is_none() && raw.state.is_some());
    if is_status_context {
        return match upper(&raw.state).as_str() {
            "SUCCESS" => "pass",
            "FAILURE" | "ERROR" => "fail",
            _ => "pending",
        };
    }
    let status = upper(&raw.status);
    if !status.is_empty() && status != "COMPLETED" {
        return "pending";
    }
    match upper(&raw.conclusion).as_str() {
        "SUCCESS" => "pass",
        "FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => "fail",
        "CANCELLED" => "cancelled",
        "SKIPPED" => "skipped",
        // Finished with no verdict, a verdict of "neutral", or one GitHub has
        // since replaced ("stale"): nothing to celebrate or worry about.
        "" if status.is_empty() => "pending",
        _ => "neutral",
    }
}

fn check(raw: RawCheck) -> Check {
    let bucket = check_bucket(&raw);
    let detail = if raw
        .status
        .as_deref()
        .is_some_and(|s| !s.eq_ignore_ascii_case("completed"))
    {
        word(raw.status)
    } else {
        word(raw.conclusion).or(word(raw.state))
    };
    Check {
        name: text(raw.name)
            .or(text(raw.context))
            .unwrap_or_else(|| "check".to_string()),
        workflow: text(raw.workflow_name),
        bucket,
        detail,
        url: text(raw.details_url).or(text(raw.target_url)),
        description: text(raw.description),
        started_at: text(raw.started_at),
        completed_at: text(raw.completed_at),
    }
}

/// A pull request's checks, de-duplicated.
///
/// The rollup lists a check once per run, so a workflow that was re-run shows
/// every attempt. Only the last of each name is kept — what GitHub's own merge
/// box shows — so an old failure that has since passed does not hold a red
/// cross up forever.
fn checks(raw: Option<Vec<RawCheck>>) -> Vec<Check> {
    let mut kept: Vec<Check> = Vec::new();
    for entry in raw.unwrap_or_default().into_iter().map(check) {
        match kept
            .iter_mut()
            .find(|seen| seen.name == entry.name && seen.workflow == entry.workflow)
        {
            Some(seen) if entry.started_at >= seen.started_at => *seen = entry,
            Some(_) => {}
            None => kept.push(entry),
        }
    }
    kept
}

pub fn summarise(checks: &[Check]) -> CheckSummary {
    let mut summary = CheckSummary {
        total: checks.len(),
        ..CheckSummary::default()
    };
    for check in checks {
        match check.bucket {
            "pass" => summary.passed += 1,
            "fail" => summary.failed += 1,
            "pending" => summary.pending += 1,
            _ => {}
        }
    }
    summary
}

fn pull_state(state: Option<&str>) -> &'static str {
    match state.map(str::to_uppercase).as_deref() {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ => "open",
    }
}

fn repo(raw: RawRepo) -> Repo {
    let mut merge_methods = Vec::new();
    // Absent is taken as allowed: a gh too old to report it is better offered
    // the method and refused by GitHub than never offered one at all.
    if raw.merge_commit_allowed.unwrap_or(true) {
        merge_methods.push("merge");
    }
    if raw.squash_merge_allowed.unwrap_or(true) {
        merge_methods.push("squash");
    }
    if raw.rebase_merge_allowed.unwrap_or(true) {
        merge_methods.push("rebase");
    }
    Repo {
        name_with_owner: raw.name_with_owner.unwrap_or_default(),
        url: raw.url.unwrap_or_default(),
        merge_methods,
        permission: word(raw.viewer_permission),
        default_branch: raw.default_branch_ref.and_then(|r| text(r.name)),
        issues_enabled: raw.has_issues_enabled.unwrap_or(true),
    }
}

fn pull_summary(raw: RawPull) -> Option<PullSummary> {
    let checks = checks(raw.status_check_rollup);
    Some(PullSummary {
        number: raw.number?,
        title: raw.title.unwrap_or_default(),
        author: person(raw.author),
        draft: raw.is_draft.unwrap_or(false),
        head_ref: raw.head_ref_name.unwrap_or_default(),
        base_ref: raw.base_ref_name.unwrap_or_default(),
        labels: labels(raw.labels),
        checks: summarise(&checks),
        review_decision: word(raw.review_decision),
        updated_at: text(raw.updated_at),
        url: text(raw.url),
    })
}

fn issue_summary(raw: RawIssue) -> Option<IssueSummary> {
    Some(IssueSummary {
        number: raw.number?,
        title: raw.title.unwrap_or_default(),
        author: person(raw.author),
        labels: labels(raw.labels),
        updated_at: text(raw.updated_at),
        url: text(raw.url),
    })
}

fn pull(raw: RawPull) -> Option<Pull> {
    Some(Pull {
        number: raw.number?,
        title: raw.title.unwrap_or_default(),
        state: pull_state(raw.state.as_deref()),
        draft: raw.is_draft.unwrap_or(false),
        author: person(raw.author),
        base_ref: raw.base_ref_name.unwrap_or_default(),
        head_ref: raw.head_ref_name.unwrap_or_default(),
        head_owner: raw
            .head_repository_owner
            .and_then(|owner| text(owner.login)),
        cross_repository: raw.is_cross_repository.unwrap_or(false),
        body: raw.body.unwrap_or_default(),
        labels: labels(raw.labels),
        assignees: people(raw.assignees),
        review_requests: raw
            .review_requests
            .unwrap_or_default()
            .into_iter()
            .filter_map(|who| text(who.login).or(text(who.slug)).or(text(who.name)))
            .collect(),
        review_decision: word(raw.review_decision),
        mergeable: word(raw.mergeable),
        merge_state: word(raw.merge_state_status),
        additions: raw.additions.unwrap_or(0),
        deletions: raw.deletions.unwrap_or(0),
        changed_files: raw.changed_files.unwrap_or(0),
        commits: raw.commits.map(|list| list.len()).unwrap_or(0),
        comments: comments(raw.comments),
        reviews: raw
            .reviews
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(index, review)| Review {
                id: text(review.id).unwrap_or_else(|| format!("review-{index}")),
                author: person(review.author),
                association: word(review.author_association),
                body: review.body.unwrap_or_default(),
                state: word(review.state),
                submitted_at: text(review.submitted_at),
            })
            .collect(),
        checks: checks(raw.status_check_rollup),
        url: text(raw.url),
        created_at: text(raw.created_at),
        updated_at: text(raw.updated_at),
        merged_at: text(raw.merged_at),
        closed_at: text(raw.closed_at),
    })
}

fn issue(raw: RawIssue) -> Option<Issue> {
    Some(Issue {
        number: raw.number?,
        title: raw.title.unwrap_or_default(),
        state: if raw
            .state
            .as_deref()
            .is_some_and(|s| s.eq_ignore_ascii_case("closed"))
        {
            "closed"
        } else {
            "open"
        },
        state_reason: word(raw.state_reason),
        author: person(raw.author),
        labels: labels(raw.labels),
        assignees: people(raw.assignees),
        body: raw.body.unwrap_or_default(),
        comments: comments(raw.comments),
        url: text(raw.url),
        created_at: text(raw.created_at),
        updated_at: text(raw.updated_at),
        closed_at: text(raw.closed_at),
    })
}

/// The decoders, from bytes, for the commands and for the tests.
pub fn decode_repo(bytes: &[u8]) -> Result<Repo, GhError> {
    decode::<RawRepo>(bytes).map(repo)
}

pub fn decode_pull_list(bytes: &[u8]) -> Result<Vec<PullSummary>, GhError> {
    // An entry with no number is dropped; it could not be opened anyway.
    decode::<Vec<RawPull>>(bytes).map(|list| list.into_iter().filter_map(pull_summary).collect())
}

pub fn decode_issue_list(bytes: &[u8]) -> Result<Vec<IssueSummary>, GhError> {
    decode::<Vec<RawIssue>>(bytes).map(|list| list.into_iter().filter_map(issue_summary).collect())
}

pub fn decode_pull(bytes: &[u8]) -> Result<Pull, GhError> {
    pull(decode(bytes)?)
        .ok_or_else(|| GhError::new(GhErrorKind::Failed, "gh's answer had no number"))
}

pub fn decode_issue(bytes: &[u8]) -> Result<Issue, GhError> {
    issue(decode(bytes)?)
        .ok_or_else(|| GhError::new(GhErrorKind::Failed, "gh's answer had no number"))
}

/* ── The fields asked for ────────────────────────────────────────────────── */

const REPO_FIELDS: &str = "nameWithOwner,url,mergeCommitAllowed,squashMergeAllowed,\
rebaseMergeAllowed,viewerPermission,defaultBranchRef,hasIssuesEnabled";

const PULL_LIST_FIELDS: &str = "number,title,author,isDraft,headRefName,baseRefName,labels,\
statusCheckRollup,reviewDecision,updatedAt,url";

const ISSUE_LIST_FIELDS: &str = "number,title,author,labels,updatedAt,url";

const PULL_FIELDS: &str = "number,title,state,isDraft,author,baseRefName,headRefName,\
headRepositoryOwner,isCrossRepository,body,labels,assignees,reviewRequests,reviewDecision,\
mergeable,mergeStateStatus,additions,deletions,changedFiles,commits,comments,reviews,\
statusCheckRollup,url,createdAt,updatedAt,mergedAt,closedAt";

const ISSUE_FIELDS: &str = "number,title,state,stateReason,author,labels,assignees,body,\
comments,url,createdAt,updatedAt,closedAt";

fn read_repo(cwd: &Path) -> Result<Repo, GhError> {
    let run = gh(
        cwd,
        &["repo", "view", "--json", REPO_FIELDS],
        None,
        MAX_JSON_BYTES,
        READ_TIMEOUT,
    )?;
    decode_repo(&run.stdout)
}

/// Run two reads at once — the repository and the thing in it — and hand back
/// both, or the first failure. The repository's error is preferred: "not a
/// GitHub repository" is the truer answer than "no such pull request" when
/// both are true.
fn both<A: Send, B: Send>(
    first: impl FnOnce() -> Result<A, GhError> + Send,
    second: impl FnOnce() -> Result<B, GhError> + Send,
) -> Result<(A, B), GhError> {
    std::thread::scope(|scope| {
        let other = scope.spawn(second);
        let a = first();
        let b = other
            .join()
            .unwrap_or_else(|_| Err(GhError::new(GhErrorKind::Failed, "gh task failed")));
        Ok((a?, b?))
    })
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/// The repository `cwd` belongs to, with its open pull requests and issues.
///
/// The repository is asked about first and alone, because its failure is the
/// one that says what is wrong — gh missing, logged out, not a GitHub
/// repository — and there is no point asking two more questions that will fail
/// the same way.
#[tauri::command]
pub async fn github_lists(cwd: String) -> Result<Lists, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let repo = read_repo(cwd)?;
        let issues_enabled = repo.issues_enabled;
        let (pulls, issues) = both(
            || {
                let list: Vec<RawPull> = gh_json(
                    cwd,
                    &[
                        "pr",
                        "list",
                        "--limit",
                        LIST_LIMIT,
                        "--json",
                        PULL_LIST_FIELDS,
                    ],
                )?;
                Ok(list.into_iter().filter_map(pull_summary).collect())
            },
            || {
                // `gh issue list` on a repository with issues turned off is an
                // error, not an empty list.
                if !issues_enabled {
                    return Ok(Vec::new());
                }
                let list: Vec<RawIssue> = gh_json(
                    cwd,
                    &[
                        "issue",
                        "list",
                        "--limit",
                        LIST_LIMIT,
                        "--json",
                        ISSUE_LIST_FIELDS,
                    ],
                )?;
                Ok(list.into_iter().filter_map(issue_summary).collect())
            },
        )?;
        Ok(Lists {
            repo,
            pulls,
            issues,
        })
    })
    .await
}

/// One pull request in full, and the repository it is in — which says which
/// merge methods are allowed and whether this user may merge at all.
#[tauri::command]
pub async fn github_pull(cwd: String, number: u64) -> Result<PullView, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let (repo, pull) = both(
            || read_repo(cwd),
            || {
                let run = gh(
                    cwd,
                    &["pr", "view", &number, "--json", PULL_FIELDS],
                    None,
                    MAX_JSON_BYTES,
                    READ_TIMEOUT,
                )?;
                decode_pull(&run.stdout)
            },
        )?;
        Ok(PullView { repo, pull })
    })
    .await
}

/// A pull request's diff, cut at `MAX_DIFF_BYTES` on a line boundary.
#[tauri::command]
pub async fn github_pull_diff(cwd: String, number: u64) -> Result<PullDiff, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let run = gh(
            cwd,
            &["pr", "diff", &number, "--color=never"],
            None,
            MAX_DIFF_BYTES,
            READ_TIMEOUT,
        )?;
        let mut bytes = run.stdout;
        if run.truncated {
            if let Some(end) = bytes.iter().rposition(|&b| b == b'\n') {
                bytes.truncate(end + 1);
            }
        }
        Ok(PullDiff {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            truncated: run.truncated,
        })
    })
    .await
}

#[tauri::command]
pub async fn github_issue(cwd: String, number: u64) -> Result<IssueView, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let (repo, issue) = both(
            || read_repo(cwd),
            || {
                let run = gh(
                    cwd,
                    &["issue", "view", &number, "--json", ISSUE_FIELDS],
                    None,
                    MAX_JSON_BYTES,
                    READ_TIMEOUT,
                )?;
                decode_issue(&run.stdout)
            },
        )?;
        Ok(IssueView { repo, issue })
    })
    .await
}

/// Which list a number is in. Pull requests and issues share one sequence of
/// numbers on GitHub, but gh's commands for them are separate.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Pull,
    Issue,
}

/// Comment on a pull request or an issue. The body goes in on stdin.
#[tauri::command]
pub async fn github_comment(
    cwd: String,
    target: Target,
    number: u64,
    body: String,
) -> Result<String, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let body = checked_body(&body)?;
        let noun = match target {
            Target::Pull => "pr",
            Target::Issue => "issue",
        };
        gh_action(
            cwd,
            &[noun, "comment", &number, "--body-file", "-"],
            Some(body),
        )
    })
    .await
}

/// `gh pr checkout`: the pull request's branch, in the repository `cwd` is in.
/// Whatever git refuses — a dirty tree in the way — comes back in its words.
#[tauri::command]
pub async fn github_checkout(cwd: String, number: u64) -> Result<String, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        gh_action(cwd, &["pr", "checkout", &number], None)
    })
    .await
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

/// Merge a pull request with the method chosen. Always one flag, so gh has no
/// question to ask; no `--admin`, so branch protection is never bypassed from
/// here; no `--delete-branch`, which is a second decision nobody was asked.
#[tauri::command]
pub async fn github_merge(
    cwd: String,
    number: u64,
    method: MergeMethod,
) -> Result<String, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let flag = match method {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        };
        gh_action(cwd, &["pr", "merge", &number, flag], None)
    })
    .await
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

/// Close an issue, or reopen one.
#[tauri::command]
pub async fn github_set_issue_state(
    cwd: String,
    number: u64,
    state: IssueState,
) -> Result<String, GhError> {
    blocking(move || {
        let cwd = checked_dir(&cwd)?;
        let number = checked_number(number)?;
        let verb = match state {
            IssueState::Open => "reopen",
            IssueState::Closed => "close",
        };
        gh_action(cwd, &["issue", verb, &number], None)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from gh 2.103 against public repositories, trimmed, with fields
    // added that a newer gh might send and fields removed that an older one
    // might not.

    const REPO: &str = r#"{
        "defaultBranchRef": {"name": "main"},
        "mergeCommitAllowed": false,
        "nameWithOwner": "JacobFV/jterm",
        "rebaseMergeAllowed": true,
        "squashMergeAllowed": true,
        "url": "https://github.com/JacobFV/jterm",
        "viewerPermission": "ADMIN",
        "hasIssuesEnabled": true,
        "someFieldFromTheFuture": [1, 2, 3]
    }"#;

    const PULL_LIST: &str = r#"[
        {
            "author": {"id": "MDQ6VXNlcjQwMzQzOTEz", "is_bot": false, "login": "JacobFV", "name": "Jacob Valdez"},
            "baseRefName": "main",
            "headRefName": "feat/formula-ambient",
            "isDraft": true,
            "labels": [{"id": "LA_1", "name": "go", "description": "Go code", "color": "16e2e2"}],
            "number": 12,
            "reviewDecision": "",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "completedAt": "2026-08-16T06:25:10Z", "conclusion": "SUCCESS",
                 "detailsUrl": "https://github.com/JacobFV/jterm/actions/runs/1/job/2", "name": "frontend",
                 "startedAt": "2026-08-16T06:24:42Z", "status": "COMPLETED", "workflowName": "CI"},
                {"__typename": "CheckRun", "completedAt": "0001-01-01T00:00:00Z", "conclusion": "",
                 "detailsUrl": "https://github.com/JacobFV/jterm/actions/runs/1/job/3", "name": "backend",
                 "startedAt": "2026-08-16T06:24:42Z", "status": "IN_PROGRESS", "workflowName": "CI"}
            ],
            "title": "Add exact formula generative background",
            "updatedAt": "2026-08-16T06:25:11Z",
            "url": "https://github.com/JacobFV/jterm/pull/12"
        },
        {"title": "no number, so nothing to open"},
        {"number": 13, "author": null, "labels": null, "statusCheckRollup": null}
    ]"#;

    const PULL: &str = r#"{
        "additions": 174,
        "assignees": [],
        "author": {"id": "U_1", "is_bot": false, "login": "octocat", "name": "The Octocat"},
        "baseRefName": "main",
        "body": "Fixes #3.\n\n- [x] tests",
        "changedFiles": 5,
        "closedAt": null,
        "comments": [
            {"id": "IC_1", "author": {"login": "cli-triage"}, "authorAssociation": "NONE",
             "body": "**Recommendation: Review before merging**", "createdAt": "2026-11-10T14:22:31Z",
             "includesCreatedEdit": false, "isMinimized": false, "minimizedReason": "",
             "reactionGroups": [], "url": "https://github.com/cli/cli/pull/15010#issuecomment-1",
             "viewerDidAuthor": false},
            {"author": null, "body": "from a deleted account", "isMinimized": true}
        ],
        "commits": [{"oid": "cc89458b"}, {"oid": "dd00aa11"}, {"oid": "ee11bb22"}],
        "createdAt": "2026-08-16T06:24:37Z",
        "deletions": 28,
        "headRefName": "patch-1",
        "headRepositoryOwner": {"id": "U_2", "login": "someone-else", "name": "Someone"},
        "isCrossRepository": true,
        "isDraft": false,
        "labels": [{"name": "dependencies", "color": "0366d6", "description": ""},
                   {"name": "evil", "color": "red;background:url(x)"}],
        "mergeStateStatus": "BLOCKED",
        "mergeable": "MERGEABLE",
        "mergedAt": null,
        "number": 15010,
        "reviewDecision": "REVIEW_REQUIRED",
        "reviewRequests": [{"__typename": "User", "login": "tidy-dev"},
                           {"__typename": "Team", "name": "CLI maintainers", "slug": "cli/maintainers"}],
        "reviews": [
            {"id": "PRR_1", "author": {"login": "copilot-pull-request-reviewer"},
             "authorAssociation": "CONTRIBUTOR", "body": "", "submittedAt": "2026-11-10T14:05:25Z",
             "includesCreatedEdit": false, "reactionGroups": [], "state": "APPROVED",
             "commit": {"oid": "b557a232"}}
        ],
        "state": "OPEN",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "lint", "workflowName": "CI", "status": "COMPLETED",
             "conclusion": "FAILURE", "startedAt": "2026-11-10T14:00:00Z",
             "detailsUrl": "https://github.com/cli/cli/actions/runs/1/job/1"},
            {"__typename": "CheckRun", "name": "lint", "workflowName": "CI", "status": "COMPLETED",
             "conclusion": "SUCCESS", "startedAt": "2026-11-10T15:00:00Z",
             "detailsUrl": "https://github.com/cli/cli/actions/runs/2/job/1"},
            {"__typename": "CheckRun", "name": "label-external", "workflowName": "PR Triaging",
             "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "2026-11-10T14:03:29Z"},
            {"__typename": "StatusContext", "context": "ci/circleci", "description": "Your tests are queued",
             "state": "PENDING", "targetUrl": "https://circleci.com/gh/x/1", "startedAt": "2026-11-10T14:03:00Z"},
            {"__typename": "StatusContext", "context": "netlify/deploy", "state": "ERROR"}
        ],
        "title": "build(deps): bump golang.org/x/crypto",
        "updatedAt": "2026-11-10T14:22:31Z",
        "url": "https://github.com/cli/cli/pull/15010"
    }"#;

    const ISSUE: &str = r#"{
        "assignees": [{"id": "U_3", "login": "mislav", "name": "Mislav"}],
        "author": {"id": "U_kgDOEPowwQ", "is_bot": false, "login": "ottopb", "name": "Otto"},
        "body": "I just noticed…\n\n### Describe the feature",
        "comments": [{"author": {"login": "cli-triage"}, "authorAssociation": "NONE",
                      "body": "Current release does not provide a global default-remote setting.",
                      "createdAt": "2026-11-11T18:38:23Z", "id": "IC_2", "isMinimized": false,
                      "url": "https://github.com/cli/cli/issues/15029#issuecomment-2"}],
        "createdAt": "2026-11-11T18:30:34Z",
        "labels": [{"color": "D6393F", "description": "needs to be reviewed", "id": "LA_2", "name": "needs-triage"}],
        "milestone": null,
        "number": 15029,
        "state": "CLOSED",
        "stateReason": "NOT_PLANNED",
        "title": "gh silently targets the `upstream` remote over `origin`",
        "url": "https://github.com/cli/cli/issues/15029"
    }"#;

    #[test]
    fn reads_a_repository_and_the_merge_methods_it_allows() {
        let repo = decode_repo(REPO.as_bytes()).unwrap();
        assert_eq!(repo.name_with_owner, "JacobFV/jterm");
        assert_eq!(repo.merge_methods, ["squash", "rebase"]);
        assert_eq!(repo.permission.as_deref(), Some("admin"));
        assert_eq!(repo.default_branch.as_deref(), Some("main"));
        assert!(repo.issues_enabled);

        // An older gh that knows none of the newer fields still gets a repo,
        // and is offered every method rather than none.
        let bare = decode_repo(br#"{"nameWithOwner": "a/b"}"#).unwrap();
        assert_eq!(bare.merge_methods, ["merge", "squash", "rebase"]);
        assert_eq!(bare.permission, None);
    }

    #[test]
    fn reads_a_pull_request_list_and_sums_its_checks() {
        let list = decode_pull_list(PULL_LIST.as_bytes()).unwrap();
        assert_eq!(list.len(), 2, "the entry with no number is dropped");
        let first = &list[0];
        assert_eq!(first.number, 12);
        assert!(first.draft);
        assert_eq!(first.author.login, "JacobFV");
        assert_eq!(first.author.name.as_deref(), Some("Jacob Valdez"));
        assert_eq!(first.review_decision, None, "an empty decision is none");
        assert_eq!(
            first.checks,
            CheckSummary {
                total: 2,
                passed: 1,
                failed: 0,
                pending: 1
            }
        );
        assert_eq!(first.labels[0].color.as_deref(), Some("16e2e2"));

        // Nulls where lists and people were are blanks, not failures.
        let bare = &list[1];
        assert_eq!(bare.author.login, "ghost");
        assert!(bare.labels.is_empty());
        assert_eq!(bare.checks.total, 0);
    }

    #[test]
    fn reads_a_pull_request_in_full() {
        let pull = decode_pull(PULL.as_bytes()).unwrap();
        assert_eq!(pull.number, 15010);
        assert_eq!(pull.state, "open");
        assert!(!pull.draft);
        assert_eq!(pull.head_owner.as_deref(), Some("someone-else"));
        assert!(pull.cross_repository);
        assert_eq!(pull.commits, 3);
        assert_eq!(
            (pull.additions, pull.deletions, pull.changed_files),
            (174, 28, 5)
        );
        assert_eq!(pull.mergeable.as_deref(), Some("mergeable"));
        assert_eq!(pull.merge_state.as_deref(), Some("blocked"));
        assert_eq!(pull.review_decision.as_deref(), Some("review_required"));
        assert_eq!(pull.review_requests, ["tidy-dev", "cli/maintainers"]);

        assert_eq!(pull.comments.len(), 2);
        assert_eq!(pull.comments[0].association.as_deref(), Some("none"));
        assert_eq!(pull.comments[1].author.login, "ghost");
        assert!(pull.comments[1].minimized);
        assert_eq!(
            pull.comments[1].id, "comment-1",
            "a comment with no id still gets a key"
        );

        assert_eq!(pull.reviews[0].state.as_deref(), Some("approved"));

        // A label colour that is not six hex digits never reaches a style.
        assert_eq!(pull.labels[1].color, None);
    }

    #[test]
    fn keeps_the_latest_run_of_each_check_and_sorts_every_kind_into_a_bucket() {
        let pull = decode_pull(PULL.as_bytes()).unwrap();
        let by_name: Vec<(&str, &str)> = pull
            .checks
            .iter()
            .map(|check| (check.name.as_str(), check.bucket))
            .collect();
        assert_eq!(
            by_name,
            [
                // The failure was re-run and passed; only the pass is kept.
                ("lint", "pass"),
                ("label-external", "skipped"),
                ("ci/circleci", "pending"),
                ("netlify/deploy", "fail"),
            ]
        );
        assert_eq!(
            pull.checks[0].url.as_deref(),
            Some("https://github.com/cli/cli/actions/runs/2/job/1")
        );
        assert_eq!(
            pull.checks[2].url.as_deref(),
            Some("https://circleci.com/gh/x/1")
        );
        assert_eq!(
            pull.checks[2].description.as_deref(),
            Some("Your tests are queued")
        );
        assert_eq!(pull.checks[3].detail.as_deref(), Some("error"));
        assert_eq!(
            summarise(&pull.checks),
            CheckSummary {
                total: 4,
                passed: 1,
                failed: 1,
                pending: 1
            }
        );
    }

    #[test]
    fn reads_merged_and_closed_pull_requests() {
        let merged = decode_pull(br#"{"number": 1, "state": "MERGED"}"#).unwrap();
        assert_eq!(merged.state, "merged");
        let closed = decode_pull(br#"{"number": 1, "state": "CLOSED"}"#).unwrap();
        assert_eq!(closed.state, "closed");
        let unknown = decode_pull(br#"{"number": 1}"#).unwrap();
        assert_eq!(unknown.state, "open");
        assert!(decode_pull(br#"{"title": "no number"}"#).is_err());
        assert!(decode_pull(b"not json").is_err());
    }

    #[test]
    fn reads_an_issue_in_full() {
        let issue = decode_issue(ISSUE.as_bytes()).unwrap();
        assert_eq!(issue.number, 15029);
        assert_eq!(issue.state, "closed");
        assert_eq!(issue.state_reason.as_deref(), Some("not_planned"));
        assert_eq!(issue.assignees[0].login, "mislav");
        assert_eq!(issue.labels[0].name, "needs-triage");
        assert_eq!(issue.comments.len(), 1);
        assert!(issue.body.contains("### Describe"));

        let list = decode_issue_list(br#"[{"number": 4, "title": "t", "author": {"login": "a"}}]"#)
            .unwrap();
        assert_eq!(list[0].number, 4);
        assert_eq!(list[0].author.login, "a");
    }

    #[test]
    fn sorts_gh_errors_into_what_the_user_has_to_do() {
        let kind = |stderr: &str, code: Option<i32>| classify(stderr, code).kind;
        // Each of these is gh 2.103's own wording.
        assert_eq!(
            kind(
                "failed to run git: fatal: not a git repository (or any of the parent directories): .git",
                Some(1)
            ),
            GhErrorKind::NotRepo
        );
        assert_eq!(
            kind("no git remotes found", Some(1)),
            GhErrorKind::NotGithub
        );
        assert_eq!(
            kind(
                "none of the git remotes configured for this repository point to a known GitHub host. \
                 To tell gh about a new GitHub host, please use `gh auth login`",
                Some(1)
            ),
            GhErrorKind::NotGithub,
            "mentions gh auth login, but is about remotes"
        );
        assert_eq!(
            kind(
                "GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)",
                Some(1)
            ),
            GhErrorKind::NotFound
        );
        assert_eq!(
            kind(
                "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com",
                Some(1)
            ),
            GhErrorKind::Auth
        );
        assert_eq!(
            kind(
                "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable",
                Some(4)
            ),
            GhErrorKind::Auth
        );
        assert_eq!(
            kind(
                "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com",
                Some(1)
            ),
            GhErrorKind::Offline
        );
        assert_eq!(
            kind(
                "Post \"https://api.github.com/graphql\": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused",
                Some(1)
            ),
            GhErrorKind::Offline
        );
        let other = classify(
            "Pull request #3 is not mergeable: the merge commit cannot be cleanly created.",
            Some(1),
        );
        assert_eq!(other.kind, GhErrorKind::Failed);
        assert!(
            other.message.contains("not mergeable"),
            "gh's words are kept"
        );
        assert_eq!(
            classify("", Some(1)).message,
            "gh failed without saying why"
        );
    }

    #[test]
    fn refuses_numbers_bodies_and_directories_that_could_not_be_meant() {
        assert_eq!(checked_number(42).unwrap(), "42");
        assert_eq!(checked_number(0).unwrap_err().kind, GhErrorKind::Invalid);
        assert!(checked_number(u64::MAX).is_err());
        assert!(checked_body("  \n ").is_err());
        assert!(checked_body("LGTM").is_ok());
        // Free text that looks like a flag is fine: it goes in on stdin.
        assert!(checked_body("--admin").is_ok());
        assert!(checked_body(&"x".repeat(MAX_COMMENT_CHARS + 1)).is_err());
        assert!(checked_dir("").is_err());
        assert!(checked_dir("/definitely/not/a/directory/anywhere").is_err());
        assert!(checked_dir(std::env::temp_dir().to_str().unwrap()).is_ok());
    }

    #[test]
    fn the_enumerations_from_the_frontend_are_the_only_words_accepted() {
        let method: MergeMethod = serde_json::from_str("\"squash\"").unwrap();
        assert_eq!(method, MergeMethod::Squash);
        assert!(serde_json::from_str::<MergeMethod>("\"--admin\"").is_err());
        assert!(serde_json::from_str::<Target>("\"pull\"").is_ok());
        assert!(serde_json::from_str::<IssueState>("\"locked\"").is_err());
    }

    #[test]
    fn an_error_crosses_to_the_frontend_as_a_kind_and_a_message() {
        let json =
            serde_json::to_string(&GhError::new(GhErrorKind::NotGithub, "no remotes")).unwrap();
        assert_eq!(json, r#"{"kind":"notGithub","message":"no remotes"}"#);
    }
    #[test]
    fn runs_gh_with_its_output_capped() {
        // No network: `--version` is answered locally. A machine without gh
        // says so in the kind the panes draw an install hint from.
        let dir = std::env::temp_dir();
        match gh(&dir, &["--version"], None, 1 << 16, READ_TIMEOUT) {
            Ok(run) => {
                assert!(String::from_utf8_lossy(&run.stdout).contains("gh version"));
                assert!(!run.truncated);
                let cut = gh(&dir, &["--version"], None, 4, READ_TIMEOUT).unwrap();
                assert!(cut.truncated);
                assert_eq!(cut.stdout.len(), 4);
            }
            Err(err) => assert_eq!(err.kind, GhErrorKind::Missing),
        }
    }

    /// Against GitHub, through the gh on this machine, for this repository.
    /// Needs a login and the network, so it is run by hand:
    /// `cargo test github -- --ignored`. `JTERM_GH_TEST_DIR` points it at a
    /// checkout of a busier repository, one with open pull requests to read.
    #[test]
    #[ignore]
    fn reads_this_repository_from_github() {
        let here = std::env::var("JTERM_GH_TEST_DIR")
            .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        let lists = tauri::async_runtime::block_on(github_lists(here.clone())).unwrap();
        assert!(lists.repo.name_with_owner.contains('/'));
        if let Some(first) = lists.pulls.first() {
            let view =
                tauri::async_runtime::block_on(github_pull(here.clone(), first.number)).unwrap();
            assert_eq!(view.pull.number, first.number);
            let diff = tauri::async_runtime::block_on(github_pull_diff(here.clone(), first.number))
                .unwrap();
            assert!(diff.text.starts_with("diff --git"));
        }
        let missing = tauri::async_runtime::block_on(github_issue(here, 999_999_999)).unwrap_err();
        assert_eq!(missing.kind, GhErrorKind::NotFound, "{missing:?}");
    }
}
