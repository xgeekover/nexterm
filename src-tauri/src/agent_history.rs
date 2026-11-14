//! The agent session history: the Claude Code and OpenCode conversations
//! that ran in NexTerm, kept in one file so that they can be picked again
//! after a restart (the AGENT SESSIONS list and the palette). The page
//! records them and resumes them through a terminal's own Resume; this
//! module only keeps the file, through the `agent_history_*` commands
//! (commands/agent_history.rs). The browser mock in src/lib/ipc.js keeps the
//! same rules, and `contract_tests` below writes what this module answered
//! to `tests/fixtures/agent-history.json` so that the mock is checked
//! against it (tests/adversarial/agent_history_contract.test.js).
//!
//! **Where.** `agent-sessions.json` in the app's LOCAL data folder
//! (`app_local_data_dir`), beside the saved scrollback and for the same
//! reason (src/scrollback.rs): the conversations themselves live only on
//! this machine, so a roaming profile has no use for a list of them. macOS
//! `~/Library/Application Support/com.nexterm.ide`, Linux
//! `$XDG_DATA_HOME/com.nexterm.ide`, Windows `%LOCALAPPDATA%\com.nexterm.ide`.
//! The webview never names a path.
//!
//! **The format, version 1.** `{"version":1,"entries":[…]}`, each entry
//! `{key, kind, sessionId, cwd, title, startedAt, lastUsedAt, endedAt,
//! endReason}` (`Entry`), times in milliseconds since the epoch, newest
//! first. A field this build does not know is ignored. A kind it does not
//! know but that is well formed (`is_kind`) is kept and handed back like any
//! other: the page shows and resumes only the agents it knows, and a later
//! build can add one without a new format.
//!
//! **What is refused.** The file is anyone's to edit, and a session id is
//! typed into a shell when a conversation is resumed. So an entry is only
//! kept when every field is what this build could have written (`entry_from`):
//! a session id of its kind's one shape — the same patterns as
//! src/lib/agents.js — a folder that is an absolute path without control
//! characters, a title of one line. An entry that is not is dropped on read
//! and refused on write; the rest of the file is kept.
//!
//! **One entry per conversation.** Its `key` is made here from its fields
//! (`key_of`), never taken from the page or the file: `<kind>:<sessionId>`,
//! or for a conversation whose id is not known yet `<kind>:~<cwd>\0<title>`.
//! A write of a key that is there merges into it (`merge`). A write may name
//! the provisional key it `replaces` — the entry that has since learned its
//! id, or its title — which then goes, merged into the new one.
//!
//! **Caps.** CAP entries: after every write the least recently used go,
//! never the one just written. A file over MAX_READ_BYTES is not read, so
//! none is written: when CAP entries with folders and titles near their own
//! caps would come to more, the least recently used go until it fits
//! (`fitted_text`).
//!
//! **A file that cannot be read** — not UTF-8, not JSON, cut short, not the
//! shape above, too large, not a regular file — never stops anything. Its
//! bytes are moved aside to `agent-sessions.json.bad-<ms>` (the newest
//! KEEP_BAD are kept), a new empty history is written, and why is logged.
//! A clear deletes those too: a cleared history leaves no copies — and a
//! clear that could not delete one, after a few tries, says so
//! (`copies_left`) rather than report the history cleared. A name with a
//! time past MAX_INTEGER is not one of ours (`bad_ms`), and one more than a
//! day ahead of the clock does not decide where the next name goes.
//!
//! **Frozen for every later version.** A file is only known to be a newer
//! format once it has been read — within MAX_READ_BYTES — and parsed as the
//! envelope `{"version": n, "entries": [...]}`. A later format that grew
//! past that size, or wrapped its entries otherwise, would be moved aside
//! by this build as unreadable rather than left alone. So MAX_READ_BYTES
//! and that envelope stay as they are in every version after this one.
//! A file that is not there is the same as an empty history, and is written
//! by the first operation that finds it missing: the file is what the history
//! is, so one the user deleted stays deleted.
//!
//! **A newer format** (`version` above VERSION) is never overwritten or moved
//! aside: a list hands back the entries this build can read, and every write
//! is refused with NEWER_VERSION, logged once.
//!
//! **Links.** The app data folder, the file and the lock file are each looked
//! at themselves before use, and one that is a link (on Windows any reparse
//! point) refuses the operation. The file is read through the open handle,
//! not following a link (`read_small_file`). As in src/scrollback.rs, a link
//! swapped in between a look and a rename by path is not caught: only the
//! user's own programs, or root, can rename entries in that folder.
//!
//! **A write replaces the whole file or nothing**, short of a power cut: the
//! text goes to a new temporary file beside it (`create_new`, 0600 on unix)
//! that is renamed over the old one. It is not flushed first, for the reason
//! src/scrollback.rs gives; after a power cut the file may be garbage, and is
//! then moved aside as above. A temporary file a crash left is removed at the
//! next operation.
//!
//! **One at a time, across NexTerms.** Every operation is one read, change
//! and write, and holds LOCK for all of it, and an exclusive lock on
//! LOCK_FILE beside the file (`File::try_lock`: flock on unix, LockFileEx on
//! Windows), waited for up to LOCK_WAIT. Unlike the scrollback's lock, which
//! the first NexTerm keeps for good, this one is let go after each
//! operation: a second running copy records too, and neither overwrites the
//! other's entries. Nothing is kept in memory between operations; the file
//! is read again each time.

use std::fs::{self, Metadata};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::fs::{read_small_file, SmallFileError};

/// The file, in the app's local data folder.
pub const FILE: &str = "agent-sessions.json";

/// The file every operation holds locked, beside FILE.
const LOCK_FILE: &str = ".agent-sessions.lock";

/// What a temporary file's name starts with: `.agent-sessions.json.<pid>-<n>.tmp`.
const TEMP_PREFIX: &str = ".agent-sessions.json.";

/// What follows FILE in the name of a file moved aside, before its time.
const BAD_SUFFIX: &str = ".bad-";

/// The format this build writes.
pub const VERSION: u64 = 1;

/// The most entries kept. Mirrored by the browser mock.
pub const CAP: usize = 200;

/// The most of the file that is read: 1 MiB, some twenty times what CAP
/// entries take. Mirrored by the browser mock.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// How many files moved aside are kept, the newest.
pub const KEEP_BAD: usize = 3;

/// How long an operation waits for another NexTerm's to let go of LOCK_FILE.
const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_POLL: Duration = Duration::from_millis(10);

/// The longest a kind is: `^[a-z][a-z0-9-]{0,31}$`.
const MAX_KIND_CHARS: usize = 32;

/// The longest folder kept, in UTF-8 bytes.
pub const MAX_CWD_BYTES: usize = 4096;

/// The longest title kept, in characters: src/lib/agents.js `TITLE_MAX`.
pub const MAX_TITLE_CHARS: usize = 200;

/// The longest session id of a kind this build does not know, in characters.
pub const MAX_OTHER_ID_CHARS: usize = 128;

/// The largest time, and version, kept: JavaScript's largest safe integer,
/// so that the page reads back exactly what was written.
pub const MAX_INTEGER: u64 = 9_007_199_254_740_991;

/// How every refused write of a newer file begins.
pub const NEWER_VERSION: &str = "The agent session history was written by a newer NexTerm";

/// Why an operation is refused when another NexTerm held LOCK_FILE for all of LOCK_WAIT.
pub const BUSY: &str = "Another NexTerm is updating the agent session history; try again in a moment";

/// How the refusal of an entry that is not valid begins, before `: <why>`.
pub const INVALID: &str = "Not a valid agent session";

/// How many times a rename over the file is tried. Windows refuses one while
/// another program holds the old file open without FILE_SHARE_DELETE (a
/// scanner or an indexer, briefly); unix renames atomically or not at all.
const RENAME_TRIES: u32 = if cfg!(windows) { 10 } else { 1 };
const RENAME_PAUSE: Duration = Duration::from_millis(50);

/// How many times a clear tries to delete a file moved aside, DELETE_PAUSE
/// apart: on Windows a scanner or an indexer may hold it open briefly.
const DELETE_TRIES: u32 = 5;
const DELETE_PAUSE: Duration = Duration::from_millis(50);

/// How far ahead of the clock the time in a name moved aside may be and
/// still order the next one: a day.
const BAD_AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

/// How a clear that emptied the history but left a copy of it begins.
pub const COPIES_LEFT: &str = "The agent session history was emptied, but";

/// Held by every operation for all of it. See the module's doc.
static LOCK: Mutex<()> = Mutex::new(());

/// The folders whose newer file this process has said it will not write.
static NEWER_SAID: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Makes each temporary file's name its own within this process.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// One conversation, as kept and as handed to the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Made from the fields (`key_of`), never taken as given.
    pub key: String,
    /// `claude`, `opencode`, or another well-formed name (`is_kind`).
    pub kind: String,
    /// The conversation's own id, of its kind's shape, or none yet.
    pub session_id: Option<String>,
    /// The folder it ran in, as a terminal is started in it.
    pub cwd: String,
    /// One line, at most MAX_TITLE_CHARS characters, or none.
    pub title: Option<String>,
    pub started_at: u64,
    /// The last event recorded for it: started, resumed, id or title learned, ended.
    pub last_used_at: u64,
    pub ended_at: Option<u64>,
    /// Set exactly when `ended_at` is.
    pub end_reason: Option<EndReason>,
}

/// How a conversation's terminal stopped running it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EndReason {
    /// The agent's process ended and the shell's prompt came back.
    Exited,
    /// The terminal was closed while it ran.
    Closed,
}

/// The file as written.
#[derive(Serialize)]
struct Document<'a> {
    version: u64,
    entries: &'a [Entry],
}

/// What a read found, once anything unreadable has been moved aside.
enum Stored {
    /// This version: its valid entries, newest first, at most CAP.
    Current(Vec<Entry>),
    /// A newer version, read only: the entries this build can read.
    Newer { version: u64, entries: Vec<Entry> },
}

// ---- Entries ------------------------------------------------------------------

/// A character no folder or title is kept with: C0, DEL and C1 controls, the
/// line and paragraph separators, and the bidi embeddings, overrides and
/// isolates — what src/lib/agents.js `cleanAgentTitle` takes out of a title.
fn refused_char(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

/// Whether `kind` names an agent: `^[a-z][a-z0-9-]{0,31}$`, ASCII only.
fn is_kind(kind: &str) -> bool {
    let bytes = kind.as_bytes();
    (1..=MAX_KIND_CHARS).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A Claude Code conversation id: a lowercase v4 UUID, the only shape
/// `claude --session-id` takes and the one NexTerm makes — src/lib/agents.js
/// `CLAUDE_SESSION_ID` (line 83),
/// `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`.
/// Also what src/claude_conversations.rs checks an id against before it
/// becomes a file name there.
pub(crate) fn is_claude_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, &b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'4',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// An OpenCode conversation id: src/lib/agents.js `OPENCODE_SESSION_ID`
/// (line 92), `/^ses_[0-9A-Za-z]{8,64}$/`.
fn is_opencode_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Whether `id` is a session id `kind` has. A kind this build does not know
/// is held only to what any field is: one line, of a bounded length. Its
/// ids are never typed by this build.
fn is_session_id_for(kind: &str, id: &str) -> bool {
    match kind {
        "claude" => is_claude_id(id),
        "opencode" => is_opencode_id(id),
        _ => (1..=MAX_OTHER_ID_CHARS).contains(&id.chars().count()) && !id.chars().any(refused_char),
    }
}

/// An absolute path on any platform: `/…`, `\\…` (UNC, `\\?\`), or `X:\…` / `X:/…`.
fn is_absolute(cwd: &str) -> bool {
    let bytes = cwd.as_bytes();
    bytes.first() == Some(&b'/')
        || cwd.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
}

fn is_cwd(cwd: &str) -> bool {
    !cwd.is_empty() && cwd.len() <= MAX_CWD_BYTES && is_absolute(cwd) && !cwd.chars().any(refused_char)
}

fn is_title(title: &str) -> bool {
    (1..=MAX_TITLE_CHARS).contains(&title.chars().count()) && !title.chars().any(refused_char)
}

/// The key an entry is kept under. See the module's doc.
fn key_of(kind: &str, session_id: Option<&str>, cwd: &str, title: Option<&str>) -> String {
    match session_id {
        Some(id) => format!("{kind}:{id}"),
        None => format!("{kind}:~{cwd}\u{0}{}", title.unwrap_or("")),
    }
}

/// A field that is text: missing and null are none; anything else but a
/// string is `Err`.
fn text_field<'a>(entry: &'a Map<String, Value>, name: &str) -> Result<Option<&'a str>, ()> {
    match entry.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(()),
    }
}

