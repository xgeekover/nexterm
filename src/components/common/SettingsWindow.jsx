import React, { useEffect, useMemo, useRef, useState, useId } from 'react';
import { X, Search, RotateCcw } from 'lucide-react';
import { useSettingsStore, FONT_SIZE_RANGE } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { fuzzyMatch, cn } from '../../lib/utils.js';
import { ThemeGallery } from './ThemeGallery.jsx';
import { THEME_PREVIEWING, pendingThemeUndo, resetAllQuestion } from './themeGalleryModel.js';
import { ConfirmDialog } from './ConfirmDialog.jsx';

/**
 * What Reset All does. Imported themes are a setting, so Reset All deletes
 * them — for good, and with them any the gallery's Undo could still bring
 * back. With some to lose it asks first (`askReset(question)`); with none it
 * resets at once, as it always has.
 */
export function resetAll(askReset) {
  const question = resetAllQuestion(useSettingsStore.getState(), pendingThemeUndo());
  if (question) askReset(question);
  else useSettingsStore.getState().resetSettings();
}
import { isWindows } from '../../lib/platform.js';
import { expandHome } from '../../lib/paths.js';
import { isNetworkPath } from '../../lib/terminalLinks.js';
import { NETWORK_START_DIR } from '../../lib/terminalCwd.js';
import { invoke } from '../../lib/ipc.js';

/**
 * VS Code's Settings editor reads the live `--font-mono` token so the text
 * input's placeholder always shows what "leave this blank" actually means,
 * instead of a hard-coded guess that could drift from src/styles/index.css.
 */
function readInheritedMonoStack() {
  if (typeof document === 'undefined') return 'monospace';
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue('--font-mono').trim() || 'monospace';
}

import { KeybindingSettings, CHORD_RECORDER } from './KeybindingSettings.jsx';

/**
 * What a key does to the Settings window as a whole, decided by the listener
 * that sees every key before anything inside the window does:
 *
 *   'close'  Escape
 *   'trap'   Tab: kept going round inside the window
 *   null     not the window's to handle
 *
 * Escape on the field recording a shortcut belongs to that field: it ends the
 * recording, and the window stays. This listener runs in the capture phase,
 * ahead of the field's own, so it used to take that Escape and close the
 * whole window. The same for an Escape inside the theme gallery while it is
 * previewing a theme: it takes the preview back (ThemeGallery.jsx), and a
 * second Escape closes the window. A second press, not a held one: an Escape
 * held to end a preview closed the window with its repeats.
 */
export function settingsWindowKey(e) {
  if (e.key === 'Escape') {
    if (e.repeat) return null;
    const theirs = e.target?.closest?.(`[${CHORD_RECORDER}]`) || e.target?.closest?.(`[${THEME_PREVIEWING}]`);
    return theirs ? null : 'close';
  }
  if (e.key === 'Tab') return 'trap';
  return null;
}

/**
 * Leave the field being typed in, if it is in `dialog`, so that it takes what
 * was typed — a field does on leaving it (`TextLikeControl`), and closing the
 * window is leaving it. Escape and a click beside the window closed it with
 * the focus still in the field: the field never left, and a scrollback or a
 * font size typed and not yet left was dropped without a word. Only ✕, by
 * taking the focus first, kept it.
 */
export function leaveEditedField(dialog, doc) {
  const active = doc?.activeElement;
  if (!dialog || !active || active === doc.body || !dialog.contains(active)) return false;
  active.blur?.();
  return true;
}

/**
 * Where focus goes once the Settings window has closed: back to `opener`,
 * what had it when the window opened — the terminal or the editor, as a rule
 * — if it is still on the page and nothing else has taken focus since.
 * Otherwise null, and focus is left where it is.
 *
 * Left alone, focus fell to the page with the window's controls: the terminal
 * behind got no keys until it was clicked, and off macOS a Ctrl+W meant for
 * the shell reached the window's own Close Pane instead.
 */
export function focusAfterClose(opener, doc) {
  if (!opener || !doc || opener === doc.body || opener === doc.documentElement) return null;
  if (!doc.contains(opener)) return null;
  if (doc.activeElement && doc.activeElement !== doc.body) return null;
  return typeof opener.focus === 'function' ? opener : null;
}

const SECTIONS = [
  { id: 'keyboard', label: 'Keyboard Shortcuts' },
  { id: 'editor', label: 'Text Editor' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'workbench', label: 'Workbench' },
];

