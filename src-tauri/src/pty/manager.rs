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
use super::flow_gate::FlowGate;
use super::output_batch::{self, Batcher, Outgoing};
use super::shell_integration;
use super::startup_query::StartupCursorQuery;
use crate::models::PtyCommandDonePayload;
use crate::models::PtyCommandStartedPayload;
use crate::models::PtyCwdPayload;
use crate::models::PtyTitlePayload;

use crate::models::{PtyExitPayload, PtyOutputPayload, PtySessionInfo};
use crate::control::{self, Control, SessionEnv};

pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub created_at: chrono::DateTime<Utc>,
    /// The pty itself. `None` once its console has been closed because the
    /// shell exited (Windows, see `watch_for_exit`): it is only resized
    /// through here, and a closed console has nothing left to resize.
    pub master: Mutex<Option<Box<dyn MasterPty + Send>>>,
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
    /// How far behind the page is with this session's output, and the hold
    /// on its reader when it is too far (flow_gate.rs).
    pub flow: Arc<FlowGate>,
}

impl PtySession {
    /// Let the pty go — on Windows that is `ClosePseudoConsole`, which ends
    /// the console host and with it the output pipe the reader is reading.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn close_console(&self) {
        let master = self.master.lock().take();
        drop(master);
    }
}

/// Windows: close the console once the shell in it has exited, so that the
/// end is seen at all.
///
/// The end of a session is its output pipe ending: the reader thread then
/// waits for the exit code and emits `pty-exit`. On Windows 10 the pipe does
/// not end with the shell. The headless console host keeps it open until
/// `ClosePseudoConsole` — and that is called when the pty is dropped, which
/// happens when the session is, which happens after `pty-exit`. So a shell
/// that exited was never reported: no exit code, no "Press Enter to start a
/// new shell", the row still "Running", keys going nowhere — and the console
/// host stayed alive, through the app's own exit too (V26).
///
/// The shell's process is waited for on a thread of its own, through a
/// duplicate of its handle, so the child stays free for `kill` and for the
/// reader's own `wait`. When it ends, the console is closed; the pipe then
/// ends and the reader reports the exit as on every other platform. A console
/// host that ends the pipe by itself only makes the close come second.
///
/// Closing the console also ends whatever is still attached to it: a server
/// cmd started with `start /b`, a job Git Bash left running with `&`. Their
/// output stops with the shell's, where on macOS and Linux the session lasts
/// until they finish. Windows Terminal does the same when its shell exits.
#[cfg(windows)]
fn watch_for_exit(session: &Arc<PtySession>) -> std::io::Result<()> {
    use std::os::windows::io::{AsRawHandle, BorrowedHandle, OwnedHandle};
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};

    let process: OwnedHandle = {
        let child = session.child.lock();
        let raw = child
            .as_raw_handle()
            .ok_or_else(|| std::io::Error::other("the shell has no process handle"))?;
        // SAFETY: `raw` is the child's process handle, open for as long as
        // the child is — and the child is held, locked, while it is copied.
        unsafe { BorrowedHandle::borrow_raw(raw) }.try_clone_to_owned()?
    };
    let watched = Arc::downgrade(session);
    thread::Builder::new()
        .name(format!("pty-exit-watch-{}", session.id))
        .spawn(move || {
            // SAFETY: a process handle this thread owns, open until it returns.
            unsafe { WaitForSingleObject(process.as_raw_handle() as _, INFINITE) };
            if let Some(session) = watched.upgrade() {
                session.close_console();
            }
        })?;
    Ok(())
}

/// One `pty-output` event — counted, and its emit timed, when the app is
/// being measured (src/perf.rs).
fn emit_output(app: &AppHandle, session_id: &str, data: String) {
    let started = crate::perf::emit_started();
    let bytes = data.len();
    let payload = PtyOutputPayload {
        session_id: session_id.to_string(),
        bytes: bytes as u64,
        data,
    };
    let _ = app.emit("pty-output", &payload);
    crate::perf::note_emit(started, bytes);
}

/// A marker the OSC filter found, as the event the frontend listens for.
fn emit_marker(app: &AppHandle, session_id: &str, marker: Marker) {
    let session_id = session_id.to_string();
    match marker {
        Marker::CommandFinished(exit_code) => {
            let _ = app.emit("pty-command-done", &PtyCommandDonePayload { session_id, exit_code });
        }
        Marker::WorkingDirectory(cwd) => {
            let _ = app.emit("pty-cwd", &PtyCwdPayload { session_id, cwd });
        }
        // OSC 133 "C": output is about to begin, so something is running
        // now. The parser has always recognised this marker and the backend
        // always dropped it, which left the frontend able to say what a
        // command finished WITH but never that one was still going.
        Marker::CommandExecuted => {
            let _ = app.emit("pty-command-started", &PtyCommandStartedPayload { session_id });
        }
        // A window title, which the output before it still carries to xterm:
        // reported for the agent terminals, whose conversation opencode names
        // there (src/lib/agents.js).
        Marker::Title(title) => {
            let _ = app.emit("pty-title", &PtyTitlePayload { session_id, title });
        }
        // A is the prompt drawing and B is where the user's typing begins;
        // neither says anything about work being done.
        Marker::PromptStart | Marker::CommandStart => {}
    }
}

