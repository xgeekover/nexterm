//! Per-token rate limits (spec D6): what one terminal's programs may ask of
//! NexTerm in a given time, whatever they ask it through.
//!
//! - **Requests:** 20 a second, in bursts of up to 40 — a token bucket that
//!   starts full. Every authenticated request counts, refused ones included,
//!   so a loop of bad requests is held back like any other.
//! - **send:** at most 64 KiB of `args.text` in any 60 seconds.
//! - **read-screen:** at most 30 in any 60 seconds.
//!
//! The two per-minute limits are sliding windows, not buckets: a bucket of
//! 64 KiB refilled over a minute lets 128 KiB through in the first minute
//! (the full bucket, then the refill), and "64 KiB a minute" would not be
//! true. A refused request is not counted against its window.
//!
//! Time is passed in, never read here, so the tests can say exactly when.

use std::collections::VecDeque;
use std::time::Duration;

use tokio::time::Instant;

pub const REQUESTS_PER_SECOND: f64 = 20.0;
pub const REQUEST_BURST: f64 = 40.0;
pub const SEND_BYTES_PER_MINUTE: usize = 64 * 1024;
pub const READS_PER_MINUTE: usize = 30;
/// The most `new-split`s in any 60 seconds from all tokens together: each
/// split's shell gets a token of its own, with budgets of its own, so a
/// per-token limit alone would let a loop of splits open terminals without
/// end (review). The page keeps per-caller caps as well.
pub const SPLITS_PER_MINUTE: usize = 20;
/// The most `new-split`s from one token in any 60 seconds, asked before the
/// shared 20, so that one caller firing at once leaves the rest for the
/// other terminals (review).
pub const SPLITS_PER_TOKEN_PER_MINUTE: usize = 10;
/// What one key counts against `send`'s 64 KiB a minute: more than any key
/// encodes to (the longest, `CSI 27;8;13~`, is 10 bytes — src/lib/controlKeys.js).
pub const KEY_BYTES: usize = 16;
const MINUTE: Duration = Duration::from_secs(60);

/// What one token has used.
#[derive(Debug)]
pub struct Budget {
    tokens: f64,
    refilled: Instant,
    sent: Window,
    reads: Window,
    splits: Window,
}

impl Budget {
    pub fn new(now: Instant) -> Self {
        Budget {
            tokens: REQUEST_BURST,
            refilled: now,
            sent: Window::new(SEND_BYTES_PER_MINUTE),
            reads: Window::new(READS_PER_MINUTE),
            splits: Window::new(SPLITS_PER_TOKEN_PER_MINUTE),
        }
    }

    /// Whether one more `new-split` is within this token's 10 a minute —
    /// asked, not taken: the shared 20 may still refuse it (server.rs).
    pub fn split_fits(&mut self, now: Instant) -> bool {
        self.splits.fits(1, now)
    }

    /// A `new-split`, taken from this token's 10 a minute.
    pub fn split(&mut self, now: Instant) -> bool {
        self.splits.take(1, now)
    }

    /// One more request: whether it is within 20 a second, burst 40.
    pub fn request(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.refilled).as_secs_f64();
        self.tokens = (self.tokens + elapsed * REQUESTS_PER_SECOND).min(REQUEST_BURST);
        self.refilled = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// A `send` of `bytes` of text: whether it fits in the last minute's 64 KiB.
    pub fn send(&mut self, bytes: usize, now: Instant) -> bool {
        self.sent.take(bytes, now)
    }

    /// A `read-screen`: whether it is within the last minute's 30.
    pub fn read(&mut self, now: Instant) -> bool {
        self.reads.take(1, now)
    }
}

/// The `new-split`s of every token together: at most SPLITS_PER_MINUTE in
/// any 60 seconds.
#[derive(Debug)]
pub struct Splits(Window);

impl Default for Splits {
    fn default() -> Self {
        Splits(Window::new(SPLITS_PER_MINUTE))
    }
}

impl Splits {
    pub fn take(&mut self, now: Instant) -> bool {
        self.0.take(1, now)
    }
}

/// At most `cap` units in any 60 seconds.
#[derive(Debug)]
struct Window {
    cap: usize,
    used: usize,
    entries: VecDeque<(Instant, usize)>,
}

impl Window {
    fn new(cap: usize) -> Self {
        Window { cap, used: 0, entries: VecDeque::new() }
    }

