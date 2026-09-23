import React, { useEffect, useMemo, useRef, useState, useId } from 'react';
import { X, Search, RotateCcw } from 'lucide-react';
import { useSettingsStore, FONT_SIZE_RANGE } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { fuzzyMatch, cn } from '../../lib/utils.js';
import { TERMINAL_THEMES, TERMINAL_THEME_IDS } from '../../lib/terminalThemes.js';
import { isWindows } from '../../lib/platform.js';
import { expandHome } from '../../lib/paths.js';
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

import { KeybindingSettings } from './KeybindingSettings.jsx';

const SECTIONS = [
  { id: 'keyboard', label: 'Keyboard Shortcuts' },
  { id: 'editor', label: 'Text Editor' },
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
      description: 'Specifies the color theme used in the terminal.',
      control: 'select',
      options: TERMINAL_THEME_IDS.map((id) => ({ value: id, label: TERMINAL_THEMES[id].label })),
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
        try {
          const ok = await invoke('fs_dir_exists', { path: expandHome(wanted, homeDir) });
          return ok ? null : 'No directory there. New terminals will fall back to the workspace root.';
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
      id: 'terminalSuggestions',
      section: 'terminal',
      key: 'terminalSuggestions',
      settingKey: 'terminal.integrated.suggestions',
      title: 'Command Suggestions',
      description: 'Controls whether inline command suggestions and the completion popup are shown as you type in the terminal.',
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
      const n = Number(text);
      const clamped = Number.isFinite(n) ? Math.min(item.max, Math.max(item.min, n)) : value;
      setText(String(clamped));
      if (clamped !== value) onCommit(clamped);
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
  const terminalDefaultShell = useSettingsStore((s) => s.terminalDefaultShell);
  const terminalNotifyAfterSeconds = useSettingsStore((s) => s.terminalNotifyAfterSeconds);
  const terminalDefaultCwd = useSettingsStore((s) => s.terminalDefaultCwd);
  const terminalDefaultCwdPath = useSettingsStore((s) => s.terminalDefaultCwdPath);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const editorTabSize = useSettingsStore((s) => s.editorTabSize);
  const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
  const editorMinimap = useSettingsStore((s) => s.editorMinimap);
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
    terminalDefaultShell,
    terminalNotifyAfterSeconds,
    terminalDefaultCwd,
    terminalDefaultCwdPath,
    editorFontSize,
    editorTabSize,
    editorWordWrap,
    editorMinimap,
    reducedMotion,
  };

  const [query, setQuery] = useState('');
  const [activeSection, setActiveSection] = useState('editor');
  // Per-item validation messages, keyed by item id. Async because the only
  // honest answer to "is that a directory?" comes from the backend.
  const [notes, setNotes] = useState({});

  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const sectionNodeRefs = useRef({});
  const titleId = useId();

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
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
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
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'Tab') {
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
        if (e.target === e.currentTarget) setOpen(false);
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
            onClick={() => resetSettings()}
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
    </div>
  );
}

export default SettingsWindow;