/// A field that is a time: missing and null are none; anything else but a
/// whole number from 0 to MAX_INTEGER — written without a fraction or an
/// exponent — is `Err`.
fn time_field(entry: &Map<String, Value>, name: &str) -> Result<Option<u64>, ()> {
    match entry.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().filter(|&at| at <= MAX_INTEGER).map(Some).ok_or(()),
    }
}

/// `value` as an entry, its key made from its fields, or why it is not one.
/// The same test for an entry read from the file and one the page writes.
/// The browser mock asks the same questions in the same order, with the
/// same answers.
fn entry_from(value: &Value) -> Result<Entry, String> {
    let Some(entry) = value.as_object() else {
        return Err("it is not an object".to_string());
    };
    let kind = match text_field(entry, "kind") {
        Ok(Some(kind)) if is_kind(kind) => kind,
        _ => return Err("its kind is not an agent's name".to_string()),
    };
    let session_id = match text_field(entry, "sessionId") {
        Ok(None) => None,
        Ok(Some(id)) if is_session_id_for(kind, id) => Some(id),
        _ => return Err(format!("its session id is not one that {kind} gives a conversation")),
    };
    let cwd = match text_field(entry, "cwd") {
        Ok(Some(cwd)) if is_cwd(cwd) => cwd,
        _ => return Err("its folder is not an absolute path".to_string()),
    };
    let title = match text_field(entry, "title") {
        Ok(None) => None,
        Ok(Some(title)) if is_title(title) => Some(title),
        _ => return Err(format!("its title is not one line of at most {MAX_TITLE_CHARS} characters")),
    };
    let Ok(Some(started_at)) = time_field(entry, "startedAt") else {
        return Err("its startedAt is not a time".to_string());
    };
    let Ok(Some(last_used_at)) = time_field(entry, "lastUsedAt") else {
        return Err("its lastUsedAt is not a time".to_string());
    };
    let Ok(ended_at) = time_field(entry, "endedAt") else {
        return Err("its endedAt is not a time".to_string());
    };
    let end_reason = match text_field(entry, "endReason") {
        Ok(None) => None,
        Ok(Some("exited")) => Some(EndReason::Exited),
        Ok(Some("closed")) => Some(EndReason::Closed),
        _ => return Err("its endReason is neither exited nor closed".to_string()),
    };
    if ended_at.is_some() != end_reason.is_some() {
        return Err("it has an endedAt without an endReason, or an endReason without an endedAt".to_string());
    }
    Ok(Entry {
        key: key_of(kind, session_id, cwd, title),
        kind: kind.to_string(),
        session_id: session_id.map(str::to_string),
        cwd: cwd.to_string(),
        title: title.map(str::to_string),
        started_at,
        last_used_at,
        ended_at,
        end_reason,
    })
}

/// `incoming`, written by the page, merged with `others`: the entry already
/// under its key, then the provisional one it replaces, as there are.
///
/// Its kind, id and folder are the incoming ones, and so is its key. It
/// started at the earliest start and was last used at the latest use. It
/// ended as the most recently used of them did — the incoming one when two
/// were used at the same time. Its title is the newest there is, again by
/// last use; but for an entry with no id the title is part of its key, so it
/// stays the incoming one.
fn merge(incoming: Entry, others: Vec<Entry>) -> Entry {
    let mut all = Vec::with_capacity(1 + others.len());
    all.push(incoming);
    all.extend(others);
    let started_at = all.iter().map(|e| e.started_at).fold(all[0].started_at, u64::min);
    let mut newest_first: Vec<&Entry> = all.iter().collect();
    // Stable: of two used at the same time, the incoming one comes first.
    newest_first.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    let newest = newest_first[0];
    let title = if all[0].session_id.is_some() {
        newest_first.iter().find_map(|e| e.title.clone())
    } else {
        all[0].title.clone()
    };
    let (last_used_at, ended_at, end_reason) = (newest.last_used_at, newest.ended_at, newest.end_reason);
    let mut merged = all.swap_remove(0);
    merged.started_at = started_at;
    merged.last_used_at = last_used_at;
    merged.ended_at = ended_at;
    merged.end_reason = end_reason;
    merged.title = title;
    merged
}

/// Most recently used first; of two used at the same time, the one that was
/// first stays first.
fn sort_newest_first(entries: &mut [Entry]) {
    entries.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
}

/// Drop the least recently used until CAP are left — never `written`.
fn keep_cap(entries: &mut Vec<Entry>, written: &str) {
    while entries.len() > CAP {
        let Some(at) = entries.iter().rposition(|e| e.key != written) else {
            break;
        };
        entries.remove(at);
    }
}

/// The valid entries of a file's `entries`, newest first, at most CAP. Of
/// two with the same key, the one earlier in the file is kept.
fn valid_entries(values: &[Value]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    for value in values {
        let Ok(entry) = entry_from(value) else { continue };
        if entries.iter().all(|e| e.key != entry.key) {
            entries.push(entry);
        }
    }
    sort_newest_first(&mut entries);
    entries.truncate(CAP);
    entries
}

/// What a file's bytes hold.
enum Parsed {
    /// Not a history this or any build wrote: why.
    Unreadable(&'static str),
    Read { version: u64, entries: Vec<Entry> },
}

fn parse(bytes: &[u8]) -> Parsed {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Parsed::Unreadable("it is not UTF-8 text");
    };
    let Ok(document) = serde_json::from_str::<Value>(text) else {
        return Parsed::Unreadable("it is not JSON");
    };
    let Some(document) = document.as_object() else {
        return Parsed::Unreadable("it is not an agent session history");
    };
    let Some(version) = document
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| (1..=MAX_INTEGER).contains(v))
    else {
        return Parsed::Unreadable("it has no format version");
    };
    let entries = document.get("entries").and_then(Value::as_array);
    if version == VERSION && entries.is_none() {
        return Parsed::Unreadable("it has no list of entries");
    }
    Parsed::Read {
        version,
        entries: valid_entries(entries.map(Vec::as_slice).unwrap_or(&[])),
    }
}

// ---- The folder and the file ----------------------------------------------------

/// Whether the entry `meta` describes — from `symlink_metadata`, never
/// followed — is a symbolic link, or on Windows any reparse point at all.
/// The same test as src/scrollback.rs; src/claude_conversations.rs uses it too.
pub(crate) fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn link_refusal(path: &Path) -> String {
    format!("{} is a link \u{2014} NexTerm keeps no agent session history through it", path.display())
}

fn log(line: &str) {
    eprintln!("[NexTerm] {line}");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// `base`, the app's local data folder, made with its parents when it is not
/// there; refused when it is a link or not a folder.
fn folder(base: &Path) -> Result<(), String> {
    let looked_at = |e: std::io::Error| format!("{} could not be looked at: {e}", base.display());
    let meta = match fs::symlink_metadata(base) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(base).map_err(|e| format!("{} could not be made: {e}", base.display()))?;
            // Looked at again rather than trusted: something else may have
            // put a link there first.
            fs::symlink_metadata(base).map_err(looked_at)?
        }
        Err(e) => return Err(looked_at(e)),
    };
    if is_link(&meta) {
        return Err(link_refusal(base));
    }
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", base.display()));
    }
    Ok(())
}

/// LOCK_FILE in `base`, opened — never through a link — and locked, waiting
/// up to LOCK_WAIT for another process to let go of it. Let go of when the
/// file is dropped, at the end of the operation.
fn lock_file(base: &Path) -> Result<fs::File, String> {
    let path = base.join(LOCK_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|meta| is_link(&meta)) {
        return Err(link_refusal(&path));
    }
    let failed = |e: std::io::Error| format!("{} could not be locked: {e}", path.display());
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(failed)?;
    if !file.metadata().map_err(failed)?.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(LOCK_POLL),
            Err(fs::TryLockError::WouldBlock) => return Err(BUSY.to_string()),
            Err(fs::TryLockError::Error(e)) => return Err(failed(e)),
        }
    }
}

/// Whether `name` is one of this module's temporary files.
fn is_our_temp(name: &str) -> bool {
    name.strip_prefix(TEMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .is_some_and(|unique| !unique.is_empty() && unique.bytes().all(|b| b.is_ascii_digit() || b == b'-'))
}

/// The time in the name of a file moved aside, if `name` is one. A time past
/// MAX_INTEGER — the largest this module keeps anywhere — is not one this
/// or any NexTerm named: not ours, so never counted, kept or deleted.
fn bad_ms(name: &str) -> Option<u64> {
    let digits = name.strip_prefix(FILE)?.strip_prefix(BAD_SUFFIX)?;
    if digits.is_empty() || digits.len() > 20 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().filter(|&ms| ms <= MAX_INTEGER)
}

/// The names in `base` that `pick` chooses, with their paths. A name that is
/// not UTF-8 is never one of ours.
fn names_in(base: &Path, pick: impl Fn(&str) -> bool) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            pick(&name).then(|| (name, entry.path()))
        })
        .collect()
}

/// Remove the entry at `path`, which bears one of our names: a file, or a
/// link as a link; a folder is left alone. Logged when it cannot go.
fn remove_ours(path: &Path, what: &str) {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
        return;
    }
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => log(&format!("Could not delete {what} {}: {e}", path.display())),
    }
}

/// Delete the file moved aside at `path` for a clear, tried DELETE_TRIES
/// times; a folder bearing the name is left alone, and one already gone is
/// deleted. The error of the last try when it is still there.
fn delete_copy(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
        return Ok(());
    }
    let mut tries = 0;
    loop {
        match remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                tries += 1;
                if tries >= DELETE_TRIES {
                    return Err(e);
                }
                std::thread::sleep(DELETE_PAUSE);
            }
        }
    }
}

/// Why a clear fails that emptied the history but could not delete `left`
/// of the files moved aside. No path or time in it: the log has those.
fn copies_left(left: usize) -> String {
    let copies = if left == 1 { "1 damaged copy of it".to_string() } else { format!("{left} damaged copies of it") };
    format!(
        "{COPIES_LEFT} {copies} kept aside could not be deleted. Try again; or delete \
         {FILE}{BAD_SUFFIX}* in NexTerm's data folder"
    )
}

/// `fs::rename`, tried RENAME_TRIES times RENAME_PAUSE apart: on Windows a
/// rename fails while another program holds the file open without
/// FILE_SHARE_DELETE (a scanner or an indexer, briefly); unix renames
/// atomically or not at all, and tries once.
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                tries += 1;
                if tries >= RENAME_TRIES {
                    return Err(e);
                }
                std::thread::sleep(RENAME_PAUSE);
            }
        }
    }
}

