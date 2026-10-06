//! Shell integration: make the user's shell announce command boundaries and
//! its live working directory.
//!
//! For zsh we point `ZDOTDIR` at a generated directory whose rc files first
//! source the user's real rc files and then register `preexec`/`precmd`
//! hooks that print OSC 133 markers (the same protocol VS Code, iTerm2 and
//! Warp use). For bash we do the same thing with `--rcfile` plus a
//! `trap ... DEBUG` preexec. For PowerShell (the Windows default) we wrap
//! the `prompt` function and PSReadLine's line reader instead, since that
//! shell has no preexec/precmd hooks at all. The PTY reader turns those
//! markers into `pty-command-done` events, which is what lets a command
//! block close with a real exit code.
//!
//! The same `precmd`/`PROMPT_COMMAND`/`prompt` hooks also print an OSC 7
//! sequence (`ESC ] 7 ; file://<host><path> BEL`) on every prompt, reporting
//! the shell's current directory. None of the three hooks percent-encode
//! `$PWD`/`$PWD.Path` before splicing it in — they emit the raw path and let
//! the Rust-side parser (`osc.rs::parse_osc7_path`) handle decoding, since a
//! raw (unencoded) path round-trips through percent-decoding unchanged for
//! the overwhelming majority of real directory names, and doing the
//! encoding in three different shell dialects would be considerably more
//! fragile than doing the (already-implemented, already-tested) decoding
//! once in Rust. The PTY reader turns this into a `pty-cwd` event.
//!
//! cmd.exe is a special case: it has no hooks of any kind, only the `PROMPT`
//! environment variable, which it re-expands before every prompt. `$E` is an
//! escape and `$P` is the current directory, so cmd CAN report where it is —
//! and since cmd is the Windows default, without this the headline behaviour
//! on Windows was a working directory frozen at whatever it was when the tab
//! opened. A prompt being drawn also means the command before it has ended, so
//! cmd reports that too, as an OSC 133 "D" with no exit code. What it still
//! cannot report is where a command starts or what it exited with, so the
//! sticky header stays off there and a finished command is reported without a
//! verdict. That is a limit of the shell.
//!
//! Every other shell falls back to plain spawning (no markers, blocks only
//! close when the shell exits, and the tab's cwd never updates after spawn).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// What it takes to make a shell emit our markers: extra environment
/// variables, plus extra `CommandBuilder` arguments (some shells only load a
/// custom rc/profile file when told to via a flag).
pub struct ShellIntegration {
    pub env: Vec<(String, String)>,
    pub args: Vec<String>,
}

impl ShellIntegration {
    fn none() -> Self {
        ShellIntegration { env: Vec::new(), args: Vec::new() }
    }
}

/// Whether zsh and bash start as login shells: on macOS they do, as
/// Terminal.app, iTerm2 and VS Code start them.
///
/// That is where a Mac's PATH comes from. /etc/zprofile runs path_helper,
/// which adds /usr/local/bin and everything in /etc/paths.d (Homebrew's entry
/// among them), and ~/.zprofile is where Homebrew's installer puts
/// `brew shellenv` — and only a login shell reads either. An app opened from
/// the Finder or the Dock inherits launchd's bare PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), so `brew`, `node`, `opencode` and
/// `claude` were "command not found" in every terminal unless ~/.zshrc
/// happened to add them. `tauri dev`, started from a terminal, inherits a
/// full PATH, which is why development never showed it.
///
/// Linux terminals start non-login shells, the desktop session having set the
/// PATH up already, and Windows shells have no login files at all; neither
/// changes.
const LOGIN_SHELLS: bool = cfg!(target_os = "macos");

/// Build the integration payload for the shell at `shell_path`. Matches on
/// the executable's file name (case-insensitively, `.exe` suffix ignored)
/// so it works the same whether the caller passed a bare name or a full
/// path.
pub fn for_shell(shell_path: &str) -> ShellIntegration {
    for_shell_as(shell_path, LOGIN_SHELLS)
}

