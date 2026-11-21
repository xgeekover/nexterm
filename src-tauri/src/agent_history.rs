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
//! **The format.** `{"version":1,"entries":[…]}` while nothing is curated,
//! and `{"version":2,"entries":[…],"groups":[…]}` once anything is
//! (`document_text`). Each entry is `{key, kind, sessionId, cwd, title,
//! startedAt, lastUsedAt, endedAt, endReason}` (`Entry`), times in
//! milliseconds since the epoch, newest first; then `forkOf`, only for a
//! conversation forked from another (Fork Conversation): that one's session
//! id, of the entry's kind's shape. It is recorded, not curated — an upsert
//! writes it, a later one without it keeps it (`merge`) — and an entry
//! without it is written exactly as before, so it alone never makes the file
//! version 2; a build before it reads the file and ignores the field. Then,
//! each only when it is not at its default, what the user curated: `name`, their own name for it,
//! one line as a title is; `pinned` and `archived`, true; and `groupId`, the
//! `id` of one of `groups`. A group is `{id, name, collapsed}`, in the order
//! the side bar shows them: an id the page made (`^[0-9A-Za-z_-]{1,64}$`), a
//! name of one line, and whether its list is folded. VERSION, the newest
//! format this build reads and writes, is 2; it reads version 1 as well. A
//! field this build does not know is ignored — which is how a build before
//! `forkOf` reads one that has it. A kind it does not know but
//! that is well formed (`is_kind`) is kept and handed back like any other:
//! the page shows and resumes only the agents it knows, and a later build can
//! add one without a new format.
//!
//! **Why version 2 only once something is curated.** NexTerm 0.26.0 ignores a
//! field it does not know when it reads, but writes only its own nine, so it
//! would drop a name or a pin at its next recorded event; and it reads any
//! version above 1 as a newer file, which it lists and never writes. So a
//! history with nothing curated is written byte for byte as 0.26.0 writes it
//! and stays one that 0.26.0 records into, and a curated one is one it only
//! reads. Nothing curated is lost either way.
//!
//! **What is refused.** The file is anyone's to edit, and a session id is
//! typed into a shell when a conversation is resumed. So an entry is only
//! kept when every field is what this build could have written (`entry_from`,
//! and `stored_entry_from` for what the user curated): a session id of its
//! kind's one shape — the same patterns as src/lib/agents.js, and the same
//! for the `forkOf` it was forked from — a folder that
//! is an absolute path without control characters, a title and a name of one
//! line, a `groupId` of a group id's shape. An entry that is not is dropped
//! on read and refused on write; the rest of the file is kept. A group that
//! is not valid, one with an id seen before and any past MAX_GROUPS are
//! dropped by themselves (`valid_groups`), and a `groupId` that names no group
//! kept is read as none: the entry stays, in no group. None of these moves the
//! file aside.
//!
//! **One entry per conversation.** Its `key` is made here from its fields
//! (`key_of`), never taken from the page or the file: `<kind>:<sessionId>`,
//! or for a conversation whose id is not known yet `<kind>:~<cwd>\0<title>`.
//! A write of a key that is there merges into it (`merge`). A write may name
//! the provisional key it `replaces` — the entry that has since learned its
//! id, or its title — which then goes, merged into the new one. A recorded
//! event never changes what the user curated: an upsert reads no `name`,
//! `pinned`, `archived` or `groupId` of the page's, and the merged entry has
//! them from the entry under its key, else from the one it replaces; asked
//! to `unarchive`, it clears `archived` and nothing else. Only the curation
//! operations change them: `update`, `group_create`, `group_update`,
//! `group_delete`, and `clear`, which deletes the groups too.
//!
//! **Caps.** An entry that is pinned, renamed or in a group is protected
//! (`Entry::is_protected`); archived alone is not. After every recorded event
//! (`upsert`) the least recently used unprotected entries go until CAP are
//! left, never the one just written, and never a protected one. At most
//! MAX_CURATED are protected: a curation that would protect one more is
//! refused with TOO_MANY_CURATED and changes nothing, so nothing curated is
//! dropped for the cap. A curation adds no entry and drops none for CAP: one
//! it leaves unprotected — unpinned, its name cleared, out of a group — stays
//! until the next recorded event, which keeps the CAP most recent. A read
//! keeps what every write leaves: the newest MAX_CURATED protected entries,
//! and CAP + MAX_CURATED entries in all (`within_bounds`). A file over
//! MAX_READ_BYTES is not read, so none is written: when entries with folders
//! and titles near their own caps would come to more, the least recently used
//! go until it fits — never the one just written, the unprotected first, and
//! a protected one only once no other is left, which is logged
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
//! and that envelope stay as they are in every version after this one:
//! version 2 keeps to them, its `groups` a member beside `entries`, and its
//! text within MAX_READ_BYTES. Both versions this build reads must have their
//! `entries`. A file that is not there is the same as an empty history, and
//! is written by the first operation that finds it missing: the file is what
//! the history is, so one the user deleted stays deleted.
//!
//! **A newer format** (`version` above VERSION, so 3 and up) is never
//! overwritten or moved aside: a list hands back the entries this build can
//! read, `groups` the groups it can read and that it is read only, and every
//! write is refused with NEWER_VERSION, logged once.
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

/// The newest format this build reads and writes: a curated history's.
pub const VERSION: u64 = 2;

/// The format a history with nothing curated is written in: NexTerm 0.26.0's,
/// byte for byte. See the module's doc.
pub const UNCURATED_VERSION: u64 = 1;

/// The most entries kept that are not pinned, renamed or in a group. Mirrored by the browser mock.
pub const CAP: usize = 200;

/// The most entries kept that are pinned, renamed or in a group, besides CAP
/// others. Mirrored by the browser mock.
pub const MAX_CURATED: usize = 200;

/// The most groups. Mirrored by the browser mock.
pub const MAX_GROUPS: usize = 50;

/// The longest name a user gives an entry, in characters: as long as a title.
pub const MAX_NAME_CHARS: usize = 200;

/// The longest group name, in characters.
pub const MAX_GROUP_NAME_CHARS: usize = 100;

/// The longest group id, in characters: `^[0-9A-Za-z_-]{1,64}$`.
pub const MAX_GROUP_ID_CHARS: usize = 64;

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

/// How the refusal of an entry that is not valid begins, before `: <why>` —
/// and of changes to one (`update`).
pub const INVALID: &str = "Not a valid agent session";

/// How the refusal of a group, or changes to one, that is not valid begins,
/// before `: <why>`.
pub const INVALID_GROUP: &str = "Not a valid agent session group";

/// Why a group past MAX_GROUPS is refused.
pub const TOO_MANY_GROUPS: &str = "There can be at most 50 agent session groups";

/// Why a curation is refused that would protect an entry past MAX_CURATED.
pub const TOO_MANY_CURATED: &str = "At most 200 agent sessions can be pinned, renamed or in a group; unpin one, clear its name or take it out of its group first";

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
    /// The conversation this one was forked from (Fork Conversation): a
    /// session id of its kind's shape, as `session_id` is. Written and handed
    /// to the page only when there is one, so an entry with none is the nine
    /// fields; not curated, so it never makes the file version 2. Recorded
    /// like the rest — an upsert reads it — and kept by `merge` when a later
    /// event has none. NexTerm 0.26.0 to 0.33 ignore it when they read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_of: Option<String>,
    // What the user curated, written and handed to the page only when not at
    // its default: an entry with none is the nine fields NexTerm 0.26.0
    // writes. Never read from an upsert (`merge`).
    /// The user's own name for it: one line, at most MAX_NAME_CHARS characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub pinned: bool,
    /// Hidden from the lists until it is unarchived, or resumed.
    #[serde(skip_serializing_if = "is_false")]
    pub archived: bool,
    /// The `id` of the group it is in, one that is there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

impl Entry {
    /// Kept beyond CAP: pinned, renamed or in a group. Archived alone is not.
    pub fn is_protected(&self) -> bool {
        self.pinned || self.name.is_some() || self.group_id.is_some()
    }

    /// Anything curated, archived included: what makes the file version 2.
    fn is_curated(&self) -> bool {
        self.is_protected() || self.archived
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A group of entries, as kept and as handed to the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Group {
    /// Made by the page (`crypto.randomUUID()`), `^[0-9A-Za-z_-]{1,64}$`.
    pub id: String,
    /// One line, at most MAX_GROUP_NAME_CHARS characters.
    pub name: String,
    /// Whether the side bar folds its list.
    pub collapsed: bool,
}

/// What `groups` hands the page: the file's own version, whether this build
/// only reads it (a newer file), and its groups in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupList {
    pub version: u64,
    pub read_only: bool,
    pub groups: Vec<Group>,
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

/// The file as written: `groups` only in version 2.
#[derive(Serialize)]
struct Document<'a> {
    version: u64,
    entries: &'a [Entry],
    #[serde(skip_serializing_if = "Option::is_none")]
    groups: Option<&'a [Group]>,
}

/// A history as read: the file's own version, its valid entries — newest
/// first, within the bounds (`within_bounds`) — and its valid groups, in order.
struct History {
    version: u64,
    entries: Vec<Entry>,
    groups: Vec<Group>,
}

impl History {
    fn empty() -> History {
        History { version: UNCURATED_VERSION, entries: Vec::new(), groups: Vec::new() }
    }
}

/// What a read found, once anything unreadable has been moved aside.
enum Stored {
    /// Version 1 or 2: to change and write back.
    Current(History),
    /// A newer version, read only: what this build can read of it.
    Newer(History),
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

/// A user's name for an entry: one line, as a title is.
fn is_name(name: &str) -> bool {
    (1..=MAX_NAME_CHARS).contains(&name.chars().count()) && !name.chars().any(refused_char)
}

fn is_group_name(name: &str) -> bool {
    (1..=MAX_GROUP_NAME_CHARS).contains(&name.chars().count()) && !name.chars().any(refused_char)
}

/// Whether `id` names a group: `^[0-9A-Za-z_-]{1,64}$`, ASCII only — what
/// the page's `crypto.randomUUID()` makes, and more.
fn is_group_id(id: &str) -> bool {
    (1..=MAX_GROUP_ID_CHARS).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// Why a curated field, or a change to one, is refused. The browser mock says
// the same.
fn bad_name() -> String {
    format!("its name is not one line of at most {MAX_NAME_CHARS} characters")
}
const BAD_PINNED: &str = "its pinned is neither true nor false";
const BAD_ARCHIVED: &str = "its archived is neither true nor false";
const BAD_GROUP_ID: &str = "its groupId is not a group's id";
// And a group, or a change to one.
const BAD_ID: &str = "its id is not 1 to 64 ASCII letters, digits, - and _";
fn bad_group_name() -> String {
    format!("its name is not one line of at most {MAX_GROUP_NAME_CHARS} characters")
}
const BAD_COLLAPSED: &str = "its collapsed is neither true nor false";

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

/// A field that is true or false: missing and null are false; anything else
/// but a boolean is `Err`.
fn flag_field(object: &Map<String, Value>, name: &str) -> Result<bool, ()> {
    match object.get(name) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
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
/// The same test for an entry read from the file and one the page writes;
/// what the user curated is not read here, and is at its default (an
/// upsert never sets it; the file's is read by `stored_entry_from`). The
/// browser mock asks the same questions in the same order, with the same
/// answers.
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
    // Asked last, so that an entry of the nine fields is refused for exactly
    // what it always was.
    let fork_of = match text_field(entry, "forkOf") {
        Ok(None) => None,
        Ok(Some(id)) if is_session_id_for(kind, id) => Some(id),
        _ => return Err(format!("its forkOf is not one that {kind} gives a conversation")),
    };
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
        fork_of: fork_of.map(str::to_string),
        name: None,
        pinned: false,
        archived: false,
        group_id: None,
    })
}

/// `value` as an entry of the file: `entry_from`'s, and what the user
/// curated of it, each field of its shape — missing and null are its
/// default — or why it is not one. Whether its group is there is asked
/// after (`valid_entries`).
fn stored_entry_from(value: &Value) -> Result<Entry, String> {
    let mut entry = entry_from(value)?;
    let Some(object) = value.as_object() else {
        return Err("it is not an object".to_string());
    };
    entry.name = match text_field(object, "name") {
        Ok(None) => None,
        Ok(Some(name)) if is_name(name) => Some(name.to_string()),
        _ => return Err(bad_name()),
    };
    entry.pinned = flag_field(object, "pinned").map_err(|()| BAD_PINNED.to_string())?;
    entry.archived = flag_field(object, "archived").map_err(|()| BAD_ARCHIVED.to_string())?;
    entry.group_id = match text_field(object, "groupId") {
        Ok(None) => None,
        Ok(Some(id)) if is_group_id(id) => Some(id.to_string()),
        _ => return Err(BAD_GROUP_ID.to_string()),
    };
    Ok(entry)
}

/// What `update` is asked to change: each field it names, with its new value.
#[derive(Debug, Default)]
struct Changes {
    name: Option<Option<String>>,
    pinned: Option<bool>,
    archived: Option<bool>,
    group_id: Option<Option<String>>,
}

/// `value` as changes to an entry, or why not: an object naming only `name`
/// (a name, or null or "" for none), `pinned` and `archived` (true or false)
/// and `groupId` (a group id, or null for none). Whether that group is there
/// is asked once the file is read. The browser mock asks the same questions
/// in the same order, with the same answers.
fn changes_from(value: &Value) -> Result<Changes, String> {
    let Some(object) = value.as_object() else {
        return Err("the changes are not an object".to_string());
    };
    if object.keys().any(|field| !matches!(field.as_str(), "name" | "pinned" | "archived" | "groupId")) {
        return Err("a change names something other than name, pinned, archived and groupId".to_string());
    }
    let mut changes = Changes::default();
    if let Some(name) = object.get("name") {
        changes.name = Some(match name {
            Value::Null => None,
            Value::String(name) if name.is_empty() => None,
            Value::String(name) if is_name(name) => Some(name.clone()),
            _ => return Err(bad_name()),
        });
    }
    if let Some(pinned) = object.get("pinned") {
        let Value::Bool(pinned) = pinned else { return Err(BAD_PINNED.to_string()) };
        changes.pinned = Some(*pinned);
    }
    if let Some(archived) = object.get("archived") {
        let Value::Bool(archived) = archived else { return Err(BAD_ARCHIVED.to_string()) };
        changes.archived = Some(*archived);
    }
    if let Some(group_id) = object.get("groupId") {
        changes.group_id = Some(match group_id {
            Value::Null => None,
            Value::String(id) if is_group_id(id) => Some(id.clone()),
            _ => return Err(BAD_GROUP_ID.to_string()),
        });
    }
    Ok(changes)
}

/// `value`, the page's new group `{id, name}`, as kept — its list not folded
/// — or why it is not one. Any other field is not read.
fn new_group_from(value: &Value) -> Result<Group, String> {
    let Some(object) = value.as_object() else {
        return Err("it is not an object".to_string());
    };
    let id = match text_field(object, "id") {
        Ok(Some(id)) if is_group_id(id) => id,
        _ => return Err(BAD_ID.to_string()),
    };
    let name = match text_field(object, "name") {
        Ok(Some(name)) if is_group_name(name) => name,
        _ => return Err(bad_group_name()),
    };
    Ok(Group { id: id.to_string(), name: name.to_string(), collapsed: false })
}

/// A group of the file, or none when it is not one: `new_group_from`'s, and
/// `collapsed` true or false — missing and null are false.
fn stored_group_from(value: &Value) -> Option<Group> {
    let mut group = new_group_from(value).ok()?;
    group.collapsed = flag_field(value.as_object()?, "collapsed").ok()?;
    Some(group)
}

/// What `group_update` is asked to change.
#[derive(Debug, Default)]
struct GroupChanges {
    name: Option<String>,
    collapsed: Option<bool>,
}

/// `value` as changes to a group, or why not: an object naming only `name`
/// (a group name) and `collapsed` (true or false).
fn group_changes_from(value: &Value) -> Result<GroupChanges, String> {
    let Some(object) = value.as_object() else {
        return Err("the changes are not an object".to_string());
    };
    if object.keys().any(|field| !matches!(field.as_str(), "name" | "collapsed")) {
        return Err("a change names something other than name and collapsed".to_string());
    }
    let mut changes = GroupChanges::default();
    if let Some(name) = object.get("name") {
        let Some(name) = name.as_str().filter(|name| is_group_name(name)) else {
            return Err(bad_group_name());
        };
        changes.name = Some(name.to_string());
    }
    if let Some(collapsed) = object.get("collapsed") {
        let Value::Bool(collapsed) = collapsed else { return Err(BAD_COLLAPSED.to_string()) };
        changes.collapsed = Some(*collapsed);
    }
    Ok(changes)
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
///
/// The conversation it was forked from is the incoming one's when it names
/// one, else the first there is of `others`: an event after the fork — a
/// title, an end — sends none, and must not undo the link.
///
/// What the user curated is never the incoming one's (`entry_from` reads
/// none): its name and group are the first there are of `others`, it is
/// pinned when either is, and archived as the first of them is — the entry
/// under its key when there is one — unless it is to `unarchive`.
fn merge(incoming: Entry, others: Vec<Entry>, unarchive: bool) -> Entry {
    let fork_of = incoming.fork_of.clone().or_else(|| others.iter().find_map(|e| e.fork_of.clone()));
    let name = others.iter().find_map(|e| e.name.clone());
    let group_id = others.iter().find_map(|e| e.group_id.clone());
    let pinned = others.iter().any(|e| e.pinned);
    let archived = !unarchive && others.first().is_some_and(|e| e.archived);
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
    merged.fork_of = fork_of;
    merged.name = name;
    merged.pinned = pinned;
    merged.archived = archived;
    merged.group_id = group_id;
    merged
}

/// Most recently used first; of two used at the same time, the one that was
/// first stays first.
fn sort_newest_first(entries: &mut [Entry]) {
    entries.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
}

/// Drop the least recently used unprotected entries until CAP are left —
/// never `written`, and never a protected one. After every upsert.
fn keep_cap(entries: &mut Vec<Entry>, written: &str) {
    let mut unprotected = entries.iter().filter(|e| !e.is_protected()).count();
    while unprotected > CAP {
        let Some(at) = entries.iter().rposition(|e| !e.is_protected() && e.key != written) else {
            break;
        };
        entries.remove(at);
        unprotected -= 1;
    }
}

/// `entries`, newest first, within what every write leaves (see the module's
/// doc): the newest MAX_CURATED protected ones, and CAP + MAX_CURATED in all.
fn within_bounds(entries: Vec<Entry>) -> Vec<Entry> {
    let mut kept = Vec::with_capacity(entries.len().min(CAP + MAX_CURATED));
    let mut protected = 0;
    for entry in entries {
        if kept.len() == CAP + MAX_CURATED {
            break;
        }
        if entry.is_protected() {
            if protected == MAX_CURATED {
                continue;
            }
            protected += 1;
        }
        kept.push(entry);
    }
    kept
}

/// The valid groups of a file's `groups`, in order: none when it is not a
/// list; one that is not valid, one with an id seen before, and any past the
/// MAX_GROUPS kept, dropped by themselves.
fn valid_groups(value: Option<&Value>) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for value in value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if groups.len() == MAX_GROUPS {
            break;
        }
        let Some(group) = stored_group_from(value) else { continue };
        if groups.iter().all(|g| g.id != group.id) {
            groups.push(group);
        }
    }
    groups
}

