//! Shell integration: make the user's shell announce command boundaries.
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
//! Every other shell falls back to plain spawning (no markers, blocks only
//! close when the shell exits).

use std::fs;
use std::path::{Path, PathBuf};

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

/// Build the integration payload for the shell at `shell_path`. Matches on
/// the executable's file name (case-insensitively, `.exe` suffix ignored)
/// so it works the same whether the caller passed a bare name or a full
/// path.
pub fn for_shell(shell_path: &str) -> ShellIntegration {
    let file_name = Path::new(shell_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem = file_name.strip_suffix(".exe").unwrap_or(&file_name);

    match stem {
        "zsh" => zsh_integration(),
        "bash" => bash_integration(),
        "pwsh" | "powershell" => pwsh_integration(),
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
__nexterm_preexec() {
  builtin printf '\e]133;C\a'
}
__nexterm_precmd() {
  local __nexterm_status=$?
  builtin printf '\e]133;D;%d\a' "$__nexterm_status"
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

fn zsh_integration() -> ShellIntegration {
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
                args: Vec::new(),
            }
        }
        // If we cannot write the rc files, spawn the shell plainly rather than fail.
        Err(_) => ShellIntegration::none(),
    }
}

/// Write (or refresh) the generated zsh rc directory and return its path.
pub fn prepare_zsh_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("nexterm-shell-integration").join("zsh");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
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
// bash (Linux / Git Bash / macOS fallback)
// ---------------------------------------------------------------------

const BASHRC: &str = r#"# NexTerm shell integration (bash) — generated file, do not edit.
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

# OSC 133: A = prompt start, C = command output starts, D;<code> = command done
#
# bash has no preexec/precmd hooks, so we build them out of two primitives:
#   - PROMPT_COMMAND runs right before every prompt is drawn (our precmd).
#   - `trap ... DEBUG` runs before every top-level simple command (our
#     preexec). It also fires once for PROMPT_COMMAND's own invocation, and
#     once per simple command in a compound line (`a; b; c`), so:
#       * we skip it when $BASH_COMMAND is exactly $PROMPT_COMMAND (the
#         standard bash-preexec trick for ignoring the trap "for
#         PROMPT_COMMAND"), and
#       * a guard flag (set in precmd, cleared in the trap) makes sure the
#         C marker prints exactly once per typed command rather than once
#         per simple command inside it.
#     The trap is not traced into shell functions unless `set -o functrace`
#     is enabled, which we never do, so the statements inside
#     __nexterm_precmd/__nexterm_preexec don't retrigger the trap while it
#     is running (i.e. it is effectively ignored "while running the precmd
#     itself").
__nexterm_pending_preexec=0

__nexterm_preexec() {
  if [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]]; then
    return
  fi
  if [[ "$__nexterm_pending_preexec" != "1" ]]; then
    return
  fi
  __nexterm_pending_preexec=0
  builtin printf '\e]133;C\a'
}

__nexterm_precmd() {
  local __nexterm_status=$?
  builtin printf '\e]133;D;%d\a' "$__nexterm_status"
  builtin printf '\e]133;A\a'
  __nexterm_pending_preexec=1
}

trap '__nexterm_preexec' DEBUG
PROMPT_COMMAND='__nexterm_precmd'
"#;

fn bash_integration() -> ShellIntegration {
    match prepare_bash_rcfile() {
        Ok(path) => ShellIntegration {
            env: Vec::new(),
            args: vec![
                "--rcfile".to_string(),
                path.to_string_lossy().to_string(),
                "-i".to_string(),
            ],
        },
        Err(_) => ShellIntegration::none(),
    }
}

/// Write (or refresh) the generated bash rc file and return its path.
pub fn prepare_bash_rcfile() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("nexterm-shell-integration").join("bash");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join("bashrc");
    if fs::read_to_string(&path).map(|cur| cur == BASHRC).unwrap_or(false) {
        return Ok(path);
    }
    fs::write(&path, BASHRC).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path)
}

// ---------------------------------------------------------------------
// PowerShell (pwsh / Windows PowerShell)
// ---------------------------------------------------------------------

const PWSH_INTEGRATION: &str = r#"# NexTerm shell integration (PowerShell) — generated file, do not edit.
# OSC 133: A = prompt start, C = command output starts, D;<code> = command done
#
# PowerShell has no preexec/precmd hooks either, so — following VS Code's
# shell integration pattern — we wrap two functions instead:
#   - `prompt` runs every time PowerShell is about to draw a prompt. Its
#     *return value* becomes the prompt text, so we splice the D/A markers
#     onto the front of whatever the original prompt would have printed.
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
    $__nextermCode = 0
    if (-not $?) {
        $__nextermCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    }
    $__nextermMarker = "$([char]27)]133;D;$__nextermCode$([char]7)$([char]27)]133;A$([char]7)"
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
    let dir = std::env::temp_dir().join("nexterm-shell-integration").join("pwsh");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
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

    #[test]
    fn generates_all_four_rc_files() {
        let dir = prepare_zsh_dir().unwrap();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let body = fs::read_to_string(dir.join(name)).unwrap();
            assert!(body.contains("NexTerm shell integration"), "{name} missing header");
        }
        assert!(fs::read_to_string(dir.join(".zshrc")).unwrap().contains("133;D;%d"));
    }

    #[test]
    fn only_zsh_and_bash_and_powershell_get_integration() {
        assert!(for_shell("/usr/local/bin/fish").env.is_empty());
        assert!(for_shell("/usr/local/bin/fish").args.is_empty());
        assert!(for_shell("/bin/sh").env.is_empty());

        let zsh = for_shell("/bin/zsh");
        assert!(zsh.env.iter().any(|(k, _)| k == "ZDOTDIR"));
        assert!(zsh.env.iter().any(|(k, _)| k == "NEXTERM_USER_ZDOTDIR"));
        assert!(zsh.args.is_empty());
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
        assert!(contents.contains("PROMPT_COMMAND"));
    }

    /// Runs a real bash with the generated rcfile and checks that the DEBUG
    /// trap / PROMPT_COMMAND pair emits the C and D markers around a
    /// command. Skipped when bash is not installed.
    #[cfg(unix)]
    #[test]
    fn real_bash_emits_markers_around_commands() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        if Command::new("bash").arg("--version").output().is_err() {
            eprintln!("bash not installed; skipping");
            return;
        }
        let integration = bash_integration();
        assert!(!integration.args.is_empty(), "bash integration produced no args");

        // Isolated fake HOME so the developer's real .bashrc is not sourced.
        let home = std::env::temp_dir().join(format!("nexterm-si-bash-home-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();

        let mut child = Command::new("bash")
            .args(&integration.args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("TERM", "xterm-256color")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn bash");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"echo x\nfalse\nexit\n")
            .unwrap();
        let out = child.wait_with_output().expect("bash output");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = fs::remove_dir_all(&home);

        assert!(combined.contains("\x1b]133;C\x07"), "no C marker: {combined:?}");
        assert!(combined.contains("\x1b]133;D;0\x07"), "no D;0 marker: {combined:?}");
        assert!(combined.contains("\x1b]133;D;1\x07"), "no D;1 marker after `false`: {combined:?}");
        assert!(combined.contains("\x1b]133;A\x07"), "no A marker: {combined:?}");
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
}
