//! What Claude Code itself keeps about a conversation NexTerm started, read
//! for the agent session history (src/lib/agentHistory.js): its title, and
//! whether there is a conversation at all. Through `claude_conversations`
//! (commands/agent.rs), beside `agent_sessions`. Kept out of
//! src/agent_history.rs, which keeps the history's file for any agent and
//! knows nothing of how one of them stores its conversations.
//!
//! **Where.** Claude Code (2.1.323, measured 2026-11-13) writes each
//! conversation to `<config>/projects/<its folder, encoded>/<session id>.jsonl`,
//! one JSON record a line. `<config>` is `CLAUDE_CONFIG_DIR` when NexTerm's own
//! environment sets it to an absolute path, else `.claude` in the user's home
//! (`config_dir`). The transcript is found by its file name in the direct
//! sub-folders of `projects`: Claude Code's encoding of a folder into a name
//! is its own, and is not guessed here.
//!
//! **Saved or not (F17).** NexTerm starts Claude Code as `claude --session-id
//! <uuid>`, and Claude Code writes `<uuid>.jsonl` only once a first message is
//! sent. A terminal quit before that leaves an id with no conversation, and
//! `claude --resume <uuid>` then fails (`No conversation found with session
//! ID`). So `saved` is `true` when a project folder holds the transcript as a
//! regular file. It is `false` only on positive evidence that Claude Code ran
//! under that id in THIS config folder and saved nothing: `projects` and every
//! folder in it could be looked at, none holds the transcript, AND
//! `<config>/session-env/<id>` is a real folder — the marker Claude Code
//! (2.1.323) makes when a session starts (`has_marker`). A wrong `false` is the
//! answer that does harm — the page then starts a new conversation and drops
//! the entry — and without the marker the folder looked at may simply not be
//! the one the user's shell has Claude Code use (`CLAUDE_CONFIG_DIR` set only
//! in a shell profile, NexTerm started from the Finder). And `null` —
//! "cannot tell", for which the page resumes as it always did — in every other
//! case: no config folder, no `projects`, one that is a link or not a folder, a
//! folder in it that is a link or could not be read, a transcript that is a
//! link or not a regular file, no marker, or a marker (or `session-env`) that
//! is a link or no folder.
//!
//! **The title (F16).** The conversation's title as Claude Code generated it:
//! the NEWEST `{"type":"ai-title","aiTitle":"…"}` record, which Claude Code
//! appends again as the conversation goes on, and with none the newest
//! `{"type":"last-prompt","lastPrompt":"…"}`. Each line is parsed as JSON
//! and taken only for exactly that `type` with a string value that is not
//! blank; anything else, a line that is not JSON, a record of that type with
//! no such string — one `last-prompt` variant has none — is passed over.
//! At most MAX_TITLE_CHARS characters of it are handed back; the page cleans
//! it, cuts it to the history's 200 and hides any secret in it
//! (`historyTitle`) before it is kept or shown.
//!
//! **Read-only and bounded.** Only the last TAIL_BYTES of a transcript are
//! read — the newest title was within 34 KB of the end in every titled
//! transcript measured, in files of up to 47 MB — and a first line that the
//! window starts in the middle of is passed over (`tail`). The
//! file is opened for reading only, never through a link (`O_NOFOLLOW`; on
//! Windows the reparse point itself, which is then no regular file), and
//! never written, locked or moved. Nothing of it but the title string leaves
//! this module, and nothing of it is logged.
//!
//! **The ids are the page's.** Each is checked to be a Claude Code session id
//! (`is_claude_id`, the shape `claude --session-id` takes) before any file is
//! looked at; one that is not is answered "cannot tell" and touches nothing
//! — it becomes a file name here. At most MAX_IDS are taken at once: the
//! history's own cap.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::agent_history::{is_claude_id, is_link, CAP};

/// The most ids one call takes: as many as the history keeps.
pub const MAX_IDS: usize = CAP;

/// How much of the end of a transcript is read: 256 KiB.
pub const TAIL_BYTES: u64 = 256 * 1024;

