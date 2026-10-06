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
use super::startup_query::StartupCursorQuery;
use crate::models::PtyCommandDonePayload;
use crate::models::PtyCommandStartedPayload;
use crate::models::PtyCwdPayload;
use crate::models::PtyTitlePayload;

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
///
/// unix-only, like its one caller: Windows ConPTY has no line discipline, and
/// `#![deny(warnings)]` turns an unused function there into a build failure.
#[cfg(unix)]
fn leading_line_len(data: &[u8]) -> usize {
    data.iter().position(|&b| b == b'\n' || b == b'\r').unwrap_or(data.len())
}

/// The variable OpenTUI reads for the notification protocol to use: `osc99`
/// (kitty's) or `osc9` (iTerm2's).
const OPENTUI_NOTIFICATION_PROTOCOL: &str = "OPENTUI_NOTIFICATION_PROTOCOL";

/// What NexTerm adds to the environment a shell inherits from the app.
///
/// A function of its own so that a test can start a real shell with exactly
/// this environment, which it cannot do through `spawn`: that needs an
/// `AppHandle`.
fn set_session_env(cmd: &mut CommandBuilder) {
    // ConPTY (Windows) ignores TERM/COLORTERM; harmless to set anyway.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("NEXTERM", "1");

    // OpenCode's TUI (OpenTUI) sends a notification only in a protocol it has
    // chosen. It asks the terminal as it starts — kitty's OSC 99 query — and
    // the frontend answers (src/lib/programNotifications.js); with no answer
    // it sends nothing at all. ConPTY may not carry that answer back to the
    // program, so the choice is made here as well, where OpenTUI reads it
    // before asking anything. Only when the shell would not inherit a choice
    // already: one the user made wins.
    if cmd.get_env(OPENTUI_NOTIFICATION_PROTOCOL).is_none() {
        cmd.env(OPENTUI_NOTIFICATION_PROTOCOL, "osc99");
    }

    // Opened from the Finder, the app inherits launchd's environment, which
    // names no locale, and a shell without one runs in C — where bash's
    // readline takes every byte of a Hangul syllable for a Meta key. A UTF-8
    // LANG is added only when the shell would inherit no locale at all, so a
    // user's own always wins. `cmd` already holds the environment the shell
    // will get, so that is where to look. See locale.rs.
    #[cfg(unix)]
    {
        let inherited = |key: &str| cmd.get_env(key).map(std::ffi::OsStr::to_os_string);
        if let Some(lang) = super::locale::lang_for(inherited) {
            cmd.env("LANG", lang);
        }
    }
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
        // Where the shell really starts, reported back in `PtySessionInfo`.
        let mut started_in = None;
        if let Some(dir) = cwd {
            if !dir.trim().is_empty() && Path::new(&dir).is_dir() {
                // A `\\?\` path — as older builds persisted with the layout —
                // is refused by cmd.exe as a UNC path, and it starts in
                // C:\Windows instead.
                let dir = dunce::simplified(Path::new(&dir)).to_path_buf();
                started_in = Some(dir.to_string_lossy().to_string());
                cmd.cwd(dir);
            }
        }
        set_session_env(&mut cmd);
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
        // ConPTY holds the shell back until its opening cursor query is
        // answered (see startup_query.rs). The reader thread answers it through
        // this same input queue, and lets the clone go once the start of the
        // stream is decided so it cannot keep the queue alive.
        let mut startup_query = if cfg!(windows) {
            Some((StartupCursorQuery::default(), input_tx.clone()))
        } else {
            None
        };

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

        let reader_thread = thread::Builder::new()
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
                            let mut released = None;
                            if let Some((query, answer_tx)) = startup_query.as_mut() {
                                let scan = query.feed(&buf[..n]);
                                if let Some(answer) = scan.answer {
                                    let _ = answer_tx.send(answer.to_vec());
                                }
                                released = Some((scan.forward, query.is_done()));
                            }
                            if matches!(released, Some((_, true))) {
                                startup_query = None;
                            }
                            let chunk: &[u8] = match &released {
                                Some((forward, _)) => forward,
                                None => &buf[..n],
                            };
                            if chunk.is_empty() {
                                continue;
                            }
                            let filtered = filter.feed(chunk);
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
                                    // OSC 133 "C": output is about to begin, so
                                    // something is running now. The parser has
                                    // always recognised this marker and the
                                    // backend always dropped it, which left the
                                    // frontend able to say what a command
                                    // finished WITH but never that one was still
                                    // going.
                                    Marker::CommandExecuted => {
                                        let payload = PtyCommandStartedPayload {
                                            session_id: session_id_clone.clone(),
                                        };
                                        let _ = app_handle_clone.emit("pty-command-started", &payload);
                                    }
                                    // A window title, which the output above
                                    // still carries to xterm: reported for the
                                    // agent terminals, whose conversation opencode
                                    // names there (src/lib/agents.js).
                                    Marker::Title(title) => {
                                        let payload = PtyTitlePayload {
                                            session_id: session_id_clone.clone(),
                                            title,
                                        };
                                        let _ = app_handle_clone.emit("pty-title", &payload);
                                    }
                                    // A is the prompt drawing and B is where the
                                    // user's typing begins; neither says anything
                                    // about work being done.
                                    Marker::PromptStart | Marker::CommandStart => {}
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                // The stream ended while bytes were held back as a possible
                // cursor query: they are output like any other.
                if let Some((mut query, _)) = startup_query.take() {
                    let held = query.take_held();
                    if !held.is_empty() {
                        let filtered = filter.feed(&held);
                        if !filtered.output.is_empty() {
                            let payload = PtyOutputPayload {
                                session_id: session_id_clone.clone(),
                                data: filtered.output,
                            };
                            let _ = app_handle_clone.emit("pty-output", &payload);
                        }
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
            });
        if let Err(e) = reader_thread {
            // The session is already in the map, and without a reader it is a
            // live shell nothing can see and nothing will reap until the next
            // reload. The caller gets an error and may well try again — the
            // frontend retries a failed spawn once, at the default directory
            // — so leaving it here would leak one shell per attempt.
            let _ = self.kill(&session_id);
            return Err(format!("Failed to spawn PTY reader thread: {e}"));
        }

        Ok(PtySessionInfo {
            id: session_id.clone(),
            session_id: session_id.clone(),
            shell: shell_path,
            created_at,
            cwd: started_in,
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
            let _ = session.child.lock().kill();
            #[cfg(unix)]
            reap(session);
        }
        Ok(())
    }

    /// Kill every session except the ones named, and report how many went.
    ///
    /// The webview can be reloaded — ⌘R, or Vite replacing a module it cannot
    /// hot-swap — and when it is, the frontend's state starts from nothing
    /// while this map does not. The rebuilt frontend restores its saved layout
    /// by spawning a fresh PTY per tab (the payload stores a title and a
    /// directory, never a session id), so the previous set was left running
    /// with no tab to show it: one leaked shell per reload, forever, measured
    /// as 1 → 2 → 3 → 4 child shells over three reloads with one terminal on
    /// screen.
    ///
    /// NexTerm has a single window, so a session this manager holds that the
    /// starting frontend does not claim belongs to a frontend that no longer
    /// exists. Expressed as "keep exactly these" rather than "kill everything"
    /// so that a frontend which one day reattaches to its old sessions can say
    /// so, instead of this quietly destroying them.
    pub fn retain_only(&self, keep: &[String]) -> usize {
        let doomed: Vec<String> = {
            let sessions = self.sessions.lock();
            sessions
                .keys()
                .filter(|id| !keep.iter().any(|k| k == *id))
                .cloned()
                .collect()
        };
        // `kill` takes the same lock, so the ids are collected before killing.
        for id in &doomed {
            let _ = self.kill(id);
        }
        doomed.len()
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
                cwd: None,
            })
            .collect()
    }
}

