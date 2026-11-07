//! The local control API (stage 7): how a program running in a NexTerm
//! terminal — an agent's hook, a script — asks NexTerm to notify, show a
//! status or progress, list terminals, open a split, type, read the screen
//! or focus a terminal. The threat model and decisions are in the vault
//! (`NexTerm - 7단계 CLI와 로컬 제어 API 설계`); D1–D3 and D6's limits are
//! carried out here, the rest by the page.
//!
//! **Transport (D1).** No network listener of any kind.
//! - macOS and Linux: a Unix socket, `<instance>.sock` in a folder of this
//!   user's alone (unix.rs) — `$XDG_RUNTIME_DIR/nexterm` on Linux when that
//!   is set, else `control` in the app's local data folder. Every connection
//!   is checked to come from this user (the peer's uid).
//! - Windows: a named pipe `\\.\pipe\nexterm-<128 random bits>` whose DACL
//!   lets in this user alone, remote clients rejected, created as the
//!   name's first instance so that nobody can be there first (windows.rs).
//!   Every client is checked to run as this user.
//! - `<instance>` is new at every start, so nothing of a crashed run is ever
//!   reused.
//!
//! **Tokens (D2).** Every shell `PtyManager::spawn` starts while the API is
//! listening is given a token of its own (tokens.rs), with the address and
//! the CLI, in its environment (`SessionEnv`); the token is forgotten when
//! that session ends — killed, exited, or reaped by `retain_only`. A
//! restarted shell is a new session with a new token.
//!
//! **Settings (D5)** come from the page (`control_set_settings`):
//! - `enabled` off stops the listener, removes the socket, forgets every
//!   token, and starts new shells without any of the variables. On again
//!   starts a new listener at a new address. Shells started while it was off
//!   get no token until they are restarted: their environment cannot be
//!   changed from outside, and nothing here tries.
//! - `type_and_read` off: `send` and `read-screen` are answered `disabled`
//!   here, before the page hears of them (the page refuses them as well).
//! - `other_terminals` is the page's to enforce; it is handed to the page
//!   with every request, as `type_and_read` is, so the page acts on the
//!   value of the moment.
//!
//!   Until the page first says otherwise the defaults of D5 hold: on, typing
//!   and reading off, other terminals off. The page should send its settings
//!   before it starts its first shell, so that a user's "off" holds from the
//!   first terminal on.
//!
//! **Protocol (D3)** is protocol.rs; connections, caps and timeouts are
//! server.rs; the page is asked through bridge.rs; the rate limits are
//! limits.rs.

mod bridge;
mod cli;
mod limits;
mod protocol;
mod server;
mod tokens;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
pub(crate) mod windows;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;

pub use bridge::{Page, PageRequest, REQUEST_EVENT};

/// The variables a shell is given (spec D1, D2, D7).
pub const ENV_ADDRESS: &str = "NEXTERM_CONTROL";
pub const ENV_TOKEN: &str = "NEXTERM_CONTROL_TOKEN";
pub const ENV_CLI: &str = "NEXTERM_CLI";

/// The CLI's file name, beside the app's own executable (Tauri's
/// `bundle.externalBin`; on macOS that is `Contents/MacOS`).
pub const CLI_NAME: &str = if cfg!(windows) { "nexterm-cli.exe" } else { "nexterm-cli" };

/// The page's three switches (Settings ▸ Terminal ▸ Control).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Settings {
    pub enabled: bool,
    pub type_and_read: bool,
    pub other_terminals: bool,
}

impl Default for Settings {
    /// D5's defaults: on, typing and reading off, other terminals off.
    fn default() -> Self {
        Settings { enabled: true, type_and_read: false, other_terminals: false }
    }
}

/// What `control_set_settings` answers: whether the API is listening now,
/// and why not when it should be.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Status {
    pub enabled: bool,
    pub listening: bool,
    pub error: Option<String>,
}

/// What a shell is given when it starts while the API is listening.
#[derive(Clone, Debug)]
pub struct SessionEnv {
    pub address: OsString,
    pub token: String,
    /// `NEXTERM_CLI`: the CLI in its own folder (cli.rs), or the real one.
    pub cli: Option<PathBuf>,
    /// The folder put first on PATH: one holding only the CLI, or none.
    pub path_dir: Option<PathBuf>,
}

