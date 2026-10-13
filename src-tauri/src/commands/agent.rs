//! The conversations an agent CLI keeps, for picking one back up in a
//! terminal (src/lib/agents.js).
//!
//! Only opencode needs listing. claude's conversations are named by NexTerm
//! itself (`--session-id`), while opencode chooses its own ids and only shows
//! a conversation's TITLE, in the terminal's title (`OC | <title>`). Its CLI
//! maps titles back to ids: `opencode session list --format json` (1.18.34)
//! answers conversations with their id, title, directory and times — but
//! only those of the PROJECT its own working directory belongs to: the git
//! repository it is in (every conversation started anywhere in it), or for a
//! folder outside any repository the one "global" project all such folders
//! share (measured 2026-10-13 with isolated data). Two uses:
//!
//! - matching the title an opencode terminal shows to its conversation, so
//!   the terminal can resume exactly that one after a restart;
//! - the resume banner's "Choose…" list, for when it cannot.
//!
//! How it is run, and why:
//!
//! - From the terminal's own folder (`run_dir`), with `--pure` (no external
//!   plugins) and OPENCODE_DISABLE_AUTOUPDATE. It used to run from the temp
//!   directory so that listing would load no repository's config or plugins
//!   — and from there it only ever listed the "global" project: in a git
//!   repository no terminal learned its conversation, and every resume fell
//!   back to the folder's most recent. The folder is the one the user runs
//!   opencode in anyway, and `--pure` keeps its external plugins out. Which
//!   directory a conversation belongs to is still decided here
//!   (`in_directory`), from its own `directory`: where opencode was started,
//!   which in a repository may be any folder below its root.
//! - Found on the PATH of the user's login shell, read once (unix). An app
//!   started from the Finder or a desktop launcher gets a bare PATH, while
//!   opencode lives wherever the user's shell setup puts it — nvm, bun,
//!   ~/.opencode/bin. Windows hands a GUI app the user's own PATH.
//! - Against a deadline, so a CLI that hangs costs an answer, not a thread.
//! - Without `--pure` or `-n` when this opencode does not know them
//!   (`refused_flags`): an unknown flag is a usage screen and exit 1, and an
//!   older opencode would otherwise never list anything. Once, within the
//!   same deadline.
//! - Saying why when it fails, in words a user can pass on: the backend's
//!   reason is shown on the resume offer (`failure_reason`), and on Windows
//!   cmd.exe's own complaints are read in the console's code page
//!   (`stderr_text`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
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

/// The flags `session list` is run with that are a nicety, not the point:
/// `--pure` (no external plugins) and `-n` (a cap). An opencode that does
/// not know one refuses the whole command, so it is run again without it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OptionalFlags {
    pure: bool,
    max_count: bool,
}

impl OptionalFlags {
    const ALL: OptionalFlags = OptionalFlags { pure: true, max_count: true };

    /// These, less the ones `refused` says this opencode does not know.
    fn without(self, refused: OptionalFlags) -> OptionalFlags {
        OptionalFlags { pure: self.pure && !refused.pure, max_count: self.max_count && !refused.max_count }
    }

    fn args(self) -> Vec<&'static str> {
        let mut args = vec!["session", "list", "--format", "json"];
        if self.pure {
            args.push("--pure");
        }
        if self.max_count {
            args.extend(["-n", LIST_LIMIT]);
        }
        args
    }
}

