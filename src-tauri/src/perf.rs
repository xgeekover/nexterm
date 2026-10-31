//! Performance mode: what a measuring run of the app counts and how it is
//! set up (stage 4 — several agents printing at once).
//!
//! Off unless the app is started with `NEXTERM_PERF` set to anything but
//! empty or `0`. Then the PTY readers count what they read and what they
//! emit, the frontend loads its probe and, when `NEXTERM_PERF_SCENARIOS`
//! names some, runs them and writes a report (src/lib/perf/, TEST_INFRA.md).
//! Off, each count is one load of a flag that never changes, and nothing is
//! timed.
//!
//! Read from the environment, never from settings: a measuring run is
//! started on purpose, from a shell, and a setting left on would slow every
//! later session down without saying so.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;

/// Whether `value`, an environment variable's, switches something on.
pub fn env_flag(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some(v) if !v.is_empty() && v != "0")
}

/// Whether this run of the app is being measured. Read once.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| env_flag(std::env::var("NEXTERM_PERF").ok().as_deref()))
}

/// How long a session's output may be held while it flows
/// (pty/output_batch.rs). A measuring run may set it with
/// `NEXTERM_PERF_BATCH_MS` — `0` sends every read as it comes, as before
/// batching — to compare the two in one build; nothing else can.
pub fn batch_window() -> std::time::Duration {
    static WINDOW: OnceLock<std::time::Duration> = OnceLock::new();
    *WINDOW.get_or_init(|| {
        let asked = enabled()
            .then(|| std::env::var("NEXTERM_PERF_BATCH_MS").ok())
            .flatten()
            .and_then(|v| v.trim().parse::<u64>().ok());
        match asked {
            Some(ms) => std::time::Duration::from_millis(ms.min(100)),
            None => crate::pty::output_batch::DEFAULT_WINDOW,
        }
    })
}

/// A session's flow control (pty/flow_gate.rs). A measuring run may set the
/// high-water mark with `NEXTERM_PERF_FLOW_KB` — `0` turns the hold off, as
/// before flow control — to compare the two in one build; nothing else can.
pub fn flow_gate() -> crate::pty::flow_gate::FlowGate {
    use crate::pty::flow_gate::{FlowGate, HIGH_WATER, LOW_WATER, STALL};
    static HIGH: OnceLock<Option<u64>> = OnceLock::new();
    let high = *HIGH.get_or_init(|| {
        enabled()
            .then(|| std::env::var("NEXTERM_PERF_FLOW_KB").ok())
            .flatten()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(|kb| if kb == 0 { u64::MAX } else { kb.saturating_mul(1024) })
    });
    match high {
        Some(high) => FlowGate::new(high, high / 2, STALL),
        None => FlowGate::new(HIGH_WATER, LOW_WATER, STALL),
    }
}

/// Since the app started, across every session.
struct Counters {
    reads: AtomicU64,
    read_bytes: AtomicU64,
    emits: AtomicU64,
    emit_bytes: AtomicU64,
    emit_nanos: AtomicU64,
    emit_max_nanos: AtomicU64,
    holds: AtomicU64,
    held_nanos: AtomicU64,
}

static COUNTERS: Counters = Counters {
    reads: AtomicU64::new(0),
    read_bytes: AtomicU64::new(0),
    emits: AtomicU64::new(0),
    emit_bytes: AtomicU64::new(0),
    emit_nanos: AtomicU64::new(0),
    emit_max_nanos: AtomicU64::new(0),
    holds: AtomicU64::new(0),
    held_nanos: AtomicU64::new(0),
};

/// A PTY reader got `bytes` from one `read`.
#[inline]
pub fn note_read(bytes: usize) {
    if enabled() {
        COUNTERS.reads.fetch_add(1, Ordering::Relaxed);
        COUNTERS.read_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }
}

/// Now, if anyone is measuring: the start of an emit or of a hold.
#[inline]
pub fn emit_started() -> Option<Instant> {
    enabled().then(Instant::now)
}

/// A reader held by flow control (pty/flow_gate.rs) from `started` until now.
#[inline]
pub fn note_hold(started: Option<Instant>) {
    let Some(started) = started else { return };
    COUNTERS.holds.fetch_add(1, Ordering::Relaxed);
    COUNTERS.held_nanos.fetch_add(started.elapsed().as_nanos().min(u64::MAX as u128) as u64, Ordering::Relaxed);
}

/// A `pty-output` emit of `bytes` (UTF-8) that began at `started`.
#[inline]
pub fn note_emit(started: Option<Instant>, bytes: usize) {
    let Some(started) = started else { return };
    let nanos = started.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    COUNTERS.emits.fetch_add(1, Ordering::Relaxed);
    COUNTERS.emit_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    COUNTERS.emit_nanos.fetch_add(nanos, Ordering::Relaxed);
    COUNTERS.emit_max_nanos.fetch_max(nanos, Ordering::Relaxed);
}

