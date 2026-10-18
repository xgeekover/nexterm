//! Whether a terminal is asking for a password (spec P4): its typing hidden.
//!
//! A program that reads a password turns the terminal's ECHO off and reads a
//! line, so what is typed is not shown. The line discipline's state says so,
//! and `tcgetattr` on the MASTER side reads the state the slave is running
//! under — the same read `is_canonical` makes for the long-line guard.
//!
//! The rule is **ECHO off and ICANON on**. Echo alone is not enough: zsh's
//! line editor and readline turn ECHO *and* ICANON off at every ordinary
//! prompt (they draw what is typed themselves), and a full-screen program is
//! raw, ECHO off too. What reads a password — sudo, ssh, `read -s`,
//! getpass(3), readpassphrase(3) — keeps the line discipline in canonical
//! mode and only turns echo off. So the rule never fires at a shell prompt
//! nor in vim, and fires for every password prompt that goes through the
//! tty.
//!
//! Unix only. On Windows a program's console input mode (ENABLE_ECHO_INPUT,
//! ENABLE_LINE_INPUT) belongs to the console's input buffer, which only a
//! process ATTACHED to that console can read (`GetConsoleMode` takes a handle
//! to it); the host of a pseudoconsole holds the two pipes and an HPCON, and
//! the pseudoconsole API has no call that reports the client's mode (checked
//! against the bindings this build compiles with: windows 0.62's
//! Win32::System::Console offers CreatePseudoConsole, ResizePseudoConsole and
//! ClosePseudoConsole, nothing else, and portable-pty loads the same three).
//! ConPTY does not report an echo change in the VT stream either. Attaching
//! a helper process to the client's console to call `GetConsoleMode` would
//! be a process per check and a race with the client; it is not done, and
//! Windows shows no lock.
//!
//! WHEN it is read: after output, at most every `ECHO_CHECK_INTERVAL`, on a
//! thread of its own (`EchoWatch`). A program that asks for a password says
//! so — it prints a prompt — so output is the moment to look; a check that
//! the rate limit holds back is made when the interval is up, so the prompt
//! printed right after another line is still seen. And once output stops,
//! three more reads (`TRAILING_READS`: about 250 ms, 1 s and 3 s after it),
//! for the program that prints its prompt first and turns echo off after.
//! While the terminal is secret it is also read every interval with no
//! output at all, so the lock goes as soon as echo comes back. The reader
//! thread only flips a flag per chunk it reads — no syscall per byte or per
//! chunk on its side — and heavy output costs at most one `tcgetattr` per
//! interval.
//!
//! What is SENT: `pty-echo { session_id, secret }`, only when the answer
//! changes — and once, `secret: false`, when a session that ends secret
//! ends, so nothing is left locked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use portable_pty::MasterPty;

/// The least time between two reads of a terminal's mode.
pub(crate) const ECHO_CHECK_INTERVAL: Duration = Duration::from_millis(250);

/// When the terminal is read again after its output has stopped, counted
/// from the last output: the shell-script idiom prints its prompt and only
/// then turns echo off (`printf 'Password: '; stty -echo; read pw`), so the
/// read that the prompt's output brings is too early, and nothing is printed
/// after it. Three reads, then none while the terminal stays quiet.
pub(crate) const TRAILING_READS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(1000),
    Duration::from_millis(3000),
];

/// The password rule on a termios's local flags: echo off, canonical on.
pub(crate) fn secret_mode(local_flags: libc::tcflag_t) -> bool {
    (local_flags & libc::ECHO) == 0 && (local_flags & libc::ICANON) != 0
}

/// Whether the program reading this terminal has its typing hidden
/// (`secret_mode`), or `None` when the mode cannot be read.
pub(crate) fn input_hidden(master: &(dyn MasterPty + Send)) -> Option<bool> {
    let fd = master.as_raw_fd()?;
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: `tcgetattr` fills a zeroed termios for an fd we own.
    if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
        return None;
    }
    Some(secret_mode(termios.c_lflag))
}

/// What the reader thread and the watch thread share.
struct Shared {
    /// Output arrived since the last read of the mode.
    output: AtomicBool,
    /// The session's stream ended: the watch says its last word and stops.
    done: AtomicBool,
    /// Only for sleeping on: the flags above are the state.
    lock: Mutex<()>,
    wake: Condvar,
}

impl Shared {
    fn notify(&self) {
        // Taken before notifying, so a watcher that has just found nothing
        // to do and is about to wait cannot miss this.
        let _guard = self.lock.lock();
        self.wake.notify_one();
    }
}