/// The valid entries of a file's `entries`, newest first, within the bounds
/// (`within_bounds`). Of two with the same key, the one earlier in the file
/// is kept. One in a group that is not among `groups` is in none.
fn valid_entries(values: &[Value], groups: &[Group]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    for value in values {
        let Ok(mut entry) = stored_entry_from(value) else { continue };
        if entries.iter().any(|e| e.key == entry.key) {
            continue;
        }
        if entry.group_id.as_ref().is_some_and(|id| groups.iter().all(|g| g.id != *id)) {
            entry.group_id = None;
        }
        entries.push(entry);
    }
    sort_newest_first(&mut entries);
    within_bounds(entries)
}

/// What a file's bytes hold.
enum Parsed {
    /// Not a history this or any build wrote: why.
    Unreadable(&'static str),
    Read(History),
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
    if version <= VERSION && entries.is_none() {
        return Parsed::Unreadable("it has no list of entries");
    }
    let groups = valid_groups(document.get("groups"));
    Parsed::Read(History {
        version,
        entries: valid_entries(entries.map(Vec::as_slice).unwrap_or(&[]), &groups),
        groups,
    })
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

/// The file's text for `entries` and `groups`: pretty-printed, two spaces,
/// ending in a line end — byte for byte what the browser mock's
/// `JSON.stringify(…, null, 2)` makes of the same, which the contract test
/// checks. While nothing is curated — no group, and no entry with a name, a
/// pin, a group or archived — that is version 1 with no `groups`: the text
/// NexTerm 0.26.0 writes for the same entries. Else version 2, with them.
fn document_text(entries: &[Entry], groups: &[Group]) -> Result<String, String> {
    let document = if groups.is_empty() && !entries.iter().any(Entry::is_curated) {
        Document { version: UNCURATED_VERSION, entries, groups: None }
    } else {
        Document { version: VERSION, entries, groups: Some(groups) }
    };
    let mut text = serde_json::to_string_pretty(&document).map_err(not_saved)?;
    text.push('\n');
    Ok(text)
}

/// The file's text for `entries` and `groups`, after dropping the least
/// recently used — never `written`, the unprotected first and a protected one
/// only once no other is left — until it is within MAX_READ_BYTES: a file
/// this module would refuse to read is never written. Only entries whose
/// folders and titles are near their caps come near it; for those the fewest
/// to drop is found by halving, as the text only shrinks with each one
/// dropped (and with the version 1 a history with no more curated is).
fn fitted_text(entries: &mut Vec<Entry>, groups: &[Group], written: Option<&str>) -> Result<String, String> {
    let text = document_text(entries, groups)?;
    let fits = |text: &str| text.len() as u64 <= MAX_READ_BYTES;
    // The positions that may go, in the order they go: the least recently
    // used unprotected first, then the least recently used protected.
    let may_go: Vec<usize> = (0..entries.len()).rev().filter(|&at| Some(entries[at].key.as_str()) != written).collect();
    let unprotected = may_go.iter().filter(|&&at| !entries[at].is_protected()).count();
    let droppable: Vec<usize> = may_go
        .iter()
        .filter(|&&at| !entries[at].is_protected())
        .chain(may_go.iter().filter(|&&at| entries[at].is_protected()))
        .copied()
        .collect();
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
    if fits(&document_text(&without(1), groups)?) {
        high = 1;
    }
    while low < high {
        let middle = (low + high) / 2;
        if fits(&document_text(&without(middle), groups)?) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    if low > unprotected {
        log(&format!(
            "The agent session history would not fit in {MAX_READ_BYTES} bytes: {} pinned, renamed or grouped entries, the least recently used, were dropped from it",
            low - unprotected
        ));
    }
    *entries = without(low);
    document_text(entries, groups)
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
    write(base, &document_text(&[], &[])?)?;
    Ok(Stored::Current(History::empty()))
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
        Parsed::Read(history) if history.version <= VERSION => Ok(Stored::Current(history)),
        Parsed::Read(history) => Ok(Stored::Newer(history)),
    }
}

/// The history of `stored` to change and write back, or the refusal of a
/// newer file — said in the log once per folder for the life of the process.
fn writable(base: &Path, stored: Stored) -> Result<History, String> {
    match stored {
        Stored::Current(history) => Ok(history),
        Stored::Newer(History { version, .. }) => {
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
/// the kinds this build does not know included, and what the user curated of
/// each. Makes the file when it is not there. A newer file's entries are read
/// and the file is left as it is.
pub fn list(base: &Path) -> Result<Vec<Entry>, String> {
    with_history(base, |stored| {
        Ok(match stored {
            Stored::Current(history) | Stored::Newer(history) => history.entries,
        })
    })
}

/// The groups kept in `base`, in order, with the file's own version and
/// whether this build only reads it (a newer file, whose groups are the ones
/// this build can read). Makes the file when it is not there, as `list` does.
pub fn groups(base: &Path) -> Result<GroupList, String> {
    with_history(base, |stored| {
        let (history, read_only) = match stored {
            Stored::Current(history) => (history, false),
            Stored::Newer(history) => (history, true),
        };
        Ok(GroupList { version: history.version, read_only, groups: history.groups })
    })
}

/// `upsert_with` that unarchives nothing.
pub fn upsert(base: &Path, entry: &Value, replaces: Option<&str>) -> Result<Entry, String> {
    upsert_with(base, entry, replaces, false)
}

/// Record `entry` (the page's, in the file's shape; any `key` it has is not
/// read, nor anything curated) merged into the one with its key, and into it
/// the provisional entry `replaces` names — only one with no session id, of
/// the same kind, and not the new key itself; any other name is passed over.
/// What the user curated is kept (`merge`), but `archived` is cleared when it
/// is to `unarchive` — a conversation started or resumed again. Then keep
/// CAP (`keep_cap`), and MAX_READ_BYTES (`fitted_text`). The entry as kept.
///
/// Refused with INVALID, before the disk is touched, for an entry that is not
/// valid; with NEWER_VERSION for a newer file.
pub fn upsert_with(base: &Path, entry: &Value, replaces: Option<&str>, unarchive: bool) -> Result<Entry, String> {
    let incoming = entry_from(entry).map_err(|why| format!("{INVALID}: {why}"))?;
    with_history(base, |stored| {
        let History { mut entries, groups, .. } = writable(base, stored)?;
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
        let merged = merge(incoming, others, unarchive);
        entries.insert(0, merged.clone());
        sort_newest_first(&mut entries);
        keep_cap(&mut entries, &merged.key);
        write(base, &fitted_text(&mut entries, &groups, Some(&merged.key))?)?;
        Ok(merged)
    })
}

/// Refused with TOO_MANY_CURATED when `after`, in place of `before` in
/// `entries`, would be one protected entry more than MAX_CURATED.
fn room_to_protect(entries: &[Entry], before: &Entry, after: &Entry) -> Result<(), String> {
    if after.is_protected()
        && !before.is_protected()
        && entries.iter().filter(|e| e.is_protected()).count() >= MAX_CURATED
    {
        return Err(TOO_MANY_CURATED.to_string());
    }
    Ok(())
}

/// Change what the user curated of the entry under `key`: the fields of
/// `changes` (`changes_from`), and nothing else — not its last use, nor where
/// it is in the list. The entry as kept, or none when there is no such
/// entry.
///
/// Refused with INVALID, before the disk is touched, for changes that are
/// not valid, and once the file is read for a `groupId` that names no group
/// there; with TOO_MANY_CURATED when it would protect one entry more than
/// MAX_CURATED; with NEWER_VERSION for a newer file. A refusal changes nothing.
pub fn update(base: &Path, key: &str, changes: &Value) -> Result<Option<Entry>, String> {
    let changes = changes_from(changes).map_err(|why| format!("{INVALID}: {why}"))?;
    with_history(base, |stored| {
        let History { mut entries, groups, .. } = writable(base, stored)?;
        let Some(at) = entries.iter().position(|e| e.key == key) else {
            return Ok(None);
        };
        if let Some(Some(id)) = &changes.group_id {
            if groups.iter().all(|g| g.id != *id) {
                return Err(format!("{INVALID}: its groupId names no group"));
            }
        }
        let mut entry = entries[at].clone();
        if let Some(name) = changes.name {
            entry.name = name;
        }
        if let Some(pinned) = changes.pinned {
            entry.pinned = pinned;
        }
        if let Some(archived) = changes.archived {
            entry.archived = archived;
        }
        if let Some(group_id) = changes.group_id {
            entry.group_id = group_id;
        }
        room_to_protect(&entries, &entries[at], &entry)?;
        entries[at] = entry.clone();
        write(base, &fitted_text(&mut entries, &groups, Some(key))?)?;
        Ok(Some(entry))
    })
}

/// Add `group` (the page's `{id, name}`, `new_group_from`) after the others,
/// its list not folded, and when `move_key` names an entry, put that entry
/// in it in the same write; a `move_key` that names none moves nothing. The
/// group as kept.
///
/// Refused with INVALID_GROUP, before the disk is touched, for a group that
/// is not valid, and once the file is read for an id another group has; with
/// TOO_MANY_GROUPS for one past MAX_GROUPS; with TOO_MANY_CURATED when the
/// entry moved would be one protected entry more than MAX_CURATED; with
/// NEWER_VERSION for a newer file. A refusal changes nothing.
pub fn group_create(base: &Path, group: &Value, move_key: Option<&str>) -> Result<Group, String> {
    let group = new_group_from(group).map_err(|why| format!("{INVALID_GROUP}: {why}"))?;
    with_history(base, |stored| {
        let History { mut entries, mut groups, .. } = writable(base, stored)?;
        if groups.iter().any(|g| g.id == group.id) {
            return Err(format!("{INVALID_GROUP}: another group has its id"));
        }
        if groups.len() >= MAX_GROUPS {
            return Err(TOO_MANY_GROUPS.to_string());
        }
        let moved = move_key.and_then(|key| entries.iter().position(|e| e.key == key));
        if let Some(at) = moved {
            let mut entry = entries[at].clone();
            entry.group_id = Some(group.id.clone());
            room_to_protect(&entries, &entries[at], &entry)?;
            entries[at] = entry;
        }
        groups.push(group.clone());
        let written = moved.map(|at| entries[at].key.clone());
        write(base, &fitted_text(&mut entries, &groups, written.as_deref())?)?;
        Ok(group)
    })
}

/// Rename the group `id`, or fold or unfold its list: the fields of
/// `changes` (`group_changes_from`). The group as kept, or none when there
/// is no such group.
///
/// Refused with INVALID_GROUP, before the disk is touched, for an id or
/// changes that are not valid; with NEWER_VERSION for a newer file.
pub fn group_update(base: &Path, id: &str, changes: &Value) -> Result<Option<Group>, String> {
    if !is_group_id(id) {
        return Err(format!("{INVALID_GROUP}: {BAD_ID}"));
    }
    let changes = group_changes_from(changes).map_err(|why| format!("{INVALID_GROUP}: {why}"))?;
    with_history(base, |stored| {
        let History { mut entries, mut groups, .. } = writable(base, stored)?;
        let Some(group) = groups.iter_mut().find(|g| g.id == id) else {
            return Ok(None);
        };
        if let Some(name) = changes.name {
            group.name = name;
        }
        if let Some(collapsed) = changes.collapsed {
            group.collapsed = collapsed;
        }
        let group = group.clone();
        write(base, &fitted_text(&mut entries, &groups, None)?)?;
        Ok(Some(group))
    })
}

/// Delete the group `id`. Its entries are kept, in no group, and otherwise
/// as they were. How many there were, or none when there is no such group.
///
/// Refused with INVALID_GROUP, before the disk is touched, for an id that is
/// not valid; with NEWER_VERSION for a newer file.
pub fn group_delete(base: &Path, id: &str) -> Result<Option<u32>, String> {
    if !is_group_id(id) {
        return Err(format!("{INVALID_GROUP}: {BAD_ID}"));
    }
    with_history(base, |stored| {
        let History { mut entries, mut groups, .. } = writable(base, stored)?;
        let Some(at) = groups.iter().position(|g| g.id == id) else {
            return Ok(None);
        };
        groups.remove(at);
        let mut ungrouped: usize = 0;
        for entry in entries.iter_mut().filter(|e| e.group_id.as_deref() == Some(id)) {
            entry.group_id = None;
            ungrouped += 1;
        }
        write(base, &fitted_text(&mut entries, &groups, None)?)?;
        Ok(Some(u32::try_from(ungrouped).unwrap_or(u32::MAX)))
    })
}

/// Delete the entry under `key`. Whether there was one.
pub fn remove(base: &Path, key: &str) -> Result<bool, String> {
    with_history(base, |stored| {
        let History { mut entries, groups, .. } = writable(base, stored)?;
        let Some(at) = entries.iter().position(|e| e.key == key) else {
            return Ok(false);
        };
        entries.remove(at);
        write(base, &fitted_text(&mut entries, &groups, None)?)?;
        Ok(true)
    })
}

/// Empty the history, every kind's entries and every group included — what
/// is left is the version 1 empty history — and delete the files moved
/// aside: they are copies of what it held, titles and folders and all, and a
/// history the user cleared keeps no copies. How many entries went — the
/// entries of the file that was read, not of those copies. A refused clear
/// (a newer file) touches neither.
///
/// A copy that cannot be deleted, after DELETE_TRIES, fails the clear with
/// COPIES_LEFT (`copies_left`) once every other one has gone: the history is
/// empty, but it is not cleared as the user asked, and the page says so.
pub fn clear(base: &Path) -> Result<u32, String> {
    with_history(base, |stored| {
        let History { entries, .. } = writable(base, stored)?;
        write(base, &document_text(&[], &[])?)?;
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

    /// AC27: version 3 is the first newer one, now that this build writes 2.
    #[test]
    fn a_newer_file_is_read_and_never_written() {
        let scratch = Scratch::new("newer");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        let mut pinned = entry("claude", Some(CLAUDE_A), "/w", None, 1, 5);
        pinned["pinned"] = json!(true);
        pinned["groupId"] = json!("g1");
        let bytes = serde_json::to_vec(&json!({"version": 3, "entries": [
            pinned,
            {"kind": "claude", "shape": "of version 3"},
        ], "groups": [{"id": "g1", "name": "Kept", "collapsed": true}, {"id": "g2", "shape": "of version 3"}], "more": true}))
        .unwrap();
        fs::write(scratch.file(), &bytes).unwrap();

        let listed = list(&base).unwrap();
        assert_eq!(keys(&listed), vec![format!("claude:{CLAUDE_A}")], "what it can read");
        assert!(listed[0].pinned && listed[0].group_id.as_deref() == Some("g1"), "with what was curated of it");
        assert_eq!(
            groups(&base).unwrap(),
            GroupList { version: 3, read_only: true, groups: vec![Group { id: "g1".into(), name: "Kept".into(), collapsed: true }] },
            "the groups it can read, and that it is read only"
        );
        assert_eq!(fs::read(scratch.file()).unwrap(), bytes, "untouched by a list and by groups");

        let refused = upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", None, 1, 1), None).unwrap_err();
        assert!(refused.starts_with(NEWER_VERSION), "{refused}");
        assert!(refused.contains("format version 3"), "{refused}");
        let key = format!("claude:{CLAUDE_A}");
        for refused in [
            upsert_with(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 1, 9), None, true).map(drop),
            update(&base, &key, &json!({"name": "Mine"})).map(drop),
            update(&base, "claude:nothing-here", &json!({"pinned": true})).map(drop),
            group_create(&base, &json!({"id": "g3", "name": "New"}), Some(&key)).map(drop),
            group_update(&base, "g1", &json!({"collapsed": false})).map(drop),
            group_delete(&base, "g1").map(drop),
            remove(&base, &key).map(drop),
            clear(&base).map(drop),
        ] {
            let why = refused.unwrap_err();
            assert!(why.starts_with(NEWER_VERSION), "{why}");
        }
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
        assert!(document_text(&one_more, &[]).unwrap().len() as u64 > MAX_READ_BYTES);
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
        let claude_fork = "its forkOf is not one that claude gives a conversation";
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
            // The conversation it was forked from: its kind's shape, as its own id.
            (with(&good, "forkOf", json!("x; curl a | sh")), claude_fork),
            (with(&good, "forkOf", json!(CLAUDE_B.to_uppercase())), claude_fork),
            (with(&good, "forkOf", json!(OPENCODE_A)), claude_fork),
            (with(&good, "forkOf", json!("")), claude_fork),
            (with(&good, "forkOf", json!(7)), claude_fork),
            (with(&good, "forkOf", json!([CLAUDE_B])), claude_fork),
            (with(&good, "forkOf", json!({"sessionId": CLAUDE_B})), claude_fork),
            (with(&good, "forkOf", json!(format!("{CLAUDE_B}\n"))), claude_fork),
            (with(&opencode, "forkOf", json!(CLAUDE_B)), "its forkOf is not one that opencode gives a conversation"),
            (with(&opencode, "forkOf", json!("ses_1234567")), "its forkOf is not one that opencode gives a conversation"),
            (with(&other, "forkOf", json!("a".repeat(MAX_OTHER_ID_CHARS + 1))), "its forkOf is not one that agy gives a conversation"),
            // Every other field first: a fork refused for its forkOf is one
            // whose nine fields are what this build would have written.
            (with(&with(&good, "forkOf", json!("bad")), "endReason", json!("killed")), "its endReason is neither exited nor closed"),
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
        let newer = br#"{"version":3,"entries":[]}"#;
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

    // ---- Fork Conversation: the conversation a fork was forked from -----------------------------------

    /// A fork of CLAUDE_A recorded as CLAUDE_B, as the page writes it when
    /// the fork is typed (src/lib/agentHistory.js `entryOfAgent`).
    fn fork(started: u64, used: u64) -> Value {
        let mut e = entry("claude", Some(CLAUDE_B), "/w", None, started, used);
        e["forkOf"] = json!(CLAUDE_A);
        e
    }

    /// The source (`write_two`'s Claude Code entry, used at 4) and its fork,
    /// used at 6: the fork's `forkOf` after its nine fields, the source as
    /// it always was, and still version 1.
    const FORK_TEXT: &str = r#"{
  "version": 1,
  "entries": [
    {
      "key": "claude:7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "kind": "claude",
      "sessionId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "cwd": "/w",
      "title": null,
      "startedAt": 5,
      "lastUsedAt": 6,
      "endedAt": null,
      "endReason": null,
      "forkOf": "0f8fad5b-d9cb-469f-a165-70867728950e"
    },
    {
      "key": "claude:0f8fad5b-d9cb-469f-a165-70867728950e",
      "kind": "claude",
      "sessionId": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "cwd": "/w",
      "title": null,
      "startedAt": 3,
      "lastUsedAt": 4,
      "endedAt": null,
      "endReason": null
    }
  ]
}
"#;

    #[test]
    fn a_fork_keeps_the_conversation_it_was_forked_from_and_stays_version_1() {
        let scratch = Scratch::new("fork-of");
        let base = scratch.base();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 3, 4), None).unwrap();
        let kept = upsert(&base, &fork(5, 6), None).unwrap();
        assert_eq!(kept.fork_of.as_deref(), Some(CLAUDE_A));
        assert_eq!(kept.key, format!("claude:{CLAUDE_B}"), "keyed by its own id, not the source's");
        assert!(!kept.is_curated(), "a link is not curation");
        assert_eq!(text(&scratch), FORK_TEXT);
        let listed = list(&base).unwrap();
        assert_eq!(listed[0].fork_of.as_deref(), Some(CLAUDE_A));
        assert_eq!(listed[1].fork_of, None, "the source is left as it was");
        assert_eq!(serde_json::to_value(&listed[0]).unwrap().as_object().unwrap().len(), 10);
        assert_eq!(serde_json::to_value(&listed[1]).unwrap().as_object().unwrap().len(), 9, "handed to the page as before");
        assert_eq!(groups(&base).unwrap().version, 1);

        // Later events of the fork send none: the link stays — an end, a
        // title from the transcript, a resume that names it null.
        let mut ended = entry("claude", Some(CLAUDE_B), "/w", None, 5, 7);
        ended["endedAt"] = json!(7);
        ended["endReason"] = json!("exited");
        assert_eq!(upsert(&base, &ended, None).unwrap().fork_of.as_deref(), Some(CLAUDE_A));
        let titled = upsert(&base, &entry("claude", Some(CLAUDE_B), "/w", Some("From the transcript"), 5, 8), None).unwrap();
        assert_eq!(titled.fork_of.as_deref(), Some(CLAUDE_A));
        let mut resumed = entry("claude", Some(CLAUDE_B), "/w", None, 9, 9);
        resumed["forkOf"] = Value::Null;
        let resumed = upsert(&base, &resumed, None).unwrap();
        assert_eq!((resumed.fork_of.as_deref(), resumed.title.as_deref()), (Some(CLAUDE_A), Some("From the transcript")));
        assert_eq!(document(&scratch)["version"], json!(1), "never version 2 by itself");

        // Curated, it is version 2, with the link between the nine and the
        // curated fields; uncurated again, version 1 with the link.
        let key = format!("claude:{CLAUDE_B}");
        update(&base, &key, &json!({"pinned": true})).unwrap();
        let pinned = text(&scratch);
        assert!(pinned.starts_with("{\n  \"version\": 2,"), "{pinned}");
        assert!(pinned.contains(&format!("\"endReason\": null,\n      \"forkOf\": \"{CLAUDE_A}\",\n      \"pinned\": true\n")), "{pinned}");
        update(&base, &key, &json!({"pinned": false})).unwrap();
        assert_eq!(document(&scratch)["version"], json!(1));
        assert_eq!(document(&scratch)["entries"][0]["forkOf"], json!(CLAUDE_A));
        assert_eq!(list(&base).unwrap()[0].fork_of.as_deref(), Some(CLAUDE_A), "a curation keeps it too");

        // The newest that names one wins.
        let mut again = entry("claude", Some(CLAUDE_B), "/w", None, 9, 10);
        again["forkOf"] = json!("d4bef4d0-c043-40ef-b157-640fb31ac0ea");
        assert_eq!(upsert(&base, &again, None).unwrap().fork_of.as_deref(), Some("d4bef4d0-c043-40ef-b157-640fb31ac0ea"));
    }

    #[test]
    fn no_fork_of_is_written_as_nothing_and_each_kind_has_its_own_shape() {
        let scratch = Scratch::new("fork-of-none");
        let base = scratch.base();
        // A page that sends `forkOf: null` for every entry writes 0.26.0's text.
        let mut ended = entry("opencode", Some(OPENCODE_A), "/w", Some("Title"), 1, 2);
        ended["endedAt"] = json!(2);
        ended["endReason"] = json!("closed");
        ended["forkOf"] = Value::Null;
        upsert(&base, &ended, None).unwrap();
        let mut claude = entry("claude", Some(CLAUDE_A), "/w", None, 3, 4);
        claude["forkOf"] = Value::Null;
        upsert(&base, &claude, None).unwrap();
        assert_eq!(text(&scratch), V1_TEXT, "byte for byte the nine-field version 1");

        // Each kind's own shape: an OpenCode fork names an OpenCode
        // conversation; a kind this build does not know, a line of text.
        let mut opencode = entry("opencode", Some("ses_0123456789abcdefGHIJKLMNop"), "/w", None, 5, 5);
        opencode["forkOf"] = json!(OPENCODE_A);
        assert_eq!(upsert(&base, &opencode, None).unwrap().fork_of.as_deref(), Some(OPENCODE_A));
        let mut other = entry("agy", Some("agy-2"), "/w", None, 6, 6);
        other["forkOf"] = json!("agy 1 of a line");
        assert_eq!(upsert(&base, &other, None).unwrap().fork_of.as_deref(), Some("agy 1 of a line"));
        // A fork whose own id is not known yet may still name its source.
        let mut provisional = entry("claude", None, "/x", None, 7, 7);
        provisional["forkOf"] = json!(CLAUDE_A);
        assert_eq!(upsert(&base, &provisional, None).unwrap().fork_of.as_deref(), Some(CLAUDE_A));
    }

    #[test]
    fn a_malformed_fork_of_is_refused_on_write_and_its_entry_dropped_on_read() {
        let scratch = Scratch::new("fork-of-bad");
        let base = scratch.base();
        for bad in [json!("x; curl a | sh"), json!(CLAUDE_A.to_uppercase()), json!(OPENCODE_A), json!(""), json!(1), json!([CLAUDE_A])] {
            let mut e = fork(1, 1);
            e["forkOf"] = bad.clone();
            assert_eq!(
                upsert(&base, &e, None).unwrap_err(),
                format!("{INVALID}: its forkOf is not one that claude gives a conversation"),
                "{bad}"
            );
        }
        assert!(!base.exists(), "nothing was made for a refused write");
        fs::create_dir_all(&base).unwrap();
        let mut malformed = entry("claude", Some(CLAUDE_A), "/w", None, 1, 9);
        malformed["forkOf"] = json!("x; curl a | sh");
        let file = json!({"version": 1, "entries": [malformed, fork(1, 5), entry("opencode", Some(OPENCODE_A), "/w", None, 1, 3)]});
        fs::write(scratch.file(), serde_json::to_vec(&file).unwrap()).unwrap();
        let listed = list(&base).unwrap();
        assert_eq!(keys(&listed), vec![format!("claude:{CLAUDE_B}"), format!("opencode:{OPENCODE_A}")], "dropped, the rest kept");
        assert_eq!(listed[0].fork_of.as_deref(), Some(CLAUDE_A));
        assert!(scratch.bad().is_empty(), "the file is not moved aside for one entry");
        assert_eq!(document(&scratch), file, "nor rewritten by a list");
    }

    // ---- AC25: version 2, and only once something is curated -----------------------------------------

    /// What NexTerm 0.26.0 (fe24af1) writes for the two entries `write_two`
    /// records, byte for byte: its nine fields in its order, pretty-printed
    /// with two spaces, and a line end at the end.
    const V1_TEXT: &str = r#"{
  "version": 1,
  "entries": [
    {
      "key": "claude:0f8fad5b-d9cb-469f-a165-70867728950e",
      "kind": "claude",
      "sessionId": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "cwd": "/w",
      "title": null,
      "startedAt": 3,
      "lastUsedAt": 4,
      "endedAt": null,
      "endReason": null
    },
    {
      "key": "opencode:ses_ef45006f5ffeAMtumN5ySj4VmT",
      "kind": "opencode",
      "sessionId": "ses_ef45006f5ffeAMtumN5ySj4VmT",
      "cwd": "/w",
      "title": "Title",
      "startedAt": 1,
      "lastUsedAt": 2,
      "endedAt": 2,
      "endReason": "closed"
    }
  ]
}
"#;

    /// The same two entries with every field there is curated (`curate_two`):
    /// the curated fields after the nine, each only when it is not at its
    /// default, and the groups after the entries.
    const V2_TEXT: &str = r#"{
  "version": 2,
  "entries": [
    {
      "key": "claude:0f8fad5b-d9cb-469f-a165-70867728950e",
      "kind": "claude",
      "sessionId": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "cwd": "/w",
      "title": null,
      "startedAt": 3,
      "lastUsedAt": 4,
      "endedAt": null,
      "endReason": null,
      "name": "Mine",
      "pinned": true,
      "archived": true,
      "groupId": "g1"
    },
    {
      "key": "opencode:ses_ef45006f5ffeAMtumN5ySj4VmT",
      "kind": "opencode",
      "sessionId": "ses_ef45006f5ffeAMtumN5ySj4VmT",
      "cwd": "/w",
      "title": "Title",
      "startedAt": 1,
      "lastUsedAt": 2,
      "endedAt": 2,
      "endReason": "closed",
      "name": "Theirs",
      "groupId": "g2"
    }
  ],
  "groups": [
    {
      "id": "g1",
      "name": "Work",
      "collapsed": true
    },
    {
      "id": "g2",
      "name": "Play",
      "collapsed": false
    }
  ]
}
"#;

    /// An OpenCode conversation that ended, then a Claude Code one still running.
    fn write_two(base: &Path) {
        let mut ended = entry("opencode", Some(OPENCODE_A), "/w", Some("Title"), 1, 2);
        ended["endedAt"] = json!(2);
        ended["endReason"] = json!("closed");
        upsert(base, &ended, None).unwrap();
        upsert(base, &entry("claude", Some(CLAUDE_A), "/w", None, 3, 4), None).unwrap();
    }

    /// `write_two`'s entries curated with every field, through the operations.
    fn curate_two(base: &Path) {
        let (claude, opencode) = (format!("claude:{CLAUDE_A}"), format!("opencode:{OPENCODE_A}"));
        group_create(base, &json!({"id": "g1", "name": "Work"}), Some(&claude)).unwrap();
        group_create(base, &json!({"id": "g2", "name": "Play"}), Some(&opencode)).unwrap();
        group_update(base, "g1", &json!({"collapsed": true})).unwrap();
        update(base, &claude, &json!({"name": "Mine", "pinned": true, "archived": true})).unwrap();
        update(base, &opencode, &json!({"name": "Theirs"})).unwrap();
    }

    fn text(scratch: &Scratch) -> String {
        fs::read_to_string(scratch.file()).unwrap()
    }

    /// `document` as the file, written by hand.
    fn put(scratch: &Scratch, document: &Value) {
        fs::create_dir_all(scratch.base()).unwrap();
        fs::write(scratch.file(), serde_json::to_vec(document).unwrap()).unwrap();
    }

    fn curation(e: &Entry) -> (Option<&str>, bool, bool, Option<&str>) {
        (e.name.as_deref(), e.pinned, e.archived, e.group_id.as_deref())
    }

    #[test]
    fn an_uncurated_history_is_written_byte_for_byte_as_0_26_0_writes_it() {
        let scratch = Scratch::new("golden-v1");
        let base = scratch.base();
        write_two(&base);
        assert_eq!(text(&scratch), V1_TEXT);
        // A file 0.26.0 wrote is written back as it was.
        fs::write(scratch.file(), V1_TEXT).unwrap();
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 3, 4), None).unwrap();
        assert_eq!(text(&scratch), V1_TEXT, "the same event again changes no byte");
    }