/// Remove every temporary file a crash left. Safe under LOCK_FILE: no other
/// operation, in this process or another, has one open meanwhile.
fn sweep_temps(base: &Path) {
    for (_, path) in names_in(base, is_our_temp) {
        remove_ours(&path, "the leftover temporary file");
    }
}

/// Remove all but the KEEP_BAD newest files moved aside.
fn keep_newest_bad(base: &Path) {
    let mut bad: Vec<(u64, PathBuf)> = names_in(base, |name| bad_ms(name).is_some())
        .into_iter()
        .filter_map(|(name, path)| Some((bad_ms(&name)?, path)))
        .collect();
    bad.sort();
    let excess = bad.len().saturating_sub(KEEP_BAD);
    for (_, path) in bad.into_iter().take(excess) {
        remove_ours(&path, "an old unreadable agent session history");
    }
}

/// A new, empty file in `base` that nothing else has: `create_new`, so a
/// name that is taken is passed over rather than written through, link or
/// not. On unix for the owner alone, which the rename keeps.
fn new_temp(base: &Path) -> Result<(PathBuf, fs::File), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    for _ in 0..100 {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = base.join(format!("{TEMP_PREFIX}{}-{n}.tmp", std::process::id()));
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(not_saved(e)),
        }
    }
    Err("The agent session history could not be saved: no free temporary name".to_string())
}

fn not_saved(e: impl std::fmt::Display) -> String {
    format!("The agent session history could not be saved: {e}")
}

/// The file's text for `entries`: pretty-printed, two spaces, ending in a
/// line end — byte for byte what the browser mock's `JSON.stringify(…, null,
/// 2)` makes of the same entries, which the contract test checks.
fn document_text(entries: &[Entry]) -> Result<String, String> {
    let mut text = serde_json::to_string_pretty(&Document { version: VERSION, entries }).map_err(not_saved)?;
    text.push('\n');
    Ok(text)
}

/// The file's text for `entries`, after dropping the least recently used —
/// never `written` — until it is within MAX_READ_BYTES: a file this module
/// would refuse to read is never written. Only entries whose folders and
/// titles are near their caps come near it; for those the fewest to drop is
/// found by halving, as the text only shrinks with each one dropped.
fn fitted_text(entries: &mut Vec<Entry>, written: Option<&str>) -> Result<String, String> {
    let text = document_text(entries)?;
    let fits = |text: &str| text.len() as u64 <= MAX_READ_BYTES;
    // The positions that may go, the least recently used first.
    let droppable: Vec<usize> =
        (0..entries.len()).rev().filter(|&at| Some(entries[at].key.as_str()) != written).collect();
    if fits(&text) || droppable.is_empty() {
        return Ok(text);
    }
    let without = |n: usize| -> Vec<Entry> {
        let gone = &droppable[..n];
        entries.iter().enumerate().filter(|(at, _)| !gone.contains(at)).map(|(_, e)| e.clone()).collect()
    };
    // One more than fits is what a full history meets at every write after
    // the first that reached the cap: tried first. All of them dropped
    // leaves `written` alone, or nothing, and that fits.
    let (mut low, mut high) = (1, droppable.len());
    if fits(&document_text(&without(1))?) {
        high = 1;
    }
    while low < high {
        let middle = (low + high) / 2;
        if fits(&document_text(&without(middle))?) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    *entries = without(low);
    document_text(entries)
}

/// Replace the file in `base` with `text`, or leave it as it was.
fn write(base: &Path, text: &str) -> Result<(), String> {
    let (temp, mut file) = new_temp(base)?;
    let written = file.write_all(text.as_bytes());
    // Closed before the rename: Windows renames an open file only when every
    // handle on it allows it.
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(not_saved(e));
    }
    // std::fs::rename replaces `to` on every platform: rename(2) on unix; on
    // Windows a replacing rename, tried again a few times
    // (`rename_retrying`), then this write fails and the old file stays.
    rename_retrying(&temp, &base.join(FILE)).map_err(|e| {
        let _ = fs::remove_file(&temp);
        not_saved(e)
    })
}

/// A new, empty history in `base`.
fn start_empty(base: &Path) -> Result<Stored, String> {
    write(base, &document_text(&[])?)?;
    Ok(Stored::Current(Vec::new()))
}

/// Move the unreadable file in `base` aside, keep the newest KEEP_BAD such,
/// and start a new history. Its bytes are kept as they were: it is renamed,
/// not copied. When it cannot be moved, nothing is written over it.
///
/// Named after the time, and always after every name already there: a name
/// that `keep_newest_bad` freed must not be taken again within the same
/// millisecond, or the newest file would sort as the oldest and go next.
/// A name more than a day ahead of the clock (BAD_AHEAD_MS) is passed over
/// for that: put there by hand, or by a clock since set back, it would push
/// every later name out with it — to the end of time, and past it.
fn set_aside(base: &Path, why: &str) -> Result<Stored, String> {
    let now = now_ms();
    let after_the_last = names_in(base, |name| bad_ms(name).is_some())
        .iter()
        .filter_map(|(name, _)| bad_ms(name))
        .filter(|&ms| ms <= now.saturating_add(BAD_AHEAD_MS))
        .max()
        .map_or(0, |last| last.saturating_add(1));
    let mut at = Some(now.max(after_the_last));
    let mut aside = None;
    for _ in 0..1000 {
        // Never a name `bad_ms` would not know for ours.
        let Some(ms) = at.filter(|&ms| ms <= MAX_INTEGER) else { break };
        let name = format!("{FILE}{BAD_SUFFIX}{ms}");
        match fs::symlink_metadata(base.join(&name)) {
            Err(e) if e.kind() == ErrorKind::NotFound => {
                aside = Some(name);
                break;
            }
            _ => at = ms.checked_add(1),
        }
    }
    let unreadable = format!("The agent session history could not be read ({why})");
    let Some(aside) = aside else {
        return Err(format!("{unreadable}, and there is no free name to move it aside to"));
    };
    rename_retrying(&base.join(FILE), &base.join(&aside))
        .map_err(|e| format!("{unreadable}, and could not be moved aside: {e}"))?;
    log(&format!("{unreadable}; it was moved aside to {aside}, and a new one was started"));
    keep_newest_bad(base);
    start_empty(base)
}

/// The history in `base`, made when it is not there and started again when
/// it cannot be read (see the module's doc).
fn load(base: &Path) -> Result<Stored, String> {
    let path = base.join(FILE);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return start_empty(base),
        Err(e) => return Err(format!("{} could not be looked at: {e}", path.display())),
    };
    if is_link(&meta) {
        return Err(link_refusal(&path));
    }
    if !meta.is_file() {
        return set_aside(base, "it is not a regular file");
    }
    // Not following a link, and asked of the open handle: a file swapped for
    // a link or a FIFO since the look is refused all the same, and one that
    // grows while it is read is read no further than the cap.
    let bytes = match read_small_file(&path, false, MAX_READ_BYTES) {
        Ok(bytes) => bytes,
        Err(SmallFileError::NotFound) => return start_empty(base),
        Err(SmallFileError::NotAFile) => return Err(format!("{} is not a regular file", path.display())),
        Err(SmallFileError::TooLarge) => return set_aside(base, &format!("it is larger than {MAX_READ_BYTES} bytes")),
        Err(SmallFileError::Io(e)) => return Err(format!("{} could not be read: {e}", path.display())),
    };
    match parse(&bytes) {
        Parsed::Unreadable(why) => set_aside(base, why),
        Parsed::Read { version: VERSION, entries } => Ok(Stored::Current(entries)),
        Parsed::Read { version, entries } => Ok(Stored::Newer { version, entries }),
    }
}

/// The entries of `stored` to change and write back, or the refusal of a
/// newer file — said in the log once per folder for the life of the process.
fn writable(base: &Path, stored: Stored) -> Result<Vec<Entry>, String> {
    match stored {
        Stored::Current(entries) => Ok(entries),
        Stored::Newer { version, .. } => {
            let why = format!("{NEWER_VERSION} (format version {version}); this one reads it and changes nothing in it");
            let mut said = NEWER_SAID.lock();
            if !said.iter().any(|folder| folder == base) {
                said.push(base.to_path_buf());
                log(&why);
            }
            Err(why)
        }
    }
}

/// Run `work` on the history in `base` under both locks. See the module's doc.
fn with_history<T>(base: &Path, work: impl FnOnce(Stored) -> Result<T, String>) -> Result<T, String> {
    let _one_at_a_time = LOCK.lock();
    folder(base)?;
    let _held = lock_file(base)?;
    sweep_temps(base);
    work(load(base)?)
}

// ---- The operations -----------------------------------------------------------------

/// Every entry kept in `base`, the app's local data folder, newest first —
/// the kinds this build does not know included. Makes the file when it is not
/// there. A newer file's entries are read and the file is left as it is.
pub fn list(base: &Path) -> Result<Vec<Entry>, String> {
    with_history(base, |stored| {
        Ok(match stored {
            Stored::Current(entries) | Stored::Newer { entries, .. } => entries,
        })
    })
}

/// Record `entry` (the page's, in the file's shape; any `key` it has is not
/// read) merged into the one with its key, and into it the provisional entry
/// `replaces` names — only one with no session id, of the same kind, and not
/// the new key itself; any other name is passed over. Then keep CAP, and
/// MAX_READ_BYTES (`fitted_text`). The entry as kept.
///
/// Refused with INVALID, before the disk is touched, for an entry that is not
/// valid; with NEWER_VERSION for a newer file.
pub fn upsert(base: &Path, entry: &Value, replaces: Option<&str>) -> Result<Entry, String> {
    let incoming = entry_from(entry).map_err(|why| format!("{INVALID}: {why}"))?;
    with_history(base, |stored| {
        let mut entries = writable(base, stored)?;
        let mut others = Vec::new();
        if let Some(at) = entries.iter().position(|e| e.key == incoming.key) {
            others.push(entries.remove(at));
        }
        if let Some(old) = replaces.filter(|old| *old != incoming.key) {
            if let Some(at) = entries
                .iter()
                .position(|e| e.key == old && e.session_id.is_none() && e.kind == incoming.kind)
            {
                others.push(entries.remove(at));
            }
        }
        let merged = merge(incoming, others);
        entries.insert(0, merged.clone());
        sort_newest_first(&mut entries);
        keep_cap(&mut entries, &merged.key);
        write(base, &fitted_text(&mut entries, Some(&merged.key))?)?;
        Ok(merged)
    })
}

/// Delete the entry under `key`. Whether there was one.
pub fn remove(base: &Path, key: &str) -> Result<bool, String> {
    with_history(base, |stored| {
        let mut entries = writable(base, stored)?;
        let Some(at) = entries.iter().position(|e| e.key == key) else {
            return Ok(false);
        };
        entries.remove(at);
        write(base, &fitted_text(&mut entries, None)?)?;
        Ok(true)
    })
}

