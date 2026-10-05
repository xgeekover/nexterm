//! The conversations an agent CLI keeps, for picking one back up in a
//! terminal (src/lib/agents.js).
//!
//! Only opencode needs listing. claude's conversations are named by NexTerm
//! itself (`--session-id`), while opencode chooses its own ids and only shows
//! a conversation's TITLE, in the terminal's title (`OC | <title>`). Its CLI
//! maps titles back to ids: `opencode session list --format json` (1.18.34)
//! answers every conversation with its id, title, directory and times, from
//! whichever directory it is run in. Two uses:
//!
//! - matching the title an opencode terminal shows to its conversation, so
//!   the terminal can resume exactly that one after a restart;
//! - the resume banner's "Choose…" list, for when it cannot.
//!
//! How it is run, and why:
//!
//! - From the temp directory, with `--pure` (no external plugins) and
//!   OPENCODE_DISABLE_AUTOUPDATE: listing loads no project's config or
//!   plugins and updates nothing. Which directory a conversation belongs to
//!   is decided here instead (`same_dir`), from its own `directory`.
//! - Found on the PATH of the user's login shell, read once (unix). An app
//!   started from the Finder or a desktop launcher gets a bare PATH, while
//!   opencode lives wherever the user's shell setup puts it — nvm, bun,
//!   ~/.opencode/bin. Windows hands a GUI app the user's own PATH.
//! - Against a deadline, so a CLI that hangs costs an answer, not a thread.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
#[cfg(unix)]
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// One conversation, as the frontend reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    /// Milliseconds since the epoch, as opencode keeps them.
    pub updated: i64,
    pub created: i64,
}

/// One entry of `opencode session list --format json`.
#[derive(Debug, Clone, Deserialize)]
struct ListedSession {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    updated: i64,
    #[serde(default)]
    created: i64,
    #[serde(default)]
    directory: String,
}

/// How many conversations opencode is asked for; the newest come first.
const LIST_LIMIT: &str = "500";
/// How many of one directory's are handed back.
const MAX_RETURNED: usize = 100;
/// Long enough for a cold start of a 140 MB binary on a slow disk.
const LIST_DEADLINE: Duration = Duration::from_secs(20);
/// An interactive login shell that takes longer than this is not answering.
#[cfg(unix)]
const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(10);

