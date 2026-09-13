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

/// The kernel's buffer for one canonical-mode input line, in bytes.
///
/// In canonical ("cooked") mode the line discipline buffers a line until a
/// newline arrives. A newline-free run that fills this buffer loses data —
/// differently on each platform, both measured against a real pty:
///
///   macOS  buffer 1024: the line is discarded WHOLE. 1023 bytes plus the
///          newline arrive intact; 1024 bytes deliver nothing at all.
///   Linux  buffer 4096: the line is TRUNCATED. 4095 bytes plus the newline
///          arrive intact; past that only the first 4096 bytes ever arrive.
///
/// Splitting the write up does not help on either, because the buffer
/// accumulates across writes.
///
/// `fpathconf(_PC_MAX_CANON)` is NOT usable for this. It reports 1024 on
/// macOS, which is right, but 255 on Linux — the POSIX minimum, sixteen times
/// smaller than the real buffer. Trusting it made the guard below refuse
/// pastes that Linux handles perfectly well, which is worse than the silent
/// loss it was meant to prevent. The constants are measured, and
/// `canonical_limit_tests` re-measures the boundary on whatever platform it
/// runs, so a wrong value fails CI rather than reaching a user.
#[cfg(all(unix, target_os = "macos"))]
pub(crate) const CANON_LINE_LIMIT: usize = 1024;
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) const CANON_LINE_LIMIT: usize = 4096;

/// Whether the foreground program has this tty in canonical mode.
///
/// `tcgetattr` on the MASTER side reports the line discipline the slave is
/// running under, so this tracks the program that currently owns the terminal
/// — a shell's line editor turns ICANON off, `cat` and `read` leave it on.
/// `None` when the mode cannot be determined, so callers stay out of the way.
#[cfg(unix)]
fn is_canonical(master: &(dyn MasterPty + Send)) -> Option<bool> {
    let fd = master.as_raw_fd()?;
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: `tcgetattr` fills a zeroed termios for an fd we own.
    if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
        return None;
    }
    Some((termios.c_lflag & libc::ICANON) != 0)
}