/// Watches one session's terminal for a hidden-typing prompt. See the module
/// documentation for when it looks and what it says.
pub(crate) struct EchoWatch {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl EchoWatch {
    /// Start watching. `probe` reads the mode (`input_hidden` on the
    /// session's master); `emit` hears every change, and a closing `false`.
    pub(crate) fn start<P, E>(name: String, interval: Duration, mut probe: P, mut emit: E) -> std::io::Result<Self>
    where
        P: FnMut() -> Option<bool> + Send + 'static,
        E: FnMut(bool) + Send + 'static,
    {
        let shared = Arc::new(Shared {
            output: AtomicBool::new(false),
            done: AtomicBool::new(false),
            lock: Mutex::new(()),
            wake: Condvar::new(),
        });
        let watched = shared.clone();
        let thread = thread::Builder::new().name(name).spawn(move || {
            let shared = watched;
            let mut secret = false;
            let mut last_read: Option<Instant> = None;
            // The trailing reads still to come since the last output.
            let mut trailing: Vec<Instant> = Vec::new();
            loop {
                // Wait for output, for the next trailing read, or — while
                // secret — for the next interval, to look again with none.
                let mut output = false;
                {
                    let mut guard = shared.lock.lock();
                    loop {
                        if shared.done.load(Ordering::Acquire) {
                            break;
                        }
                        if shared.output.load(Ordering::Acquire) {
                            output = true;
                            break;
                        }
                        let wake_at = if secret {
                            Some(last_read.map_or_else(Instant::now, |at| at + interval))
                        } else {
                            trailing.first().copied()
                        };
                        match wake_at {
                            Some(at) if Instant::now() >= at => break,
                            Some(at) => {
                                shared.wake.wait_until(&mut guard, at);
                            }
                            None => shared.wake.wait(&mut guard),
                        }
                    }
                }
                if shared.done.load(Ordering::Acquire) {
                    break;
                }
                let now = Instant::now();
                if output {
                    // Output again: the trailing reads count from here.
                    trailing = TRAILING_READS.iter().map(|after| now + *after).collect();
                } else {
                    trailing.retain(|at| *at > now);
                }
                // The rate limit: not sooner than `interval` after the last
                // read. Output meanwhile is folded into this one read.
                if let Some(at) = last_read {
                    let next = at + interval;
                    let mut guard = shared.lock.lock();
                    while !shared.done.load(Ordering::Acquire) && Instant::now() < next {
                        shared.wake.wait_until(&mut guard, next);
                    }
                }
                if shared.done.load(Ordering::Acquire) {
                    break;
                }
                // Cleared BEFORE reading, so output that lands during the
                // read asks for another.
                shared.output.store(false, Ordering::Release);
                last_read = Some(Instant::now());
                if let Some(now) = probe() {
                    if now != secret {
                        secret = now;
                        emit(secret);
                    }
                }
            }
            // A session that ends secret leaves nothing locked.
            if secret {
                emit(false);
            }
        })?;
        Ok(Self { shared, thread: Some(thread) })
    }

    /// Output arrived. Called by the reader thread for every chunk it reads:
    /// an atomic swap, and a wake-up only when none is pending already.
    pub(crate) fn output(&self) {
        if !self.shared.output.swap(true, Ordering::AcqRel) {
            self.shared.notify();
        }
    }

    /// The stream ended: stop, after the closing `false` if the terminal was
    /// secret. Waits for that, so it is sent before whatever the caller sends
    /// next (`pty-exit`).
    pub(crate) fn finish(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.shared.done.store(true, Ordering::Release);
        self.shared.notify();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for EchoWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    /// A real shell in a real pty running `script`, its output drained (and
    /// counted as output to `watch`, when given). Returns the master and the
    /// child.
    fn shell(script: &str) -> (Box<dyn MasterPty + Send>, Box<dyn portable_pty::Child + Send + Sync>, Box<dyn Read + Send>) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(script);
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().expect("reader");
        (pair.master, child, reader)
    }