/** Every row the Settings window can render, grouped by section. */
function buildItems(monoPlaceholder, detectedShells, homeDir) {
  return [
    // ---- Text Editor ----
    {
      id: 'editorFontSize',
      section: 'editor',
      key: 'editorFontSize',
      settingKey: 'editor.fontSize',
      title: 'Font Size',
      description: 'Controls the font size in pixels for the editor.',
      control: 'number',
      min: FONT_SIZE_RANGE.min,
      max: FONT_SIZE_RANGE.max,
      step: 1,
    },
    {
      id: 'editorTabSize',
      section: 'editor',
      key: 'editorTabSize',
      settingKey: 'editor.tabSize',
      title: 'Tab Size',
      description: 'The number of spaces a tab is equal to when indenting.',
      control: 'number',
      min: 1,
      max: 8,
      step: 1,
    },
    {
      id: 'editorWordWrap',
      section: 'editor',
      key: 'editorWordWrap',
      settingKey: 'editor.wordWrap',
      title: 'Word Wrap',
      description: 'Wraps lines that exceed the width of the editor instead of scrolling horizontally.',
      control: 'checkbox',
    },
    {
      id: 'editorMinimap',
      section: 'editor',
      key: 'editorMinimap',
      settingKey: 'editor.minimap.enabled',
      title: 'Minimap',
      description: 'Controls whether the minimap is shown on the right edge of the editor.',
      control: 'checkbox',
    },
    {
      id: 'editorRestoreTabs',
      section: 'editor',
      key: 'editorRestoreTabs',
      settingKey: 'workbench.editor.restoreOpenEditors',
      title: 'Restore Open Editors',
      description:
        'Reopens the files that were open in a folder, in the same editor groups, when the folder is opened again or NexTerm restarts. Unsaved changes are not kept: a reopened file shows what is on disk. Disabled: nothing is reopened, and the files remembered so far are forgotten.',
      control: 'checkbox',
    },
    // ---- Files ----
    {
      id: 'filesEnableTrash',
      section: 'files',
      key: 'filesEnableTrash',
      settingKey: 'files.enableTrash',
      title: 'Enable Trash',
      description: isWindows
        ? 'Delete in the Explorer moves files and folders to the Recycle Bin, where they can be restored. On a drive that has none — a network drive, a USB stick — you are asked again before anything is deleted permanently. Disabled: Delete removes them permanently, after one question.'
        : 'Delete in the Explorer moves files and folders to the Trash, where they can be restored. Where there is none — some network and USB drives — you are asked again before anything is deleted permanently. Disabled: Delete removes them permanently, after one question.',
      control: 'checkbox',
    },
    // ---- Terminal ----
    {
      id: 'terminalFontFamily',
      section: 'terminal',
      key: 'terminalFontFamily',
      settingKey: 'terminal.integrated.fontFamily',
      title: 'Font Family',
      description: 'Controls the font family of the terminal. Leave blank to follow the editor font.',
      control: 'text',
      placeholder: monoPlaceholder,
    },
    {
      id: 'terminalFontSize',
      section: 'terminal',
      key: 'terminalFontSize',
      settingKey: 'terminal.integrated.fontSize',
      title: 'Font Size',
      description: 'Controls the font size in pixels of the terminal.',
      control: 'number',
      min: FONT_SIZE_RANGE.min,
      max: FONT_SIZE_RANGE.max,
      step: 1,
    },
    {
      id: 'terminalLineHeight',
      section: 'terminal',
      key: 'terminalLineHeight',
      settingKey: 'terminal.integrated.lineHeight',
      title: 'Line Height',
      description: 'Controls the line height of the terminal, as a multiple of the font size.',
      control: 'number',
      min: 1,
      max: 2,
      step: 0.1,
    },
    {
      id: 'terminalCursorStyle',
      section: 'terminal',
      key: 'terminalCursorStyle',
      settingKey: 'terminal.integrated.cursorStyle',
      title: 'Cursor Style',
      description: 'Controls the style of the terminal cursor.',
      control: 'select',
      options: [
        { value: 'bar', label: 'Bar' },
        { value: 'block', label: 'Block' },
        { value: 'underline', label: 'Underline' },
      ],
    },
    {
      id: 'terminalCursorBlink',
      section: 'terminal',
      key: 'terminalCursorBlink',
      settingKey: 'terminal.integrated.cursorBlinking',
      title: 'Cursor Blinking',
      description: 'Controls whether the terminal cursor blinks.',
      control: 'checkbox',
    },
    {
      id: 'terminalStickyHeader',
      section: 'terminal',
      key: 'terminalStickyHeader',
      settingKey: 'terminal.integrated.stickyCommandHeader',
      title: 'Sticky Command Header',
      description:
        'While the terminal is scrolled back, show a bar naming the command whose output is on screen. It covers the top row, which is occasionally the one you scrolled up to read.',
      control: 'checkbox',
    },
    {
      id: 'terminalScrollback',
      section: 'terminal',
      key: 'terminalScrollback',
      settingKey: 'terminal.integrated.scrollback',
      title: 'Scrollback',
      description: 'Controls the maximum number of lines the terminal keeps in its scrollback buffer.',
      control: 'number',
      min: 100,
      max: 100000,
      step: 100,
    },
    {
      id: 'terminalTheme',
      section: 'terminal',
      key: 'terminalTheme',
      settingKey: 'terminal.integrated.theme',
      title: 'Color Theme',
      description:
        'The colors of every terminal. Point at a theme, or move to it with the arrow keys, to try it on every terminal; click it or press Enter to keep it. Escape, or leaving the themes without choosing one, goes back to the one you had. Import adds a dark theme from a file — NexTerm is dark throughout, so light themes are refused.',
      // Drawn by ThemeGallery.jsx, which reads and writes the theme settings
      // itself: previewing must not go through `onChange`, which saves.
      control: 'themeGallery',
    },
    {
      id: 'terminalDefaultShell',
      section: 'terminal',
      key: 'terminalDefaultShell',
      settingKey: 'terminal.integrated.defaultShell',
      title: 'Default Shell',
      description:
        'Which shell new terminals open. "Default" is the system one — the command prompt on Windows, $SHELL elsewhere. A path may be typed in place of a name.',
      control: 'select',
      // Built from what the backend FOUND on this machine, not from a fixed
      // list per platform. The old one promised "PowerShell 7" on every
      // Windows box whether or not pwsh was installed, and never mentioned
      // Git Bash or WSL — the two a developer on Windows most often wants.
      // An empty list still leaves "Default", which the backend resolves at
      // spawn time.
      options: [
        { value: 'default', label: isWindows ? 'Default (Command Prompt)' : 'Default ($SHELL)' },
        ...detectedShells.map((profile) => ({ value: profile.spec, label: profile.label })),
      ],
    },
    {
      id: 'terminalDefaultCwd',
      section: 'terminal',
      key: 'terminalDefaultCwd',
      settingKey: 'terminal.integrated.cwd',
      title: 'Default Directory',
      description:
        'Where a new terminal starts when nothing else has asked for a directory. A terminal restored with a session still opens where it was saved — this only decides the ones that have no answer of their own.',
      control: 'select',
      // Keywords rather than a path, so "workspace" and "home" follow the
      // machine instead of being frozen the day they were picked.
      options: [
        { value: 'workspace', label: 'Workspace root' },
        { value: 'home', label: 'Home directory' },
        { value: 'active', label: 'Same as the active terminal' },
        { value: 'custom', label: 'Custom path…' },
      ],
    },
    {
      id: 'terminalSplitCwd',
      section: 'terminal',
      key: 'terminalSplitCwd',
      settingKey: 'terminal.integrated.splitCwd',
      title: 'Split Directory',
      description:
        'Where a terminal made by splitting a pane starts. "The terminal being split" opens it in that terminal\'s current folder, with the same shell; "Same as a new terminal" follows Default Shell and Default Directory.',
      control: 'select',
      options: [
        { value: 'inherited', label: 'The terminal being split' },
        { value: 'default', label: 'Same as a new terminal' },
      ],
    },
    // ---- Split layout (stage 3, spec P1 and P2) ----
    {
      id: 'terminalEqualizeOnSplit',
      section: 'terminal',
      key: 'terminalEqualizeOnSplit',
      settingKey: 'terminal.integrated.equalizeOnSplit',
      title: 'Equal Splits',
      description:
        'A new split gives every pane in its row, or its column, the same share — three panes side by side get a third each. Disabled: the pane being split is halved and the others keep the sizes you gave them. "Equalize Splits" in the command palette evens out the whole group once, whichever this is.',
      control: 'checkbox',
    },
    {
      id: 'terminalHideSingleTabStrip',
      section: 'terminal',
      key: 'terminalHideSingleTabStrip',
      settingKey: 'terminal.integrated.hideSingleTabStrip',
      title: 'Hide the Tab Strip of a Single Terminal',
      description:
        'A pane holding one terminal shows a thin handle instead of its tab strip, and the terminal gets the rest of the height. Click the handle (or press Enter on it) to bring the strip up over the top of the terminal; it goes again on Escape, a click elsewhere, or when the pointer leaves it. It also comes up while a tab is being dragged and while its menu or a rename is open — never just because the pointer passes by, and never resizing the terminal. The handle shows the terminal\'s unread count, progress and password lock as small marks, with their words in its tooltip. A second terminal in the pane brings the strip back for good; a zoomed pane always shows it. Rename Terminal and Close Terminal are in the command palette too.',
      control: 'checkbox',
    },
    {
      id: 'terminalDefaultCwdPath',
      section: 'terminal',
      key: 'terminalDefaultCwdPath',
      settingKey: 'terminal.integrated.cwdPath',
      title: 'Custom Directory',
      description: 'The directory "Custom path…" means. `~` is your home directory.',
      control: 'text',
      placeholder: '~/work',
      // Only worth showing when it is the one being used; an input that does
      // nothing is worse than no input.
      visibleWhen: (v) => v.terminalDefaultCwd === 'custom',
      // Checked against the real filesystem — a path that is not there would
      // otherwise fall back silently and read as "the setting did not save".
      validate: async (value) => {
        const wanted = String(value ?? '').trim();
        if (!wanted) return 'Type a directory, or choose another option above.';
        const path = expandHome(wanted, homeDir);
        if (isNetworkPath(path)) return NETWORK_START_DIR;
        try {
          const ok = await invoke('fs_dir_exists', { path });
          return ok ? null : 'No directory there. New terminals will fall back to the workspace root, or your home directory if no folder is open.';
        } catch {
          return null; // cannot check right now; do not cry wolf
        }
      },
    },
    {
      id: 'terminalNotifyAfterSeconds',
      section: 'terminal',
      key: 'terminalNotifyAfterSeconds',
      settingKey: 'terminal.integrated.notifyAfterSeconds',
      title: 'Notify After',
      description:
        'Tell me when a command finishes in a terminal I am not looking at, once it has run at least this many seconds. 0 turns it off.',
      control: 'number',
      min: 0,
      max: 600,
      step: 5,
    },
    {
      id: 'terminalProgramNotifications',
      section: 'terminal',
      key: 'terminalProgramNotifications',
      settingKey: 'terminal.integrated.programNotifications',
      title: 'Notifications from Programs',
      description:
        'Shows what a program in a terminal asks to tell you — OpenCode when a session is done or needs your permission, Claude Code when it is waiting for you — in the status bar, and as a desktop notification while NexTerm is in the background. The program has to be set up to send them; the README says how.',
      control: 'checkbox',
    },
    {
      id: 'terminalBellAttention',
      section: 'terminal',
      key: 'terminalBellAttention',
      settingKey: 'terminal.integrated.bellAttention',
      title: 'Terminal Bell',
      description:
        'When a program rings the bell in a terminal you are not looking at, that terminal asks for your attention: its pane gets a ring, its tab a count, and the status bar\'s bell an entry. Repeated rings add up in one entry. Never shown as a desktop notification. Off, the bell is ignored.',
      control: 'checkbox',
    },
    {
      id: 'terminalAttentionFlashFocused',
      section: 'terminal',
      key: 'terminalAttentionFlashFocused',
      settingKey: 'terminal.integrated.attentionFlashFocused',
      title: 'Flash the Terminal You Are In',
      description:
        'A notification or a bell from the terminal you are typing into never adds an entry, since you are already looking at it. On, its pane\'s ring flashes once instead, so you notice it happened.',
      control: 'checkbox',
    },
    {
      id: 'terminalProgress',
      section: 'terminal',
      key: 'terminalProgress',
      settingKey: 'terminal.integrated.progress',
      title: 'Progress Bars',
      description:
        'Shows the progress a program reports with OSC 9;4, the sequence Windows Terminal understands, as a thin bar under its tab and its group, and on Windows on the taskbar button too. Off, every bar is taken down at once.',
      control: 'checkbox',
    },
    // ---- The TERMINALS side bar's rows (stage 2) ----
    // With any of Branch, Agent and Status, or Last Notification on, every
    // terminal row is two lines of one height; with all three off, one line.
    {
      id: 'terminalsPanelFolder',
      section: 'terminal',
      key: 'terminalsPanelFolder',
      settingKey: 'terminal.sidebar.showFolder',
      title: 'Show Folder',
      description:
        'In the TERMINALS side bar, shows the folder each terminal is in at the right of its row, cut from the front when it does not fit.',
      control: 'checkbox',
    },
    {
      id: 'terminalsPanelBranch',
      section: 'terminal',
      key: 'terminalsPanelBranch',
      settingKey: 'terminal.sidebar.showGitBranch',
      title: 'Show Git Branch',
      description:
        "In the TERMINALS side bar, shows the Git branch of each terminal's folder under its title. It is read from the folder's .git when the terminal changes folder, when a command ends in it, and when the workspace's Git status refreshes — never on a timer, and nothing the repository configures is ever run to find it. A terminal in WSL or in a network folder shows no branch. Off, nothing is looked up.",
      control: 'checkbox',
    },
    {
      id: 'terminalsPanelAgent',
      section: 'terminal',
      key: 'terminalsPanelAgent',
      settingKey: 'terminal.sidebar.showAgentStatus',
      title: 'Show Agent and Status',
      description:
        "In the TERMINALS side bar, shows under each terminal's title the agent running in it — Claude Code or OpenCode — and what it is doing: waiting for you, failed, running, a program's progress, or exited.",
      control: 'checkbox',
    },
    {
      id: 'terminalsPanelLastNote',
      section: 'terminal',
      key: 'terminalsPanelLastNote',
      settingKey: 'terminal.sidebar.showLastNotification',
      title: 'Show Last Notification',
      description:
        "In the TERMINALS side bar, shows under each terminal's title the last thing it told you — a program's message, a bell, a finished command — dimmed once you have read it. Point at it for the whole text and how long ago it came.",
      control: 'checkbox',
    },
    {
      id: 'terminalsPanelSortAttention',
      section: 'terminal',
      key: 'terminalsPanelSortAttention',
      settingKey: 'terminal.sidebar.sortByAttention',
      title: 'Sort by Attention',
      description:
        'Lists the groups in the TERMINALS side bar, and the terminals in each pane, most urgent first: waiting for you, then failed, then running, then idle, then exited, keeping your order among equals. Only the side bar changes — tabs and group chips keep your order, and turning this off shows it again; menu items that act on your order, such as Close Terminals to the Right, are unavailable while it is on. While you aim, the list holds still: while the pointer is over a terminal or group row, from a press until its click and a double-click after, while a menu from the list is open, and while a row is being renamed. Moving off the rows, or leaving the window, lets it catch up; until it has, a dot on the sort button says a newer order is waiting.',
      control: 'checkbox',
    },
    {
      id: 'terminalSuggestions',
      section: 'terminal',
      key: 'terminalSuggestions',
      settingKey: 'terminal.integrated.suggestions',
      title: 'Command Suggestions',
      description: 'Controls whether inline command suggestions and the completion popup are shown as you type in the terminal.',
      control: 'checkbox',
    },
    {
      id: 'terminalCopyOnSelect',
      section: 'terminal',
      key: 'terminalCopyOnSelect',
      settingKey: 'terminal.integrated.copyOnSelection',
      title: 'Copy on Select',
      description:
        'Copies text to the clipboard as soon as you select it with the mouse — a drag, a double-click for a word, a triple-click for a line.',
      control: 'checkbox',
    },
    {
      id: 'terminalRightClick',
      section: 'terminal',
      key: 'terminalRightClick',
      settingKey: 'terminal.integrated.rightClickBehavior',
      title: 'Right Click',
      description:
        'Copy or Paste: a right-click copies the selection and clears it, or pastes when nothing is selected, as in Windows Terminal — inside Claude Code, OpenCode and vim too, which never see the click. Shift+right-click passes the click on to the program instead (on macOS; elsewhere it does nothing). Default: the right-click is left to the terminal and the program. Copy or Paste is the default on Windows.',
      control: 'select',
      options: [
        { value: 'copyPaste', label: 'Copy or Paste' },
        { value: 'default', label: 'Default' },
      ],
    },
    {
      id: 'terminalMultiLinePasteWarning',
      section: 'terminal',
      key: 'terminalMultiLinePasteWarning',
      settingKey: 'terminal.integrated.enableMultiLinePasteWarning',
      title: 'Multi-Line Paste Warning',
      description:
        'Ask before pasting two or more lines, offering Paste, Paste as One Line and Cancel. Auto: only when the program has not asked for bracketed paste, so each line would run as a command the moment it is pasted — cmd never asks for it; zsh, OpenCode and Claude Code do. A line with its own line break at the end is one line, and lines of only spaces are not counted. A paste with an escape sequence in it is asked about even where bracketed paste is on.',
      control: 'select',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'always', label: 'Always' },
        { value: 'never', label: 'Never' },
      ],
    },
    {
      id: 'terminalAutoReplyBatchJob',
      section: 'terminal',
      key: 'terminalAutoReplyBatchJob',
      settingKey: 'terminal.integrated.autoReplies',
      title: 'Answer cmd\'s "Terminate batch job (Y/N)?" with Y',
      description:
        'After you press Ctrl+C in a Command Prompt (cmd) terminal, cmd asks this when the program it stopped was started from a batch file — OpenCode, through npm\'s opencode.cmd, every time — and a second Ctrl+C while it asks can end cmd itself. Answered once, and only cmd\'s own question on a new line — the ^C cmd echoes beside it, or its words in English or Korean — within 3 seconds of the Ctrl+C (longer while the program is still closing) and before anything else is typed.',
      control: 'checkbox',
    },
    {
      id: 'terminalMouseReporting',
      section: 'terminal',
      key: 'terminalMouseReporting',
      settingKey: 'terminal.integrated.fullScreenMouseReporting',
      title: 'Mouse Reporting in Full-Screen Apps',
      description:
        'Lets a full-screen program such as vim, htop or tmux use the mouse. A program in the scrollback, like Claude Code, never gets it, so a drag there always selects text. Inside a full-screen program, hold Shift while dragging to select (on macOS ⌥ works too).',
      control: 'checkbox',
    },
    // ---- Workbench ----
    {
      id: 'reducedMotion',
      section: 'workbench',
      key: 'reducedMotion',
      settingKey: 'workbench.reduceMotion',
      title: 'Reduce Motion',
      description: 'Reduces the motion used for animations and transitions across the UI.',
      control: 'checkbox',
    },
  ];
}