    #[test]
    fn a_version_1_file_is_read_with_nothing_curated_and_no_groups() {
        let scratch = Scratch::new("read-v1");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        fs::write(scratch.file(), V1_TEXT).unwrap();
        let listed = list(&base).unwrap();
        assert_eq!(listed.len(), 2);
        for e in &listed {
            assert_eq!(curation(e), (None, false, false, None), "{}", e.key);
            let answered = serde_json::to_value(e).unwrap();
            assert_eq!(answered.as_object().unwrap().len(), 9, "handed to the page as 0.26.0 hands it: {answered}");
        }
        assert_eq!(groups(&base).unwrap(), GroupList { version: 1, read_only: false, groups: Vec::new() });
        assert_eq!(text(&scratch), V1_TEXT, "neither read writes it");
    }

    #[test]
    fn pinning_writes_version_2_and_unpinning_version_1_again() {
        let scratch = Scratch::new("pin-v2");
        let base = scratch.base();
        write_two(&base);
        let claude = format!("claude:{CLAUDE_A}");
        assert!(update(&base, &claude, &json!({"pinned": true})).unwrap().unwrap().pinned);
        let written = document(&scratch);
        assert_eq!(written["version"], json!(2));
        assert_eq!(written["groups"], json!([]), "with its list of groups, empty");
        assert_eq!(written["entries"][0]["pinned"], json!(true));
        assert!(written["entries"][1].get("pinned").is_none(), "on that entry only");
        assert_eq!(groups(&base).unwrap().version, 2);
        update(&base, &claude, &json!({"pinned": false})).unwrap();
        assert_eq!(text(&scratch), V1_TEXT, "nothing curated: version 1 again, byte for byte");
        assert_eq!(groups(&base).unwrap().version, 1);

        // Each curated field alone makes it version 2, archived too.
        for change in [json!({"name": "Mine"}), json!({"archived": true})] {
            update(&base, &claude, &change).unwrap();
            assert_eq!(document(&scratch)["version"], json!(2), "{change}");
        }
        update(&base, &claude, &json!({"name": null, "archived": false})).unwrap();
        assert_eq!(text(&scratch), V1_TEXT);
        group_create(&base, &json!({"id": "g1", "name": "Work"}), Some(&claude)).unwrap();
        assert_eq!(document(&scratch)["entries"][0]["groupId"], json!("g1"));
        update(&base, &claude, &json!({"groupId": null})).unwrap();
        assert_eq!(document(&scratch)["version"], json!(2), "a group with no one in it keeps it version 2");
        assert_eq!(document(&scratch)["groups"], json!([{"id": "g1", "name": "Work", "collapsed": false}]));
        group_delete(&base, "g1").unwrap();
        assert_eq!(text(&scratch), V1_TEXT);
    }

