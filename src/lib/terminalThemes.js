/**
 * Named terminal colour themes for @xterm/xterm's `ITheme`.
 *
 * Every entry but `dark-modern` carries a *fixed*, hand-sourced palette taken
 * from each theme's canonical/official published colours (Dracula's own
 * spec, Nord's own spec, the Solarized project's official 16-colour ANSI
 * mapping, the widely-republished Monokai/Material/One Dark/Gruvbox
 * Dark/Tomorrow Night terminal ports, etc.) — never an invented
 * approximation. `dark-modern` is the one exception: it is not a fixed
 * palette at all, it is "whatever the app's own --vsc-* tokens currently
 * resolve to". The app is dark-only (light mode was removed), so those
 * tokens are now a constant — `followsAppTheme` just means "read the live
 * CSS custom properties instead of a literal below" rather than "track a
 * light/dark flip" (there is no flip anymore).
 *
 * Every palette here is a DARK one, and that is the point. `light-modern` and
 * `solarized-light` used to sit in this list, which let a user put a white
 * terminal inside a window whose every other surface is #181818 — the app
 * lighting one rectangle differently from itself, with no light shell to go
 * with it. They are gone. A settings file still naming one is not an error:
 * `getTerminalThemeEntry` falls back to the default for any unknown id, which
 * is the same path an older app version's value already took.
 *
 * Shape: every `theme` object is a complete xterm `ITheme` — background,
 * foreground, cursor, cursorAccent, selectionBackground, and all 16 ANSI
 * colours (8 base + 8 bright). This file has zero DOM/xterm dependency on
 * purpose (see terminalRegistry.js's `readTheme()` for the one entry —
 * dark-modern — that needs the live CSS tokens instead of a literal here).
 *
 * Rule for this file only: literal hex is expected and required — the whole
 * point is reproducing each theme's real published colours. Every other
 * file in this app must keep using design tokens instead.
 */