const inputClass =
  'h-[26px] rounded-[3px] bg-vsc-input border border-vsc-input-border text-vsc-fg placeholder:text-vsc-placeholder focus:border-vsc-focus outline-none text-ui px-2';

/**
 * What a number field commits when focus leaves it: the number typed, held
 * to the field's range — or, when nothing readable was typed, the saved
 * value, which commits nothing.
 *
 * A blank field is not 0. `Number('')` is, and it used to be clamped to the
 * minimum and saved: clear Scrollback to type a new value, click anywhere,
 * and it was 100 — applied live, so every open terminal dropped all but its
 * last 100 lines, for good. Font sizes went to 8 the same way, and Notify
 * After to 0, which turns it off. A type="number" input also reports '' for
 * text it cannot read, so that arrives here as a blank too.
 */
export function numberToCommit(text, { min, max }, saved) {
  const typed = String(text ?? '').trim();
  const n = typed === '' ? NaN : Number(typed);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : saved;
}

/** Number/text controls commit on blur or Enter so mid-typing digits never
 * get clobbered by a live re-clamp — but there is still no Save button
 * anywhere in the window; every field takes effect the moment you leave it. */
function TextLikeControl({ item, value, onCommit }) {
  const [text, setText] = useState(String(value ?? ''));

  useEffect(() => {
    setText(String(value ?? ''));
  }, [value]);

  const commit = () => {
    if (item.control === 'number') {
      const next = numberToCommit(text, item, value);
      setText(String(next ?? ''));
      if (next !== value) onCommit(next);
    } else {
      onCommit(text);
    }
  };

  return (
    <input
      type={item.control === 'number' ? 'number' : 'text'}
      min={item.control === 'number' ? item.min : undefined}
      max={item.control === 'number' ? item.max : undefined}
      step={item.control === 'number' ? item.step : undefined}
      value={text}
      placeholder={item.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          e.currentTarget.blur();
        }
      }}
      className={cn(inputClass, 'w-[220px] font-mono')}
    />
  );
}