    /// Drain `reader` on a thread, telling `on_output` about every chunk.
    fn drain(mut reader: Box<dyn Read + Send>, on_output: impl Fn() + Send + 'static) {
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                on_output();
            }
        });
    }

    fn mode_of(script: &str) -> Option<bool> {
        let (master, mut child, reader) = shell(script);
        drain(reader, || {});
        thread::sleep(Duration::from_millis(400)); // let `stty` take effect
        let mode = input_hidden(master.as_ref());
        let _ = child.kill();
        let _ = child.wait();
        mode
    }

    #[test]
    fn the_rule_is_echo_off_and_canonical_on() {
        let echo = libc::ECHO;
        let icanon = libc::ICANON;
        assert!(secret_mode(icanon), "canonical, no echo: a password prompt");
        assert!(!secret_mode(icanon | echo), "canonical with echo: a program reading a line");
        assert!(!secret_mode(0), "neither: a line editor at a prompt, or a full-screen program");
        assert!(!secret_mode(echo), "echo without canonical");
    }

    /// The three states on a real terminal, read the way the watch reads
    /// them, with `cat` holding the terminal — `cat` leaves the mode as
    /// `stty` set it, where a shell's own line editor would change it.
    #[test]
    fn a_real_terminal_reads_as_secret_only_with_echo_off_and_canonical_on() {
        assert_eq!(mode_of("stty sane -echo; cat"), Some(true), "`stty -echo`: what sudo and ssh leave it in");
        assert_eq!(
            mode_of("stty sane -icanon -echo; cat"),
            Some(false),
            "`stty -icanon -echo`: what zsh's line editor and readline leave at every prompt"
        );
        assert_eq!(mode_of("stty sane; cat"), Some(false), "`stty echo`: an ordinary terminal");
    }

    type Said = Arc<std::sync::Mutex<Vec<(Instant, bool)>>>;

    fn watch_master(master: &Arc<std::sync::Mutex<Box<dyn MasterPty + Send>>>, said: &Said, probes: &Arc<std::sync::atomic::AtomicUsize>) -> EchoWatch {
        let probed = master.clone();
        let count = probes.clone();
        let heard = said.clone();
        EchoWatch::start(
            "echo-watch-test".into(),
            ECHO_CHECK_INTERVAL,
            move || {
                count.fetch_add(1, Ordering::Relaxed);
                input_hidden(probed.lock().unwrap().as_ref())
            },
            move |secret| heard.lock().unwrap().push((Instant::now(), secret)),
        )
        .expect("watch")
    }

    /// A password prompt as sudo makes one — echo off, a prompt, a pause,
    /// echo back on — is told once each way, and nothing in between, though
    /// the terminal is read every interval while it is secret.
    #[test]
    fn a_prompt_is_told_once_as_it_comes_and_once_as_it_goes() {
        let (master, mut child, reader) =
            shell("stty sane; printf 'ready\\n'; sleep 0.6; stty -echo; printf 'Password:'; sleep 1.2; stty echo; printf '\\n'; sleep 30");
        let master = Arc::new(std::sync::Mutex::new(master));
        let said: Said = Arc::default();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(watch_master(&master, &said, &probes));
        let fed = watch.clone();
        drain(reader, move || fed.output());
        thread::sleep(Duration::from_millis(3200));
        let told: Vec<bool> = said.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(told, vec![true, false], "told {told:?}, not once each way");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The shell-script idiom, prompt first and echo off after it — the
    /// prompt's output is read while echo is still on, and nothing is printed
    /// after `stty`. Seen all the same, by the reads that follow output once
    /// it has stopped (`TRAILING_READS`).
    #[test]
    fn a_prompt_printed_before_echo_goes_off_is_still_seen() {
        let (master, mut child, reader) = shell("printf 'Password: '; stty -echo; read pw");
        let master = Arc::new(std::sync::Mutex::new(master));
        let said: Said = Arc::default();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(watch_master(&master, &said, &probes));
        let fed = watch.clone();
        drain(reader, move || fed.output());
        thread::sleep(Duration::from_millis(1600));
        let told: Vec<bool> = said.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(told, vec![true], "told {told:?}");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// After output stops the terminal is read a few more times — then not at
    /// all while it stays quiet and not secret.
    #[test]
    fn a_quiet_terminal_is_read_a_few_times_after_its_output_and_then_left_alone() {
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = probes.clone();
        let watch = EchoWatch::start("echo-watch-quiet".into(), ECHO_CHECK_INTERVAL, move || {
            count.fetch_add(1, Ordering::Relaxed);
            Some(false)
        }, |_| panic!("nothing changed, nothing is told"))
        .expect("watch");
        watch.output();
        thread::sleep(Duration::from_millis(4500));
        let after_trailing = probes.load(Ordering::Relaxed);
        assert!(
            (2..=1 + TRAILING_READS.len()).contains(&after_trailing),
            "{after_trailing} reads after one burst of output; the first and {} trailing ones expected",
            TRAILING_READS.len()
        );
        thread::sleep(Duration::from_millis(1500));
        assert_eq!(probes.load(Ordering::Relaxed), after_trailing, "a quiet terminal was read again");
        watch.finish();
    }

    /// Echo coming back with nothing printed — a program killed at its prompt
    /// that restores the terminal silently — still takes the lock down: a
    /// secret terminal is read every interval, output or not.
    #[test]
    fn the_lock_goes_when_echo_returns_with_nothing_printed() {
        let (master, mut child, reader) =
            shell("stty sane; stty -echo; printf 'Password:'; sleep 0.8; stty echo; sleep 30");
        let master = Arc::new(std::sync::Mutex::new(master));
        let said: Said = Arc::default();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(watch_master(&master, &said, &probes));
        let fed = watch.clone();
        drain(reader, move || fed.output());
        thread::sleep(Duration::from_millis(1600));
        let told: Vec<bool> = said.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(told, vec![true, false], "told {told:?}");
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The rate limit: however often output arrives, the terminal is read at
    /// most once per interval (plus the first read).
    #[test]
    fn output_in_a_tight_loop_reads_the_mode_at_most_once_per_interval() {
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = probes.clone();
        let watch = EchoWatch::start("echo-watch-rate".into(), ECHO_CHECK_INTERVAL, move || {
            count.fetch_add(1, Ordering::Relaxed);
            Some(false)
        }, |_| panic!("nothing changed, nothing is told"))
        .expect("watch");
        let started = Instant::now();
        let mut calls = 0u64;
        while started.elapsed() < Duration::from_millis(1000) {
            watch.output();
            calls += 1;
        }
        let elapsed = started.elapsed();
        watch.finish();
        let read = probes.load(Ordering::Relaxed) as u128;
        let most = elapsed.as_millis() / ECHO_CHECK_INTERVAL.as_millis() + 1;
        assert!(read <= most, "{read} reads in {elapsed:?} — the limit allows {most}");
        assert!(read >= 2, "output kept coming, yet the mode was read {read} time(s)");
        // What the reader thread pays per chunk: well under a microsecond.
        let per_call = elapsed.as_nanos() / u128::from(calls.max(1));
        assert!(per_call < 2_000, "output() costs {per_call} ns a call");
    }

    /// Heavy output from a real program, its mode never changing: nothing is
    /// told, and the terminal is read no more than the limit allows.
    #[test]
    fn heavy_output_tells_nothing_and_reads_within_the_limit() {
        let (master, mut child, reader) = shell("stty sane; yes 'a line of output to keep the reader busy'");
        let master = Arc::new(std::sync::Mutex::new(master));
        let said: Said = Arc::default();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(watch_master(&master, &said, &probes));
        let chunks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (fed, counted) = (watch.clone(), chunks.clone());
        let started = Instant::now();
        drain(reader, move || {
            counted.fetch_add(1, Ordering::Relaxed);
            fed.output();
        });
        thread::sleep(Duration::from_millis(1500));
        let elapsed = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        let read = probes.load(Ordering::Relaxed) as u128;
        let most = elapsed.as_millis() / ECHO_CHECK_INTERVAL.as_millis() + 2;
        assert!(chunks.load(Ordering::Relaxed) > 100, "setup: the program printed little");
        assert!(read <= most, "{read} reads in {elapsed:?} — the limit allows {most}");
        assert!(said.lock().unwrap().is_empty(), "told {:?} though nothing changed", said.lock().unwrap());
    }

    /// A session that ends while secret is told `false` once as it ends —
    /// before `finish` returns, so before the caller's `pty-exit`.
    #[test]
    fn a_session_ending_secret_is_told_false_before_it_is_over() {
        let said: Said = Arc::default();
        let heard = said.clone();
        let watch = EchoWatch::start("echo-watch-end".into(), Duration::from_millis(20), || Some(true), move |secret| {
            heard.lock().unwrap().push((Instant::now(), secret));
        })
        .expect("watch");
        watch.output();
        thread::sleep(Duration::from_millis(100));
        watch.finish();
        let told: Vec<bool> = said.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(told, vec![true, false]);

        // And one that ends clear says nothing more.
        let quiet: Said = Arc::default();
        let heard = quiet.clone();
        let watch = EchoWatch::start("echo-watch-end-clear".into(), Duration::from_millis(20), || Some(false), move |secret| {
            heard.lock().unwrap().push((Instant::now(), secret));
        })
        .expect("watch");
        watch.output();
        thread::sleep(Duration::from_millis(60));
        watch.finish();
        assert!(quiet.lock().unwrap().is_empty());
    }

    /// A prompt printed right after other output — inside the interval the
    /// first read started — is still seen: the held-back read is made when
    /// the interval is up, with no further output to prompt it.
    #[test]
    fn a_prompt_inside_the_interval_is_seen_by_the_trailing_read() {
        let (master, mut child, reader) =
            shell("stty sane; printf 'a line\\n'; stty -echo; printf 'Password:'; sleep 30");
        let master = Arc::new(std::sync::Mutex::new(master));
        let said: Said = Arc::default();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let watch = Arc::new(watch_master(&master, &said, &probes));
        let fed = watch.clone();
        drain(reader, move || fed.output());
        thread::sleep(Duration::from_millis(900));
        let told: Vec<bool> = said.lock().unwrap().iter().map(|(_, s)| *s).collect();
        assert_eq!(told, vec![true], "told {told:?}");
        let _ = child.kill();
        let _ = child.wait();
    }
}