/// Wait for a shell `kill` has just killed, so that it does not stay behind
/// as a zombie.
///
/// portable-pty's kill sends SIGHUP, gives the shell 200 ms to go, then sends
/// SIGKILL and returns without waiting. A shell slower than that to die — a
/// HUP trap, a slow zshexit hook — was never waited for: `kill` drops the
/// session, and the reader thread, the only other thing that waits, reaches
/// the child through the session. So it stayed <defunct> until NexTerm
/// exited, one per such tab closed, and `retain_only` did the same on reload.
///
/// After SIGKILL the end comes promptly, but not for a process stuck in the
/// kernel, and `kill` must return regardless — closing a group kills its
/// terminals one after another — so the waiting is done on a thread of its
/// own, holding the session until the shell is gone. A shell that was gone
/// within the grace period has been waited for already, and needs no thread.
///
/// unix-only: Windows has no zombies, and closing the process handle is all
/// a killed process needs there.
#[cfg(unix)]
fn reap(session: Arc<PtySession>) {
    if matches!(session.child.lock().try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = thread::Builder::new()
        .name(format!("pty-reaper-{}", session.id))
        .spawn(move || {
            let _ = session.child.lock().wait();
        });
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

    /// `retain_only` against real spawned shells.
    ///
    /// This is what stops a reloaded webview leaking its terminals, so it is
    /// checked here rather than only through the browser mock — the mock
    /// implements the same contract in JavaScript and could agree with the
    /// tests while disagreeing with this.
    #[test]
    fn retain_only_keeps_what_it_is_told_and_reaps_the_rest() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        // `PtyManager::spawn` needs an AppHandle to emit output events, which
        // a unit test has no way to build — so the sessions are assembled by
        // hand around real shells. `retain_only` is map bookkeeping plus a
        // kill, and both are exercised here.
        let manager = PtyManager::new();
        let spawn = |id: &str| {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .expect("openpty");
            let cmd = CommandBuilder::new(PtyManager::default_shell());
            let child = pair.slave.spawn_command(cmd).expect("a shell must start");
            drop(pair.slave);

            // Everything from here to the reader thread is the part of
            // `PtyManager::spawn` that a hand-assembled session would otherwise
            // skip — and skipping it did not merely make this case
            // unrepresentative, it hung.
            //
            // portable-pty creates the pseudoconsole with
            // PSEUDOCONSOLE_INHERIT_CURSOR, so the first thing ConPTY writes is
            // `ESC[6n` and it then holds the shell back, prompt and input
            // alike, until the terminal answers (see startup_query.rs). With
            // nothing draining the master and nothing answering, the three
            // shells sat blocked behind an output pipe nobody was reading, and
            // dropping their masters at the end of `retain_only` left
            // ClosePseudoConsole waiting on clients that could never finish.
            // The Windows suite stopped dead here: 69 of 70 cases passed and
            // this one never returned, four runs out of four.
            //
            // Answering the query is exactly what the production reader thread
            // does, so doing it here makes the test both terminate AND resemble
            // the thing it is testing.
            let mut reader = pair.master.try_clone_reader().expect("clone the PTY reader");
            let writer = pair.master.take_writer().expect("take the PTY writer");
            let input_tx = spawn_writer_thread(writer, id).expect("writer thread");
            let answer_tx = input_tx.clone();
            thread::Builder::new()
                .name(format!("test-pty-reader-{id}"))
                .spawn(move || {
                    let mut startup_query = if cfg!(windows) {
                        Some(StartupCursorQuery::default())
                    } else {
                        None
                    };
                    let mut buf = [0u8; 4096];
                    // The bytes are of no interest; draining them is the point.
                    while let Ok(n) = reader.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        if let Some(query) = startup_query.as_mut() {
                            if let Some(answer) = query.feed(&buf[..n]).answer {
                                let _ = answer_tx.send(answer.to_vec());
                            }
                            if query.is_done() {
                                startup_query = None;
                            }
                        }
                    }
                })
                .expect("reader thread");

            manager.sessions.lock().insert(
                id.to_string(),
                Arc::new(PtySession {
                    id: id.to_string(),
                    shell: PtyManager::default_shell(),
                    created_at: Utc::now(),
                    master: Mutex::new(pair.master),
                    // As in production: `kill` drops this, which is what ends
                    // the writer thread.
                    input: Mutex::new(Some(input_tx)),
                    child: Mutex::new(child),
                }),
            );
            id.to_string()
        };

        let a = spawn("pty-a");
        let b = spawn("pty-b");
        let c = spawn("pty-c");
        assert_eq!(manager.list_sessions().len(), 3);

        let reaped = manager.retain_only(&[b.clone()]);
        assert_eq!(reaped, 2, "it reports how many it killed");

        let left: Vec<String> = manager.list_sessions().into_iter().map(|s| s.session_id).collect();
        assert_eq!(left, vec![b.clone()], "only the named session survives");
        assert!(!left.contains(&a));
        assert!(!left.contains(&c));

        // Naming a session that is already gone kills nothing and is not an
        // error: a frontend may legitimately ask to keep what it had.
        assert_eq!(manager.retain_only(&[b.clone(), a.clone()]), 0);
        assert_eq!(manager.list_sessions().len(), 1);

        // And the empty list — what `bootstrap` sends — clears everything.
        assert_eq!(manager.retain_only(&[]), 1);
        assert!(manager.list_sessions().is_empty());
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

        // and the bytes really do get written, in the background.
        //
        // Waited for, not slept through. Three 400ms writes run one after the
        // other, so a fixed 1500ms sleep left 300ms of margin for everything
        // else on the machine — and a loaded CI runner ate it (2 of 3 writes
        // done, macOS, 2026-09-20). Polling is also faster when nothing is
        // wrong, which is nearly always.
        let deadline = Instant::now() + Duration::from_secs(20);
        while finished.load(AtomicOrdering::SeqCst) < 3 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            writes.load(AtomicOrdering::SeqCst),
            3,
            "the writer thread never picked up all three"
        );
        assert_eq!(
            finished.load(AtomicOrdering::SeqCst),
            3,
            "three queued writes did not all complete within 20s"
        );
    }

    /// The unit tests above use a fake writer; this one drives a real shell
    /// through the real queue, because the whole input path was rewritten.
    ///
    /// On Windows that shell is cmd.exe behind ConPTY, which runs nothing until
    /// its opening cursor query is answered. The test answers it with the same
    /// `StartupCursorQuery` the reader thread in `spawn` uses, so breaking that
    /// shows up here as a shell that never echoes anything.
    #[test]
    fn a_real_shell_receives_queued_input() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        #[cfg(unix)]
        let (shell, enter) = ("/bin/sh".to_string(), "\n");
        #[cfg(windows)]
        let (shell, enter) = (PtyManager::default_shell(), "\r");

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("PS1", "");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn shell");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = pair.master.take_writer().expect("writer");
        let tx = spawn_writer_thread(writer, "test-real").unwrap();

        tx.send(format!("echo nexterm-queue-ok{enter}").into_bytes()).unwrap();
        tx.send(format!("exit{enter}").into_bytes()).unwrap();

        let mut startup_query = StartupCursorQuery::default();
        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = [0u8; 1024];
        while Instant::now() < deadline && !seen.contains("nexterm-queue-ok") {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let scan = startup_query.feed(&buf[..n]);
                    if let Some(answer) = scan.answer {
                        tx.send(answer.to_vec()).unwrap();
                    }
                    seen.push_str(&String::from_utf8_lossy(&scan.forward));
                }
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

