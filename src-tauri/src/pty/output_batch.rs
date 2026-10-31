//! A session's output, sent to the page in fewer and larger `pty-output`
//! events (stage 4: several agents printing at once).
//!
//! Every event costs the page one script evaluation — Tauri hands an event
//! to the web view as `eval(<a script holding the JSON>)` — and macOS gives a
//! PTY reader about a kilobyte per `read`. One terminal taking a big file
//! made about 16,800 events a second (S1 of the stage 4 baseline), each a
//! script for the page to parse and run on the thread that also draws.
//!
//! The rule:
//!
//! - Output after a quiet spell goes at once: the echo of a key, a prompt, a
//!   line from a slow log. Quiet means nothing was sent for a window.
//! - Output that arrives while output is flowing is held, and goes out at
//!   most a window after the first of it was held, or as soon as `max` bytes
//!   are held. So nothing waits longer than a window, and a flood becomes
//!   one event per window.
//! - A marker (a command started or finished, the folder, a title) sends
//!   what is held first: it never overtakes the output it came after, which
//!   is what the sticky command header and the attention signals read it
//!   against.
//! - The end of the stream sends what is held, before the reader reports
//!   the exit.
//!
//! The reader thread keeps reading; a thread of the session's own sends
//! (`run_emitter`), because the reader sits in a blocking `read` and could
//! not keep a deadline. A window of zero sends every read as it comes, which
//! is how it was before — what a measuring run compares against.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use super::osc::Marker;

/// How long output may be held while more of it is arriving.
pub const DEFAULT_WINDOW: Duration = Duration::from_millis(8);
/// How much may be held before it goes regardless.
pub const DEFAULT_MAX: usize = 256 * 1024;

/// What the reader hands the sender, in the order it read it — and what
/// the sender then sends, in the same order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    Output(String),
    Marker(Marker),
}

/// When to send held output. Driven by the caller's clock, so it can be
/// tested without one.
pub struct Batcher {
    window: Duration,
    max: usize,
    held: String,
    held_since: Option<Instant>,
    last_sent: Option<Instant>,
}

impl Batcher {
    pub fn new(window: Duration, max: usize) -> Self {
        Self {
            window,
            max: max.max(1),
            held: String::new(),
            held_since: None,
            last_sent: None,
        }
    }

    /// Output just read, at `now`: what to send now, if anything.
    pub fn push(&mut self, data: String, now: Instant) -> Option<String> {
        if data.is_empty() {
            return None;
        }
        let quiet = self.held.is_empty()
            && self
                .last_sent
                .map_or(true, |sent| now.saturating_duration_since(sent) >= self.window);
        if quiet {
            self.last_sent = Some(now);
            return Some(data);
        }
        if self.held.is_empty() {
            self.held_since = Some(now);
            self.held = data;
        } else {
            self.held.push_str(&data);
        }
        // Full, or past its deadline: output that keeps arriving never lets
        // the sender's wait time out, so the deadline is kept here as well.
        if self.held.len() >= self.max || self.deadline().is_some_and(|deadline| now >= deadline) {
            return self.take(now);
        }
        None
    }

    /// When what is held has to go, if anything is held.
    pub fn deadline(&self) -> Option<Instant> {
        self.held_since.map(|since| since + self.window)
    }

    /// Everything held, to send now: at the deadline, before a marker, at the end.
    pub fn take(&mut self, now: Instant) -> Option<String> {
        if self.held.is_empty() {
            return None;
        }
        self.held_since = None;
        self.last_sent = Some(now);
        Some(std::mem::take(&mut self.held))
    }
}