/// What brackets the PATH a login shell prints, so that whatever else its
/// startup files print around it is ignored.
#[cfg(unix)]
const PATH_MARK: &str = "__NEXTERM_PATH__";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The conversations `kind` keeps for the directory `cwd`, newest first.
#[tauri::command]
pub async fn agent_sessions(kind: String, cwd: String) -> Result<Vec<AgentSession>, String> {
    if kind != "opencode" {
        return Err(format!("{kind} keeps no list NexTerm can read"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = search_path();
        let bin = find_opencode(path.as_deref()).ok_or_else(|| "opencode was not found on PATH".to_string())?;
        opencode_sessions(&bin, path.as_deref(), Path::new(&cwd))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `bin session list` and keep `dir`'s conversations.
fn opencode_sessions(bin: &Path, path: Option<&std::ffi::OsStr>, dir: &Path) -> Result<Vec<AgentSession>, String> {
    let mut command = quiet_command(bin);
    command
        .args(["session", "list", "--format", "json", "--pure", "-n", LIST_LIMIT])
        .current_dir(std::env::temp_dir())
        .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = run_with_deadline(command, LIST_DEADLINE)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no reason given");
        return Err(format!("opencode session list failed: {reason}"));
    }
    let listed = parse_list(&String::from_utf8_lossy(&output.stdout))?;
    Ok(in_directory(listed, dir))
}

/// The list opencode printed. Nothing at all is how it answers "none" (seen
/// with an empty data directory); anything before the opening `[` — an
/// update notice, a warning — is skipped.
fn parse_list(stdout: &str) -> Result<Vec<ListedSession>, String> {
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let start = stdout.find('[').ok_or_else(|| "opencode printed no session list".to_string())?;
    serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter::<Vec<ListedSession>>()
        .next()
        .ok_or_else(|| "opencode printed no session list".to_string())?
        .map_err(|e| format!("opencode's session list could not be read: {e}"))
}

/// The conversations whose directory is `dir`, newest first.
fn in_directory(listed: Vec<ListedSession>, dir: &Path) -> Vec<AgentSession> {
    let Some(wanted) = comparable(&dir.to_string_lossy()) else {
        return Vec::new();
    };
    // Conversations share directories; each is resolved once.
    let mut seen: HashMap<String, bool> = HashMap::new();
    let mut found: Vec<AgentSession> = listed
        .into_iter()
        .filter(|s| {
            *seen
                .entry(s.directory.clone())
                .or_insert_with(|| comparable(&s.directory).as_deref() == Some(wanted.as_str()))
        })
        .map(|s| AgentSession { id: s.id, title: s.title, updated: s.updated, created: s.created })
        .collect();
    found.sort_by(|a, b| b.updated.cmp(&a.updated));
    found.truncate(MAX_RETURNED);
    found
}

/// A directory as two spellings of it compare equal: resolved (symlinks —
/// macOS's /tmp is /private/tmp — and `..`), without a trailing separator,
/// and on the platforms whose filesystems ignore case by default, lowercase.
fn comparable(path: &str) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let raw = Path::new(path);
    let resolved = dunce::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf());
    let mut text = resolved.to_string_lossy().to_string();
    if cfg!(windows) {
        text = text.replace('/', "\\");
    }
    while text.len() > 1 && (text.ends_with('/') || text.ends_with('\\')) && !text.ends_with(":\\") {
        text.pop();
    }
    if cfg!(any(windows, target_os = "macos")) {
        text = text.to_lowercase();
    }
    Some(text)
}

/// Where to look for opencode: the login shell's PATH, then this process's.
fn search_path() -> Option<OsString> {
    let own = std::env::var_os("PATH");
    #[cfg(unix)]
    {
        if let Some(login) = login_shell_path() {
            let mut dirs: Vec<PathBuf> = std::env::split_paths(&login).collect();
            if let Some(own) = &own {
                dirs.extend(std::env::split_paths(own));
            }
            return std::env::join_paths(dirs).ok().or(own);
        }
    }
    own
}

/// The PATH the user's interactive login shell sets up, read once per run —
/// or None when it cannot be (no shell to ask, one whose syntax this does not
/// speak, a timeout, startup files that never got to the end).
#[cfg(unix)]
fn login_shell_path() -> Option<OsString> {
    static LOGIN_PATH: OnceLock<Option<OsString>> = OnceLock::new();
    LOGIN_PATH.get_or_init(read_login_shell_path).clone()
}

#[cfg(unix)]
fn read_login_shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .or_else(|| cfg!(target_os = "macos").then(|| OsString::from("/bin/zsh")))?;
    let name = Path::new(&shell).file_name()?.to_string_lossy().to_string();
    let script = match name.as_str() {
        "fish" => format!("printf '\\n%s%s%s\\n' {PATH_MARK} (string join : $PATH) {PATH_MARK}"),
        "zsh" | "bash" | "sh" | "ksh" | "dash" => {
            format!("printf '\\n%s%s%s\\n' {PATH_MARK} \"$PATH\" {PATH_MARK}")
        }
        // nushell, xonsh, elvish: a syntax of their own.
        _ => return None,
    };
    let mut command = quiet_command(&shell);
    command
        .args(["-i", "-l", "-c", &script])
        // For startup files that want to skip work when nobody is looking —
        // VS Code sets VSCODE_RESOLVING_ENVIRONMENT for the same purpose.
        .env("NEXTERM_RESOLVING_ENVIRONMENT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = run_with_deadline(command, LOGIN_SHELL_DEADLINE).ok()?;
    marked(&String::from_utf8_lossy(&output.stdout), PATH_MARK).map(OsString::from)
}

/// A command that opens no console window: on Windows a console program
/// started by a GUI app gets one of its own unless told not to, and opencode
/// is one (see `git` in src/fs/git.rs, which met this first).
fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    // Changed only on Windows.
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The text between the last pair of `mark`s, when there is one and it is not empty.
#[cfg(unix)]
fn marked(text: &str, mark: &str) -> Option<String> {
    let end = text.rfind(mark)?;
    let start = text[..end].rfind(mark)? + mark.len();
    let value = &text[start..end];
    (!value.is_empty() && !value.contains('\n')).then(|| value.to_string())
}

/// opencode's executable on `path`, or in the places its installers use.
fn find_opencode(path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    #[cfg(windows)]
    const NAMES: &[&str] = &["opencode.exe", "opencode.cmd", "opencode.bat"];
    #[cfg(not(windows))]
    const NAMES: &[&str] = &["opencode"];

    if let Some(path) = path {
        for dir in std::env::split_paths(path) {
            for name in NAMES {
                let candidate = dir.join(name);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let mut known: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        known.push(home.join(".opencode").join("bin"));
        known.push(home.join(".bun").join("bin"));
    }
    if cfg!(not(windows)) {
        known.push(PathBuf::from("/opt/homebrew/bin"));
        known.push(PathBuf::from("/usr/local/bin"));
    }
    known
        .into_iter()
        .flat_map(|dir| NAMES.iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Run `command` to completion, or kill it at `deadline`. Its output is read
/// on threads of their own, so a child that fills a pipe cannot stall, and a
/// grandchild that keeps the pipe open past the end cannot hold this up.
fn run_with_deadline(mut command: Command, deadline: Duration) -> Result<Output, String> {
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("gave up after {} s", deadline.as_secs()));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    // What a grandchild still holds open is not waited for.
    let grace = Duration::from_millis(500);
    Ok(Output {
        status,
        stdout: stdout.recv_timeout(grace).unwrap_or_default(),
        stderr: stderr.recv_timeout(grace).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What opencode 1.18.34 printed, measured in a sandbox (two of eleven).
    const LISTED: &str = r#"[
  {
    "id": "ses_ef45006f5ffeAMtumN5ySj4VmT",
    "title": "Hello from the mock.",
    "updated": 1791197445787,
    "created": 1791197444362,
    "projectId": "global",
    "directory": "/somewhere/proj"
  },
  {
    "id": "ses_ef5480fb7ffeAsS3ztDO8RZEA4",
    "title": "Hello from the mock.",
    "updated": 1791181190703,
    "created": 1791181189192,
    "projectId": "global",
    "directory": "/somewhere/proj"
  }
]
"#;

    fn listed(id: &str, title: &str, updated: i64, directory: &str) -> ListedSession {
        ListedSession {
            id: id.to_string(),
            title: title.to_string(),
            updated,
            created: updated - 1,
            directory: directory.to_string(),
        }
    }

    #[test]
    fn the_measured_list_is_read() {
        let got = parse_list(LISTED).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "ses_ef45006f5ffeAMtumN5ySj4VmT");
        assert_eq!(got[0].title, "Hello from the mock.");
        assert_eq!(got[0].updated, 1791197445787);
        assert_eq!(got[1].directory, "/somewhere/proj");
    }

    #[test]
    fn nothing_printed_is_no_conversations_and_noise_before_the_list_is_skipped() {
        assert!(parse_list("").unwrap().is_empty());
        assert!(parse_list("  \n").unwrap().is_empty());
        assert!(parse_list("[]").unwrap().is_empty());
        let got = parse_list(&format!("Update available: 1.18.35\n{LISTED}trailing words")).unwrap();
        assert_eq!(got.len(), 2);
        assert!(parse_list("not json at all").is_err());
        assert!(parse_list("[{\"title\": \"no id\"}]").is_err());
    }

    #[test]
    fn only_the_directorys_own_come_back_newest_first() {
        let dir = std::env::temp_dir().join(format!("nexterm-agent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let here = dir.to_string_lossy().to_string();
        let got = in_directory(
            vec![
                listed("ses_aaaaaaaaaaaa", "old", 10, &here),
                listed("ses_bbbbbbbbbbbb", "elsewhere", 30, "/not/this/one"),
                listed("ses_cccccccccccc", "new", 20, &format!("{here}{}", std::path::MAIN_SEPARATOR)),
            ],
            &dir,
        );
        assert_eq!(
            got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["ses_cccccccccccc", "ses_aaaaaaaaaaaa"],
            "the other directory's is left out, a trailing separator is the same directory"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_reached_through_a_symlink_is_the_same_directory() {
        // macOS's /tmp is /private/tmp: the shell reports one spelling and
        // opencode, which resolves its cwd, may keep the other.
        let base = std::env::temp_dir().join(format!("nexterm-agent-link-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let got = in_directory(
            vec![listed("ses_dddddddddddd", "t", 1, &real.to_string_lossy())],
            &link,
        );
        assert_eq!(got.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_directory_matches_nothing() {
        assert!(in_directory(vec![listed("ses_eeeeeeeeeeee", "t", 1, "")], Path::new("")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_path_is_read_from_between_the_marks_whatever_the_startup_files_print() {
        let out = format!("Welcome!\n\n{PATH_MARK}/a/bin:/b/bin{PATH_MARK}\nbye\n");
        assert_eq!(marked(&out, PATH_MARK).as_deref(), Some("/a/bin:/b/bin"));
        assert_eq!(marked("no marks here", PATH_MARK), None);
        assert_eq!(marked(&format!("{PATH_MARK}{PATH_MARK}"), PATH_MARK), None, "empty is nothing");
        assert_eq!(marked(&format!("{PATH_MARK}only one"), PATH_MARK), None);
    }

    #[cfg(unix)]
    #[test]
    fn opencode_is_found_on_the_path_only_when_it_can_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nexterm-agent-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("opencode");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        assert_ne!(find_opencode(Some(&path)), Some(bin.clone()), "not executable: not this one");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_opencode(Some(&path)), Some(bin.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_stand_in_cli_is_run_from_the_temp_directory_and_its_list_narrowed() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nexterm-agent-cli-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let here = project.to_string_lossy().to_string();
        let bin = base.join("opencode");
        // Records its arguments and where it ran, then answers like opencode.
        let script = format!(
            "#!/bin/sh\necho \"$@\" > '{log}'\npwd >> '{log}'\nprintf '%s' '[{{\"id\":\"ses_ffffffffffff\",\"title\":\"Mine\",\"updated\":5,\"created\":4,\"directory\":\"{here}\"}},{{\"id\":\"ses_gggggggggggg\",\"title\":\"Not mine\",\"updated\":9,\"created\":8,\"directory\":\"/elsewhere\"}}]'\n",
            log = base.join("args.log").to_string_lossy(),
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let got = opencode_sessions(&bin, None, &project).unwrap();
        assert_eq!(got, vec![AgentSession { id: "ses_ffffffffffff".into(), title: "Mine".into(), updated: 5, created: 4 }]);
        let log = std::fs::read_to_string(base.join("args.log")).unwrap();
        let mut lines = log.lines();
        assert_eq!(lines.next(), Some("session list --format json --pure -n 500"));
        let ran_in = lines.next().unwrap();
        assert_ne!(
            dunce::canonicalize(ran_in).ok(),
            dunce::canonicalize(&project).ok(),
            "never run inside the project, whose config and plugins it would load"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_cli_says_why_and_a_hanging_one_is_given_up_on() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nexterm-agent-fail-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let bin = base.join("opencode");
        std::fs::write(&bin, "#!/bin/sh\necho 'Error: database is locked' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = opencode_sessions(&bin, None, &base).unwrap_err();
        assert!(err.contains("database is locked"), "{err}");

        let mut sleeper = Command::new("sleep");
        sleeper.arg("5").stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = Instant::now();
        let err = run_with_deadline(sleeper, Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("gave up"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(3), "the deadline held");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_opencode_has_a_list() {
        let err = tauri::async_runtime::block_on(agent_sessions("claude".into(), "/".into())).unwrap_err();
        assert!(err.contains("claude"), "{err}");
    }
}