/// What `kill` leaves behind. A shell that is killed has to be waited for, or
/// it stays in the process table as a zombie until NexTerm exits.
#[cfg(all(test, unix))]
mod kill_tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::time::{Duration, Instant};

    /// Whether `pid` is in the process table at all — running, or dead and
    /// never waited for.
    fn in_process_table(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 delivers nothing; it only asks whether the
        // process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// portable-pty's kill sends SIGHUP, gives the shell 200 ms, then sends
    /// SIGKILL and returns without waiting. A shell slower than that to die
    /// — a HUP trap, a slow zshexit — was never waited for: `kill` dropped
    /// the session, so the reader thread could no longer reach the child to
    /// wait on it either.
    #[test]
    fn a_shell_that_outlives_the_hangup_is_still_reaped() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        // Ignores the hangup, then becomes `sleep`, which keeps ignoring it:
        // only the SIGKILL after the grace period ends it.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "trap '' HUP; echo hangup-ignored; exec sleep 30"]);
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let pid = child.process_id().expect("a pid") as libc::pid_t;

        // A hangup that arrived before the trap was set would end the shell
        // at once, and prove nothing.
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (ready_tx, ready) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut seen = String::new();
            let mut buf = [0u8; 256];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                if seen.contains("hangup-ignored") {
                    let _ = ready_tx.send(());
                    seen.clear();
                }
            }
        });
        ready.recv_timeout(Duration::from_secs(10)).expect("the shell never got going");

        let writer = pair.master.take_writer().expect("writer");
        let manager = PtyManager::new();
        manager.sessions.lock().insert(
            "slow".into(),
            Arc::new(PtySession {
                id: "slow".into(),
                shell: "/bin/sh".into(),
                created_at: Utc::now(),
                master: Mutex::new(pair.master),
                input: Mutex::new(Some(spawn_writer_thread(writer, "slow").unwrap())),
                child: Mutex::new(child),
            }),
        );

        let started = Instant::now();
        manager.kill("slow").unwrap();
        // `pty_kill` is off the IPC thread, but closing a group kills its
        // terminals one after another: the wait must not be `kill`'s.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "kill took {:?} — it waited for the shell itself",
            started.elapsed()
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        while in_process_table(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !in_process_table(pid),
            "pid {pid} is still in the process table: killed, but never waited for"
        );
    }
}

