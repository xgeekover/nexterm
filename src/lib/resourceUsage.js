/**
 * What a terminal's programs use (bundle 4, B8): the words and figures the
 * TERMINALS row and a tab's hover card show, and when the page asks for them.
 * Pure: no store, no timer, no IPC. The sampler is src/hooks/
 * useResourceSampler.js, the figures it keeps src/stores/
 * resourceUsageStore.js, and the measuring the backend's
 * (src-tauri/src/pty/resources.rs, `pty_resource_usage`).
 *
 * The backend answers, per terminal, the CPU of the shell's whole process
 * tree since its last call — 100 is one core, on every OS, so a tree keeping
 * two cores busy is 200 — or null on its first call; the resident memory of
 * that tree added up; how many processes it has; and `partial` when some of
 * them could not be read, so the figures leave them out.
 *
 * Memory is shown in binary units labelled MB and GB, as Activity Monitor and
 * Task Manager show it: 1 MB here is 1024 × 1024 bytes and 1 GB 1024 MB.
 * Under 1 GB: whole MB ('340 MB'). From 1 GB: GB with one decimal ('1.2 GB');
 * a figure that rounds to 1024 MB is already '1.0 GB'. CPU is a whole
 * percent ('0%', '12%', '140%').
 *
 * A WSL terminal is never measured: its Linux programs run in WSL's own
 * machine, where Windows — and so NexTerm — cannot see them; the Windows side
 * is only the launcher. It shows 'not measurable' instead of figures.
 */
import { shellKindFor } from './dropPaths.js';
import { shellPathOf } from './terminalFileDrop.js';

/** The setting, in settingsStore.js's SETTINGS_DEFAULTS: Settings ▸ Terminal ▸ Show CPU and Memory. */
export const RESOURCE_SETTING = 'terminalShowResources';

/** How often the page asks, while it asks at all (`shouldSample`). */
export const RESOURCE_SAMPLE_MS = 5000;

/**
 * How long after the first answer of a run the page asks once more: that
 * first answer's CPU is measuring, and this one gives a real CPU figure 1 s
 * later instead of 5 s later (a card opened with the TERMINALS panel hidden
 * shows it about 1.6 s after the pointer came onto its tab). One extra call
 * per run.
 */
export const RESOURCE_FOLLOW_UP_MS = 1000;

/** Shown for the CPU of a terminal's first sample: there is nothing yet to measure it against. */
export const RESOURCE_MEASURING = 'measuring';

/** Shown instead of figures for a WSL terminal. */
export const RESOURCE_NOT_MEASURABLE = 'not measurable';