    /// AC25 (5): what NexTerm 0.26.0's `parse` (fe24af1, :462-487) and
    /// `entry_from` ask of a file to read it as a newer one, which it lists
    /// and never writes.
    #[test]
    fn a_version_2_file_is_one_that_0_26_0_reads_as_newer() {
        let scratch = Scratch::new("v2-for-0.26.0");
        let base = scratch.base();
        write_two(&base);
        curate_two(&base);
        let written = text(&scratch);
        assert_eq!(written, V2_TEXT);
        assert!(written.len() as u64 <= MAX_READ_BYTES);
        assert!(
            written.starts_with("{\n  \"version\": 2,\n  \"entries\": [\n") && written.contains("\n  ],\n  \"groups\": [\n"),
            "version, entries, groups: in that order"
        );
        let read: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(read.as_object().unwrap().len(), 3, "and nothing else");
        let version = read["version"].as_u64().unwrap();
        assert!(version > 1 && version <= MAX_INTEGER, "above 0.26.0's own: a newer file to it");
        let entries = read["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        for e in entries {
            let mut nine = e.clone();
            for field in ["name", "pinned", "archived", "groupId"] {
                nine.as_object_mut().unwrap().remove(field);
            }
            assert_eq!(nine.as_object().unwrap().len(), 9);
            // `entry_from` asks what 0.26.0's asked, unchanged.
            assert!(entry_from(&nine).is_ok(), "{nine}");
        }
    }

