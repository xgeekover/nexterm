/**
 * Utility functions for NexTerm
 */

/**
 * Conditionally joins class names together.
 * Pure JS replacement for clsx / classnames without external dependencies.
 */
export function cn(...inputs) {
  const classes = [];

  for (const input of inputs) {
    if (!input) continue;

    if (typeof input === 'string') {
      classes.push(input);
    } else if (Array.isArray(input)) {
      const inner = cn(...input);
      if (inner) classes.push(inner);
    } else if (typeof input === 'object') {
      for (const [key, value] of Object.entries(input)) {
        if (value) classes.push(key);
      }
    }
  }

  return classes.join(' ');
}

/**
 * Formats a byte size into a human-readable string (B, KB, MB, GB).
 */
export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Formats seconds or milliseconds into a human-readable duration (e.g. "1.2s", "45ms", "2m 10s").
 */
export function formatDuration(duration) {
  if (duration === null || duration === undefined) return '';
  if (typeof duration === 'string') return duration;
  if (duration < 1) {
    return `${Math.round(duration * 1000)}ms`;
  }
  if (duration < 60) {
    return `${duration.toFixed(2)}s`;
  }
  const mins = Math.floor(duration / 60);
  const secs = Math.round(duration % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Formats a timestamp string or Date object into a readable time (HH:MM:SS).
 */
export function formatTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * Fuzzy search matching for search inputs.
 * Returns true if query characters appear sequentially in target string.
 */
export function fuzzyMatch(query, target) {
  if (!query) return true;
  if (!target) return false;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qIdx = 0;
  let tIdx = 0;

  while (qIdx < q.length && tIdx < t.length) {
    if (q[qIdx] === t[tIdx]) {
      qIdx++;
    }
    tIdx++;
  }

  return qIdx === q.length;
}

/**
 * Detects code language from file extension for Monaco Editor.
 */
export function getLanguageFromPath(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase();

  const langMap = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    rs: 'rust',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    markdown: 'markdown',
    toml: 'ini',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml'
  };

  return langMap[ext] || 'plaintext';
}

/**
 * Lightweight pure JS ANSI escape parser for terminal outputs.
 * Parses standard ANSI color codes into React-compatible styled spans.
 */
export function parseAnsiToSpans(text) {
  if (!text) return [];

  const ansiRegex = /\x1b\[([0-9;]*)m/g;
  const parts = [];
  let lastIndex = 0;
  let currentClasses = [];

  const colorMap = {
    '30': 'text-ansi-black',
    '31': 'text-ansi-red',
    '32': 'text-ansi-green',
    '33': 'text-ansi-yellow',
    '34': 'text-ansi-blue',
    '35': 'text-ansi-magenta',
    '36': 'text-ansi-cyan',
    '37': 'text-ansi-white',
    '90': 'text-ansi-bright-black',
    '91': 'text-ansi-bright-red',
    '92': 'text-ansi-bright-green',
    '93': 'text-ansi-bright-yellow',
    '94': 'text-ansi-bright-blue',
    '95': 'text-ansi-bright-magenta',
    '96': 'text-ansi-bright-cyan',
    '97': 'text-ansi-bright-white',
    '1': 'font-bold',
    '2': 'opacity-70',
    '3': 'italic',
    '4': 'underline'
  };

  let match;
  while ((match = ansiRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        text: text.substring(lastIndex, match.index),
        className: currentClasses.join(' ')
      });
    }

    const codes = match[1] ? match[1].split(';') : ['0'];
    for (const code of codes) {
      if (code === '0' || code === '') {
        currentClasses = [];
      } else if (colorMap[code]) {
        currentClasses.push(colorMap[code]);
      }
    }

    lastIndex = ansiRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({
      text: text.substring(lastIndex),
      className: currentClasses.join(' ')
    });
  }

  return parts;
}

/**
 * Checks if current host OS is macOS.
 */
export function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}
