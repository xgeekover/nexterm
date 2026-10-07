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