/// `for_shell`, told whether zsh and bash start as login shells instead of
/// asking the platform — so that both kinds can be tested on any machine.
fn for_shell_as(shell_path: &str, login: bool) -> ShellIntegration {
    let file_name = Path::new(shell_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem = file_name.strip_suffix(".exe").unwrap_or(&file_name);

    match stem {
        "zsh" => zsh_integration(login),
        "bash" => bash_integration(login),
        "pwsh" | "powershell" => pwsh_integration(),
        "cmd" => cmd_integration(),
        _ => ShellIntegration::none(),
    }
}

// ---------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------

const ZSHENV: &str = r#"# NexTerm shell integration (zsh) — generated file, do not edit.
# Source the user's own .zshenv, then make sure our rc directory stays active
# even if that file re-points ZDOTDIR (a common dotfiles pattern).
if [[ -z "$NEXTERM_USER_ZDOTDIR" ]]; then
  NEXTERM_USER_ZDOTDIR="$HOME"
fi
if [[ -f "$NEXTERM_USER_ZDOTDIR/.zshenv" ]]; then
  ZDOTDIR="$NEXTERM_USER_ZDOTDIR"
  builtin source "$NEXTERM_USER_ZDOTDIR/.zshenv"
  if [[ "$ZDOTDIR" != "$NEXTERM_USER_ZDOTDIR" ]]; then
    NEXTERM_USER_ZDOTDIR="$ZDOTDIR"
  fi
fi
ZDOTDIR="$NEXTERM_ZDOTDIR"
export NEXTERM_USER_ZDOTDIR
"#;

const ZPROFILE: &str = r#"# NexTerm shell integration (zsh) — generated file, do not edit.
if [[ -f "$NEXTERM_USER_ZDOTDIR/.zprofile" ]]; then
  ZDOTDIR="$NEXTERM_USER_ZDOTDIR"
  builtin source "$NEXTERM_USER_ZDOTDIR/.zprofile"
  ZDOTDIR="$NEXTERM_ZDOTDIR"
fi
"#;

const ZSHRC: &str = r#"# NexTerm shell integration (zsh) — generated file, do not edit.
if [[ -f "$NEXTERM_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR="$NEXTERM_USER_ZDOTDIR"
  builtin source "$NEXTERM_USER_ZDOTDIR/.zshrc"
  ZDOTDIR="$NEXTERM_ZDOTDIR"
fi

# Keep history where the user expects it: /etc/zshrc defaults HISTFILE to
# $ZDOTDIR/.zsh_history, which would now be our generated directory.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$NEXTERM_ZDOTDIR"/* ]]; then
  HISTFILE="$NEXTERM_USER_ZDOTDIR/.zsh_history"
fi
# The inverse-video "%" zsh prints after output without a trailing newline
# would end up inside command blocks; the block UI shows status itself.
PROMPT_EOL_MARK=''

# OSC 133: A = prompt start, C = command output starts, D;<code> = command done
# OSC 7: report the live working directory on every prompt (raw path, see
# the module doc comment in shell_integration.rs for why this is not
# percent-encoded here).
__nexterm_preexec() {
  builtin printf '\e]133;C\a'
}
__nexterm_precmd() {
  local __nexterm_status=$?
  builtin printf '\e]133;D;%d\a' "$__nexterm_status"
  builtin printf '\e]7;file://%s%s\a' "$HOST" "$PWD"
  builtin printf '\e]133;A\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __nexterm_preexec
add-zsh-hook precmd __nexterm_precmd
"#;

const ZLOGIN: &str = r#"# NexTerm shell integration (zsh) — generated file, do not edit.
if [[ -f "$NEXTERM_USER_ZDOTDIR/.zlogin" ]]; then
  ZDOTDIR="$NEXTERM_USER_ZDOTDIR"
  builtin source "$NEXTERM_USER_ZDOTDIR/.zlogin"
  ZDOTDIR="$NEXTERM_ZDOTDIR"
fi
"#;


/// Where this process keeps the rc files it generates for the shell.
///
/// Two things made a single fixed `$TMPDIR/nexterm-shell-integration` wrong:
///
///   * On Linux `temp_dir()` is `/tmp`, which is world-writable. Another local
///     user could pre-create the directory (or a symlink in its place) and
///     every terminal NexTerm opened would source their code as the victim.
///     macOS and Windows hand each user a private temp directory, so only
///     Linux was exposed — but the fix costs nothing anywhere.
///   * One path shared by every process meant the test suite raced itself:
///     two tests generating the same rc file at once, under cargo's parallel
///     harness, read a file another was halfway through writing.
///
/// Both go away with a directory that belongs to this user AND this process —
/// on unix, one this process made itself (see `process_dir`).
fn integration_dir(shell: &str) -> Result<PathBuf, String> {
    // Unique per call: the counter keeps two threads of one process (cargo's
    // test harness) from writing the same file at once.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = format!("{shell}-{}", SEQ.fetch_add(1, Ordering::Relaxed));

    #[cfg(unix)]
    let dir = {
        let dir = process_dir()?.join(name);
        create_private_dir(&dir)
            .map_err(|e| format!("cannot create the shell-integration directory {}: {e}", dir.display()))?;
        dir
    };
    #[cfg(not(unix))]
    let dir = {
        let mut dir = std::env::temp_dir();
        dir.push(format!("nexterm-{}", std::process::id()));
        dir.push(name);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create the shell-integration directory {}: {e}", dir.display()))?;
        dir
    };
    Ok(dir)
}

/// This process's own directory in the temp directory, made the first time
/// it is needed.
///
/// It used to be `nexterm-<uid>-<pid>`, made with `create_dir_all`, and on
/// Linux that was not enough. The uid is public and pids are handed out in
/// order, so another user of a shared /tmp could make that directory first —
/// or a symlink to one of theirs — and `create_dir_all` took whatever was
/// there; the chmod after it failed quietly on a directory that was not
/// ours. Their files were then sourced as this user. So the name now ends in
/// a random part nobody can make first, the directory is made by a mkdir that
/// refuses to take over anything already there, and what was made is checked
/// before anything goes in it.
///
/// Checked again on every use, too: a temp cleaner may remove it during a
/// long session, and then another is made.
#[cfg(unix)]
fn process_dir() -> Result<PathBuf, String> {
    static DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
    let mut dir = DIR.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = dir.as_ref() {
        if check_private_dir(existing).is_ok() {
            return Ok(existing.clone());
        }
    }
    let made = make_process_dir(&std::env::temp_dir())?;
    *dir = Some(made.clone());
    Ok(made)
}

/// A new directory of this process's own in `parent`, named
/// `nexterm-<uid>-<pid>-<random>`.
#[cfg(unix)]
fn make_process_dir(parent: &Path) -> Result<PathBuf, String> {
    // SAFETY: `getuid` only reads this process's own uid and cannot fail.
    let uid = unsafe { libc::getuid() };
    let pid = std::process::id();
    // A random name that is taken is someone else's; another one is tried
    // rather than spawning shells without their integration.
    let mut taken = Vec::new();
    for _ in 0..8 {
        let random = uuid::Uuid::new_v4().simple().to_string();
        let dir = parent.join(format!("nexterm-{uid}-{pid}-{}", &random[..12]));
        match create_private_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => taken.push(dir),
            Err(e) => return Err(format!("cannot create {}: {e}", dir.display())),
        }
    }
    Err(format!("every directory name tried in {} was taken: {taken:?}", parent.display()))
}

/// Make `dir`, which must not exist yet, as a directory only this user can
/// enter — and check that this is what is there now.
#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    // Fails, rather than taking it over, on anything already at `dir`: a
    // directory, or a symlink to one.
    fs::DirBuilder::new().mode(0o700).create(dir)?;
    // The umask can take our own bits away from 0700, though never add any.
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    check_private_dir(dir)
}

/// Whether `dir` is a real directory, not a symlink to one, that belongs to
/// this user and lets nobody else in.
#[cfg(unix)]
fn check_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(dir)?;
    // SAFETY: as in `make_process_dir`.
    let uid = unsafe { libc::getuid() };
    let refuse = |why: String| Err(std::io::Error::other(format!("{}: {why}", dir.display())));
    if !meta.file_type().is_dir() {
        return refuse("not a directory".to_string());
    }
    if meta.uid() != uid {
        return refuse(format!("owned by uid {}, not {uid}", meta.uid()));
    }
    if meta.mode() & 0o077 != 0 {
        return refuse(format!("mode {:o} lets other users in", meta.mode() & 0o777));
    }
    Ok(())
}

fn zsh_integration(login: bool) -> ShellIntegration {
    // A login zsh also reads .zprofile and .zlogin from ZDOTDIR, and the
    // generated ones hand each to the user's own, like the other two. zsh
    // reads the four in order — .zshenv, .zprofile, .zshrc, .zlogin — so the
    // user's run once each, in the order they always did.
    let args = if login { vec!["-l".to_string()] } else { Vec::new() };
    match prepare_zsh_dir() {
        Ok(dir) => {
            let dir_str = dir.to_string_lossy().to_string();
            let user_zdotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
            ShellIntegration {
                env: vec![
                    ("ZDOTDIR".to_string(), dir_str.clone()),
                    ("NEXTERM_ZDOTDIR".to_string(), dir_str),
                    ("NEXTERM_USER_ZDOTDIR".to_string(), user_zdotdir),
                ],
                args,
            }
        }
        // If we cannot write the rc files, spawn the shell plainly rather than
        // fail — still a login shell where it should be one.
        Err(_) => ShellIntegration { env: Vec::new(), args },
    }
}

/// Write (or refresh) the generated zsh rc directory and return its path.
pub fn prepare_zsh_dir() -> Result<PathBuf, String> {
    let dir = integration_dir("zsh")?;
    for (name, body) in [
        (".zshenv", ZSHENV),
        (".zprofile", ZPROFILE),
        (".zshrc", ZSHRC),
        (".zlogin", ZLOGIN),
    ] {
        let path = dir.join(name);
        // Only rewrite when the content changed, so the shell does not see a
        // fresh mtime on every spawn.
        if fs::read_to_string(&path).map(|cur| cur == body).unwrap_or(false) {
            continue;
        }
        fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(dir)
}

// ---------------------------------------------------------------------
// bash (Linux / Git Bash / macOS)
// ---------------------------------------------------------------------

/// The start of the generated rcfile for an interactive non-login bash: what
/// bash itself would have read in its place.
const BASH_STARTUP: &str = r#"# NexTerm shell integration (bash) — generated file, do not edit.
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi
"#;

/// The start of the generated rcfile for a login bash (see `LOGIN_SHELLS`).
/// bash reads no --rcfile as a login shell, so it is started as an
/// interactive one and this reads what a login shell would have — /etc/profile,
/// then the first of the three profile files there is — and not ~/.bashrc,
/// which a login shell leaves to ~/.bash_profile. VS Code does the same.
const BASH_LOGIN_STARTUP: &str = r#"# NexTerm shell integration (bash) — generated file, do not edit.
# A login shell's startup files, read here because bash reads no --rcfile in
# a login shell: /etc/profile (on macOS, path_helper builds PATH there), then
# the first of the user's three that is there.
if [[ -r /etc/profile ]]; then
  source /etc/profile
fi
if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
"#;

/// The rest of the generated rcfile, the same for both.
const BASH_HOOKS: &str = r#"
# OSC 133: A = prompt start, C = command output starts, D;<code> = command done
#
# bash has no preexec/precmd hooks, so we build them out of two primitives:
#   - PROMPT_COMMAND runs right before every prompt is drawn (our precmd).
#   - `trap ... DEBUG` runs before every top-level simple command (our
#     preexec). It also fires for each command PROMPT_COMMAND runs, and
#     once per simple command in a compound line (`a; b; c`), so a guard
#     flag (set in precmd, cleared by the first command after it) makes
#     sure the C marker prints exactly once per typed command rather than
#     once per simple command inside it.
#
# Neither primitive is ours alone. ~/.bashrc has just run, and it is where
# direnv, zoxide and starship put their hooks in PROMPT_COMMAND, where
# `history -a` keeps a shared history, and where a DEBUG trap times
# commands. Assigning ours over them switched all of that off without a
# word, so ours are added to what is there:
#   - PROMPT_COMMAND keeps the user's commands, between two of ours. The
#     first takes the exit status before anything can change it and returns
#     it again, so their commands see it as they always did; the last
#     prints the markers. They stay in PROMPT_COMMAND itself rather than
#     being run from a copy, so an installer that looks for its hook there
#     still finds it when ~/.bashrc is read again. starship's, not finding
#     it, would keep ours and run it from its own hook — and a copy run by
#     ours holds starship's hook, so each would run the other forever.
#   - The DEBUG trap that was there runs from ours, with the exit status and
#     $_ of the command it fired for, and returns what it returns (under
#     extdebug, non-zero skips the command). It does not run for our two
#     PROMPT_COMMAND commands, which it would never have seen.
#   - bash-preexec (atuin, bash-it) owns both primitives already and calls
#     hook functions from two arrays, so ours join the arrays instead.

__nexterm_preexec() {
  if [[ "${__nexterm_pending_preexec-}" != 1 ]]; then
    return 0
  fi
  __nexterm_pending_preexec=0
  builtin printf '\e]133;C\a'
}

# OSC 7: report the live working directory on every prompt (raw path, see
# the module doc comment above for why this is not percent-encoded here).
# bash's hostname variable is $HOSTNAME (zsh/csh use $HOST instead).
# Under bash-preexec, $? is the command's exit status here; otherwise
# __nexterm_prompt_begin kept it, since the user's commands ran since.
__nexterm_precmd() {
  local __nexterm_code=$?
  if [[ -n "${__nexterm_exit_status-}" ]]; then
    __nexterm_code=$__nexterm_exit_status
    __nexterm_exit_status=
  fi
  builtin printf '\e]133;D;%d\a' "$__nexterm_code"
  builtin printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
  builtin printf '\e]133;A\a'
  __nexterm_pending_preexec=1
}

# First in PROMPT_COMMAND. Called with "$_" as its last argument, it leaves
# $_ as the user's command left it, as every call leaves $_ holding its last
# argument.
__nexterm_prompt_begin() {
  __nexterm_exit_status=$?
  __nexterm_pending_preexec=0
  return "$__nexterm_exit_status"
}

# Sets $? to $1, and — given a second argument — $_ to that.
__nexterm_return() {
  return "$1"
}

# The DEBUG trap. $? is still the command's own on entry; $_ is passed in,
# because it was still the command's own where the trap called this.
__nexterm_debug() {
  local __nexterm_code=$? __nexterm_last=${1-} __nexterm_verdict=0
  case "$BASH_COMMAND" in
    __nexterm_*) return 0 ;;
  esac
  # extdebug traces into functions, ours included; nothing in them is the
  # user's, or the start of a command.
  case "${FUNCNAME[1]-}" in
    __nexterm_*) return 0 ;;
  esac
  if [[ -n "${__nexterm_user_debug_trap-}" ]]; then
    __nexterm_return "$__nexterm_code" "$__nexterm_last"
    builtin eval -- "$__nexterm_user_debug_trap"
    __nexterm_verdict=$?
  fi
  __nexterm_preexec
  return "$__nexterm_verdict"
}