/// The notification protocol OpenCode is told to use, set up by the same code
/// `spawn` uses — on every platform: the variable is there for ConPTY.
#[cfg(test)]
mod session_env_tests {
    use super::*;
    use portable_pty::CommandBuilder;

    fn value(cmd: &CommandBuilder, key: &str) -> Option<String> {
        cmd.get_env(key).map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn opencode_is_told_to_notify_with_osc_99() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.env_remove(OPENTUI_NOTIFICATION_PROTOCOL);
        set_session_env(&mut cmd);
        assert_eq!(value(&cmd, "OPENTUI_NOTIFICATION_PROTOCOL").as_deref(), Some("osc99"));
    }

    #[test]
    fn a_protocol_the_shell_inherits_is_left_exactly_as_it_is() {
        // Empty is a choice too: the user unset OpenTUI's guess, not NexTerm.
        for inherited in ["osc9", "osc99", "", "something-newer"] {
            let mut cmd = CommandBuilder::new("sh");
            cmd.env("OPENTUI_NOTIFICATION_PROTOCOL", inherited);
            set_session_env(&mut cmd);
            assert_eq!(
                value(&cmd, "OPENTUI_NOTIFICATION_PROTOCOL").as_deref(),
                Some(inherited),
                "OPENTUI_NOTIFICATION_PROTOCOL={inherited:?} did not survive"
            );
        }

        // Windows does not care how a variable's name is cased, so a name the
        // user spelt in lower case is the same variable, and wins the same way.
        #[cfg(windows)]
        {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.env_remove(OPENTUI_NOTIFICATION_PROTOCOL);
            cmd.env("opentui_notification_protocol", "osc9");
            set_session_env(&mut cmd);
            assert_eq!(value(&cmd, "OPENTUI_NOTIFICATION_PROTOCOL").as_deref(), Some("osc9"));
        }
    }
}

