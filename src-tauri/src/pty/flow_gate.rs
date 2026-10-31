//! Flow control: a shell's output is read no faster than the page takes it
//! (stage 4).
//!
//! Without it the reader read as fast as the program wrote and sent it all
//! on. The page's xterm parses about 25 MB/s on this Mac, shared between
//! every terminal; four terminals flooding at once left it 18 s behind,
//! froze the window for 11 s at a time, grew the web view to 3 GB — and
//! lost output, because xterm throws a write away once 50 M characters are
//! waiting ("write data discarded, use flow control to avoid losing data",
//! xterm.js's WriteBuffer). Measured in the stage 4 baseline, S2.
//!
//! So each session counts the bytes it has sent that the page has not yet
//! said it read (`pty_ack`, after xterm's write callback — or at once for
//! output kept for a terminal that does not exist yet). Past HIGH_WATER the
//! reader stops reading; the program then waits in its own `write`, as it
//! would on any terminal that cannot keep up, and the reader starts again
//! once the count is back to LOW_WATER. What is waiting in a page in front
//! is never more than about HIGH_WATER, so a Ctrl+C — which goes in through
//! the writer thread, never held — shows its prompt a moment later, not
//! after everything the program printed before it. (Coming back to a window
//! that was minimised, or to a page that was silent, there can be up to the
//! FAR mark waiting: the price of a program that was not held meanwhile.)
//!
//! A page that stops answering: a reload says so (`pty_flow_reset`, every
//! count back to nothing). Anything else — a page napped, collecting
//! garbage, throttled to a timer a minute while minimised, or one whose
//! listener failed — is held for STALL with nothing acknowledged and is then
//! given the FAR mark instead of HIGH_WATER, until it says anything again.
//! Nothing it was sent is ever forgotten: an earlier version let the reader
//! go and started counting afresh, which fed a page that was only slow
//! another megabyte each time, without end — past xterm's 50 M characters it
//! throws writes away (found in two reviews). Bounded by FAR, what can wait
//! in one terminal's xterm stays under that limit — at most FAR (32 M; a
//! byte is at most one of xterm's characters) + HIDDEN_AHEAD acknowledged
//! early while hidden (8 M, terminalRegistry.js) + the backlog kept for a
//! terminal not made yet (1 M, ptyOutputBus.js) + a batch and a read past a
//! mark (0.3 M): about 41.3 M. Raise one of them and recount. A shell whose
//! page is silent still runs on for FAR more — to its exit, as a rule. The
//! price: a page in front silent for STALL (a long GC, a modal) lets every
//! flooding terminal run to FAR before it is held again, and a Ctrl+C there
//! waits behind that much.
//!
//! A minimised window is the one case where the page is not behind because
//! it parses slowly but because it is *given* the output slowly: measured on
//! macOS, a minimised WKWebView took two or three events a second whatever
//! its scheduling policy, so one terminal's 50 MB took 92 s and the program
//! wrote at 0.7 MB/s — against 2 s and 50 MB/s in front (with flow control
//! off it wrote at 91 MB/s and the page got it all 86 s later). v0.21.0
//! never held a program for that. So while every window is minimised
//! (`away`, kept by main.rs) the reader stops only past the FAR mark too —
//! far enough for a burst to run at full speed, still under the 50 M
//! characters at which xterm throws a write away once the window is back
//! (the page may run up to 8 M characters further ahead while hidden,
//! terminalRegistry.js HIDDEN_AHEAD; a byte is at most one character).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

/// Unread output in the page at which the reader stops.
pub const HIGH_WATER: u64 = 1024 * 1024;
/// ... and at or under which it starts again.
pub const LOW_WATER: u64 = 512 * 1024;
/// Held this long with nothing acknowledged: the page is not answering.
pub const STALL: Duration = Duration::from_secs(2);
/// Unread output at which the reader stops while every window is minimised,
/// or once the page has been silent for STALL; it reads again at half of it.
pub const AWAY_HIGH_WATER: u64 = 32 * 1024 * 1024;

struct State {
    unread: u64,
    last_ack: Instant,
    closed: bool,
    /// Held for STALL with no word from the page since: the FAR mark holds
    /// until it says anything.
    stalled: bool,
}

