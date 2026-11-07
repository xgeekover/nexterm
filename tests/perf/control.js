#!/usr/bin/env node
/**
 * The control API's round trip as an agent's hook pays it (stage 7, spec
 * D9): `nexterm-cli set-status …` run again and again from a terminal, each
 * call timed from before the CLI is started to after it has exited — the
 * process starting, connecting, authenticating, the page's round trip and
 * the answer, all of it. The target is p95 under 20 ms.
 *
 *   node tests/perf/control.js --count 200 --interval 60
 *   node tests/perf/control.js --count 50 --cli /path/to/nexterm-cli
 *
 * The CLI is `--cli`, else `$NEXTERM_CLI` (the absolute path every shell
 * NexTerm starts is given), else `nexterm-cli` on the PATH. Calls are
 * `--interval` ms apart (60 by default): the backend allows one token 20
 * requests a second with a burst of 40 (spec D6), and calls back to back
 * would measure the rate limit, not the round trip. Each sets another text,
 * so the page does write the store every time, as a hook's would; the
 * status is cleared at the end.
 *
 * The last line is a summary the in-app runner (src/lib/perf/perfRunner.js,
 * scenario S7) reads back — milliseconds, `-` where nothing was measured:
 *
 *   [nexterm-perf-control] calls=200 failed=0 p50=4.12 p95=6.80 p99=9.10 max=12.30 mean=4.50
 *
 * and after it, when a call failed, what the first failure said:
 *
 *   [nexterm-perf-control] first-error exit=4 refused: ...
 *
 * Node's own modules and the repository's percentile rule: it runs from a
 * clone of the repository with nothing installed, as flood.js does.
 */
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { percentile } from '../../src/lib/perf/perfStats.js';

/** `--count 200 --interval 60 --cli PATH`. */
export function parseArgs(argv) {
  const options = { count: 200, interval: 60, cli: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--cli' && value) {
      options.cli = value;
      i += 1;
    } else if ((key === '--count' || key === '--interval') && Number.isFinite(Number(value))) {
      options[key.slice(2)] = Math.max(0, Math.floor(Number(value)));
      i += 1;
    }
  }
  return options;
}

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

/** The summary line for `times` (ms) and how many calls `failed`. */
export function summaryLine(times, failed) {
  const list = times.filter((t) => typeof t === 'number' && Number.isFinite(t)).sort((a, b) => a - b);
  const mean = list.length ? list.reduce((sum, t) => sum + t, 0) / list.length : null;
  const f = (n) => (n === null ? '-' : round(n).toFixed(2));
  return `[nexterm-perf-control] calls=${list.length + failed} failed=${failed} p50=${f(percentile(list, 50))} p95=${f(percentile(list, 95))} p99=${f(percentile(list, 99))} max=${f(list.length ? list[list.length - 1] : null)} mean=${f(mean)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the CLI once with `args`: how long it took, and how it ended. A `.js`
 * or `.mjs` CLI — the suites' stand-in — is run with this Node, which works
 * on every platform without a shebang.
 */
function callOnce(cli, args) {
  const script = /\.m?js$/i.test(cli);
  const started = process.hrtime.bigint();
  const out = spawnSync(script ? process.execPath : cli, script ? [cli, ...args] : args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const said = String(out.stderr || out.stdout || out.error?.message || '').split('\n').find((line) => line.trim()) ?? '';
  return { ms, ok: out.status === 0, status: out.status ?? (out.error ? 'error' : 'signal'), said: said.trim().slice(0, 200) };
}

async function main() {
  const { count, interval, cli: given } = parseArgs(process.argv.slice(2));
  const cli = given || process.env.NEXTERM_CLI || 'nexterm-cli';
  const times = [];
  let failed = 0;
  let firstError = null;
  for (let i = 1; i <= count; i += 1) {
    const call = callOnce(cli, ['set-status', `perf ${i}/${count}`]);
    if (call.ok) times.push(call.ms);
    else {
      failed += 1;
      firstError ??= call;
    }
    if (interval > 0 && i < count) await sleep(interval);
  }
  callOnce(cli, ['set-status', '--clear']);
  process.stdout.write(`${summaryLine(times, failed)}\n`);
  if (firstError) process.stdout.write(`[nexterm-perf-control] first-error exit=${firstError.status} ${firstError.said}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
