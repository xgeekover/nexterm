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
    /// Bytes on their way to the shell.
    ///
    /// A tty input queue fills at about a kilobyte, and `write_all` then
    /// blocks until the foreground program reads. `pty_write` is a synchronous
    /// Tauri command, so that block landed on the IPC thread and froze the
    /// whole window — pasting a multi-line snippet into a running command was
    /// enough, and Ctrl-C could not get through afterwards because the thread
    /// never returned to handle another call. The command now hands the bytes
    /// to a per-session writer thread and returns immediately.
    ///
    /// `None` once the session is killed; dropping the sender ends the thread.
    pub input: Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>,
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
}

/// Move a PTY's blocking writes onto their own thread.
///
/// Returns the queue the caller hands bytes to. The thread ends when the
/// sender is dropped, or as soon as a write fails (the shell is gone).
fn spawn_writer_thread(
    mut writer: Box<dyn Write + Send>,
    session_id: &str,
) -> Result<std::sync::mpsc::Sender<Vec<u8>>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name(format!("pty-writer-{session_id}"))
        .spawn(move || {
            while let Ok(bytes) = rx.recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
        })
        .map_err(|e| format!("Failed to spawn PTY writer thread: {e}"))?;
    Ok(tx)
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

        let input_tx = spawn_writer_thread(writer, &session_id)?;

        let created_at = Utc::now();
        let session = Arc::new(PtySession {
            id: session_id.clone(),
            shell: shell_path.clone(),
            created_at,
            master: Mutex::new(pair.master),
            input: Mutex::new(Some(input_tx)),
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

                // The shell died mid-character: emit the bytes verbatim rather
                // than holding them forever.
                let tail = filter.take_utf8_tail();
                if !tail.is_empty() {
                    let payload = PtyOutputPayload {
                        session_id: session_id_clone.clone(),
                        data: String::from_utf8_lossy(&tail).to_string(),
                    };
                    let _ = app_handle_clone.emit("pty-output", &payload);
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

        let queue = session.input.lock();
        let sender = queue
            .as_ref()
            .ok_or_else(|| format!("PTY session is closed: {session_id}"))?;
        sender
            .send(data.as_bytes().to_vec())
            .map_err(|_| format!("PTY session is no longer accepting input: {session_id}"))
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
            // Close the input queue first so the writer thread is not left
            // blocked on a write to a shell that is about to die.
            *session.input.lock() = None;
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


#[cfg(test)]
mod writer_thread_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::{Duration, Instant};

    /// Stands in for a PTY master whose tty input queue is full: every write
    /// blocks until the foreground program reads.
    struct BlockingWriter {
        delay: Duration,
        writes: Arc<AtomicUsize>,
        finished: Arc<AtomicUsize>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.fetch_add(1, AtomicOrdering::SeqCst);
            thread::sleep(self.delay);
            self.finished.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn queueing_input_does_not_block_the_caller() {
        let writes = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let tx = spawn_writer_thread(
            Box::new(BlockingWriter {
                delay: Duration::from_millis(400),
                writes: writes.clone(),
                finished: finished.clone(),
            }),
            "test-block",
        )
        .unwrap();

        // Three writes that each take 400ms on the far side. Handing them over
        // must not cost the caller anything — this is the IPC thread, and
        // blocking it here is what froze the window on a multi-line paste.
        let started = Instant::now();
        for _ in 0..3 {
            tx.send(b"echo hello\n".to_vec()).unwrap();
        }
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(100),
            "queueing blocked the caller for {elapsed:?}"
        );
        assert_eq!(finished.load(AtomicOrdering::SeqCst), 0, "write completed synchronously");

        // and the bytes really do get written, in the background
        thread::sleep(Duration::from_millis(1500));
        assert_eq!(writes.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(finished.load(AtomicOrdering::SeqCst), 3);
    }

    /// The unit tests above use a fake writer; this one drives a real shell
    /// through the real queue, because the whole input path was rewritten.
    #[test]
    fn a_real_shell_receives_queued_input() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env("PS1", "");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn sh");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = pair.master.take_writer().expect("writer");
        let tx = spawn_writer_thread(writer, "test-real").unwrap();

        tx.send(b"echo nexterm-queue-ok\n".to_vec()).unwrap();
        tx.send(b"exit\n".to_vec()).unwrap();

        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = [0u8; 1024];
        while Instant::now() < deadline && !seen.contains("nexterm-queue-ok") {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => seen.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();

        assert!(
            seen.contains("nexterm-queue-ok"),
            "the shell never received the queued input; saw: {seen:?}"
        );
    }

    #[test]
    fn dropping_the_queue_ends_the_writer_thread() {
        let writes = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let tx = spawn_writer_thread(
            Box::new(BlockingWriter {
                delay: Duration::from_millis(1),
                writes: writes.clone(),
                finished: finished.clone(),
            }),
            "test-drop",
        )
        .unwrap();

        tx.send(b"a".to_vec()).unwrap();
        thread::sleep(Duration::from_millis(50));
        drop(tx);
        thread::sleep(Duration::from_millis(50));

        // Nothing to assert about the thread handle directly; what matters is
        // that a send after the drop is impossible (the channel is gone) and
        // the one queued byte was written.
        assert_eq!(writes.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn a_failing_write_stops_the_thread_instead_of_spinning() {
        struct AlwaysFails;
        impl Write for AlwaysFails {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let tx = spawn_writer_thread(Box::new(AlwaysFails), "test-fail").unwrap();
        // The first send is accepted; the thread then exits, so a later send
        // reports the closed channel rather than piling up forever.
        tx.send(b"x".to_vec()).unwrap();
        thread::sleep(Duration::from_millis(80));
        assert!(tx.send(b"y".to_vec()).is_err(), "writer thread outlived a broken pipe");
    }
}
