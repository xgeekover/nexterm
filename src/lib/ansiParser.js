import React from 'react';

/**
 * ANSI Escape Sequence Parser for Terminal Blocks
 * Converts terminal escape sequences (colors, bold, underline) into styled JSX elements.
 */

const ANSI_COLOR_MAP = {
  // Standard foreground
  30: 'text-ansi-black',
  31: 'text-ansi-red',
  32: 'text-ansi-green',
  33: 'text-ansi-yellow',
  34: 'text-ansi-blue',
  35: 'text-ansi-magenta',
  36: 'text-ansi-cyan',
  37: 'text-ansi-white',

  // Bright foreground
  90: 'text-ansi-bright-black',
  91: 'text-ansi-bright-red',
  92: 'text-ansi-bright-green',
  93: 'text-ansi-bright-yellow',
  94: 'text-ansi-bright-blue',
  95: 'text-ansi-bright-magenta',
  96: 'text-ansi-bright-cyan',
  97: 'text-ansi-bright-white',

  // Standard background
  40: 'bg-ansi-black',
  41: 'bg-ansi-red',
  42: 'bg-ansi-green',
  43: 'bg-ansi-yellow',
  44: 'bg-ansi-blue',
  45: 'bg-ansi-magenta',
  46: 'bg-ansi-cyan',
  47: 'bg-ansi-white',
};

/**
 * Strips ANSI escape codes from string
 */
export function stripAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')
    .replace(/\x1b/g, '');
}

/**
 * Parses raw text with ANSI escape codes into an array of token objects
 * Each token has { text, className }
 */
export function parseAnsiTokens(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  const tokens = [];
  // Matches all ANSI CSI sequences (capturing parameters and command char),
  // OSC sequences, and single escape sequences.
  const ansiRegex = /\x1b(?:\[([0-9;?]*)([a-zA-Z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

  let lastIndex = 0;
  let currentClasses = new Set();
  let match;

  while ((match = ansiRegex.exec(rawText)) !== null) {
    const textChunk = rawText.slice(lastIndex, match.index).replace(/\x1b/g, '');
    if (textChunk.length > 0) {
      tokens.push({
        text: textChunk,
        className: Array.from(currentClasses).join(' '),
      });
    }

    // Only process SGR styling sequences (CSI ending with 'm')
    if (match[2] === 'm') {
      const codes = match[1] ? match[1].split(';').map(Number) : [0];
      for (const code of codes) {
        if (code === 0) {
          currentClasses.clear();
        } else if (code === 1) {
          currentClasses.add('font-bold');
        } else if (code === 2) {
          currentClasses.add('opacity-75');
        } else if (code === 3) {
          currentClasses.add('italic');
        } else if (code === 4) {
          currentClasses.add('underline');
        } else if (ANSI_COLOR_MAP[code]) {
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            for (const c of Array.from(currentClasses)) {
              if (c.startsWith('text-')) currentClasses.delete(c);
            }
          }
          currentClasses.add(ANSI_COLOR_MAP[code]);
        }
      }
    }

    lastIndex = ansiRegex.lastIndex;
  }

  // Trailing text
  const remaining = rawText.slice(lastIndex).replace(/\x1b/g, '');
  if (remaining.length > 0) {
    tokens.push({
      text: remaining,
      className: Array.from(currentClasses).join(' '),
    });
  }

  return tokens;
}

/**
 * React Component to render ANSI colorized text using pure React.createElement
 */
export function AnsiText({ text, className = '' }) {
  if (!text) return null;

  const tokens = parseAnsiTokens(text);

  return React.createElement(
    'pre',
    {
      className: `font-mono text-xs leading-relaxed whitespace-pre-wrap select-text ${className}`,
    },
    tokens.map((token, idx) =>
      React.createElement(
        'span',
        {
          key: idx,
          className: token.className || undefined,
        },
        token.text
      )
    )
  );
}

export default AnsiText;
