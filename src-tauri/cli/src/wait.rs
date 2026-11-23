//! `nexterm-cli wait TARGET [--for idle|exit] [--timeout DURATION]` (B2).
//!
//! No command of its own on the wire (B2-F2): once a second it sends an
//! ordinary `list`, each on a fresh connection, and judges the target's row
//! here. So it needs only the main control switch, as `list` does, and it
//! never reads a screen.
//!
//! The row's `status` is the side bar's state (src/lib/terminalStatus.js);
//! `activity` is Claude Code's own `working` or `idle`, or null — and an
//! older NexTerm sends no `activity` at all, which counts as null.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::args::{Command, UsageError, Until};
use crate::exit;
use crate::output;
use crate::protocol::{self, Answer};
use crate::transport::{Address, FailureKind, Link};
use crate::usage;

/// Polls start at least this far apart, start to start.
pub const POLL: Duration = Duration::from_secs(1);
/// How long the target must stay settled after it was seen busy.
pub const SETTLE: Duration = Duration::from_secs(1);
/// How long it must stay settled when it was never seen busy: a terminal
/// that is between two steps of its work looks settled for a moment.
pub const START_GRACE: Duration = Duration::from_millis(3500);
/// A busy NexTerm (`rate_limited`, `not_responding`) is asked again after
/// twice the last interval, up to this.
pub const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Nothing is going on: no state, idle, or the last command failed.
const SETTLED: &[&str] = &["none", "idle", "failed"];
/// Something is going on.
const BUSY: &[&str] = &["working", "running", "progress", "error"];

/// Time, so the tests can run the loop with no real waiting.
pub trait Clock {
    /// How long since a fixed start.
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
}

pub struct RealClock {
    start: Instant,
}

impl RealClock {
    pub fn starting_now() -> RealClock {
        RealClock { start: Instant::now() }
    }
}

impl Clock for RealClock {
    fn now(&self) -> Duration {
        self.start.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

pub struct Spec<'a> {
    /// As given: a tab id, or `child:<id>`.
    pub target: &'a str,
    pub until: Until,
    /// None: no limit.
    pub timeout: Option<Duration>,
}

/// The target's row in one `list` answer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Row {
    pub status: Option<String>,
    pub activity: Option<String>,
}

impl Row {
    fn of(v: &Value) -> Row {
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        Row { status: text("status"), activity: text("activity") }
    }
}

/// What the polls so far have shown, for `--for idle`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Memory {
    /// A busy state was seen since the wait began.
    pub seen_busy: bool,
    /// When the current settled run began (None: not settled now).
    pub settled_since: Option<Duration>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Idle,
    Exited,
    Closed,
    Blocked,
    TimedOut,
}