/// Run `bin session list` and keep `dir`'s conversations.
fn opencode_sessions(bin: &Path, path: Option<&std::ffi::OsStr>, dir: &Path) -> Result<Vec<AgentSession>, String> {
    let started = Instant::now();
    let run_in = run_dir(dir);
    let mut flags = OptionalFlags::ALL;
    let mut output = run_list(bin, path, &run_in, flags, LIST_DEADLINE)?;
    // Whether the list was read from outside the terminal's project.
    let mut outside = false;
    if !output.status.success() {
        // Refused for a flag it does not know: once more without it, in
        // what is left of the same deadline. Anything else is reported as
        // it is — a database that is locked is not cured by fewer flags.
        let fewer = flags.without(refused_flags(&stderr_text(&output.stderr)));
        let left = LIST_DEADLINE.saturating_sub(started.elapsed());
        if fewer != flags && left >= Duration::from_secs(1) {
            // Without `--pure` an opencode run in the folder loads its
            // project's own plugins (its opencode.json), so that retry runs
            // from the temp directory — where a git repository's
            // conversations are not listed, which the error below says.
            let retry_in = if flags.pure && !fewer.pure { std::env::temp_dir() } else { run_in.clone() };
            outside = retry_in != run_in;
            flags = fewer;
            output = run_list(bin, path, &retry_in, flags, left)?;
        }
    }
    if !output.status.success() {
        let reason = failure_reason(
            &stderr_text(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
            output.status.code(),
        );
        return Err(format!("opencode session list failed: {reason}"));
    }
    let listed = parse_list(&String::from_utf8_lossy(&output.stdout))?;
    let found = in_directory(listed, dir);
    if outside && found.is_empty() && in_git_repository(&run_in) {
        return Err("this opencode does not know --pure, so its list was read outside this git repository, \
             where the repository's conversations do not show; a newer opencode lists them"
            .to_string());
    }
    Ok(found)
}

/// Whether `dir` is in a git repository: it or a folder above it holds
/// `.git`, which is how opencode tells its projects apart.
fn in_git_repository(dir: &Path) -> bool {
    dir.ancestors().any(|d| d.join(".git").exists())
}

/// Where `session list` runs for the terminal folder `dir`: in it, since the
/// list holds only the conversations of the project the working directory
/// belongs to. A folder that is gone runs in its nearest ancestor that is
/// still there — most often in the same repository. One on another machine
/// (`resolvable`) never runs there: a terminal's folder cannot be one — the
/// backend drops such an OSC 7 and starts no shell in one — so it can only
/// come from a saved workspace, which must not make NexTerm sign in to a
/// host. Those, and an empty one, list from the temp directory: the
/// "global" project, compared by spelling.
fn run_dir(dir: &Path) -> PathBuf {
    let spelled = dir.to_string_lossy();
    if spelled.trim().is_empty() || !dir.is_absolute() || !resolvable(&spelled) {
        return std::env::temp_dir();
    }
    dir.ancestors().find(|d| d.is_dir()).map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir)
}

/// One run of `bin session list` with `flags`, in `run_in`.
fn run_list(
    bin: &Path,
    path: Option<&std::ffi::OsStr>,
    run_in: &Path,
    flags: OptionalFlags,
    deadline: Duration,
) -> Result<Output, String> {
    let mut command = quiet_command(bin);
    command
        .args(flags.args())
        .current_dir(run_in)
        .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        command.env("PATH", path);
    }
    // A process group of its own, which `kill_tree` ends whole. Not for the
    // login shell (`read_login_shell_path`): an interactive shell moved out
    // of the terminal's group can be stopped by it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    run_with_deadline(command, deadline).map_err(|e| format!("opencode session list: {e}"))
}

/// Which of the `OptionalFlags` this opencode refused, from what it printed
/// when it failed — conservatively: a flag counts as refused only when the
/// output names it as unknown, or is a usage screen for `session list` that
/// does not list it.
///
/// opencode 1.18.34, handed a flag it does not know, prints the usage of
/// `session list` to stderr — and nothing else, no "Unknown argument" line
/// — and exits 1 (measured). yargs' own `Unknown argument(s): pure, n` is
/// read too, for a build that lets it through.
fn refused_flags(stderr: &str) -> OptionalFlags {
    let text = without_ansi(stderr);
    let mut refused = OptionalFlags { pure: false, max_count: false };
    for line in text.lines() {
        // ASCII lowercasing keeps every byte where it was, so `at` indexes both.
        let Some(at) = line.to_ascii_lowercase().find("unknown argument") else {
            continue;
        };
        let names = line[at..].split_once(':').map_or("", |(_, names)| names);
        for name in names.split(|c: char| c == ',' || c.is_whitespace()) {
            match name.trim_start_matches('-') {
                "pure" => refused.pure = true,
                "n" | "max-count" => refused.max_count = true,
                _ => {}
            }
        }
    }
    if refused.pure || refused.max_count {
        return refused;
    }
    if let Some(known) = usage_flags(&text) {
        refused.pure = !known.iter().any(|f| f == "--pure");
        refused.max_count = !known.iter().any(|f| f == "-n" || f == "--max-count");
    }
    refused
}