/// The most characters of a title handed back. The page keeps 200 of them;
/// this leaves room for the spaces its cleaning folds away, and keeps a long
/// pasted prompt from crossing to the page whole.
pub const MAX_TITLE_CHARS: usize = 1000;

/// Why a call with more than MAX_IDS ids is refused.
pub const TOO_MANY: &str = "At most 200 Claude Code conversations can be looked up at once";

/// The folder in the config folder that holds a folder per project.
const PROJECTS: &str = "projects";

/// The folder in the config folder that holds a folder per session started.
const SESSION_ENV: &str = "session-env";

/// What follows a session id in its transcript's name.
const TRANSCRIPT_EXTENSION: &str = "jsonl";

/// The record that holds Claude Code's own title for the conversation, and its field.
const AI_TITLE: (&str, &str) = ("ai-title", "aiTitle");

/// The record that holds the last prompt sent, and its field.
const LAST_PROMPT: (&str, &str) = ("last-prompt", "lastPrompt");

/// One conversation, as the page reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// The id as asked.
    pub session_id: String,
    /// Whether Claude Code saved a conversation under it: `None` when that
    /// cannot be told. See the module's doc.
    pub saved: Option<bool>,
    /// Its newest `ai-title`, else its newest `last-prompt`, else none.
    pub title: Option<String>,
}

/// Claude Code's config folder: `CLAUDE_CONFIG_DIR` (`from_env`) when it is
/// set to an absolute path, else `.claude` in `home`. None when neither is
/// to be had — a relative `CLAUDE_CONFIG_DIR` is relative to wherever Claude
/// Code was started, which is not known here.
pub fn config_dir(from_env: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    match from_env.filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)).filter(|dir| dir.is_absolute()),
        None => home
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .map(|home| home.join(".claude")),
    }
}

/// The conversation of each of `ids`, in order, from the Claude Code config
/// folder `config` (none: every answer is "cannot tell"). Refused for more
/// than MAX_IDS ids.
pub fn look_up(config: Option<&Path>, ids: &[String]) -> Result<Vec<Conversation>, String> {
    if ids.len() > MAX_IDS {
        return Err(TOO_MANY.to_string());
    }
    Ok(answer(ids, |wanted| config.and_then(|dir| search(dir, wanted))))
}

/// What a search of `projects` found.
struct Search {
    /// By session id: the transcripts found.
    found: HashMap<String, Found>,
    /// Whether every folder in `projects` was looked in. When one was not —
    /// a link, or one that could not be read — an id not found may be there.
    complete: bool,
    /// The ids not found whose session Claude Code started in this config
    /// folder (`has_marker`): only these are known never to have been saved.
    started: Vec<String>,
}

enum Found {
    /// A regular file, and the title read from it.
    Transcript(Option<String>),
    /// Something by that name that is not read: a link, or no regular file.
    NotRead,
}

/// `ids` answered from what `search` finds. `search` is handed the ids that
/// are Claude Code session ids, each once, and is not called at all when
/// there are none: an id that is not one never reaches the disk.
fn answer(ids: &[String], search: impl FnOnce(&[&str]) -> Option<Search>) -> Vec<Conversation> {
    let mut wanted: Vec<&str> = Vec::new();
    for id in ids {
        if is_claude_id(id) && !wanted.contains(&id.as_str()) {
            wanted.push(id);
        }
    }
    let searched = if wanted.is_empty() { None } else { search(&wanted) };
    ids.iter()
        .map(|id| {
            let (saved, title) = match &searched {
                Some(found) if is_claude_id(id) => match found.found.get(id.as_str()) {
                    Some(Found::Transcript(title)) => (Some(true), title.clone()),
                    Some(Found::NotRead) => (None, None),
                    None if found.complete && found.started.iter().any(|s| s == id) => (Some(false), None),
                    None => (None, None),
                },
                _ => (None, None),
            };
            Conversation { session_id: id.clone(), saved, title }
        })
        .collect()
}

