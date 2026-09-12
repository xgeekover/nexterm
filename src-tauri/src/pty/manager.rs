use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use chrono::Utc;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use super::osc::{Marker, OscFilter};
use super::shell_integration;
use crate::models::PtyCommandDonePayload;
use crate::models::PtyCwdPayload;

use crate::models::{PtyExitPayload, PtyOutputPayload, PtySessionInfo};

pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub created_at: chrono::DateTime<Utc>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<PtySession>>>>,
    counter: AtomicU64,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(1),
        }
    }

    pub fn default_shell() -> String {
        #[cfg(unix)]
        {
            if let Ok(shell) = std::env::var("SHELL") {
                if !shell.trim().is_empty() && Path::new(&shell).exists() {
                    return shell;
                }
            }
            if Path::new("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else if Path::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        }
        #[cfg(windows)]
        {
            // PowerShell 7+ (`pwsh.exe`) is the modern, cross-platform build;
            // prefer it when the user has it installed. It does not ship
            // with Windows, so we search PATH ourselves rather than assume
            // it resolves the way `powershell.exe` (always in System32) does.
            if let Some(pwsh) = Self::find_on_path("pwsh.exe") {
                return pwsh;
            }
            if Self::find_on_path("powershell.exe").is_some() {
                return "powershell.exe".to_string();
            }
            if let Ok(comspec) = std::env::var("COMSPEC") {
                if !comspec.trim().is_empty() && Path::new(&comspec).exists() {
                    return comspec;
                }
            }
            "powershell.exe".to_string()
        }
    }

    /// Search `PATH` for an executable by file name, Windows-only. Used to
    /// find `pwsh.exe`, which — unlike `powershell.exe` — is not guaranteed
    /// to exist, so we must probe for it instead of assuming it resolves.
    #[cfg(windows)]
    fn find_on_path(exe_name: &str) -> Option<String> {
        let path_var = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        None
    }

    pub fn spawn(
        &self,
        app_handle: AppHandle,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Result<PtySessionInfo, String> {
        let session_id = format!("pty-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        let shell_path = match shell {
            Some(s) if !s.trim().is_empty() => s,
            _ => Self::default_shell(),
        };

        let mut cmd = CommandBuilder::new(&shell_path);
        if let Some(dir) = cwd {
            if !dir.trim().is_empty() && Path::new(&dir).is_dir() {
                cmd.cwd(dir);
            }
        }
        // ConPTY (Windows) ignores TERM/COLORTERM; harmless to set anyway.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("NEXTERM", "1");
        let integration = shell_integration::for_shell(&shell_path);
        for (key, value) in integration.env {
            cmd.env(key, value);
        }
        if !integration.args.is_empty() {
            cmd.args(&integration.args);
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.clamp(2, 200),
                cols: cols.clamp(10, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell '{shell_path}': {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

        let created_at = Utc::now();
        let session = Arc::new(PtySession {
            id: session_id.clone(),
            shell: shell_path.clone(),
            created_at,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        });

        self.sessions
            .lock()
            .insert(session_id.clone(), session.clone());

        let session_id_clone = session_id.clone();
        let app_handle_clone = app_handle.clone();
        let sessions_map_clone = self.sessions.clone();
        let session_weak = Arc::downgrade(&session);

        thread::Builder::new()
            .name(format!("pty-reader-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                // Strips OSC 133 markers (everything else is forwarded verbatim) and tells us
                // when a command finished (see osc.rs / shell_integration.rs).
                let mut filter = OscFilter::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let filtered = filter.feed(&buf[..n]);
                            if !filtered.output.is_empty() {
                                let payload = PtyOutputPayload {
                                    session_id: session_id_clone.clone(),
                                    data: filtered.output,
                                };
                                let _ = app_handle_clone.emit("pty-output", &payload);
                            }
                            for marker in filtered.markers {
                                match marker {
                                    Marker::CommandFinished(exit_code) => {
                                        let payload = PtyCommandDonePayload {
                                            session_id: session_id_clone.clone(),
                                            exit_code,
                                        };
                                        let _ = app_handle_clone.emit("pty-command-done", &payload);
                                    }
                                    Marker::WorkingDirectory(cwd) => {
                                        let payload = PtyCwdPayload {
                                            session_id: session_id_clone.clone(),
                                            cwd,
                                        };
                                        let _ = app_handle_clone.emit("pty-cwd", &payload);
                                    }
                                    Marker::PromptStart | Marker::CommandStart | Marker::CommandExecuted => {}
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                let exit_code = if let Some(session_arc) = session_weak.upgrade() {
                    let mut child = session_arc.child.lock();
                    child.wait().ok().map(|status| status.exit_code())
                } else {
                    None
                };

                let exit_payload = PtyExitPayload {
                    session_id: session_id_clone.clone(),
                    exit_code,
                };
                let _ = app_handle_clone.emit("pty-exit", &exit_payload);

                sessions_map_clone.lock().remove(&session_id_clone);
            })
            .map_err(|e| format!("Failed to spawn PTY reader thread: {e}"))?;

        Ok(PtySessionInfo {
            id: session_id.clone(),
            session_id: session_id.clone(),
            shell: shell_path,
            created_at,
        })
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("PTY session not found: {session_id}"))?
        };

        let mut writer = session.writer.lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY writer: {e}"))?;

        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("PTY session not found: {session_id}"))?
        };

        let master = session.master.lock();
        master
            .resize(PtySize {
                rows: rows.clamp(2, 200),
                cols: cols.clamp(10, 500),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {e}"))?;

        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let session = self.sessions.lock().remove(session_id);
        if let Some(session) = session {
            let mut child = session.child.lock();
            let _ = child.kill();
        }
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<PtySessionInfo> {
        let sessions = self.sessions.lock();
        sessions
            .values()
            .map(|s| PtySessionInfo {
                id: s.id.clone(),
                session_id: s.id.clone(),
                shell: s.shell.clone(),
                created_at: s.created_at,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_shell_resolution() {
        let shell = PtyManager::default_shell();
        assert!(!shell.trim().is_empty());
        #[cfg(unix)]
        {
            assert!(shell.contains("sh") || shell.contains("bash") || shell.contains("zsh"));
        }
    }

    #[test]
    fn test_pty_manager_session_management() {
        let manager = PtyManager::new();
        assert!(manager.list_sessions().is_empty());

        // Error handling on invalid session IDs
        let err_write = manager.write("invalid-session", "echo hi");
        assert!(err_write.is_err());
        assert!(err_write.unwrap_err().contains("PTY session not found"));

        let err_resize = manager.resize("invalid-session", 80, 24);
        assert!(err_resize.is_err());
        assert!(err_resize.unwrap_err().contains("PTY session not found"));

        // Kill on unknown session succeeds gracefully (no-op)
        assert!(manager.kill("invalid-session").is_ok());
    }
}