/// Empty the history, every kind's entries included, and delete the files
/// moved aside: they are copies of what it held, titles and folders and all,
/// and a history the user cleared keeps no copies. How many entries went —
/// the entries of the file that was read, not of those copies. A refused
/// clear (a newer file) touches neither.
///
/// A copy that cannot be deleted, after DELETE_TRIES, fails the clear with
/// COPIES_LEFT (`copies_left`) once every other one has gone: the history is
/// empty, but it is not cleared as the user asked, and the page says so.
pub fn clear(base: &Path) -> Result<u32, String> {
    with_history(base, |stored| {
        let entries = writable(base, stored)?;
        write(base, &document_text(&[])?)?;
        let mut left = 0;
        for (_, path) in names_in(base, |name| bad_ms(name).is_some()) {
            if let Err(e) = delete_copy(&path) {
                log(&format!("Could not delete an unreadable agent session history {}: {e}", path.display()));
                left += 1;
            }
        }
        if left > 0 {
            return Err(copies_left(left));
        }
        Ok(u32::try_from(entries.len()).unwrap_or(u32::MAX))
    })
}

/// `fs::remove_file`, or in the tests the refusal of a file another program
/// holds open (`tests::HELD_OPEN`), as Windows refuses one a scanner has.
///
/// The last item that is not a test, on purpose: nothing but tests may
/// follow a file's first `#[cfg(test)]` (src/fs/git.rs
/// `nothing_but_tests_follows_the_first_cfg_test`), and the one here is
/// inside this function.
fn remove_file(path: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if tests::HELD_OPEN.lock().iter().any(|held| held == path) {
        return Err(std::io::Error::new(ErrorKind::PermissionDenied, "another program has it open"));
    }
    fs::remove_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Files the tests say another program holds open: deleting one fails,
    /// as it does on Windows while a scanner has it (`delete_copy`).
    pub(super) static HELD_OPEN: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

    /// A folder of its own for one test, removed when the test ends. cargo
    /// runs tests in parallel, so every test has its own tag.
    pub(super) struct Scratch(PathBuf);

    impl Scratch {
        pub(super) fn new(tag: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("nexterm-agent-history-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dunce::canonicalize(&dir).unwrap())
        }

        /// The app's local data folder, as Tauri hands it in: not made yet.
        pub(super) fn base(&self) -> PathBuf {
            self.0.join("com.nexterm.ide")
        }

        pub(super) fn file(&self) -> PathBuf {
            self.base().join(FILE)
        }

        /// The files moved aside, oldest first, with their bytes.
        pub(super) fn bad(&self) -> Vec<Vec<u8>> {
            let mut bad: Vec<(u64, PathBuf)> = names_in(&self.base(), |name| bad_ms(name).is_some())
                .into_iter()
                .map(|(name, path)| (bad_ms(&name).unwrap(), path))
                .collect();
            bad.sort();
            bad.into_iter().map(|(_, path)| fs::read(path).unwrap()).collect()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            NEWER_SAID.lock().retain(|folder| *folder != self.base());
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const CLAUDE_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const CLAUDE_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const OPENCODE_A: &str = "ses_ef45006f5ffeAMtumN5ySj4VmT";

    pub(super) fn entry(kind: &str, id: Option<&str>, cwd: &str, title: Option<&str>, started: u64, used: u64) -> Value {
        json!({
            "kind": kind, "sessionId": id, "cwd": cwd, "title": title,
            "startedAt": started, "lastUsedAt": used, "endedAt": null, "endReason": null,
        })
    }

    fn document(scratch: &Scratch) -> Value {
        serde_json::from_slice(&fs::read(scratch.file()).unwrap()).unwrap()
    }

    fn keys(entries: &[Entry]) -> Vec<String> {
        entries.iter().map(|e| e.key.clone()).collect()
    }

    // ---- AC1: made at the first operation --------------------------------------

    #[test]
    fn the_first_list_makes_an_empty_history() {
        let scratch = Scratch::new("first-list");
        assert!(!scratch.base().exists(), "premise: not even the folder is there");
        assert_eq!(list(&scratch.base()).unwrap(), Vec::<Entry>::new());
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(scratch.file()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the file is the owner's alone");
        }
        assert!(scratch.bad().is_empty());
    }

    // ---- AC2: made again after it was deleted ----------------------------------

    #[test]
    fn a_deleted_file_is_made_again_holding_only_what_came_after() {
        let scratch = Scratch::new("deleted");
        let base = scratch.base();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).unwrap();
        fs::remove_file(scratch.file()).unwrap();
        upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 2, 2), None).unwrap();
        assert_eq!(keys(&list(&base).unwrap()), vec![format!("claude:{CLAUDE_B}")], "the deleted history stays deleted");

        fs::remove_file(scratch.file()).unwrap();
        assert!(list(&base).unwrap().is_empty());
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}));

        fs::remove_file(scratch.file()).unwrap();
        assert!(!remove(&base, "claude:x").unwrap());
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}), "remove makes it again too");
        fs::remove_file(scratch.file()).unwrap();
        assert_eq!(clear(&base).unwrap(), 0);
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}), "and clear");
        assert!(scratch.bad().is_empty(), "a missing file is not an unreadable one");
    }

    // ---- AC3: unreadable files ---------------------------------------------------

    #[test]
    fn an_unreadable_file_is_moved_aside_byte_for_byte() {
        let mut too_large = br#"{"version":1,"entries":[]}"#.to_vec();
        too_large.resize(MAX_READ_BYTES as usize + 1, b' ');
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("invalid JSON", b"{version: 1, entries: []}".to_vec()),
            ("truncated", br#"{"version":1,"entries":[{"kind":"claude","sessionId":"0f8f"#.to_vec()),
            ("a top-level array", br#"[{"version":1}]"#.to_vec()),
            ("not UTF-8", b"{\"version\":1,\"entries\":[],\"x\":\"\xff\xfe\"}".to_vec()),
            ("over 1 MiB, though valid JSON", too_large),
            ("no version", br#"{"entries":[]}"#.to_vec()),
            ("no entries", br#"{"version":1}"#.to_vec()),
            ("empty", Vec::new()),
        ];
        for (what, bytes) in cases {
            let scratch = Scratch::new(&format!("unreadable-{}", what.replace(' ', "-")));
            let base = scratch.base();
            fs::create_dir_all(&base).unwrap();
            fs::write(scratch.file(), &bytes).unwrap();
            assert_eq!(list(&base).unwrap(), Vec::<Entry>::new(), "{what}: the list is empty");
            assert_eq!(scratch.bad(), vec![bytes.clone()], "{what}: its bytes are kept as they were");
            assert_eq!(document(&scratch), json!({"version": 1, "entries": []}), "{what}: a new history");
            // And the history works on from there.
            upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).unwrap();
            assert_eq!(list(&base).unwrap().len(), 1, "{what}");
            assert_eq!(scratch.bad().len(), 1, "{what}: nothing else was moved aside");
        }
    }

    #[test]
    fn only_the_three_newest_unreadable_files_are_kept() {
        let scratch = Scratch::new("keep-three");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let mut written = Vec::new();
        for n in 0..5 {
            let bytes = format!("garbage {n}").into_bytes();
            fs::write(scratch.file(), &bytes).unwrap();
            assert!(list(&base).unwrap().is_empty());
            written.push(bytes);
        }
        assert_eq!(scratch.bad(), written[2..].to_vec(), "the newest three, oldest first");
    }

    #[test]
    fn an_invalid_entry_is_dropped_and_the_rest_of_the_file_is_kept() {
        let scratch = Scratch::new("invalid-entry");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let file = json!({"version": 1, "entries": [
            entry("claude", Some(CLAUDE_A), "/w", None, 1, 5),
            entry("claude", Some("x; curl a | sh"), "/w", None, 1, 9),
            entry("opencode", Some(OPENCODE_A), "/w", Some("Fix the build"), 1, 3),
        ]});
        fs::write(scratch.file(), serde_json::to_vec(&file).unwrap()).unwrap();
        assert_eq!(
            keys(&list(&base).unwrap()),
            vec![format!("claude:{CLAUDE_A}"), format!("opencode:{OPENCODE_A}")]
        );
        assert!(scratch.bad().is_empty(), "the file is not moved aside for one entry");
        assert_eq!(document(&scratch), file, "nor rewritten by a list");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_in_the_files_place_is_moved_aside_without_waiting() {
        let scratch = Scratch::new("fifo");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let path = std::ffi::CString::new(scratch.file().to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path; mkfifo only reads it.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(list(&base).unwrap().is_empty());
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}));
        assert_eq!(names_in(&base, |name| bad_ms(name).is_some()).len(), 1);
    }

    // ---- AC4: a newer format -------------------------------------------------------

    #[test]
    fn a_newer_file_is_read_and_never_written() {
        let scratch = Scratch::new("newer");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let bytes = serde_json::to_vec(&json!({"version": 2, "entries": [
            entry("claude", Some(CLAUDE_A), "/w", None, 1, 5),
            {"kind": "claude", "shape": "of version 2"},
        ], "more": true}))
        .unwrap();
        fs::write(scratch.file(), &bytes).unwrap();

        assert_eq!(keys(&list(&base).unwrap()), vec![format!("claude:{CLAUDE_A}")], "what it can read");
        assert_eq!(fs::read(scratch.file()).unwrap(), bytes, "untouched by a list");

        let refused = upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 1, 1), None).unwrap_err();
        assert!(refused.starts_with(NEWER_VERSION), "{refused}");
        assert!(refused.contains("format version 2"), "{refused}");
        assert!(remove(&base, &format!("claude:{CLAUDE_A}")).unwrap_err().starts_with(NEWER_VERSION));
        assert!(clear(&base).unwrap_err().starts_with(NEWER_VERSION));
        assert_eq!(fs::read(scratch.file()).unwrap(), bytes, "byte for byte after refused writes");
        assert!(scratch.bad().is_empty(), "and never moved aside");
        assert_eq!(
            NEWER_SAID.lock().iter().filter(|folder| **folder == base).count(),
            1,
            "said once, not at every write"
        );
    }

    // ---- AC5: the cap ------------------------------------------------------------------

    #[test]
    fn the_newest_two_hundred_are_kept() {
        let scratch = Scratch::new("cap");
        let base = scratch.base();
        for n in 1..=205u64 {
            let id = format!("ses_cap{n:05}");
            upsert(&base, &entry("opencode", Some(&id), "/w", None, n, 1000 + n), None).unwrap();
        }
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), CAP);
        assert_eq!(kept[0].key, "opencode:ses_cap00205");
        assert_eq!(kept[CAP - 1].key, "opencode:ses_cap00006", "the five oldest went");
        assert_eq!(document(&scratch)["entries"].as_array().unwrap().len(), CAP, "in the file too");

        // Older than every other, and kept all the same: it is the one just written.
        let old = upsert(&base, &entry("opencode", Some("ses_oldest00"), "/w", None, 0, 1), None).unwrap();
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), CAP);
        assert_eq!(kept[CAP - 1], old);
        assert!(!keys(&kept).contains(&"opencode:ses_cap00006".to_string()), "the oldest other one went");
        assert!(keys(&kept).contains(&"opencode:ses_cap00007".to_string()));
    }

    #[test]
    fn a_history_is_never_written_larger_than_it_may_be_read() {
        let scratch = Scratch::new("fit");
        let base = scratch.base();
        // Folders at their cap, with no id: each is in the key a second time.
        let folder = |n: u64| format!("/{n:04}{}", "d".repeat(MAX_CWD_BYTES - 5));
        let title = "\u{1f600}".repeat(MAX_TITLE_CHARS);
        let written = 120;
        for n in 1..=written {
            upsert(&base, &entry("opencode", None, &folder(n), Some(&title), n, 1000 + n), None).unwrap();
        }
        let size = fs::metadata(scratch.file()).unwrap().len();
        assert!(size <= MAX_READ_BYTES, "{size} bytes written");
        let kept = list(&base).unwrap();
        assert!(scratch.bad().is_empty(), "read back, not moved aside");
        assert!(kept.len() < written as usize && kept.len() > 50, "{} kept", kept.len());
        assert_eq!(kept[0].cwd, folder(written), "the newest are the ones kept");
        let last = kept.len() as u64;
        assert_eq!(kept[kept.len() - 1].cwd, folder(written - last + 1), "and the fewest were dropped");
        // One more would not have fitted: the fewest were dropped.
        let mut one_more: Vec<Entry> = kept.clone();
        let next = entry_from(&entry("opencode", None, &folder(written - last), Some(&title), written - last, 1000 + written - last)).unwrap();
        one_more.push(next);
        assert!(document_text(&one_more).unwrap().len() as u64 > MAX_READ_BYTES);
        // Older than all, written all the same.
        let old = upsert(&base, &entry("opencode", None, &folder(0), Some(&title), 0, 1), None).unwrap();
        assert_eq!(list(&base).unwrap().last(), Some(&old));
        assert!(fs::metadata(scratch.file()).unwrap().len() <= MAX_READ_BYTES);
    }

    // ---- AC6: one entry per conversation -------------------------------------------------

    #[test]
    fn two_writes_of_one_conversation_are_one_entry() {
        let scratch = Scratch::new("dedupe");
        let base = scratch.base();
        upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("First"), 100, 200), None).unwrap();
        let merged = upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", None, 150, 300), None).unwrap();
        assert_eq!(merged.started_at, 100, "the earliest start");
        assert_eq!(merged.last_used_at, 300, "the latest use");
        assert_eq!(merged.title.as_deref(), Some("First"), "the latest title there is");
        let renamed = upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Second"), 400, 400), None).unwrap();
        assert_eq!(renamed.title.as_deref(), Some("Second"));
        assert_eq!(renamed.started_at, 100);
        // A write that arrives late — used before the last one — changes no title or end.
        let late = upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Stale"), 50, 350), None).unwrap();
        assert_eq!((late.title.as_deref(), late.started_at, late.last_used_at), (Some("Second"), 50, 400));
        assert_eq!(list(&base).unwrap().len(), 1);
    }

    #[test]
    fn an_end_comes_from_the_newest_event() {
        let scratch = Scratch::new("ended");
        let base = scratch.base();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 10), None).unwrap();
        let mut ended = entry("claude", Some(CLAUDE_A), "/w", None, 1, 20);
        ended["endedAt"] = json!(20);
        ended["endReason"] = json!("exited");
        let kept = upsert(&base, &ended, None).unwrap();
        assert_eq!((kept.ended_at, kept.end_reason), (Some(20), Some(EndReason::Exited)));
        // Resumed: running again.
        let resumed = upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 30, 30), None).unwrap();
        assert_eq!((resumed.ended_at, resumed.end_reason, resumed.started_at), (None, None, 1));
        assert_eq!(serde_json::to_value(&kept).unwrap()["endReason"], json!("exited"));
    }

    #[test]
    fn an_entry_that_learns_its_id_replaces_its_provisional_one() {
        let scratch = Scratch::new("replaces");
        let base = scratch.base();
        let provisional = upsert(&base, &entry("opencode", None, "/w", None, 100, 100), None).unwrap();
        assert_eq!(provisional.key, "opencode:~/w\u{0}");
        let titled = upsert(&base, &entry("opencode", None, "/w", Some("Fix it"), 100, 150), Some(&provisional.key)).unwrap();
        assert_eq!(titled.key, "opencode:~/w\u{0}Fix it");
        assert_eq!(keys(&list(&base).unwrap()), vec![titled.key.clone()], "re-keyed, not doubled");

        // The id entry is there already, from an earlier run.
        upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 50, 60), None).unwrap();
        let learned = upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 100, 200), Some(&titled.key)).unwrap();
        assert_eq!(keys(&list(&base).unwrap()), vec![format!("opencode:{OPENCODE_A}")]);
        assert_eq!((learned.started_at, learned.last_used_at), (50, 200));
    }

    #[test]
    fn replaces_never_takes_a_conversation_with_an_id_or_of_another_kind() {
        let scratch = Scratch::new("replaces-refused");
        let base = scratch.base();
        let claude = upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).unwrap();
        let claude_latest = upsert(&base, &entry("claude", None, "/w", None, 1, 2), None).unwrap();
        upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", None, 3, 3), Some(&claude.key)).unwrap();
        upsert(&base, &entry("opencode", None, "/x", None, 4, 4), Some(&claude_latest.key)).unwrap();
        let mut kept = keys(&list(&base).unwrap());
        kept.sort();
        let mut expected = vec![claude.key, claude_latest.key, format!("opencode:{OPENCODE_A}"), "opencode:~/x\u{0}".to_string()];
        expected.sort();
        assert_eq!(kept, expected);
    }

    // ---- What is refused ------------------------------------------------------------------

    #[test]
    fn session_ids_have_their_kinds_shape_only() {
        // agents.js:83 and :92.
        assert!(is_session_id_for("claude", CLAUDE_A));
        for bad in [
            "0F8FAD5B-D9CB-469F-A165-70867728950E",    // uppercase
            "0f8fad5b-d9cb-169f-a165-70867728950e",    // v1
            "0f8fad5b-d9cb-469f-c165-70867728950e",    // not the RFC variant
            "0f8fad5b-d9cb-469f-a165-70867728950e\n",  // a line end
            "0f8fad5b-d9cb-469f-a165-70867728950",     // short
            "x; curl a | sh",
            "",
        ] {
            assert!(!is_session_id_for("claude", bad), "{bad:?}");
        }
        assert!(is_session_id_for("opencode", OPENCODE_A));
        assert!(is_session_id_for("opencode", "ses_12345678"));
        let longest = format!("ses_{}", "a".repeat(64));
        let too_long = format!("ses_{}", "a".repeat(65));
        assert!(is_session_id_for("opencode", &longest));
        for bad in ["ses_1234567", "ses_abc-defgh", "SES_12345678", "ses_é2345678", "ses_12345678\n", too_long.as_str()] {
            assert!(!is_session_id_for("opencode", bad), "{bad:?}");
        }
        assert!(is_session_id_for("agy", "anything-1 of a line"));
        assert!(!is_session_id_for("agy", "two\nlines"));
        assert!(!is_session_id_for("agy", &"a".repeat(129)));
    }

    /// Every entry `entry_from` refuses, and why: each field's rule, at its
    /// bounds and with the wrong type, and every character class
    /// `refused_char` names. Run here, and replayed against the browser mock
    /// by the contract (`contract_tests`), as written and inside a file.
    pub(super) fn refused_cases() -> Vec<(Value, String)> {
        let good = entry("claude", Some(CLAUDE_A), "/w", None, 1, 1);
        let with = |base: &Value, field: &str, value: Value| {
            let mut e = base.clone();
            e[field] = value;
            e
        };
        let opencode = entry("opencode", None, "/w", Some("T"), 1, 1);
        let other = entry("agy", Some("agy-1"), "/w", None, 1, 1);
        let kind = "its kind is not an agent's name";
        let claude_id = "its session id is not one that claude gives a conversation";
        let opencode_id = "its session id is not one that opencode gives a conversation";
        let other_id = "its session id is not one that agy gives a conversation";
        let folder = "its folder is not an absolute path";
        let title = "its title is not one line of at most 200 characters";
        let mut cases: Vec<(Value, &str)> = vec![
            (json!(["not", "an", "object"]), "it is not an object"),
            (json!("an entry"), "it is not an object"),
            (json!(7), "it is not an object"),
            (with(&good, "kind", json!("Claude")), kind),
            (with(&good, "kind", json!(format!("a{}", "b".repeat(32)))), kind),
            (with(&good, "kind", json!("")), kind),
            (with(&good, "kind", json!("-claude")), kind),
            (with(&good, "kind", json!("cläude")), kind),
            (with(&good, "kind", json!(1)), kind),
            (with(&good, "kind", json!(null)), kind),
            (with(&good, "sessionId", json!("x; curl a | sh")), claude_id),
            (with(&good, "sessionId", json!(7)), claude_id),
            (with(&good, "sessionId", json!(true)), claude_id),
            (with(&good, "sessionId", json!(CLAUDE_A.to_uppercase())), claude_id),
            (with(&good, "sessionId", json!(OPENCODE_A)), claude_id),
            (with(&opencode, "sessionId", json!("ses_1234567")), opencode_id),
            (with(&opencode, "sessionId", json!(format!("ses_{}", "a".repeat(65)))), opencode_id),
            (with(&opencode, "sessionId", json!("ses_abc-defgh")), opencode_id),
            (with(&opencode, "sessionId", json!(CLAUDE_A)), opencode_id),
            (with(&other, "sessionId", json!("a".repeat(MAX_OTHER_ID_CHARS + 1))), other_id),
            (with(&other, "sessionId", json!("")), other_id),
            (with(&other, "sessionId", json!(["agy-1"])), other_id),
            (with(&good, "cwd", json!("relative/path")), folder),
            (with(&good, "cwd", json!("")), folder),
            (with(&good, "cwd", json!("C:relative")), folder),
            (with(&good, "cwd", json!(format!("/{}", "a".repeat(MAX_CWD_BYTES)))), folder),
            (with(&good, "cwd", json!(format!("/{}", "é".repeat(MAX_CWD_BYTES / 2)))), folder),
            (with(&good, "cwd", json!(7)), folder),
            (with(&good, "cwd", json!(null)), folder),
            (with(&good, "title", json!("")), title),
            (with(&good, "title", json!("t".repeat(MAX_TITLE_CHARS + 1))), title),
            (with(&good, "title", json!("é".repeat(MAX_TITLE_CHARS + 1))), title),
            (with(&good, "title", json!(5)), title),
            (with(&good, "title", json!({"text": "T"})), title),
            (with(&good, "startedAt", json!(null)), "its startedAt is not a time"),
            (with(&good, "startedAt", json!(-1)), "its startedAt is not a time"),
            (with(&good, "startedAt", json!("1000")), "its startedAt is not a time"),
            (with(&good, "startedAt", json!(true)), "its startedAt is not a time"),
            (with(&good, "startedAt", json!(MAX_INTEGER + 1)), "its startedAt is not a time"),
            (with(&good, "lastUsedAt", json!(1.5)), "its lastUsedAt is not a time"),
            (with(&good, "lastUsedAt", json!(MAX_INTEGER + 1)), "its lastUsedAt is not a time"),
            (with(&good, "lastUsedAt", json!(u64::MAX)), "its lastUsedAt is not a time"),
            (with(&good, "lastUsedAt", json!(-5)), "its lastUsedAt is not a time"),
            (with(&good, "lastUsedAt", json!(null)), "its lastUsedAt is not a time"),
            (with(&good, "endedAt", json!("soon")), "its endedAt is not a time"),
            (with(&good, "endedAt", json!(MAX_INTEGER + 1)), "its endedAt is not a time"),
            (with(&good, "endReason", json!("killed")), "its endReason is neither exited nor closed"),
            (with(&good, "endReason", json!("Exited")), "its endReason is neither exited nor closed"),
            (with(&good, "endReason", json!(1)), "its endReason is neither exited nor closed"),
            (with(&good, "endedAt", json!(5)), "it has an endedAt without an endReason, or an endReason without an endedAt"),
            (with(&good, "endReason", json!("closed")), "it has an endedAt without an endReason, or an endReason without an endedAt"),
        ];
        // Every class of character refused in a folder, a title and the id
        // of a kind this build does not know: C0 (NUL, BEL, ESC, a line
        // end, TAB, US), DEL, C1 (its first, NEL, CSI, its last), the line
        // and paragraph separators, and the bidi embeddings, overrides and
        // isolates at both ends of each range.
        for c in [
            '\u{0}', '\u{7}', '\u{9}', '\u{a}', '\u{1b}', '\u{1f}', '\u{7f}', '\u{80}', '\u{85}', '\u{9b}', '\u{9f}',
            '\u{2028}', '\u{2029}', '\u{202a}', '\u{202c}', '\u{202e}', '\u{2066}', '\u{2068}', '\u{2069}',
        ] {
            cases.push((with(&good, "cwd", json!(format!("/w{c}x"))), folder));
            cases.push((with(&good, "title", json!(format!("a{c}b"))), title));
            cases.push((with(&other, "sessionId", json!(format!("agy{c}1"))), other_id));
        }
        cases.into_iter().map(|(value, why)| (value, why.to_string())).collect()
    }

    #[test]
    fn an_invalid_entry_is_refused_before_the_disk_is_touched() {
        let scratch = Scratch::new("refused");
        let base = scratch.base();
        let good = entry("claude", Some(CLAUDE_A), "/w", None, 1, 1);
        let with = |field: &str, value: Value| {
            let mut e = good.clone();
            e[field] = value;
            e
        };
        for (value, why) in refused_cases() {
            assert_eq!(upsert(&base, &value, None).unwrap_err(), format!("{INVALID}: {why}"), "{value}");
        }
        assert!(!base.exists(), "nothing was made for a refused write");
        // Just inside each bidi range and beside the refused classes: kept.
        for c in ['\u{20}', '\u{a0}', '\u{2027}', '\u{202f}', '\u{2065}', '\u{206a}'] {
            assert!(entry_from(&with("title", json!(format!("a{c}b")))).is_ok(), "{c:?} is not refused");
        }
        // The bounds themselves are kept.
        let mut longest = with("title", json!("t".repeat(200)));
        longest["cwd"] = json!(format!("/{}", "a".repeat(MAX_CWD_BYTES - 1)));
        longest["lastUsedAt"] = json!(MAX_INTEGER);
        assert!(upsert(&base, &longest, None).is_ok());
        for cwd in ["C:\\Users\\me", "c:/x", "\\\\server\\share", "/"] {
            assert!(upsert(&base, &with("cwd", json!(cwd)), None).is_ok(), "{cwd}");
        }
    }

    #[test]
    fn the_key_is_made_here_and_fields_it_does_not_know_are_ignored() {
        let scratch = Scratch::new("key");
        let base = scratch.base();
        let mut given = entry("claude", Some(CLAUDE_A), "/w", None, 1, 1);
        given["key"] = json!("claude:something-else");
        given["future"] = json!({"nested": true});
        let kept = upsert(&base, &given, None).unwrap();
        assert_eq!(kept.key, format!("claude:{CLAUDE_A}"));
        assert!(document(&scratch)["entries"][0].get("future").is_none(), "not carried into the file");

        // In the file too: a key that does not fit is made again; of two
        // entries with one key the first is kept.
        fs::write(scratch.file(), serde_json::to_vec(&json!({"version": 1, "entries": [
            {"key": "wrong", "kind": "claude", "sessionId": CLAUDE_B, "cwd": "/a", "startedAt": 1, "lastUsedAt": 1},
            {"kind": "claude", "sessionId": CLAUDE_B, "cwd": "/b", "startedAt": 2, "lastUsedAt": 2},
        ]})).unwrap())
        .unwrap();
        let kept = list(&base).unwrap();
        assert_eq!(keys(&kept), vec![format!("claude:{CLAUDE_B}")]);
        assert_eq!(kept[0].cwd, "/a");
        assert_eq!(kept[0].title, None, "a missing nullable field is null");
    }

    // ---- AC7: links --------------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_files_place_refuses_everything() {
        let scratch = Scratch::new("link");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let target = scratch.0.join("elsewhere.json");
        let before = br#"{"version":1,"entries":[]}"#;
        fs::write(&target, before).unwrap();
        std::os::unix::fs::symlink(&target, scratch.file()).unwrap();

        for refused in [
            list(&base).map(drop),
            upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).map(drop),
            remove(&base, "claude:x").map(drop),
            clear(&base).map(drop),
        ] {
            let why = refused.unwrap_err();
            assert!(why.contains("is a link"), "{why}");
        }
        assert_eq!(fs::read(&target).unwrap(), before, "the link's target is unchanged");
        assert!(fs::symlink_metadata(scratch.file()).unwrap().file_type().is_symlink(), "and the link is still a link");
        assert!(scratch.bad().is_empty(), "nor moved aside");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_or_lock_file_refuses_everything() {
        let scratch = Scratch::new("linked-folder");
        let real = scratch.0.join("real");
        fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, scratch.base()).unwrap();
        assert!(list(&scratch.base()).unwrap_err().contains("is a link"));
        assert!(fs::read_dir(&real).unwrap().next().is_none(), "nothing was made through it");

        let scratch = Scratch::new("linked-lock");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let target = scratch.0.join("lock-target");
        fs::write(&target, b"").unwrap();
        std::os::unix::fs::symlink(&target, base.join(LOCK_FILE)).unwrap();
        assert!(list(&base).unwrap_err().contains("is a link"));
        assert!(!scratch.file().exists());
    }

    // ---- AC18: remove and clear ------------------------------------------------------------------

    #[test]
    fn remove_deletes_exactly_one_and_clear_all() {
        let scratch = Scratch::new("remove");
        let base = scratch.base();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).unwrap();
        upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 2, 2), None).unwrap();
        upsert(&base, &entry("agy", Some("agy-1"), "/w", None, 3, 3), None).unwrap();
        assert!(remove(&base, &format!("claude:{CLAUDE_A}")).unwrap());
        assert!(!remove(&base, &format!("claude:{CLAUDE_A}")).unwrap(), "gone already");
        assert_eq!(keys(&list(&base).unwrap()), vec!["agy:agy-1".to_string(), format!("claude:{CLAUDE_B}")]);
        assert_eq!(clear(&base).unwrap(), 2, "every kind's");
        assert!(list(&base).unwrap().is_empty());
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}));
        assert_eq!(clear(&base).unwrap(), 0);
    }

    #[test]
    fn clear_deletes_the_files_moved_aside_too() {
        let scratch = Scratch::new("clear-asides");
        let base = scratch.base();
        for garbage in ["{not json", "[1]"] {
            upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", Some("deploy key"), 1, 1), None).unwrap();
            fs::write(scratch.file(), garbage).unwrap();
            assert!(list(&base).unwrap().is_empty());
        }
        assert_eq!(scratch.bad().len(), 2, "premise: two files moved aside");
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 2, 2), None).unwrap();
        upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Kept"), 3, 3), None).unwrap();
        // Something else in the folder that only looks like ours is left alone.
        fs::create_dir(base.join(format!("{FILE}{BAD_SUFFIX}7"))).unwrap();
        fs::write(base.join(format!("{FILE}{BAD_SUFFIX}x")), "not ours").unwrap();

        assert_eq!(clear(&base).unwrap(), 2, "the entries of the history, not of its copies");
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}));
        assert!(base.join(format!("{FILE}{BAD_SUFFIX}7")).is_dir(), "a folder is never deleted");
        assert!(base.join(format!("{FILE}{BAD_SUFFIX}x")).is_file(), "nor a name that is not one of ours");
        fs::remove_dir(base.join(format!("{FILE}{BAD_SUFFIX}7"))).unwrap();
        assert!(scratch.bad().is_empty(), "no copy of the cleared history is left");

        // A file unreadable at the clear itself is moved aside and deleted with the rest.
        fs::write(scratch.file(), "garbage").unwrap();
        assert_eq!(clear(&base).unwrap(), 0);
        assert!(scratch.bad().is_empty());

        // A refused clear touches neither the newer file nor what was moved aside.
        fs::write(scratch.file(), "garbage").unwrap();
        assert!(list(&base).unwrap().is_empty());
        let newer = br#"{"version":2,"entries":[]}"#;
        fs::write(scratch.file(), newer).unwrap();
        assert!(clear(&base).unwrap_err().starts_with(NEWER_VERSION));
        assert_eq!(fs::read(scratch.file()).unwrap(), newer.to_vec());
        assert_eq!(scratch.bad(), vec![b"garbage".to_vec()]);
    }

    /// Found in review: a copy that could not be deleted was only logged, and
    /// the clear reported a history cleared that still had a copy.
    #[test]
    fn a_clear_that_cannot_delete_a_copy_says_so() {
        let scratch = Scratch::new("clear-held");
        let base = scratch.base();
        for garbage in ["{not json", "[1]"] {
            upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", Some("deploy key"), 1, 1), None).unwrap();
            fs::write(scratch.file(), garbage).unwrap();
            assert!(list(&base).unwrap().is_empty());
        }
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 2, 2), None).unwrap();
        let mut copies = names_in(&base, |name| bad_ms(name).is_some());
        copies.sort();
        assert_eq!(copies.len(), 2, "premise: two files moved aside");
        let held = copies[0].1.clone();
        HELD_OPEN.lock().push(held.clone());

        let started = Instant::now();
        let refused = clear(&base).unwrap_err();
        HELD_OPEN.lock().retain(|path| *path != held);
        assert_eq!(refused, copies_left(1));
        assert!(refused.starts_with(COPIES_LEFT), "{refused}");
        assert!(started.elapsed() >= DELETE_PAUSE * (DELETE_TRIES - 1), "tried again before giving up");
        assert_eq!(document(&scratch), json!({"version": 1, "entries": []}), "emptied all the same");
        assert_eq!(scratch.bad(), vec![b"{not json".to_vec()], "the other copy went; the held one is left");
        assert!(copies_left(2).contains("2 damaged copies of it"));

        // Let go of, the next clear deletes it.
        assert_eq!(clear(&base).unwrap(), 0);
        assert!(scratch.bad().is_empty());
    }

    /// Found in review: a file planted as `agent-sessions.json.bad-<u64::MAX>`
    /// overflowed the name's time (a panic in a debug build, in a release one
    /// a wrap to 0 that made the newest copy sort as the oldest).
    #[test]
    fn a_name_at_the_end_of_time_neither_overflows_nor_decides_the_next() {
        let scratch = Scratch::new("bad-end-of-time");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let named = |ms: u64| base.join(format!("{FILE}{BAD_SUFFIX}{ms}"));
        assert_eq!(bad_ms(&format!("{FILE}{BAD_SUFFIX}{MAX_INTEGER}")), Some(MAX_INTEGER));
        assert_eq!(bad_ms(&format!("{FILE}{BAD_SUFFIX}{}", MAX_INTEGER + 1)), None, "past MAX_INTEGER: not ours");
        assert_eq!(bad_ms(&format!("{FILE}{BAD_SUFFIX}{}", u64::MAX)), None);

        let end_of_time = named(u64::MAX);
        let last_ours = named(MAX_INTEGER);
        let ahead = named(now_ms() + 10 * BAD_AHEAD_MS);
        for (path, text) in [(&end_of_time, "planted"), (&last_ours, "last"), (&ahead, "ahead")] {
            fs::write(path, text).unwrap();
        }
        let before = now_ms();
        fs::write(scratch.file(), "garbage").unwrap();
        assert!(list(&base).unwrap().is_empty(), "moved aside, no overflow");
        let after = now_ms();
        let mut times: Vec<u64> = names_in(&base, |name| bad_ms(name).is_some()).iter().filter_map(|(name, _)| bad_ms(name)).collect();
        times.sort();
        assert_eq!(times.len(), 3, "the garbage, the one ten days ahead and the last of ours: {times:?}");
        assert!(times[0] >= before && times[0] <= after + 1, "named after now, not after the names ahead: {times:?}");
        assert_eq!(fs::read(named(times[0])).unwrap(), b"garbage");
        assert!(end_of_time.exists(), "not ours: left alone");

        // Every name of ours is deleted by a clear, however far ahead; the
        // one that is not ours is not.
        assert_eq!(clear(&base).unwrap(), 0);
        assert!(scratch.bad().is_empty());
        assert!(end_of_time.exists(), "not even by a clear");
    }

    // ---- AC19: a kind this build does not know ----------------------------------------------------

    #[test]
    fn an_unknown_kind_survives_other_writes() {
        let scratch = Scratch::new("unknown-kind");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let agy = json!({"key": "agy:a1", "kind": "agy", "sessionId": "a1", "cwd": "/w", "title": "Plan",
            "startedAt": 5, "lastUsedAt": 5, "endedAt": null, "endReason": null, "agyOnly": [1, 2]});
        fs::write(scratch.file(), serde_json::to_vec(&json!({"version": 1, "entries": [agy]})).unwrap()).unwrap();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 9, 9), None).unwrap();
        let kept = list(&base).unwrap();
        assert_eq!(keys(&kept), vec![format!("claude:{CLAUDE_A}"), "agy:a1".to_string()]);
        assert_eq!(kept[1].title.as_deref(), Some("Plan"));
    }

    // ---- Atomicity and the locks --------------------------------------------------------------------

    #[test]
    fn a_temporary_file_a_crash_left_is_swept() {
        let scratch = Scratch::new("temp");
        let base = scratch.base();
        list(&base).unwrap();
        let leftover = base.join(format!("{TEMP_PREFIX}99999-0.tmp"));
        fs::write(&leftover, b"half a write").unwrap();
        let other = base.join(".someone-else.tmp");
        fs::write(&other, b"not ours").unwrap();
        list(&base).unwrap();
        assert!(!leftover.exists(), "ours went");
        assert!(other.exists(), "nobody else's is touched");
        assert!(names_in(&base, is_our_temp).is_empty(), "and no write leaves one");
    }

    #[test]
    fn another_nexterm_holding_the_lock_is_waited_for_then_refused() {
        let scratch = Scratch::new("busy");
        let base = scratch.base();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 1), None).unwrap();
        let before = fs::read(scratch.file()).unwrap();
        // Another open of the lock file is another lock owner, as another
        // process is: flock locks are per open file, LockFileEx's per handle.
        let other = fs::OpenOptions::new().read(true).write(true).open(base.join(LOCK_FILE)).unwrap();
        other.lock().unwrap();
        let started = Instant::now();
        assert_eq!(upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 2, 2), None).unwrap_err(), BUSY);
        assert!(started.elapsed() >= LOCK_WAIT, "waited for it first");
        assert_eq!(fs::read(scratch.file()).unwrap(), before, "nothing changed");
        other.unlock().unwrap();
        assert!(upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 2, 2), None).is_ok(), "let go, the next one goes ahead");
    }

    #[test]
    fn the_written_file_is_the_documented_shape() {
        let scratch = Scratch::new("shape");
        let base = scratch.base();
        let mut ended = entry("opencode", Some(OPENCODE_A), "/w", Some("Title"), 1, 2);
        ended["endedAt"] = json!(2);
        ended["endReason"] = json!("closed");
        upsert(&base, &ended, None).unwrap();
        assert_eq!(
            document(&scratch),
            json!({"version": 1, "entries": [{
                "key": format!("opencode:{OPENCODE_A}"), "kind": "opencode", "sessionId": OPENCODE_A,
                "cwd": "/w", "title": "Title", "startedAt": 1, "lastUsedAt": 2, "endedAt": 2, "endReason": "closed",
            }]})
        );
    }
}