/// The flags a usage screen for `session list` lists, or None when `text` is
/// not one. Known by its first line, the command it describes, and by its
/// option lines, which start with the flags — not by its headings, which
/// yargs translates.
fn usage_flags(text: &str) -> Option<Vec<String>> {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    if !first.contains("session list") {
        return None;
    }
    let flags: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('-'))
        .flat_map(|l| {
            l.split_whitespace()
                .take_while(|w| w.starts_with('-'))
                .map(|w| w.trim_end_matches(',').to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    (!flags.is_empty()).then_some(flags)
}

/// Why a `session list` failed, as one line for the resume offer: a line
/// that says "error" if there is one, else the first two things it printed
/// — stderr first; cmd.exe breaks its one sentence over two — else its exit
/// code. Not the first line of a usage screen, which is only the command's
/// own name (measured): that says so instead, and whether this opencode can
/// print JSON at all.
fn failure_reason(stderr: &str, stdout: &str, code: Option<i32>) -> String {
    let (stderr, stdout) = (without_ansi(stderr), without_ansi(stdout));
    if let Some(known) = usage_flags(&stderr).or_else(|| usage_flags(&stdout)) {
        return if known.iter().any(|f| f == "--format") {
            "it printed its usage instead of a list".to_string()
        } else {
            "this opencode cannot print its sessions as JSON (no --format); a newer opencode can".to_string()
        };
    }
    let lines: Vec<&str> = stderr.lines().chain(stdout.lines()).map(str::trim).filter(|l| !l.is_empty()).collect();
    if let Some(line) = lines.iter().find(|l| l.to_ascii_lowercase().contains("error")) {
        return clipped(line, 300);
    }
    match (lines.len(), code) {
        (0, Some(code)) => format!("it exited with code {code} and said nothing"),
        (0, None) => "it was stopped before it finished".to_string(),
        (n, _) => clipped(&lines[..n.min(2)].join(" "), 300),
    }
}

/// `text` without its colour codes (CSI sequences), which a CLI may print
/// even into a pipe.
fn without_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            // Parameters and intermediates, up to the final byte.
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// At most `max` characters of `text`, with `…` when cut.
fn clipped(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}\u{2026}", &text[..at]),
        None => text.to_string(),
    }
}

/// What a program wrote to stderr, as text. opencode writes UTF-8. On
/// Windows npm's `opencode.cmd` runs it through cmd.exe, and what cmd says
/// itself — `'node' is not recognized…` — is in the console's code page,
/// CP949 on a Korean system: not UTF-8, so read in the OEM code page rather
/// than turned into U+FFFD, which would leave the user nothing to report.
fn stderr_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => from_oem_code_page(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned()),
    }
}

#[cfg(windows)]
fn from_oem_code_page(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    let len = i32::try_from(bytes.len()).ok()?;
    if len == 0 {
        return Some(String::new());
    }
    // SAFETY: `bytes` is valid for `len` bytes; the first call only measures,
    // and the second writes at most `wide.len()` u16s into `wide`.
    let needed = unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return None;
    }
    let mut wide = vec![0u16; needed as usize];
    let written = unsafe { MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), needed) };
    if written <= 0 {
        return None;
    }
    wide.truncate(written as usize);
    Some(String::from_utf16_lossy(&wide))
}

#[cfg(not(windows))]
fn from_oem_code_page(_bytes: &[u8]) -> Option<String> {
    None
}

/// The list opencode printed. Nothing at all is how it answers "none" (seen
/// with an empty data directory). Whatever comes before it — an update
/// notice, coloured or not, a `[opencode] …` tag, a migration's `[1/3]` — is
/// skipped: the list starts on a line of its own, at its `[`, so each line
/// that starts with one is tried in turn, colour codes taken out first.
/// The first `[` anywhere was once taken for it, and a tag or a counter
/// before the list made it unreadable.
fn parse_list(stdout: &str) -> Result<Vec<ListedSession>, String> {
    let text = without_ansi(stdout);
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut last_error = None;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let start = at + (line.len() - line.trim_start().len());
        at += line.len();
        if !text[start..].starts_with('[') {
            continue;
        }
        match serde_json::Deserializer::from_str(&text[start..]).into_iter::<Vec<ListedSession>>().next() {
            Some(Ok(listed)) => return Ok(listed),
            Some(Err(e)) => last_error = Some(e),
            None => {}
        }
    }
    Err(match last_error {
        Some(e) => format!("opencode's session list could not be read: {e}"),
        None => "opencode printed no session list".to_string(),
    })
}