/// Where the listener goes: on unix the socket's folder; on Windows there
/// is nothing to choose.
#[derive(Clone, Debug)]
pub struct Place {
    #[cfg(unix)]
    folder: PathBuf,
}

impl Place {
    /// The place for the app, from its local data folder (and on Linux
    /// `XDG_RUNTIME_DIR`).
    pub fn for_app(app_local_data: &Path) -> Place {
        #[cfg(unix)]
        {
            Place { folder: unix::folder(std::env::var_os("XDG_RUNTIME_DIR").as_deref(), app_local_data) }
        }
        #[cfg(windows)]
        {
            let _ = app_local_data;
            Place {}
        }
    }
}

/// What connections share: the settings of the moment, the tokens, and the
/// way to the page.
pub(crate) struct Shared {
    settings: Mutex<Settings>,
    tokens: Mutex<tokens::Tokens>,
    /// Every token's `new-split`s together (limits.rs, SPLITS_PER_MINUTE).
    /// Taken after the tokens' lock when both are.
    splits: Mutex<limits::Splits>,
    /// How many open connections each session's token has proven
    /// (server.rs, MAX_CONNECTIONS_PER_TOKEN). Taken after the tokens' lock
    /// when both are.
    held: Mutex<std::collections::HashMap<String, usize>>,
    bridge: bridge::Bridge,
}

impl Shared {
    fn new() -> Self {
        Shared {
            settings: Mutex::new(Settings::default()),
            tokens: Mutex::new(tokens::Tokens::default()),
            splits: Mutex::new(limits::Splits::default()),
            held: Mutex::new(std::collections::HashMap::new()),
            bridge: bridge::Bridge::default(),
        }
    }
}

/// The listener now running.
struct Running {
    address: OsString,
    /// Tells the accept loop to stop.
    stop: Option<oneshot::Sender<()>>,
    /// The accept loop, which ends every connection before it returns.
    task: Option<tokio::task::JoinHandle<()>>,
    /// The socket's file, removed as the listener stops.
    #[cfg(unix)]
    socket: Option<unix::SocketFile>,
}

impl Running {
    /// Nothing new reaches it from here on: the socket's file is gone
    /// (unix), and the accept loop is told to stop.
    fn close(&mut self) {
        #[cfg(unix)]
        drop(self.socket.take());
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }

    /// Stopped, and every connection with it, by the time this returns.
    async fn finish(mut self) {
        self.close();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Running {
    /// Stopped without waiting: as the app exits.
    fn drop(&mut self) {
        self.close();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[derive(Clone)]
struct Setup {
    rt: tokio::runtime::Handle,
    /// Nothing to choose on Windows (`Place`).
    #[cfg_attr(windows, allow(dead_code))]
    place: Place,
}

/// The control API: its listener, its tokens, its settings.
pub struct Control {
    shared: Arc<Shared>,
    /// Taken first whenever both are needed: `run`, then the settings, then
    /// the tokens.
    run: Mutex<Option<Running>>,
    setup: Mutex<Option<Setup>>,
    /// The real CLI, beside the app.
    real_cli: Option<PathBuf>,
    /// What the shells are given for it.
    cli: Mutex<Option<cli::CliPaths>>,
}

impl Control {
    /// Not listening, and not able to until `configure`. `cli` is the real
    /// CLI's path (`find_cli`): `NEXTERM_CLI`, with PATH left alone, until
    /// `install_cli` gives it a folder of its own.
    pub fn new(cli: Option<PathBuf>) -> Self {
        Control {
            shared: Arc::new(Shared::new()),
            run: Mutex::new(None),
            setup: Mutex::new(None),
            cli: Mutex::new(cli.as_deref().map(cli::CliPaths::bare)),
            real_cli: cli,
        }
    }

    /// The CLI put in `<app_local_data>/bin`, the folder every shell then
    /// has first on its PATH (cli.rs). Without a CLI, nothing to do.
    pub fn install_cli(&self, app_local_data: &Path) {
        // From the real one each time, never from the link made before.
        if let Some(real) = &self.real_cli {
            *self.cli.lock() = Some(cli::install(app_local_data, real));
        }
    }

    /// Where to listen, on which runtime, and the page to ask.
    pub fn configure(&self, rt: tokio::runtime::Handle, page: Arc<dyn Page>, place: Place) {
        self.shared.bridge.set_page(page);
        *self.setup.lock() = Some(Setup { rt, place });
    }

    /// The page's settings: the listener started or stopped to match. Turned
    /// off, it returns once the listener and every connection are gone, so
    /// that nothing is answered after the page has been told it is off.
    pub async fn apply(&self, settings: Settings) -> Status {
        let (status, stopped) = self.apply_now(settings);
        if let Some(stopped) = stopped {
            stopped.finish().await;
        }
        status
    }

    /// The settings the app starts with, before any page: nothing is
    /// running yet, so there is nothing to wait for.
    pub fn begin(&self, settings: Settings) -> Status {
        self.apply_now(settings).0
    }

    /// The settings in place, and the listener now stopping if one is.
    fn apply_now(&self, settings: Settings) -> (Status, Option<Running>) {
        let mut run = self.run.lock();
        *self.shared.settings.lock() = settings;
        let mut error = None;
        let mut stopped = None;
        if settings.enabled {
            if run.is_none() {
                match self.start() {
                    Ok(running) => {
                        eprintln!("[NexTerm] The control API is listening at {}", running.address.to_string_lossy());
                        *run = Some(running);
                    }
                    Err(why) => {
                        eprintln!("[NexTerm] The control API is not available: {why}");
                        error = Some(why);
                    }
                }
            }
        } else {
            stopped = Self::stop(&mut run, &self.shared);
        }
        (Status { enabled: settings.enabled, listening: run.is_some(), error }, stopped)
    }

    fn start(&self) -> Result<Running, String> {
        let setup = self.setup.lock().clone().ok_or("NexTerm is still starting")?;
        // The listener registers with the runtime as it is made.
        let _entered = setup.rt.enter();
        let (stop, stopped) = oneshot::channel();
        #[cfg(unix)]
        {
            let bound = unix::bind(&setup.place.folder)?;
            let listener = tokio::net::UnixListener::from_std(bound.listener)
                .map_err(|e| format!("the control socket could not be listened on: {e}"))?;
            let address = bound.file.path().as_os_str().to_os_string();
            let task = setup
                .rt
                .spawn(server::accept_loop(unix::UnixIncoming::new(listener), self.shared.clone(), stopped));
            // What crashed runs left behind, swept when nothing answers it.
            setup.rt.spawn(unix::sweep(setup.place.folder.clone(), bound.file.path().to_path_buf()));
            Ok(Running { address, stop: Some(stop), task: Some(task), socket: Some(bound.file) })
        }
        #[cfg(windows)]
        {
            let incoming = windows::PipeIncoming::create()?;
            let address = OsString::from(incoming.name());
            let task = setup.rt.spawn(server::accept_loop(incoming, self.shared.clone(), stopped));
            Ok(Running { address, stop: Some(stop), task: Some(task) })
        }
    }

    /// Every token forgotten, and the listener, if any, closed and handed
    /// back to be finished.
    fn stop(run: &mut Option<Running>, shared: &Shared) -> Option<Running> {
        shared.tokens.lock().clear();
        let mut running = run.take()?;
        eprintln!("[NexTerm] The control API stopped listening at {}", running.address.to_string_lossy());
        running.close();
        Some(running)
    }

    /// The listener stopped and its socket removed, without waiting for the
    /// connections — as the app exits.
    pub fn shutdown(&self) {
        drop(Self::stop(&mut self.run.lock(), &self.shared));
    }

    /// A token for the shell `session_id` is about to start, with what goes
    /// beside it — or `None` while the API is not listening.
    pub fn issue(&self, session_id: &str) -> Option<SessionEnv> {
        let run = self.run.lock();
        let running = run.as_ref()?;
        if !self.shared.settings.lock().enabled {
            return None;
        }
        let token = self.shared.tokens.lock().issue(session_id, tokio::time::Instant::now())?;
        let cli = self.cli.lock().clone();
        Some(SessionEnv {
            address: running.address.clone(),
            token,
            path_dir: cli.as_ref().and_then(|c| c.path_dir.clone()),
            cli: cli.map(|c| c.cli),
        })
    }

    /// `session_id` has ended: its token is no longer good.
    pub fn revoke(&self, session_id: &str) {
        self.shared.tokens.lock().revoke(session_id);
    }

    /// The page's answer to request `id` (`control_reply`). An id nobody is
    /// waiting for is ignored.
    pub fn reply(&self, id: u64, ok: bool, result: Option<Value>, error: Option<Value>) {
        self.shared.bridge.reply(id, ok, result, error);
    }
}

/// The page in the app: the webview, asked by an event.
pub struct TauriPage(pub tauri::AppHandle);

impl Page for TauriPage {
    fn deliver(&self, request: PageRequest) -> Result<(), String> {
        use tauri::Emitter;
        self.0.emit(REQUEST_EVENT, &request).map_err(|e| e.to_string())
    }
}

/// The CLI beside `exe`, if it is there.
pub fn cli_beside(exe: &Path) -> Option<PathBuf> {
    let cli = exe.parent()?.join(CLI_NAME);
    cli.is_file().then_some(cli)
}

/// The CLI beside the running app, if it is there.
pub fn find_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // Through a link to the app, the CLI is beside where the app really is.
    let exe = dunce::canonicalize(&exe).unwrap_or(exe);
    cli_beside(&exe)
}

/// PATH's separator.
const PATH_SEPARATOR: &str = if cfg!(windows) { ";" } else { ":" };

/// `path` (a PATH) with `dir` put in front of it, and what was there kept
/// exactly as it was — no entry moved, rewritten or removed (review): only
/// left as it is when `dir` is its first entry already. `None` when `dir`
/// cannot be one entry (it holds the separator, or a quote on Windows).
pub fn path_with(dir: &Path, path: Option<&OsStr>) -> Option<OsString> {
    let text = dir.as_os_str();
    let lossy = text.to_string_lossy();
    if text.is_empty() || lossy.contains(PATH_SEPARATOR) || (cfg!(windows) && lossy.contains('"')) {
        return None;
    }
    // An empty PATH is not one empty entry — which a shell reads as the
    // current folder.
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Some(text.to_os_string());
    };
    if std::env::split_paths(path).next().is_some_and(|first| first == dir) {
        return Some(path.to_os_string());
    }
    let mut joined = text.to_os_string();
    joined.push(PATH_SEPARATOR);
    joined.push(path);
    Some(joined)
}

/// The pipe's security descriptor (windows.rs): this user alone, protected;
/// and when NexTerm runs elevated, a high integrity label that no process
/// below it may read or write through — or a non-elevated program of the
/// same user could drive the elevated shells (review).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn pipe_sddl(user_sid: &str, elevated: bool) -> String {
    let dacl = format!("D:P(A;;GA;;;{user_sid})");
    if elevated {
        format!("{dacl}S:(ML;;NWNR;;;HI)")
    } else {
        dacl
    }
}

/// The names WSL is told to carry across from Windows (spec D7).
pub const WSLENV_NAMES: [&str; 2] = [ENV_ADDRESS, ENV_TOKEN];

/// `WSLENV` with the address and the token in it: what was there kept as it
/// was, each name added once — not again when it is there already, with or
/// without flags, in any case.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn wslenv_with(existing: Option<&str>) -> String {
    let existing = existing.unwrap_or("");
    let has = |name: &str| {
        existing
            .split(':')
            .any(|entry| entry.split('/').next().is_some_and(|n| n.eq_ignore_ascii_case(name)))
    };
    let mut value = existing.trim_end_matches(':').to_string();
    for name in WSLENV_NAMES {
        if !has(name) {
            if !value.is_empty() {
                value.push(':');
            }
            value.push_str(name);
        }
    }
    value
}