/// The other half of the browser mock's contract with this module: a list of
/// operation sequences, each run here on a folder of its own, written with
/// what this module answered to `tests/fixtures/agent-history.json`.
/// tests/adversarial/agent_history_contract.test.js replays each through
/// `BrowserMockBridge` and expects the same answers, the same file, byte for
/// byte, and the same files moved aside.
#[cfg(test)]
mod contract_tests {
    use super::tests::{entry, Scratch, HELD_OPEN};
    use super::*;
    use serde_json::json;

    const CLAUDE_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const OPENCODE_A: &str = "ses_ef45006f5ffeAMtumN5ySj4VmT";
    const OPENCODE_B: &str = "ses_0123456789abcdefGHIJKLMNop";

    fn upsert_op(entry: Value, replaces: Option<&str>) -> Value {
        match replaces {
            Some(key) => json!({"op": "upsert", "args": {"entry": entry, "replaces": key}}),
            None => json!({"op": "upsert", "args": {"entry": entry}}),
        }
    }

    fn ended(mut e: Value, at: u64, reason: &str) -> Value {
        e["endedAt"] = json!(at);
        e["endReason"] = json!(reason);
        e
    }

    fn with(mut e: Value, field: &str, value: Value) -> Value {
        e[field] = value;
        e
    }

