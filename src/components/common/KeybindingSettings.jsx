import React, { useMemo, useState } from 'react';
import { RotateCcw, X, AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { isMac } from '../../lib/platform.js';
import { chordFromEvent, displayChord, stringifyChord, parseChord } from '../../lib/chords.js';
import {
  configurableCommands,
  resolveKeybindings,
  findConflicts,
  keysFor,
} from '../../lib/keybindings.js';
import { cn } from '../../lib/utils.js';

/**
 * One row: a command, the chord bound to it, and a way to change it.
 *
 * Recording is done on the real keyboard rather than by typing `mod+shift+b`,
 * because nobody wants to learn a spelling to rebind a key. The chord that
 * comes back is the same shape the matcher uses, so what you pressed is
 * exactly what gets bound.
 */
function KeybindingRow({ command, keys, conflictKeys, onBind, onUnbind, onReset, isDefault }) {
  const [recording, setRecording] = useState(false);

  const record = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    const chord = chordFromEvent(e, { isMod: isMac ? e.metaKey : e.ctrlKey });
    // Still only modifiers down — wait for a real key.
    if (!chord) return;
    onBind(stringifyChord(chord));
    setRecording(false);
  };

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-vsc-border/40 group">
      <span className="flex-1 min-w-0 truncate text-ui text-vsc-fg">{command.title}</span>

      <div className="flex items-center gap-1 shrink-0">
        {keys.length === 0 && !recording && (
          <span className="text-ui-sm text-vsc-muted italic px-2">Unassigned</span>
        )}
        {!recording &&
          keys.map((key) => (
            <kbd
              key={key}
              title={conflictKeys.has(key) ? 'Another command uses this chord' : key}
              className={cn(
                'px-1.5 py-0.5 rounded-sm border font-mono text-ui-sm',
                conflictKeys.has(key)
                  ? 'border-vsc-error text-vsc-error'
                  : 'bg-vsc-button-secondary border-vsc-border text-vsc-fg'
              )}
            >
              {displayChord(key, { isMac })}
            </kbd>
          ))}
        {recording && (
          <input
            autoFocus
            readOnly
            value="Press the keys…"
            onKeyDown={record}
            onBlur={() => setRecording(false)}
            className="w-[150px] bg-vsc-input border border-vsc-focus rounded-sm px-2 py-0.5 text-ui-sm text-vsc-fg outline-none"
          />
        )}
      </div>

      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <button
          type="button"
          onClick={() => setRecording(true)}
          className="px-2 py-0.5 rounded-sm text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
        >
          Change
        </button>
        <button
          type="button"
          title="Remove this shortcut"
          onClick={onUnbind}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-error hover:bg-vsc-item-hover disabled:opacity-30"
          disabled={keys.length === 0}
        >
          <X size={14} />
        </button>
        <button
          type="button"
          title="Back to the default"
          onClick={onReset}
          className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover disabled:opacity-30"
          disabled={isDefault}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * The Keyboard Shortcuts section of the settings window.
 *
 * Overrides are stored per command, not as a whole replacement list, so a
 * command that gains a shortcut in a later version gets it without anyone
 * having to migrate a saved file. `null` means the user deliberately unbound
 * something, which is different from never having touched it.
 */
export function KeybindingSettings({ query = '' }) {
  const overrides = useSettingsStore((s) => s.keybindings);
  const setSetting = useSettingsStore((s) => s.setSetting);

  const { bindings } = useMemo(() => resolveKeybindings(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  const conflictKeys = useMemo(() => new Set(conflicts.map((c) => c.key)), [conflicts]);
  const defaults = useMemo(() => resolveKeybindings({}).bindings, []);

  const commands = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = configurableCommands();
    if (!q) return all;
    return all.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.id.includes(q) ||
        keysFor(c.id, bindings).some((k) => displayChord(k, { isMac }).toLowerCase().includes(q))
    );
  }, [query, bindings]);

  const update = (commandId, value) =>
    setSetting('keybindings', { ...overrides, [commandId]: value });

  const reset = (commandId) => {
    const next = { ...overrides };
    delete next[commandId];
    setSetting('keybindings', next);
  };

  if (commands.length === 0) return null;

  // No heading of its own: SettingsWindow already draws the section header,
  // and two "Keyboard Shortcuts" titles in a row read as a rendering bug.
  return (
    <div>
      {conflicts.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 mt-2 px-2 py-1.5 rounded-sm border border-vsc-error text-ui-sm text-vsc-error"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {conflicts.length === 1 ? 'One chord is' : `${conflicts.length} chords are`} bound to
            more than one command. Whichever is listed first wins, which is rarely what anyone
            means:{' '}
            {conflicts.map((c) => displayChord(c.key, { isMac })).join(', ')}
          </span>
        </div>
      )}

      <p className="text-ui-sm text-vsc-muted pt-2 pb-1">
        Over a focused terminal only the two side-bar toggles are claimed; every other chord goes
        to the shell. Rebind one here if it clashes with something you run in a pane — a tmux
        prefix, say.
      </p>

      {commands.map((command) => {
        const keys = keysFor(command.id, bindings);
        const defaultKeys = keysFor(command.id, defaults);
        const isDefault = !(command.id in (overrides || {}));
        return (
          <KeybindingRow
            key={command.id}
            command={command}
            keys={keys}
            conflictKeys={conflictKeys}
            isDefault={isDefault}
            onBind={(key) => update(command.id, key)}
            onUnbind={() => update(command.id, null)}
            onReset={() => reset(command.id)}
            defaultKeys={defaultKeys}
          />
        );
      })}
    </div>
  );
}

export default KeybindingSettings;