pub struct FlowGate {
    state: Mutex<State>,
    room: Condvar,
    high: u64,
    low: u64,
    stall: Duration,
    /// Every window minimised (see the module comment).
    away: Option<Arc<AtomicBool>>,
    /// How far behind a minimised or silent page may fall.
    far: u64,
}

impl FlowGate {
    pub fn new(high: u64, low: u64, stall: Duration) -> Self {
        Self {
            state: Mutex::new(State {
                unread: 0,
                last_ack: Instant::now(),
                closed: false,
                stalled: false,
            }),
            room: Condvar::new(),
            high,
            low: low.min(high),
            stall,
            away: None,
            far: AWAY_HIGH_WATER.max(high),
        }
    }

    /// While `away` is set, stop the reader only past `far` instead (and
    /// past `far` too once the page has been silent for the stall).
    pub fn with_away(mut self, away: Arc<AtomicBool>, far: u64) -> Self {
        self.away = Some(away);
        self.far = far.max(self.high);
        self
    }

    /// Where the reader stops, and where it reads again, as things are now.
    fn marks(&self, state: &State) -> (u64, u64) {
        let away = self.away.as_ref().is_some_and(|away| away.load(Ordering::Relaxed));
        if away || state.stalled {
            (self.far, self.low.max(self.far / 2))
        } else {
            (self.high, self.low)
        }
    }

    /// `bytes` of output went to the page.
    pub fn sent(&self, bytes: u64) {
        self.state.lock().unread += bytes;
    }

    /// The page has read `bytes` of it.
    pub fn acked(&self, bytes: u64) {
        let mut state = self.state.lock();
        state.unread = state.unread.saturating_sub(bytes);
        state.last_ack = Instant::now();
        state.stalled = false;
        if state.unread <= self.marks(&state).1 {
            self.room.notify_all();
        }
    }

    /// The page starts over (a reload): whatever it had not read is gone.
    pub fn reset(&self) {
        let mut state = self.state.lock();
        state.unread = 0;
        state.last_ack = Instant::now();
        state.stalled = false;
        self.room.notify_all();
    }

    /// The session is over: never hold its reader again.
    pub fn close(&self) {
        self.state.lock().closed = true;
        self.room.notify_all();
    }

    /// How much the page has not read yet.
    pub fn unread(&self) -> u64 {
        self.state.lock().unread
    }

    /// Before the next read: wait while the page is HIGH_WATER behind,
    /// until it is back to LOW_WATER. Whether the reader was held.
    pub fn wait_for_room(&self) -> bool {
        let mut state = self.state.lock();
        if state.closed || state.unread <= self.marks(&state).0 {
            return false;
        }
        let held_since = Instant::now();
        loop {
            // Woken by an acknowledgement, or every 250 ms — which is also
            // how a window minimised meanwhile is noticed.
            self.room.wait_for(&mut state, Duration::from_millis(250));
            // Silent since the hold began, or since its last word: an
            // acknowledgement from before the hold says nothing about now.
            // From then on the far mark, nothing forgotten (module comment).
            if !state.stalled && state.last_ack.max(held_since).elapsed() >= self.stall {
                state.stalled = true;
            }
            if state.closed || state.unread <= self.marks(&state).1 {
                return true;
            }
        }
    }
}