    /// Whether `units` more fit in the last 60 seconds, nothing taken.
    fn fits(&mut self, units: usize, now: Instant) -> bool {
        while let Some(&(at, n)) = self.entries.front() {
            if now.saturating_duration_since(at) < MINUTE {
                break;
            }
            self.entries.pop_front();
            self.used -= n;
        }
        self.used + units <= self.cap
    }

    fn take(&mut self, units: usize, now: Instant) -> bool {
        if !self.fits(units, now) {
            return false;
        }
        self.used += units;
        self.entries.push_back((now, units));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn forty_at_once_then_twenty_a_second() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        assert!((0..40).all(|_| budget.request(start)), "a burst of 40 goes through");
        assert!(!budget.request(start), "the 41st at the same moment is refused");
        // 50 ms is one more at 20 a second.
        assert!(budget.request(start + ms(50)));
        assert!(!budget.request(start + ms(50)));
        // Over a long run, 20 a second and no more.
        let mut granted = 0;
        for tick in 1..=1000u64 {
            // Every 10 ms for 10 s: 100 asks a second.
            if budget.request(start + ms(50) + ms(tick * 10)) {
                granted += 1;
            }
        }
        assert!((199..=201).contains(&granted), "{granted} in 10 s at 20 a second");
    }

    #[test]
    fn a_long_pause_refills_to_forty_and_no_further() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        assert!((0..40).all(|_| budget.request(start)));
        let later = start + Duration::from_secs(3600);
        assert!((0..40).all(|_| budget.request(later)));
        assert!(!budget.request(later));
    }

    #[test]
    fn sixty_four_kib_of_text_a_minute_in_any_minute() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        assert!(budget.send(16 * 1024, start));
        assert!(budget.send(16 * 1024, start + ms(1)));
        assert!(budget.send(16 * 1024, start + ms(2)));
        assert!(budget.send(16 * 1024 - 1, start + ms(3)));
        assert!(budget.send(1, start + ms(4)), "64 KiB exactly is allowed");
        assert!(!budget.send(1, start + ms(5)), "one byte more is not");
        // A send with no text (keys only) always fits.
        assert!(budget.send(0, start + ms(6)));
        // Refused sends were not counted: a minute after the first, its
        // 16 KiB is free again and no more.
        assert!(!budget.send(16 * 1024 + 1, start + MINUTE));
        assert!(budget.send(16 * 1024, start + MINUTE));
        assert!(!budget.send(1, start + MINUTE));
    }

    #[test]
    fn thirty_screen_reads_a_minute_in_any_minute() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        for i in 0..30u64 {
            assert!(budget.read(start + Duration::from_secs(i)), "read {i}");
        }
        assert!(!budget.read(start + Duration::from_secs(30)));
        assert!(!budget.read(start + ms(59_999)));
        // The first read leaves the window at 60 s: room for exactly one.
        assert!(budget.read(start + MINUTE));
        assert!(!budget.read(start + MINUTE));
    }

    #[test]
    fn twenty_splits_a_minute_from_everyone_together() {
        let start = Instant::now();
        let mut splits = Splits::default();
        for i in 0..20u64 {
            assert!(splits.take(start + Duration::from_secs(i)), "split {i}");
        }
        assert!(!splits.take(start + Duration::from_secs(20)));
        assert!(splits.take(start + MINUTE), "the first is a minute old");
        assert!(!splits.take(start + MINUTE));
    }

    #[test]
    fn ten_splits_a_minute_from_one_token() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        // Asking takes nothing.
        assert!((0..100).all(|_| budget.split_fits(start)));
        assert!((0..10).all(|_| budget.split(start)));
        assert!(!budget.split_fits(start));
        assert!(!budget.split(start));
        assert!(budget.split_fits(start + MINUTE));
        assert!(budget.split(start + MINUTE));
    }

    #[test]
    fn each_budget_is_its_own() {
        let start = Instant::now();
        let mut one = Budget::new(start);
        let mut two = Budget::new(start);
        assert!((0..40).all(|_| one.request(start)));
        assert!(!one.request(start));
        assert!(two.request(start), "another token's burst is untouched");
        assert!(one.send(SEND_BYTES_PER_MINUTE, start));
        assert!(two.send(SEND_BYTES_PER_MINUTE, start));
    }
}