/// Look in each direct sub-folder of `config`'s `projects` for the
/// transcript of each of `wanted`, never through a link, and for each one
/// not found, whether its session was started here (`has_marker`). None when
/// `projects` cannot be read: it is not there, not a folder, a link, or
/// listing it failed.
fn search(config: &Path, wanted: &[&str]) -> Option<Search> {
    let projects = config.join(PROJECTS);
    let projects = projects.as_path();
    let meta = fs::symlink_metadata(projects).ok()?;
    if is_link(&meta) || !meta.is_dir() {
        return None;
    }
    let mut complete = true;
    let mut folders = Vec::new();
    for item in fs::read_dir(projects).ok()? {
        let Ok(item) = item else {
            complete = false;
            continue;
        };
        let path = item.path();
        match fs::symlink_metadata(&path) {
            // A link is not followed, so what it leads to is not known.
            Ok(meta) if is_link(&meta) => complete = false,
            Ok(meta) if meta.is_dir() => folders.push(path),
            // A file beside the project folders is none of them.
            Ok(_) => {}
            Err(_) => complete = false,
        }
    }
    // The same answer whatever order the folder lists them in.
    folders.sort();

    let mut found: HashMap<String, Found> = HashMap::new();
    for folder in &folders {
        for &id in wanted {
            if matches!(found.get(id), Some(Found::Transcript(_))) {
                continue;
            }
            let path = folder.join(format!("{id}.{TRANSCRIPT_EXTENSION}"));
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_file() && !is_link(&meta) => {
                    found.insert(id.to_string(), Found::Transcript(title_in(&path)));
                }
                Ok(_) => {
                    found.entry(id.to_string()).or_insert(Found::NotRead);
                }
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                // The folder could not be looked in for it (no permission).
                Err(_) => complete = false,
            }
        }
    }
    let started = wanted
        .iter()
        .filter(|id| !found.contains_key(**id) && has_marker(config, id))
        .map(|id| id.to_string())
        .collect();
    Some(Search { found, complete, started })
}

/// Whether `config/session-env/<id>` is a real folder — `session-env` and it
/// each looked at themselves, never through a link: Claude Code made it when
/// a session under `id` started with this config folder.
fn has_marker(config: &Path, id: &str) -> bool {
    let real_folder = |path: &Path| fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta));
    let markers = config.join(SESSION_ENV);
    real_folder(&markers) && real_folder(&markers.join(id))
}

/// The title in the transcript at `path`, from its last TAIL_BYTES. None
/// when it holds none there, or cannot be read.
fn title_in(path: &Path) -> Option<String> {
    newest_title(&tail(path).ok()?)
}

