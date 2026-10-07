import React, { useId, useMemo, useRef, useState } from 'react';
import { RotateCcw, X, AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { isMac } from '../../lib/platform.js';
import { displayChord } from '../../lib/chords.js';
import {
  configurableCommands,
  commandsOverTerminal,
  describeConflict,
  resolveKeybindings,
  findConflicts,
  keysFor,
  recordKeydown,
} from '../../lib/keybindings.js';
import { cn } from '../../lib/utils.js';

/**
 * The attribute that marks the field a shortcut is being recorded in. While
 * it has focus Escape is the recorder's — it ends the recording — and the
 * Settings window, whose listener runs first, leaves the key alone (see
 * `settingsWindowKey`).
 */
export const CHORD_RECORDER = 'data-chord-recorder';

const NO_NOTES = new Map();

/**
 * The paragraph above the list: which shortcuts a focused terminal never
 * sees.
 *
 * Built from the `overTerminal` flags rather than written out. The sentence it
 * replaces said only the two side-bar toggles were claimed over a terminal;
 * true when it was written, it stayed while the count grew to ten — the wrong
 * thing to tell someone looking for the command that took a key from their
 * shell.
 */
export function overTerminalNote(commands = commandsOverTerminal()) {
  const titles = commands.map((c) => c.title);
  if (titles.length === 0) {
    return 'Over a focused terminal, a shortcut works only when the terminal has no use for its keys.';
  }
  const named = titles.length === 1
    ? titles[0]
    : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
  return (
    `Over a focused terminal, the keys of ${named} are taken before the shell sees them. ` +
    'Any other shortcut works there only when the terminal has no use for its keys. ' +
    'Rebind one here if it clashes with something you run in a pane — a tmux prefix, say.'
  );
}

/**
 * The field a shortcut is recorded in, while it is. `refusal` says why the
 * last key pressed was not taken; `refusalId` is where that is written.
 */
export function ChordRecorder({ title, refusal, refusalId, onKeyDown, onBlur }) {
  return (
    <input
      {...{ [CHORD_RECORDER]: '' }}
      autoFocus
      readOnly
      value="Press the keys…"
      aria-label={`Press the keys for ${title}`}
      aria-invalid={refusal ? true : undefined}
      aria-describedby={refusal ? refusalId : undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={cn(
        'w-[150px] bg-vsc-input border rounded-sm px-2 py-0.5 text-ui-sm text-vsc-fg outline-none',
        refusal ? 'border-vsc-error' : 'border-vsc-focus'
      )}
    />
  );
}

/**
 * One row: a command, the chord bound to it, and a way to change it.
 *
 * Recording is done on the real keyboard rather than by typing `mod+shift+b`,
 * because nobody wants to learn a spelling to rebind a key. The chord that
 * comes back is the same shape the matcher uses, so what you pressed is
 * exactly what gets bound — once it is something a shortcut can be (see
 * `recordKeydown`).
 *
 * `notes` holds, per chord of this command, the conflicts it is part of.
 */
function KeybindingRow({ command, keys, notes, onBind, onUnbind, onReset, isDefault }) {
  const [recording, setRecording] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const refusalId = useId();
  const changeRef = useRef(null);

  const stopRecording = ({ refocus }) => {
    setRecording(false);
    setRefusal(null);
    // The field that had focus is about to go; without this, focus would
    // fall to the page and the next Tab would start from nowhere.
    if (refocus) changeRef.current?.focus();
  };

  const record = (e) => {
    const outcome = recordKeydown(e, { isMac });
    // Tab moves focus on as everywhere else, and the blur ends the recording.
    if (outcome.action === 'leave') return;
    e.preventDefault();
    e.stopPropagation();
    if (outcome.action === 'refuse') setRefusal(outcome.reason);
    else if (outcome.action === 'cancel') stopRecording({ refocus: true });
    else if (outcome.action === 'bind') {
      onBind(outcome.key);
      stopRecording({ refocus: true });
    }
  };

  return (
    <div className="py-1.5 border-b border-vsc-border/40 group">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-ui text-vsc-fg">{command.title}</span>

        <div className="flex items-center gap-1 shrink-0">
          {keys.length === 0 && !recording && (
            <span className="text-ui-sm text-vsc-muted italic px-2">Unassigned</span>
          )}
          {!recording &&
            keys.map((key) => {
              const note = notes.get(key);
              return (
                <kbd
                  key={key}
                  title={note ?? key}
                  className={cn(
                    'px-1.5 py-0.5 rounded-sm border font-mono text-ui-sm',
                    note
                      ? 'border-vsc-error text-vsc-error'
                      : 'bg-vsc-button-secondary border-vsc-border text-vsc-fg'
                  )}
                >
                  {displayChord(key, { isMac })}
                </kbd>
              );
            })}
          {recording && (
            <ChordRecorder
              title={command.title}
              refusal={refusal}
              refusalId={refusalId}
              onKeyDown={record}
              onBlur={() => stopRecording({ refocus: false })}
            />
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
          <button
            ref={changeRef}
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

      {recording && refusal && (
        <p id={refusalId} role="status" className="pt-1 text-ui-sm text-vsc-error">
          {refusal}
        </p>
      )}
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
  const conflicts = useMemo(() => findConflicts(bindings, { isMac }), [bindings]);

  // Per command, per chord: the conflicts that chord is in. Both sides are
  // marked — the chord that never runs, and the one that runs in its place.
  const notesByCommand = useMemo(() => {
    const notes = new Map();
    const add = (command, key, text) => {
      if (!notes.has(command)) notes.set(command, new Map());
      const byKey = notes.get(command);
      byKey.set(key, byKey.has(key) ? `${byKey.get(key)}\n${text}` : text);
    };
    for (const conflict of conflicts) {
      const text = describeConflict(conflict, { isMac });
      add(conflict.command, conflict.key, text);
      add(conflict.winner, conflict.winnerKey, text);
    }
    return notes;
  }, [conflicts]);

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
          <div>
            <p>
              {conflicts.length === 1 ? 'One shortcut never runs' : `${conflicts.length} shortcuts never run`},
              because another command takes the same keys first:
            </p>
            <ul>
              {conflicts.map((conflict) => (
                <li key={`${conflict.command}\u0000${conflict.key}`}>
                  {describeConflict(conflict, { isMac })}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <p className="text-ui-sm text-vsc-muted pt-2 pb-1">{overTerminalNote()}</p>

      {commands.map((command) => (
        <KeybindingRow
          key={command.id}
          command={command}
          keys={keysFor(command.id, bindings)}
          notes={notesByCommand.get(command.id) ?? NO_NOTES}
          isDefault={!(command.id in (overrides || {}))}
          onBind={(key) => update(command.id, key)}
          onUnbind={() => update(command.id, null)}
          onReset={() => reset(command.id)}
        />
      ))}
    </div>
  );
}

export default KeybindingSettings;