/// Send what `rx` brings through `send`, output batched by `batcher`,
/// until the reader lets go of its end; then what is still held.
pub fn run_emitter(rx: Receiver<Outgoing>, mut batcher: Batcher, mut send: impl FnMut(Outgoing)) {
    loop {
        let next = match batcher.deadline() {
            Some(deadline) => match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(item) => item,
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(data) = batcher.take(Instant::now()) {
                        send(Outgoing::Output(data));
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(item) => item,
                Err(_) => break,
            },
        };
        match next {
            Outgoing::Output(data) => {
                if let Some(data) = batcher.push(data, Instant::now()) {
                    send(Outgoing::Output(data));
                }
            }
            Outgoing::Marker(marker) => {
                if let Some(data) = batcher.take(Instant::now()) {
                    send(Outgoing::Output(data));
                }
                send(Outgoing::Marker(marker));
            }
        }
    }
    if let Some(data) = batcher.take(Instant::now()) {
        send(Outgoing::Output(data));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    const W: Duration = Duration::from_millis(8);

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn output_after_a_quiet_spell_goes_at_once() {
        let t0 = Instant::now();
        let mut b = Batcher::new(W, 1024);
        assert_eq!(b.push("a".into(), t0).as_deref(), Some("a"), "the first output of all");
        assert_eq!(b.push("b".into(), t0 + ms(20)).as_deref(), Some("b"), "a key's echo after a pause");
        assert!(b.deadline().is_none(), "nothing held");
    }

    #[test]
    fn output_while_output_flows_waits_at_most_a_window() {
        let t0 = Instant::now();
        let mut b = Batcher::new(W, 1024);
        assert!(b.push("1".into(), t0).is_some());
        assert_eq!(b.push("2".into(), t0 + ms(1)), None);
        assert_eq!(b.push("3".into(), t0 + ms(5)), None);
        assert_eq!(b.deadline(), Some(t0 + ms(1) + W), "a window after the first of it was held");
        assert_eq!(b.take(t0 + ms(9)).as_deref(), Some("23"));
        // Still flowing: the next is held again, not sent alone.
        assert_eq!(b.push("4".into(), t0 + ms(10)), None);
        assert_eq!(b.take(t0 + ms(18)).as_deref(), Some("4"));
        assert_eq!(b.take(t0 + ms(19)), None);
    }

    #[test]
    fn output_arriving_past_the_deadline_goes_with_what_was_held() {
        let t0 = Instant::now();
        let mut b = Batcher::new(W, 1024);
        assert!(b.push("1".into(), t0).is_some());
        assert_eq!(b.push("2".into(), t0 + ms(1)), None);
        assert_eq!(b.push("3".into(), t0 + ms(5)), None);
        // The window of what was held ended at 9 ms: this goes, and the rest with it.
        assert_eq!(b.push("4".into(), t0 + ms(12)).as_deref(), Some("234"));
        assert!(b.deadline().is_none());
    }

    #[test]
    fn a_full_batch_goes_without_waiting() {
        let t0 = Instant::now();
        let mut b = Batcher::new(W, 4);
        b.push("x".into(), t0);
        assert_eq!(b.push("ab".into(), t0 + ms(1)), None);
        assert_eq!(b.push("cd".into(), t0 + ms(2)).as_deref(), Some("abcd"));
        assert!(b.deadline().is_none());
    }

    #[test]
    fn a_window_of_zero_sends_every_read() {
        let t0 = Instant::now();
        let mut b = Batcher::new(Duration::ZERO, 1024);
        for (i, piece) in ["a", "b", "c"].iter().enumerate() {
            assert_eq!(b.push(piece.to_string(), t0).as_deref(), Some(*piece), "read {i}");
        }
        assert_eq!(b.push(String::new(), t0), None, "nothing read, nothing sent");
    }

    /// The sender on a thread of its own, fed as the reader feeds it.
    fn emitted(items: Vec<(Outgoing, u64)>, window: Duration) -> Vec<Outgoing> {
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let sender = thread::spawn(move || run_emitter(rx, Batcher::new(window, DEFAULT_MAX), |item| out_tx.send(item).unwrap()));
        for (item, pause) in items {
            tx.send(item).unwrap();
            if pause > 0 {
                thread::sleep(ms(pause));
            }
        }
        drop(tx);
        sender.join().unwrap();
        out_rx.try_iter().collect()
    }

    fn out(s: &str) -> Outgoing {
        Outgoing::Output(s.to_string())
    }

    #[test]
    fn a_marker_never_overtakes_the_output_before_it() {
        let got = emitted(
            vec![
                (out("$ ls\r\n"), 0),
                (out("a b c\r\n"), 0),
                (Outgoing::Marker(Marker::CommandFinished(Some(0))), 0),
                (out("$ "), 0),
            ],
            Duration::from_secs(5),
        );
        assert_eq!(
            got,
            vec![
                out("$ ls\r\n"),
                out("a b c\r\n"),
                Outgoing::Marker(Marker::CommandFinished(Some(0))),
                out("$ "),
            ],
            "held output goes before the marker, however long the window"
        );
    }

    #[test]
    fn what_is_held_at_the_end_still_goes() {
        let got = emitted(vec![(out("a"), 0), (out("b"), 0), (out("c"), 0)], Duration::from_secs(5));
        let text: String = got
            .iter()
            .map(|item| match item {
                Outgoing::Output(s) => s.as_str(),
                Outgoing::Marker(_) => "",
            })
            .collect();
        assert_eq!(text, "abc");
    }

    /// Output that never pauses — a flood — still goes out a window at a
    /// time, not only when `max` is reached.
    #[test]
    fn a_steady_stream_goes_out_a_window_at_a_time() {
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel::<(Outgoing, Instant)>();
        let sender = thread::spawn(move || {
            run_emitter(rx, Batcher::new(ms(10), DEFAULT_MAX), |item| out_tx.send((item, Instant::now())).unwrap())
        });
        let started = Instant::now();
        let mut written = 0;
        while started.elapsed() < ms(120) {
            tx.send(out("x")).unwrap();
            written += 1;
            thread::sleep(Duration::from_micros(200));
        }
        drop(tx);
        sender.join().unwrap();
        let got: Vec<_> = out_rx.try_iter().collect();
        let total: usize = got
            .iter()
            .map(|(item, _)| match item {
                Outgoing::Output(s) => s.len(),
                Outgoing::Marker(_) => 0,
            })
            .sum();
        assert_eq!(total, written, "nothing lost or doubled");
        assert!(got.len() >= 6, "about one batch per 10 ms window over 120 ms, not one at the end: {}", got.len());
        let gaps: Vec<_> = got.windows(2).map(|w| w[1].1.duration_since(w[0].1)).collect();
        let longest = gaps.iter().max().copied().unwrap_or_default();
        assert!(longest < ms(60), "no batch held far past its window: {longest:?}");
    }

    #[test]
    fn held_output_goes_by_its_deadline_without_more_arriving() {
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel::<(Outgoing, Instant)>();
        let sender = thread::spawn(move || {
            run_emitter(rx, Batcher::new(ms(20), DEFAULT_MAX), |item| out_tx.send((item, Instant::now())).unwrap())
        });
        tx.send(out("first")).unwrap();
        let held_at = Instant::now();
        tx.send(out("held")).unwrap();
        // No more output, and the reader still holding its end.
        let (_, _) = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (item, at) = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(item, out("held"));
        let waited = at.duration_since(held_at);
        assert!(waited >= ms(15) && waited < ms(1000), "sent by its deadline, not at the end: {waited:?}");
        drop(tx);
        sender.join().unwrap();
    }
}
