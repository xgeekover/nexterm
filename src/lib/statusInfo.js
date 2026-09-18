/**
 * What the status bar says, computed rather than hard-coded.
 *
 * The bar used to show a git branch of "main" and a shell of "zsh" whatever
 * was actually running — on a Windows machine running cmd.exe it was wrong
 * twice over. Everything here is derived from real state, and the parts that
 * genuinely differ by platform differ here rather than being averaged into
 * something that suits none of them.
 *
 * Pure: no React, no stores, no IPC.
 */

import { basename, displayPath, sepOf } from './paths.js';

/** Canonical platform key from whatever the backend reported. */
export function platformOf(os) {
  const value = String(os || '').toLowerCase();
  // macOS first: "darwin" contains "win", so testing for Windows ahead of it
  // reports every Mac as a Windows machine — CRLF line endings and all.
  if (value.includes('mac') || value.includes('darwin') || value === 'osx') return 'macos';
  if (value.includes('win')) return 'windows';
  if (value.includes('linux') || value.includes('bsd')) return 'linux';
  return 'unknown';
}

/** How a platform writes the end of a line — the thing pasted text carries. */
export function lineEndingFor(platform) {
  return platform === 'windows' ? 'CRLF' : 'LF';
}

/**
 * How a platform describes its text encoding.
 *
 * Only Windows has a code page worth naming: a console still running 949 or
 * 437 renders UTF-8 output as mojibake, and knowing which one is in effect is
 * the first thing to check. Everywhere else UTF-8 is simply the answer.
 */
export function encodingFor(platform, { codePage = null } = {}) {
  if (platform !== 'windows') return 'UTF-8';
  return codePage ? `UTF-8 (${codePage})` : 'UTF-8';
}

/** The human name for a shell path or spec, per platform. */
export function shellLabel(shellSpec, platform) {
  const raw = String(shellSpec || '').trim();
  if (!raw || raw === 'default') {
    if (platform === 'windows') return 'Command Prompt';
    if (platform === 'macos') return 'zsh';
    if (platform === 'linux') return 'bash';
    return 'shell';
  }
  const name = basename(raw).replace(/\.exe$/i, '').toLowerCase();
  const WINDOWS_NAMES = {
    cmd: 'Command Prompt',
    powershell: 'Windows PowerShell',
    pwsh: 'PowerShell',
    bash: 'Git Bash',
    wsl: 'WSL',
  };
  if (platform === 'windows' && WINDOWS_NAMES[name]) return WINDOWS_NAMES[name];
  return name || 'shell';
}

/**
 * The working directory as the bar should show it.
 *
 * `~` is a unix convention; a Windows user reads `C:\…\project`, not `~\
 * project`, so the home directory is only folded away off Windows.
 */
export function cwdLabel(cwd, { platform, homeDir = null, keep = 2 } = {}) {
  if (!cwd) return '';
  return displayPath(cwd, { home: platform === 'windows' ? null : homeDir, keep });
}

/** A short platform badge: what you are on, and for which chip. */
export function platformLabel(platform, arch) {
  const NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  const name = NAMES[platform] || 'Unknown';
  return arch ? `${name} ${arch}` : name;
}

/**
 * The status bar's contents, left and right, for one moment of app state.
 *
 * Every entry carries an `id` so the renderer can key and test on it rather
 * than on its position or label.
 */
export function buildStatusItems({
  os = '',
  arch = null,
  homeDir = null,
  codePage = null,
  workspacePath = null,
  cwd = null,
  shell = null,
  cols = null,
  rows = null,
  groupCount = 0,
  terminalCount = 0,
  lastExitCode = null,
  shellExited = false,
  fontSize = null,
  defaultFontSize = null,
} = {}) {
  const platform = platformOf(os);
  const sep = sepOf(cwd || workspacePath || '/');

  const left = [];
  left.push({
    id: 'workspace',
    kind: 'accent',
    text: workspacePath ? basename(workspacePath) : 'NexTerm',
    title: workspacePath || 'No folder opened',
  });

  if (cwd) {
    left.push({
      id: 'cwd',
      kind: 'plain',
      icon: 'folder',
      text: cwdLabel(cwd, { platform, homeDir }),
      title: cwd,
    });
  }

  // A shell that has died, or a command that just failed, is the one thing on
  // this bar worth interrupting the user for.
  if (shellExited) {
    left.push({ id: 'exited', kind: 'error', text: 'shell exited', title: 'The terminal’s shell is no longer running' });
  } else if (typeof lastExitCode === 'number' && lastExitCode !== 0) {
    left.push({
      id: 'exit-code',
      kind: 'error',
      icon: 'x',
      text: `exit ${lastExitCode}`,
      title: `The last command exited with code ${lastExitCode}`,
    });
  }

  const right = [];
  if (terminalCount > 0) {
    right.push({
      id: 'terminals',
      kind: 'plain',
      icon: 'terminal',
      text: groupCount > 1 ? `${terminalCount} in ${groupCount} groups` : `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`,
      title: `${terminalCount} terminal${terminalCount === 1 ? '' : 's'} across ${groupCount} group${groupCount === 1 ? '' : 's'}`,
    });
  }
  if (cols && rows) {
    right.push({ id: 'size', kind: 'plain', text: `${cols}\u00d7${rows}`, title: `${cols} columns by ${rows} rows` });
  }
  // Only while zoomed. A permanent "12px" would be noise; a size that is not
  // the default is worth saying, because the shortcut that changed it is easy
  // to hit by accident and there was previously nothing on screen to explain
  // why the text had shrunk. `action` makes it the way back.
  if (fontSize && defaultFontSize && fontSize !== defaultFontSize) {
    right.push({
      id: 'zoom',
      kind: 'plain',
      text: `${fontSize}px`,
      title: `Font size ${fontSize}px (default ${defaultFontSize}px) — click to reset`,
      action: 'zoom-reset',
    });
  }
  right.push({
    id: 'shell',
    kind: 'plain',
    text: shellLabel(shell, platform),
    title: shell && shell !== 'default' ? shell : 'The platform default shell',
  });
  right.push({
    id: 'encoding',
    kind: 'plain',
    text: encodingFor(platform, { codePage }),
    title: 'Terminal text encoding',
  });
  right.push({
    id: 'eol',
    kind: 'plain',
    text: lineEndingFor(platform),
    title: platform === 'windows' ? 'Carriage return + line feed' : 'Line feed',
  });
  right.push({
    id: 'platform',
    kind: 'plain',
    text: platformLabel(platform, arch),
    title: `Separator “${sep}”`,
  });

  return { platform, left, right };
}