function SettingRow({ item, value, isDefault, onChange, onReset, note }) {
  return (
    <div className="py-3 px-1 border-b border-vsc-border last:border-b-0 group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-ui text-vsc-fg font-medium">{item.title}</div>
          <div className="font-mono text-ui-sm text-vsc-muted">{item.settingKey}</div>
        </div>
        {!isDefault && (
          <button
            type="button"
            onClick={onReset}
            title="Reset Setting"
            className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          >
            <RotateCcw size={14} />
            <span>Reset</span>
          </button>
        )}
      </div>

      <p className="mt-1 text-ui-sm text-vsc-muted">{item.description}</p>

      <div className="mt-2">
        {item.control === 'checkbox' && (
          <label className="inline-flex items-center gap-2 text-ui text-vsc-fg cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              className="h-[16px] w-[16px] accent-current"
            />
            <span>{value ? 'Enabled' : 'Disabled'}</span>
          </label>
        )}

        {item.control === 'select' && (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(inputClass, 'w-[220px]')}
          >
            {item.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}

        {(item.control === 'number' || item.control === 'text') && (
          <TextLikeControl item={item} value={value} onCommit={onChange} />
        )}

        {item.control === 'themeGallery' && <ThemeGallery />}

        {/* What the backend said about this value — a path that is not there,
            typically. Said here rather than left to be discovered when a
            terminal quietly opens somewhere else. */}
        {note && <p className="mt-1.5 text-ui-sm text-vsc-error">{note}</p>}
      </div>
    </div>
  );
}

export function SettingsWindow() {
  const isOpen = useSettingsStore((s) => s.isSettingsModalOpen);
  const setOpen = useSettingsStore((s) => s.setSettingsModalOpen);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const settingsDefaults = useSettingsStore((s) => s.settingsDefaults);

  const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const terminalLineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const terminalCursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const terminalCursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const terminalScrollback = useSettingsStore((s) => s.terminalScrollback);
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const terminalSuggestions = useSettingsStore((s) => s.terminalSuggestions);
  const terminalStickyHeader = useSettingsStore((s) => s.terminalStickyHeader);
  const terminalCopyOnSelect = useSettingsStore((s) => s.terminalCopyOnSelect);
  const terminalMouseReporting = useSettingsStore((s) => s.terminalMouseReporting);
  const terminalRightClick = useSettingsStore((s) => s.terminalRightClick);
  const terminalMultiLinePasteWarning = useSettingsStore((s) => s.terminalMultiLinePasteWarning);
  const terminalAutoReplyBatchJob = useSettingsStore((s) => s.terminalAutoReplyBatchJob);
  const terminalDefaultShell = useSettingsStore((s) => s.terminalDefaultShell);
  const terminalNotifyAfterSeconds = useSettingsStore((s) => s.terminalNotifyAfterSeconds);
  const terminalProgramNotifications = useSettingsStore((s) => s.terminalProgramNotifications);
  const terminalBellAttention = useSettingsStore((s) => s.terminalBellAttention);
  const terminalAttentionFlashFocused = useSettingsStore((s) => s.terminalAttentionFlashFocused);
  const terminalProgress = useSettingsStore((s) => s.terminalProgress);
  const terminalsPanelFolder = useSettingsStore((s) => s.terminalsPanelFolder);
  const terminalsPanelBranch = useSettingsStore((s) => s.terminalsPanelBranch);
  const terminalsPanelAgent = useSettingsStore((s) => s.terminalsPanelAgent);
  const terminalsPanelLastNote = useSettingsStore((s) => s.terminalsPanelLastNote);
  const terminalsPanelSortAttention = useSettingsStore((s) => s.terminalsPanelSortAttention);
  const terminalDefaultCwd = useSettingsStore((s) => s.terminalDefaultCwd);
  const terminalDefaultCwdPath = useSettingsStore((s) => s.terminalDefaultCwdPath);
  const terminalSplitCwd = useSettingsStore((s) => s.terminalSplitCwd);
  const terminalEqualizeOnSplit = useSettingsStore((s) => s.terminalEqualizeOnSplit);
  const terminalHideSingleTabStrip = useSettingsStore((s) => s.terminalHideSingleTabStrip);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const editorTabSize = useSettingsStore((s) => s.editorTabSize);
  const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
  const editorMinimap = useSettingsStore((s) => s.editorMinimap);
  const editorRestoreTabs = useSettingsStore((s) => s.editorRestoreTabs);
  const filesEnableTrash = useSettingsStore((s) => s.filesEnableTrash);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);

  const values = {
    terminalFontFamily,
    terminalFontSize,
    terminalLineHeight,
    terminalCursorStyle,
    terminalCursorBlink,
    terminalScrollback,
    terminalTheme,
    terminalSuggestions,
    terminalStickyHeader,
    terminalCopyOnSelect,
    terminalMouseReporting,
    terminalRightClick,
    terminalMultiLinePasteWarning,
    terminalAutoReplyBatchJob,
    terminalDefaultShell,
    terminalNotifyAfterSeconds,
    terminalProgramNotifications,
    terminalBellAttention,
    terminalAttentionFlashFocused,
    terminalProgress,
    terminalsPanelFolder,
    terminalsPanelBranch,
    terminalsPanelAgent,
    terminalsPanelLastNote,
    terminalsPanelSortAttention,
    terminalDefaultCwd,
    terminalDefaultCwdPath,
    terminalSplitCwd,
    terminalEqualizeOnSplit,
    terminalHideSingleTabStrip,
    editorFontSize,
    editorTabSize,
    editorWordWrap,
    editorMinimap,
    editorRestoreTabs,
    filesEnableTrash,
    reducedMotion,
  };

  const [query, setQuery] = useState('');
  // What Reset All is asking before it runs, or null (`resetAllQuestion`).
  const [resetQuestion, setResetQuestion] = useState(null);
  const [activeSection, setActiveSection] = useState('editor');
  // Per-item validation messages, keyed by item id. Async because the only
  // honest answer to "is that a directory?" comes from the backend.
  const [notes, setNotes] = useState({});

  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const sectionNodeRefs = useRef({});
  const titleId = useId();

  // Read again each time the window opens rather than once: `isOpen` is the
  // reason to look again, not something the reading uses.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const monoPlaceholder = useMemo(() => readInheritedMonoStack(), [isOpen]);
  const detectedShells = useSystemStore((s) => s.shells);
  const homeDir = useSystemStore((s) => s.homeDir);
  const ITEMS = useMemo(
    () => buildItems(monoPlaceholder, detectedShells, homeDir),
    [monoPlaceholder, detectedShells, homeDir]
  );

  const validatedSignature = ITEMS.filter((i) => i.validate)
    .map((i) => `${i.id}=${values[i.key]}`)
    .join('\u0000');

  // Check the values that can be wrong about the world. Async, so the result
  // arrives after the render that asked for it; `cancelled` keeps a stale
  // answer from overwriting a newer one when the value changes while a check
  // is still in flight.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    const validated = ITEMS.filter((item) => item.validate);
    if (validated.length === 0) return undefined;
    Promise.all(
      validated.map(async (item) => [item.id, await item.validate(values[item.key])])
    ).then((pairs) => {
      if (!cancelled) setNotes(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // `values` is rebuilt every render, so depend on the validated values
    // themselves — as one string, since a spread would change the dep array's
    // LENGTH between renders and React refuses to compare those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, ITEMS, validatedSignature]);

  // Reset transient UI state (search, scroll spy) every time the window opens.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveSection('editor');
    setResetQuestion(null);
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  // Note what has focus as the window opens — the search box takes it a frame
  // later — and give it back when the window closes, however it closes.
  useEffect(() => {
    if (!isOpen) return undefined;
    const opener = document.activeElement;
    return () => {
      focusAfterClose(opener, document)?.focus();
    };
  }, [isOpen]);

  // Escape to close + a focus trap that keeps Tab cycling inside the window.
  useEffect(() => {
    if (!isOpen) return undefined;

    const getFocusable = () => {
      const dialog = dialogRef.current;
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled && el.offsetParent !== null);
    };

    const onKeyDown = (e) => {
      const action = settingsWindowKey(e);
      if (action === 'close') {
        e.preventDefault();
        leaveEditedField(dialogRef.current, document);
        setOpen(false);
        return;
      }
      if (action === 'trap') {
        const focusable = getFocusable();
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, setOpen]);

  // Scroll-spy: highlight whichever section heading is nearest the top of
  // the scrollable list as the user scrolls, so the left nav tracks it.
  useEffect(() => {
    if (!isOpen) return undefined;
    const root = listRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveSection(visible[0].target.dataset.section);
        }
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    );

    Object.values(sectionNodeRefs.current).forEach((node) => {
      if (node) observer.observe(node);
    });

    return () => observer.disconnect();
  }, [isOpen, query]);

  if (!isOpen) return null;

  const q = query.trim();
  const filteredItems = ITEMS.filter(
    (item) =>
      item.visibleWhen?.(values) !== false
      && (fuzzyMatch(q, item.title) || fuzzyMatch(q, item.description) || fuzzyMatch(q, item.settingKey))
  );

  const visibleSections = SECTIONS.filter((section) =>
    // Keyboard Shortcuts builds its own rows rather than coming from ITEMS,
    // so it decides for itself whether the query matches anything.
    section.id === 'keyboard' ? true : filteredItems.some((item) => item.section === section.id)
  );

  const jumpToSection = (sectionId) => {
    setActiveSection(sectionId);
    sectionNodeRefs.current[sectionId]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const handleChange = (item, raw) => {
    setSetting(item.key, raw);
  };

  const handleReset = (item) => {
    setSetting(item.key, settingsDefaults[item.key]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The window closes during this press and gives focus back; the
        // press's own default would then move focus to what was clicked —
        // nothing — and take it away again.
        e.preventDefault();
        leaveEditedField(dialogRef.current, document);
        setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex flex-col w-[900px] min-w-[720px] max-w-[90vw] h-[640px] min-h-[520px] max-h-[85vh] bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[6px] overflow-hidden"
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-3 h-panel-header px-4 border-b border-vsc-border">
          <h2 id={titleId} className="text-ui font-semibold text-vsc-fg flex-shrink-0">
            Settings
          </h2>

          <div className="flex-1 flex items-center gap-2 h-[26px] px-2 rounded-[3px] bg-vsc-input border border-vsc-input-border focus-within:border-vsc-focus transition-colors max-w-[360px]">
            <Search size={14} className="text-vsc-muted flex-shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-ui text-vsc-fg placeholder:text-vsc-placeholder"
            />
          </div>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => resetAll(setResetQuestion)}
            className="flex-shrink-0 h-[26px] px-2.5 rounded-[3px] text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          >
            Reset All
          </button>

          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close"
            className="flex-shrink-0 p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: left section nav + right settings list */}
        <div className="flex flex-1 min-h-0">
          <nav className="w-[180px] flex-shrink-0 border-r border-vsc-border overflow-y-auto py-2">
            {visibleSections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => jumpToSection(section.id)}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-ui-sm transition-colors',
                  activeSection === section.id
                    ? 'text-vsc-fg bg-vsc-item-active font-medium'
                    : 'text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover'
                )}
              >
                {section.label}
              </button>
            ))}
          </nav>

          <div ref={listRef} className="flex-1 overflow-y-auto px-4">
            {visibleSections.length === 0 && (
              <div className="py-8 text-center text-vsc-muted text-ui-sm italic">
                No matching settings.
              </div>
            )}

            {visibleSections.map((section) => (
              <div
                key={section.id}
                data-section={section.id}
                ref={(node) => {
                  sectionNodeRefs.current[section.id] = node;
                }}
                className="pt-4"
              >
                <h3 className="text-ui font-semibold text-vsc-fg pb-2 border-b border-vsc-border uppercase tracking-wide text-ui-sm">
                  {section.label}
                </h3>
                {section.id === 'keyboard' && <KeybindingSettings query={query} />}
                {filteredItems
                  .filter((item) => item.section === section.id)
                  .map((item) => {
                    const value = values[item.key];
                    const isDefault = Object.is(value, settingsDefaults[item.key]);
                    return (
                      <SettingRow
                        key={item.id}
                        note={notes[item.id]}
                        item={item}
                        value={value}
                        isDefault={isDefault}
                        onChange={(raw) => handleChange(item, raw)}
                        onReset={() => handleReset(item)}
                      />
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Over the window, in the window's tree: its Escape and Tab are the
          dialog's (it listens on `window` in the capture phase, ahead of the
          window's own listener on `document`), and a press on its dim area
          is not a press on the window's. Cancel is focused: the answer that
          loses nothing. */}
      <ConfirmDialog
        open={Boolean(resetQuestion)}
        title={resetQuestion?.title}
        message={resetQuestion?.message}
        confirmLabel={resetQuestion?.confirmLabel}
        danger
        initialFocus="cancel"
        onConfirm={() => {
          setResetQuestion(null);
          resetSettings();
        }}
        onCancel={() => setResetQuestion(null)}
      />
    </div>
  );
}

export default SettingsWindow;