/// The whole lines in the last TAIL_BYTES of the regular file at `path`,
/// read through a handle that was not opened through a link. A FIFO opened
/// by mistake does not hold the open (`O_NONBLOCK`), and is no regular file.
///
/// When the file goes on before the window, the window's first line may be
/// the end of a record, and is passed over — unless the byte just before the
/// window, read for this and nothing else, ends a line.
fn tail(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || is_link(&meta) {
        return Err(std::io::Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    let start = meta.len().saturating_sub(TAIL_BYTES);
    let before = start.min(1);
    file.seek(SeekFrom::Start(start - before))?;
    let mut bytes = Vec::new();
    // As much as there was when it was looked at: a file Claude Code is
    // appending to is not followed past the window.
    file.take(TAIL_BYTES + before).read_to_end(&mut bytes)?;
    if before == 0 {
        return Ok(bytes);
    }
    // Through the first line end, the byte before the window's included.
    let whole = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |at| at + 1);
    bytes.drain(..whole);
    Ok(bytes)
}

/// The newest `ai-title` in `lines`, else its newest `last-prompt`, at most
/// MAX_TITLE_CHARS characters.
fn newest_title(lines: &[u8]) -> Option<String> {
    let mut prompt = None;
    for line in lines.split(|&b| b == b'\n').rev() {
        if let Some(title) = text_of(line, AI_TITLE) {
            return Some(title);
        }
        if prompt.is_none() {
            prompt = text_of(line, LAST_PROMPT);
        }
    }
    prompt
}

/// The `field` of `line` when it is a record of exactly `kind` whose `field`
/// is a string that is not blank, cut to MAX_TITLE_CHARS characters.
fn text_of(line: &[u8], (kind, field): (&str, &str)) -> Option<String> {
    // Only a line that names the kind is parsed: a transcript's lines are
    // mostly the conversation itself, some of them long.
    let quoted = format!("\"{kind}\"");
    if !line.windows(quoted.len()).any(|w| w == quoted.as_bytes()) {
        return None;
    }
    let record: Value = serde_json::from_slice(line).ok()?;
    if record.get("type").and_then(Value::as_str) != Some(kind) {
        return None;
    }
    let text = record.get(field).and_then(Value::as_str)?;
    (!text.trim().is_empty()).then(|| text.chars().take(MAX_TITLE_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "d4bef4d0-c043-40ef-b157-640fb31ac0ea";
    const B: &str = "60a62d81-6923-4289-9d6d-7ce3f8f44043";
    const C: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    /// A Claude Code config folder of the test's own, empty, in the temporary folder.
    fn config(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-claude-conversations-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `config/projects/<folder>`, made.
    fn project(config: &Path, folder: &str) -> PathBuf {
        let dir = config.join(PROJECTS).join(folder);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(record: Value) -> String {
        format!("{record}\n")
    }

    fn title_record(title: &str) -> String {
        line(json!({"type": "ai-title", "aiTitle": title, "sessionId": A}))
    }

    fn prompt_record(prompt: &str) -> String {
        line(json!({"type": "last-prompt", "lastPrompt": prompt, "leafUuid": "x", "sessionId": A}))
    }

    /// A line of the conversation itself, `bytes` long with its newline.
    fn filler(bytes: usize) -> String {
        let head = r#"{"type":"user","message":""#;
        let tail = "\"}\n";
        format!("{head}{}{tail}", "x".repeat(bytes - head.len() - tail.len()))
    }

    /// The folder Claude Code makes in `config/session-env` when a session under `id` starts.
    fn marker(config: &Path, id: &str) -> PathBuf {
        let dir = config.join(SESSION_ENV).join(id);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(folder: &Path, id: &str, text: &str) -> PathBuf {
        let path = folder.join(format!("{id}.jsonl"));
        fs::write(&path, text).unwrap();
        path
    }

    fn one(config: &Path, id: &str) -> Conversation {
        look_up(Some(config), &[id.to_string()]).unwrap().remove(0)
    }

    fn saved(id: &str, title: Option<&str>) -> Conversation {
        Conversation { session_id: id.to_string(), saved: Some(true), title: title.map(str::to_string) }
    }

    fn unknown(id: &str) -> Conversation {
        Conversation { session_id: id.to_string(), saved: None, title: None }
    }

    #[test]
    fn of_several_titles_the_newest_is_the_one() {
        let dir = config("newest");
        let folder = project(&dir, "-Users-me-work");
        let text = [
            filler(300),
            title_record("First guess"),
            prompt_record("and then?"),
            filler(500),
            title_record("NexTerm project analysis"),
            filler(200),
            prompt_record("a later prompt"),
        ]
        .concat();
        write(&folder, A, &text);
        assert_eq!(one(&dir, A), saved(A, Some("NexTerm project analysis")), "the newest ai-title, over a later prompt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_no_title_the_newest_last_prompt_is() {
        let dir = config("prompt");
        let folder = project(&dir, "-Users-me-work");
        let variant = line(json!({"type": "last-prompt", "leafUuid": "y", "sessionId": A}));
        let text = [prompt_record("an early prompt"), filler(400), prompt_record("Fix the login flow"), variant, filler(100)].concat();
        write(&folder, A, &text);
        assert_eq!(one(&dir, A), saved(A, Some("Fix the login flow")), "the newest one with a prompt; the variant with none passed over");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_transcript_with_neither_is_saved_and_untitled() {
        let dir = config("neither");
        let folder = project(&dir, "-Users-me-work");
        write(&folder, A, &[filler(300), filler(300)].concat());
        write(&folder, B, "");
        assert_eq!(one(&dir, A), saved(A, None));
        assert_eq!(one(&dir, B), saved(B, None), "an empty transcript is still one");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Only the last TAIL_BYTES are read: a title whose line starts the
    /// window is found, one whose line the window starts inside is not, and
    /// neither is one well before it.
    #[test]
    fn a_title_before_the_last_256_kib_is_not_read() {
        let dir = config("bounded");
        let folder = project(&dir, "-Users-me-work");
        let window = TAIL_BYTES as usize;

        // The title's line and what follows it fill the window exactly.
        let title = title_record("Starts the window");
        let inside = [filler(5000), title.clone(), filler(window - title.len())].concat();
        write(&folder, A, &inside);
        assert_eq!(one(&dir, A), saved(A, Some("Starts the window")));

        // One byte more after it, and the window starts one byte into its line.
        let title = title_record("Cut by the window");
        let cut = [filler(5000), title.clone(), filler(window - title.len() + 1)].concat();
        write(&folder, B, &cut);
        assert_eq!(one(&dir, B), saved(B, None), "a record the window starts inside is not read");
        // Its rest is not taken for a record of its own either.
        let rest = tail(&folder.join(format!("{B}.jsonl"))).unwrap();
        assert_eq!(rest.len(), window - title.len() + 1, "the window, its cut first line passed over");

        // Well before, in a larger file, with a prompt after it in the window.
        let before = [
            title_record("Long ago"),
            filler(window),
            filler(window),
            prompt_record("the last prompt"),
            filler(1000),
        ]
        .concat();
        write(&folder, C, &before);
        assert_eq!(one(&dir, C), saved(C, Some("the last prompt")), "the old title is not read; the prompt is");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_records_of_exactly_that_shape_count() {
        let dir = config("shapes");
        let folder = project(&dir, "-Users-me-work");
        let text = [
            title_record("The real one"),
            line(json!({"type": "ai-title", "aiTitle": 7})),
            line(json!({"type": "ai-title", "aiTitle": "   "})),
            line(json!({"type": "ai-title-v2", "aiTitle": "another type"})),
            line(json!({"type": "user", "message": "\"ai-title\" said in a message"})),
            line(json!({"kind": "ai-title", "aiTitle": "no type"})),
            "{\"type\":\"ai-title\",\"aiTitle\":\"not closed\"\n".to_string(),
            "not json \"ai-title\"\n".to_string(),
            "\u{0}\u{ff}\"ai-title\"\n".to_string(),
        ]
        .concat();
        write(&folder, A, &text);
        assert_eq!(one(&dir, A).title.as_deref(), Some("The real one"));

        let long = "y".repeat(MAX_TITLE_CHARS + 50);
        write(&folder, B, &title_record(&format!("\u{e9}{long}")));
        let title = one(&dir, B).title.unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS, "cut to MAX_TITLE_CHARS characters");
        assert!(title.starts_with('\u{e9}'));
        let _ = fs::remove_dir_all(&dir);
    }

    /// No transcript, and the session-env marker Claude Code made when the
    /// session started: never saved. The marker without a transcript is what
    /// the measured never-saved session left.
    #[test]
    fn an_id_with_no_transcript_but_its_session_marker_was_never_saved() {
        let dir = config("unsaved");
        let folder = project(&dir, "-Users-me-work");
        write(&folder, A, &title_record("Someone else's"));
        // A project folder Claude Code made with only `memory/` in it, as the
        // measured never-saved session left.
        fs::create_dir_all(project(&dir, "-Users-me").join("memory")).unwrap();
        fs::write(dir.join(PROJECTS).join(format!("{B}.jsonl")), title_record("beside the folders")).unwrap();
        fs::create_dir_all(folder.join(format!("{C}.jsonl"))).unwrap();
        for id in [A, B, C] {
            marker(&dir, id);
        }
        let answers = look_up(Some(&dir), &[B.to_string(), A.to_string(), C.to_string()]).unwrap();
        assert_eq!(
            answers,
            vec![
                Conversation { session_id: B.to_string(), saved: Some(false), title: None },
                saved(A, Some("Someone else's")),
                unknown(C),
            ],
            "B nowhere in a project folder (a file directly in projects is not one); A's marker changes nothing; C a folder, not a transcript"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// No transcript and no real marker folder: the folder looked at may not
    /// be the one Claude Code used, so it cannot be told — never `false`.
    #[test]
    fn with_no_transcript_and_no_session_marker_it_cannot_be_told() {
        let dir = config("no-marker");
        let folder = project(&dir, "-Users-me-work");
        write(&folder, A, &title_record("Someone else's"));
        assert_eq!(one(&dir, B), unknown(B), "no session-env at all");
        marker(&dir, C);
        assert_eq!(one(&dir, B), unknown(B), "session-env there, B's marker not");
        fs::write(dir.join(SESSION_ENV).join(B), "a file").unwrap();
        assert_eq!(one(&dir, B), unknown(B), "a marker that is a file is none");
        assert_eq!(one(&dir, C), Conversation { session_id: C.to_string(), saved: Some(false), title: None }, "premise: C's is one");

        // Markers there but `projects` not: still cannot be told.
        let bare = config("marker-no-projects");
        marker(&bare, B);
        assert_eq!(one(&bare, B), unknown(B));
        // A `session-env` that is a file.
        let filed = config("marker-file");
        project(&filed, "-Users-me-work");
        fs::write(filed.join(SESSION_ENV), "a file").unwrap();
        assert_eq!(one(&filed, B), unknown(B));
        for d in [dir, bare, filed] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn with_no_projects_folder_it_cannot_be_told() {
        let dir = config("no-projects");
        assert_eq!(one(&dir, A), unknown(A), "no projects folder");
        fs::write(dir.join(PROJECTS), "a file").unwrap();
        assert_eq!(one(&dir, A), unknown(A), "projects is a file");
        assert_eq!(look_up(None, &[A.to_string()]).unwrap(), vec![unknown(A)], "no config folder");
        assert_eq!(one(&dir.join("not-there"), A), unknown(A));
        let _ = fs::remove_dir_all(&dir);
    }

    /// An id that is not a Claude Code session id is never looked for: the
    /// search is not even called for it.
    #[test]
    fn an_invalid_id_is_refused_without_touching_the_disk() {
        let bad = [
            "../../../etc/passwd".to_string(),
            "D4BEF4D0-C043-40EF-B157-640FB31AC0EA".to_string(),
            format!("{A}/../{B}"),
            format!("{A} "),
            String::new(),
            "*".to_string(),
        ];
        let answers = answer(&bad, |_| panic!("the disk was looked at for an invalid id"));
        assert_eq!(answers, bad.iter().map(|id| unknown(id)).collect::<Vec<_>>());

        let mixed = [bad[0].clone(), A.to_string(), bad[1].clone(), A.to_string(), B.to_string()];
        let mut asked = Vec::new();
        let answers = answer(&mixed, |wanted| {
            asked = wanted.iter().map(|id| id.to_string()).collect();
            Some(Search {
                found: HashMap::from([(A.to_string(), Found::Transcript(Some("t".to_string())))]),
                complete: true,
                started: vec![B.to_string()],
            })
        });
        assert_eq!(asked, vec![A.to_string(), B.to_string()], "only the valid ids, each once");
        assert_eq!(answers.iter().map(|c| c.saved).collect::<Vec<_>>(), vec![None, Some(true), None, Some(true), Some(false)]);

        // And on a disk where a file of each bad name exists.
        let dir = config("invalid");
        let folder = project(&dir, "-Users-me-work");
        fs::write(folder.join("D4BEF4D0-C043-40EF-B157-640FB31AC0EA.jsonl"), title_record("upper")).unwrap();
        fs::write(dir.join(PROJECTS).join(format!("{B}.jsonl")), title_record("up a folder")).unwrap();
        let answers = look_up(Some(&dir), &[bad[1].clone(), bad[2].clone()]).unwrap();
        assert_eq!(answers, vec![unknown(&bad[1]), unknown(&bad[2])]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn at_most_200_ids_at_once_each_answered_in_order() {
        let ids: Vec<String> = (0..MAX_IDS).map(|_| A.to_string()).collect();
        assert_eq!(look_up(None, &ids).unwrap().len(), MAX_IDS);
        let over: Vec<String> = (0..=MAX_IDS).map(|_| A.to_string()).collect();
        assert_eq!(look_up(None, &over), Err(TOO_MANY.to_string()));
        assert_eq!(look_up(None, &[]).unwrap(), vec![]);
    }

    #[test]
    fn the_config_folder_is_claude_config_dir_else_dot_claude_at_home() {
        let os = |s: &str| Some(OsString::from(s));
        let home = if cfg!(windows) { r"C:\Users\me" } else { "/Users/me" };
        let set = if cfg!(windows) { r"D:\claude" } else { "/opt/claude" };
        assert_eq!(config_dir(os(set), os(home)), Some(PathBuf::from(set)));
        assert_eq!(config_dir(None, os(home)), Some(PathBuf::from(home).join(".claude")));
        assert_eq!(config_dir(os(""), os(home)), Some(PathBuf::from(home).join(".claude")), "set but empty is not set");
        assert_eq!(config_dir(os("relative/claude"), os(home)), None, "relative to a folder not known here");
        assert_eq!(config_dir(None, None), None);
        assert_eq!(config_dir(None, os("")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_not_followed() {
        use std::os::unix::fs::symlink;
        let dir = config("links");
        let elsewhere = config("links-target");
        let target = write(&elsewhere, "target", &title_record("Behind a link"));

        // The transcript a link: not read, and so not known to be saved.
        let folder = project(&dir, "-Users-me-work");
        symlink(&target, folder.join(format!("{A}.jsonl"))).unwrap();
        assert_eq!(one(&dir, A), unknown(A));

        // A project folder that is a link: not looked in, so an id not found
        // elsewhere may be in it.
        write(&elsewhere, B, &title_record("In a linked folder"));
        symlink(&elsewhere, dir.join(PROJECTS).join("-linked")).unwrap();
        assert_eq!(one(&dir, B), unknown(B));
        assert_eq!(one(&dir, C), unknown(C), "nor is one in no folder known never to have been saved");

        // A session marker that is a link, and a `session-env` that is one.
        let marked = config("links-marker");
        project(&marked, "-Users-me-work");
        fs::create_dir_all(marked.join(SESSION_ENV)).unwrap();
        fs::create_dir_all(elsewhere.join("markers").join(B)).unwrap();
        symlink(elsewhere.join("markers").join(B), marked.join(SESSION_ENV).join(B)).unwrap();
        assert_eq!(one(&marked, B), unknown(B), "a marker that is a link is none");
        let linked_env = config("links-session-env");
        project(&linked_env, "-Users-me-work");
        symlink(elsewhere.join("markers"), linked_env.join(SESSION_ENV)).unwrap();
        assert_eq!(one(&linked_env, B), unknown(B), "nor one reached through a linked session-env");

        // `projects` itself a link.
        let other = config("links-projects");
        fs::create_dir_all(elsewhere.join("p")).unwrap();
        write(&elsewhere.join("p"), C, &title_record("Through projects"));
        symlink(&elsewhere, other.join(PROJECTS)).unwrap();
        assert_eq!(one(&other, C), unknown(C));

        // A transcript swapped for a link after it was looked at is not read
        // through either: the open itself does not follow one.
        let swapped = folder.join(format!("{B}.jsonl"));
        symlink(&target, &swapped).unwrap();
        assert!(tail(&swapped).is_err());
        assert_eq!(title_in(&swapped), None);

        for d in [dir, elsewhere, other, marked, linked_env] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_like_a_transcript_is_not_waited_on() {
        let dir = config("fifo");
        let folder = project(&dir, "-Users-me-work");
        let path = folder.join(format!("{A}.jsonl"));
        let name = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a path we just made, NUL-terminated.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(one(&dir, A), unknown(A), "no regular file: not read, not known");
        assert!(tail(&path).is_err(), "and the open does not wait for a writer");
        let _ = fs::remove_dir_all(&dir);
    }
}