impl Outcome {
    /// As `--json` names it.
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Idle => "idle",
            Outcome::Exited => "exited",
            Outcome::Closed => "closed",
            Outcome::Blocked => "blocked",
            Outcome::TimedOut => "timed_out",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    KeepWaiting,
    /// What was waited for happened: exit 0.
    Done(Outcome),
    /// Waiting on a person, with why: exit 7.
    Blocked(&'static str),
    /// Exited or closed before it was idle: exit 8.
    Ended(Outcome),
}

/// One poll's judgement: `row` is the target's row, None when it is gone
/// (closed) — only ever after a poll that found it. `at` is when the row
/// was seen. Pure: the same inputs give the same answer.
pub fn judge(row: Option<&Row>, until: Until, at: Duration, before: Memory) -> (Verdict, Memory) {
    let mut m = before;
    let ended = |outcome| match until {
        Until::Exit => Verdict::Done(outcome),
        Until::Idle => Verdict::Ended(outcome),
    };
    let Some(row) = row else {
        return (ended(Outcome::Closed), m);
    };
    // A status this CLI does not know (a later NexTerm's) is neither.
    let status = row.status.as_deref().unwrap_or("");
    if status == "exited" {
        return (ended(Outcome::Exited), m);
    }
    if until == Until::Exit {
        return (Verdict::KeepWaiting, m);
    }
    let agent_idle = row.activity.as_deref() == Some("idle");
    if status == "waiting" && !agent_idle {
        return (Verdict::Blocked("waiting for input"), m);
    }
    if !(SETTLED.contains(&status) || status == "waiting") {
        m.seen_busy |= BUSY.contains(&status);
        m.settled_since = None;
        return (Verdict::KeepWaiting, m);
    }
    let since = *m.settled_since.get_or_insert(at);
    let needed = if m.seen_busy { SETTLE } else { START_GRACE };
    if at.saturating_sub(since) >= needed {
        (Verdict::Done(Outcome::Idle), m)
    } else {
        (Verdict::KeepWaiting, m)
    }
}

/// How a wait ended, before it is printed.
#[derive(Debug, PartialEq, Eq)]
pub struct Finish {
    pub outcome: Outcome,
    /// 0, 6, 7 or 8.
    pub code: u8,
    /// The last status seen, or None when no answer had a row.
    pub status: Option<String>,
    pub waited: Duration,
    /// Why it is blocked.
    pub reason: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum End {
    /// Exit 0, 6, 7 or 8: one line, or one JSON object.
    Finished(Finish),
    /// Any other exit code, with what goes to stderr.
    Error { code: u8, text: String },
}

/// One poll, read.
enum Poll {
    Rows(Vec<Value>),
    /// NexTerm is busy or slow: ask again later.
    Busy,
    Stop(End),
}

fn poll(link: &dyn Link, address: &Address, request: &[u8]) -> Poll {
    let answer = match link.exchange(address, request) {
        Ok(a) => a,
        Err(f) if f.kind == FailureKind::NotResponding => return Poll::Busy,
        // Unreachable: NexTerm quit or its control was turned off (5);
        // refused (4); a bad answer (1).
        Err(f) => return Poll::Stop(error(f.kind.exit_code(), format!("nexterm-cli: {}\n", output::one_line(&f.message)))),
    };
    match protocol::decode(&answer) {
        Ok(Answer::Done(Value::Array(rows))) => Poll::Rows(rows),
        Ok(Answer::Done(_)) => Poll::Stop(error(exit::FAILED, "nexterm-cli: NexTerm's list answer is not a list of terminals\n")),
        Ok(Answer::Failed { code, message }) => {
            let code_text = code.as_deref().unwrap_or("");
            let exit_code = protocol::exit_code_for(code_text);
            if exit_code == exit::NOT_RESPONDING {
                return Poll::Busy;
            }
            let message = output::one_line(&message);
            let mut text = match code.as_deref() {
                Some(c) => format!("nexterm-cli: {message} [{}]\n", output::one_line(c)),
                None => format!("nexterm-cli: {message}\n"),
            };
            if exit_code == exit::USAGE {
                text.push_str("Run 'nexterm-cli help wait' for more.\n");
            }
            Poll::Stop(error(exit_code, text))
        }
        Err(problem) => Poll::Stop(error(exit::FAILED, format!("nexterm-cli: {problem}\n"))),
    }
}

fn error(code: u8, text: impl Into<String>) -> End {
    End::Error { code, text: text.into() }
}

/// Polls `list` until the target is what `spec` waits for, or the time is up.
pub fn wait(spec: &Spec, token: &str, address: &Address, link: &dyn Link, clock: &dyn Clock) -> End {
    let line = match protocol::build(&Command::List, &mut io::empty()).and_then(|r| protocol::encode(token, &r)) {
        Ok(l) => l,
        Err(e) => return error(exit::USAGE, usage::usage_error(&UsageError { command: Some("wait"), ..e })),
    };
    let (id, as_child) = match spec.target.strip_prefix("child:") {
        Some(id) => (id, true),
        None => (spec.target, false),
    };
    let shown = output::one_line(id);
    let start = clock.now();
    let deadline = spec.timeout.map(|t| start + t);
    let mut next = start;
    let mut memory = Memory::default();
    let mut found = false;
    let mut status: Option<String> = None;
    let mut interval = POLL;
    loop {
        let now = clock.now();
        if next > now {
            clock.sleep(next - now);
        }
        let polled_at = clock.now();
        // Slow exchanges (a frozen NexTerm: up to 2 s to connect and 5 s for
        // the answer) can carry the last one past the deadline: no poll
        // starts after it. One at the deadline itself still does.
        if deadline.is_some_and(|deadline| polled_at > deadline) {
            let waited = polled_at - start;
            return End::Finished(Finish { outcome: Outcome::TimedOut, code: exit::TIMED_OUT, status, waited, reason: None });
        }
        match poll(link, address, line.as_bytes()) {
            Poll::Stop(end) => return end,
            Poll::Busy => interval = (interval * 2).min(BACKOFF_MAX),
            Poll::Rows(rows) => {
                interval = POLL;
                let at = clock.now();
                let row = rows.iter().find(|r| r.get("id").and_then(Value::as_str) == Some(id));
                if !found {
                    let Some(r) = row else {
                        return error(exit::REFUSED, format!("nexterm-cli: no terminal {shown} (see 'nexterm-cli list')\n"));
                    };
                    if r.get("self") == Some(&Value::Bool(true)) {
                        let why = format!("{shown} is this terminal; wait needs another one (a tab id or child:<id>)");
                        return error(exit::USAGE, usage::usage_error(&UsageError::of("wait", why)));
                    }
                    if as_child && r.get("child") != Some(&Value::Bool(true)) {
                        return error(exit::REFUSED, format!("nexterm-cli: {shown} was not opened by this terminal\n"));
                    }
                    found = true;
                }
                let row = row.map(Row::of);
                if let Some(r) = &row {
                    status = r.status.clone();
                }
                let (verdict, m) = judge(row.as_ref(), spec.until, at, memory);
                memory = m;
                let finish = |outcome, code, reason| {
                    End::Finished(Finish { outcome, code, status: status.clone(), waited: at - start, reason })
                };
                match verdict {
                    Verdict::KeepWaiting => {}
                    Verdict::Done(o) => return finish(o, exit::OK, None),
                    Verdict::Blocked(why) => return finish(Outcome::Blocked, exit::BLOCKED, Some(why)),
                    Verdict::Ended(o) => return finish(o, exit::ENDED, None),
                }
            }
        }
        next = polled_at + interval;
        if let Some(deadline) = deadline {
            if next > deadline {
                let now = clock.now();
                if deadline > now {
                    clock.sleep(deadline - now);
                }
                let waited = clock.now() - start;
                return End::Finished(Finish { outcome: Outcome::TimedOut, code: exit::TIMED_OUT, status, waited, reason: None });
            }
        }
    }
}

/// Prints how the wait ended and returns the exit code. Done (0) is a line
/// on stdout; 6, 7 and 8 are a line on stderr, as other failures are. With
/// `--json` each of the four is one object on stdout and nothing else.
pub fn report(spec: &Spec, end: End, json: bool, out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    // Write errors (a closed pipe) are ignored: the exit code still says it.
    match end {
        End::Error { code, text } => {
            let _ = err.write_all(text.as_bytes());
            code
        }
        End::Finished(f) => {
            if json {
                let _ = out.write_all(output::wait_json(spec.target, &f).as_bytes());
            } else if f.code == exit::OK {
                let _ = out.write_all(output::wait_line(spec.target, &f).as_bytes());
            } else {
                let _ = write!(err, "nexterm-cli: {}", output::wait_line(spec.target, &f));
            }
            let _ = out.flush();
            f.code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{parse_address, Failure};
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    const TOKEN: &str = "tok_abcDEF123-_";

    fn secs(s: f64) -> Duration {
        Duration::from_secs_f64(s)
    }

    struct FakeClock {
        now: Cell<Duration>,
    }

    impl FakeClock {
        fn new() -> FakeClock {
            FakeClock { now: Cell::new(Duration::ZERO) }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            self.now.get()
        }
        fn sleep(&self, d: Duration) {
            self.now.set(self.now.get() + d);
            // A loop that never ends fails here instead of hanging the suite.
            assert!(self.now.get() < Duration::from_secs(48 * 3600), "the wait never ended");
        }
    }

    #[derive(Clone)]
    enum Say {
        Line(String),
        Fail(FailureKind),
    }

    /// Answers each exchange with the next scripted answer (the last one
    /// again once they run out), recording the request and the fake time
    /// it was sent; each exchange takes `latency`.
    struct Script<'a> {
        clock: &'a FakeClock,
        says: Vec<Say>,
        latency: Duration,
        sent: RefCell<Vec<(Duration, String)>>,
    }

    impl<'a> Script<'a> {
        fn new(clock: &'a FakeClock, says: Vec<Say>) -> Script<'a> {
            Script { clock, says, latency: Duration::ZERO, sent: RefCell::new(Vec::new()) }
        }
        fn times(&self) -> Vec<Duration> {
            self.sent.borrow().iter().map(|(t, _)| *t).collect()
        }
    }

    impl Link for Script<'_> {
        fn exchange(&self, _address: &Address, request: &[u8]) -> Result<Vec<u8>, Failure> {
            let mut sent = self.sent.borrow_mut();
            let i = sent.len();
            assert!(i < 100_000, "the wait never ended");
            sent.push((self.clock.now(), String::from_utf8(request.to_vec()).unwrap()));
            self.clock.sleep(self.latency);
            match &self.says[i.min(self.says.len() - 1)] {
                Say::Line(l) => Ok(l.as_bytes().to_vec()),
                Say::Fail(kind) => Err(Failure { kind: *kind, message: format!("it went wrong ({kind:?})") }),
            }
        }
    }

    fn address() -> Address {
        let raw = if cfg!(windows) { r"\\.\pipe\nexterm-0123456789abcdef" } else { "/run/user/1000/nexterm/1.sock" };
        parse_address(std::ffi::OsStr::new(raw)).unwrap()
    }

    /// A row of `list`: `activity: None` leaves the key out (an older NexTerm).
    fn row(id: &str, status: &str, activity: Option<Value>) -> Value {
        let mut r = json!({"id": id, "title": "zsh", "cwd": "/w", "group": "Main", "active": false,
                           "agent": "claude", "status": status, "self": false, "child": true});
        if let Some(a) = activity {
            r["activity"] = a;
        }
        r
    }

    /// The target, tab-term-7, in `status`, beside the caller's own row.
    fn target(status: &str, activity: Option<Value>) -> Say {
        let me = json!({"id": "tab-term-1", "status": "working", "activity": "working", "self": true, "child": false});
        rows(json!([me, row("tab-term-7", status, activity)]))
    }

    fn rows(rows: Value) -> Say {
        Say::Line(json!({"v": 1, "id": 1, "ok": true, "result": rows}).to_string())
    }

    fn st(status: &str) -> Say {
        target(status, Some(Value::Null))
    }

    fn gone() -> Say {
        rows(json!([{"id": "tab-term-1", "status": "working", "self": true, "child": false}]))
    }

    fn refusal(code: &str) -> Say {
        Say::Line(format!(r#"{{"v":1,"id":1,"ok":false,"error":{{"code":"{code}","message":"said {code}"}}}}"#))
    }

    fn spec(target: &str, until: Until, timeout: Option<f64>) -> Spec<'_> {
        Spec { target, until, timeout: timeout.map(secs) }
    }

    /// Runs the wait; returns how it ended and the link, to look at.
    fn go<'a>(clock: &'a FakeClock, says: Vec<Say>, spec: &Spec) -> (End, Script<'a>) {
        let link = Script::new(clock, says);
        let end = wait(spec, TOKEN, &address(), &link, clock);
        (end, link)
    }

    fn finished(end: End) -> Finish {
        match end {
            End::Finished(f) => f,
            other => panic!("not finished: {other:?}"),
        }
    }

    fn at(list: &[f64]) -> Vec<Duration> {
        list.iter().map(|s| secs(*s)).collect()
    }

    const IDLE: Until = Until::Idle;
    const EXIT: Until = Until::Exit;

    fn idle_for(target: &str) -> Spec<'_> {
        spec(target, IDLE, Some(600.0))
    }

    #[test]
    fn the_constants_are_the_specs() {
        assert_eq!(POLL, Duration::from_secs(1));
        assert_eq!(SETTLE, Duration::from_secs(1));
        assert_eq!(START_GRACE, Duration::from_millis(3500));
        assert_eq!(BACKOFF_MAX, Duration::from_secs(5));
        assert_eq!((exit::TIMED_OUT, exit::BLOCKED, exit::ENDED), (6, 7, 8));
    }

    #[test]
    fn judge_settled_busy_and_blocked() {
        let r = |status: &str, activity: Option<&str>| Row { status: Some(status.into()), activity: activity.map(Into::into) };
        let fresh = Memory::default();
        // Busy states are remembered and end a settled run.
        for busy in ["working", "running", "progress", "error"] {
            let settled = Memory { seen_busy: false, settled_since: Some(secs(0.0)) };
            let (v, m) = judge(Some(&r(busy, None)), IDLE, secs(1.0), settled);
            assert_eq!((v, m), (Verdict::KeepWaiting, Memory { seen_busy: true, settled_since: None }), "{busy}");
        }
        // Settled states start a run; it is done after SETTLE once busy was seen.
        for settled in [r("none", None), r("idle", None), r("failed", Some("working")), r("waiting", Some("idle"))] {
            let after_busy = Memory { seen_busy: true, settled_since: None };
            let (v, m) = judge(Some(&settled), IDLE, secs(2.0), after_busy);
            assert_eq!((v, m), (Verdict::KeepWaiting, Memory { seen_busy: true, settled_since: Some(secs(2.0)) }), "{settled:?}");
            assert_eq!(judge(Some(&settled), IDLE, secs(2.9), m).0, Verdict::KeepWaiting, "{settled:?}");
            assert_eq!(judge(Some(&settled), IDLE, secs(3.0), m).0, Verdict::Done(Outcome::Idle), "{settled:?}");
            // Never busy: START_GRACE instead.
            let (_, m) = judge(Some(&settled), IDLE, secs(0.0), fresh);
            assert_eq!(judge(Some(&settled), IDLE, secs(3.4), m).0, Verdict::KeepWaiting, "{settled:?}");
            assert_eq!(judge(Some(&settled), IDLE, secs(3.5), m).0, Verdict::Done(Outcome::Idle), "{settled:?}");
        }
        // Waiting while the agent is not idle: blocked at once, with why.
        for activity in [Some("working"), None, Some("something-new")] {
            let (v, _) = judge(Some(&r("waiting", activity)), IDLE, secs(0.0), fresh);
            assert_eq!(v, Verdict::Blocked("waiting for input"), "{activity:?}");
        }
        // Exited or gone ends the wait for idle, and is what --for exit waits for.
        assert_eq!(judge(Some(&r("exited", None)), IDLE, secs(1.0), fresh).0, Verdict::Ended(Outcome::Exited));
        assert_eq!(judge(None, IDLE, secs(1.0), fresh).0, Verdict::Ended(Outcome::Closed));
        assert_eq!(judge(Some(&r("exited", None)), EXIT, secs(1.0), fresh).0, Verdict::Done(Outcome::Exited));
        assert_eq!(judge(None, EXIT, secs(1.0), fresh).0, Verdict::Done(Outcome::Closed));
        // --for exit waits through everything else, blocked included.
        for other in [r("idle", None), r("waiting", None), r("working", Some("working")), r("none", None)] {
            let settled = Memory { seen_busy: true, settled_since: Some(secs(0.0)) };
            assert_eq!(judge(Some(&other), EXIT, secs(100.0), settled).0, Verdict::KeepWaiting, "{other:?}");
        }
        // A status this CLI does not know, or none at all, is neither.
        for odd in [r("napping", None), Row::default()] {
            let settled = Memory { seen_busy: true, settled_since: Some(secs(0.0)) };
            let (v, m) = judge(Some(&odd), IDLE, secs(5.0), settled);
            assert_eq!((v, m), (Verdict::KeepWaiting, Memory { seen_busy: true, settled_since: None }), "{odd:?}");
        }
    }

    #[test]
    fn busy_then_settled_for_one_second_is_done() {
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![st("working"), st("running"), st("idle"), st("idle"), st("working")], &idle_for("tab-term-7"));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Idle, 0, Some("idle"), secs(3.0)));
        assert_eq!(link.times(), at(&[0.0, 1.0, 2.0, 3.0]));
        // A busy state in between starts the settling over.
        let clock = FakeClock::new();
        let says = vec![st("working"), st("idle"), st("progress"), st("none"), st("none")];
        let (end, link) = go(&clock, says, &idle_for("tab-term-7"));
        assert_eq!(finished(end).waited, secs(4.0));
        assert_eq!(link.times().len(), 5);
    }

    #[test]
    fn settled_from_the_first_poll_is_done_only_after_the_start_grace() {
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![st("idle")], &idle_for("tab-term-7"));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.waited), (Outcome::Idle, 0, secs(4.0)));
        assert_eq!(link.times(), at(&[0.0, 1.0, 2.0, 3.0, 4.0]));
        // With polls that took a while, 3.5 s after the first settled answer.
        let clock = FakeClock::new();
        let mut link = Script::new(&clock, vec![st("none")]);
        link.latency = secs(0.25);
        let f = finished(wait(&idle_for("tab-term-7"), TOKEN, &address(), &link, &clock));
        assert_eq!(f.waited, secs(4.25));
    }

    #[test]
    fn waiting_while_the_agent_is_idle_is_settled() {
        let clock = FakeClock::new();
        let says = vec![st("working"), target("waiting", Some(json!("idle"))), target("waiting", Some(json!("idle")))];
        let (end, _) = go(&clock, says, &idle_for("tab-term-7"));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Idle, 0, Some("waiting"), secs(2.0)));
    }

    #[test]
    fn waiting_while_the_agent_is_not_idle_is_blocked_exit_7() {
        for activity in [Some(json!("working")), Some(Value::Null), None] {
            let clock = FakeClock::new();
            let says = vec![st("working"), target("waiting", activity.clone()), st("idle")];
            let (end, link) = go(&clock, says, &idle_for("tab-term-7"));
            let f = finished(end);
            assert_eq!(
                (f.outcome, f.code, f.status.as_deref(), f.waited, f.reason),
                (Outcome::Blocked, 7, Some("waiting"), secs(1.0), Some("waiting for input")),
                "{activity:?}"
            );
            assert_eq!(link.times().len(), 2);
        }
        // From the very first poll, too.
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![target("waiting", Some(json!("working")))], &idle_for("tab-term-7"));
        assert_eq!(finished(end).code, exit::BLOCKED);
    }

    #[test]
    fn exited_or_closed_ends_a_wait_for_idle_with_exit_8() {
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![st("working"), st("exited")], &idle_for("tab-term-7"));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Exited, 8, Some("exited"), secs(1.0)));
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![st("working"), st("working"), gone()], &idle_for("tab-term-7"));
        let f = finished(end);
        // Closed: the status is the last one seen before the row went.
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Closed, 8, Some("working"), secs(2.0)));
    }

    #[test]
    fn exited_or_closed_is_what_a_wait_for_exit_waits_for() {
        let clock = FakeClock::new();
        let says = vec![st("working"), st("idle"), target("waiting", None), st("idle"), st("idle"), st("exited")];
        let (end, link) = go(&clock, says, &spec("tab-term-7", EXIT, Some(600.0)));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Exited, 0, Some("exited"), secs(5.0)));
        assert_eq!(link.times().len(), 6);
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![st("idle"), gone()], &spec("child:tab-term-7", EXIT, None));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::Closed, 0, Some("idle"), secs(1.0)));
    }

    #[test]
    fn a_timeout_is_exit_6_with_the_last_status() {
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![st("working")], &spec("tab-term-7", IDLE, Some(5.0)));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref(), f.waited), (Outcome::TimedOut, 6, Some("working"), secs(5.0)));
        // A poll at the deadline itself still counts; none after it.
        assert_eq!(link.times(), at(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0]));
        // Between two polls, it waits out the deadline and stops there.
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![st("running")], &spec("tab-term-7", EXIT, Some(2.5)));
        let f = finished(end);
        assert_eq!((f.code, f.waited), (6, secs(2.5)));
        assert_eq!(link.times().len(), 3);
    }

    #[test]
    fn no_timeout_waits_as_long_as_it_takes() {
        let mut says = vec![st("working"); 3000];
        says.push(st("idle"));
        let clock = FakeClock::new();
        let (end, link) = go(&clock, says, &spec("tab-term-7", IDLE, None));
        let f = finished(end);
        assert_eq!((f.code, f.waited), (0, secs(3001.0)));
        assert_eq!(link.times().len(), 3002);
    }

    #[test]
    fn a_busy_nexterm_is_asked_again_with_backoff_until_it_answers() {
        let clock = FakeClock::new();
        let says = vec![
            refusal("rate_limited"),
            refusal("not_responding"),
            Say::Fail(FailureKind::NotResponding),
            refusal("rate_limited"),
            st("working"),
            refusal("rate_limited"),
            st("idle"),
            st("idle"),
        ];
        let (end, link) = go(&clock, says, &idle_for("tab-term-7"));
        let f = finished(end);
        assert_eq!((f.outcome, f.code, f.status.as_deref()), (Outcome::Idle, 0, Some("idle")));
        // 2, 4, 5, 5 s apart while busy; once a second again after an answer.
        assert_eq!(link.times(), at(&[0.0, 2.0, 6.0, 11.0, 16.0, 17.0, 19.0, 20.0]));
        assert_eq!(f.waited, secs(20.0));
    }

    #[test]
    fn a_nexterm_that_stays_busy_is_retried_until_the_timeout() {
        for busy in [refusal("rate_limited"), refusal("not_responding"), Say::Fail(FailureKind::NotResponding)] {
            let clock = FakeClock::new();
            let (end, link) = go(&clock, vec![busy], &spec("tab-term-7", IDLE, Some(20.0)));
            let f = finished(end);
            assert_eq!((f.outcome, f.code, f.status, f.waited), (Outcome::TimedOut, 6, None, secs(20.0)));
            assert_eq!(link.times(), at(&[0.0, 2.0, 6.0, 11.0, 16.0]));
        }
    }

    /// Review A-R5: each exchange takes 7 s (a frozen NexTerm: 2 s to
    /// connect, 5 s for the answer) and the timeout is 20 s. Polls start at
    /// 0, 7 and 14 s; the one that ends at 21 s is the last, and the wait
    /// times out then — not a 4th poll, ending at 28 s, which could even
    /// have said what was waited for.
    #[test]
    fn no_poll_starts_after_the_deadline_however_slow_each_one_is() {
        for until in [IDLE, EXIT] {
            let clock = FakeClock::new();
            let says = vec![st("working"), st("working"), st("working"), st("exited"), st("idle"), st("idle")];
            let mut link = Script::new(&clock, says);
            link.latency = secs(7.0);
            let f = finished(wait(&spec("tab-term-7", until, Some(20.0)), TOKEN, &address(), &link, &clock));
            assert_eq!((f.outcome, f.code, f.status.as_deref()), (Outcome::TimedOut, 6, Some("working")), "{until:?}");
            assert_eq!(link.times(), at(&[0.0, 7.0, 14.0]), "{until:?}");
            assert_eq!(f.waited, secs(21.0), "{until:?}: the time the last answer came, not 28 s");
        }
        // A NexTerm that never answers in time, likewise.
        let clock = FakeClock::new();
        let mut link = Script::new(&clock, vec![Say::Fail(FailureKind::NotResponding)]);
        link.latency = secs(7.0);
        let f = finished(wait(&spec("tab-term-7", IDLE, Some(20.0)), TOKEN, &address(), &link, &clock));
        assert_eq!((f.outcome, f.code, f.status, f.waited), (Outcome::TimedOut, 6, None, secs(21.0)));
        // Backoff asks again 2, 4 and 5 s after each start; each answer
        // comes later than that, so the next starts as it does.
        assert_eq!(link.times(), at(&[0.0, 7.0, 14.0]));
    }

    fn error_of(end: End) -> (u8, String) {
        match end {
            End::Error { code, text } => (code, text),
            other => panic!("not an error: {other:?}"),
        }
    }

    #[test]
    fn not_allowed_is_exit_4_at_once_at_any_poll() {
        for code in ["unauthorized", "disabled", "forbidden", "not_found", "refused"] {
            let clock = FakeClock::new();
            let (end, link) = go(&clock, vec![refusal(code)], &idle_for("tab-term-7"));
            assert_eq!(error_of(end), (4, format!("nexterm-cli: said {code} [{code}]\n")), "{code}");
            assert_eq!(link.times().len(), 1);
            // Later on, too (the control was turned down meanwhile).
            let clock = FakeClock::new();
            let (end, link) = go(&clock, vec![st("working"), st("working"), refusal(code)], &idle_for("tab-term-7"));
            assert_eq!(error_of(end).0, 4, "{code}");
            assert_eq!(link.times(), at(&[0.0, 1.0, 2.0]));
        }
    }

    #[test]
    fn the_target_is_checked_on_the_first_rows() {
        // No such terminal.
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![gone()], &idle_for("tab-term-9"));
        assert_eq!(error_of(end), (4, "nexterm-cli: no terminal tab-term-9 (see 'nexterm-cli list')\n".to_owned()));
        assert_eq!(link.times().len(), 1);
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![rows(json!([]))], &idle_for("child:tab-term-9"));
        assert_eq!(error_of(end).0, 4);
        // Not on the first poll when that one was busy: the first rows count.
        let clock = FakeClock::new();
        let (end, link) = go(&clock, vec![refusal("rate_limited"), gone()], &idle_for("tab-term-7"));
        assert_eq!(error_of(end).0, 4);
        assert_eq!(link.times(), at(&[0.0, 2.0]));
        // child:<id> must be a terminal this one opened.
        let mut other = row("tab-term-7", "working", None);
        other["child"] = json!(false);
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![rows(json!([other]))], &idle_for("child:tab-term-7"));
        assert_eq!(error_of(end), (4, "nexterm-cli: tab-term-7 was not opened by this terminal\n".to_owned()));
        // ...but a plain tab id need not be.
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![rows(json!([other])), st("idle"), st("idle")], &idle_for("tab-term-7"));
        assert_eq!(finished(end).code, 0);
        // Its own terminal by id is the same as self: exit 2, wait's usage.
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![st("idle")], &idle_for("tab-term-1"));
        let (code, text) = error_of(end);
        assert_eq!(code, 2);
        assert!(text.starts_with("nexterm-cli: tab-term-1 is this terminal; wait needs another one"), "{text}");
        assert!(text.ends_with("Run 'nexterm-cli help wait' for more.\n"), "{text}");
        // An id cannot write escapes into the message.
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![gone()], &idle_for("tab\u{1b}]0;x\u{7}"));
        assert!(!error_of(end).1.contains('\u{1b}'));
    }

    #[test]
    fn other_failures_end_the_wait_with_their_exit_codes() {
        let cases = [
            (Say::Fail(FailureKind::Unreachable), 5),
            (Say::Fail(FailureKind::Refused), 4),
            (Say::Fail(FailureKind::BadAnswer), 1),
            (refusal("bad_request"), 2),
            (refusal("internal"), 1),
            (Say::Line("not json".into()), 1),
            (Say::Line(r#"{"v":1,"id":1,"ok":true,"result":{"rows":[]}}"#.into()), 1),
            (Say::Line(r#"{"v":1,"id":1,"ok":true}"#.into()), 1),
        ];
        for (say, want) in cases {
            // On the first poll and on a later one alike.
            for says in [vec![say.clone()], vec![st("working"), say.clone()]] {
                let n = says.len();
                let clock = FakeClock::new();
                let (end, link) = go(&clock, says, &idle_for("tab-term-7"));
                let (code, text) = error_of(end);
                assert_eq!(code, want, "{text}");
                assert!(text.starts_with("nexterm-cli: "), "{text}");
                assert_eq!(link.times().len(), n);
            }
        }
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![refusal("bad_request")], &idle_for("tab-term-7"));
        assert_eq!(error_of(end).1, "nexterm-cli: said bad_request [bad_request]\nRun 'nexterm-cli help wait' for more.\n");
        let clock = FakeClock::new();
        let (end, _) = go(&clock, vec![Say::Fail(FailureKind::Unreachable)], &idle_for("tab-term-7"));
        assert_eq!(error_of(end).1, "nexterm-cli: it went wrong (Unreachable)\n");
    }

    #[test]
    fn each_poll_is_its_own_list_request_at_least_a_second_apart() {
        for latency in [0.0, 0.3, 0.999, 1.5] {
            let clock = FakeClock::new();
            let mut link = Script::new(&clock, vec![st("working"), st("working"), st("idle"), st("idle"), st("exited")]);
            link.latency = secs(latency);
            let _ = wait(&idle_for("tab-term-7"), TOKEN, &address(), &link, &clock);
            let sent = link.sent.borrow();
            assert_eq!(sent.len(), 4, "{latency}");
            for (_, line) in sent.iter() {
                assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "one line each: {line:?}");
                let req: Value = serde_json::from_str(line.trim_end()).unwrap();
                assert_eq!(req, json!({"v": 1, "id": 1, "token": TOKEN, "cmd": "list", "args": {}}));
            }
            let times: Vec<Duration> = sent.iter().map(|(t, _)| *t).collect();
            for pair in times.windows(2) {
                assert!(pair[1] - pair[0] >= POLL, "{latency}: {times:?}");
            }
            if latency < 1.0 {
                assert_eq!(times, at(&[0.0, 1.0, 2.0, 3.0]), "start to start, {latency}");
            }
        }
    }

    fn report_of(target: &str, f: Finish, json: bool) -> (u8, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = report(&spec(target, IDLE, None), End::Finished(f), json, &mut out, &mut err);
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    fn fin(outcome: Outcome, code: u8, status: Option<&str>, waited: f64, reason: Option<&'static str>) -> Finish {
        Finish { outcome, code, status: status.map(Into::into), waited: secs(waited), reason }
    }

    #[test]
    fn human_output_is_one_line() {
        let cases = [
            (fin(Outcome::Idle, 0, Some("idle"), 125.4, None), "tab-term-7 is idle after 2m 5s\n", ""),
            (fin(Outcome::Exited, 0, Some("exited"), 40.0, None), "tab-term-7 exited after 40s\n", ""),
            (fin(Outcome::Closed, 0, Some("idle"), 3.0, None), "tab-term-7 was closed after 3s\n", ""),
            (
                fin(Outcome::Exited, 8, Some("exited"), 40.0, None),
                "",
                "nexterm-cli: tab-term-7 exited after 40s, before it was idle\n",
            ),
            (
                fin(Outcome::Closed, 8, Some("working"), 3.0, None),
                "",
                "nexterm-cli: tab-term-7 was closed after 3s, before it was idle\n",
            ),
            (
                fin(Outcome::Blocked, 7, Some("waiting"), 12.0, Some("waiting for input")),
                "",
                "nexterm-cli: tab-term-7 is blocked after 12s: waiting for input\n",
            ),
            (
                fin(Outcome::TimedOut, 6, Some("working"), 600.0, None),
                "",
                "nexterm-cli: tab-term-7 timed out after 10m (still working)\n",
            ),
            (
                fin(Outcome::TimedOut, 6, Some("none"), 3720.0, None),
                "",
                "nexterm-cli: tab-term-7 timed out after 1h 2m (still open)\n",
            ),
            (
                fin(Outcome::TimedOut, 6, None, 20.0, None),
                "",
                "nexterm-cli: tab-term-7 timed out after 20s (NexTerm did not answer)\n",
            ),
        ];
        for (f, out, err) in cases {
            let code = f.code;
            assert_eq!(report_of("tab-term-7", f, false), (code, out.to_owned(), err.to_owned()));
        }
        // The target as given, child: included; NexTerm's status made safe.
        let (_, out, _) = report_of("child:tab-term-7", fin(Outcome::Idle, 0, Some("idle"), 0.2, None), false);
        assert_eq!(out, "child:tab-term-7 is idle after 0s\n");
        let (_, _, err) = report_of("x", fin(Outcome::TimedOut, 6, Some("a\u{1b}[2Jb\nc"), 1.0, None), false);
        assert!(!err.contains('\u{1b}') && err.matches('\n').count() == 1, "{err:?}");
    }

    #[test]
    fn json_output_is_one_object_on_stdout_for_0_6_7_and_8() {
        let cases = [
            (fin(Outcome::Idle, 0, Some("idle"), 125.4, None), json!({"target": "child:tab-term-7", "outcome": "idle", "status": "idle", "waited_ms": 125_400})),
            (fin(Outcome::Exited, 0, Some("exited"), 40.0, None), json!({"target": "child:tab-term-7", "outcome": "exited", "status": "exited", "waited_ms": 40_000})),
            (fin(Outcome::Closed, 8, Some("working"), 3.0, None), json!({"target": "child:tab-term-7", "outcome": "closed", "status": "working", "waited_ms": 3000})),
            (fin(Outcome::Exited, 8, Some("exited"), 1.0, None), json!({"target": "child:tab-term-7", "outcome": "exited", "status": "exited", "waited_ms": 1000})),
            (
                fin(Outcome::Blocked, 7, Some("waiting"), 12.0, Some("waiting for input")),
                json!({"target": "child:tab-term-7", "outcome": "blocked", "status": "waiting", "waited_ms": 12_000}),
            ),
            (fin(Outcome::TimedOut, 6, None, 600.0, None), json!({"target": "child:tab-term-7", "outcome": "timed_out", "status": null, "waited_ms": 600_000})),
        ];
        for (f, want) in cases {
            let code = f.code;
            let (got_code, out, err) = report_of("child:tab-term-7", f, true);
            assert_eq!((got_code, err.as_str()), (code, ""), "{want}");
            assert!(out.ends_with('\n') && out.matches('\n').count() == 1, "one line: {out:?}");
            let printed: Value = serde_json::from_str(out.trim_end()).unwrap();
            assert_eq!(printed, want);
            assert!(out.starts_with(r#"{"target":"child:tab-term-7","outcome":"#), "in the documented order: {out}");
        }
        // An error is not an outcome: the usual stderr, nothing on stdout.
        let mut out = Vec::new();
        let mut err = Vec::new();
        let end = End::Error { code: 4, text: "nexterm-cli: no terminal x (see 'nexterm-cli list')\n".into() };
        assert_eq!(report(&spec("x", IDLE, None), end, true, &mut out, &mut err), 4);
        assert!(out.is_empty());
        assert_eq!(String::from_utf8(err).unwrap(), "nexterm-cli: no terminal x (see 'nexterm-cli list')\n");
    }

    #[test]
    fn the_whole_wait_end_to_end_through_report() {
        let clock = FakeClock::new();
        let s = spec("tab-term-7", IDLE, Some(600.0));
        let (end, _) = go(&clock, vec![st("working"), st("idle"), st("idle")], &s);
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(report(&s, end, false, &mut out, &mut err), 0);
        assert_eq!(String::from_utf8(out).unwrap(), "tab-term-7 is idle after 2s\n");
        assert!(err.is_empty());
    }
}