/// The conversations whose directory is `dir`, newest first.
///
/// Only a directory that could be this one is resolved: one whose last part,
/// as listed, is the last part of `dir` as the terminal spells it or as it
/// resolves. The list holds every conversation opencode keeps — anywhere,
/// up to 500 — and resolving each of their directories touched every one of
/// them: a drive that is no longer there, a share, a folder long deleted.
/// opencode keeps the resolved directory (its own cwd), so the second of the
/// two names covers a terminal that reached it through a link.
fn in_directory(listed: Vec<ListedSession>, dir: &Path) -> Vec<AgentSession> {
    let spelled = dir.to_string_lossy();
    let Some(wanted) = comparable(&spelled) else {
        return Vec::new();
    };
    let names = [last_part(&spelled), last_part(&wanted)];
    // Conversations share directories; each is resolved once.
    let mut seen: HashMap<String, bool> = HashMap::new();
    let mut found: Vec<AgentSession> = listed
        .into_iter()
        .filter(|s| {
            *seen.entry(s.directory.clone()).or_insert_with(|| {
                names.contains(&last_part(&s.directory))
                    && comparable(&s.directory).as_deref() == Some(wanted.as_str())
            })
        })
        .map(|s| AgentSession { id: s.id, title: s.title, updated: s.updated, created: s.created })
        .collect();
    found.sort_by(|a, b| b.updated.cmp(&a.updated));
    found.truncate(MAX_RETURNED);
    found
}

/// The last part of a directory, lowercase, whichever separator it uses.
fn last_part(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_lowercase()
}

/// A directory as two spellings of it compare equal: resolved (symlinks —
/// macOS's /tmp is /private/tmp — and `..`), without a trailing separator,
/// and on the platforms whose filesystems ignore case by default, lowercase.
///
/// Never resolved when it is on another machine, or a link there
/// (`fs::is_network_path`, `fs::link_leads_off_machine`): on Windows only
/// asking connects to the host and signs in with the user's credentials,
/// and a host that does not answer holds the lookup for as long as Windows
/// waits. Compared by its spelling instead.
fn comparable(path: &str) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let raw = Path::new(path);
    let resolved = if resolvable(path) {
        dunce::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf())
    } else {
        raw.to_path_buf()
    };
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