/// The reader's loop, from the PTY to the sender's queue (`outgoing`), up to
/// the end of the stream — apart from `spawn` so the suites can drive it with
/// a real PTY and no page.
///
/// Per read, in this order: wait while the page is too far behind
/// (flow_gate.rs); on Windows, hold the opening cursor query and answer it
/// (startup_query.rs); tell the password watch output came (`read_seen`);
/// strip OSC 133/7 into markers, holding a split escape or UTF-8 character
/// (osc.rs); queue the output, then that read's markers after it. At the end
/// of the stream, what was held back as a possible query is output like any
/// other, and a character cut in half is sent as it is rather than held for
/// ever.
///
/// Output is counted against flow control as it is queued, not as it is
/// sent: what waits between this thread and the sender's is as unread by the
/// page as what waits in the page, and counted later it let the reader run
/// ahead of a sender stuck emitting with nothing to stop it (found in
/// review). Counted before the page can possibly have it, so an
/// acknowledgement never arrives ahead of its count; the sender's batches
/// are the same bytes joined, so the page acknowledges exactly this.
///
/// Returns how many times flow control held the reader.
fn pump_output(
    reader: &mut dyn Read,
    flow: &FlowGate,
    startup_query: &mut Option<(StartupCursorQuery, std::sync::mpsc::Sender<Vec<u8>>)>,
    mut read_seen: impl FnMut(),
    outgoing: &std::sync::mpsc::Sender<Outgoing>,
) -> usize {
    let queue = |text: String| {
        flow.sent(text.len() as u64);
        // No sender any more (its thread gone): nothing this session queued
        // will ever be acknowledged — what was waiting in it included — so
        // flow control has nothing left to wait for. Closed, it never holds
        // this reader again, and the shell runs on to its exit (review: an
        // acknowledgement back cleared the stall and stranded the rest).
        if outgoing.send(Outgoing::Output(text)).is_err() {
            flow.close();
        }
    };
    let mut held = 0;
    let mut buf = [0u8; 4096];
    // Strips OSC 133 markers (everything else is forwarded verbatim) and tells us
    // when a command finished (see osc.rs / shell_integration.rs).
    let mut filter = OscFilter::new();
    loop {
        // The page too far behind: read nothing until it catches
        // up, and let the program wait in its write (flow_gate.rs).
        let hold = crate::perf::emit_started();
        if flow.wait_for_room() {
            held += 1;
            crate::perf::note_hold(hold);
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                crate::perf::note_read(n);
                let mut released = None;
                if let Some((query, answer_tx)) = startup_query.as_mut() {
                    let scan = query.feed(&buf[..n]);
                    if let Some(answer) = scan.answer {
                        let _ = answer_tx.send(answer.to_vec());
                    }
                    released = Some((scan.forward, query.is_done()));
                }
                if matches!(released, Some((_, true))) {
                    *startup_query = None;
                }
                let chunk: &[u8] = match &released {
                    Some((forward, _)) => forward,
                    None => &buf[..n],
                };
                if chunk.is_empty() {
                    continue;
                }
                // One flag per chunk; the watch does the rest.
                read_seen();
                let filtered = filter.feed(chunk);
                if !filtered.output.is_empty() {
                    queue(filtered.output);
                }
                // After the output they came with, in the same queue:
                // the sender keeps them in order (output_batch.rs).
                for marker in filtered.markers {
                    let _ = outgoing.send(Outgoing::Marker(marker));
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
                queue(filtered.output);
            }
        }
    }

    // The shell died mid-character: emit the bytes verbatim rather
    // than holding them forever.
    let tail = filter.take_utf8_tail();
    if !tail.is_empty() {
        queue(String::from_utf8_lossy(&tail).to_string());
    }
    held
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
///
/// `control` is what the control API gives this shell (src/control/), or
/// `None` while the API is off:
/// - `NEXTERM_CONTROL`: the socket's path, or the pipe's name on Windows;
/// - `NEXTERM_CONTROL_TOKEN`: this shell's token;
/// - `NEXTERM_CLI`: the CLI's absolute path, when it is beside the app: the
///   link to it (a copy on Windows) in a folder of NexTerm's that holds only
///   it — and that folder put in front of `PATH`, so that `nexterm-cli` is
///   found by name and nothing else comes with it (src/control/cli.rs). If
///   there is no such folder, the real CLI, and `PATH` left alone;
/// - Windows: `WSLENV` gains `NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN`, so that
///   a WSL shell started from this one has them too, and `nexterm-cli.exe`
///   works from there through interop.
///
/// None of the three is ever inherited: a NexTerm started from inside
/// another's terminal (`tauri dev`, say) would otherwise hand its shells the
/// other's address and token, and with the API off they would talk to it.
fn set_session_env(cmd: &mut CommandBuilder, control: Option<&SessionEnv>) {
    // ConPTY (Windows) ignores TERM/COLORTERM; harmless to set anyway.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("NEXTERM", "1");

    for key in [control::ENV_ADDRESS, control::ENV_TOKEN, control::ENV_CLI] {
        cmd.env_remove(key);
    }
    if let Some(env) = control {
        cmd.env(control::ENV_ADDRESS, &env.address);
        cmd.env(control::ENV_TOKEN, &env.token);
        if let Some(cli) = &env.cli {
            cmd.env(control::ENV_CLI, cli);
        }
        if let Some(path) = env.path_dir.as_deref().and_then(|dir| control::path_with(dir, cmd.get_env("PATH"))) {
            cmd.env("PATH", path);
        }
        #[cfg(windows)]
        {
            let wslenv = cmd.get_env("WSLENV").map(|v| v.to_string_lossy().into_owned());
            cmd.env("WSLENV", control::wslenv_with(wslenv.as_deref()));
        }
    }

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
    /// Every window minimised: flow control lets the page fall much further
    /// behind (flow_gate.rs, AWAY_HIGH_WATER). Kept by main.rs.
    away: Arc<std::sync::atomic::AtomicBool>,
    /// The control API, which gives every shell a token as it starts and
    /// forgets it as its session ends (src/control/). `None` in the tests
    /// that need no API.
    control: Option<Arc<Control>>,
}

/// A token issued for a shell that has not started yet: taken back unless
/// the session gets as far as the map, from where `kill` and the end of
/// the session take it back instead.
struct IssuedToken<'a> {
    control: Option<&'a Control>,
    session_id: &'a str,
}

impl IssuedToken<'_> {
    fn kept(mut self) {
        self.control = None;
    }
}