#[cfg(test)]
pub(crate) mod tests {
    use super::bridge::tests::fake_page;
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    impl Control {
        fn address(&self) -> Option<OsString> {
            self.run.lock().as_ref().map(|r| r.address.clone())
        }

        fn tokens(&self) -> usize {
            self.shared.tokens.lock().len()
        }

        /// A token for `session_id`, listening or not: for the PTY
        /// manager's tests, which are about when tokens go.
        pub(crate) fn token_for_test(&self, session_id: &str) -> String {
            self.shared.tokens.lock().issue(session_id, tokio::time::Instant::now()).unwrap()
        }

        /// Whether `token` is still good.
        pub(crate) fn knows(&self, token: &str) -> bool {
            self.shared.tokens.lock().lookup(token).is_some()
        }
    }

    #[cfg(unix)]
    impl Place {
        /// A socket folder of a test's own.
        fn folder(folder: PathBuf) -> Place {
            Place { folder }
        }
    }

    #[test]
    fn the_defaults_are_d5_s() {
        assert_eq!(Settings::default(), Settings { enabled: true, type_and_read: false, other_terminals: false });
    }

    /// The spec's numbers (D3, D6), written out once: the other tests use
    /// the constants, and would pass with any value in them.
    #[test]
    fn the_numbers_are_the_spec_s() {
        use std::time::Duration;
        assert_eq!(protocol::MAX_REQUEST_BYTES, 64 * 1024);
        assert_eq!(protocol::MAX_RESPONSE_BYTES, 1024 * 1024);
        assert_eq!(protocol::MAX_SEND_TEXT_BYTES, 16 * 1024);
        assert_eq!(server::LINE_TIMEOUT, Duration::from_secs(5));
        assert_eq!(server::IDLE_TIMEOUT, Duration::from_secs(30));
        assert_eq!(server::MAX_CONNECTIONS, 16);
        assert_eq!(server::MAX_CONNECTIONS_PER_TOKEN, 4);
        assert_eq!(limits::SPLITS_PER_TOKEN_PER_MINUTE, 10);
        assert_eq!(bridge::MAX_WAITING, 64);
        assert_eq!(bridge::REPLY_TIMEOUT, Duration::from_secs(3));
        assert_eq!(limits::REQUESTS_PER_SECOND, 20.0);
        assert_eq!(limits::REQUEST_BURST, 40.0);
        assert_eq!(limits::SEND_BYTES_PER_MINUTE, 64 * 1024);
        assert_eq!(limits::READS_PER_MINUTE, 30);
        assert_eq!(limits::SPLITS_PER_MINUTE, 20);
        assert_eq!(limits::KEY_BYTES, 16);
        assert_eq!(server::FIRST_LINE_TIMEOUT, Duration::from_secs(1));
        assert_eq!(cli::BIN_DIR, "bin");
        assert_eq!(tokens::TOKEN_BYTES * 8, 256);
        assert_eq!(REQUEST_EVENT, "control-request");
        assert_eq!((ENV_ADDRESS, ENV_TOKEN, ENV_CLI), ("NEXTERM_CONTROL", "NEXTERM_CONTROL_TOKEN", "NEXTERM_CLI"));
        assert_eq!(CLI_NAME, if cfg!(windows) { "nexterm-cli.exe" } else { "nexterm-cli" });
    }