    /// A raw file: `text`, padded with spaces to `pad_to` bytes when given.
    fn write_file(text: &str, pad_to: Option<usize>) -> Value {
        match pad_to {
            Some(n) => json!({"op": "write_file", "args": {"text": text, "padTo": n}}),
            None => json!({"op": "write_file", "args": {"text": text}}),
        }
    }

    fn scenarios() -> Vec<(&'static str, Vec<Value>)> {
        let claude = entry("claude", Some(CLAUDE_A), "/work/app", None, 1000, 1000);
        let provisional = entry("opencode", None, "/work/app", None, 2000, 2000);
        let provisional_key = "opencode:~/work/app\u{0}";
        let titled = entry("opencode", None, "/work/app", Some("Fix the build"), 2000, 2100);
        let titled_key = "opencode:~/work/app\u{0}Fix the build";
        let learned = entry("opencode", Some(OPENCODE_A), "/work/app", Some("Fix the build"), 2000, 2200);
        let valid_v1 = json!({"version": 1, "entries": [
            entry("claude", Some(CLAUDE_A), "/w", None, 1, 5),
            entry("claude", Some("x; curl a | sh"), "/w", None, 1, 9),
            entry("opencode", Some(OPENCODE_A), "/w", Some("Kept"), 1, 3),
            {"kind": "claude", "sessionId": CLAUDE_A, "cwd": "/second", "startedAt": 1, "lastUsedAt": 4},
            {"kind": "agy", "sessionId": "agy 1", "cwd": "/w", "startedAt": 2, "lastUsedAt": 2, "extra": {"a": 1}},
            "not an entry",
        ]});
        let newer = json!({"version": 2, "entries": [
            entry("claude", Some(CLAUDE_A), "/w", None, 1, 5),
            {"kind": "claude", "v2": true},
        ], "settings": {}});

        // Every refusal of the unit test, written through the command: the
        // mock must refuse each with the same words.
        let mut refused = vec![
            upsert_op(json!("an entry"), None),
            upsert_op(json!(null), None),
            upsert_op(with(claude.clone(), "kind", json!("Claude Code")), None),
            upsert_op(with(claude.clone(), "sessionId", json!("x; curl a | sh")), None),
            upsert_op(with(claude.clone(), "sessionId", json!(CLAUDE_A.to_uppercase())), None),
            upsert_op(with(claude.clone(), "sessionId", json!("ses_ef45006f5ffeAMtumN5ySj4VmT")), None),
            upsert_op(with(entry("opencode", None, "/w", None, 1, 1), "sessionId", json!("ses_short")), None),
            upsert_op(with(claude.clone(), "cwd", json!("work/app")), None),
            upsert_op(with(claude.clone(), "cwd", json!("")), None),
            upsert_op(with(claude.clone(), "cwd", json!("/w\u{7}")), None),
            upsert_op(with(claude.clone(), "title", json!("one\u{2028}two")), None),
            upsert_op(with(claude.clone(), "title", json!("é".repeat(201))), None),
            upsert_op(with(claude.clone(), "startedAt", json!("1000")), None),
            upsert_op(with(claude.clone(), "lastUsedAt", json!(-5)), None),
            upsert_op(with(claude.clone(), "endedAt", json!(10)), None),
            upsert_op(with(claude.clone(), "endReason", json!("closed")), None),
            upsert_op(with(with(claude.clone(), "endedAt", json!(10)), "endReason", json!("crashed")), None),
        ];
        refused.extend(super::tests::refused_cases().into_iter().map(|(value, _)| upsert_op(value, None)));
        refused.push(json!({"op": "list"}));
        // The same entries in a file: dropped on read, the valid ones kept,
        // the file not rewritten by a list; then a write leaves them out.
        let mut in_file = vec![entry("claude", Some(CLAUDE_A), "/w", None, 1, 5)];
        in_file.extend(super::tests::refused_cases().into_iter().map(|(value, _)| value));
        in_file.push(entry("opencode", Some(OPENCODE_A), "/w", Some("Kept"), 1, 3));
        let refused_in_file = vec![
            write_file(&json!({"version": 1, "entries": in_file}).to_string(), None),
            json!({"op": "list"}),
            upsert_op(entry("opencode", Some(OPENCODE_B), "/w", None, 6, 6), None),
            json!({"op": "list"}),
        ];
        // Text JSON.parse reads and serde_json does not: a lone surrogate
        // escaped, in a value or a key, and nesting past serde_json's limit
        // (128 levels, the file's object included). A pair is read.
        let nested = |levels: usize| {
            format!(r#"{{"version":1,"entries":[],"x":{}{}}}"#, "[".repeat(levels - 1), "]".repeat(levels - 1))
        };
        let unparsable = vec![
            write_file(r#"{"version":1,"entries":[],"x":"\ud800"}"#, None),
            json!({"op": "list"}),
            write_file(r#"{"version":1,"entries":[],"x":"a\udc00b"}"#, None),
            json!({"op": "list"}),
            write_file(r#"{"version":1,"\ud800":1,"entries":[]}"#, None),
            json!({"op": "list"}),
            write_file(r#"{"version":1,"entries":[{"kind":"opencode","sessionId":null,"cwd":"/w","title":"😀 ok","startedAt":1,"lastUsedAt":1}]}"#, None),
            json!({"op": "list"}),
        ];
        let deep = vec![
            write_file(&nested(127), None),
            json!({"op": "list"}),
            write_file(&nested(128), None),
            json!({"op": "list"}),
            write_file(&nested(129), None),
            json!({"op": "list"}),
        ];
        // -0 is a float to serde_json, and no time; nor a version.
        let negative_zero = vec![
            write_file(
                &format!(
                    r#"{{"version":1,"entries":[{{"kind":"claude","sessionId":"{CLAUDE_A}","cwd":"/w","startedAt":-0,"lastUsedAt":1}},{{"kind":"opencode","sessionId":"{OPENCODE_A}","cwd":"/w","startedAt":0,"lastUsedAt":-0}},{{"kind":"opencode","sessionId":"{OPENCODE_B}","cwd":"/w","startedAt":0,"lastUsedAt":2}}]}}"#
                ),
                None,
            ),
            json!({"op": "list"}),
            write_file(r#"{"version":-0,"entries":[]}"#, None),
            json!({"op": "list"}),
        ];

        let mut cap = Vec::new();
        for n in 1..=205u64 {
            cap.push(upsert_op(entry("opencode", Some(&format!("ses_cap{n:05}")), "/w", None, n, 1000 + n), None));
        }
        cap.push(json!({"op": "list"}));
        cap.push(upsert_op(entry("opencode", Some("ses_oldest00"), "/w", None, 0, 1), None));
        cap.push(json!({"op": "list"}));

        // Folders of 4096 bytes with a backslash in every other one, written
        // twice each (the key), and titles of quotes: about 13 KB an entry
        // as JSON, so some 79 fit under the read cap. The fixture keeps every
        // answer, so it stays at the 90 needed to get past it.
        let mut fit = Vec::new();
        let wide = |n: u64| format!("C:\\{n:03}{}", "\\x".repeat(2045));
        let quoted = "\"".repeat(MAX_TITLE_CHARS);
        for n in 1..=90u64 {
            fit.push(upsert_op(entry("opencode", None, &wide(n), Some(&quoted), n, 100 + n), None));
        }
        fit.push(upsert_op(entry("opencode", None, &wide(0), Some(&quoted), 0, 1), None));
        fit.push(json!({"op": "remove", "args": {"key": format!("opencode:~{}\u{0}{quoted}", wide(90))}}));
        fit.push(json!({"op": "list"}));

        vec![
            ("the first list makes an empty history", vec![json!({"op": "list"})]),
            (
                "one conversation written twice is one entry",
                vec![
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("First"), 100, 200), None),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", None, 150, 300), None),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Stale"), 50, 250), None),
                    upsert_op(ended(entry("opencode", Some(OPENCODE_A), "/w", None, 400, 400), 400, "exited"), None),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Second"), 500, 500), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a provisional entry is re-keyed by its title, then by its id",
                vec![
                    upsert_op(provisional, None),
                    upsert_op(titled, Some(provisional_key)),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/work/app", Some("Earlier"), 10, 20), None),
                    upsert_op(learned, Some(titled_key)),
                    json!({"op": "list"}),
                ],
            ),
            (
                "replaces passes over an entry with an id, another kind, and itself",
                vec![
                    upsert_op(claude.clone(), None),
                    upsert_op(entry("claude", None, "/work/app", None, 1, 2), None),
                    upsert_op(entry("opencode", Some(OPENCODE_B), "/work/app", None, 3, 3), Some(&format!("claude:{CLAUDE_A}"))),
                    upsert_op(entry("opencode", None, "/x", None, 4, 4), Some("claude:~/work/app\u{0}")),
                    upsert_op(entry("opencode", None, "/x", None, 5, 5), Some("opencode:~/x\u{0}")),
                    upsert_op(entry("opencode", None, "/y", None, 6, 6), Some("opencode:nothing-here")),
                    json!({"op": "list"}),
                ],
            ),
            ("the newest two hundred are kept", cap),
            ("a history is never written larger than it may be read", fit),
            (
                "remove deletes exactly one, and clear every kind's",
                vec![
                    upsert_op(claude.clone(), None),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Kept"), 5, 5), None),
                    upsert_op(entry("agy", Some("agy-1"), "/w", None, 6, 6), None),
                    json!({"op": "remove", "args": {"key": format!("claude:{CLAUDE_A}")}}),
                    json!({"op": "remove", "args": {"key": format!("claude:{CLAUDE_A}")}}),
                    json!({"op": "remove", "args": {"key": ""}}),
                    json!({"op": "list"}),
                    json!({"op": "clear"}),
                    json!({"op": "list"}),
                    json!({"op": "clear"}),
                ],
            ),
            (
                "a kind this build does not know is kept",
                vec![
                    write_file(&json!({"version": 1, "entries": [
                        {"key": "agy:a1", "kind": "agy", "sessionId": "a1", "cwd": "/w", "title": "Plan",
                         "startedAt": 5, "lastUsedAt": 5, "endedAt": null, "endReason": null, "agyOnly": [1, 2]}
                    ]}).to_string(), None),
                    upsert_op(claude.clone(), None),
                    json!({"op": "list"}),
                ],
            ),
            ("invalid entries are refused and nothing is made", refused),
            ("entries that would be refused are dropped from a valid file", refused_in_file),
            ("text serde_json does not read is moved aside: lone surrogates", unparsable),
            ("text serde_json does not read is moved aside: nesting past its limit", deep),
            ("-0 is no time and no version", negative_zero),
            (
                "a clear that cannot delete a copy moved aside says so",
                vec![
                    upsert_op(claude.clone(), None),
                    write_file("{not json", None),
                    json!({"op": "list"}),
                    upsert_op(claude.clone(), None),
                    write_file("[1]", None),
                    json!({"op": "list"}),
                    json!({"op": "hold_asides"}),
                    upsert_op(claude.clone(), None),
                    json!({"op": "clear"}),
                    json!({"op": "list"}),
                ],
            ),
            (
                "the bounds themselves are kept",
                vec![
                    upsert_op(with(with(claude.clone(), "title", json!("é".repeat(200))), "lastUsedAt", json!(MAX_INTEGER)), None),
                    upsert_op(entry("opencode", Some(&format!("ses_{}", "Z".repeat(64))), "C:\\Users\\me", None, 0, 0), None),
                    upsert_op(entry("claude", None, "\\\\server\\share", None, 0, 0), None),
                    upsert_op(entry("agy", Some(&"a".repeat(128)), "/", None, 0, 0), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a deleted file is made again",
                vec![
                    upsert_op(claude.clone(), None),
                    json!({"op": "delete_file"}),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", None, 7, 7), None),
                    json!({"op": "list"}),
                    json!({"op": "delete_file"}),
                    json!({"op": "list"}),
                    json!({"op": "delete_file"}),
                    json!({"op": "remove", "args": {"key": format!("opencode:{OPENCODE_A}")}}),
                    json!({"op": "delete_file"}),
                    json!({"op": "clear"}),
                ],
            ),
            (
                "unreadable files are moved aside, the newest three kept",
                vec![
                    upsert_op(claude.clone(), None),
                    write_file("{version: 1, entries: []}", None),
                    json!({"op": "list"}),
                    write_file(r#"{"version":1,"entries":[{"kind":"claude","sessionId":"0f8f"#, None),
                    upsert_op(claude.clone(), None),
                    write_file(r#"[{"version":1,"entries":[]}]"#, None),
                    json!({"op": "remove", "args": {"key": format!("claude:{CLAUDE_A}")}}),
                    write_file(r#"{"version":1,"entries":[]}"#, Some(MAX_READ_BYTES as usize + 1)),
                    json!({"op": "clear"}),
                    write_file(r#"{"entries":[]}"#, None),
                    json!({"op": "list"}),
                    write_file(r#"{"version":1,"entries":{}}"#, None),
                    json!({"op": "list"}),
                    write_file(r#"{"version":0,"entries":[]}"#, None),
                    json!({"op": "list"}),
                    write_file("", None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "clear deletes the files moved aside, a refused clear none",
                vec![
                    upsert_op(claude.clone(), None),
                    write_file("{not json", None),
                    json!({"op": "list"}),
                    upsert_op(claude.clone(), None),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Kept"), 5, 5), None),
                    json!({"op": "clear"}),
                    write_file("[1]", None),
                    json!({"op": "clear"}),
                    write_file("garbage", None),
                    json!({"op": "list"}),
                    write_file(r#"{"version":2,"entries":[]}"#, None),
                    json!({"op": "clear"}),
                ],
            ),
            (
                "a file just under the read cap is read",
                vec![
                    write_file(&json!({"version": 1, "entries": [entry("claude", Some(CLAUDE_A), "/w", None, 1, 1)]}).to_string(), Some(MAX_READ_BYTES as usize)),
                    json!({"op": "list"}),
                ],
            ),
            (
                "invalid entries in a valid file are dropped, the file kept",
                vec![write_file(&valid_v1.to_string(), None), json!({"op": "list"})],
            ),
            (
                "a newer file is read and never written",
                vec![
                    write_file(&newer.to_string(), None),
                    json!({"op": "list"}),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", None, 1, 1), None),
                    json!({"op": "remove", "args": {"key": format!("claude:{CLAUDE_A}")}}),
                    json!({"op": "clear"}),
                    upsert_op(json!({"kind": 1}), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a newer file with no list reads as empty",
                vec![write_file(r#"{"version":3,"sessions":[]}"#, None), json!({"op": "list"})],
            ),
        ]
    }

    fn answer<T: Serialize>(result: Result<T, String>) -> Value {
        match result {
            Ok(value) => json!({"ok": value}),
            Err(why) => json!({"error": why}),
        }
    }

    fn run(base: &Path, op: &Value) -> Value {
        let args = &op["args"];
        match op["op"].as_str().unwrap() {
            "list" => answer(list(base)),
            "upsert" => answer(upsert(base, &args["entry"], args["replaces"].as_str())),
            "remove" => answer(remove(base, args["key"].as_str().unwrap())),
            "clear" => answer(clear(base)),
            "delete_file" => {
                match fs::remove_file(base.join(FILE)) {
                    Err(e) if e.kind() != ErrorKind::NotFound => panic!("{e}"),
                    _ => {}
                }
                Value::Null
            }
            "write_file" => {
                let mut text = args["text"].as_str().unwrap().to_string();
                if let Some(n) = args["padTo"].as_u64() {
                    while text.len() < n as usize {
                        text.push(' ');
                    }
                }
                fs::create_dir_all(base).unwrap();
                fs::write(base.join(FILE), text).unwrap();
                Value::Null
            }
            // Another program holds every file moved aside so far open: a
            // clear cannot delete them (`delete_copy`).
            "hold_asides" => {
                let mut held = HELD_OPEN.lock();
                held.extend(names_in(base, |name| bad_ms(name).is_some()).into_iter().map(|(_, path)| path));
                Value::Null
            }
            other => panic!("no such op {other}"),
        }
    }

    /// A file moved aside, as the fixture holds it: its size, and its text
    /// when it is short enough to be worth comparing whole.
    fn aside(bytes: &[u8]) -> Value {
        let text = std::str::from_utf8(bytes).ok().filter(|_| bytes.len() <= 4096);
        json!({"bytes": bytes.len(), "text": text})
    }

    #[test]
    fn dump_the_backends_answers_for_the_mock_contract_test() {
        let mut out = Vec::new();
        for (n, (name, ops)) in scenarios().into_iter().enumerate() {
            let scratch = Scratch::new(&format!("contract-{n}"));
            let base = scratch.base();
            let results: Vec<Value> = ops.iter().map(|op| run(&base, op)).collect();
            // The file's exact text: the mock must write the same bytes.
            let text = fs::read(scratch.file()).ok().map(|bytes| String::from_utf8(bytes).unwrap());
            let bad: Vec<Value> = scratch.bad().iter().map(|bytes| aside(bytes)).collect();
            HELD_OPEN.lock().retain(|path| !path.starts_with(&base));
            out.push(json!({"name": name, "ops": ops, "results": results, "fileText": text, "bad": bad}));
        }
        let payload = json!({
            "platform": std::env::consts::OS,
            "constants": {
                "file": FILE, "version": VERSION, "cap": CAP, "maxReadBytes": MAX_READ_BYTES, "keepBad": KEEP_BAD,
                "maxCwdBytes": MAX_CWD_BYTES, "maxTitleChars": MAX_TITLE_CHARS, "maxOtherIdChars": MAX_OTHER_ID_CHARS,
                "maxInteger": MAX_INTEGER, "newerVersion": NEWER_VERSION, "invalid": INVALID,
                "copiesLeft": COPIES_LEFT,
            },
            "scenarios": out,
        });
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("tests").join("fixtures");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("agent-history.json"), serde_json::to_string_pretty(&payload).unwrap()).unwrap();
    }
}
