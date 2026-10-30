#!/usr/bin/env node
/**
 * How much CPU NexTerm uses, sampled from outside it (stage 4).
 *
 *   node tests/perf/cpu.js --pid <NexTerm's pid> --out <file.jsonl> [--interval 1000]
 *
 * A terminal's cost is not all in the app's own process: the page — xterm's
 * parser, its renderer, React — runs in the web view's processes, which the
 * app does not own the way it owns a thread. So two groups are summed:
 *
 *   app      the NexTerm process itself (Rust: the PTY readers, IPC)
 *   webview  macOS: the WebKit processes (com.apple.WebKit.*) that started
 *            with the app — they are launchd's children, not the app's, so
 *            "started no earlier than two seconds before it" is how they are
 *            told from Safari's; Windows: every msedgewebview2.exe under the
 *            app; Linux: every WebKit* process under the app
 *
 * Shells and the programs in them are counted in neither: they are the load,
 * not the terminal.
 *
 * One JSON line per sample, CPU in cumulative seconds (so a missed sample
 * loses nothing) and memory in bytes:
 *
 *   {"t":1761900000000,"app":{"cpu":12.4,"rss":201326592,"pids":[123]},"webview":{...}}
 *
 * tests/perf/summarize.js turns the samples into a percentage per scenario.
 * Runs until killed — the in-app runner closes the terminal it runs in.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const options = { interval: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--pid') options.pid = Number(value);
    else if (key === '--out') options.out = value;
    else if (key === '--interval') options.interval = Number(value);
    else continue;
    i += 1;
  }
  return options;
}

/** `[[dd-]hh:]mm:ss[.cc]` (ps's etime and time) in seconds. */
export function psDuration(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = rest.split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(days) * 86400 + seconds;
}

/** Every process below `root` in `parentOf` (pid → ppid). */
export function descendantsOf(root, parentOf) {
  const below = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parentOf) {
      if (!below.has(pid) && (ppid === root || below.has(ppid))) {
        below.add(pid);
        grew = true;
      }
    }
  }
  return below;
}

/**
 * One `ps` line: `pid ppid etime time rss comm…` (macOS and Linux spell
 * these the same; comm may hold spaces, so it is everything after the fifth).
 */
export function parsePsLine(line) {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [pid, ppid, etime, time, rss] = fields;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    age: psDuration(etime),
    cpu: psDuration(time),
    rss: Number(rss) * 1024,
    comm: fields.slice(5).join(' '),
  };
}

/** Which of `rows` are the app and which its web view, on a unix. */
export function groupUnix(rows, appPid, platform) {
  const app = rows.find((r) => r.pid === appPid);
  if (!app) return null;
  let webview;
  if (platform === 'darwin') {
    webview = rows.filter((r) => r.comm.includes('com.apple.WebKit') && r.age <= app.age + 2);
  } else {
    const below = descendantsOf(appPid, new Map(rows.map((r) => [r.pid, r.ppid])));
    webview = rows.filter((r) => below.has(r.pid) && /WebKit/.test(r.comm));
  }
  return { app: [app], webview };
}

function sum(rows) {
  return {
    cpu: Number(rows.reduce((total, r) => total + r.cpu, 0).toFixed(3)),
    rss: rows.reduce((total, r) => total + r.rss, 0),
    pids: rows.map((r) => r.pid),
  };
}

function sampleUnix(appPid, platform) {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,etime=,time=,rss=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const rows = stdout.split('\n').map(parsePsLine).filter(Boolean);
      const groups = groupUnix(rows, appPid, platform);
      resolve(groups && { app: sum(groups.app), webview: sum(groups.webview) });
    });
  });
}

/**
 * Windows: one PowerShell for the whole run, printing the process tree every
 * tenth tick (`T|pid|ppid|name`) and every process's CPU seconds and working
 * set each tick (`C|pid|cpu|ws`), each list ended by a line of its own.
 * Starting PowerShell once a second would cost more than what is measured.
 */
const WINDOWS_LOOP = (interval) => `
$i = 0
while ($true) {
  if ($i % 10 -eq 0) {
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "T|$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }
    "T-END"
  }
  Get-Process | ForEach-Object { "C|$($_.Id)|$($_.CPU)|$($_.WorkingSet64)" }
  "C-END"
  $i++
  Start-Sleep -Milliseconds ${interval}
}`;

/** The groups of one Windows tick, from the latest tree. */
export function groupWindows(cpuRows, tree, appPid) {
  const below = descendantsOf(appPid, new Map([...tree].map(([pid, row]) => [pid, row.ppid])));
  const app = cpuRows.filter((r) => r.pid === appPid);
  if (app.length === 0) return null;
  const webview = cpuRows.filter((r) => below.has(r.pid) && /^msedgewebview2(\.exe)?$/i.test(tree.get(r.pid)?.name ?? ''));
  return { app: sum(app), webview: sum(webview) };
}

function sampleWindows(appPid, interval, onSample) {
  const encoded = Buffer.from(WINDOWS_LOOP(interval), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let tree = new Map();
  let nextTree = new Map();
  let rows = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const [kind, a, b, c] = line.split('|');
      if (kind === 'T') nextTree.set(Number(a), { ppid: Number(b), name: c });
      else if (line === 'T-END') {
        tree = nextTree;
        nextTree = new Map();
      } else if (kind === 'C') {
        rows.push({ pid: Number(a), cpu: Number(b) || 0, rss: Number(c) || 0 });
      } else if (line === 'C-END') {
        const groups = groupWindows(rows, tree, appPid);
        rows = [];
        if (groups) onSample(groups);
      }
    }
  });
  return child;
}

async function main() {
  const { pid, out, interval } = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(pid) || !out) {
    process.stderr.write('usage: node tests/perf/cpu.js --pid <NexTerm pid> --out <file.jsonl> [--interval ms]\n');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const write = (groups) => fs.appendFileSync(out, `${JSON.stringify({ t: Date.now(), ...groups })}\n`);
  process.stdout.write(`[nexterm-perf] sampling ${pid} into ${out}\n`);
  if (process.platform === 'win32') {
    const child = sampleWindows(pid, interval, write);
    const stop = () => {
      child.kill();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  for (;;) {
    const groups = await sampleUnix(pid, process.platform);
    if (!groups) {
      process.stdout.write('[nexterm-perf] the app is gone; stopping\n');
      return;
    }
    write(groups);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  });
}