    /// AC27: and this build reads and writes one.
    #[test]
    fn this_build_reads_and_writes_a_version_2_file() {
        let scratch = Scratch::new("v2-read-write");
        let base = scratch.base();
        fs::create_dir_all(&base).unwrap();
        fs::write(scratch.file(), V2_TEXT).unwrap();
        let listed = list(&base).unwrap();
        assert_eq!(curation(&listed[0]), (Some("Mine"), true, true, Some("g1")));
        assert_eq!(curation(&listed[1]), (Some("Theirs"), false, false, Some("g2")));
        let read = groups(&base).unwrap();
        assert_eq!((read.version, read.read_only, read.groups.len()), (2, false, 2));
        assert_eq!(text(&scratch), V2_TEXT, "not written by a read");
        let kept = upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 3, 4), None).unwrap();
        assert_eq!(curation(&kept), (Some("Mine"), true, true, Some("g1")));
        assert_eq!(text(&scratch), V2_TEXT, "written back as it was");
    }

    // ---- AC26: what is refused of what the user curated ----------------------------------------------

    /// Every curated field `stored_entry_from` refuses in the file, and why;
    /// `update` refuses each with the same words. Replayed against the
    /// browser mock by the contract (`contract_tests`).
    pub(super) fn curated_refused_cases() -> Vec<(&'static str, Value, String)> {
        let name = bad_name();
        let mut cases: Vec<(&'static str, Value, String)> = vec![
            ("name", json!("n".repeat(MAX_NAME_CHARS + 1)), name.clone()),
            ("name", json!("é".repeat(MAX_NAME_CHARS + 1)), name.clone()),
            ("name", json!(5), name.clone()),
            ("name", json!(true), name.clone()),
            ("name", json!(["Mine"]), name.clone()),
            ("name", json!({"text": "Mine"}), name.clone()),
            ("pinned", json!("yes"), BAD_PINNED.to_string()),
            ("pinned", json!(1), BAD_PINNED.to_string()),
            ("pinned", json!(0), BAD_PINNED.to_string()),
            ("pinned", json!([true]), BAD_PINNED.to_string()),
            ("archived", json!("no"), BAD_ARCHIVED.to_string()),
            ("archived", json!(1), BAD_ARCHIVED.to_string()),
            ("archived", json!({}), BAD_ARCHIVED.to_string()),
            ("groupId", json!(""), BAD_GROUP_ID.to_string()),
            ("groupId", json!("has space"), BAD_GROUP_ID.to_string()),
            ("groupId", json!("g".repeat(MAX_GROUP_ID_CHARS + 1)), BAD_GROUP_ID.to_string()),
            ("groupId", json!("grüppe"), BAD_GROUP_ID.to_string()),
            ("groupId", json!("g/1"), BAD_GROUP_ID.to_string()),
            ("groupId", json!("g1\n"), BAD_GROUP_ID.to_string()),
            ("groupId", json!(7), BAD_GROUP_ID.to_string()),
            ("groupId", json!(["g1"]), BAD_GROUP_ID.to_string()),
        ];
        // Every class of character a title is refused with: C0, DEL, C1, the
        // line and paragraph separators, and the bidi controls.
        for c in ['\u{0}', '\u{9}', '\u{a}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}', '\u{2028}', '\u{2029}', '\u{202a}', '\u{202e}', '\u{2066}', '\u{2069}'] {
            cases.push(("name", json!(format!("a{c}b")), name.clone()));
        }
        cases
    }

    #[test]
    fn a_curated_field_of_the_wrong_shape_drops_its_entry_and_is_refused() {
        let scratch = Scratch::new("curated-refused");
        let base = scratch.base();
        let key = format!("claude:{CLAUDE_A}");
        for (field, value, why) in curated_refused_cases() {
            let mut changes = json!({});
            changes[field] = value.clone();
            assert_eq!(update(&base, &key, &changes).unwrap_err(), format!("{INVALID}: {why}"), "{field}: {value}");
        }
        for (changes, why) in [
            (json!(null), "the changes are not an object"),
            (json!([]), "the changes are not an object"),
            (json!("pin"), "the changes are not an object"),
            (json!({"title": "Mine"}), "a change names something other than name, pinned, archived and groupId"),
            (json!({"pinned": true, "key": "claude:x"}), "a change names something other than name, pinned, archived and groupId"),
            (json!({"pinned": null}), BAD_PINNED),
            (json!({"archived": null}), BAD_ARCHIVED),
        ] {
            assert_eq!(update(&base, &key, &changes).unwrap_err(), format!("{INVALID}: {why}"), "{changes}");
        }
        assert!(!base.exists(), "nothing was made for a refused update");

        // In the file: that entry is dropped, the rest kept, nothing moved aside.
        let good = entry("claude", Some(CLAUDE_A), "/w", None, 1, 5);
        let mut cases: Vec<(&str, Value)> = curated_refused_cases().into_iter().map(|(field, value, _)| (field, value)).collect();
        cases.push(("name", json!("")));
        for (field, value) in cases {
            let mut bad = entry("opencode", Some(OPENCODE_A), "/w", None, 1, 9);
            bad[field] = value.clone();
            put(&scratch, &json!({"version": 2, "entries": [good, bad], "groups": [{"id": "g1", "name": "G"}]}));
            assert_eq!(keys(&list(&base).unwrap()), vec![key.clone()], "{field}: {value}");
        }
        assert!(scratch.bad().is_empty(), "none of them moved the file aside");

        // Null is each one's default in the file, as a missing field is; and
        // the bounds themselves are kept.
        let mut nulls = good.clone();
        for field in ["name", "pinned", "archived", "groupId"] {
            nulls[field] = json!(null);
        }
        let mut longest = entry("opencode", Some(OPENCODE_A), "/w", None, 1, 9);
        longest["name"] = json!("é".repeat(MAX_NAME_CHARS));
        longest["groupId"] = json!(format!("{}{}", "Az09_-".repeat(10), "abcd"));
        longest["pinned"] = json!(false);
        put(&scratch, &json!({"version": 2, "entries": [nulls, longest], "groups": [{"id": format!("{}{}", "Az09_-".repeat(10), "abcd"), "name": "n".repeat(MAX_GROUP_NAME_CHARS)}]}));
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), 2);
        assert_eq!(curation(&kept[0]).1, false);
        assert_eq!(kept[0].name.as_ref().map(|n| n.chars().count()), Some(MAX_NAME_CHARS));
        assert_eq!(kept[0].group_id.as_ref().map(String::len), Some(MAX_GROUP_ID_CHARS));
        assert_eq!(curation(&kept[1]), (None, false, false, None), "all null: nothing curated");
        assert!(scratch.bad().is_empty());
    }

    /// A file's `groups` with every way a group is dropped by itself: of the
    /// fifty-five valid ones with ids of their own, `ok-1` to `ok-55`, the
    /// first fifty are kept. Replayed against the browser mock by the
    /// contract (`contract_tests`).
    pub(super) fn group_cases() -> Vec<Value> {
        let mut groups = vec![
            json!({"id": "ok-1", "name": "First", "collapsed": true}),
            json!({"id": "has space", "name": "Bad id"}),
            json!({"id": "", "name": "Empty id"}),
            json!({"id": 7, "name": "A number for an id"}),
            json!({"name": "No id"}),
            json!({"id": "bad-name-1", "name": ""}),
            json!({"id": "bad-name-2", "name": "n".repeat(MAX_GROUP_NAME_CHARS + 1)}),
            json!({"id": "bad-name-3", "name": "a\u{202e}b"}),
            json!({"id": "bad-name-4", "name": 5}),
            json!({"id": "bad-name-5"}),
            json!({"id": "bad-collapsed", "name": "C", "collapsed": "yes"}),
            json!({"id": "ok-1", "name": "The same id"}),
            json!("not a group"),
            json!({"id": "ok-2", "name": "Second", "collapsed": null, "colour": "red"}),
        ];
        for n in 3..=55 {
            groups.push(json!({"id": format!("ok-{n}"), "name": format!("Group {n}")}));
        }
        groups
    }

    #[test]
    fn groups_are_read_leniently_and_never_move_the_file_aside() {
        let scratch = Scratch::new("groups-lenient");
        let base = scratch.base();
        let in_group = |id: &str, n: u64| {
            let mut e = entry("opencode", Some(&format!("ses_grp{n:05}")), "/w", None, n, n);
            e["groupId"] = json!(id);
            e
        };
        // A `groups` that is not a list: no groups; the entries are kept, in none.
        for not_a_list in [json!(null), json!({"g1": {"name": "G"}}), json!("g1"), json!(7)] {
            put(&scratch, &json!({"version": 2, "entries": [in_group("g1", 1)], "groups": not_a_list}));
            let kept = list(&base).unwrap();
            assert_eq!((kept.len(), kept[0].group_id.as_deref()), (1, None), "{not_a_list}");
            assert_eq!(groups(&base).unwrap().groups, Vec::<Group>::new());
        }
        put(&scratch, &json!({"version": 2, "entries": [in_group("g1", 1)]}));
        assert_eq!(list(&base).unwrap()[0].group_id, None, "nor when there is none");

        // Each group that is not one is dropped by itself, and so is one with
        // an id seen before, and every one past the fiftieth kept.
        let entries = vec![in_group("ok-1", 1), in_group("bad-name-1", 2), in_group("ok-51", 3), in_group("ok-50", 4)];
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": group_cases()}));
        let kept = groups(&base).unwrap();
        assert_eq!(kept.groups.len(), MAX_GROUPS);
        assert_eq!(kept.groups[0], Group { id: "ok-1".into(), name: "First".into(), collapsed: true });
        assert_eq!(kept.groups[1], Group { id: "ok-2".into(), name: "Second".into(), collapsed: false }, "null is not folded");
        assert_eq!(kept.groups[49].id, "ok-50");
        let by_key = |n: u64| list(&base).unwrap().into_iter().find(|e| e.key == format!("opencode:ses_grp{n:05}")).unwrap();
        assert_eq!(by_key(1).group_id.as_deref(), Some("ok-1"));
        assert_eq!(by_key(2).group_id, None, "its group was dropped: kept, in none");
        assert_eq!(by_key(3).group_id, None, "and the 51st");
        assert_eq!(by_key(4).group_id.as_deref(), Some("ok-50"));
        assert!(scratch.bad().is_empty(), "none of them moved the file aside");
        // The next write keeps what was read.
        upsert(&base, &entry("claude", Some(CLAUDE_A), "/w", None, 9, 9), None).unwrap();
        let written = document(&scratch);
        assert_eq!(written["groups"].as_array().unwrap().len(), MAX_GROUPS);
        assert_eq!(written["groups"][1], json!({"id": "ok-2", "name": "Second", "collapsed": false}));
    }

    // ---- AC28: a recorded event keeps what the user curated --------------------------------------------

    #[test]
    fn a_recorded_event_never_changes_what_the_user_curated() {
        let scratch = Scratch::new("merge-curation");
        let base = scratch.base();
        let key = format!("claude:{CLAUDE_A}");
        let at = |started: u64, used: u64| entry("claude", Some(CLAUDE_A), "/w", None, started, used);
        let ended = |mut e: Value, when: u64| {
            e["endedAt"] = json!(when);
            e["endReason"] = json!("exited");
            e
        };
        upsert(&base, &at(100, 100), None).unwrap();
        group_create(&base, &json!({"id": "g1", "name": "Work"}), Some(&key)).unwrap();
        update(&base, &key, &json!({"name": "Mine", "pinned": true, "archived": true})).unwrap();
        let curated = (Some("Mine"), true, true, Some("g1"));

        // (a) a new title: it changes underneath.
        let mut titled = at(100, 200);
        titled["title"] = json!("Fix the build");
        let kept = upsert(&base, &titled, None).unwrap();
        assert_eq!((kept.title.as_deref(), curation(&kept)), (Some("Fix the build"), curated), "(a)");
        // (b) an end.
        let kept = upsert(&base, &ended(at(100, 300), 300), None).unwrap();
        assert_eq!((kept.ended_at, curation(&kept)), (Some(300), curated), "(b)");
        // (c) a title from Claude Code's transcript, with the entry's own times (F16).
        let mut from_transcript = ended(at(100, 300), 300);
        from_transcript["title"] = json!("From the transcript");
        let kept = upsert(&base, &from_transcript, None).unwrap();
        assert_eq!((kept.title.as_deref(), kept.last_used_at, curation(&kept)), (Some("From the transcript"), 300, curated), "(c)");
        // (d) an incoming entry with curated fields of its own: not read, so
        // not refused either.
        let mut carrying = at(100, 400);
        carrying["name"] = json!("Other");
        carrying["pinned"] = json!(false);
        carrying["archived"] = json!(false);
        carrying["groupId"] = json!("g2");
        assert_eq!(curation(&upsert(&base, &carrying, None).unwrap()), curated, "(d)");
        let mut odd = at(100, 400);
        odd["pinned"] = json!("yes");
        odd["name"] = json!(5);
        assert_eq!(curation(&upsert(&base, &odd, None).unwrap()), curated, "(d), of no shape");
        assert_eq!(curation(&list(&base).unwrap()[0]), curated, "and in the file");

        // unarchive: archived cleared, and nothing else.
        let before = list(&base).unwrap()[0].clone();
        let kept = upsert_with(&base, &at(500, 500), None, true).unwrap();
        let mut expected = before.clone();
        expected.archived = false;
        expected.last_used_at = 500;
        expected.ended_at = None;
        expected.end_reason = None;
        assert_eq!(kept, expected);
        let kept = upsert_with(&base, &at(500, 600), None, true).unwrap();
        assert!(!kept.archived, "unarchiving one not archived changes nothing");
        // An entry that was never there, unarchived, is new and plain.
        let fresh = upsert_with(&base, &entry("opencode", Some(OPENCODE_A), "/w", None, 1, 1), None, true).unwrap();
        assert_eq!(curation(&fresh), (None, false, false, None));
    }

    #[test]
    fn a_provisional_entrys_curation_goes_with_it_when_it_is_replaced() {
        let scratch = Scratch::new("merge-replaces");
        let base = scratch.base();
        let provisional = upsert(&base, &entry("opencode", None, "/w", None, 100, 100), None).unwrap();
        group_create(&base, &json!({"id": "g1", "name": "Work"}), Some(&provisional.key)).unwrap();
        update(&base, &provisional.key, &json!({"name": "Mine", "archived": true})).unwrap();
        let learned =
            upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 100, 200), Some(&provisional.key)).unwrap();
        assert_eq!(keys(&list(&base).unwrap()), vec![learned.key.clone()], "one entry");
        assert_eq!(curation(&learned), (Some("Mine"), false, true, Some("g1")), "named and grouped, archived as it was");

        // Both curated: the entry under the key first, and pinned when either is.
        let provisional = upsert(&base, &entry("opencode", None, "/x", None, 300, 300), None).unwrap();
        group_create(&base, &json!({"id": "g2", "name": "Play"}), Some(&provisional.key)).unwrap();
        update(&base, &provisional.key, &json!({"name": "Provisional", "pinned": true, "archived": true})).unwrap();
        update(&base, &learned.key, &json!({"archived": false})).unwrap();
        let merged =
            upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 100, 400), Some(&provisional.key)).unwrap();
        assert_eq!(curation(&merged), (Some("Mine"), true, false, Some("g1")));
        // None under the key but the provisional's: its own.
        update(&base, &merged.key, &json!({"name": null, "groupId": null, "pinned": false})).unwrap();
        let provisional = upsert(&base, &entry("opencode", None, "/y", None, 500, 500), None).unwrap();
        update(&base, &provisional.key, &json!({"groupId": "g2"})).unwrap();
        let merged =
            upsert(&base, &entry("opencode", Some(OPENCODE_A), "/w", None, 100, 600), Some(&provisional.key)).unwrap();
        assert_eq!(curation(&merged), (None, false, false, Some("g2")));
    }

    // ---- AC29: the operations -------------------------------------------------------------------------

    #[test]
    fn update_changes_only_what_it_names() {
        let scratch = Scratch::new("update");
        let base = scratch.base();
        write_two(&base);
        let (claude, opencode) = (format!("claude:{CLAUDE_A}"), format!("opencode:{OPENCODE_A}"));
        let before = list(&base).unwrap();
        let kept = update(&base, &claude, &json!({"name": "Mine"})).unwrap().unwrap();
        let mut expected = before[0].clone();
        expected.name = Some("Mine".into());
        assert_eq!(kept, expected, "its name, and nothing else");
        // The older one changed stays where it is.
        update(&base, &opencode, &json!({"pinned": true, "archived": true})).unwrap();
        let after = list(&base).unwrap();
        assert_eq!(keys(&after), keys(&before), "not moved");
        assert_eq!(after[1].last_used_at, before[1].last_used_at, "not used");
        assert_eq!(curation(&after[1]), (None, true, true, None));
        // "" and null clear a name.
        for none in [json!(""), json!(null)] {
            update(&base, &claude, &json!({"name": "Mine"})).unwrap();
            assert_eq!(update(&base, &claude, &json!({"name": none})).unwrap().unwrap().name, None, "{none}");
        }
        // No change at all is the entry as it is.
        assert_eq!(update(&base, &claude, &json!({})).unwrap().unwrap(), list(&base).unwrap()[0]);
        // No such entry: none, and nothing written; nor for a group that is not there.
        let unchanged = text(&scratch);
        assert_eq!(update(&base, "claude:nothing-here", &json!({"pinned": true})).unwrap(), None);
        assert_eq!(update(&base, &claude, &json!({"groupId": "g1"})).unwrap_err(), format!("{INVALID}: its groupId names no group"));
        assert_eq!(text(&scratch), unchanged);
    }

    #[test]
    fn groups_are_made_renamed_folded_and_deleted() {
        let scratch = Scratch::new("group-ops");
        let base = scratch.base();
        write_two(&base);
        let (claude, opencode) = (format!("claude:{CLAUDE_A}"), format!("opencode:{OPENCODE_A}"));
        let work = group_create(&base, &json!({"id": "g1", "name": "Work", "collapsed": true, "colour": "red"}), None).unwrap();
        assert_eq!(work, Group { id: "g1".into(), name: "Work".into(), collapsed: false }, "not folded, whatever it says");
        let play = group_create(&base, &json!({"id": "g2", "name": "Play"}), Some(&claude)).unwrap();
        assert_eq!(groups(&base).unwrap().groups, vec![work.clone(), play.clone()], "after the others");
        assert_eq!(list(&base).unwrap()[0].group_id.as_deref(), Some("g2"), "moved in the same write");
        let empty = group_create(&base, &json!({"id": "g3", "name": "Empty"}), Some("claude:nothing-here")).unwrap();
        assert_eq!(groups(&base).unwrap().groups.last(), Some(&empty), "a move_key naming no entry moves nothing");

        for (group, why) in [
            (json!("g4"), "it is not an object".to_string()),
            (json!(null), "it is not an object".to_string()),
            (json!({"id": "has space", "name": "Work"}), BAD_ID.to_string()),
            (json!({"id": "g".repeat(MAX_GROUP_ID_CHARS + 1), "name": "Work"}), BAD_ID.to_string()),
            (json!({"id": 4, "name": "Work"}), BAD_ID.to_string()),
            (json!({"name": "Work"}), BAD_ID.to_string()),
            (json!({"id": "g4"}), bad_group_name()),
            (json!({"id": "g4", "name": ""}), bad_group_name()),
            (json!({"id": "g4", "name": "n".repeat(MAX_GROUP_NAME_CHARS + 1)}), bad_group_name()),
            (json!({"id": "g4", "name": "one\ntwo"}), bad_group_name()),
            (json!({"id": "g4", "name": "a\u{2066}b"}), bad_group_name()),
        ] {
            assert_eq!(group_create(&base, &group, None).unwrap_err(), format!("{INVALID_GROUP}: {why}"), "{group}");
        }
        assert_eq!(group_create(&base, &json!({"id": "g1", "name": "Again"}), None).unwrap_err(), format!("{INVALID_GROUP}: another group has its id"));

        let renamed = group_update(&base, "g1", &json!({"name": "Office"})).unwrap().unwrap();
        assert_eq!(renamed, Group { id: "g1".into(), name: "Office".into(), collapsed: false });
        let folded = group_update(&base, "g1", &json!({"collapsed": true})).unwrap().unwrap();
        assert_eq!(folded, Group { id: "g1".into(), name: "Office".into(), collapsed: true });
        assert_eq!(groups(&base).unwrap().groups[0], folded, "in the file");
        assert_eq!(group_update(&base, "g9", &json!({"collapsed": true})).unwrap(), None);
        for (id, changes, why) in [
            ("has space", json!({"collapsed": true}), BAD_ID.to_string()),
            ("", json!({"collapsed": true}), BAD_ID.to_string()),
            ("g1", json!(null), "the changes are not an object".to_string()),
            ("g1", json!({"id": "g5"}), "a change names something other than name and collapsed".to_string()),
            ("g1", json!({"name": null}), bad_group_name()),
            ("g1", json!({"name": ""}), bad_group_name()),
            ("g1", json!({"collapsed": "yes"}), BAD_COLLAPSED.to_string()),
            ("g1", json!({"collapsed": null}), BAD_COLLAPSED.to_string()),
        ] {
            assert_eq!(group_update(&base, id, &changes).unwrap_err(), format!("{INVALID_GROUP}: {why}"), "{id} {changes}");
        }

        // Deleted: how many were in it, and they are otherwise as they were.
        update(&base, &opencode, &json!({"groupId": "g2", "pinned": true})).unwrap();
        let before = list(&base).unwrap();
        assert_eq!(group_delete(&base, "g2").unwrap(), Some(2));
        let after = list(&base).unwrap();
        for (was, now) in before.iter().zip(&after) {
            let mut expected = was.clone();
            expected.group_id = None;
            assert_eq!(now, &expected);
        }
        assert!(groups(&base).unwrap().groups.iter().all(|g| g.id != "g2"));
        assert_eq!(group_delete(&base, "g2").unwrap(), None, "gone already");
        assert_eq!(group_delete(&base, "g3").unwrap(), Some(0), "an empty one");
        assert_eq!(group_delete(&base, "bad id").unwrap_err(), format!("{INVALID_GROUP}: {BAD_ID}"));
    }

    #[test]
    fn there_are_at_most_fifty_groups() {
        let scratch = Scratch::new("fifty-groups");
        let base = scratch.base();
        write_two(&base);
        for n in 0..MAX_GROUPS {
            group_create(&base, &json!({"id": format!("g{n}"), "name": format!("Group {n}")}), None).unwrap();
        }
        let unchanged = text(&scratch);
        let refused = group_create(&base, &json!({"id": "g50", "name": "One more"}), Some(&format!("claude:{CLAUDE_A}")));
        assert_eq!(refused.unwrap_err(), TOO_MANY_GROUPS);
        assert_eq!(text(&scratch), unchanged, "and nothing moved either");
        assert!(TOO_MANY_GROUPS.contains(&MAX_GROUPS.to_string()));
        group_delete(&base, "g0").unwrap();
        assert!(group_create(&base, &json!({"id": "g50", "name": "One more"}), None).is_ok(), "one deleted, one more");
    }

    #[test]
    fn clear_deletes_the_groups_and_leaves_the_version_1_empty_history() {
        let scratch = Scratch::new("clear-groups");
        let base = scratch.base();
        write_two(&base);
        fs::write(scratch.file(), "{not json").unwrap();
        assert!(list(&base).unwrap().is_empty());
        write_two(&base);
        curate_two(&base);
        assert_eq!(scratch.bad().len(), 1, "premise: a copy moved aside");
        assert_eq!(clear(&base).unwrap(), 2);
        assert_eq!(text(&scratch), "{\n  \"version\": 1,\n  \"entries\": []\n}\n");
        assert_eq!(groups(&base).unwrap(), GroupList { version: 1, read_only: false, groups: Vec::new() });
        assert!(scratch.bad().is_empty());
    }

    // ---- AC30: the cap and the fit protect what the user curated ---------------------------------------

    /// An unprotected OpenCode entry used at `used`.
    fn plain(n: u64, used: u64) -> Value {
        entry("opencode", Some(&format!("ses_cap{n:05}")), "/w", None, used, used)
    }

    #[test]
    fn the_cap_keeps_every_protected_entry_beside_the_newest_two_hundred() {
        let scratch = Scratch::new("cap-protected");
        let base = scratch.base();
        // Ten protected, older than every other: pinned, renamed, grouped.
        let mut entries = Vec::new();
        for n in 1..=10u64 {
            let mut e = entry("opencode", Some(&format!("ses_kept{n:05}")), "/w", None, n, n);
            match n {
                1..=4 => e["pinned"] = json!(true),
                5..=7 => e["name"] = json!(format!("Mine {n}")),
                _ => e["groupId"] = json!("g1"),
            }
            entries.push(e);
        }
        // Two hundred that are not, the two oldest archived only.
        for n in 1..=200u64 {
            let mut e = plain(n, 100 + n);
            if n <= 2 {
                e["archived"] = json!(true);
            }
            entries.push(e);
        }
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": [{"id": "g1", "name": "Kept"}]}));
        assert_eq!(list(&base).unwrap().len(), 210, "premise: all read");
        for n in 201..=205u64 {
            upsert(&base, &plain(n, 1000 + n), None).unwrap();
        }
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), 210);
        let protected: Vec<String> = kept.iter().filter(|e| e.is_protected()).map(|e| e.key.clone()).collect();
        assert_eq!(protected.len(), 10, "every protected one kept, the oldest of all");
        let unprotected: Vec<&Entry> = kept.iter().filter(|e| !e.is_protected()).collect();
        assert_eq!(unprotected.len(), CAP);
        assert_eq!(unprotected[0].key, "opencode:ses_cap00205");
        assert_eq!(unprotected[CAP - 1].key, "opencode:ses_cap00006", "the five oldest went, the two archived ones first");
        assert!(!kept.iter().any(|e| e.archived), "archived alone protects nothing");
    }

    #[test]
    fn a_201st_protected_entry_is_refused_and_changes_nothing() {
        let scratch = Scratch::new("max-curated");
        let base = scratch.base();
        let mut entries: Vec<Value> = (1..=MAX_CURATED as u64)
            .map(|n| {
                let mut e = plain(n, n);
                e["pinned"] = json!(true);
                e
            })
            .collect();
        entries.push(plain(999, 999));
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": [{"id": "g1", "name": "Full"}]}));
        let one_more = "opencode:ses_cap00999";
        list(&base).unwrap();
        let unchanged = text(&scratch);
        for change in [json!({"pinned": true}), json!({"name": "One more"}), json!({"groupId": "g1"}), json!({"archived": true, "pinned": true})] {
            assert_eq!(update(&base, one_more, &change).unwrap_err(), TOO_MANY_CURATED, "{change}");
        }
        assert_eq!(group_create(&base, &json!({"id": "g2", "name": "New"}), Some(one_more)).unwrap_err(), TOO_MANY_CURATED);
        assert_eq!(text(&scratch), unchanged, "nothing changed: no entry, no group");
        assert!(TOO_MANY_CURATED.contains(&MAX_CURATED.to_string()));
        // Archived alone protects nothing; a protected one may change; and
        // one that is no longer protected makes room.
        assert!(update(&base, one_more, &json!({"archived": true})).unwrap().unwrap().archived);
        assert!(update(&base, "opencode:ses_cap00001", &json!({"name": "Renamed", "groupId": "g1"})).is_ok());
        update(&base, "opencode:ses_cap00002", &json!({"pinned": false})).unwrap();
        assert!(update(&base, one_more, &json!({"pinned": true})).unwrap().unwrap().pinned);
    }

    /// A curation drops no entry for CAP (see the module's doc): one it leaves
    /// unprotected stays until the next recorded event, which keeps the CAP
    /// most recent.
    #[test]
    fn a_curation_drops_no_entry_for_the_cap() {
        let scratch = Scratch::new("cap-curation");
        let base = scratch.base();
        let mut pinned = plain(900, 1);
        pinned["pinned"] = json!(true);
        let mut grouped = plain(901, 2);
        grouped["groupId"] = json!("g1");
        let mut entries: Vec<Value> = (1..=CAP as u64).map(|n| plain(n, 100 + n)).collect();
        entries.extend([pinned, grouped]);
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": [{"id": "g1", "name": "Old"}]}));
        update(&base, "opencode:ses_cap00900", &json!({"pinned": false})).unwrap();
        assert_eq!(group_delete(&base, "g1").unwrap(), Some(1));
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), CAP + 2, "both back in the list, and nothing else gone");
        assert!(kept.iter().all(|e| !e.is_protected()));
        // The next recorded event keeps the CAP most recent.
        upsert(&base, &plain(1000, 5000), None).unwrap();
        let kept = list(&base).unwrap();
        assert_eq!(kept.len(), CAP);
        assert_eq!(kept[0].key, "opencode:ses_cap01000");
        assert_eq!(kept[CAP - 1].key, "opencode:ses_cap00002", "the two once curated and the oldest other went");
    }

    #[test]
    fn the_read_size_fit_drops_unprotected_entries_before_any_protected_one() {
        let scratch = Scratch::new("fit-protected");
        let base = scratch.base();
        // Folders at their cap with no id (each in the key a second time) and
        // titles at theirs: some 10 KB an entry, so about 100 fit.
        let folder = |n: u64| format!("/{n:04}{}", "d".repeat(MAX_CWD_BYTES - 5));
        let title = "\u{1f600}".repeat(MAX_TITLE_CHARS);
        let wide = |n: u64, used: u64| entry("opencode", None, &folder(n), Some(&title), used, used);
        for n in 1..=20 {
            let kept = upsert(&base, &wide(n, n), None).unwrap();
            update(&base, &kept.key, &json!({"pinned": true})).unwrap();
        }
        for n in 21..=120 {
            upsert(&base, &wide(n, 1000 + n), None).unwrap();
        }
        assert!(fs::metadata(scratch.file()).unwrap().len() <= MAX_READ_BYTES);
        let kept = list(&base).unwrap();
        assert_eq!(kept.iter().filter(|e| e.pinned).count(), 20, "every pinned one, the oldest of all, kept");
        let unprotected: Vec<&Entry> = kept.iter().filter(|e| !e.pinned).collect();
        assert!(unprotected.len() < 100 && unprotected.len() > 50, "{} kept", unprotected.len());
        assert_eq!(unprotected[0].cwd, folder(120), "the newest kept");
        assert_eq!(unprotected[unprotected.len() - 1].cwd, folder(120 - unprotected.len() as u64 + 1), "the oldest went");
        assert!(scratch.bad().is_empty());

        // And a protected one only once no other is left: a file of pinned
        // ones only, which the next write cannot keep all of.
        let scratch = Scratch::new("fit-protected-only");
        let base = scratch.base();
        let pinned: Vec<Value> = (1..=110)
            .map(|n| {
                let mut e = wide(n, n);
                e["pinned"] = json!(true);
                e
            })
            .collect();
        put(&scratch, &json!({"version": 2, "entries": pinned, "groups": []}));
        assert!(fs::metadata(scratch.file()).unwrap().len() <= MAX_READ_BYTES, "premise: read, in its short form");
        assert_eq!(list(&base).unwrap().len(), 110);
        let written = upsert(&base, &wide(999, 5000), None).unwrap();
        assert!(fs::metadata(scratch.file()).unwrap().len() <= MAX_READ_BYTES);
        let kept = list(&base).unwrap();
        assert_eq!(kept[0], written, "never the one just written");
        assert!(kept.len() < 111 && kept.len() > 50, "{} kept", kept.len());
        assert_eq!(kept[1].cwd, folder(110), "the newest pinned kept");
        assert_eq!(kept[kept.len() - 1].cwd, folder(110 - (kept.len() as u64 - 1) + 1), "the least recently used went");
    }

    /// Decision 2: a read keeps the newest MAX_CURATED protected entries and
    /// CAP + MAX_CURATED in all (`within_bounds`), of a file larger than this
    /// build writes; the next upsert then keeps CAP unprotected (`keep_cap`).
    #[test]
    fn a_read_keeps_the_newest_two_hundred_protected_and_four_hundred_in_all() {
        let scratch = Scratch::new("read-bounds");
        let base = scratch.base();
        // 210 pinned, used at 1 to 210; 250 plain ones, newer, used at 1001 to 1250.
        let mut entries: Vec<Value> = (1..=210u64)
            .map(|n| {
                let mut e = plain(n, n);
                e["pinned"] = json!(true);
                e
            })
            .collect();
        entries.extend((1001..=1250u64).map(|n| plain(n, n)));
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": []}));
        let unchanged = text(&scratch);
        let key = |n: u64| format!("opencode:ses_cap{n:05}");
        let range = |from: u64, to: u64| -> Vec<String> { (from..=to).rev().map(key).collect() };

        let listed = list(&base).unwrap();
        assert_eq!(listed.len(), CAP + MAX_CURATED, "400 in all");
        let mut expected = range(1001, 1250);
        expected.extend(range(61, 210));
        assert_eq!(keys(&listed), expected, "the 250 plain ones, then the newest 150 pinned");
        assert_eq!(listed.iter().filter(|e| e.pinned).count(), 150);
        assert_eq!(text(&scratch), unchanged, "a read writes nothing");

        // One plain upsert: the newest CAP plain ones, the written one among
        // them, beside those 150 pinned; the 60 older pinned ones are gone
        // from the file (decision 2's accepted limitation).
        let written = upsert(&base, &plain(2000, 2000), None).unwrap();
        assert_eq!(written.key, key(2000));
        let listed = list(&base).unwrap();
        let mut expected = vec![key(2000)];
        expected.extend(range(1052, 1250));
        expected.extend(range(61, 210));
        assert_eq!(keys(&listed), expected);
        assert_eq!(listed.iter().filter(|e| !e.is_protected()).count(), CAP);
        let file: Value = serde_json::from_str(&text(&scratch)).unwrap();
        assert_eq!(file["entries"].as_array().unwrap().len(), CAP + 150, "and the file holds exactly those");

        // A version 1 file of 450 entries is read as its newest 400.
        let scratch = Scratch::new("read-bounds-v1");
        let base = scratch.base();
        put(&scratch, &json!({"version": 1, "entries": (1..=450u64).map(|n| plain(n, n)).collect::<Vec<Value>>()}));
        let unchanged = text(&scratch);
        assert_eq!(keys(&list(&base).unwrap()), range(51, 450));
        assert_eq!(text(&scratch), unchanged, "a read writes nothing");
    }

    /// Decision 2, the protected bound alone: of 250 pinned entries newer
    /// than 100 plain ones a read keeps the newest MAX_CURATED pinned and
    /// every plain one, though the 350 are fewer than CAP + MAX_CURATED; the
    /// next upsert keeps what was read and drops nothing for the cap.
    #[test]
    fn a_read_keeps_only_the_newest_two_hundred_protected_below_four_hundred_in_all() {
        let scratch = Scratch::new("read-bounds-protected");
        let base = scratch.base();
        // 250 pinned, used at 1001 to 1250; 100 plain ones, older, used at 1 to 100.
        let mut entries: Vec<Value> = (1001..=1250u64)
            .map(|n| {
                let mut e = plain(n, n);
                e["pinned"] = json!(true);
                e
            })
            .collect();
        entries.extend((1..=100u64).map(|n| plain(n, n)));
        assert!(entries.len() < CAP + MAX_CURATED, "premise: the bound of 400 in all cuts nothing");
        put(&scratch, &json!({"version": 2, "entries": entries, "groups": []}));
        let unchanged = text(&scratch);
        let key = |n: u64| format!("opencode:ses_cap{n:05}");
        let range = |from: u64, to: u64| -> Vec<String> { (from..=to).rev().map(key).collect() };

        let listed = list(&base).unwrap();
        let mut expected = range(1051, 1250);
        expected.extend(range(1, 100));
        assert_eq!(keys(&listed), expected, "the newest 200 pinned, then the 100 plain ones; not the 50 older pinned");
        assert_eq!(listed.len(), 300);
        assert_eq!(listed.iter().filter(|e| e.pinned).count(), MAX_CURATED);
        assert_eq!(text(&scratch), unchanged, "a read writes nothing");

        // One plain upsert, the newest: 101 unprotected are within CAP, so
        // nothing goes for the cap; the 50 older pinned ones are gone from
        // the file (decision 2's accepted limitation).
        let written = upsert(&base, &plain(2000, 2000), None).unwrap();
        assert_eq!(written.key, key(2000));
        let listed = list(&base).unwrap();
        let mut expected = vec![key(2000)];
        expected.extend(range(1051, 1250));
        expected.extend(range(1, 100));
        assert_eq!(keys(&listed), expected, "the written one, the same 200 pinned, the same 100 plain ones");
        assert_eq!(listed.iter().filter(|e| e.pinned).count(), MAX_CURATED);
        let file: Value = serde_json::from_str(&text(&scratch)).unwrap();
        assert_eq!(file["entries"].as_array().unwrap().len(), 301, "and the file holds exactly those");
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
    const CLAUDE_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
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
        // Version 3: the first newer than this build's (AC27), with what this
        // build can read of its groups and of what was curated.
        let newer = json!({"version": 3, "entries": [
            with(with(entry("claude", Some(CLAUDE_A), "/w", None, 1, 5), "pinned", json!(true)), "groupId", json!("g1")),
            {"kind": "claude", "v2": true},
        ], "groups": [{"id": "g1", "name": "Kept", "collapsed": true}, {"id": "g2", "v3": true}], "settings": {}});

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

        let mut all = vec![
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
                    write_file(r#"{"version":3,"entries":[]}"#, None),
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
                    json!({"op": "groups"}),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", None, 1, 1), None),
                    unarchive_op(entry("claude", Some(CLAUDE_A), "/w", None, 1, 9), None),
                    update_op(&format!("claude:{CLAUDE_A}"), json!({"name": "Mine"})),
                    update_op("claude:nothing-here", json!({"pinned": true})),
                    create_op(json!({"id": "g2", "name": "New"}), Some(&format!("claude:{CLAUDE_A}"))),
                    group_update_op("g1", json!({"collapsed": false})),
                    group_delete_op("g1"),
                    json!({"op": "remove", "args": {"key": format!("claude:{CLAUDE_A}")}}),
                    json!({"op": "clear"}),
                    upsert_op(json!({"kind": 1}), None),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                ],
            ),
            (
                "a newer file with no list reads as empty",
                vec![write_file(r#"{"version":3,"sessions":[]}"#, None), json!({"op": "list"}), json!({"op": "groups"})],
            ),
            ("a fork keeps the conversation it was forked from", fork_scenario()),
        ];
        all.extend(curated_scenarios());
        all
    }

    /// Fork Conversation: a fork of CLAUDE_A recorded as CLAUDE_B. Its
    /// `forkOf` is written after the nine fields and only when there is one,
    /// kept when a later event sends none, curated or not, and never makes
    /// the file version 2 by itself; one of the wrong shape is refused, and
    /// dropped from a file.
    fn fork_scenario() -> Vec<Value> {
        let source = entry("claude", Some(CLAUDE_A), "/work/app", None, 1, 2);
        let fork = |started: u64, used: u64| with(entry("claude", Some(CLAUDE_B), "/work/app", None, started, used), "forkOf", json!(CLAUDE_A));
        let plain = |started: u64, used: u64| entry("claude", Some(CLAUDE_B), "/work/app", None, started, used);
        let fork_key = format!("claude:{CLAUDE_B}");
        let in_file = json!({"version": 1, "entries": [
            fork(3, 9),
            with(entry("claude", Some(CLAUDE_A), "/w", None, 1, 8), "forkOf", json!("x; curl a | sh")),
            with(entry("opencode", Some(OPENCODE_A), "/w", None, 1, 7), "forkOf", json!(CLAUDE_A)),
            with(entry("opencode", Some(OPENCODE_B), "/w", None, 1, 6), "forkOf", json!(OPENCODE_A)),
            with(entry("claude", None, "/w", None, 1, 5), "forkOf", json!(null)),
        ]});
        vec![
            upsert_op(source.clone(), None),
            upsert_op(fork(3, 4), None),
            upsert_op(ended(plain(3, 5), 5, "exited"), None),
            upsert_op(with(plain(3, 6), "title", json!("From the transcript")), None),
            upsert_op(with(plain(7, 7), "forkOf", json!(null)), None),
            json!({"op": "list"}),
            update_op(&fork_key, json!({"pinned": true})),
            json!({"op": "list"}),
            update_op(&fork_key, json!({"pinned": false})),
            upsert_op(with(entry("opencode", Some(OPENCODE_B), "/w", None, 8, 8), "forkOf", json!(OPENCODE_A)), None),
            upsert_op(with(entry("claude", None, "/x", None, 9, 9), "forkOf", json!(CLAUDE_A)), None),
            upsert_op(with(plain(10, 10), "forkOf", json!(OPENCODE_A)), None),
            upsert_op(with(plain(10, 10), "forkOf", json!(CLAUDE_A.to_uppercase())), None),
            json!({"op": "list"}),
            write_file(&in_file.to_string(), None),
            json!({"op": "list"}),
            upsert_op(source, None),
            json!({"op": "list"}),
        ]
    }

    fn update_op(key: &str, changes: Value) -> Value {
        json!({"op": "update", "args": {"key": key, "changes": changes}})
    }

    fn create_op(group: Value, move_key: Option<&str>) -> Value {
        match move_key {
            Some(key) => json!({"op": "group_create", "args": {"group": group, "move_key": key}}),
            None => json!({"op": "group_create", "args": {"group": group}}),
        }
    }

    fn group_update_op(id: &str, changes: Value) -> Value {
        json!({"op": "group_update", "args": {"id": id, "changes": changes}})
    }

    fn group_delete_op(id: &str) -> Value {
        json!({"op": "group_delete", "args": {"id": id}})
    }

    /// An upsert that unarchives: what the page sends when a conversation is
    /// started or resumed again.
    fn unarchive_op(entry: Value, replaces: Option<&str>) -> Value {
        match replaces {
            Some(key) => json!({"op": "upsert", "args": {"entry": entry, "replaces": key, "unarchive": true}}),
            None => json!({"op": "upsert", "args": {"entry": entry, "unarchive": true}}),
        }
    }

    /// `e`, with `field` set to `value`: one curated field, in the file.
    fn curated(mut e: Value, field: &str, value: Value) -> Value {
        e[field] = value;
        e
    }

    /// The sequences of format version 2: what the user curated (AC25-AC30).
    fn curated_scenarios() -> Vec<(&'static str, Vec<Value>)> {
        let claude_key = format!("claude:{CLAUDE_A}");
        let opencode_key = format!("opencode:{OPENCODE_A}");
        let claude = |started: u64, used: u64| entry("claude", Some(CLAUDE_A), "/w", None, started, used);
        // `tests::write_two`: an OpenCode conversation that ended, then a
        // Claude Code one still running.
        let write_two = vec![
            upsert_op(ended(entry("opencode", Some(OPENCODE_A), "/w", Some("Title"), 1, 2), 2, "closed"), None),
            upsert_op(claude(3, 4), None),
        ];
        let with_two = |ops: Vec<Value>| -> Vec<Value> { write_two.iter().cloned().chain(ops).collect() };
        let plain = |n: u64, used: u64| entry("opencode", Some(&format!("ses_cap{n:05}")), "/w", None, used, used);

        // Every curated field refused, through update — before the file is
        // made — and in a file, where the entry is dropped and the rest kept.
        let mut refused: Vec<Value> = super::tests::curated_refused_cases()
            .into_iter()
            .map(|(field, value, _)| update_op(&claude_key, json!({ field: value })))
            .collect();
        for changes in [
            json!(null),
            json!([]),
            json!("pin"),
            json!({"title": "Mine"}),
            json!({"pinned": true, "key": "claude:x"}),
            json!({"pinned": null}),
            json!({"archived": null}),
        ] {
            refused.push(update_op(&claude_key, changes));
        }
        let mut in_file = vec![
            claude(1, 5),
            curated(entry("opencode", Some("ses_kept00001"), "/w", None, 1, 4), "name", json!("")),
        ];
        for (n, (field, value, _)) in super::tests::curated_refused_cases().into_iter().enumerate() {
            in_file.push(curated(entry("opencode", Some(&format!("ses_bad{n:05}")), "/w", None, 1, 9), field, value));
        }
        let mut nulls = claude(1, 3);
        for field in ["name", "pinned", "archived", "groupId"] {
            nulls[field] = json!(null);
        }
        let mut longest = entry("opencode", Some(OPENCODE_A), "/w", None, 1, 7);
        longest["name"] = json!("é".repeat(MAX_NAME_CHARS));
        longest["groupId"] = json!(format!("{}{}", "Az09_-".repeat(10), "abcd"));
        longest["pinned"] = json!(false);
        in_file.extend([nulls, longest]);
        let in_file_groups = json!([{"id": format!("{}{}", "Az09_-".repeat(10), "abcd"), "name": "n".repeat(MAX_GROUP_NAME_CHARS)}]);

        let in_group = |id: &str, n: u64| curated(entry("opencode", Some(&format!("ses_grp{n:05}")), "/w", None, n, n), "groupId", json!(id));

        // The cap: ten protected entries older than two hundred others.
        let mut capped = Vec::new();
        for n in 1..=10u64 {
            let e = entry("opencode", Some(&format!("ses_kept{n:05}")), "/w", None, n, n);
            capped.push(match n {
                1..=4 => curated(e, "pinned", json!(true)),
                5..=7 => curated(e, "name", json!(format!("Mine {n}"))),
                _ => curated(e, "groupId", json!("g1")),
            });
        }
        for n in 1..=200u64 {
            let e = plain(n, 100 + n);
            capped.push(if n <= 2 { curated(e, "archived", json!(true)) } else { e });
        }
        let mut cap = vec![write_file(&json!({"version": 2, "entries": capped, "groups": [{"id": "g1", "name": "Kept"}]}).to_string(), None)];
        for n in 201..=205u64 {
            cap.push(upsert_op(plain(n, 1000 + n), None));
        }
        cap.push(json!({"op": "list"}));

        // At most MAX_CURATED protected.
        let mut full: Vec<Value> = (1..=MAX_CURATED as u64).map(|n| curated(plain(n, n), "pinned", json!(true))).collect();
        full.push(plain(999, 999));
        let one_more = "opencode:ses_cap00999";
        let max_curated = vec![
            write_file(&json!({"version": 2, "entries": full, "groups": [{"id": "g1", "name": "Full"}]}).to_string(), None),
            update_op(one_more, json!({"pinned": true})),
            update_op(one_more, json!({"name": "One more"})),
            update_op(one_more, json!({"groupId": "g1"})),
            update_op(one_more, json!({"archived": true, "pinned": true})),
            create_op(json!({"id": "g2", "name": "New"}), Some(one_more)),
            json!({"op": "groups"}),
            update_op(one_more, json!({"archived": true})),
            update_op("opencode:ses_cap00001", json!({"name": "Renamed", "groupId": "g1"})),
            update_op("opencode:ses_cap00002", json!({"pinned": false})),
            update_op(one_more, json!({"pinned": true})),
            json!({"op": "list"}),
        ];

        // A curation drops no entry for the cap; the next recorded event does.
        let mut returned: Vec<Value> = (1..=CAP as u64).map(|n| plain(n, 100 + n)).collect();
        returned.push(curated(plain(900, 1), "pinned", json!(true)));
        returned.push(curated(plain(901, 2), "groupId", json!("g1")));
        let no_cap_for_a_curation = vec![
            write_file(&json!({"version": 2, "entries": returned, "groups": [{"id": "g1", "name": "Old"}]}).to_string(), None),
            update_op("opencode:ses_cap00900", json!({"pinned": false})),
            group_delete_op("g1"),
            json!({"op": "list"}),
            upsert_op(plain(1000, 5000), None),
            json!({"op": "list"}),
        ];

        // The read-size fit (`fitted_text`): the folders and titles of the
        // older fit scenario, a fifth of them pinned and the oldest; then
        // pinned ones only. Written short, as a hand might, so that the next
        // write is the one that must fit.
        let wide = |n: u64| format!("C:\\{n:03}{}", "\\x".repeat(2045));
        let quoted = "\"".repeat(MAX_TITLE_CHARS);
        let wide_entry = |n: u64, used: u64| entry("opencode", None, &wide(n), Some(&quoted), used, used);
        let mixed: Vec<Value> = (1..=90u64)
            .map(|n| if n <= 20 { curated(wide_entry(n, n), "pinned", json!(true)) } else { wide_entry(n, 100 + n) })
            .collect();
        let pinned_only: Vec<Value> = (1..=90u64).map(|n| curated(wide_entry(n, n), "pinned", json!(true))).collect();

        // The read bound (`within_bounds`, decision 2): 210 pinned and 250
        // newer plain ones are read as the 250 and the newest 150 pinned;
        // a version 1 file of 450 as its newest 400.
        let mut beyond: Vec<Value> = (1..=210u64).map(|n| curated(plain(n, n), "pinned", json!(true))).collect();
        beyond.extend((1001..=1250u64).map(|n| plain(n, n)));
        let beyond_v1: Vec<Value> = (1..=450u64).map(|n| plain(n, n)).collect();
        // The protected bound alone: 250 pinned newer than 100 plain ones
        // are read as the newest 200 pinned and the 100, 300 in all.
        let mut beyond_protected: Vec<Value> =
            (1001..=1250u64).map(|n| curated(plain(n, n), "pinned", json!(true))).collect();
        beyond_protected.extend((1..=100u64).map(|n| plain(n, n)));

        vec![
            (
                "an uncurated history is version 1, a curated one version 2",
                with_two(vec![
                    json!({"op": "groups"}),
                    update_op(&claude_key, json!({"pinned": true})),
                    json!({"op": "groups"}),
                    update_op(&claude_key, json!({"pinned": false})),
                    json!({"op": "groups"}),
                    update_op(&claude_key, json!({"archived": true})),
                    update_op(&claude_key, json!({"archived": false, "name": "Mine"})),
                    update_op(&claude_key, json!({"name": ""})),
                    create_op(json!({"id": "g1", "name": "Work"}), None),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                    group_delete_op("g1"),
                    json!({"op": "list"}),
                ]),
            ),
            (
                "every curated field, written as version 2",
                with_two(vec![
                    create_op(json!({"id": "g1", "name": "Work"}), Some(&claude_key)),
                    create_op(json!({"id": "g2", "name": "Play"}), Some(&opencode_key)),
                    group_update_op("g1", json!({"collapsed": true})),
                    update_op(&claude_key, json!({"name": "Mine", "pinned": true, "archived": true})),
                    update_op(&opencode_key, json!({"name": "Theirs"})),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                    upsert_op(claude(3, 4), None),
                ]),
            ),
            (
                "a version 2 file is read and written",
                vec![
                    write_file(&json!({"version": 2, "entries": [
                        curated(curated(curated(curated(claude(3, 4), "name", json!("Mine")), "pinned", json!(true)), "archived", json!(true)), "groupId", json!("g1")),
                        curated(entry("opencode", Some(OPENCODE_A), "/w", Some("Title"), 1, 2), "groupId", json!("g2")),
                    ], "groups": [{"id": "g1", "name": "Work", "collapsed": true}, {"id": "g2", "name": "Play", "collapsed": false}]}).to_string(), None),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                    upsert_op(claude(3, 10), None),
                    json!({"op": "remove", "args": {"key": opencode_key.clone()}}),
                    json!({"op": "list"}),
                ],
            ),
            (
                "version 2 must have its entries too",
                vec![
                    write_file(r#"{"version":2}"#, None),
                    json!({"op": "list"}),
                    write_file(r#"{"version":2,"entries":{},"groups":[]}"#, None),
                    json!({"op": "groups"}),
                    write_file(r#"{"version":2,"entries":[],"groups":[]}"#, None),
                    json!({"op": "groups"}),
                ],
            ),
            (
                "update changes only what it names",
                with_two(vec![
                    update_op(&claude_key, json!({"name": "Mine"})),
                    update_op(&opencode_key, json!({"pinned": true, "archived": true})),
                    update_op(&claude_key, json!({"name": null})),
                    update_op(&claude_key, json!({})),
                    update_op("claude:nothing-here", json!({"pinned": true})),
                    update_op(&claude_key, json!({"groupId": "g1"})),
                    create_op(json!({"id": "g1", "name": "Work"}), None),
                    update_op(&claude_key, json!({"groupId": "g1"})),
                    update_op(&opencode_key, json!({"groupId": "g1", "pinned": false})),
                    update_op(&claude_key, json!({"groupId": null})),
                    json!({"op": "list"}),
                ]),
            ),
            ("update refuses what is not a change, and nothing is made", refused),
            (
                "curated fields of the wrong shape drop their entry from a valid file",
                vec![
                    write_file(&json!({"version": 2, "entries": in_file, "groups": in_file_groups}).to_string(), None),
                    json!({"op": "list"}),
                    upsert_op(claude(1, 6), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "groups are read leniently, each dropped by itself",
                vec![
                    write_file(&json!({"version": 2, "entries": [in_group("g1", 1)], "groups": null}).to_string(), None),
                    json!({"op": "list"}),
                    write_file(&json!({"version": 2, "entries": [in_group("g1", 1)], "groups": {"g1": {"name": "G"}}}).to_string(), None),
                    json!({"op": "groups"}),
                    write_file(&json!({"version": 2, "entries": [in_group("g1", 1)], "groups": "g1"}).to_string(), None),
                    json!({"op": "list"}),
                    write_file(&json!({"version": 2, "entries": [in_group("g1", 1)]}).to_string(), None),
                    json!({"op": "list"}),
                    write_file(&json!({"version": 2, "entries": [
                        in_group("ok-1", 1), in_group("bad-name-1", 2), in_group("ok-51", 3), in_group("ok-50", 4),
                    ], "groups": super::tests::group_cases()}).to_string(), None),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                    upsert_op(claude(9, 9), None),
                    json!({"op": "groups"}),
                ],
            ),
            (
                "a recorded event never changes what the user curated",
                vec![
                    upsert_op(claude(100, 100), None),
                    create_op(json!({"id": "g1", "name": "Work"}), Some(&claude_key)),
                    update_op(&claude_key, json!({"name": "Mine", "pinned": true, "archived": true})),
                    upsert_op(with(claude(100, 200), "title", json!("Fix the build")), None),
                    upsert_op(ended(claude(100, 300), 300, "exited"), None),
                    upsert_op(with(ended(claude(100, 300), 300, "exited"), "title", json!("From the transcript")), None),
                    upsert_op(curated(curated(curated(curated(claude(100, 400), "name", json!("Other")), "pinned", json!(false)), "archived", json!(false)), "groupId", json!("g2")), None),
                    upsert_op(curated(curated(claude(100, 400), "pinned", json!("yes")), "name", json!(5)), None),
                    unarchive_op(claude(500, 500), None),
                    unarchive_op(claude(500, 600), None),
                    unarchive_op(entry("opencode", Some(OPENCODE_B), "/w", None, 1, 1), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a provisional entry's curation goes with it when it is replaced",
                vec![
                    upsert_op(entry("opencode", None, "/w", None, 100, 100), None),
                    create_op(json!({"id": "g1", "name": "Work"}), Some("opencode:~/w\u{0}")),
                    update_op("opencode:~/w\u{0}", json!({"name": "Mine", "archived": true})),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 100, 200), Some("opencode:~/w\u{0}")),
                    upsert_op(entry("opencode", None, "/x", None, 300, 300), None),
                    create_op(json!({"id": "g2", "name": "Play"}), Some("opencode:~/x\u{0}")),
                    update_op("opencode:~/x\u{0}", json!({"name": "Provisional", "pinned": true, "archived": true})),
                    update_op(&opencode_key, json!({"archived": false})),
                    upsert_op(entry("opencode", Some(OPENCODE_A), "/w", Some("Fix it"), 100, 400), Some("opencode:~/x\u{0}")),
                    update_op(&opencode_key, json!({"name": null, "groupId": null, "pinned": false})),
                    upsert_op(entry("opencode", None, "/y", None, 500, 500), None),
                    update_op("opencode:~/y\u{0}", json!({"groupId": "g2"})),
                    unarchive_op(entry("opencode", Some(OPENCODE_A), "/w", None, 100, 600), Some("opencode:~/y\u{0}")),
                    json!({"op": "list"}),
                ],
            ),
            (
                "groups are made, renamed, folded and deleted",
                with_two(vec![
                    create_op(json!({"id": "g1", "name": "Work", "collapsed": true, "colour": "red"}), None),
                    create_op(json!({"id": "g2", "name": "Play"}), Some(&claude_key)),
                    create_op(json!({"id": "g3", "name": "Empty"}), Some("claude:nothing-here")),
                    create_op(json!("g4"), None),
                    create_op(json!(null), None),
                    create_op(json!({"id": "has space", "name": "Work"}), None),
                    create_op(json!({"id": "g".repeat(MAX_GROUP_ID_CHARS + 1), "name": "Work"}), None),
                    create_op(json!({"id": 4, "name": "Work"}), None),
                    create_op(json!({"name": "Work"}), None),
                    create_op(json!({"id": "g4"}), None),
                    create_op(json!({"id": "g4", "name": ""}), None),
                    create_op(json!({"id": "g4", "name": "n".repeat(MAX_GROUP_NAME_CHARS + 1)}), None),
                    create_op(json!({"id": "g4", "name": "one\ntwo"}), None),
                    create_op(json!({"id": "g4", "name": "a\u{2066}b"}), None),
                    create_op(json!({"id": "g1", "name": "Again"}), None),
                    group_update_op("g1", json!({"name": "Office"})),
                    group_update_op("g1", json!({"collapsed": true})),
                    group_update_op("g9", json!({"collapsed": true})),
                    group_update_op("has space", json!({"collapsed": true})),
                    group_update_op("", json!({"collapsed": true})),
                    group_update_op("g1", json!(null)),
                    group_update_op("g1", json!({"id": "g5"})),
                    group_update_op("g1", json!({"name": null})),
                    group_update_op("g1", json!({"name": ""})),
                    group_update_op("g1", json!({"collapsed": "yes"})),
                    group_update_op("g1", json!({"collapsed": null})),
                    update_op(&opencode_key, json!({"groupId": "g2", "pinned": true})),
                    json!({"op": "list"}),
                    group_delete_op("g2"),
                    group_delete_op("g2"),
                    group_delete_op("g3"),
                    group_delete_op("bad id"),
                    json!({"op": "list"}),
                    json!({"op": "groups"}),
                ]),
            ),
            (
                "there are at most fifty groups",
                with_two(
                    (0..MAX_GROUPS)
                        .map(|n| create_op(json!({"id": format!("g{n}"), "name": format!("Group {n}")}), None))
                        .chain([
                            create_op(json!({"id": "g50", "name": "One more"}), Some(&claude_key)),
                            group_delete_op("g0"),
                            create_op(json!({"id": "g50", "name": "One more"}), None),
                            json!({"op": "groups"}),
                        ])
                        .collect(),
                ),
            ),
            (
                "clear deletes the groups, and leaves the version 1 empty history",
                with_two(vec![
                    write_file("{not json", None),
                    json!({"op": "list"}),
                    upsert_op(claude(3, 4), None),
                    create_op(json!({"id": "g1", "name": "Work"}), Some(&claude_key)),
                    update_op(&claude_key, json!({"pinned": true})),
                    json!({"op": "clear"}),
                    json!({"op": "groups"}),
                    json!({"op": "list"}),
                ]),
            ),
            ("the cap keeps every protected entry beside the newest two hundred", cap),
            ("a 201st protected entry is refused and changes nothing", max_curated),
            ("a curation drops no entry for the cap", no_cap_for_a_curation),
            (
                "the read-size fit drops unprotected entries before any protected one",
                vec![
                    write_file(&json!({"version": 2, "entries": mixed, "groups": []}).to_string(), None),
                    upsert_op(wide_entry(91, 1000), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "the read-size fit drops a protected entry only once no other is left",
                vec![
                    write_file(&json!({"version": 2, "entries": pinned_only, "groups": []}).to_string(), None),
                    upsert_op(wide_entry(91, 1000), None),
                ],
            ),
            (
                "a read keeps the newest two hundred protected and four hundred in all",
                vec![
                    write_file(&json!({"version": 2, "entries": beyond, "groups": []}).to_string(), None),
                    json!({"op": "list"}),
                    upsert_op(plain(2000, 2000), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a read keeps only the newest two hundred protected, below four hundred in all",
                vec![
                    write_file(&json!({"version": 2, "entries": beyond_protected, "groups": []}).to_string(), None),
                    json!({"op": "list"}),
                    upsert_op(plain(2000, 2000), None),
                    json!({"op": "list"}),
                ],
            ),
            (
                "a version 1 file of 450 entries is read as its newest 400",
                vec![write_file(&json!({"version": 1, "entries": beyond_v1}).to_string(), None), json!({"op": "list"})],
            ),
        ]
    }

    fn answer<T: Serialize>(result: Result<T, String>) -> Value {
        match result {
            Ok(value) => json!({"ok": value}),
            Err(why) => json!({"error": why}),
        }
    }

    /// One op of a sequence. The arguments are the commands' own, by the
    /// names the page gives them (snake_case: `move_key`), so that the mock
    /// is called with each exactly as the page calls the backend.
    fn run(base: &Path, op: &Value) -> Value {
        let args = &op["args"];
        match op["op"].as_str().unwrap() {
            "list" => answer(list(base)),
            "groups" => answer(groups(base)),
            "upsert" => answer(upsert_with(base, &args["entry"], args["replaces"].as_str(), args["unarchive"] == json!(true))),
            "update" => answer(update(base, args["key"].as_str().unwrap(), &args["changes"])),
            "group_create" => answer(group_create(base, &args["group"], args["move_key"].as_str())),
            "group_update" => answer(group_update(base, args["id"].as_str().unwrap(), &args["changes"])),
            "group_delete" => answer(group_delete(base, args["id"].as_str().unwrap())),
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
                "copiesLeft": COPIES_LEFT, "uncuratedVersion": UNCURATED_VERSION, "maxCurated": MAX_CURATED,
                "maxGroups": MAX_GROUPS, "maxNameChars": MAX_NAME_CHARS, "maxGroupNameChars": MAX_GROUP_NAME_CHARS,
                "maxGroupIdChars": MAX_GROUP_ID_CHARS, "invalidGroup": INVALID_GROUP, "tooManyGroups": TOO_MANY_GROUPS,
                "tooManyCurated": TOO_MANY_CURATED,
            },
            "scenarios": out,
        });
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("tests").join("fixtures");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("agent-history.json"), serde_json::to_string_pretty(&payload).unwrap()).unwrap();
    }
}