# The DEBUG trap set before ours. `trap -p` prints it quoted for reuse, and
# reading that back as words gives the action exactly. If it is ours (this
# file read twice), the one ours already runs is the answer: ours running
# ours would never end.
__nexterm_debug_trap_before() {
  local -a __nexterm_words
  builtin eval "__nexterm_words=( $(builtin trap -p DEBUG) )"
  if [[ "${__nexterm_words[2]-}" == '__nexterm_debug "$_"' ]]; then
    builtin printf '%s' "${__nexterm_user_debug_trap-}"
  else
    builtin printf '%s' "${__nexterm_words[2]-}"
  fi
}

# The user's PROMPT_COMMAND between ours. An array stays one on bash 5.1+,
# which runs every element; anywhere else it is the string bash runs (an
# older bash only ever ran an array's first element). The `;` after ours
# keeps `;_direnv_hook;` findable for direnv's installed-already check, and
# the newline before the last one ends any trailing comment.
__nexterm_wrap_prompt_command() {
  if [[ "${PROMPT_COMMAND[*]-}" == *__nexterm_precmd* ]]; then
    return 0
  fi
  if [[ "$(builtin declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]] &&
    (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=('__nexterm_prompt_begin "$_"' "${PROMPT_COMMAND[@]}" __nexterm_precmd)
  else
    PROMPT_COMMAND="__nexterm_prompt_begin \"\$_\";${PROMPT_COMMAND-}"$'\n'"__nexterm_precmd"
  fi
}

if [[ -n "${bash_preexec_imported-}${__bp_imported-}" ]]; then
  if [[ " ${precmd_functions[*]-} " != *" __nexterm_precmd "* ]]; then
    precmd_functions+=(__nexterm_precmd)
  fi
  if [[ " ${preexec_functions[*]-} " != *" __nexterm_preexec "* ]]; then
    preexec_functions+=(__nexterm_preexec)
  fi
else
  # Read and set out here: bash 3.2 puts back, as a function returns, the
  # DEBUG trap it was called with, undoing one the function set.
  __nexterm_user_debug_trap=$(__nexterm_debug_trap_before)
  builtin trap '__nexterm_debug "$_"' DEBUG
  __nexterm_wrap_prompt_command
fi
"#;

fn bash_integration(login: bool) -> ShellIntegration {
    match prepare_bash_rcfile(login) {
        Ok(path) => ShellIntegration {
            env: Vec::new(),
            args: vec![
                "--rcfile".to_string(),
                path.to_string_lossy().to_string(),
                "-i".to_string(),
            ],
        },
        // Without the rcfile, a plain login shell still reads the profile.
        Err(_) if login => ShellIntegration { env: Vec::new(), args: vec!["-l".to_string()] },
        Err(_) => ShellIntegration::none(),
    }
}

/// The generated bash rcfile: the user's startup files as this kind of shell
/// reads them, then the hooks.
fn bash_rcfile(login: bool) -> String {
    [if login { BASH_LOGIN_STARTUP } else { BASH_STARTUP }, BASH_HOOKS].concat()
}

/// Write (or refresh) the generated bash rc file and return its path.
pub fn prepare_bash_rcfile(login: bool) -> Result<PathBuf, String> {
    let dir = integration_dir("bash")?;
    let path = dir.join("bashrc");
    let body = bash_rcfile(login);
    if fs::read_to_string(&path).map(|cur| cur == body).unwrap_or(false) {
        return Ok(path);
    }
    fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

// ---------------------------------------------------------------------
// PowerShell (pwsh / Windows PowerShell)
// ---------------------------------------------------------------------

const PWSH_INTEGRATION: &str = r#"# NexTerm shell integration (PowerShell) — generated file, do not edit.
# OSC 133: A = prompt start, C = command output starts, D;<code> = command done
# OSC 7: report the live working directory on every prompt (raw path — see
# the module doc comment in shell_integration.rs for why this is not
# percent-encoded here). No host is reported (an empty host is valid OSC 7);
# a Windows drive-letter path is given a leading '/' (e.g. "/C:/Users/dev")
# so it parses the same way a POSIX path does on the Rust side.
#
# PowerShell has no preexec/precmd hooks either, so — following VS Code's
# shell integration pattern — we wrap two functions instead:
#   - `prompt` runs every time PowerShell is about to draw a prompt. Its
#     *return value* becomes the prompt text, so we splice the D/A/OSC7
#     markers onto the front of whatever the original prompt would have
#     printed.
#   - PSReadLine's `PSConsoleHostReadLine` runs once per line the user
#     submits (after Enter, before it executes) — the closest thing to a
#     preexec hook — so we wrap it to print C as a side effect via
#     Write-Host. It must be a side effect and not part of the return
#     value: the return value IS the command line PowerShell is about to
#     run, so smuggling escape codes into it would corrupt the command.

if (-not (Test-Path Variable:Global:__NextermOriginalPrompt)) {
    $Global:__NextermOriginalPrompt = $function:prompt
}

function Global:prompt {
    # $? is set by EVERY statement, an assignment included, so it has to be
    # read inside the first one. Capturing it on a later line only ever
    # reported that the preceding assignment succeeded, which made every
    # command look like it exited 0.
    $__nextermCode = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    $__nextermPath = $PWD.Path -replace '\\', '/'
    if ($__nextermPath -notmatch '^/') { $__nextermPath = "/$__nextermPath" }
    $__nextermMarker = "$([char]27)]133;D;$__nextermCode$([char]7)$([char]27)]7;file://$__nextermPath$([char]7)$([char]27)]133;A$([char]7)"
    "$__nextermMarker$(& $Global:__NextermOriginalPrompt)"
}

if (Get-Module -Name PSReadLine) {
    if (-not (Test-Path Variable:Global:__NextermOriginalReadLine)) {
        $Global:__NextermOriginalReadLine = $function:PSConsoleHostReadLine
    }
    function Global:PSConsoleHostReadLine {
        $__nextermLine = & $Global:__NextermOriginalReadLine
        Write-Host -NoNewline "$([char]27)]133;C$([char]7)"
        $__nextermLine
    }
}
"#;

// ---------------------------------------------------------------------
// cmd.exe
// ---------------------------------------------------------------------

/// cmd.exe: that the last command has ended, and the live working directory.
///
/// The only hook cmd offers is `PROMPT`, re-expanded before every prompt.
/// `$E` is an escape and `$P` is the current directory, which is exactly
/// enough for OSC 7. And since a prompt is drawn when the command before it
/// has ended, an OSC 133 "D" in the same `PROMPT` reports that end — the same
/// "D" the other shells send from their prompt hooks, minus the exit code:
/// `PROMPT` is read as written and never expands `%ERRORLEVEL%`, so there is
/// no code to give, and a constant one would be a lie about every command.
/// The frontend reads a D with no code as "finished", never as a success.
/// Nothing in cmd runs when a command STARTS, so there is no "C".
///
/// Details that are not obvious:
///
/// - The terminator is ST (`$E\`), not BEL. `PROMPT` has no escape for a
///   BEL byte at all, and `osc.rs` accepts both.
/// - A `file://` URI path is absolute, so the drive letter gets a `/` in
///   front of it (`file:///C:\Users\dev`). `osc.rs::as_native_path` takes it
///   back off. `$P` already uses backslashes and needs no other translation.
/// - The markers go in FRONT of the visible prompt. ConPTY forwards a
///   sequence that paints nothing only with the next frame that paints
///   something; in front, that is the prompt's own text, so the end arrives
///   when the prompt does rather than whenever the user next types.
/// - A batch file run with echo on draws this prompt before each line it
///   echoes, and each of those reports an end. Most scripts begin with
///   `@echo off` — npm's shims for `claude` and `opencode` do.
///
/// The user's own `PROMPT` is kept and drawn after the markers, so their
/// prompt still looks like theirs. `$P$G` — `C:\dir>` — is cmd's default and
/// the fallback when they have not set one.
fn cmd_integration() -> ShellIntegration {
    cmd_integration_with_prompt(&std::env::var("PROMPT").unwrap_or_default())
}

/// The env-free half, so a test can pin the prompt without writing to the
/// process environment — which every other test in this file would then see.
fn cmd_integration_with_prompt(user: &str) -> ShellIntegration {
    let visible = if user.trim().is_empty() { "$P$G" } else { user };
    ShellIntegration {
        env: vec![("PROMPT".to_string(), format!("$E]133;D$E\\$E]7;file:///$P$E\\{visible}"))],
        args: Vec::new(),
    }
}

fn pwsh_integration() -> ShellIntegration {
    match prepare_pwsh_integration() {
        Ok(path) => {
            // Dot-source (". path", no `& { ... }` wrapper) rather than
            // `-File path`: `-File` (and `&`) invoke the script in a child
            // scope that is torn down once the script returns, so
            // `function prompt { ... }` and the PSReadLine override would
            // vanish the instant the script finished and never affect the
            // interactive session that `-NoExit` drops into. Dot-sourcing
            // runs the script's body directly in the caller's (global)
            // scope, so the overridden functions persist for the rest of
            // the session — this is also how VS Code injects its own
            // PowerShell shell integration script.
            let quoted = path.to_string_lossy().replace('\'', "''");
            ShellIntegration {
                env: Vec::new(),
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-Command".to_string(),
                    format!(". '{quoted}'"),
                ],
            }
        }
        Err(_) => ShellIntegration::none(),
    }
}

/// Write (or refresh) the generated PowerShell integration script and
/// return its path.
pub fn prepare_pwsh_integration() -> Result<PathBuf, String> {
    let dir = integration_dir("pwsh")?;
    let path = dir.join("integration.ps1");
    if fs::read_to_string(&path).map(|cur| cur == PWSH_INTEGRATION).unwrap_or(false) {
        return Ok(path);
    }
    fs::write(&path, PWSH_INTEGRATION).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// cmd is the Windows default, so this is the path most Windows users are
    /// actually on. It round-trips the real `PROMPT` value through the real
    /// filter rather than asserting on the string.
    #[test]
    fn cmd_reports_its_directory_and_still_draws_the_users_prompt() {
        use crate::pty::osc::{Marker, OscFilter};

        // A backslash path is only split by `Path` on Windows, so the
        // full-path case is written the way the pwsh test writes it.
        for name in ["cmd.exe", "cmd", "CMD.EXE", "C:/Windows/System32/cmd.exe"] {
            assert!(
                for_shell(name).env.iter().any(|(k, _)| k == "PROMPT"),
                "{name} was not recognised as cmd"
            );
            let integration = cmd_integration_with_prompt("");
            let (_, prompt) = integration.env.iter().find(|(k, _)| k == "PROMPT").unwrap();

            // What cmd itself prints, expanding its own codes.
            let emitted = prompt
                .replace("$E", "\x1b")
                .replace("$P", "C:\\Users\\dev\\project")
                .replace("$G", ">");

            let mut filter = OscFilter::new();
            let filtered = filter.feed(emitted.as_bytes());

            assert_eq!(
                filtered.markers,
                vec![
                    Marker::CommandFinished(None),
                    Marker::WorkingDirectory("C:\\Users\\dev\\project".to_string()),
                ],
                "{name}: no end marker and usable cwd came out of its prompt"
            );
            assert_eq!(
                filtered.output, "C:\\Users\\dev\\project>",
                "{name}: the markers must be invisible and the prompt untouched"
            );
        }
    }

    /// The markers are added to the user's prompt, not put in place of it —
    /// and they go in FRONT of it. ConPTY forwards a sequence that paints
    /// nothing only with the next frame that does paint something. In front,
    /// that frame is the prompt's own text, drawn at the same moment; after
    /// it, the end of a command would be reported only once the user typed.
    #[test]
    fn cmd_keeps_a_prompt_the_user_set() {
        let integration = cmd_integration_with_prompt("[mine]$P$G");
        let (_, prompt) = integration.env.iter().find(|(k, _)| k == "PROMPT").unwrap();
        assert!(prompt.ends_with("[mine]$P$G"), "the user's prompt is gone, or not last: {prompt}");
        assert!(prompt.starts_with("$E]133;D$E\\"), "no end marker in front: {prompt}");
        assert!(prompt.contains("$E]7;file:///$P$E\\"), "no cwd marker: {prompt}");

        // Nothing set: cmd's own default is drawn, so the prompt looks normal.
        let (_, default) = cmd_integration_with_prompt("   ").env.into_iter().next().unwrap();
        assert!(default.ends_with("$P$G"), "{default}");
    }

    /// Every prompt cmd draws reports that the command before it has ended:
    /// the one boundary cmd can report, since `PROMPT` is its only hook. With
    /// no code — `PROMPT` is read as written and never expands `%ERRORLEVEL%`,
    /// so a number there would be the same number after every command, a
    /// verdict no command gave. And nothing marks where a command starts.
    #[test]
    fn cmd_reports_an_end_at_every_prompt_and_never_a_code() {
        use crate::pty::osc::{Marker, OscFilter};

        let integration = cmd_integration_with_prompt("");
        let (_, prompt) = integration.env.iter().find(|(k, _)| k == "PROMPT").unwrap();
        assert!(!prompt.contains("133;D;"), "an exit code cmd cannot know: {prompt}");

        let draw = |dir: &str| prompt.replace("$E", "\x1b").replace("$P", dir).replace("$G", ">");
        // The first prompt, `dir` and what it printed, then the next prompt.
        let session = format!("{}dir\r\n file.txt\r\n\r\n{}", draw("C:\\work"), draw("C:\\work"));

        let mut filter = OscFilter::new();
        let filtered = filter.feed(session.as_bytes());
        assert_eq!(
            filtered.markers,
            vec![
                Marker::CommandFinished(None),
                Marker::WorkingDirectory("C:\\work".to_string()),
                Marker::CommandFinished(None),
                Marker::WorkingDirectory("C:\\work".to_string()),
            ],
            "one end, and no code, per prompt"
        );
        assert_eq!(filtered.output, "C:\\work>dir\r\n file.txt\r\n\r\nC:\\work>");
    }

    /// A shell we have nothing for must be left completely alone.
    #[test]
    fn an_unknown_shell_gets_no_environment_at_all() {
        let integration = for_shell("fish");
        assert!(integration.env.is_empty());
        assert!(integration.args.is_empty());
    }

    #[test]
    fn generates_all_four_rc_files() {
        let dir = prepare_zsh_dir().unwrap();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let body = fs::read_to_string(dir.join(name)).unwrap();
            assert!(body.contains("NexTerm shell integration"), "{name} missing header");
        }
        let zshrc = fs::read_to_string(dir.join(".zshrc")).unwrap();
        assert!(zshrc.contains("133;D;%d"));
        assert!(zshrc.contains("]7;file://"));
    }

    #[test]
    fn only_zsh_and_bash_and_powershell_get_integration() {
        assert!(for_shell("/usr/local/bin/fish").env.is_empty());
        assert!(for_shell("/usr/local/bin/fish").args.is_empty());
        assert!(for_shell("/bin/sh").env.is_empty());

        let zsh = for_shell("/bin/zsh");
        assert!(zsh.env.iter().any(|(k, _)| k == "ZDOTDIR"));
        assert!(zsh.env.iter().any(|(k, _)| k == "NEXTERM_USER_ZDOTDIR"));
        // Nothing but the login flag, and that only on macOS.
        assert!(zsh.args.iter().all(|a| a == "-l") && zsh.args.len() <= 1, "{:?}", zsh.args);
    }

    /// Runs a real interactive zsh with the generated ZDOTDIR and checks that
    /// the hooks emit the C and D markers around a command. Skipped when zsh
    /// is not installed.
    #[cfg(unix)]
    #[test]
    fn real_zsh_emits_markers_around_a_command() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        if Command::new("zsh").arg("--version").output().is_err() {
            eprintln!("zsh not installed; skipping");
            return;
        }
        let dir = prepare_zsh_dir().unwrap();
        // Isolated fake HOME so the developer's real dotfiles are not sourced.
        let home = std::env::temp_dir().join(format!("nexterm-si-home-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".zshrc"), "export NEXTERM_TEST_USER_RC=loaded\n").unwrap();

        let mut child = Command::new("zsh")
            .arg("-i")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("TERM", "xterm-256color")
            .env("ZDOTDIR", &dir)
            .env("NEXTERM_ZDOTDIR", &dir)
            .env("NEXTERM_USER_ZDOTDIR", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn zsh");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"echo marker-test-$NEXTERM_TEST_USER_RC\nfalse\nexit\n")
            .unwrap();
        let out = child.wait_with_output().expect("zsh output");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = fs::remove_dir_all(&home);

        assert!(combined.contains("marker-test-loaded"), "user rc not sourced: {combined:?}");
        assert!(combined.contains("\x1b]133;C\x07"), "no C marker: {combined:?}");
        assert!(combined.contains("\x1b]133;D;0\x07"), "no D;0 marker: {combined:?}");
        assert!(combined.contains("\x1b]133;D;1\x07"), "no D;1 marker after `false`: {combined:?}");
        assert!(combined.contains("\x1b]133;A\x07"), "no A marker: {combined:?}");
        assert!(combined.contains("\x1b]7;file://"), "no OSC 7 cwd marker: {combined:?}");
    }

    /// On macOS, zsh and bash start as login shells, as Terminal.app, iTerm2
    /// and VS Code start them; nowhere else does anything change. bash reads
    /// no --rcfile as a login shell, so for bash it is the rcfile that reads
    /// what a login shell would.
    #[test]
    fn zsh_and_bash_are_login_shells_on_macos_and_nowhere_else() {
        let zsh = for_shell("/bin/zsh");
        let bash = for_shell("/bin/bash");
        let bashrc = fs::read_to_string(&bash.args[1]).unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(zsh.args, ["-l"], "zsh on macOS must be a login shell");
            assert!(
                bashrc.contains("source /etc/profile") && bashrc.contains("source \"$HOME/.bash_profile\""),
                "bash on macOS must read what a login shell reads:\n{bashrc}"
            );
            assert!(!bashrc.contains("source \"$HOME/.bashrc\""), "a login shell does not read ~/.bashrc itself");
        } else {
            assert!(zsh.args.is_empty(), "zsh off macOS starts as it always did: {:?}", zsh.args);
            assert!(bashrc.contains("source \"$HOME/.bashrc\""), "{bashrc}");
            assert!(!bashrc.contains("/etc/profile"), "bash off macOS is not a login shell:\n{bashrc}");
        }
    }

    /// A zsh started the way NexTerm starts one on macOS, from an app opened in
    /// the Finder — that is, with launchd's PATH and nothing else. It has to
    /// end up with the PATH /etc/zprofile's path_helper builds, and read the
    /// user's own four files once each, in zsh's order, through the
    /// generated ZDOTDIR. Skipped when zsh is not installed.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_zsh_on_macos_gets_the_login_path() {
        let integration = for_shell("/bin/zsh");
        let Some(combined) = run_real_zsh(&integration, "/usr/bin:/bin:/usr/sbin:/sbin") else {
            eprintln!("zsh not installed; skipping");
            return;
        };
        assert_eq!(
            startup_files_read(&combined),
            [".zshenv", ".zprofile", ".zshrc", ".zlogin"],
            "{combined:?}"
        );
        let path = printed_path(&combined);
        assert!(
            path.split(':').any(|dir| dir == "/usr/local/bin"),
            "/etc/zprofile never ran: a Finder-launched terminal is left with PATH={path}"
        );
        assert!(combined.contains("\x1b]133;D;0\x07"), "no D marker: {combined:?}");
    }

    /// The value a `PATH=$PATH` line in `output` gave, after the C marker
    /// that comes ahead of it on the same line.
    #[cfg(target_os = "macos")]
    fn printed_path(output: &str) -> &str {
        let start = output.find("PATH=").unwrap_or_else(|| panic!("no PATH printed: {output:?}")) + 5;
        let rest = &output[start..];
        &rest[..rest.find('\n').unwrap_or(rest.len())]
    }

    /// The generated ZDOTDIR on any machine with zsh, whatever its platform
    /// starts: a login zsh reads .zshenv, .zprofile, .zshrc and .zlogin in
    /// that order, and the generated ones must hand each to the user's own
    /// exactly once; a non-login zsh reads only the two it always read.
    /// Skipped when zsh is not installed.
    #[cfg(unix)]
    #[test]
    fn real_zsh_reads_each_user_file_once_in_order() {
        let path = std::env::var("PATH").unwrap_or_default();
        for (login, expected) in [
            (true, &[".zshenv", ".zprofile", ".zshrc", ".zlogin"][..]),
            (false, &[".zshenv", ".zshrc"][..]),
        ] {
            let integration = for_shell_as("/bin/zsh", login);
            let Some(combined) = run_real_zsh(&integration, &path) else {
                eprintln!("zsh not installed; skipping");
                return;
            };
            assert_eq!(startup_files_read(&combined), expected, "login={login}: {combined:?}");
            assert!(combined.contains("\x1b]133;C\x07"), "login={login}: no C marker: {combined:?}");
            assert!(combined.contains("\x1b]133;D;0\x07"), "login={login}: no D marker: {combined:?}");
            assert!(combined.contains("\x1b]133;A\x07"), "login={login}: no A marker: {combined:?}");
        }
    }

    /// What `print -r -- startup-file:<name>` lines in the user's startup
    /// files reported, in order.
    #[cfg(unix)]
    fn startup_files_read(output: &str) -> Vec<&str> {
        output.lines().filter_map(|l| l.strip_prefix("startup-file:")).collect()
    }

    /// A real zsh started with `integration` and `path`, its user dotfiles in
    /// an isolated fake HOME, each saying when it is read. `None` when zsh is
    /// not installed.
    #[cfg(unix)]
    fn run_real_zsh(integration: &ShellIntegration, path: &str) -> Option<String> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let zsh = ["/bin/zsh", "/usr/bin/zsh"].into_iter().find(|p| Path::new(p).exists())?;
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let home = std::env::temp_dir().join(format!(
            "nexterm-si-zsh-home-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&home).unwrap();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            fs::write(home.join(name), format!("print -r -- startup-file:{name}\n")).unwrap();
        }

        let mut command = Command::new(zsh);
        // A pty makes NexTerm's zsh interactive; pipes do not.
        command.args(&integration.args).arg("-i").env_clear();
        for (key, value) in &integration.env {
            // for_shell named this machine's real home as the user's; the
            // fake one stands in for it.
            if key == "NEXTERM_USER_ZDOTDIR" {
                command.env(key, &home);
            } else {
                command.env(key, value);
            }
        }
        let mut child = command
            .env("PATH", path)
            .env("HOME", &home)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn zsh");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"print -r -- \"PATH=$PATH\"\nexit\n")
            .unwrap();
        let out = child.wait_with_output().expect("zsh output");
        let _ = fs::remove_dir_all(&home);
        Some(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }

    #[test]
    fn for_shell_bash_has_expected_arg_shape_and_generates_rcfile() {
        let result = for_shell("/bin/bash");
        assert!(result.env.is_empty());
        assert_eq!(result.args.len(), 3);
        assert_eq!(result.args[0], "--rcfile");
        assert!(result.args[1].ends_with("bashrc"), "unexpected rcfile path: {}", result.args[1]);
        assert_eq!(result.args[2], "-i");

        let contents = fs::read_to_string(&result.args[1]).unwrap();
        assert!(contents.contains("133;C"));
        assert!(contents.contains("133;D;"));
        assert!(contents.contains("]7;file://"));
        assert!(contents.contains("PROMPT_COMMAND"));
    }

    /// What a real bash prints, stdout and stderr together, started the way
    /// NexTerm starts one — as a login shell or not — in an isolated fake
    /// HOME holding `files`, and given `input` to run. `None` when bash is
    /// not installed.
    ///
    /// Unless `files` brings a login file of its own, the fake HOME gets a
    /// ~/.bash_profile that sources ~/.bashrc, as a Mac user's does: a login
    /// shell reads only the former.
    #[cfg(unix)]
    fn run_real_bash(login: bool, files: &[(&str, &str)], input: &str) -> Option<String> {
        run_real_bash_with_path(login, files, input, &std::env::var("PATH").unwrap_or_default())
    }

    #[cfg(unix)]
    fn run_real_bash_with_path(
        login: bool,
        files: &[(&str, &str)],
        input: &str,
        path: &str,
    ) -> Option<String> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        if Command::new("bash").arg("--version").output().is_err() {
            return None;
        }
        let integration = bash_integration(login);
        assert!(!integration.args.is_empty(), "bash integration produced no args");

        // Isolated fake HOME so the developer's real dotfiles are not sourced;
        // one per call, since these cases run in parallel.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let home = std::env::temp_dir().join(format!(
            "nexterm-si-bash-home-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&home).unwrap();
        let login_files = [".bash_profile", ".bash_login", ".profile"];
        if !files.iter().any(|(name, _)| login_files.contains(name)) {
            let sources_bashrc = "if [[ -f \"$HOME/.bashrc\" ]]; then source \"$HOME/.bashrc\"; fi\n";
            fs::write(home.join(".bash_profile"), sources_bashrc).unwrap();
        }
        for (name, body) in files {
            fs::write(home.join(name), body).unwrap();
        }

        let mut child = Command::new("bash")
            .args(&integration.args)
            .env_clear()
            .env("PATH", path)
            .env("HOME", &home)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn bash");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().expect("bash output");
        let _ = fs::remove_dir_all(&home);
        Some(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }

    /// The prompt hook and the DEBUG trap a user's ~/.bashrc sets up — where
    /// direnv, zoxide, starship and `history -a` live — each reporting the
    /// exit status it saw.
    #[cfg(unix)]
    const USER_BASHRC: &str = r#"
__user_prompt() { builtin printf 'user-prompt-command:%s\n' "$?"; }
PROMPT_COMMAND=__user_prompt
__user_trap() {
  case "$BASH_COMMAND" in
    "echo x") builtin printf 'user-debug-trap:%s\n' "$?" ;;
  esac
}
trap '__user_trap' DEBUG
"#;

    /// Runs a real bash with the generated rcfile and checks that the DEBUG
    /// trap / PROMPT_COMMAND pair emits the C and D markers around a
    /// command — and that the PROMPT_COMMAND and DEBUG trap ~/.bashrc set
    /// up still run, seeing the exit status they always saw. Assigning ours
    /// over them used to switch direnv, zoxide and shared history off
    /// without a word. Both kinds of shell, whichever this platform starts.
    /// Skipped when bash is not installed.
    #[cfg(unix)]
    #[test]
    fn real_bash_emits_markers_around_commands() {
        for login in [false, true] {
            let Some(combined) = run_real_bash(
                login,
                &[(".bashrc", USER_BASHRC)],
                "false\necho x\necho lastarg foo\necho \"dollar-underscore:[$_]\"\nfalse\nexit\n",
            ) else {
                eprintln!("bash not installed; skipping");
                return;
            };

            assert!(combined.contains("\x1b]133;C\x07"), "login={login}: no C marker: {combined:?}");
            assert!(combined.contains("\x1b]133;D;0\x07"), "login={login}: no D;0 marker: {combined:?}");
            assert!(
                combined.contains("\x1b]133;D;1\x07"),
                "login={login}: no D;1 marker after `false`: {combined:?}"
            );
            assert!(combined.contains("\x1b]133;A\x07"), "login={login}: no A marker: {combined:?}");
            assert!(combined.contains("\x1b]7;file://"), "login={login}: no OSC 7 cwd marker: {combined:?}");

            assert!(
                combined.contains("user-prompt-command:1\n") && combined.contains("user-prompt-command:0\n"),
                "login={login}: the PROMPT_COMMAND ~/.bashrc set no longer runs, or not with the \
                 command's exit status: {combined:?}"
            );
            assert!(
                combined.contains("user-debug-trap:1\n"),
                "login={login}: the DEBUG trap ~/.bashrc set no longer runs, or not with the exit \
                 status before it: {combined:?}"
            );
            // A DEBUG trap leaves $_ holding the last word it ran, and the
            // command it fired for sees that unless the trap puts $_ back.
            assert!(
                combined.contains("dollar-underscore:[foo]"),
                "login={login}: the trap changed what $_ holds for the command after it: {combined:?}"
            );
        }
    }

    /// bash 5.1 runs every element of an array PROMPT_COMMAND, and an older
    /// bash only the first. Either way the user's elements run as they did,
    /// and the markers still come out.
    #[cfg(unix)]
    #[test]
    fn real_bash_keeps_an_array_prompt_command() {
        use std::process::Command;

        let bashrc = r#"
__first() { builtin printf 'first-element:%s\n' "$?"; }
__second() { builtin printf 'second-element\n'; }
PROMPT_COMMAND=(__first __second)
"#;
        for login in [false, true] {
            let Some(combined) = run_real_bash(login, &[(".bashrc", bashrc)], "false\nexit\n") else {
                eprintln!("bash not installed; skipping");
                return;
            };
            let version = Command::new("bash")
                .args(["-c", "echo $(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))"])
                .output()
                .ok()
                .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok())
                .expect("bash says its version");

            assert!(
                combined.contains("first-element:1\n"),
                "login={login}: the first element no longer runs: {combined:?}"
            );
            assert_eq!(
                combined.contains("second-element\n"),
                version >= 501,
                "login={login}, bash {version}: the second element must run exactly when this bash \
                 runs arrays: {combined:?}"
            );
            assert!(
                combined.contains("\x1b]133;D;1\x07"),
                "login={login}: no D;1 marker after `false`: {combined:?}"
            );
            assert!(combined.contains("\x1b]133;C\x07"), "login={login}: no C marker: {combined:?}");
        }
    }

    /// bash-preexec (atuin, bash-it) owns PROMPT_COMMAND and the DEBUG trap
    /// and calls hook functions from two arrays. Ours join those arrays and
    /// leave both primitives to it. This stands in for it with the same
    /// contract.
    #[cfg(unix)]
    #[test]
    fn real_bash_joins_bash_preexec_instead_of_replacing_it() {
        let bashrc = r#"
bash_preexec_imported=defined
precmd_functions=()
preexec_functions=()
__bp_ret() { return "$1"; }
__bp_precmd() {
  local status=$? f
  for f in "${precmd_functions[@]}"; do __bp_ret "$status"; "$f"; done
  __bp_ready=1
}
__bp_preexec() {
  [[ -n "${__bp_ready-}" && "$BASH_COMMAND" != "$PROMPT_COMMAND" ]] || return 0
  __bp_ready=
  local f
  for f in "${preexec_functions[@]}"; do "$f" "$BASH_COMMAND"; done
}
trap '__bp_preexec' DEBUG
PROMPT_COMMAND=__bp_precmd
__user_precmd() { builtin printf 'precmd-function:%s\n' "$?"; }
__user_preexec() { builtin printf 'preexec-function:%s\n' "$1"; }
precmd_functions+=(__user_precmd)
preexec_functions+=(__user_preexec)
"#;
        for login in [false, true] {
            let Some(combined) = run_real_bash(
                login,
                &[(".bashrc", bashrc)],
                "false\necho x\necho \"[$PROMPT_COMMAND][$(trap -p DEBUG)]\"\nexit\n",
            ) else {
                eprintln!("bash not installed; skipping");
                return;
            };

            assert!(
                combined.contains("precmd-function:1\n"),
                "login={login}: bash-preexec's precmd functions stopped: {combined:?}"
            );
            assert!(
                combined.contains("preexec-function:echo x\n"),
                "login={login}: bash-preexec's preexec functions stopped: {combined:?}"
            );
            assert!(
                combined.contains("[__bp_precmd][trap -- '__bp_preexec' DEBUG]"),
                "login={login}: bash-preexec's own PROMPT_COMMAND and DEBUG trap were replaced: {combined:?}"
            );
            assert!(combined.contains("\x1b]133;C\x07"), "login={login}: no C marker: {combined:?}");
            assert!(
                combined.contains("\x1b]133;D;1\x07"),
                "login={login}: no D;1 marker after `false`: {combined:?}"
            );
            assert!(combined.contains("\x1b]133;D;0\x07"), "login={login}: no D;0 marker: {combined:?}");
            assert!(combined.contains("\x1b]133;A\x07"), "login={login}: no A marker: {combined:?}");
        }
    }

    /// ~/.bashrc read a second time — `source ~/.bashrc` after editing it —
    /// runs every installer in it again. starship's, finding its hook gone
    /// from PROMPT_COMMAND, keeps whatever is there and runs it from its own
    /// hook; had ours run a saved copy of the user's PROMPT_COMMAND (which
    /// holds starship's hook), each would have run the other forever. direnv's
    /// only checks for `;_direnv_hook;`.
    #[cfg(unix)]
    #[test]
    fn real_bash_survives_bashrc_being_read_again() {
        let bashrc = r#"
starship_precmd() {
  local status=$?
  builtin printf 'starship-precmd:%s\n' "$status"
  __ret "$status"
  eval "${_PRESERVED_PROMPT_COMMAND-}"
}
__ret() { return "$1"; }
if [[ -z "${PROMPT_COMMAND-}" ]]; then
  PROMPT_COMMAND="starship_precmd"
elif [[ "${PROMPT_COMMAND-}" != *"starship_precmd"* ]]; then
  _PRESERVED_PROMPT_COMMAND="$PROMPT_COMMAND"
  PROMPT_COMMAND="starship_precmd"
fi
_direnv_hook() { local previous_exit_status=$?; builtin printf 'direnv-hook\n'; return $previous_exit_status; }
if [[ ";${PROMPT_COMMAND[*]:-};" != *";_direnv_hook;"* ]]; then
  PROMPT_COMMAND="_direnv_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
"#;
        for login in [false, true] {
            let Some(combined) =
                run_real_bash(login, &[(".bashrc", bashrc)], "source ~/.bashrc\nfalse\nexit\n")
            else {
                eprintln!("bash not installed; skipping");
                return;
            };

            assert!(
                combined.contains("\x1b]133;D;1\x07"),
                "login={login}: the shell did not live to report `false` — the prompt hooks ran \
                 each other forever?: {combined:?}"
            );
            // Every prompt ran each hook once: not lost, not doubled, not looping.
            let prompts = combined.matches("\x1b]133;A\x07").count();
            assert_eq!(prompts, 3, "login={login}: startup, after `source`, after `false`: {combined:?}");
            assert_eq!(combined.matches("direnv-hook\n").count(), prompts, "login={login}: {combined:?}");
            assert_eq!(combined.matches("starship-precmd:").count(), prompts, "login={login}: {combined:?}");
            assert!(combined.contains("starship-precmd:1\n"), "login={login}: {combined:?}");
        }
    }

    /// A login bash reads /etc/profile, then the first of ~/.bash_profile,
    /// ~/.bash_login and ~/.profile that is there — and not ~/.bashrc, unless
    /// that file sources it. bash reads no --rcfile as a login shell, so the
    /// generated rcfile does that reading, and has to pick the same one.
    #[cfg(unix)]
    #[test]
    fn real_bash_as_a_login_shell_reads_the_first_profile_file() {
        let say = |name: &str, more: &str| format!("echo startup-file:{name}\n{more}");
        let bash_profile = say(".bash_profile", "source \"$HOME/.bashrc\"\n");
        let bash_login = say(".bash_login", "");
        let profile = say(".profile", "");
        let bashrc = say(".bashrc", "");
        let all = [
            (".bash_profile", bash_profile.as_str()),
            (".bash_login", bash_login.as_str()),
            (".profile", profile.as_str()),
            (".bashrc", bashrc.as_str()),
        ];

        let Some(combined) = run_real_bash(true, &all, "exit\n") else {
            eprintln!("bash not installed; skipping");
            return;
        };
        assert_eq!(startup_files_read(&combined), [".bash_profile", ".bashrc"], "{combined:?}");

        // No ~/.bash_profile or ~/.bash_login: ~/.profile is the one.
        let only_profile = [(".profile", profile.as_str()), (".bashrc", bashrc.as_str())];
        let combined = run_real_bash(true, &only_profile, "exit\n").unwrap();
        assert_eq!(startup_files_read(&combined), [".profile"], "{combined:?}");

        // Not a login shell: ~/.bashrc, as before.
        let combined = run_real_bash(false, &all, "exit\n").unwrap();
        assert_eq!(startup_files_read(&combined), [".bashrc"], "{combined:?}");
    }

    /// bash on macOS, started from an app opened in the Finder — launchd's
    /// PATH and nothing else — still ends up with the PATH /etc/profile's
    /// path_helper builds.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_bash_on_macos_gets_the_login_path() {
        let Some(combined) = run_real_bash_with_path(
            LOGIN_SHELLS,
            &[],
            "echo \"PATH=$PATH\"\nexit\n",
            "/usr/bin:/bin:/usr/sbin:/sbin",
        ) else {
            eprintln!("bash not installed; skipping");
            return;
        };
        let path = printed_path(&combined);
        assert!(
            path.split(':').any(|dir| dir == "/usr/local/bin"),
            "/etc/profile never ran: a Finder-launched terminal is left with PATH={path}"
        );
    }

    #[test]
    fn for_shell_pwsh_generates_script_and_dot_sources_it() {
        for name in ["pwsh.exe", "pwsh", "powershell.exe", "PowerShell.exe"] {
            let result = for_shell(name);
            assert!(result.env.is_empty(), "{name}: expected no env vars");
            assert_eq!(result.args.len(), 6, "{name}: unexpected args shape: {:?}", result.args);
            assert_eq!(result.args[0], "-NoLogo");
            assert_eq!(result.args[1], "-NoExit");
            assert_eq!(result.args[2], "-ExecutionPolicy");
            assert_eq!(result.args[3], "Bypass");
            assert_eq!(result.args[4], "-Command");

            let command = &result.args[5];
            assert!(command.starts_with(". '"), "{name}: expected a dot-source command, got {command}");
            assert!(command.ends_with('\''), "{name}: expected a dot-source command, got {command}");

            let script_path = command.trim_start_matches(". '").trim_end_matches('\'');
            let contents = fs::read_to_string(script_path).unwrap();
            assert!(contents.contains("133;C"));
            assert!(contents.contains("133;D;"));
            assert!(contents.contains("]7;file://"));
            assert!(contents.contains("function Global:prompt"));
            assert!(contents.contains("PSConsoleHostReadLine"));
        }
    }

    #[test]
    fn for_shell_matches_case_insensitively_and_ignores_exe_suffix() {
        let a = for_shell("/usr/bin/BASH");
        assert!(!a.args.is_empty());
        // `std::path::Path` only treats `\` as a separator when actually
        // compiled for Windows, so a backslash path can't be exercised here
        // — use `/`, which both Windows and Unix accept, to stay
        // cfg-portable while still covering path-with-directory matching.
        let b = for_shell("C:/Program Files/PowerShell/7/PWSH.EXE");
        assert!(!b.args.is_empty());
    }

    /// The generated rc files used to live in one fixed
    /// `$TMPDIR/nexterm-shell-integration/<shell>`. On Linux that is inside a
    /// world-writable /tmp, so another local account could plant the directory
    /// and have every NexTerm terminal source their code; and one path shared
    /// by every caller is what made this very suite race itself under cargo's
    /// parallel harness.
    #[test]
    fn integration_dirs_are_private_and_never_shared_between_calls() {
        let a = integration_dir("zsh").unwrap();
        let b = integration_dir("zsh").unwrap();
        assert_ne!(a, b, "two calls handed out the same directory");
        assert!(a.exists() && b.exists());

        let pid = std::process::id().to_string();
        for dir in [&a, &b] {
            let parent = dir.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
            assert!(parent.starts_with("nexterm-"), "unexpected parent: {parent}");
            // Followed, on unix, by a random part (see `process_dir`).
            assert!(
                parent.ends_with(&pid) || parent.contains(&format!("-{pid}-")),
                "the directory is not per-process: {parent}"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // Owner-only, and this user's own real directory — at BOTH
            // levels. The per-process one sits in a shared /tmp on Linux, and
            // whoever can write in it can swap a whole <shell>-N directory,
            // rc files and all, before the shell reads them.
            let uid = unsafe { libc::getuid() };
            for dir in [&a, a.parent().unwrap()] {
                let meta = fs::symlink_metadata(dir).unwrap();
                assert!(meta.file_type().is_dir(), "{} is not a directory of its own", dir.display());
                assert_eq!(meta.uid(), uid, "{} belongs to someone else", dir.display());
                let mode = meta.permissions().mode() & 0o777;
                assert_eq!(mode, 0o700, "{} is {mode:o}, not 700", dir.display());
            }

            // and it really is per-user
            let parent = a.parent().unwrap().file_name().unwrap().to_string_lossy().to_string();
            assert!(parent.contains(&uid.to_string()), "the directory is not per-user: {parent}");
        }

        // Clean up only the two directories this case made. `a.parent()` is
        // the per-PROCESS directory every test in this run shares, and
        // removing it deleted rc files a parallel test had just written and
        // was about to read — a ~5%-of-runs flake in
        // `generates_all_four_rc_files`.
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    /// What another user of a shared /tmp could have put where the directory
    /// goes is refused: something already there is never taken over, and
    /// nothing passes that is not this user's own real directory with
    /// nobody else let in.
    #[cfg(unix)]
    #[test]
    fn a_directory_that_is_not_ours_alone_is_never_used() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!("nexterm-si-private-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        create_private_dir(&base).expect("a new directory is made");
        check_private_dir(&base).expect("and passes the check");

        // Made by this call or not at all: one already there is refused, even
        // a private one of this user's. `create_dir_all` accepted any.
        let again = create_private_dir(&base).expect_err("an existing directory was taken over");
        assert_eq!(again.kind(), std::io::ErrorKind::AlreadyExists, "{again}");

        // A symlink to a private directory — what would be planted — is
        // neither made through nor accepted.
        let target = base.join("target");
        create_private_dir(&target).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(create_private_dir(&link).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert!(check_private_dir(&link).is_err(), "a symlink passed for a directory");

        // Open to other users.
        let open = base.join("open");
        fs::create_dir(&open).unwrap();
        fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_private_dir(&open).is_err(), "a directory others can enter passed");

        // Not a directory.
        let file = base.join("file");
        fs::write(&file, "").unwrap();
        assert!(check_private_dir(&file).is_err(), "a file passed for a directory");

        // Someone else's: `/` is root's.
        if unsafe { libc::getuid() } != 0 {
            let err = check_private_dir(Path::new("/")).unwrap_err();
            assert!(err.to_string().contains("owned by"), "{err}");
        }

        let _ = fs::remove_dir_all(&base);
    }

    /// The per-process directory's name cannot be worked out in advance: uid
    /// and pid, for whoever looks, and then a part that is new every time.
    #[cfg(unix)]
    #[test]
    fn the_per_process_directory_has_a_name_nobody_can_make_first() {
        let base = std::env::temp_dir().join(format!("nexterm-si-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        create_private_dir(&base).unwrap();

        let a = make_process_dir(&base).unwrap();
        let b = make_process_dir(&base).unwrap();
        assert_ne!(a, b);
        let prefix = format!("nexterm-{}-{}-", unsafe { libc::getuid() }, std::process::id());
        for dir in [&a, &b] {
            assert_eq!(dir.parent(), Some(base.as_path()));
            check_private_dir(dir).expect("made private");
            let name = dir.file_name().unwrap().to_string_lossy().to_string();
            let random = name.strip_prefix(&prefix).unwrap_or_else(|| panic!("unexpected name {name}"));
            assert!(
                random.len() >= 12 && random.chars().all(|c| c.is_ascii_hexdigit()),
                "no random part in {name}"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }
}
