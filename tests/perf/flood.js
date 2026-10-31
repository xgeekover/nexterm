#!/usr/bin/env node
/**
 * Output for measuring NexTerm under load (stage 4): what an agent, a build
 * or a `cat` of a big file puts through a terminal, at a rate that can be
 * named, so the same load can be run on every platform and every build.
 *
 *   node tests/perf/flood.js bulk  --mb 50          50 MB of numbered lines, as fast as the terminal takes them
 *   node tests/perf/flood.js flood --seconds 10     the same, for a time instead of a size
 *   node tests/perf/flood.js rate  --lines 2000 --seconds 10
 *                                                   a log: that many lines a second
 *   node tests/perf/flood.js tui   --fps 60 --seconds 10
 *                                                   a full-screen program: the whole screen redrawn
 *                                                   that often in the alternate screen, every frame
 *                                                   inside a synchronized update (DEC 2026), as
 *                                                   OpenCode and Claude Code draw
 *
 * Every line starts with its number (`#00000042`), so whoever reads the
 * terminal afterwards can tell whether a line went missing or came out of
 * order: the in-app runner (src/lib/perf/perfRunner.js) checks the rows it
 * still has. Lines mix ASCII, Hangul, emoji and colour, which are what make a
 * terminal's parser and renderer work for their living.
 *
 * Lines end in a bare LF, as a program's do: the terminal's own line
 * discipline (or ConPTY) makes it CR LF on the way out.
 *
 * The last line is a summary the runner reads back — what this end managed
 * to write, and how fast the terminal let it:
 *
 *   [nexterm-perf] mode=bulk lines=520000 bytes=52428800 seconds=4.21 skipped=0
 *
 * Only Node's own modules: it has to run wherever NexTerm does, from a clone
 * of the repository, with nothing installed.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const FRAGMENTS = [
  'compiling src/components/terminal/TerminalView.jsx',
  '한글 출력 확인 — 터미널이 넓은 글자를 그린다',
  '\x1b[32m✔ passed\x1b[0m \x1b[2m(12 ms)\x1b[0m',
  'emoji 🙂 👍🏽 🇰🇷 and a ZWJ 👨‍💻 in the middle',
  '\x1b[1;34minfo\x1b[0m streaming tokens from the model…',
  'error[E0308]: mismatched types \x1b[31mexpected `u16`\x1b[0m',
];

/** `--name value` pairs after the mode, as numbers. */
export function parseArgs(argv) {
  const [mode = 'bulk', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) continue;
    const value = Number(rest[i + 1]);
    if (Number.isFinite(value)) {
      options[key.slice(2)] = value;
      i += 1;
    }
  }
  return { mode, options };
}

/** Line `n`: its number first, then text that never repeats exactly. */
export function lineFor(n) {
  const fragment = FRAGMENTS[n % FRAGMENTS.length];
  return `#${String(n).padStart(8, '0')} ${fragment} ${'.'.repeat(n % 23)}\n`;
}

/** Wait until stdout has taken what it was given. */
function drained(stream) {
  return new Promise((resolve) => stream.once('drain', resolve));
}

/**
 * Write lines until `done(lines, bytes)` says to stop, in blocks of about
 * 64 KB: one write per block, so this end costs little next to the terminal
 * it is measuring.
 */
async function writeLines(out, done) {
  let lines = 0;
  let bytes = 0;
  while (!done(lines, bytes)) {
    let block = '';
    let blockBytes = 0;
    while (blockBytes < 65536 && !done(lines, bytes + blockBytes)) {
      const line = lineFor(lines);
      block += line;
      blockBytes += Buffer.byteLength(line);
      lines += 1;
    }
    bytes += blockBytes;
    if (!out.write(block)) await drained(out);
  }
  return { lines, bytes };
}

async function runRate(out, perSecond, seconds) {
  const started = Date.now();
  let lines = 0;
  let bytes = 0;
  // Ten ticks a second, each catching up to where the clock says it should
  // be, so a slow tick is made up rather than lost.
  while (Date.now() - started < seconds * 1000) {
    const due = Math.floor(((Date.now() - started) / 1000) * perSecond);
    let block = '';
    while (lines < due) {
      block += lineFor(lines);
      lines += 1;
    }
    if (block) {
      bytes += Buffer.byteLength(block);
      if (!out.write(block)) await drained(out);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { lines, bytes };
}

/** One frame of the full-screen program: every row, positioned, inside a synchronized update. */
export function frameFor(frame, cols, rows) {
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[frame % 10];
  let out = '\x1b[?2026h';
  for (let row = 1; row <= rows; row += 1) {
    const text =
      row === 1
        ? `${spinner} frame ${frame} — ${cols}×${rows}`
        : `${String(row).padStart(3)} ${FRAGMENTS[(frame + row) % FRAGMENTS.length]}`;
    // Cut to the width in characters, which is never more than the width in
    // cells: a wide character takes two.
    const visible = Array.from(text.replace(/\x1b\[[0-9;]*m/g, '')).slice(0, Math.max(1, cols - 1)).join('');
    out += `\x1b[${row};1H\x1b[2K\x1b[${30 + ((frame + row) % 8)}m${visible}\x1b[0m`;
  }
  return `${out}\x1b[?2026l`;
}

async function runTui(out, fps, seconds) {
  const cols = out.columns || 80;
  const rows = out.rows || 24;
  out.write('\x1b[?1049h\x1b[?25l');
  const started = Date.now();
  let frames = 0;
  let skipped = 0;
  let bytes = 0;
  let waiting = false;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - started >= seconds * 1000) {
        clearInterval(timer);
        resolve();
        return;
      }
      // A terminal that cannot keep up gets fewer frames, as a real
      // program's would: nothing piles up behind it.
      if (waiting) {
        skipped += 1;
        return;
      }
      const frame = frameFor(frames, cols, rows);
      frames += 1;
      bytes += Buffer.byteLength(frame);
      if (!out.write(frame)) {
        waiting = true;
        out.once('drain', () => {
          waiting = false;
        });
      }
    }, 1000 / fps);
  });
  out.write('\x1b[?25h\x1b[?1049l');
  return { lines: frames, bytes, skipped };
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));
  const out = process.stdout;
  const started = Date.now();
  let result;
  if (mode === 'bulk') {
    const limit = (options.mb ?? 50) * 1024 * 1024;
    result = await writeLines(out, (_lines, bytes) => bytes >= limit);
  } else if (mode === 'flood') {
    const until = started + (options.seconds ?? 10) * 1000;
    result = await writeLines(out, () => Date.now() >= until);
  } else if (mode === 'rate') {
    result = await runRate(out, options.lines ?? 2000, options.seconds ?? 10);
  } else if (mode === 'tui') {
    result = await runTui(out, options.fps ?? 60, options.seconds ?? 10);
  } else {
    process.stderr.write(`unknown mode: ${mode} (bulk, flood, rate, tui)\n`);
    process.exit(2);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  out.write(
    `\n[nexterm-perf] mode=${mode} lines=${result.lines} bytes=${result.bytes} seconds=${seconds} skipped=${result.skipped ?? 0}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  });
}
