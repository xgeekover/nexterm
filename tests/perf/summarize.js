#!/usr/bin/env node
/**
 * A performance run's report as a table (stage 4).
 *
 *   node tests/perf/summarize.js <report-….json>
 *
 * Reads the report the app wrote (src/lib/perf/perfRunner.js) and the CPU
 * samples it names (tests/perf/cpu.js), works out each run's CPU, and writes
 * the table beside the report as `report-….md` — and prints it. Each figure
 * is the median of the scenario's repeats.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cpuOver, median } from '../../src/lib/perf/perfStats.js';

export function readSamples(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const fmt = (value, digits = 0) => (value === null || value === undefined || Number.isNaN(value) ? '–' : Number(value).toFixed(digits));
const mb = (bytes) => (bytes ? bytes / 1048576 : null);

/** One row per scenario: the medians of its runs. */
export function scenarioRows(report, samples) {
  const byScenario = new Map();
  for (const run of report.runs ?? []) {
    if (!byScenario.has(run.scenario)) byScenario.set(run.scenario, []);
    byScenario.get(run.scenario).push(run);
  }
  const rows = [];
  for (const [scenario, runs] of byScenario) {
    const ok = runs.filter((r) => !r.error);
    const cpu = ok.map((r) => cpuOver(samples, r.startedAtEpoch, r.endedAtEpoch));
    const m = (pick) => median(ok.map(pick));
    const terminals = (r) => r.terminals ?? [];
    rows.push({
      scenario,
      title: runs[0].title,
      runs: `${ok.length}/${runs.length}`,
      errors: runs.filter((r) => r.error).map((r) => r.error),
      seconds: m((r) => r.durationMs / 1000),
      eventsPerSecond: m((r) => r.page?.eventsPerSecond),
      charsPerEvent: m((r) => r.page?.charsPerEvent),
      readsPerEmit: m((r) => (r.backend?.emits ? r.backend.reads / r.backend.emits : null)),
      frameP50: m((r) => r.page?.frames?.p50),
      frameP95: m((r) => r.page?.frames?.p95),
      frameMax: m((r) => r.page?.frames?.max),
      over50: m((r) => r.page?.frames?.over50),
      over100: m((r) => r.page?.frames?.over100),
      writeLagP95: m((r) => r.page?.writeLag?.p95),
      writeLagMax: m((r) => r.page?.writeLag?.max),
      typingP50: m((r) => r.typing?.p50),
      typingP95: m((r) => r.typing?.p95),
      typingMax: m((r) => r.typing?.max),
      typingLost: m((r) => r.typing?.lost),
      drainSeconds: m((r) => Math.max(...terminals(r).map((t) => t.drainMs ?? 0)) / 1000),
      generatorMBps: m((r) => terminals(r).reduce((total, t) => total + (t.generator?.mbPerSecond ?? 0), 0)),
      appCpu: median(cpu.map((c) => c?.appPercent)),
      webviewCpu: median(cpu.map((c) => c?.webviewPercent)),
      peakRssMB: median(cpu.map((c) => mb((c?.appPeakRss ?? 0) + (c?.webviewPeakRss ?? 0)))),
      lostLines: ok.reduce((total, r) => total + terminals(r).reduce((n, t) => n + (t.sequence?.gaps ?? 0) + (t.sequence?.outOfOrder ?? 0), 0), 0),
      timedOut: runs.filter((r) => r.timedOut).length,
    });
  }
  return rows;
}

export function toMarkdown(report, rows) {
  const env = report.environment ?? {};
  const lines = [
    `# NexTerm performance run — ${report.startedAt ?? ''}`,
    '',
    `- App ${env.appVersion ?? '?'} on ${env.os ?? '?'}; window ${env.window?.width ?? '?'}×${env.window?.height ?? '?'} @${env.window?.devicePixelRatio ?? '?'}x; font ${env.terminal?.fontFamily ?? '?'} ${env.terminal?.fontSize ?? '?'}px; scrollback ${env.terminal?.scrollback ?? '?'}`,
    `- ${env.repeat ?? '?'} run(s) per scenario; every figure is the median of them. CPU is % of one core.`,
    report.error ? `- **The run did not start:** ${report.error}` : null,
    report.cpuError ? `- **No CPU figures:** ${report.cpuError}` : null,
    '',
    '| | Runs | Time s | Events/s | Chars/event | Reads/emit | Frame p50/p95/max ms | Frames >50/>100 ms | Write lag p95/max ms | Typing p50/p95/max ms (lost) | Drain s | Generator MB/s | CPU app/webview % | Peak RSS MB | Lost lines |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ].filter((line) => line !== null);
  for (const r of rows) {
    lines.push(
      `| **${r.scenario}** ${r.title} | ${r.runs}${r.timedOut ? ` (${r.timedOut} timed out)` : ''} | ${fmt(r.seconds, 1)} | ${fmt(r.eventsPerSecond)} | ${fmt(r.charsPerEvent)} | ${fmt(r.readsPerEmit, 2)} | ${fmt(r.frameP50, 1)} / ${fmt(r.frameP95, 1)} / ${fmt(r.frameMax)} | ${fmt(r.over50)} / ${fmt(r.over100)} | ${fmt(r.writeLagP95)} / ${fmt(r.writeLagMax)} | ${fmt(r.typingP50)} / ${fmt(r.typingP95)} / ${fmt(r.typingMax)} (${fmt(r.typingLost)}) | ${fmt(r.drainSeconds, 1)} | ${fmt(r.generatorMBps, 1)} | ${fmt(r.appCpu)} / ${fmt(r.webviewCpu)} | ${fmt(r.peakRssMB)} | ${r.lostLines} |`
    );
  }
  const errors = rows.flatMap((r) => r.errors.map((e) => `- ${r.scenario}: ${e}`));
  if (errors.length) lines.push('', '**Runs that failed**', '', ...errors);
  return `${lines.join('\n')}\n`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node tests/perf/summarize.js <report.json>\n');
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const markdown = toMarkdown(report, scenarioRows(report, readSamples(report.cpuFile)));
  const out = file.replace(/\.json$/i, '') + '.md';
  fs.writeFileSync(out, markdown);
  process.stdout.write(`${markdown}\nwritten to ${out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