/// Whether `path` may be resolved without reaching another machine
/// (`comparable`).
fn resolvable(path: &str) -> bool {
    !crate::fs::is_network_path(path) && !crate::fs::link_leads_off_machine(Path::new(path))
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

/// Run `command` to completion, or kill it — and what it started — at
/// `deadline` (`kill_tree`). Its output is read on threads of their own, so
/// a child that fills a pipe cannot stall, and a grandchild that keeps the
/// pipe open past the end cannot hold this up.
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
                kill_tree(&mut child);
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

/// Kill `child` and everything it started. opencode is rarely one process:
/// npm installs it as a node script that starts the real binary, and on
/// Windows as `opencode.cmd` — cmd.exe running node running opencode.exe.
/// Killing only the first left the others running, and every retry started
/// another set.
///
/// On unix the group the child leads (`run_list` starts it in one) is
/// killed; for a child that leads none, that finds nothing. On Windows
/// `taskkill /T` ends the tree while its
/// root is still alive to name it, which a hang that reached the deadline
/// is. Then the child itself, as before, in case either could not.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill(2) on the group this child leads; it takes no
            // pointers, and an error (the group already gone) is harmless.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        // By full path: a `taskkill` found first on the PATH is not System32's.
        if let Some(root) = std::env::var_os("SystemRoot") {
            let mut taskkill = quiet_command(PathBuf::from(root).join("System32").join("taskkill.exe"));
            taskkill
                .args(["/T", "/F", "/PID", &child.id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut killer) = taskkill.spawn() {
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(5) {
                    if !matches!(killer.try_wait(), Ok(None)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                let _ = killer.kill();
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
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
    fn a_stand_in_cli_is_run_in_the_terminals_folder_and_its_list_narrowed() {
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
        // opencode lists only the conversations of the project its working
        // directory is in: from anywhere else a git repository's never show.
        assert_eq!(
            dunce::canonicalize(ran_in).ok(),
            dunce::canonicalize(&project).ok(),
            "run in the terminal's own folder"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_folder_that_is_gone_lists_from_its_nearest_ancestor_and_one_on_another_machine_never_runs_there() {
        let base = std::env::temp_dir().join(format!("nexterm-agent-rundir-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert_eq!(run_dir(&repo), repo);
        assert_eq!(run_dir(&repo.join("deleted").join("deeper")), repo, "the nearest that is still there");
        let temp = std::env::temp_dir();
        for elsewhere in ["//fileserver/share/proj", r"\\fileserver\share\proj", "", "relative/dir"] {
            assert_eq!(run_dir(Path::new(elsewhere)), temp, "{elsewhere:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_given_up_on_is_killed_with_what_it_started() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nexterm-agent-tree-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let pid_file = base.join("grandchild.pid");
        // npm's opencode is a node script that starts the real binary: a
        // child that starts a child, and hangs.
        let bin = base.join("opencode");
        std::fs::write(&bin, format!("#!/bin/sh\nsleep 30 &\necho $! > '{}'\nsleep 30\n", pid_file.to_string_lossy()))
            .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Long enough for the script to have started its child, however slowly
        // processes start here.
        let err = run_list(&bin, None, &base, OptionalFlags::ALL, Duration::from_millis(1500)).unwrap_err();
        assert!(err.contains("gave up"), "{err}");
        let grandchild: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let started = Instant::now();
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(grandchild, 0) } == 0 && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        if alive {
            unsafe {
                libc::kill(grandchild, libc::SIGKILL);
            }
        }
        assert!(!alive, "what the CLI started outlived the deadline");
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

    /// All opencode 1.18.34 printed — to stderr, exit 1 — for
    /// `session list --format json --bogus -n 1` (measured 2026-10-13): its
    /// usage, and no "Unknown argument" line.
    const USAGE: &str = r#"opencode session list

list sessions

Options:
  -h, --help        show help                                                              [boolean]
  -v, --version     show version number                                                    [boolean]
      --print-logs  print logs to stderr                                                   [boolean]
      --log-level   log level                   [string] [choices: "DEBUG", "INFO", "WARN", "ERROR"]
      --pure        run without external plugins                                           [boolean]
  -n, --max-count   limit to N most recent sessions                                         [number]
      --format      output format             [string] [choices: "table", "json"] [default: "table"]"#;

    /// The usage of an opencode that does not have the options starting with `prefixes`.
    fn usage_without(prefixes: &[&str]) -> String {
        USAGE
            .lines()
            .filter(|l| !prefixes.iter().any(|p| l.trim_start().starts_with(p)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    const NONE: OptionalFlags = OptionalFlags { pure: false, max_count: false };
    const PURE: OptionalFlags = OptionalFlags { pure: true, max_count: false };
    const MAX_COUNT: OptionalFlags = OptionalFlags { pure: false, max_count: true };

    #[test]
    fn only_a_flag_this_opencode_does_not_know_is_dropped() {
        // Its own usage lists both: refused for some other reason, so the
        // same command again would only fail again.
        assert_eq!(refused_flags(USAGE), NONE);
        assert_eq!(refused_flags(&usage_without(&["--pure"])), PURE);
        assert_eq!(refused_flags(&usage_without(&["-n,"])), MAX_COUNT);
        assert_eq!(refused_flags(&usage_without(&["--pure", "-n,"])), OptionalFlags::ALL);
        // yargs' own words, coloured or not.
        assert_eq!(refused_flags("Unknown argument: pure"), PURE);
        assert_eq!(refused_flags("\u{1b}[31mUnknown arguments: pure, n\u{1b}[0m"), OptionalFlags::ALL);
        assert_eq!(refused_flags(&format!("{USAGE}\n\nUnknown arguments: max-count, bogus")), MAX_COUNT);
        // Nothing about these flags.
        for other in [
            "",
            "Error: database is locked",
            "Unknown argument: bogus",
            "'node' is not recognized as an internal or external command,",
            // opencode's top-level usage: not `session list`'s, says nothing of its flags.
            "opencode [project]\n\nstart opencode tui\n\nOptions:\n  -m, --model  model to use",
        ] {
            assert_eq!(refused_flags(other), NONE, "{other:?}");
        }

        assert_eq!(OptionalFlags::ALL.args(), ["session", "list", "--format", "json", "--pure", "-n", "500"]);
        assert_eq!(OptionalFlags::ALL.without(PURE).args(), ["session", "list", "--format", "json", "-n", "500"]);
        assert_eq!(OptionalFlags::ALL.without(OptionalFlags::ALL).args(), ["session", "list", "--format", "json"]);
        assert_eq!(OptionalFlags::ALL.without(NONE), OptionalFlags::ALL, "nothing refused: not run again");
    }

    #[test]
    fn a_failure_says_why_in_one_line_and_never_with_the_usage_screens_first() {
        // Its first line is only the command's name.
        assert_eq!(failure_reason(USAGE, "", Some(1)), "it printed its usage instead of a list");
        assert!(failure_reason(&usage_without(&["--format"]), "", Some(1)).contains("JSON"));
        assert_eq!(
            failure_reason("loading plugins\nError: database is locked\n    at open (db.ts:1)", "", Some(1)),
            "Error: database is locked"
        );
        assert_eq!(
            failure_reason(
                "'node' is not recognized as an internal or external command,\noperable program or batch file.\n",
                "",
                Some(9009)
            ),
            "'node' is not recognized as an internal or external command, operable program or batch file."
        );
        assert_eq!(failure_reason("\u{1b}[91m\u{1b}[1mError: \u{1b}[0mboom", "", Some(1)), "Error: boom");
        assert_eq!(failure_reason("", "said it on stdout", Some(2)), "said it on stdout");
        assert_eq!(failure_reason("", " \n", Some(3)), "it exited with code 3 and said nothing");
        assert_eq!(failure_reason("", "", None), "it was stopped before it finished");
        let long = failure_reason(&"x".repeat(1000), "", Some(1));
        assert_eq!(long.chars().count(), 301, "cut, with an ellipsis");
    }

    #[test]
    fn stderr_that_is_not_utf8_still_reads_as_text() {
        assert_eq!(stderr_text("한글 error".as_bytes()), "한글 error");
        // `'node'은(는)` as cmd.exe writes it on a Korean system: CP949, not
        // UTF-8. Read in the OEM code page on Windows, replaced elsewhere —
        // either way the words around it survive.
        let cp949: &[u8] = &[b'\'', b'n', b'o', b'd', b'e', b'\'', 0xC0, 0xBA, b'(', 0xB4, 0xC2, b')'];
        let text = stderr_text(cp949);
        assert!(text.starts_with("'node'") && text.ends_with(')'), "{text:?}");
    }

    #[test]
    fn a_directory_is_matched_by_its_last_part_first() {
        assert_eq!(last_part("/Users/me/Proj/"), "proj");
        assert_eq!(last_part(r"C:\Users\me\Proj"), "proj");
        assert_eq!(last_part(r"C:\"), "c:");
        assert_eq!(last_part("/"), "");
        let dir = std::env::temp_dir().join(format!("nexterm-agent-name-{}", std::process::id())).join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let here = dir.to_string_lossy().to_string();
        let got = in_directory(
            vec![
                listed("ses_iiiiiiiiiiii", "same name, elsewhere", 3, "/somewhere/else/proj"),
                listed("ses_jjjjjjjjjjjj", "on another machine", 2, "//fileserver/share/proj"),
                listed("ses_kkkkkkkkkkkk", "here", 1, &here),
            ],
            &dir,
        );
        assert_eq!(got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["ses_kkkkkkkkkkkk"]);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_directory_on_another_machine_is_compared_by_its_spelling_never_resolved() {
        for remote in ["//fileserver/share/proj", r"\\fileserver\share\proj", r"\\?\UNC\fileserver\share\proj"] {
            assert!(!resolvable(remote), "{remote} would be resolved, signing in to the host");
        }
        assert!(resolvable(&std::env::temp_dir().to_string_lossy()));
        assert!(resolvable(r"C:\Users\me\proj"));
    }

    #[cfg(unix)]
    #[test]
    fn a_listed_directory_named_otherwise_is_not_resolved_to_find_out() {
        // opencode keeps its directory resolved (its own cwd), so the one it
        // lists is never a link. One that is anyway, under another name, is
        // not followed: resolving every listed directory touched every place
        // a conversation was ever had — up to 500 of them.
        let base = std::env::temp_dir().join(format!("nexterm-agent-unnamed-{}", std::process::id()));
        let real = base.join("proj");
        let other = base.join("another-name");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&other);
        std::os::unix::fs::symlink(&real, &other).unwrap();
        let got = in_directory(vec![listed("ses_llllllllllll", "t", 1, &other.to_string_lossy())], &real);
        assert!(got.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn an_opencode_that_does_not_know_pure_is_asked_again_without_it_and_only_then() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nexterm-agent-retry-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let here = project.to_string_lossy().to_string();
        let log = base.join("args.log");
        // Refuses `--pure` as 1.18.34 refuses a flag it does not know: its
        // usage (here one without `--pure`) on stderr, exit 1.
        std::fs::write(base.join("usage.txt"), usage_without(&["--pure"])).unwrap();
        let bin = base.join("opencode");
        // Each run's arguments and where it ran, a line each.
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{log}'\npwd >> '{log}'\nfor a in \"$@\"; do [ \"$a\" = --pure ] && {{ cat '{usage}' >&2; exit 1; }}; done\nprintf '%s' '[{{\"id\":\"ses_hhhhhhhhhhhh\",\"title\":\"Mine\",\"updated\":5,\"created\":4,\"directory\":\"{here}\"}}]'\n",
            log = log.to_string_lossy(),
            usage = base.join("usage.txt").to_string_lossy(),
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let canonical = |p: &str| dunce::canonicalize(p).ok();

        let got = opencode_sessions(&bin, None, &project).unwrap();
        assert_eq!(got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["ses_hhhhhhhhhhhh"]);
        let logged = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = logged.lines().collect();
        assert_eq!(lines[0], "session list --format json --pure -n 500");
        assert_eq!(canonical(lines[1]), canonical(&here), "first in the terminal's folder");
        assert_eq!(lines[2], "session list --format json -n 500");
        // Without `--pure` the project's own plugins would load there.
        assert_eq!(
            canonical(lines[3]),
            canonical(&std::env::temp_dir().to_string_lossy()),
            "the retry without --pure ran in the project"
        );

        // In a git repository, listing from outside it shows none of its
        // conversations: said, rather than an empty list.
        std::fs::create_dir_all(project.join(".git")).unwrap();
        let elsewhere = format!("{here}-gone-from-the-list");
        std::fs::write(
            &bin,
            std::fs::read_to_string(&bin).unwrap().replace(&format!("\"directory\":\"{here}\""), &format!("\"directory\":\"{elsewhere}\"")),
        )
        .unwrap();
        let err = opencode_sessions(&bin, None, &project).unwrap_err();
        assert!(err.contains("--pure") && err.contains("git repository"), "{err}");
        std::fs::remove_dir_all(project.join(".git")).unwrap();

        // One that knows every flag and fails anyway is run once, and says so.
        std::fs::write(base.join("usage.txt"), USAGE).unwrap();
        std::fs::remove_file(&log).unwrap();
        let err = opencode_sessions(&bin, None, &project).unwrap_err();
        assert_eq!(err, "opencode session list failed: it printed its usage instead of a list");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2, "one run, not again for nothing");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_list_is_found_after_whatever_was_printed_before_it() {
        let list = r#"[{"id":"ses_xxxxxxxxxxxx","title":"t","directory":"/p"}]"#;
        for (name, out) in [
            ("plain notice", format!("Update available: 1.19.0\n{list}")),
            ("coloured notice", format!("\u{1b}[33mUpdate available\u{1b}[0m\n{list}")),
            ("bracketed tag", format!("[opencode] update available 1.19.0\n{list}")),
            ("migration counter", format!("Performing one time database migration [1/3]\n{list}")),
            ("pretty, after a tag", format!("[opencode] hello\n  [\n  {{\"id\": \"ses_xxxxxxxxxxxx\"}}\n]\n")),
            ("coloured list", format!("\u{1b}[0m{list}\u{1b}[0m")),
        ] {
            assert_eq!(parse_list(&out).map(|v| v.len()), Ok(1), "{name}");
        }
        assert!(parse_list("\u{1b}[0m \n").unwrap().is_empty(), "nothing printed but colour is none");
        assert_eq!(parse_list("[opencode] no list today").unwrap_err(), "opencode's session list could not be read: expected value at line 1 column 2");
    }

    #[test]
    fn only_opencode_has_a_list() {
        let err = tauri::async_runtime::block_on(agent_sessions("claude".into(), "/".into())).unwrap_err();
        assert!(err.contains("claude"), "{err}");
    }
}