impl Drop for IssuedToken<'_> {
    fn drop(&mut self) {
        if let Some(control) = self.control {
            control.revoke(self.session_id);
        }
    }
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
            away: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            control: None,
        }
    }

    /// Every shell given a token of `control`'s.
    pub fn with_control(mut self, control: Arc<Control>) -> Self {
        self.control = Some(control);
        self
    }

    /// Whether every window is minimised (main.rs watches).
    pub fn set_away(&self, away: bool) {
        self.away.store(away, Ordering::Relaxed);
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
        let control_env = self.control.as_ref().and_then(|c| c.issue(&session_id));
        let issued = IssuedToken { control: self.control.as_deref().filter(|_| control_env.is_some()), session_id: &session_id };
        set_session_env(&mut cmd, control_env.as_ref());
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
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input_tx)),
            child: Mutex::new(child),
            flow: Arc::new(crate::perf::flow_gate().with_away(self.away.clone(), super::flow_gate::AWAY_HIGH_WATER)),
        });

        self.sessions
            .lock()
            .insert(session_id.clone(), session.clone());
        // From here on the session ends through `kill` or its reader below,
        // and each takes the token back.
        issued.kept();

        let session_id_clone = session_id.clone();
        let control_clone = self.control.clone();
        let app_handle_clone = app_handle.clone();
        let sessions_map_clone = self.sessions.clone();
        let session_weak = Arc::downgrade(&session);

        // Whether the terminal is asking for a password (spec P4): read from
        // the line discipline after output, at most every 250 ms, on a thread
        // of its own; `pty-echo` only when it changes. See echo_watch.rs —
        // and why there is nothing of the kind on Windows.
        #[cfg(unix)]
        let echo_watch = {
            let probed = Arc::downgrade(&session);
            let told = app_handle.clone();
            let id = session_id.clone();
            super::echo_watch::EchoWatch::start(
                format!("pty-echo-{session_id}"),
                super::echo_watch::ECHO_CHECK_INTERVAL,
                move || {
                    let session = probed.upgrade()?;
                    let master = session.master.lock();
                    super::echo_watch::input_hidden(master.as_deref()?)
                },
                move |secret| {
                    let payload = crate::models::PtyEchoPayload { session_id: id.clone(), secret };
                    let _ = told.emit("pty-echo", &payload);
                },
            )
            .map_err(|e| format!("Failed to spawn PTY echo watch thread: {e}"))
        };
        #[cfg(unix)]
        let echo_watch = match echo_watch {
            Ok(watch) => watch,
            Err(e) => {
                // As for the reader below: no shell left behind unseen.
                let _ = self.kill(&session_id);
                return Err(e);
            }
        };

        // The output goes to the page from a thread of its own, batched while
        // it flows (output_batch.rs): one event per read was one script for
        // the page per kilobyte.
        let (outgoing, outgoing_rx) = std::sync::mpsc::channel::<Outgoing>();
        let emitter = {
            let app = app_handle.clone();
            let id = session_id.clone();
            thread::Builder::new()
                .name(format!("pty-emit-{session_id}"))
                .spawn(move || {
                    let batcher = Batcher::new(crate::perf::batch_window(), output_batch::DEFAULT_MAX);
                    // Already counted by the reader, when it queued it
                    // (`pump_output`).
                    output_batch::run_emitter(outgoing_rx, batcher, |item| match item {
                        Outgoing::Output(data) => emit_output(&app, &id, data),
                        Outgoing::Marker(marker) => emit_marker(&app, &id, marker),
                    });
                })
                .map_err(|e| format!("Failed to spawn PTY output thread: {e}"))
        };
        let emitter = match emitter {
            Ok(emitter) => emitter,
            Err(e) => {
                let _ = self.kill(&session_id);
                return Err(e);
            }
        };

        let reader_flow = session.flow.clone();
        let reader_thread = thread::Builder::new()
            .name(format!("pty-reader-{session_id}"))
            .spawn(move || {
                #[cfg(unix)]
                let read_seen = || echo_watch.output();
                #[cfg(not(unix))]
                let read_seen = || {};
                let _ = pump_output(&mut *reader, &reader_flow, &mut startup_query, read_seen, &outgoing);

                // Everything read is with the sender: let it send what it
                // still holds, and only then say the shell is gone.
                drop(outgoing);
                let _ = emitter.join();

                let exit_code = if let Some(session_arc) = session_weak.upgrade() {
                    let mut child = session_arc.child.lock();
                    child.wait().ok().map(|status| status.exit_code())
                } else {
                    None
                };

                // A terminal that ends on a password prompt is told it is not
                // one any more — before it is told it ended.
                #[cfg(unix)]
                echo_watch.finish();

                // The session is over: its token with it, before the page
                // hears of the end and perhaps starts a new shell.
                if let Some(control) = &control_clone {
                    control.revoke(&session_id_clone);
                }

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
        // Windows: the shell's exit is seen only once its console is closed.
        // The same as a failed reader: a shell whose end nobody will see.
        #[cfg(windows)]
        if let Err(e) = watch_for_exit(&session) {
            let _ = self.kill(&session_id);
            return Err(format!("Failed to watch the shell for its exit: {e}"));
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
                        master.as_deref().and_then(is_canonical)
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

    /// Whether the program reading `session_id`'s terminal has its typing
    /// hidden right now — a password prompt (spec P4) — read from the line
    /// discipline there and then (echo_watch.rs). `Ok(None)` where that
    /// cannot be told: an unreadable mode, and Windows, where a ConPTY host
    /// cannot read its client's console mode at all. An unknown session is
    /// an error.
    ///
    /// The typing guard asks this right before it types on the user's
    /// behalf, so a prompt the events have not told it of yet — the watch
    /// reads at most every 250 ms — still stops it.
    pub fn input_hidden(&self, session_id: &str) -> Result<Option<bool>, String> {
        let session = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("PTY session not found: {session_id}"))?
        };
        #[cfg(unix)]
        {
            let master = session.master.lock();
            Ok(master.as_deref().and_then(super::echo_watch::input_hidden))
        }
        #[cfg(not(unix))]
        {
            drop(session);
            Ok(None)
        }
    }

    /// Whether every program in the foreground of `session_id`'s terminal
    /// runs as this user (owner.rs): on unix every member of its foreground
    /// process group, on Windows the shell and everything it started.
    /// `Some(false)` for `sudo`, `su`, `login`, `gsudo` or the shells they
    /// started, and for anything that cannot be read; `None` only on Windows
    /// when no process snapshot can be taken (or the shell has no id). An
    /// unknown session is an error. What the page asks before a control
    /// `send` types (`pty_foreground_owner`).
    pub fn foreground_owner(&self, session_id: &str) -> Result<Option<bool>, String> {
        let session = {
            let sessions = self.sessions.lock();
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("PTY session not found: {session_id}"))?
        };
        #[cfg(unix)]
        {
            let group = session.master.lock().as_deref().and_then(|m| m.process_group_leader());
            // SAFETY: geteuid cannot fail.
            Ok(Some(super::owner::foreground_runs_as(group, unsafe { libc::geteuid() })))
        }
        #[cfg(windows)]
        {
            let shell = session.child.lock().process_id();
            Ok(shell.and_then(super::owner::descendants_run_as_us))
        }
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
        // Closed because its shell exited: nothing left to resize.
        let Some(master) = master.as_ref() else {
            return Ok(());
        };
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

    /// The page has read `bytes` more of `session_id`'s output (flow_gate.rs).
    /// A session already gone is nothing to tell.
    pub fn ack(&self, session_id: &str, bytes: u64) {
        let session = self.sessions.lock().get(session_id).cloned();
        if let Some(session) = session {
            session.flow.acked(bytes);
        }
    }

    /// A new page: every session starts counting afresh, what the old page
    /// was sent and never read with it.
    pub fn flow_reset(&self) {
        let sessions: Vec<_> = self.sessions.lock().values().cloned().collect();
        for session in sessions {
            session.flow.reset();
        }
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        // Its token goes first, whatever is left of the session.
        if let Some(control) = &self.control {
            control.revoke(session_id);
        }
        let session = self.sessions.lock().remove(session_id);
        if let Some(session) = session {
            // Close the input queue first so the writer thread is not left
            // blocked on a write to a shell that is about to die.
            *session.input.lock() = None;
            // A reader held for a page that is behind has nothing to wait for.
            session.flow.close();
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

    /// A killed session's token goes with it — even one `kill` finds no
    /// session for any more (its reader ended it first, or it never got as
    /// far as the map).
    #[test]
    fn killing_a_session_takes_its_token_back_and_no_other() {
        let control = Arc::new(Control::new(None));
        let manager = PtyManager::new().with_control(control.clone());
        let mine = control.token_for_test("pty-1");
        let other = control.token_for_test("pty-2");
        manager.kill("pty-1").unwrap();
        assert!(!control.knows(&mine));
        assert!(control.knows(&other));
    }

    /// A token issued for a shell that never got as far as the map is taken
    /// back as the guard goes; one kept is not.
    #[test]
    fn a_token_for_a_shell_that_failed_to_start_is_taken_back() {
        let control = Control::new(None);
        let failed = control.token_for_test("pty-1");
        drop(IssuedToken { control: Some(&control), session_id: "pty-1" });
        assert!(!control.knows(&failed));
        let started = control.token_for_test("pty-2");
        IssuedToken { control: Some(&control), session_id: "pty-2" }.kept();
        assert!(control.knows(&started));
    }

    /// The other ways a session's token goes, read from `spawn` itself:
    /// a shell that fails to start (`IssuedToken`, until the session is in
    /// the map) and a session that ends (its reader, before `pty-exit`).
    /// `spawn` needs an AppHandle, which a unit test cannot build.
    #[test]
    fn spawn_takes_the_token_back_on_failure_and_at_the_end() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("pty").join("manager.rs"),
        )
        .unwrap();
        let body = &src[src.find("    pub fn spawn(").expect("spawn is gone")..];
        let body = &body[..body.find("\n    pub fn write(").expect("write is gone")];
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("spawn no longer has {needle:?}"));
        assert!(at("c.issue(&session_id)") < at("set_session_env(&mut cmd, control_env.as_ref())"));
        assert!(at("let issued = IssuedToken { control: self.control.as_deref()") < at("set_session_env(&mut cmd, control_env.as_ref())"));
        // Kept only once the session is where `kill` will find it.
        assert!(at(".insert(session_id.clone(), session.clone())") < at("issued.kept()"));
        assert!(at("issued.kept()") < at("let reader_thread"));
        // And taken back as the session ends, before the page is told.
        assert!(at("control.revoke(&session_id_clone)") < at("emit(\"pty-exit\""));
        assert!(at("let reader_thread") < at("control.revoke(&session_id_clone)"));
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
        let control = Arc::new(Control::new(None));
        let manager = PtyManager::new().with_control(control.clone());
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
                    master: Mutex::new(Some(pair.master)),
                    // As in production: `kill` drops this, which is what ends
                    // the writer thread.
                    input: Mutex::new(Some(input_tx)),
                    child: Mutex::new(child),
                    flow: Arc::new(FlowGate::default()),
                }),
            );
            id.to_string()
        };

        let a = spawn("pty-a");
        let b = spawn("pty-b");
        let c = spawn("pty-c");
        assert_eq!(manager.list_sessions().len(), 3);
        let [token_a, token_b, token_c] = [&a, &b, &c].map(|id| control.token_for_test(id));

        let reaped = manager.retain_only(&[b.clone()]);
        assert_eq!(reaped, 2, "it reports how many it killed");
        // A reaped session's token is no longer good; a kept one's is.
        assert!(!control.knows(&token_a) && !control.knows(&token_c));
        assert!(control.knows(&token_b));

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
        assert!(!control.knows(&token_b));
    }

    /// V26, Windows 10: a shell that exits ends its session. The console host
    /// kept the output pipe open after its shell had gone, so the reader never
    /// saw an end — no exit code, no restart, the row still "Running" — until
    /// the console was closed, which waited for the end. `watch_for_exit`
    /// closes it when the shell's process ends.
    #[cfg(windows)]
    #[test]
    fn a_shell_that_exits_ends_its_output_on_windows() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::sync::mpsc;
        use std::time::Duration;

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c", "exit 7"]);
        let child = pair.slave.spawn_command(cmd).expect("cmd starts");
        drop(pair.slave);

        // As the production reader: drain, and answer ConPTY's opening cursor
        // query, which holds the shell back until it is answered.
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = pair.master.take_writer().expect("writer");
        let input_tx = spawn_writer_thread(writer, "exit-watch").expect("writer thread");
        let answer_tx = input_tx.clone();
        let (ended_tx, ended_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut startup_query = Some(StartupCursorQuery::default());
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Some(query) = startup_query.as_mut() {
                            if let Some(answer) = query.feed(&buf[..n]).answer {
                                let _ = answer_tx.send(answer.to_vec());
                            }
                            if query.is_done() {
                                startup_query = None;
                            }
                        }
                    }
                }
            }
            let _ = ended_tx.send(());
        });

        let session = Arc::new(PtySession {
            id: "exit-watch".into(),
            shell: "cmd.exe".into(),
            created_at: Utc::now(),
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input_tx)),
            child: Mutex::new(child),
            flow: Arc::new(FlowGate::default()),
        });
        watch_for_exit(&session).expect("the exit watch starts");

        assert!(
            ended_rx.recv_timeout(Duration::from_secs(15)).is_ok(),
            "the output ends once the shell has exited"
        );
        // The watch closes the console when the shell's process ends; a
        // console host that ends the pipe by itself can end it first, so the
        // close is waited for rather than assumed to have come before.
        let closed = (0..50).any(|_| {
            if session.master.lock().is_none() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
            false
        });
        assert!(closed, "the console was closed");
        let status = session.child.lock().wait().expect("an exit status");
        assert_eq!(status.exit_code(), 7, "and the shell's own code is there to report");
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

    /// `pty_input_hidden`: the answer the typing guard asks for right before
    /// it types (spec P4) — read from the terminal there and then, not from
    /// the last event.
    #[test]
    fn input_hidden_reads_the_terminal_of_a_live_session_and_refuses_an_unknown_one() {
        let mgr = PtyManager::new();
        assert!(mgr.input_hidden("nope").is_err(), "an unknown session is an error, not an answer");
        for (id, script, expected) in [("hidden", "stty sane -echo; cat", Some(true)), ("shown", "stty sane; cat", Some(false))] {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .expect("openpty");
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.arg("-c");
            cmd.arg(script);
            let child = pair.slave.spawn_command(cmd).expect("spawn");
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().expect("reader");
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                }
            });
            let tx = spawn_writer_thread(pair.master.take_writer().expect("writer"), id).unwrap();
            mgr.sessions.lock().insert(
                id.into(),
                Arc::new(PtySession {
                    id: id.into(),
                    shell: "/bin/sh".into(),
                    created_at: Utc::now(),
                    master: Mutex::new(Some(pair.master)),
                    input: Mutex::new(Some(tx)),
                    child: Mutex::new(child),
                    flow: Arc::new(FlowGate::default()),
                }),
            );
            std::thread::sleep(Duration::from_millis(400)); // let `stty` take effect
            assert_eq!(mgr.input_hidden(id), Ok(expected), "{script}");
            let _ = mgr.kill(id);
        }
    }

    /// A session held by hand around a real program in a real pty, as the
    /// tests above hold theirs; what it prints comes out of the receiver.
    fn hold(mgr: &PtyManager, id: &str, cmd: CommandBuilder) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (printed, output) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let _ = printed.send(buf[..n].to_vec());
            }
        });
        let tx = spawn_writer_thread(pair.master.take_writer().expect("writer"), id).unwrap();
        mgr.sessions.lock().insert(
            id.into(),
            Arc::new(PtySession {
                id: id.into(),
                shell: "test".into(),
                created_at: Utc::now(),
                master: Mutex::new(Some(pair.master)),
                input: Mutex::new(Some(tx)),
                child: Mutex::new(child),
                flow: Arc::new(FlowGate::default()),
            }),
        );
        output
    }

    /// The foreground of a real pty: our own `cat` is this user; `su`,
    /// set-uid root and waiting for a password, is not — the case the page
    /// refuses to type into. Each program is its session's own, so it is in
    /// the foreground from the start.
    #[test]
    fn the_foreground_of_a_terminal_is_this_user_s_or_not() {
        use std::os::unix::fs::MetadataExt;
        let mgr = PtyManager::new();
        assert!(mgr.foreground_owner("nope").is_err(), "an unknown session is an error");

        let mut cat = CommandBuilder::new("/bin/sh");
        cat.args(["-c", "exec cat"]);
        let _output = hold(&mgr, "ours", cat);
        assert_eq!(mgr.foreground_owner("ours"), Ok(Some(true)));
        let _ = mgr.kill("ours");

        let su = ["/usr/bin/su", "/bin/su"].into_iter().find(|path| {
            std::fs::metadata(path).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o4000 != 0)
        });
        // SAFETY: cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("running as root: su would be this user; skipping that half");
        } else if let Some(su) = su {
            let output = hold(&mgr, "su", CommandBuilder::new(su));
            // Asked once it is asking: just after the exec, the system can
            // still report the credentials it had before (measured on macOS).
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut seen = String::new();
            while !seen.to_lowercase().contains("password") {
                match output.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                    Err(_) => panic!("{su} never asked for a password; it printed {seen:?}"),
                }
            }
            assert_eq!(mgr.foreground_owner("su"), Ok(Some(false)), "{su} asking for a password");
            let _ = mgr.kill("su");
        } else {
            eprintln!("no set-uid su here; skipping that half");
        }
    }

    /// What `output` prints, into `seen`, until `needle` appears after
    /// byte `from` of it; a failure (with what was printed) after 20 s.
    fn wait_for(output: &std::sync::mpsc::Receiver<Vec<u8>>, seen: &mut String, from: usize, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !seen.get(from..).is_some_and(|after| after.contains(needle)) {
            match output.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => panic!("{needle:?} never came; the terminal printed {seen:?}"),
            }
        }
    }

    /// The reviewer's shapes (review 7, round 2), started at the prompt of a
    /// shell with job control as a user would: a set-uid program that is not
    /// its foreground group's leader (`sh -c 'su; :'`, `time login`), and
    /// one whose group leader has already gone (`true | su`, `true | login`).
    /// Each is asked once it is waiting at its prompt.
    #[test]
    fn every_member_of_the_foreground_group_is_looked_at() {
        use std::os::unix::fs::MetadataExt;
        let Some(bash) = ["/bin/bash", "/usr/bin/bash"].into_iter().find(|p| std::path::Path::new(p).exists()) else {
            eprintln!("no bash here; skipping");
            return;
        };
        // SAFETY: cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("running as root: set-uid root programs are this user; skipping");
            return;
        }
        let setuid = |path: &str| std::fs::metadata(path).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o4000 != 0);
        let mut shapes: Vec<(String, &str)> = Vec::new();
        if let Some(su) = ["/usr/bin/su", "/bin/su"].into_iter().find(|p| setuid(p)) {
            shapes.push((format!("sh -c '{su}; :'"), "assword"));
            shapes.push((format!("true | {su} </dev/tty"), "assword"));
        }
        if std::path::Path::new("/usr/bin/time").exists() && setuid("/usr/bin/login") {
            shapes.push(("/usr/bin/time /usr/bin/login".into(), "login:"));
            shapes.push(("/usr/bin/true | /usr/bin/login </dev/tty".into(), "login:"));
        }
        if shapes.is_empty() {
            eprintln!("no set-uid su or login here; skipping");
            return;
        }
        let mgr = PtyManager::new();
        for (n, (line, waiting)) in shapes.iter().enumerate() {
            let id = format!("shape-{n}");
            let mut cmd = CommandBuilder::new(bash);
            cmd.args(["--norc", "--noprofile", "-i"]);
            cmd.env("PS1", "nx-ready> ");
            cmd.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
            let output = hold(&mgr, &id, cmd);
            let mut seen = String::new();
            wait_for(&output, &mut seen, 0, "nx-ready> ");
            assert_eq!(mgr.foreground_owner(&id), Ok(Some(true)), "bash at its prompt");
            let mark = seen.len();
            mgr.write(&id, &format!("{line}\n")).unwrap();
            wait_for(&output, &mut seen, mark, waiting);
            assert_eq!(mgr.foreground_owner(&id), Ok(Some(false)), "{line}");
            let _ = mgr.kill(&id);
        }
    }

    #[test]
    fn the_guard_rejects_only_what_the_kernel_would_drop() {
        let cooked = probe(false, "guard-cooked");
        let mgr = PtyManager::new();
        let session = Arc::new(PtySession {
            id: "guard".into(),
            shell: "/bin/sh".into(),
            created_at: Utc::now(),
            master: Mutex::new(Some(
                native_pty_system()
                    .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                    .expect("openpty")
                    .master,
            )),
            input: Mutex::new(Some(cooked.tx.clone())),
            child: Mutex::new(spare_child()),
            flow: Arc::new(FlowGate::default()),
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
                master: Mutex::new(Some(pair.master)),
                input: Mutex::new(Some(spawn_writer_thread(writer, "slow").unwrap())),
                child: Mutex::new(child),
                flow: Arc::new(FlowGate::default()),
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
        set_session_env(&mut cmd, None);
        assert_eq!(value(&cmd, "OPENTUI_NOTIFICATION_PROTOCOL").as_deref(), Some("osc99"));
    }

    #[test]
    fn a_protocol_the_shell_inherits_is_left_exactly_as_it_is() {
        // Empty is a choice too: the user unset OpenTUI's guess, not NexTerm.
        for inherited in ["osc9", "osc99", "", "something-newer"] {
            let mut cmd = CommandBuilder::new("sh");
            cmd.env("OPENTUI_NOTIFICATION_PROTOCOL", inherited);
            set_session_env(&mut cmd, None);
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
            set_session_env(&mut cmd, None);
            assert_eq!(value(&cmd, "OPENTUI_NOTIFICATION_PROTOCOL").as_deref(), Some("osc9"));
        }
    }
}

/// What the control API gives a shell (src/control/), set up by the same
/// code `spawn` uses.
#[cfg(test)]
mod control_env_tests {
    use super::*;
    use portable_pty::CommandBuilder;
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn value(cmd: &CommandBuilder, key: &str) -> Option<String> {
        cmd.get_env(key).map(|v| v.to_string_lossy().into_owned())
    }

    /// The folder of NexTerm's that holds only the CLI.
    fn cli_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\u\AppData\Local\com.nexterm.ide\bin")
        } else {
            PathBuf::from("/Users/u/Library/Application Support/com.nexterm.ide/bin")
        }
    }

    pub(super) fn given() -> SessionEnv {
        SessionEnv {
            address: OsString::from(if cfg!(windows) { r"\\.\pipe\nexterm-00ff00ff" } else { "/tmp/nxc/00ff00ff00ff00ff.sock" }),
            // Fake, and written so that no secret scanner takes it for one.
            token: "to·ken-of-pty-1".replace('·', ""),
            cli: Some(cli_dir().join(control::CLI_NAME)),
            path_dir: Some(cli_dir()),
        }
    }

    fn path_of(dirs: &[&str]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn a_shell_is_given_the_address_its_token_and_the_cli_first_on_path() {
        let env = given();
        let (a, b) = if cfg!(windows) { (r"C:\Windows", r"C:\bin") } else { ("/usr/bin", "/bin") };
        let mut cmd = CommandBuilder::new("sh");
        cmd.env("PATH", path_of(&[a, b]));
        cmd.env_remove("WSLENV");
        set_session_env(&mut cmd, Some(&env));
        assert_eq!(value(&cmd, "NEXTERM_CONTROL"), Some(env.address.to_string_lossy().into_owned()));
        assert_eq!(value(&cmd, "NEXTERM_CONTROL_TOKEN"), Some(env.token.clone()));
        let cli = env.cli.clone().unwrap();
        assert_eq!(value(&cmd, "NEXTERM_CLI"), Some(cli.to_string_lossy().into_owned()));
        let dir = cli_dir();
        assert_eq!(cmd.get_env("PATH").map(OsString::from), Some(path_of(&[dir.to_str().unwrap(), a, b])));
        #[cfg(windows)]
        assert_eq!(value(&cmd, "WSLENV").as_deref(), Some("NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN"));
        #[cfg(not(windows))]
        assert_eq!(value(&cmd, "WSLENV"), None, "WSL is a Windows matter");
    }

    #[test]
    fn with_the_api_off_a_shell_has_none_of_them_not_even_inherited_ones() {
        let parent = |cmd: &mut CommandBuilder| {
            cmd.env("NEXTERM_CONTROL", "/another/nexterm.sock");
            cmd.env("NEXTERM_CONTROL_TOKEN", "a-parent-to·ken".replace('·', ""));
            cmd.env("NEXTERM_CLI", "/another/nexterm-cli");
        };
        let mut cmd = CommandBuilder::new("sh");
        parent(&mut cmd);
        let path = value(&cmd, "PATH");
        let wslenv = value(&cmd, "WSLENV");
        set_session_env(&mut cmd, None);
        for key in ["NEXTERM_CONTROL", "NEXTERM_CONTROL_TOKEN", "NEXTERM_CLI"] {
            assert_eq!(value(&cmd, key), None, "{key} was left in");
        }
        assert_eq!(value(&cmd, "PATH"), path, "PATH untouched");
        assert_eq!(value(&cmd, "WSLENV"), wslenv, "WSLENV untouched");

        // On, a parent's are replaced by this instance's own.
        let mut cmd = CommandBuilder::new("sh");
        parent(&mut cmd);
        set_session_env(&mut cmd, Some(&given()));
        assert_eq!(value(&cmd, "NEXTERM_CONTROL_TOKEN"), Some(given().token));
    }

    #[test]
    fn without_the_cli_beside_the_app_path_is_left_as_it_was() {
        let env = SessionEnv { cli: None, path_dir: None, ..given() };
        let mut cmd = CommandBuilder::new("sh");
        let path = value(&cmd, "PATH");
        set_session_env(&mut cmd, Some(&env));
        assert_eq!(value(&cmd, "NEXTERM_CLI"), None);
        assert_eq!(value(&cmd, "PATH"), path);
        assert!(value(&cmd, "NEXTERM_CONTROL").is_some() && value(&cmd, "NEXTERM_CONTROL_TOKEN").is_some());
    }

    /// The CLI could not be given a folder of its own: hooks still have its
    /// path, and PATH is exactly what the shell inherited — the CLI's own
    /// folder (/usr/bin, Contents/MacOS, the install folder) never goes on it.
    #[test]
    fn with_no_folder_of_its_own_the_real_cli_is_named_and_path_left_alone() {
        let real = if cfg!(windows) { PathBuf::from(r"C:\Program Files\NexTerm\nexterm-cli.exe") } else { PathBuf::from("/usr/bin/nexterm-cli") };
        let env = SessionEnv { cli: Some(real.clone()), path_dir: None, ..given() };
        let mut cmd = CommandBuilder::new("sh");
        let path = value(&cmd, "PATH");
        set_session_env(&mut cmd, Some(&env));
        assert_eq!(value(&cmd, "NEXTERM_CLI"), Some(real.to_string_lossy().into_owned()));
        assert_eq!(value(&cmd, "PATH"), path);
    }

    /// Windows: a `WSLENV` the user has keeps everything in it, gains the
    /// two names once, and a variable spelt in another case is the same one.
    #[cfg(windows)]
    #[test]
    fn wslenv_keeps_what_the_user_had() {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.env_remove("WSLENV");
        cmd.env("wslenv", "GOPATH/l:NEXTERM_CONTROL");
        set_session_env(&mut cmd, Some(&given()));
        assert_eq!(value(&cmd, "WSLENV").as_deref(), Some("GOPATH/l:NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN"));
    }
}