impl Default for FlowGate {
    fn default() -> Self {
        Self::new(HIGH_WATER, LOW_WATER, STALL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn under_the_high_water_nothing_waits() {
        let gate = FlowGate::new(100, 50, STALL);
        gate.sent(100);
        assert!(!gate.wait_for_room(), "at the mark is not past it");
    }

    #[test]
    fn past_the_high_water_the_reader_waits_for_the_low_water() {
        let gate = Arc::new(FlowGate::new(100, 50, Duration::from_secs(10)));
        gate.sent(150);
        let waiting = {
            let gate = gate.clone();
            thread::spawn(move || {
                let started = Instant::now();
                assert!(gate.wait_for_room());
                started.elapsed()
            })
        };
        thread::sleep(Duration::from_millis(50));
        gate.acked(60);
        thread::sleep(Duration::from_millis(50));
        assert!(!waiting.is_finished(), "90 unread is still above the low water");
        gate.acked(40);
        let waited = waiting.join().unwrap();
        assert!(waited >= Duration::from_millis(90), "held until the page caught up: {waited:?}");
        assert_eq!(gate.unread(), 50);
    }

    #[test]
    fn a_silent_page_is_given_the_far_mark_after_the_stall_and_nothing_is_forgotten() {
        let gate = Arc::new(FlowGate::new(10, 5, Duration::from_millis(300)).with_away(Arc::new(AtomicBool::new(false)), 5_000));
        gate.sent(1000);
        let started = Instant::now();
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        // Bounded: a reader the stall never lets go must fail here, not hang.
        while !reader.is_finished() && started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(20));
        }
        let waited = started.elapsed();
        if !reader.is_finished() {
            gate.close();
        }
        assert!(reader.join().unwrap());
        assert!(waited >= Duration::from_millis(300) && waited < Duration::from_secs(3), "let go after {waited:?}");
        assert_eq!(gate.unread(), 1000, "what it was sent is still owed");
        // Silent still: reads on to the far mark, then is held there for good.
        gate.sent(3000);
        assert!(!gate.wait_for_room(), "under the far mark");
        gate.sent(3000);
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        thread::sleep(Duration::from_millis(800));
        assert!(!reader.is_finished(), "past the far mark a silent page is never let go again");
        gate.acked(7000);
        assert!(reader.join().unwrap());
    }

    #[test]
    fn a_page_silent_for_long_is_never_sent_more_than_the_far_mark() {
        // Found in two reviews: letting a silent page's reader go and counting
        // afresh fed a page that was only slow (napped; a minimised WebView2's
        // timer once a minute) without end, 13× HIGH in 3 s — past xterm's
        // 50 M characters it throws writes away.
        let gate = Arc::new(FlowGate::new(1000, 500, Duration::from_millis(100)).with_away(Arc::new(AtomicBool::new(false)), 5_000));
        let writer = {
            let gate = gate.clone();
            thread::spawn(move || loop {
                gate.wait_for_room();
                gate.sent(100);
                if gate.unread() > 5_100 {
                    break;
                }
            })
        };
        thread::sleep(Duration::from_secs(2));
        assert!(gate.unread() <= 5_100, "{} B owed by a page that read nothing", gate.unread());
        gate.close();
        let _ = writer.join();
    }

    #[test]
    fn a_word_from_the_page_ends_the_stall() {
        let gate = Arc::new(FlowGate::new(10, 5, Duration::from_millis(100)).with_away(Arc::new(AtomicBool::new(false)), 5_000));
        gate.sent(100);
        let stalled = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        thread::sleep(Duration::from_millis(1500));
        let let_go = stalled.is_finished();
        gate.close();
        assert!(stalled.join().unwrap());
        assert!(let_go, "stalled: the far mark lets it go");
        let gate = Arc::new(FlowGate::new(10, 5, Duration::from_millis(100)).with_away(Arc::new(AtomicBool::new(false)), 5_000));
        gate.sent(100);
        assert!(gate.wait_for_room(), "stalled: the far mark");
        gate.acked(1);
        // 99 owed, the page answering: back to the usual marks.
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        thread::sleep(Duration::from_millis(60));
        assert!(!reader.is_finished(), "an answering page is waited for at the usual mark");
        gate.acked(99);
        assert!(reader.join().unwrap());
    }

    #[test]
    fn while_every_window_is_minimised_the_page_may_fall_far_further_behind() {
        let away = Arc::new(AtomicBool::new(true));
        let gate = Arc::new(FlowGate::new(100, 50, Duration::from_secs(30)).with_away(away.clone(), 10_000));
        gate.sent(5_000);
        assert!(!gate.wait_for_room(), "minimised: 5000 behind is not too far");
        gate.sent(6_000);
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        thread::sleep(Duration::from_millis(100));
        assert!(!reader.is_finished(), "past the away mark it is held all the same");
        gate.acked(6_000);
        assert!(reader.join().unwrap(), "and reads again at half of it");

        // Back in front: the usual marks at once.
        away.store(false, Ordering::Relaxed);
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        thread::sleep(Duration::from_millis(100));
        assert!(!reader.is_finished(), "in front, 5000 behind is too far");
        // Minimised while held: noticed within a poll, and let go.
        away.store(true, Ordering::Relaxed);
        let started = Instant::now();
        assert!(reader.join().unwrap());
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    }

