//! Which shells this machine actually has.
//!
//! The Settings window used to offer a hardcoded list per platform: "PowerShell
//! 7" on every Windows box whether or not `pwsh` was installed, and never Git
//! Bash or WSL — which on a Windows machine are the two most likely to be the
//! one you want. Offering something that is not there is the same class of
//! problem as a status bar claiming a git branch it never read.
//!
//! So the list is found rather than assumed. Everything here only reports what
//! it can see on disk; `PtyManager::resolve_shell` still accepts a name or a
//! path typed by hand, and nothing here narrows what a user may ask for.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A shell the user can open a terminal with.
///
/// `spec` is what goes to `pty_spawn` — an absolute path here, so a profile
/// cannot be re-resolved into a different binary later.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub spec: String,
}

/// The first directory on PATH holding `name`, if any.
///
/// Windows-only: the unix side knows where its shells live, and an unused
/// helper is an error here — `#![deny(warnings)]` turns `dead_code` into a
/// failed build, which is how a `#[cfg(unix)]`-only helper once broke the
/// Windows build ten minutes after `cargo test` went green on ubuntu.
#[cfg(windows)]
fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn push_unique(out: &mut Vec<ShellProfile>, id: &str, label: &str, path: &Path) {
    let spec = path.to_string_lossy().to_string();
    // A machine may reach the same binary twice — `$SHELL` is usually also
    // /bin/zsh — and two rows for one shell is noise, not a choice.
    if out.iter().any(|p| p.spec.eq_ignore_ascii_case(&spec)) {
        return;
    }
    out.push(ShellProfile {
        id: id.to_string(),
        label: label.to_string(),
        spec,
    });
}

/// Every shell found on this machine, in the order they should be offered.
///
/// Empty is a possible answer and not an error: the caller still has
/// "Default", which asks the backend to decide at spawn time.
pub fn list() -> Vec<ShellProfile> {
    let mut out = Vec::new();

    #[cfg(unix)]
    {
        // What the user's account is actually set to comes first.
        if let Ok(shell) = std::env::var("SHELL") {
            let path = PathBuf::from(shell.trim());
            if path.is_file() {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "shell".to_string());
                push_unique(&mut out, "login-shell", &format!("{name} (login shell)"), &path);
            }
        }

        for (id, label, candidates) in [
            ("zsh", "zsh", vec!["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]),
            ("bash", "bash", vec!["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"]),
            // Homebrew installs elsewhere on Apple silicon than on Intel, and
            // fish is rarely in /bin at all.
            ("fish", "fish", vec!["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"]),
            ("sh", "sh", vec!["/bin/sh"]),
        ] {
            if let Some(found) = candidates.iter().map(Path::new).find(|p| p.is_file()) {
                push_unique(&mut out, id, label, found);
            }
        }
    }

    #[cfg(windows)]
    {
        if let Some(path) = on_path("pwsh.exe") {
            push_unique(&mut out, "pwsh", "PowerShell 7", &path);
        }
        if let Some(path) = on_path("powershell.exe") {
            push_unique(&mut out, "powershell", "Windows PowerShell", &path);
        }
        match std::env::var("COMSPEC") {
            Ok(comspec) if Path::new(&comspec).is_file() => {
                push_unique(&mut out, "cmd", "Command Prompt", Path::new(&comspec));
            }
            _ => {
                if let Some(path) = on_path("cmd.exe") {
                    push_unique(&mut out, "cmd", "Command Prompt", &path);
                }
            }
        }
        // Git for Windows, in both the places its installer uses. Offered
        // because a developer on Windows very often wants this one and the old
        // hardcoded list never mentioned it.
        for candidate in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let path = Path::new(candidate);
            if path.is_file() {
                push_unique(&mut out, "git-bash", "Git Bash", path);
                break;
            }
        }
        if let Some(path) = on_path("wsl.exe") {
            push_unique(&mut out, "wsl", "WSL", &path);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shell_offered_is_one_that_exists() {
        // The whole point: the list is found, not assumed. A row naming a
        // binary that is not there is how the old hardcoded list offered
        // "PowerShell 7" on machines without it.
        for profile in list() {
            assert!(
                Path::new(&profile.spec).is_file(),
                "offered {} at {}, which is not a file",
                profile.label,
                profile.spec
            );
        }
    }

    #[test]
    fn ids_and_paths_are_unique() {
        let found = list();
        for (i, a) in found.iter().enumerate() {
            for b in found.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "two profiles share the id {}", a.id);
                assert!(
                    !a.spec.eq_ignore_ascii_case(&b.spec),
                    "{} and {} are the same binary",
                    a.label,
                    b.label
                );
            }
        }
    }

    #[test]
    fn a_developer_machine_has_at_least_one() {
        // Not a law about every machine — CI runners and every platform this
        // is developed on have a shell, and an empty list there would mean the
        // detection stopped working rather than that the box is bare.
        assert!(!list().is_empty(), "no shell found at all");
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_leads_when_there_is_one() {
        if std::env::var("SHELL").map(|s| Path::new(s.trim()).is_file()).unwrap_or(false) {
            assert_eq!(list().first().map(|p| p.id.as_str()), Some("login-shell"));
        }
    }
}