/// A real shell started with exactly what `set_session_env` gives it reads
/// the address, the token and the CLI back, and finds the CLI's folder first
/// on its PATH.
#[cfg(all(test, unix))]
mod control_env_shell_tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::time::{Duration, Instant};

    #[test]
    fn a_real_shell_reads_back_what_it_was_given() {
        let env = super::control_env_tests::given();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", r#"printf 'nx=%s|%s|%s|%s=nx\n' "$NEXTERM_CONTROL" "$NEXTERM_CONTROL_TOKEN" "$NEXTERM_CLI" "${PATH%%:*}""#]);
        set_session_env(&mut cmd, Some(&env));
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 500, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn sh");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (tx, output) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut seen = String::new();
        while !seen.contains("=nx") {
            match output.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        let line = seen
            .split("nx=")
            .nth(1)
            .and_then(|rest| rest.split("=nx").next())
            .unwrap_or_else(|| panic!("the shell printed {seen:?}"));
        let cli = env.cli.clone().unwrap();
        let expected = format!(
            "{}|{}|{}|{}",
            env.address.to_string_lossy(),
            env.token,
            cli.display(),
            env.path_dir.as_ref().unwrap().display()
        );
        assert_eq!(line, expected);
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
        set_session_env(&mut cmd, None);
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
            set_session_env(&mut cmd, None);
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
        set_session_env(&mut cmd, None);
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

/// Stage 4's promise about the output path: whatever the batching and the
/// flow control do, what the page gets is exactly what the program printed —
/// nothing lost, nothing twice, nothing out of order — and a marker never
/// overtakes the output it came after.
#[cfg(all(test, unix))]
mod output_path_tests {
    use super::*;
    use super::super::startup_query;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::sync::mpsc;
    use std::time::Duration;

    /// FNV-1a, so a failure says "differs" without printing megabytes.
    fn fnv(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100_0000_01b3))
    }

    /// About `size` bytes of what terminals are shown: numbered lines, Korean,
    /// emoji (one with a ZWJ, a flag), colours, a window title, a program's
    /// own cursor query, and the shell hooks' OSC 133 / OSC 7. Returns what
    /// is printed, what the page should get (the markers removed), and each
    /// marker with how much of that output comes before it.
    fn generate(size: usize) -> (Vec<u8>, String, Vec<(Marker, usize)>) {
        let mut printed = String::new();
        let mut expected = String::new();
        let mut markers = Vec::new();
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut line = 0u64;
        while printed.len() < size {
            line += 1;
            let mut text = format!("{line:08} ");
            for _ in 0..(next() % 12) {
                text.push_str(match next() % 7 {
                    0 => "한글 출력 ",
                    1 => "😀 ",
                    2 => "👩\u{200d}💻 ",
                    3 => "🇰🇷 ",
                    4 => "\x1b[38;5;208mcolour\x1b[0m ",
                    5 => "plain words go here ",
                    _ => "가나다라마바사 ",
                });
            }
            text.push('\n');
            printed.push_str(&text);
            expected.push_str(&text);
            match next() % 40 {
                0 => {
                    let title = format!("title {line}");
                    let seq = format!("\x1b]0;{title}\x07");
                    printed.push_str(&seq);
                    expected.push_str(&seq);
                    markers.push((Marker::Title(title), expected.len()));
                }
                1 => {
                    printed.push_str("\x1b]133;C\x07");
                    markers.push((Marker::CommandExecuted, expected.len()));
                }
                2 => {
                    let code = (line % 3) as i32;
                    printed.push_str(&format!("\x1b]133;D;{code}\x07"));
                    markers.push((Marker::CommandFinished(Some(code)), expected.len()));
                }
                3 => {
                    printed.push_str(&format!("\x1b]7;file://host/tmp/dir%20{line}\x07"));
                    markers.push((Marker::WorkingDirectory(format!("/tmp/dir {line}")), expected.len()));
                }
                4 => {
                    // A program asking where the cursor is, long after the
                    // start: xterm's to answer, so it passes through.
                    printed.push_str("\x1b[6n");
                    expected.push_str("\x1b[6n");
                }
                _ => {}
            }
        }
        (printed.into_bytes(), expected, markers)
    }

    #[test]
    fn what_waits_for_the_sender_counts_against_the_page() {
        // Found in review: counted only as the sender sent it, output piled
        // up between the reader and a sender stuck emitting, with nothing to
        // stop the reader. Here the sender never takes anything.
        const HIGH: u64 = 64 * 1024;
        let flow = Arc::new(FlowGate::new(HIGH, HIGH / 2, Duration::from_secs(30)));
        let (outgoing, queued) = mpsc::channel::<Outgoing>();
        let reader = {
            let flow = flow.clone();
            thread::spawn(move || {
                let mut source = std::io::Cursor::new(vec![b'x'; 4 * 1024 * 1024]);
                pump_output(&mut source, &flow, &mut None, || {}, &outgoing)
            })
        };
        thread::sleep(Duration::from_millis(300));
        let waiting: usize = queued
            .try_iter()
            .map(|item| match item {
                Outgoing::Output(text) => text.len(),
                Outgoing::Marker(_) => 0,
            })
            .sum();
        assert!(waiting as u64 <= HIGH + 4096, "{waiting} B queued for a sender that took none");
        flow.close();
        assert!(reader.join().expect("reader") >= 1, "the reader was held");
    }

    #[test]
    fn a_sender_gone_never_holds_the_reader_again() {
        // Found in review: counted as queued, output stranded with a sender
        // that died — and every read after it — held the reader for good
        // (or a read every stall).
        let flow = Arc::new(FlowGate::new(4096, 2048, Duration::from_millis(100)));
        flow.sent(4096 + 4096); // stranded in the dead sender's queue
        let (outgoing, queued) = mpsc::channel::<Outgoing>();
        drop(queued);
        let mut source = std::io::Cursor::new(vec![b'x'; 1024 * 1024]);
        let started = std::time::Instant::now();
        let held = pump_output(&mut source, &flow, &mut None, || {}, &outgoing);
        assert!(started.elapsed() < Duration::from_secs(2), "drained in {:?}", started.elapsed());
        assert!(held <= 1, "held {held} times: once at most, before it knew");
    }

    #[test]
    fn megabytes_of_mixed_output_arrive_whole_and_in_order() {
        const HIGH: u64 = 256 * 1024;
        let (body, expected, expected_markers) = generate(4 * 1024 * 1024);
        // The stream opens with the cursor query ConPTY sends first: taken
        // out and answered, as on Windows (the reader holds it on unix only
        // here, to drive that path too).
        let mut printed = startup_query::QUERY.to_vec();
        printed.extend_from_slice(&body);
        // And it ends mid-character, as a shell that dies while printing
        // does: the half goes out as it is, never held for ever.
        printed.extend_from_slice(&"한".as_bytes()[..2]);
        let expected = format!("{expected}\u{FFFD}");
        let dir = std::env::temp_dir().join(format!("nexterm-output-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("printed.bin");
        std::fs::write(&file, &printed).expect("write the output");

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        // No output processing (no CR added to LF): what arrives is what was printed.
        cmd.args(["-c", &format!("stty -opost; cat '{}'", file.display())]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");

        let flow = Arc::new(FlowGate::new(HIGH, HIGH / 2, Duration::from_secs(30)));
        let (answer_tx, answer_rx) = mpsc::channel::<Vec<u8>>();
        let mut startup = Some((startup_query::StartupCursorQuery::default(), answer_tx));
        let (outgoing, outgoing_rx) = mpsc::channel::<Outgoing>();
        let (page_tx, page_rx) = mpsc::channel::<Outgoing>();

        // The sender, as `spawn` runs it (the reader has counted what it queued).
        let emitter = {
            thread::spawn(move || {
                let batcher = Batcher::new(Duration::from_millis(8), output_batch::DEFAULT_MAX);
                output_batch::run_emitter(outgoing_rx, batcher, |item| {
                    let _ = page_tx.send(item);
                });
            })
        };
        // A page that reads slowly, so flow control has to hold the reader.
        let page = {
            let flow = flow.clone();
            thread::spawn(move || {
                let mut output = String::new();
                let mut markers = Vec::new();
                let mut since_pause = 0;
                for item in page_rx {
                    match item {
                        Outgoing::Output(data) => {
                            output.push_str(&data);
                            since_pause += data.len();
                            if since_pause > 64 * 1024 {
                                since_pause = 0;
                                thread::sleep(Duration::from_millis(2));
                            }
                            flow.acked(data.len() as u64);
                        }
                        Outgoing::Marker(marker) => markers.push((marker, output.len())),
                    }
                }
                (output, markers)
            })
        };

        let held = pump_output(&mut *reader, &flow, &mut startup, || {}, &outgoing);
        drop(outgoing);
        emitter.join().expect("sender");
        let (output, markers) = page.join().expect("page");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(answer_rx.try_recv().ok().as_deref(), Some(startup_query::ANSWER), "the opening query is answered");
        assert!(answer_rx.try_recv().is_err(), "and only that one");
        assert!(held > 0, "the reader was never held — flow control was not exercised");
        if output != expected {
            let at = output.bytes().zip(expected.bytes()).position(|(a, b)| a != b).unwrap_or(output.len().min(expected.len()));
            panic!(
                "output differs: {} B (hash {:x}) vs {} B printed (hash {:x}), first difference at byte {at}",
                output.len(),
                fnv(output.as_bytes()),
                expected.len(),
                fnv(expected.as_bytes()),
            );
        }
        assert_eq!(markers.len(), expected_markers.len(), "every marker, once");
        for (i, ((got, at), (want, due))) in markers.iter().zip(&expected_markers).enumerate() {
            assert_eq!(got, want, "marker {i} out of order");
            // Never ahead of the output it came after, and no later than the
            // read it arrived in (a read and what the filter held before it).
            assert!(*at >= *due, "marker {i} ({got:?}) overtook output: at {at}, after {due}");
            assert!(*at <= *due + 2 * 4096 + 16, "marker {i} ({got:?}) held back: at {at}, after {due}");
        }
    }
}
