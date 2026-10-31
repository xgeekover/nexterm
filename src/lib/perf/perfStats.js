/**
 * The arithmetic of performance mode (stage 4), kept apart from the app so
 * the suites can check it: percentiles of what was timed, whether a
 * terminal kept every line it was sent, and what tests/perf/flood.js said
 * about its own end of the run.
 *
 * Shared with tests/perf/summarize.js, which runs under plain Node: nothing
 * here may touch the DOM, the stores or the backend.
 */

/** `values` sorted ascending (a copy). */
function sorted(values) {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
}

/** Nearest-rank percentile `p` (0–100) of ascending `list`, or null for none. */
export function percentile(list, p) {
  if (list.length === 0) return null;
  const rank = Math.min(list.length, Math.max(1, Math.ceil((p / 100) * list.length)));
  return list[rank - 1];
}

const round = (value, digits = 1) => (value === null ? null : Number(value.toFixed(digits)));

/** Count, median, p95, p99, max and mean of a list of times (ms). */
export function summarizeTimes(values) {
  const list = sorted(values);
  const mean = list.length ? list.reduce((total, v) => total + v, 0) / list.length : null;
  return {
    count: list.length,
    p50: round(percentile(list, 50)),
    p95: round(percentile(list, 95)),
    p99: round(percentile(list, 99)),
    max: round(list.length ? list[list.length - 1] : null),
    mean: round(mean),
  };
}

/**
 * Frame intervals (ms between animation frames): the times, and how many
 * frames took longer than the eye forgives — 50 ms is a stutter, 100 ms a
 * freeze anyone notices.
 */
export function summarizeFrames(intervals) {
  const list = sorted(intervals);
  return {
    ...summarizeTimes(list),
    over50: list.filter((v) => v > 50).length,
    over100: list.filter((v) => v > 100).length,
  };
}

/** The median of `values`, ignoring what is not a number; null for none. */
export function median(values) {
  const list = sorted(values);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

const LINE_NUMBER = /^#(\d{8}) /;

/**
 * Whether the numbered lines tests/perf/flood.js wrote are all still there,
 * in order, among `rows` — the terminal's text, wrapped rows already joined.
 * Only the lines the scrollback still holds can be checked, so a terminal
 * holding fewer is not a loss; one number not following the one before is.
 *
 *   gaps        a number further on than the next: lines lost between them
 *   outOfOrder  a number at or before the one before it: lines reordered or repeated
 */
export function checkSequence(rows) {
  let checked = 0;
  let first = null;
  let last = null;
  let gaps = 0;
  let outOfOrder = 0;
  for (const row of rows) {
    const match = LINE_NUMBER.exec(row);
    if (!match) continue;
    const n = Number(match[1]);
    if (last !== null) {
      if (n === last + 1) {
        // as it should be
      } else if (n > last + 1) gaps += 1;
      else outOfOrder += 1;
    }
    if (first === null) first = n;
    last = n;
    checked += 1;
  }
  return { checked, first, last, gaps, outOfOrder };
}

const SUMMARY = /\[nexterm-perf\] mode=(\w+) lines=(\d+) bytes=(\d+) seconds=([\d.]+) skipped=(\d+)/;

/** flood.js's last line, read back from `text`: what its end wrote, and how fast. */
export function parseGeneratorSummary(text) {
  const match = SUMMARY.exec(typeof text === 'string' ? text : '');
  if (!match) return null;
  const [, mode, lines, bytes, seconds, skipped] = match;
  const secs = Number(seconds);
  return {
    mode,
    lines: Number(lines),
    bytes: Number(bytes),
    seconds: secs,
    skipped: Number(skipped),
    mbPerSecond: secs > 0 ? round(Number(bytes) / 1048576 / secs, 2) : null,
  };
}

/** What changed in the backend's counters (src/perf.rs) between two reads. */
export function counterDelta(before, after) {
  if (!before || !after) return null;
  const d = (key) => Math.max(0, (after[key] ?? 0) - (before[key] ?? 0));
  const emits = d('emits');
  return {
    reads: d('reads'),
    readBytes: d('read_bytes'),
    emits,
    emitBytes: d('emit_bytes'),
    emitMs: round(d('emit_nanos') / 1e6),
    emitMaxMs: round((after.emit_max_nanos ?? 0) / 1e6, 2),
    bytesPerEmit: emits ? Math.round(d('emit_bytes') / emits) : null,
    // Flow control (src-tauri/src/pty/flow_gate.rs): readers held for a page behind.
    holds: d('holds'),
    heldMs: round(d('held_nanos') / 1e6),
  };
}

/**
 * CPU of each group (tests/perf/cpu.js's samples) over `[from, to]` (epoch
 * ms), as a percentage of one core, and the most memory either held. The
 * samples nearest inside the window are used; null when fewer than two fall
 * in it.
 */
export function cpuOver(samples, from, to) {
  const inside = samples.filter((s) => s && s.t >= from && s.t <= to).sort((a, b) => a.t - b.t);
  if (inside.length < 2) return null;
  const a = inside[0];
  const b = inside[inside.length - 1];
  const seconds = (b.t - a.t) / 1000;
  if (seconds <= 0) return null;
  const pct = (group) => round(((b[group]?.cpu ?? 0) - (a[group]?.cpu ?? 0)) / seconds * 100);
  const peak = (group) => Math.max(...inside.map((s) => s[group]?.rss ?? 0));
  return {
    seconds: round(seconds),
    appPercent: pct('app'),
    webviewPercent: pct('webview'),
    appPeakRss: peak('app'),
    webviewPeakRss: peak('webview'),
  };
}