/// The counts so far. The longest emit is the longest since the last read
/// of the counts: each scenario asks for its own.
#[derive(Clone, Debug, Serialize)]
pub struct PerfCounters {
    pub reads: u64,
    pub read_bytes: u64,
    pub emits: u64,
    pub emit_bytes: u64,
    pub emit_nanos: u64,
    pub emit_max_nanos: u64,
    pub holds: u64,
    pub held_nanos: u64,
}

pub fn counters() -> PerfCounters {
    PerfCounters {
        reads: COUNTERS.reads.load(Ordering::Relaxed),
        read_bytes: COUNTERS.read_bytes.load(Ordering::Relaxed),
        emits: COUNTERS.emits.load(Ordering::Relaxed),
        emit_bytes: COUNTERS.emit_bytes.load(Ordering::Relaxed),
        emit_nanos: COUNTERS.emit_nanos.load(Ordering::Relaxed),
        emit_max_nanos: COUNTERS.emit_max_nanos.swap(0, Ordering::Relaxed),
        holds: COUNTERS.holds.load(Ordering::Relaxed),
        held_nanos: COUNTERS.held_nanos.load(Ordering::Relaxed),
    }
}

/// How a measuring run is set up, for the frontend.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PerfInfo {
    pub enabled: bool,
    /// The app's own process, for tests/perf/cpu.js.
    pub pid: u32,
    /// `NEXTERM_PERF_SCENARIOS`, e.g. `S1,S2`: run these, then write the report.
    pub scenarios: Vec<String>,
    /// `NEXTERM_PERF_REPEAT`: how many times each, 1 to 20 (3).
    pub repeat: u32,
    /// `NEXTERM_PERF_OUT`, or `nexterm-perf` in the temporary folder.
    pub out_dir: String,
    /// `NEXTERM_PERF_TOOLS`: the folder holding tests/perf's scripts. Unset,
    /// the frontend looks in the open folder's `tests/perf`.
    pub tools_dir: Option<String>,
    /// `NEXTERM_PERF_PACE_MS` and `NEXTERM_PERF_PACE_KB`: how output for a
    /// terminal without focus is paced (terminalRegistry.js), to compare in
    /// one build. Unset, the app's own.
    pub pace_ms: Option<u32>,
    pub pace_kb: Option<u32>,
}

/// Scenario names: short, letters and digits, upper-cased; anything else dropped.
pub fn parse_scenarios(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(|name| name.trim().to_ascii_uppercase())
        .filter(|name| !name.is_empty() && name.len() <= 8 && name.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect()
}

pub fn parse_repeat(value: Option<&str>) -> u32 {
    value.and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(3).clamp(1, 20)
}

pub fn out_dir() -> PathBuf {
    match std::env::var_os("NEXTERM_PERF_OUT") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => std::env::temp_dir().join("nexterm-perf"),
    }
}

pub fn info() -> PerfInfo {
    if !enabled() {
        // Nothing about the environment leaves the backend unless asked for.
        return PerfInfo::default();
    }
    PerfInfo {
        enabled: true,
        pid: std::process::id(),
        scenarios: parse_scenarios(std::env::var("NEXTERM_PERF_SCENARIOS").ok().as_deref()),
        repeat: parse_repeat(std::env::var("NEXTERM_PERF_REPEAT").ok().as_deref()),
        out_dir: out_dir().to_string_lossy().into_owned(),
        tools_dir: std::env::var("NEXTERM_PERF_TOOLS").ok().filter(|v| !v.trim().is_empty()),
        pace_ms: env_number("NEXTERM_PERF_PACE_MS"),
        pace_kb: env_number("NEXTERM_PERF_PACE_KB"),
    }
}

fn env_number(name: &str) -> Option<u32> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u32>().ok())
}

/// Whether `name` may be a report's file name: one plain name, no folder.
pub fn report_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 80
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.contains("..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_value_switches_it_on() {
        assert!(!env_flag(None));
        assert!(!env_flag(Some("")));
        assert!(!env_flag(Some(" 0 ")));
        assert!(env_flag(Some("1")));
        assert!(env_flag(Some("yes")));
    }

    #[test]
    fn scenario_names_are_short_and_plain() {
        assert_eq!(parse_scenarios(Some("s1, S2 ,,s3")), vec!["S1", "S2", "S3"]);
        assert_eq!(parse_scenarios(Some("S1;rm -rf,../x,S4")), vec!["S4"]);
        assert!(parse_scenarios(None).is_empty());
    }

    #[test]
    fn repeat_is_held_to_its_range() {
        assert_eq!(parse_repeat(None), 3);
        assert_eq!(parse_repeat(Some("0")), 1);
        assert_eq!(parse_repeat(Some("99")), 20);
        assert_eq!(parse_repeat(Some("x")), 3);
        assert_eq!(parse_repeat(Some(" 5 ")), 5);
    }

    #[test]
    fn a_report_goes_into_its_folder_and_nowhere_else() {
        assert!(report_name_ok("report-1761900000.json"));
        assert!(report_name_ok("cpu.jsonl"));
        for bad in ["", "../x.json", "a/b.json", "a\\b.json", ".hidden", "x..json", "C:x", &"a".repeat(81)] {
            assert!(!report_name_ok(bad), "{bad}");
        }
    }
}