    #[test]
    fn a_page_still_reading_is_not_a_stall() {
        let gate = Arc::new(FlowGate::new(10, 5, Duration::from_millis(300)));
        gate.sent(1000);
        let reader = {
            let gate = gate.clone();
            thread::spawn(move || gate.wait_for_room())
        };
        // Slow but steady: an acknowledgement every 100 ms, never all at once.
        for _ in 0..8 {
            thread::sleep(Duration::from_millis(100));
            gate.acked(1);
            assert!(!reader.is_finished(), "a page that answers is waited for");
        }
        gate.acked(1000);
        assert!(reader.join().unwrap());
    }

    #[test]
    fn closing_or_resetting_lets_a_held_reader_go() {
        for how in ["close", "reset"] {
            let gate = Arc::new(FlowGate::new(10, 5, Duration::from_secs(10)));
            gate.sent(100);
            let reader = {
                let gate = gate.clone();
                thread::spawn(move || gate.wait_for_room())
            };
            thread::sleep(Duration::from_millis(50));
            if how == "close" {
                gate.close();
            } else {
                gate.reset();
            }
            assert!(reader.join().unwrap(), "{how}");
        }
        let closed = FlowGate::new(10, 5, STALL);
        closed.close();
        closed.sent(100);
        assert!(!closed.wait_for_room(), "a closed session never holds its reader");
    }

    /// A real program on a real PTY, read through the gate by a page that
    /// takes its time: the program is made to wait, the page is never more
    /// than the high water (and one read) behind, and every byte arrives.
    #[cfg(unix)]
    #[test]
    fn a_real_program_waits_while_the_page_is_behind() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::sync::mpsc;

        const TOTAL: usize = 4_000_000;
        const HIGH: u64 = 256 * 1024;
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        // No CR added to the LF, so what arrives can be counted exactly.
        cmd.args(["-c", &format!("stty -onlcr; head -c {TOTAL} /dev/zero | tr '\\0' x; printf '\\ndone\\n'")]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let gate = Arc::new(FlowGate::new(HIGH, HIGH / 2, Duration::from_secs(30)));
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let reading = {
            let gate = gate.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let mut held = 0;
                loop {
                    if gate.wait_for_room() {
                        held += 1;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            gate.sent(n as u64);
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
                held
            })
        };
        // The page: about 13 MB/s, far slower than the program writes.
        let mut seen = Vec::with_capacity(TOTAL + 16);
        let mut most_behind = 0;
        let mut since_pause = 0;
        while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(20)) {
            most_behind = most_behind.max(gate.unread());
            seen.extend_from_slice(&chunk);
            since_pause += chunk.len();
            if since_pause >= 64 * 1024 {
                thread::sleep(Duration::from_millis(5));
                since_pause = 0;
            }
            gate.acked(chunk.len() as u64);
            if seen.ends_with(b"done\n") {
                break;
            }
        }
        let _ = child.wait();
        drop(pair.master);
        let held = reading.join().expect("reader");
        let xs = seen.iter().filter(|&&b| b == b'x').count();
        assert_eq!(xs, TOTAL, "every byte the program wrote arrived");
        assert!(seen.ends_with(b"\ndone\n"), "and in order, the last line last");
        assert!(held > 0, "the reader was held at least once");
        assert!(most_behind <= HIGH + 4096, "never more than the high water and one read behind: {most_behind}");
    }

    #[test]
    fn acknowledging_more_than_was_sent_cannot_go_below_nothing() {
        let gate = FlowGate::new(10, 5, STALL);
        gate.sent(3);
        gate.acked(100);
        assert_eq!(gate.unread(), 0);
        gate.sent(4);
        assert_eq!(gate.unread(), 4);
    }
}
