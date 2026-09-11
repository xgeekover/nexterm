//! Shell integration: make the user's shell announce command boundaries.
//!
//! For zsh we point `ZDOTDIR` at a generated directory whose rc files first
//! source the user's real rc files and then register `preexec`/`precmd`
//! hooks that print OSC 133 markers (the same protocol VS Code, iTerm2 and
//! Warp use). The PTY reader turns those markers into `pty-command-done`
//! events, which is what lets a command block close with a real exit code.
//!
//! Other shells fall back to plain spawning (no markers, blocks only close
//! when the shell exits).

use std::fs;
use std::path::{Path, PathBuf};

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

/// Environment variables to add to the spawned shell so it loads our hooks.
pub fn env_for_shell(shell_path: &str) -> Vec<(String, String)> {
    let name = Path::new(shell_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name != "zsh" {
        return Vec::new();
    }
    match prepare_zsh_dir() {
        Ok(dir) => {
            let dir_str = dir.to_string_lossy().to_string();
            let user_zdotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
            vec![
                ("ZDOTDIR".to_string(), dir_str.clone()),
                ("NEXTERM_ZDOTDIR".to_string(), dir_str),
                ("NEXTERM_USER_ZDOTDIR".to_string(), user_zdotdir),
            ]
        }
        // If we cannot write the rc files, spawn the shell plainly rather than fail.
        Err(_) => Vec::new(),
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
    fn only_zsh_gets_an_environment() {
        assert!(env_for_shell("/bin/bash").is_empty());
        assert!(env_for_shell("/usr/local/bin/fish").is_empty());
        let zsh = env_for_shell("/bin/zsh");
        assert!(zsh.iter().any(|(k, _)| k == "ZDOTDIR"));
        assert!(zsh.iter().any(|(k, _)| k == "NEXTERM_USER_ZDOTDIR"));
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
}
