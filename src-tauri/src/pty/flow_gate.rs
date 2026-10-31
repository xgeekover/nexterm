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
//! once the count is back to LOW_WATER. What is waiting in the page is
//! never more than about HIGH_WATER, so a Ctrl+C — which goes in through
//! the writer thread, never held — shows its prompt a moment later, not
//! after everything the program printed before it.
//!
//! A page that stops answering must not stop a shell for good: a reload
//! (whose new page says so with `pty_flow_reset`), a listener that failed.
//! A reader held for STALL with no acknowledgement at all goes on reading
//! and starts counting afresh.

use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

/// Unread output in the page at which the reader stops.
pub const HIGH_WATER: u64 = 1024 * 1024;
/// ... and at or under which it starts again.
pub const LOW_WATER: u64 = 512 * 1024;
/// Held this long with nothing acknowledged: the page is not answering.
pub const STALL: Duration = Duration::from_secs(2);

struct State {
    unread: u64,
    last_ack: Instant,
    closed: bool,
}

pub struct FlowGate {
    state: Mutex<State>,
    room: Condvar,
    high: u64,
    low: u64,
    stall: Duration,
}

impl FlowGate {
    pub fn new(high: u64, low: u64, stall: Duration) -> Self {
        Self {
            state: Mutex::new(State {
                unread: 0,
                last_ack: Instant::now(),
                closed: false,
            }),
            room: Condvar::new(),
            high,
            low: low.min(high),
            stall,
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
        if state.unread <= self.low {
            self.room.notify_all();
        }
    }

    /// The page starts over (a reload): whatever it had not read is gone.
    pub fn reset(&self) {
        let mut state = self.state.lock();
        state.unread = 0;
        state.last_ack = Instant::now();
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
        if state.closed || state.unread <= self.high {
            return false;
        }
        let held_since = Instant::now();
        loop {
            self.room.wait_for(&mut state, Duration::from_millis(250));
            if state.closed || state.unread <= self.low {
                return true;
            }
            // Silent since the hold began, or since its last word: an
            // acknowledgement from before the hold says nothing about now.
            if state.last_ack.max(held_since).elapsed() >= self.stall {
                state.unread = 0;
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
    fn a_silent_page_holds_the_reader_only_for_the_stall() {
        let gate = FlowGate::new(10, 5, Duration::from_millis(300));
        gate.sent(1000);
        let started = Instant::now();
        assert!(gate.wait_for_room());
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(300) && waited < Duration::from_secs(3), "{waited:?}");
        assert_eq!(gate.unread(), 0, "and counting starts again");
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