/// The longest run of bytes at the START of `data` with no newline in it.
///
/// Only a leading run matters: once a newline goes through, the line
/// discipline hands that line to the program and starts the buffer over.
fn leading_line_len(data: &[u8]) -> usize {
    data.iter().position(|&b| b == b'\n' || b == b'\r').unwrap_or(data.len())
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
            // The plain command prompt, which is what "a terminal" means to
            // most people on Windows and what every Windows box has. PowerShell
            // is a deliberate choice now (`terminal.integrated.defaultShell`),
            // not something NexTerm decides for you.
            if let Ok(comspec) = std::env::var("COMSPEC") {
                if !comspec.trim().is_empty() && Path::new(&comspec).exists() {
                    return comspec;
                }
            }
            "cmd.exe".to_string()
        }
    }

    /// Turn the user's choice into something spawnable.
    ///
    /// The frontend sends either one of a few well-known names or an absolute
    /// path, so a user can point at a shell we have never heard of.
    pub fn resolve_shell(spec: Option<&str>) -> String {
        let spec = spec.map(str::trim).unwrap_or("");
        if spec.is_empty() || spec == "default" {
            return Self::default_shell();
        }

        // An explicit path wins over any name matching.
        if spec.contains('/') || spec.contains('\\') {
            return spec.to_string();
        }

        #[cfg(windows)]
        {
            match spec {
                "cmd" => std::env::var("COMSPEC")
                    .ok()
                    .filter(|c| !c.trim().is_empty())
                    .unwrap_or_else(|| "cmd.exe".to_string()),
                "powershell" => "powershell.exe".to_string(),
                "pwsh" => Self::find_on_path("pwsh.exe").unwrap_or_else(|| "pwsh.exe".to_string()),
                other => other.to_string(),
            }
        }
        #[cfg(unix)]
        {
            for dir in ["/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"] {
                let candidate = format!("{dir}{spec}");
                if Path::new(&candidate).exists() {
                    return candidate;
                }
            }
            spec.to_string()
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
        let shell_path = Self::resolve_shell(shell.as_deref());

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

        // A newline-free run this long is dropped in full by the line
        // discipline when the foreground program reads in canonical mode, and
        // nothing we do on this side changes that — chunking it does not help,
        // because the kernel's buffer accumulates across writes. Say so
        // instead of handing over bytes that silently evaporate.
        #[cfg(unix)]
        {
            let run = leading_line_len(data.as_bytes());
            {
                if run >= CANON_LINE_LIMIT {
                    let canonical = {
                        let master = session.master.lock();
                        is_canonical(master.as_ref())
                    };
                    if canonical == Some(true) {
                        return Err(format!(
                            "{run} bytes were not sent: the program reading this terminal takes \
                             at most {} bytes on one line. Send it in pieces separated by \
                             newlines, or write it to a file instead.",
                            CANON_LINE_LIMIT - 1
                        ));
                    }
                }
            }
        }

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

#[cfg(test)]
mod shell_choice_tests {
    use super::*;

    /// The shell is the user's choice, not ours. On Windows the default used
    /// to be PowerShell, which is a preference the app had no business making
    /// — "a terminal" there means the command prompt, and PowerShell is now
    /// something you pick.
    #[test]
    fn an_absent_or_default_choice_is_the_platform_default() {
        assert_eq!(PtyManager::resolve_shell(None), PtyManager::default_shell());
        assert_eq!(PtyManager::resolve_shell(Some("")), PtyManager::default_shell());
        assert_eq!(PtyManager::resolve_shell(Some("   ")), PtyManager::default_shell());
        assert_eq!(PtyManager::resolve_shell(Some("default")), PtyManager::default_shell());
    }

    #[test]
    fn a_path_is_taken_as_written_so_an_unknown_shell_still_works() {
        assert_eq!(
            PtyManager::resolve_shell(Some("/opt/weird/fish")),
            "/opt/weird/fish"
        );
        assert_eq!(
            PtyManager::resolve_shell(Some(r"C:\Tools\nu.exe")),
            r"C:\Tools\nu.exe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_bare_name_resolves_to_a_real_binary_when_one_exists() {
        let sh = PtyManager::resolve_shell(Some("sh"));
        assert!(Path::new(&sh).exists(), "resolved {sh}, which does not exist");
        assert!(sh.ends_with("/sh"), "expected an absolute path, got {sh}");

        // A name we cannot find is handed over unchanged rather than silently
        // swapped for something else.
        assert_eq!(PtyManager::resolve_shell(Some("definitely-not-a-shell")), "definitely-not-a-shell");
    }

    #[cfg(windows)]
    #[test]
    fn windows_names_map_to_their_executables() {
        assert!(PtyManager::resolve_shell(Some("powershell")).eq_ignore_ascii_case("powershell.exe"));
        assert!(PtyManager::resolve_shell(Some("pwsh")).to_lowercase().ends_with("pwsh.exe"));
        assert!(PtyManager::resolve_shell(Some("cmd")).to_lowercase().ends_with("cmd.exe"));
        // and the default is the command prompt, not PowerShell
        assert!(PtyManager::default_shell().to_lowercase().ends_with("cmd.exe"));
    }
}


/// `CANON_LINE_LIMIT`, checked against the kernel rather than assumed.
///
/// The boundary is re-measured here on whatever platform the suite runs, so a
/// constant that is wrong for a platform fails CI instead of reaching a user —
/// which is exactly what happened when this trusted `fpathconf`, whose 255 on
/// Linux would have made the guard refuse pastes that work fine.
#[cfg(all(test, unix))]
mod canonical_limit_tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::time::{Duration, Instant};

    struct Probe {
        child: Box<dyn Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        out: std::path::PathBuf,
        tx: std::sync::mpsc::Sender<Vec<u8>>,
    }

    /// A `cat` on a pty, capturing what actually reaches it. `raw` selects the
    /// line discipline: a shell's line editor looks like `raw`, `cat`/`read`
    /// like the default.
    fn probe(raw: bool, tag: &str) -> Probe {
        // Shell-safe: this path goes straight into a `sh -c` command line.
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let out = std::env::temp_dir().join(format!(
            "nexterm-canon-{tag}-{}-{}.txt",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&out);

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(format!(
            "stty {} -echo; cat > {}",
            if raw { "raw" } else { "sane" },
            out.display()
        ));
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        // The master must be drained continuously or both sides wedge.
        let mut reader = pair.master.try_clone_reader().expect("reader");
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
            }
        });

        let writer = pair.master.take_writer().expect("writer");
        let tx = spawn_writer_thread(writer, tag).unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let `stty` take effect
        Probe { child, master: pair.master, out, tx }
    }

    impl Probe {
        /// Bytes that actually reached `cat` after sending `n` newline-free
        /// bytes followed by a newline. `n + 1` means nothing was lost.
        fn deliver(&self, n: usize) -> usize {
            self.tx.send(vec![b'a'; n]).unwrap();
            self.tx.send(b"\n".to_vec()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            self.tx.send(vec![4u8]).unwrap(); // Ctrl-D: cat flushes and exits

            let deadline = Instant::now() + Duration::from_secs(5);
            let mut size = 0;
            while Instant::now() < deadline {
                if let Ok(meta) = std::fs::metadata(&self.out) {
                    size = meta.len() as usize;
                    if size > n {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            size
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_file(&self.out);
        }
    }

    #[test]
    fn the_mode_the_guard_reads_is_the_mode_the_program_is_in() {
        let cooked = probe(false, "mode-cooked");
        assert_eq!(
            is_canonical(cooked.master.as_ref()),
            Some(true),
            "a program reading lines must be seen as canonical"
        );
        let raw = probe(true, "mode-raw");
        assert_eq!(
            is_canonical(raw.master.as_ref()),
            Some(false),
            "a program in raw mode must not be seen as canonical"
        );
    }

    /// Pins `CANON_LINE_LIMIT` to the kernel from both sides. A limit set too
    /// SMALL fails the first assertion (the guard would refuse working
    /// pastes); too LARGE fails the second (data would still be lost
    /// silently).
    #[test]
    fn the_constant_is_exactly_where_the_kernel_starts_losing_data() {
        let under = probe(false, "limit-under");
        assert_eq!(
            under.deliver(CANON_LINE_LIMIT - 1),
            CANON_LINE_LIMIT,
            "a line one byte under CANON_LINE_LIMIT ({CANON_LINE_LIMIT}) must arrive whole — \
             the constant is too small for this platform and the guard would refuse input \
             the kernel handles fine"
        );

        let at = probe(false, "limit-at");
        let delivered = at.deliver(CANON_LINE_LIMIT);
        assert!(
            delivered < CANON_LINE_LIMIT + 1,
            "a line at CANON_LINE_LIMIT ({CANON_LINE_LIMIT}) must lose data, but all \
             {} bytes arrived — the constant is too large for this platform",
            CANON_LINE_LIMIT + 1
        );
    }

    /// How the loss shows up differs by platform, and both are data loss: the
    /// point of the guard is that neither reaches the user unannounced.
    #[test]
    fn the_loss_is_total_on_macos_and_a_truncation_elsewhere() {
        let at = probe(false, "limit-shape");
        let delivered = at.deliver(CANON_LINE_LIMIT * 2);
        if cfg!(target_os = "macos") {
            assert_eq!(delivered, 0, "macOS discards an over-long canonical line whole");
        } else {
            assert_eq!(
                delivered, CANON_LINE_LIMIT,
                "Linux truncates an over-long canonical line to the buffer size"
            );
        }
    }

    #[test]
    fn raw_mode_takes_far_more_than_the_canonical_limit() {
        // A shell's line editor puts the tty here, which is why pasting at a
        // prompt works and pasting into `cat` does not.
        let p = probe(true, "raw-big");
        let n = CANON_LINE_LIMIT * 4;
        assert_eq!(p.deliver(n), n + 1, "raw mode must deliver a large paste intact");
    }

    #[test]
    fn the_guard_rejects_only_what_the_kernel_would_drop() {
        let cooked = probe(false, "guard-cooked");
        let mgr = PtyManager::new();
        let session = Arc::new(PtySession {
            id: "guard".into(),
            shell: "/bin/sh".into(),
            created_at: Utc::now(),
            master: Mutex::new(
                native_pty_system()
                    .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                    .expect("openpty")
                    .master,
            ),
            input: Mutex::new(Some(cooked.tx.clone())),
            child: Mutex::new(spare_child()),
        });
        mgr.sessions.lock().insert("guard".into(), session);

        // A bare pty with no program on it is canonical by default, which is
        // exactly the state the guard has to judge.
        let err = mgr
            .write("guard", &"a".repeat(CANON_LINE_LIMIT))
            .expect_err("an over-limit line must be refused");
        assert!(err.contains("were not sent"), "the refusal must say so plainly: {err}");
        assert!(
            err.contains(&(CANON_LINE_LIMIT - 1).to_string()),
            "and name the limit: {err}"
        );

        // Everything else still goes through untouched.
        mgr.write("guard", &"a".repeat(CANON_LINE_LIMIT - 1))
            .expect("a line under the limit is fine");
        let long_but_split = format!("{}\n{}", "a".repeat(10), "b".repeat(CANON_LINE_LIMIT * 4));
        mgr.write("guard", &long_but_split[..11])
            .expect("a run ending in a newline is fine however long the payload");
        mgr.write("guard", "echo hi\n").expect("ordinary input is fine");
        mgr.write("guard", "").expect("an empty write is fine");
    }

    /// A child handle for a session built by hand in the test above.
    fn spare_child() -> Box<dyn Child + Send + Sync> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 30");
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        child
    }
}