    #[test]
    fn wslenv_gains_the_two_names_once_and_keeps_what_was_there() {
        assert_eq!(wslenv_with(None), "NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN");
        assert_eq!(wslenv_with(Some("")), "NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN");
        assert_eq!(wslenv_with(Some("PATH/l:GOPATH/p")), "PATH/l:GOPATH/p:NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN");
        assert_eq!(wslenv_with(Some("FOO:")), "FOO:NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN");
        // Already there — as a parent NexTerm left it, with a flag, in
        // another case — is not added again.
        let once = wslenv_with(Some("FOO"));
        assert_eq!(wslenv_with(Some(&once)), once);
        assert_eq!(wslenv_with(Some("NEXTERM_CONTROL/u:X")), "NEXTERM_CONTROL/u:X:NEXTERM_CONTROL_TOKEN");
        assert_eq!(wslenv_with(Some("nexterm_control_token")), "nexterm_control_token:NEXTERM_CONTROL");
        // A name that only starts like ours is not ours.
        assert_eq!(
            wslenv_with(Some("NEXTERM_CONTROL_X")),
            "NEXTERM_CONTROL_X:NEXTERM_CONTROL:NEXTERM_CONTROL_TOKEN"
        );
    }

    #[test]
    fn the_cli_folder_goes_in_front_of_path_and_nothing_there_moves() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let dir = if cfg!(windows) { Path::new(r"C:\Users\u\AppData\Local\com.nexterm.ide\bin") } else { Path::new("/Users/u/Library/Application Support/com.nexterm.ide/bin") };
        let join = |parts: &[&str]| OsString::from(parts.join(sep));
        let dir_s = dir.to_str().unwrap();
        let (a, b) = if cfg!(windows) { (r"C:\Windows", r"C:\bin") } else { ("/usr/bin", "/bin") };
        assert_eq!(path_with(dir, Some(&join(&[a, b]))), Some(join(&[dir_s, a, b])));
        // Somewhere else in it already: in front as well, the rest untouched.
        assert_eq!(path_with(dir, Some(&join(&[a, dir_s, b]))), Some(join(&[dir_s, a, dir_s, b])), "nothing moved");
        // First already (a NexTerm started from a NexTerm): as it was.
        assert_eq!(path_with(dir, Some(&join(&[dir_s, a]))), Some(join(&[dir_s, a])));
        assert_eq!(path_with(dir, None), Some(OsString::from(dir_s)));
        assert_eq!(path_with(dir, Some(OsStr::new(""))), Some(OsString::from(dir_s)), "no empty entry is added");
        // What was there is kept byte for byte: empty entries, quotes, a trailing separator.
        let odd = format!("{a}{sep}{sep}\"{b}\"{sep}");
        assert_eq!(path_with(dir, Some(OsStr::new(&odd))), Some(OsString::from(format!("{dir_s}{sep}{odd}"))));
        // A folder that cannot be one entry is not added at all.
        assert_eq!(path_with(&dir.join(format!("x{sep}y")), Some(&join(&[a]))), None);
    }

    #[test]
    fn the_pipe_lets_in_one_user_and_an_elevated_one_nothing_below_high_integrity() {
        assert_eq!(pipe_sddl("S-1-5-21-1-2-3-1001", false), "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)");
        assert_eq!(pipe_sddl("S-1-5-21-1-2-3-1001", true), "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)S:(ML;;NWNR;;;HI)");
    }

    #[test]
    fn the_cli_is_found_beside_the_app_only_when_it_is_there() {
        let dir = std::env::temp_dir().join(format!("nxc-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(if cfg!(windows) { "NexTerm.exe" } else { "nexterm" });
        assert_eq!(cli_beside(&exe), None);
        std::fs::create_dir(dir.join(CLI_NAME)).unwrap();
        assert_eq!(cli_beside(&exe), None, "a folder of that name is not it");
        std::fs::remove_dir(dir.join(CLI_NAME)).unwrap();
        std::fs::write(dir.join(CLI_NAME), b"").unwrap();
        assert_eq!(cli_beside(&exe), Some(dir.join(CLI_NAME)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A folder of a test's own, short enough for a socket path on macOS.
    #[cfg(unix)]
    pub(crate) struct Scratch(pub PathBuf);
    #[cfg(unix)]
    impl Scratch {
        pub fn new(tag: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("nxc-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A Control listening for real, on a socket or a pipe of its own.
    struct Live {
        control: Control,
        requests: tokio::sync::mpsc::UnboundedReceiver<PageRequest>,
        #[cfg(unix)]
        _scratch: Scratch,
    }

    fn live(tag: &str) -> Live {
        let control = Control::new(Some(PathBuf::from("/opt/nexterm/nexterm-cli")));
        let (page, requests) = fake_page();
        #[cfg(unix)]
        let scratch = Scratch::new(tag);
        #[cfg(unix)]
        let place = Place::folder(scratch.0.join("s"));
        #[cfg(windows)]
        let place = {
            let _ = tag;
            Place {}
        };
        control.configure(tokio::runtime::Handle::current(), page, place);
        let status = control.begin(Settings { enabled: true, type_and_read: true, other_terminals: false });
        assert_eq!(status, Status { enabled: true, listening: true, error: None });
        Live {
            control,
            requests,
            #[cfg(unix)]
            _scratch: scratch,
        }
    }

    #[cfg(unix)]
    type Client = BufReader<tokio::net::UnixStream>;
    #[cfg(windows)]
    type Client = BufReader<tokio::net::windows::named_pipe::NamedPipeClient>;

    #[cfg(unix)]
    async fn connect(address: &OsStr) -> std::io::Result<Client> {
        Ok(BufReader::new(tokio::net::UnixStream::connect(address).await?))
    }

    /// A pipe is busy for the moment between one client and the next
    /// instance; that is waited out, as a client would — for a while, not
    /// for ever: a pipe whose instances are all closing stays busy.
    #[cfg(windows)]
    async fn connect(address: &OsStr) -> std::io::Result<Client> {
        use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
        let mut tries = 0;
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(address) {
                Ok(client) => return Ok(BufReader::new(client)),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && tries < 400 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn ask(client: &mut Client, line: Value) -> Option<Value> {
        let mut bytes = serde_json::to_vec(&line).unwrap();
        bytes.push(b'\n');
        if client.get_mut().write_all(&bytes).await.is_err() {
            return None;
        }
        let mut answer = String::new();
        match client.read_line(&mut answer).await {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(&answer).unwrap()),
        }
    }

    /// The whole path, as a hook would take it: a real socket (a real pipe on
    /// Windows), a token as `spawn` issues it, the page asked and answering.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn end_to_end_over_the_real_transport() {
        let mut live_one = live("e2e");
        let control = &live_one.control;
        let requests = &mut live_one.requests;
        let env = control.issue("pty-7").expect("listening, so a token is issued");
        assert_eq!(Some(env.address.clone()), control.address());
        assert_eq!(env.cli.as_deref(), Some(Path::new("/opt/nexterm/nexterm-cli")));
        assert_eq!(env.path_dir, None, "no folder of its own yet: PATH left alone");

        let mut client = connect(&env.address).await.unwrap();
        let asking = tokio::spawn(async move {
            let answer = ask(&mut client, json!({"v":1,"id":3,"token":env.token,"cmd":"set-status","args":{"text":"Running tests"}})).await;
            (client, answer, env)
        });
        let request = requests.recv().await.unwrap();
        assert_eq!(request.session_id, "pty-7");
        assert_eq!(request.cmd, "set-status");
        control.reply(request.id, true, Some(json!({"shown":true})), None);
        let (mut client, answer, env) = asking.await.unwrap();
        assert_eq!(answer, Some(json!({"v":1,"id":3,"ok":true,"result":{"shown":true}})));

        // Another instance's token is not this one's.
        let other = live("e2e2");
        let foreign = other.control.issue("pty-7").unwrap();
        let answer = ask(&mut client, json!({"v":1,"id":4,"token":foreign.token,"cmd":"list"})).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("unauthorized"));

        // The session ended: its token is refused.
        control.revoke("pty-7");
        let answer = ask(&mut client, json!({"v":1,"id":5,"token":env.token,"cmd":"list"})).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("unauthorized"));
        assert!(requests.try_recv().is_err(), "the page was asked once");
        drop(other);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn turned_off_the_listener_closes_the_tokens_go_and_no_shell_is_given_any() {
        let live_one = live("off");
        let control = &live_one.control;
        let env = control.issue("pty-1").unwrap();
        let address = env.address.clone();
        let mut client = connect(&address).await.unwrap();
        assert_eq!(control.tokens(), 1);

        let status = control.apply(Settings { enabled: false, type_and_read: true, other_terminals: true }).await;
        assert_eq!(status, Status { enabled: false, listening: false, error: None });
        assert_eq!(control.tokens(), 0, "every token forgotten");
        assert!(control.issue("pty-2").is_none(), "a shell started now gets none");
        assert!(
            ask(&mut client, json!({"v":1,"id":1,"token":env.token,"cmd":"list"})).await.is_none(),
            "a connection open at the time is closed"
        );
        // Let go of first: on Windows a client still holding its end keeps
        // the closed instance, and so the name, about.
        drop(client);
        assert!(connect(&address).await.is_err(), "nothing listens there any more");
        #[cfg(unix)]
        assert!(!Path::new(&address).exists(), "the socket is gone");

        // On again: a new address, and the old token still refused.
        let status = control.apply(Settings::default()).await;
        assert!(status.listening);
        let again = control.address().unwrap();
        assert_ne!(again, address, "never the same address twice");
        assert!(control.issue("pty-2").is_some());
        let mut client = connect(&again).await.unwrap();
        let answer = ask(&mut client, json!({"v":1,"id":2,"token":env.token,"cmd":"list"})).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("unauthorized"));

        // As the app exits: the address gone at once (on unix; the pipe as
        // the aborted loop is dropped).
        control.shutdown();
        assert!(control.address().is_none());
        assert_eq!(control.tokens(), 0);
        #[cfg(unix)]
        assert!(connect(&again).await.is_err());
    }

    /// Turned off, `apply` returns only once a request waiting for the page
    /// at the time has gone with its connection. On a one-thread runtime, so
    /// that a listener merely aborted, not yet dropped, would be seen.
    #[tokio::test]
    async fn turning_it_off_returns_once_a_request_in_flight_is_gone() {
        let mut live_one = live("wait");
        let token = live_one.control.issue("pty-1").unwrap();
        let mut client = connect(&token.address).await.unwrap();
        let asking = tokio::spawn(async move {
            ask(&mut client, json!({"v":1,"id":1,"token":token.token,"cmd":"list"})).await
        });
        let asked = live_one.requests.recv().await.unwrap();
        assert_eq!(live_one.control.shared.bridge.waiting(), 1);
        live_one.control.apply(Settings { enabled: false, ..Settings::default() }).await;
        assert_eq!(live_one.control.shared.bridge.waiting(), 0, "gone before apply returned");
        live_one.control.reply(asked.id, true, None, None);
        assert_eq!(asking.await.unwrap(), None, "and never answered");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settings_change_in_place_without_a_new_address() {
        let live_one = live("set");
        let control = &live_one.control;
        let address = control.address().unwrap();
        let token = control.issue("pty-1").unwrap().token;
        control.apply(Settings { enabled: true, type_and_read: false, other_terminals: true }).await;
        assert_eq!(control.address(), Some(address.clone()));
        let mut client = connect(&address).await.unwrap();
        let answer = ask(&mut client, json!({"v":1,"id":1,"token":token,"cmd":"read-screen"})).await.unwrap();
        assert_eq!(answer["error"]["code"], json!("disabled"));
    }

    /// `install_cli` gives every shell started after it the CLI's own
    /// folder, and the link in it as NEXTERM_CLI.
    #[tokio::test]
    async fn shells_get_the_cli_s_own_folder_once_it_is_installed() {
        let scratch = std::env::temp_dir().join(format!("nxc-inst-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(scratch.join("install")).unwrap();
        let real = scratch.join("install").join(CLI_NAME);
        std::fs::write(&real, b"cli").unwrap();
        let control = Control::new(Some(real.clone()));
        let (page, _requests) = fake_page();
        #[cfg(unix)]
        let socket = Scratch::new("inst");
        #[cfg(unix)]
        let place = Place::folder(socket.0.join("s"));
        #[cfg(windows)]
        let place = Place {};
        control.configure(tokio::runtime::Handle::current(), page, place);
        control.begin(Settings::default());
        let before = control.issue("pty-1").unwrap();
        assert_eq!((before.cli.as_deref(), before.path_dir.as_deref()), (Some(real.as_path()), None));
        control.install_cli(&scratch.join("data"));
        let after = control.issue("pty-2").unwrap();
        let bin = scratch.join("data").join("bin");
        assert_eq!(after.path_dir.as_deref(), Some(bin.as_path()));
        assert_eq!(after.cli.as_deref(), Some(bin.join(CLI_NAME).as_path()));
        assert_eq!(std::fs::read(bin.join(CLI_NAME)).unwrap(), b"cli", "and it is the CLI");
        // Installed again: still from the real CLI, never from the link.
        control.install_cli(&scratch.join("data"));
        assert_eq!(control.issue("pty-3").unwrap().cli.as_deref(), Some(bin.join(CLI_NAME).as_path()));
        assert_eq!(std::fs::read(bin.join(CLI_NAME)).unwrap(), b"cli", "still the CLI");
        control.shutdown();
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn nothing_is_issued_before_the_api_is_listening() {
        let control = Control::new(None);
        assert!(control.issue("pty-1").is_none());
        let status = control.begin(Settings::default());
        assert!(!status.listening);
        assert!(status.error.is_some(), "not configured yet, and it says so");
        assert!(control.issue("pty-1").is_none());
    }

    /// The unix socket refused when its path would not fit (macOS: 104 bytes).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_socket_path_too_long_for_the_system_is_refused_with_a_reason() {
        let scratch = Scratch::new("long");
        let control = Control::new(None);
        let (page, _requests) = fake_page();
        control.configure(tokio::runtime::Handle::current(), page, Place::folder(scratch.0.join("x".repeat(120))));
        let status = control.begin(Settings::default());
        assert!(!status.listening);
        let why = status.error.unwrap();
        assert!(why.contains("bytes"), "{why}");
    }
}