export const TERMINAL_THEMES = {
  'dark-modern': {
    label: 'Dark Modern',
    // No literal palette: terminalRegistry.js's readTheme() supplies the
    // live --vsc-* values at apply time, which is exactly today's terminal
    // behaviour — this is what makes it the default. The app has no light
    // mode, so those tokens are effectively constant; this just avoids
    // duplicating them as a second literal here.
    followsAppTheme: true,
    theme: null,
  },


  // Monokai (the original Sublime Text scheme), as republished by every
  // major terminal-theme collection (iTerm2-color-schemes, Gogh, ...).
  monokai: {
    label: 'Monokai',
    theme: {
      background: '#272822',
      foreground: '#F8F8F2',
      cursor: '#F8F8F0',
      cursorAccent: '#272822',
      selectionBackground: '#49483E',
      black: '#272822',
      red: '#F92672',
      green: '#A6E22E',
      yellow: '#F4BF75',
      blue: '#66D9EF',
      magenta: '#AE81FF',
      cyan: '#A1EFE4',
      white: '#F8F8F2',
      brightBlack: '#75715E',
      brightRed: '#F92672',
      brightGreen: '#A6E22E',
      brightYellow: '#F4BF75',
      brightBlue: '#66D9EF',
      brightMagenta: '#AE81FF',
      brightCyan: '#A1EFE4',
      brightWhite: '#F9F8F5',
    },
  },

  // Material (the Material Design-derived terminal scheme ported to
  // iTerm2/Alacritty/Hyper/etc. under the name "Material").
  material: {
    label: 'Material',
    theme: {
      background: '#263238',
      foreground: '#EEFFFF',
      cursor: '#FFCC00',
      cursorAccent: '#263238',
      selectionBackground: '#546E7A',
      black: '#212121',
      red: '#B7141F',
      green: '#457B24',
      yellow: '#F6981E',
      blue: '#134EB2',
      magenta: '#560088',
      cyan: '#0E717C',
      white: '#EFEFEF',
      brightBlack: '#424242',
      brightRed: '#E83636',
      brightGreen: '#7AB83D',
      brightYellow: '#FFEA2E',
      brightBlue: '#54A4F3',
      brightMagenta: '#AA4DBC',
      brightCyan: '#26C6DA',
      brightWhite: '#FFFFFF',
    },
  },

  // Dracula — official palette from draculatheme.com's own terminal spec.
  dracula: {
    label: 'Dracula',
    theme: {
      background: '#282A36',
      foreground: '#F8F8F2',
      cursor: '#F8F8F0',
      cursorAccent: '#282A36',
      selectionBackground: '#44475A',
      black: '#21222C',
      red: '#FF5555',
      green: '#50FA7B',
      yellow: '#F1FA8C',
      blue: '#BD93F9',
      magenta: '#FF79C6',
      cyan: '#8BE9FD',
      white: '#F8F8F2',
      brightBlack: '#6272A4',
      brightRed: '#FF6E6E',
      brightGreen: '#69FF94',
      brightYellow: '#FFFFA5',
      brightBlue: '#D6ACFF',
      brightMagenta: '#FF92DF',
      brightCyan: '#A4FFFF',
      brightWhite: '#FFFFFF',
    },
  },

  // Solarized Dark — Ethan Schoonover's official base03/base0 background
  // and foreground, with the project's own canonical 16-colour ANSI table
  // (the same 16 hues Solarized Light below reuses verbatim).
  'solarized-dark': {
    label: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },


  // Nord — official palette from nordtheme.com; nord1/nord3 for
  // black/bright-black and nord2 for selection are the spec's own documented
  // roles ("Selection- and highlight color").
  nord: {
    label: 'Nord',
    theme: {
      background: '#2E3440',
      foreground: '#D8DEE9',
      cursor: '#D8DEE9',
      cursorAccent: '#2E3440',
      selectionBackground: '#434C5E',
      black: '#3B4252',
      red: '#BF616A',
      green: '#A3BE8C',
      yellow: '#EBCB8B',
      blue: '#81A1C1',
      magenta: '#B48EAD',
      cyan: '#88C0D0',
      white: '#E5E9F0',
      brightBlack: '#4C566A',
      brightRed: '#BF616A',
      brightGreen: '#A3BE8C',
      brightYellow: '#EBCB8B',
      brightBlue: '#81A1C1',
      brightMagenta: '#B48EAD',
      brightCyan: '#8FBCBB',
      brightWhite: '#ECEFF4',
    },
  },

  // One Dark (Atom's default UI/syntax palette reused as a terminal ANSI
  // scheme) — the same 16 hues shipped by every major One Dark terminal port.
  'one-dark': {
    label: 'One Dark',
    theme: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  },

  // Gruvbox Dark (medium contrast) — morhetz/gruvbox's own bg0/fg1 and
  // neutral/bright colour rows.
  'gruvbox-dark': {
    label: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },

  // Tomorrow Night — Chris Kempson's chriskempson/tomorrow-theme terminal
  // port (the same 16 hues distributed with that project).
  'tomorrow-night': {
    label: 'Tomorrow Night',
    theme: {
      background: '#1d1f21',
      foreground: '#c5c8c6',
      cursor: '#c5c8c6',
      cursorAccent: '#1d1f21',
      selectionBackground: '#373b41',
      black: '#1d1f21',
      red: '#cc6666',
      green: '#b5bd68',
      yellow: '#f0c674',
      blue: '#81a2be',
      magenta: '#b294bb',
      cyan: '#8abeb7',
      white: '#c5c8c6',
      brightBlack: '#969896',
      brightRed: '#cc6666',
      brightGreen: '#b5bd68',
      brightYellow: '#f0c674',
      brightBlue: '#81a2be',
      brightMagenta: '#b294bb',
      brightCyan: '#8abeb7',
      brightWhite: '#ffffff',
    },
  },
};

/** Stable list of every theme id, in declaration order (for <select> lists). */
export const TERMINAL_THEME_IDS = Object.keys(TERMINAL_THEMES);

export const DEFAULT_TERMINAL_THEME_ID = 'dark-modern';

/** Look up a theme entry, falling back to the default for an unknown id
 * (e.g. a settings value from an older/newer app version). */
export function getTerminalThemeEntry(themeId) {
  return TERMINAL_THEMES[themeId] || TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID];
}

export default TERMINAL_THEMES;