/// The locale a shell starts with, set up by the same code `spawn` uses.
///
/// An app opened from the Finder inherits launchd's environment, which names
/// no locale at all. These reproduce that by taking every locale variable out
/// of the test's own environment first — which on a developer's machine is
/// anything but empty.
#[cfg(all(test, unix))]
mod locale_tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// `program`, with no locale variable in its environment.
    fn without_a_locale(program: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(program);
        for (key, _) in locale_vars(&cmd) {
            cmd.env_remove(key);
        }
        cmd
    }

    /// Every locale variable `cmd` would start the program with.
    fn locale_vars(cmd: &CommandBuilder) -> Vec<(String, String)> {
        cmd.iter_full_env_as_str()
            .filter(|(key, _)| *key == "LANG" || key.starts_with("LC_"))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn a_shell_that_inherits_no_locale_is_given_lang_and_nothing_else() {
        let mut cmd = without_a_locale("/bin/sh");
        set_session_env(&mut cmd);
        let vars = locale_vars(&cmd);
        // LANG is the weakest of the three, so a locale set by the user's own
        // rc files still wins over it.
        assert_eq!(vars.len(), 1, "expected LANG alone, got {vars:?}");
        let (key, value) = &vars[0];
        assert_eq!(key, "LANG");
        assert!(value.ends_with(".UTF-8"), "LANG={value}");
    }

    #[test]
    fn a_locale_the_shell_inherits_is_left_exactly_as_it_is() {
        for (key, value) in [
            ("LANG", "C"),
            ("LANG", "en_KR.UTF-8"),
            ("LC_CTYPE", "UTF-8"),
            ("LC_ALL", "ko_KR.UTF-8"),
        ] {
            let mut cmd = without_a_locale("/bin/sh");
            cmd.env(key, value);
            set_session_env(&mut cmd);
            assert_eq!(
                locale_vars(&cmd),
                vec![(key.to_string(), value.to_string())],
                "{key}={value} did not survive"
            );
        }
    }

    /// Output from the pty until `done` is satisfied; false if the deadline
    /// passes or the shell goes away first.
    fn read_until(
        output: &mpsc::Receiver<Vec<u8>>,
        seen: &mut String,
        deadline: Instant,
        done: impl Fn(&str) -> bool,
    ) -> bool {
        while !done(seen) {
            let left = deadline.saturating_duration_since(Instant::now());
            match output.recv_timeout(left) {
                Ok(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => return false,
            }
        }
        true
    }

    /// One line for bash to run. Each answer comes out as `name=value`, which
    /// the echoed command line never contains, so the echo cannot be read as
    /// an answer. `\355\225\234` is 한 in UTF-8: one character in a UTF-8
    /// locale, three in C.
    const PROBE: &str = r#"printf '%s=%s\n' meta "$(bind -v | grep convert-meta)" chars "$(x=$(printf '\355\225\234'); echo ${#x})" ctype "$(locale | grep LC_CTYPE)" lang "$LANG""#;

    /// The defect itself, in a real bash on a real pty. Started without a
    /// locale, readline took every byte above 0x7f for a Meta key, so Hangul
    /// typed at the prompt, or brought back from history, ran key bindings
    /// instead of appearing.
    #[test]
    fn bash_started_without_a_locale_reads_non_ascii_as_text() {
        let Some(bash) = ["/bin/bash", "/usr/bin/bash"]
            .into_iter()
            .find(|path| Path::new(path).exists())
        else {
            eprintln!("bash not installed; skipping");
            return;
        };

        let mut cmd = without_a_locale(bash);
        // No rc files: the user's own could set a locale, and what is on
        // trial is the one the shell is started with.
        cmd.args(["--norc", "--noprofile", "-i"]);
        // readline's own configuration can turn convert-meta off by itself —
        // Debian's /etc/inputrc does — which would pass this for the wrong
        // reason.
        cmd.env("INPUTRC", "/dev/null");
        cmd.env("PS1", "nexterm-ready> ");
        // macOS's bash 3.2 otherwise opens with a paragraph about zsh.
        cmd.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
        set_session_env(&mut cmd);
        let lang = cmd.get_env("LANG").map(|v| v.to_string_lossy().into_owned());

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 500, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn bash");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let prompts = |seen: &str| seen.matches("nexterm-ready> ").count();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = String::new();
        // A line typed before readline is listening can be lost, so the probe
        // waits for the first prompt, and the answers for the second.
        let ready = read_until(&output, &mut seen, deadline, |s| prompts(s) >= 1);
        if ready {
            writer.write_all(format!("{PROBE}\n").as_bytes()).expect("type the probe");
            read_until(&output, &mut seen, deadline, |s| prompts(s) >= 2);
        }
        let _ = child.kill();
        let _ = child.wait();

        assert!(ready, "bash never showed a prompt; it printed {seen:?}");
        let answer = |name: &str| -> Option<String> {
            let rest = &seen[seen.find(name)? + name.len()..];
            Some(rest[..rest.find(['\r', '\n']).unwrap_or(rest.len())].to_string())
        };
        let (meta, chars, ctype) = (answer("meta="), answer("chars="), answer("ctype="));
        let report = format!(
            "LANG given: {lang:?}; bash said meta={meta:?} chars={chars:?} ctype={ctype:?}"
        );
        assert_eq!(
            meta.as_deref(),
            Some("set convert-meta off"),
            "readline still turns bytes above 0x7f into Meta keys — {report}"
        );
        assert_eq!(chars.as_deref(), Some("1"), "bash is not reading UTF-8 — {report}");
        assert!(
            ctype.as_deref().is_some_and(|c| c.contains("UTF-8") || c.contains("utf8")),
            "LC_CTYPE is not UTF-8 — {report}"
        );
        assert!(lang.is_some(), "the shell was given no LANG — {report}");
        assert_eq!(answer("lang="), lang, "the shell's LANG is not the one it was given — {report}");
    }
}
