//! Keeping the computer awake while a coding agent works.
//!
//! One holder for the whole app, off until the page turns it on
//! (`power_set_keep_awake`, src/commands/power.rs). What it holds off is the
//! system's sleep and nothing else: the display still dims, blanks and locks
//! as the user set it up, and closing a laptop's lid still puts it to sleep.
//!
//! - macOS: a child `/usr/bin/caffeinate -i -w <NexTerm's pid>`. `-i` keeps
//!   the system out of idle sleep and asks nothing of the display (no `-d`,
//!   no `-u`); `-w` ends it when NexTerm ends, however NexTerm ends — a crash
//!   or a force-quit included.
//! - Linux: `systemd-inhibit --what=sleep --who=NexTerm --why=… --mode=block`
//!   holding `tail --pid=<NexTerm's pid> -f /dev/null`. The lock lasts as long
//!   as that tail runs, and tail ends within a second of NexTerm. Both are
//!   found on PATH and run directly, never through a shell; without them
//!   keep-awake is unsupported here. The tail must be GNU coreutils' (busybox
//!   has no `--pid`): a holder already ended when it is looked at, right
//!   after it starts, is a failed hold.
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`,
//!   never `ES_DISPLAY_REQUIRED`. That state belongs to the thread that set
//!   it, so one dedicated thread owns it and is told over a channel what to
//!   do; Windows drops it when that thread or the process ends. No process is
//!   started. A hold answered 0 is reported as failed and let go of at once,
//!   and every "off" lets go, since a 0 may still be a hold that took.
//!
//! It is let go when the page turns it off, when NexTerm quits — through
//! [`release`], from commands/app.rs and the `RunEvent::Exit` in main.rs,
//! since quitting ends the process without running destructors — and when
//! the holder is dropped. A child is put in a process group of its own, so
//! that letting go ends whatever it started too.
//!
//! The tests never hold anything real: what starts the child and what calls
//! Windows are traits, and the tests hand in fakes.

#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::ffi::OsString;
#[cfg(any(target_os = "linux", all(test, unix)))]
use std::ffi::OsStr;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::path::Path;
#[cfg(any(target_os = "linux", all(test, unix)))]
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use child::ChildMethod;
#[cfg(windows)]
use thread::ThreadMethod;

/// What `power_keep_awake_support` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Support {
    /// Whether keep-awake can be turned on here.
    pub supported: bool,
    /// How this platform keeps awake — `caffeinate`, `systemd-inhibit`,
    /// `SetThreadExecutionState`, or `none` where NexTerm knows no way. Named
    /// even when it is unsupported, so that the page can say what is missing.
    pub method: &'static str,
}

/// One way of keeping the computer awake.
trait Method: Send {
    /// Start holding. Only called while not holding.
    fn hold(&mut self) -> Result<(), String>;
    /// Whether the hold taken last still stands: a child can be killed from
    /// outside.
    fn holding(&mut self) -> bool;
    /// Stop holding, and wait until it has stopped. Called after a hold, and
    /// on every "off" where [`Method::release_on_every_off`] says so.
    fn release(&mut self);
    /// Whether the page's "off" lets go even when no hold is believed taken:
    /// where a hold reported as failed may still have taken (Windows).
    fn release_on_every_off(&self) -> bool {
        false
    }
}

/// The keep-awake switch: at most one hold, whatever the page asks.
struct KeepAwake {
    method: Option<Box<dyn Method>>,
    name: &'static str,
    held: bool,
}

impl KeepAwake {
    fn new(method: Option<Box<dyn Method>>, name: &'static str) -> Self {
        Self { method, name, held: false }
    }

    fn support(&self) -> Support {
        Support { supported: self.method.is_some(), method: self.name }
    }

    /// Hold (`on`) or let go; `Ok` says whether it is held now. Asking twice
    /// holds once, and letting go of nothing does nothing — except on
    /// Windows, where every "off" lets go. Turning it on where it is
    /// unsupported holds nothing and is not an error: `Ok(false)`.
    fn set(&mut self, on: bool) -> Result<bool, String> {
        if !on {
            if !self.held {
                if let Some(method) = self.method.as_mut().filter(|m| m.release_on_every_off()) {
                    method.release();
                }
            }
            self.release();
            return Ok(false);
        }
        let Some(method) = self.method.as_mut() else {
            return Ok(false);
        };
        if self.held {
            if method.holding() {
                return Ok(true);
            }
            // It ended under us — the child was killed from outside. Reap
            // it and hold anew.
            method.release();
            self.held = false;
        }
        method.hold()?;
        self.held = true;
        Ok(true)
    }

    fn release(&mut self) {
        if !self.held {
            return;
        }
        if let Some(method) = self.method.as_mut() {
            method.release();
        }
        self.held = false;
    }

    /// This platform's way, on this machine.
    #[cfg(target_os = "macos")]
    fn system() -> Self {
        let method = Path::new(CAFFEINATE).is_file().then(|| {
            Box::new(ChildMethod::new(
                caffeinate_argv(std::process::id()),
                Box::new(system_child::SystemSpawner),
            )) as Box<dyn Method>
        });
        Self::new(method, "caffeinate")
    }

    #[cfg(target_os = "linux")]
    fn system() -> Self {
        linux_holder(
            std::env::var_os("PATH").as_deref(),
            std::process::id(),
            Box::new(system_child::SystemSpawner),
        )
    }

    #[cfg(windows)]
    fn system() -> Self {
        let method = match ThreadMethod::start(Win32) {
            Ok(method) => Some(Box::new(method) as Box<dyn Method>),
            Err(e) => {
                eprintln!("[NexTerm] Could not start the keep-awake thread: {e}");
                None
            }
        };
        Self::new(method, "SetThreadExecutionState")
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    fn system() -> Self {
        Self::new(None, "none")
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.release();
    }
}

/// The app's one holder, made on first use (on Windows that starts its
/// thread).
static HOLDER: Mutex<Option<KeepAwake>> = Mutex::new(None);

/// Hold the computer awake, or let it sleep again. `Ok(true)` while held.
pub fn set_keep_awake(on: bool) -> Result<bool, String> {
    HOLDER.lock().get_or_insert_with(KeepAwake::system).set(on)
}

/// Whether keep-awake works here, and how.
pub fn support() -> Support {
    HOLDER.lock().get_or_insert_with(KeepAwake::system).support()
}

/// Let go of keep-awake, if it is held. For the quit paths: `exit` ends the
/// process without dropping the holder. Makes nothing that was not made.
pub fn release() {
    if let Some(holder) = HOLDER.lock().as_mut() {
        holder.release();
    }
}

#[cfg(any(target_os = "macos", test))]
const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// `caffeinate -i -w <pid>`: no idle sleep until `pid` ends. Exactly that —
/// `-d` or `-u` would keep the display on.
#[cfg(any(target_os = "macos", test))]
fn caffeinate_argv(pid: u32) -> Vec<OsString> {
    [CAFFEINATE.to_owned(), "-i".to_owned(), "-w".to_owned(), pid.to_string()]
        .into_iter()
        .map(OsString::from)
        .collect()
}

/// Why, as `systemd-inhibit --list` shows it.
#[cfg(any(target_os = "linux", test))]
const WHY: &str = "A coding agent is working in NexTerm";

/// `systemd-inhibit` blocking sleep (not idle, not the lid switch) for as
/// long as `tail` waits on `pid`.
#[cfg(any(target_os = "linux", test))]
fn systemd_inhibit_argv(inhibit: &Path, tail: &Path, pid: u32) -> Vec<OsString> {
    vec![
        inhibit.as_os_str().to_owned(),
        "--what=sleep".into(),
        "--who=NexTerm".into(),
        format!("--why={WHY}").into(),
        "--mode=block".into(),
        tail.as_os_str().to_owned(),
        format!("--pid={pid}").into(),
        "-f".into(),
        "/dev/null".into(),
    ]
}

/// The Linux holder for `path` (the PATH): unsupported unless both
/// systemd-inhibit and tail are on it.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_holder(path: Option<&OsStr>, pid: u32, spawner: Box<dyn child::Spawner>) -> KeepAwake {
    let argv = find_on_path("systemd-inhibit", path)
        .zip(find_on_path("tail", path))
        .map(|(inhibit, tail)| systemd_inhibit_argv(&inhibit, &tail, pid));
    let method = argv.map(|argv| Box::new(ChildMethod::new(argv, spawner)) as Box<dyn Method>);
    KeepAwake::new(method, "systemd-inhibit")
}

/// The first executable file `name` in a directory of `path`. Only absolute
/// directories: an empty or relative PATH entry means wherever NexTerm was
/// started from.
#[cfg(any(target_os = "linux", all(test, unix)))]
fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|file| {
            std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Holding by a child that runs for as long as the hold lasts (macOS, Linux).
#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod child {
    use std::ffi::OsString;
    use std::io;

    use super::Method;

    /// A process started to hold the computer awake.
    pub trait Held: Send {
        /// Whether it still runs.
        fn running(&mut self) -> bool;
        /// End it, and reap it.
        fn stop(&mut self);
    }

    /// What starts that process: the system in the app, a fake in the tests.
    pub trait Spawner: Send {
        fn spawn(&mut self, argv: &[OsString]) -> io::Result<Box<dyn Held>>;
    }

    pub struct ChildMethod {
        argv: Vec<OsString>,
        spawner: Box<dyn Spawner>,
        child: Option<Box<dyn Held>>,
    }

    impl ChildMethod {
        pub fn new(argv: Vec<OsString>, spawner: Box<dyn Spawner>) -> Self {
            Self { argv, spawner, child: None }
        }
    }

    impl Method for ChildMethod {
        fn hold(&mut self) -> Result<(), String> {
            let program = || self.argv.first().map(|p| p.to_string_lossy()).unwrap_or_default();
            let mut child = self
                .spawner
                .spawn(&self.argv)
                .map_err(|e| format!("Could not start {}: {e}", program()))?;
            // Looked at once, right away (`try_wait`, no waiting): a child
            // that has already ended holds nothing. A `tail` without `--pid`
            // (busybox's) ends systemd-inhibit as soon as it starts.
            if !child.running() {
                child.stop();
                return Err(format!("{} ended as soon as it started", program()));
            }
            self.child = Some(child);
            Ok(())
        }

        fn holding(&mut self) -> bool {
            self.child.as_mut().is_some_and(|child| child.running())
        }

        fn release(&mut self) {
            if let Some(mut child) = self.child.take() {
                child.stop();
            }
        }
    }

    impl Drop for ChildMethod {
        fn drop(&mut self) {
            self.release();
        }
    }
}

/// The real child: no stdin, stdout or stderr, a process group of its own.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod system_child {
    use std::ffi::OsString;
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Stdio};

    use super::child::{Held, Spawner};

    pub struct SystemSpawner;

    impl Spawner for SystemSpawner {
        fn spawn(&mut self, argv: &[OsString]) -> io::Result<Box<dyn Held>> {
            let (program, args) = argv.split_first().ok_or_else(|| io::Error::other("nothing to run"))?;
            // The backend's one way of starting a program (no console window
            // on Windows; this runs on macOS and Linux alone).
            let mut command = crate::commands::agent::quiet_command(program);
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            Ok(Box::new(Process(command.spawn()?)))
        }
    }

    struct Process(Child);

    impl Held for Process {
        fn running(&mut self) -> bool {
            matches!(self.0.try_wait(), Ok(None))
        }

        fn stop(&mut self) {
            if self.running() {
                // The whole group it leads: systemd-inhibit and the tail it
                // runs, not systemd-inhibit alone.
                if let Ok(group) = libc::pid_t::try_from(self.0.id()) {
                    // SAFETY: kill(2) takes two integers and touches no
                    // memory. The child is not reaped yet, so its id — the
                    // group's — cannot have been given to another process.
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
}

/// Holding by a thread of its own that owns the execution state (Windows).
#[cfg(any(windows, test))]
mod thread {
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::thread::JoinHandle;

    use super::Method;

    pub const ES_CONTINUOUS: u32 = 0x8000_0000;
    pub const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    /// A hold: the system stays on until told otherwise. The display is not
    /// asked for (`ES_DISPLAY_REQUIRED`).
    pub const HOLD: u32 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
    /// Letting go: back to the system's own timers.
    pub const RELEASE: u32 = ES_CONTINUOUS;

    /// `SetThreadExecutionState` — Windows in the app, a fake in the tests.
    pub trait ExecutionState: Send + 'static {
        /// Set the calling thread's state to `flags`: the state before, or 0
        /// when it failed.
        fn set(&mut self, flags: u32) -> u32;
    }

    /// An order for the thread, and where it answers whether it worked.
    type Order = (u32, Sender<bool>);

    pub struct ThreadMethod {
        orders: Option<Sender<Order>>,
        thread: Option<JoinHandle<()>>,
    }

    impl ThreadMethod {
        pub fn start(os: impl ExecutionState) -> std::io::Result<Self> {
            let (orders, inbox) = mpsc::channel::<Order>();
            let thread = std::thread::Builder::new()
                .name("keep-awake".into())
                .spawn(move || run(os, inbox))?;
            Ok(Self { orders: Some(orders), thread: Some(thread) })
        }

        /// Have the thread set `flags`, and wait until it has.
        fn order(&self, flags: u32) -> bool {
            let Some(orders) = &self.orders else {
                return false;
            };
            let (done, answer) = mpsc::channel();
            orders.send((flags, done)).is_ok() && answer.recv().unwrap_or(false)
        }
    }

    /// The thread: every call is made here, and only here.
    fn run(mut os: impl ExecutionState, inbox: Receiver<Order>) {
        let mut holding = false;
        for (flags, done) in inbox {
            let worked = os.set(flags) != 0;
            if worked {
                holding = flags == HOLD;
            } else if flags == HOLD {
                // Reported as failed, yet a 0 may only be the state before
                // (none, on a thread that never set one), so the hold may have
                // taken. Never keep a hold the page is told failed: let go at
                // once, on this same thread, before answering.
                if os.set(RELEASE) != 0 {
                    holding = false;
                }
            }
            let _ = done.send(worked);
        }
        // Nobody is left to give orders. Windows would let go as the thread
        // ends; this says so first.
        if holding {
            os.set(RELEASE);
        }
    }

    impl Method for ThreadMethod {
        fn hold(&mut self) -> Result<(), String> {
            if self.order(HOLD) {
                Ok(())
            } else {
                Err("Windows did not take the request to keep the computer awake".into())
            }
        }

        fn holding(&mut self) -> bool {
            self.thread.as_ref().is_some_and(|thread| !thread.is_finished())
        }

        fn release(&mut self) {
            let _ = self.order(RELEASE);
        }

        /// A hold Windows answered 0 to may have taken all the same, so an
        /// "off" always lets go; letting go of nothing changes nothing.
        fn release_on_every_off(&self) -> bool {
            true
        }
    }

    impl Drop for ThreadMethod {
        fn drop(&mut self) {
            // Closing the channel ends the thread.
            drop(self.orders.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(windows)]
struct Win32;

#[cfg(windows)]
impl thread::ExecutionState for Win32 {
    fn set(&mut self, flags: u32) -> u32 {
        // SAFETY: takes its flags by value and changes only the calling
        // thread's execution state.
        unsafe { windows_sys::Win32::System::Power::SetThreadExecutionState(flags) }
    }
}

// The flags are spelled out in `thread` so that its tests run anywhere; here
// they are held to Windows' own.
#[cfg(windows)]
const _: () = {
    use windows_sys::Win32::System::Power as power;
    assert!(thread::ES_CONTINUOUS == power::ES_CONTINUOUS);
    assert!(thread::ES_SYSTEM_REQUIRED == power::ES_SYSTEM_REQUIRED);
    assert!(thread::HOLD & power::ES_DISPLAY_REQUIRED == 0);
};

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::io;
    use std::path::Path;
    use std::sync::Arc;

    use parking_lot::Mutex;

    use super::child::{ChildMethod, Held, Spawner};
    use super::thread::{self, ExecutionState, ThreadMethod};
    use super::*;

    /// What the fake spawner was asked to do.
    #[derive(Default)]
    struct Calls {
        spawned: Vec<Vec<OsString>>,
        /// Per child, whether it has ended.
        ended: Vec<bool>,
        stops: usize,
        fail: bool,
        /// The next children have ended before anyone looks at them.
        exits_at_once: bool,
    }

    type Log = Arc<Mutex<Calls>>;

    struct FakeSpawner(Log);

    struct FakeChild {
        log: Log,
        index: usize,
    }

    impl Spawner for FakeSpawner {
        fn spawn(&mut self, argv: &[OsString]) -> io::Result<Box<dyn Held>> {
            let mut calls = self.0.lock();
            if calls.fail {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no such file"));
            }
            calls.spawned.push(argv.to_vec());
            let ended = calls.exits_at_once;
            calls.ended.push(ended);
            Ok(Box::new(FakeChild { log: self.0.clone(), index: calls.ended.len() - 1 }))
        }
    }

    impl Held for FakeChild {
        fn running(&mut self) -> bool {
            !self.log.lock().ended[self.index]
        }

        fn stop(&mut self) {
            let mut calls = self.log.lock();
            calls.ended[self.index] = true;
            calls.stops += 1;
        }
    }

    fn fake(argv: Vec<OsString>) -> (KeepAwake, Log) {
        let log = Log::default();
        let method = ChildMethod::new(argv, Box::new(FakeSpawner(log.clone())));
        (KeepAwake::new(Some(Box::new(method)), "caffeinate"), log)
    }

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn on_twice_holds_one() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        assert_eq!(keep.set(true), Ok(true));
        assert_eq!(keep.set(true), Ok(true));
        let calls = log.lock();
        assert_eq!(calls.spawned.len(), 1, "one child, however often it is asked");
        assert_eq!(calls.stops, 0);
    }

    #[test]
    fn off_releases() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        keep.set(true).unwrap();
        assert_eq!(keep.set(false), Ok(false));
        let calls = log.lock();
        assert_eq!(calls.stops, 1);
        assert_eq!(calls.ended, [true], "the child is ended and reaped");
    }

    #[test]
    fn off_when_off_does_nothing() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        assert_eq!(keep.set(false), Ok(false));
        keep.release();
        assert_eq!(log.lock().spawned.len(), 0);
        assert_eq!(log.lock().stops, 0);

        keep.set(true).unwrap();
        keep.set(false).unwrap();
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(log.lock().stops, 1, "a second off lets go of nothing");
    }

    #[test]
    fn on_after_off_holds_again() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        keep.set(true).unwrap();
        keep.set(false).unwrap();
        assert_eq!(keep.set(true), Ok(true));
        let calls = log.lock();
        assert_eq!(calls.spawned.len(), 2);
        assert_eq!(calls.ended, [true, false]);
    }

    #[test]
    fn drop_releases() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        keep.set(true).unwrap();
        drop(keep);
        assert_eq!(log.lock().stops, 1);
        assert_eq!(log.lock().ended, [true]);

        // Dropped while off: nothing to let go of.
        let (keep, log) = fake(caffeinate_argv(4242));
        drop(keep);
        assert_eq!(log.lock().stops, 0);
    }

    #[test]
    fn a_child_killed_from_outside_is_reaped_and_held_anew() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        keep.set(true).unwrap();
        log.lock().ended[0] = true;
        assert_eq!(keep.set(true), Ok(true));
        let calls = log.lock();
        assert_eq!(calls.spawned.len(), 2, "held again");
        assert_eq!(calls.stops, 1, "the dead one reaped first");
    }

    #[test]
    fn a_child_that_cannot_start_is_an_error_and_holds_nothing() {
        let (mut keep, log) = fake(caffeinate_argv(4242));
        log.lock().fail = true;
        let err = keep.set(true).unwrap_err();
        assert!(err.contains("/usr/bin/caffeinate") && err.contains("no such file"), "{err}");
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(log.lock().stops, 0);
        assert!(keep.support().supported, "the way is still there; it failed this once");
    }

    #[test]
    fn a_child_that_ends_as_soon_as_it_starts_is_a_failed_hold_and_is_reaped() {
        // systemd-inhibit holding a busybox tail, which has no --pid: it has
        // ended by the time it is looked at.
        let log = Log::default();
        let argv = systemd_inhibit_argv(Path::new("/usr/bin/systemd-inhibit"), Path::new("/bin/tail"), 4242);
        let method = ChildMethod::new(argv, Box::new(FakeSpawner(log.clone())));
        let mut keep = KeepAwake::new(Some(Box::new(method)), "systemd-inhibit");
        log.lock().exits_at_once = true;

        let err = keep.set(true).unwrap_err();
        assert!(err.contains("/usr/bin/systemd-inhibit") && err.contains("ended as soon as it started"), "{err}");
        assert_eq!(log.lock().spawned.len(), 1);
        assert_eq!(log.lock().stops, 1, "the ended child is reaped");
        // Not held: "off" has nothing to let go of, and the way is still there.
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(log.lock().stops, 1);
        assert!(keep.support().supported);

        // A child that keeps running holds, as before.
        log.lock().exits_at_once = false;
        assert_eq!(keep.set(true), Ok(true));
        assert_eq!(log.lock().ended, [true, false]);
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(log.lock().stops, 2);
    }

    #[test]
    fn unsupported_holds_nothing_and_says_so() {
        let mut keep = KeepAwake::new(None, "systemd-inhibit");
        assert_eq!(keep.set(true), Ok(false));
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(keep.support(), Support { supported: false, method: "systemd-inhibit" });
    }

    #[test]
    fn support_reaches_the_page_as_supported_and_method() {
        let value = serde_json::to_value(Support { supported: true, method: "caffeinate" }).unwrap();
        assert_eq!(value, serde_json::json!({ "supported": true, "method": "caffeinate" }));
    }

    #[test]
    fn the_macos_argv_is_exactly_caffeinate_i_w_pid() {
        assert_eq!(caffeinate_argv(4242), os(&["/usr/bin/caffeinate", "-i", "-w", "4242"]));

        // And that is what is started.
        let (mut keep, log) = fake(caffeinate_argv(77));
        keep.set(true).unwrap();
        assert_eq!(log.lock().spawned, [os(&["/usr/bin/caffeinate", "-i", "-w", "77"])]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_awake_with_caffeinate_on_this_pid() {
        // Made, not held: nothing is started.
        let keep = KeepAwake::system();
        assert_eq!(keep.support(), Support { supported: true, method: "caffeinate" });
        assert_eq!(
            caffeinate_argv(std::process::id()).last(),
            Some(&OsString::from(std::process::id().to_string()))
        );
    }

    #[test]
    fn the_linux_argv_blocks_sleep_with_systemd_inhibit_until_nexterm_ends() {
        let argv = systemd_inhibit_argv(Path::new("/usr/bin/systemd-inhibit"), Path::new("/usr/bin/tail"), 4242);
        assert_eq!(
            argv,
            os(&[
                "/usr/bin/systemd-inhibit",
                "--what=sleep",
                "--who=NexTerm",
                "--why=A coding agent is working in NexTerm",
                "--mode=block",
                "/usr/bin/tail",
                "--pid=4242",
                "-f",
                "/dev/null",
            ])
        );
        for arg in &argv {
            let arg = arg.to_string_lossy();
            assert!(!arg.contains("idle") && !arg.contains("handle-lid-switch"), "sleep alone: {arg}");
            assert!(!arg.contains("sh -c"), "no shell: {arg}");
        }
    }

    /// A directory of its own under the system's temp directory.
    #[cfg(unix)]
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-power-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn program(dir: &Path, name: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join(name);
        std::fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linux_support_is_false_when_systemd_inhibit_is_not_on_path() {
        let empty = scratch("empty");
        let only_inhibit = scratch("only-inhibit");
        program(&only_inhibit, "systemd-inhibit", 0o755);
        let not_executable = scratch("not-executable");
        program(&not_executable, "systemd-inhibit", 0o644);
        program(&not_executable, "tail", 0o755);
        let both = scratch("both");
        program(&both, "systemd-inhibit", 0o755);
        program(&both, "tail", 0o755);

        let unsupported = Support { supported: false, method: "systemd-inhibit" };
        let support = |path: Option<&OsStr>| {
            let log = Log::default();
            let mut keep = linux_holder(path, 4242, Box::new(FakeSpawner(log.clone())));
            let held = keep.set(true);
            let spawned = log.lock().spawned.clone();
            (keep.support(), held, spawned)
        };

        assert_eq!(support(None), (unsupported, Ok(false), vec![]), "no PATH at all");
        for dir in [&empty, &only_inhibit, &not_executable] {
            let path = std::env::join_paths([dir]).unwrap();
            assert_eq!(support(Some(&path)), (unsupported, Ok(false), vec![]), "{}", dir.display());
        }
        // A relative entry is not searched, even when it is where NexTerm runs.
        assert_eq!(support(Some(OsStr::new("relative/dir"))).0, unsupported);

        let path = std::env::join_paths([&empty, &both]).unwrap();
        let (found, held, spawned) = support(Some(&path));
        assert_eq!(found, Support { supported: true, method: "systemd-inhibit" });
        assert_eq!(held, Ok(true));
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0][0], both.join("systemd-inhibit").into_os_string());
        assert_eq!(spawned[0][1], "--what=sleep");
        assert_eq!(spawned[0][5], both.join("tail").into_os_string());

        for dir in [empty, only_inhibit, not_executable, both] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    /// Every call the fake Windows was asked to make, and on which thread.
    type OsLog = Arc<Mutex<Vec<(u32, std::thread::ThreadId)>>>;

    struct FakeWindows {
        log: OsLog,
        /// What `SetThreadExecutionState` answers: 0 is a failure.
        answer: u32,
    }

    impl ExecutionState for FakeWindows {
        fn set(&mut self, flags: u32) -> u32 {
            self.log.lock().push((flags, std::thread::current().id()));
            self.answer
        }
    }

    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;

    fn windows(answer: u32) -> (KeepAwake, OsLog) {
        let log = OsLog::default();
        let method = ThreadMethod::start(FakeWindows { log: log.clone(), answer }).unwrap();
        (KeepAwake::new(Some(Box::new(method)), "SetThreadExecutionState"), log)
    }

    #[test]
    fn the_windows_flags_are_continuous_and_system_required_never_the_display() {
        assert_eq!(thread::HOLD, 0x8000_0001, "ES_CONTINUOUS | ES_SYSTEM_REQUIRED");
        assert_eq!(thread::HOLD & ES_DISPLAY_REQUIRED, 0);
        assert_eq!(thread::RELEASE, 0x8000_0000, "ES_CONTINUOUS alone");
        #[cfg(windows)]
        assert_eq!(ES_DISPLAY_REQUIRED, windows_sys::Win32::System::Power::ES_DISPLAY_REQUIRED);

        let (mut keep, log) = windows(thread::RELEASE);
        assert_eq!(keep.set(true), Ok(true));
        assert_eq!(keep.set(true), Ok(true));
        assert_eq!(log.lock().iter().map(|c| c.0).collect::<Vec<_>>(), [thread::HOLD], "held once");
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(keep.set(false), Ok(false));
        let flags: Vec<u32> = log.lock().iter().map(|c| c.0).collect();
        // Every "off" lets go on Windows, the second one too.
        assert_eq!(flags, [thread::HOLD, thread::RELEASE, thread::RELEASE]);
        assert!(flags.iter().all(|f| f & ES_DISPLAY_REQUIRED == 0));

        // One dedicated thread made every call, and it is not the caller's.
        let threads: Vec<_> = log.lock().iter().map(|c| c.1).collect();
        assert!(threads.iter().all(|t| *t == threads[0]));
        assert_ne!(threads[0], std::thread::current().id());
    }

    #[test]
    fn the_windows_thread_lets_go_when_dropped() {
        let (mut keep, log) = windows(thread::RELEASE);
        keep.set(true).unwrap();
        drop(keep);
        let flags: Vec<u32> = log.lock().iter().map(|c| c.0).collect();
        assert_eq!(flags.first(), Some(&thread::HOLD));
        assert_eq!(flags.last(), Some(&thread::RELEASE), "{flags:x?}");

        // Never held: dropping it calls nothing.
        let (keep, log) = windows(thread::RELEASE);
        drop(keep);
        assert!(log.lock().is_empty());
    }

    #[test]
    fn a_hold_windows_answers_0_to_is_an_error_and_let_go_of_at_once() {
        // 0 is the failure answer, but also the state before on a thread that
        // never set one: the hold may have taken, so it is let go of.
        let (mut keep, log) = windows(0);
        assert!(keep.set(true).unwrap_err().contains("Windows"));
        let calls = log.lock().clone();
        let flags: Vec<u32> = calls.iter().map(|c| c.0).collect();
        assert_eq!(flags, [thread::HOLD, thread::RELEASE], "the release came before the answer");
        assert!(calls.iter().all(|c| c.1 == calls[0].1), "on the thread that made the hold");
        assert_ne!(calls[0].1, std::thread::current().id());

        // Not held, and "off" lets go all the same; dropping it adds nothing.
        assert_eq!(keep.set(false), Ok(false));
        drop(keep);
        let flags: Vec<u32> = log.lock().iter().map(|c| c.0).collect();
        assert_eq!(flags, [thread::HOLD, thread::RELEASE, thread::RELEASE]);
    }

    #[test]
    fn on_windows_every_off_lets_go_even_when_nothing_is_held() {
        let (mut keep, log) = windows(thread::RELEASE);
        assert_eq!(keep.set(false), Ok(false));
        assert_eq!(keep.set(false), Ok(false));
        let flags: Vec<u32> = log.lock().iter().map(|c| c.0).collect();
        assert_eq!(flags, [thread::RELEASE, thread::RELEASE]);
        // Quitting and dropping still let go only of a hold that was taken.
        keep.release();
        drop(keep);
        assert_eq!(log.lock().len(), 2);
    }

    /// The app's holder, with a fake in it — the one test that touches it.
    #[test]
    fn release_lets_go_of_the_apps_holder() {
        let (keep, log) = fake(caffeinate_argv(4242));
        let before = HOLDER.lock().replace(keep);
        assert!(before.is_none(), "nothing else in the tests makes the app's holder");

        assert_eq!(set_keep_awake(true), Ok(true));
        assert_eq!(support(), Support { supported: true, method: "caffeinate" });
        release();
        assert_eq!(log.lock().stops, 1);
        release();
        assert_eq!(set_keep_awake(false), Ok(false));
        assert_eq!(log.lock().stops, 1);

        HOLDER.lock().take();
    }

    /// Quitting calls `exit`, which drops nothing, so every quit lets go
    /// first: both of commands/app.rs's and the `RunEvent::Exit` every other
    /// way of leaving ends in.
    #[test]
    fn the_quit_path_calls_release() {
        let app = include_str!("commands/app.rs");
        let production = &app[..app.find("\n#[cfg(test)]").expect("app.rs's tests")];
        assert_eq!(production.matches(".exit(").count(), 1, "every quit goes through `quit`");

        let quit = &production[production.find("\nfn quit(").expect("app.rs's quit")..];
        let quit = &quit[..quit.find("\n}").expect("the end of quit")];
        let released = quit.find("crate::power::release();").expect("quit lets go of keep-awake");
        assert!(released < quit.find("app.exit(0)").expect("quit exits"), "{quit}");

        let app_quit = &production[production.find("pub fn app_quit(").expect("app_quit")..];
        let app_quit = &app_quit[..app_quit.find("\n}").expect("the end of app_quit")];
        assert!(app_quit.contains("quit(&app)"), "{app_quit}");
        assert!(production.contains("quit(&quitter)"), "the macOS quit the page never answered");

        let main = include_str!("main.rs");
        let exit = &main[main.find("tauri::RunEvent::Exit = event").expect("the exit event")..];
        let exit = &exit[..exit.find('}').expect("the end of the exit arm")];
        assert!(exit.contains("power::release()"), "{exit}");
    }
}