/** Marks figures that leave out a process that could not be read. */
export const RESOURCE_PARTIAL = 'partial';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const finiteAtLeastZero = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * CPU as a whole percent of one core — '0%', '12%', '140%' — or
 * RESOURCE_MEASURING for null (a terminal's first sample) or anything that
 * is not a figure at all.
 */
export function formatCpu(cpuPercent) {
  if (!finiteAtLeastZero(cpuPercent)) return RESOURCE_MEASURING;
  return `${Math.round(cpuPercent)}%`;
}

/**
 * Memory in binary units labelled MB and GB (see the head of this file):
 * '340 MB', '1.2 GB'; '0 MB' for nothing, '<1 MB' for less than one MB but
 * not nothing. '' for anything that is not a count of bytes.
 */
export function formatMemory(bytes) {
  if (!finiteAtLeastZero(bytes)) return '';
  if (bytes === 0) return '0 MB';
  if (bytes < MIB) return '<1 MB';
  const mb = Math.round(bytes / MIB);
  if (mb < 1024) return `${mb} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * The short form for a row or a card: '12% · 340 MB', 'measuring · 340 MB'
 * on a first sample, '12% · 340 MB · partial' when a process could not be
 * read, RESOURCE_NOT_MEASURABLE for a WSL terminal (`wsl`), and '' when there
 * is no sample for the terminal (yet, or the backend left it out).
 *
 * `entry` is what the store keeps for a terminal: `{ cpuPercent,
 * memoryBytes, processes, partial }`.
 */
export function resourceUsageLabel(entry, { wsl = false } = {}) {
  if (wsl) return RESOURCE_NOT_MEASURABLE;
  if (!entry || typeof entry !== 'object') return '';
  const memory = formatMemory(entry.memoryBytes);
  if (!memory) return '';
  const text = `${formatCpu(entry.cpuPercent)} \u{00B7} ${memory}`;
  return entry.partial === true ? `${text} \u{00B7} ${RESOURCE_PARTIAL}` : text;
}

/**
 * The same, in words, for a tooltip: 'CPU 12% of one core, memory 340 MB,
 * in 3 processes.' — saying that 100% is one core — 'CPU still being
 * measured' on a first sample, why a WSL terminal has no figures, and, for a
 * partial tree, that the figures leave out what could not be read. '' when
 * there is no sample.
 */
export function resourceUsageWords(entry, { wsl = false } = {}) {
  if (wsl) {
    return 'CPU and memory are not measurable in a WSL terminal: its Linux programs run where Windows cannot see them.';
  }
  if (!entry || typeof entry !== 'object') return '';
  const memory = formatMemory(entry.memoryBytes);
  if (!memory) return '';
  const cpu = finiteAtLeastZero(entry.cpuPercent) ? `CPU ${formatCpu(entry.cpuPercent)} of one core` : 'CPU still being measured';
  const count = Number.isInteger(entry.processes) && entry.processes > 0 ? entry.processes : null;
  const processes = count === null ? '' : `, in ${count} ${count === 1 ? 'process' : 'processes'}`;
  const sentence = `${cpu}, memory ${memory}${processes}.`;
  return entry.partial === true ? `${sentence} Some of its processes could not be read, so the figures leave them out.` : sentence;
}

/**
 * Whether terminal `tab` runs WSL, by the shell it reported or would have
 * been given — the same reading the rest of the app makes of a tab's shell
 * (`shellPathOf`, `shellKindFor`). Only ever true on Windows.
 */
export function isWslTerminal(tab, { defaultShell = null, systemShell = null, platform = null } = {}) {
  if (!tab) return false;
  return shellKindFor(shellPathOf(tab, { defaultShell, systemShell }), platform) === 'wsl';
}

/**
 * Whether the page asks the backend at all: only while Show CPU and Memory
 * is on (`settingOn`), the window can be seen (`windowVisible`: not
 * minimised, not hidden), and something on screen shows the figures — the
 * TERMINALS panel (`panelVisible`) or a tab's hover card (`cardShown`).
 * Each has to be exactly true: a missing answer is a no.
 */
export function shouldSample({ settingOn = false, windowVisible = false, panelVisible = false, cardShown = false } = {}) {
  return settingOn === true && windowVisible === true && (panelVisible === true || cardShown === true);
}

/** Whether `doc` can be seen: visible, not minimised or hidden. No document, no. */
export function documentVisible(doc = globalThis.document) {
  try {
    if (!doc) return false;
    if (typeof doc.visibilityState === 'string') return doc.visibilityState === 'visible';
    return doc.hidden !== true;
  } catch {
    return false;
  }
}

/**
 * The store's entry for one item of the backend's answer, or null when the
 * item is not one: `{ sessionId, cpuPercent, memoryBytes, processes,
 * partial }`, with `cpuPercent` null when it was null or is not a figure.
 * `measuring` makes it null whatever the answer said (the first sample after
 * the page starts asking again: the backend measured since its last call,
 * before the pause).
 */
export function usageEntry(item, { measuring = false } = {}) {
  if (!item || typeof item !== 'object' || typeof item.session_id !== 'string' || !item.session_id) return null;
  if (!finiteAtLeastZero(item.memory_bytes)) return null;
  return {
    sessionId: item.session_id,
    cpuPercent: !measuring && finiteAtLeastZero(item.cpu_percent) ? item.cpu_percent : null,
    memoryBytes: item.memory_bytes,
    processes: Number.isInteger(item.processes) && item.processes >= 0 ? item.processes : 0,
    partial: item.partial === true,
  };
}
