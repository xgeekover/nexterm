/**
 * What a terminal pane with no terminal in it draws (A2): "No terminal in
 * this pane" with New Terminal, a New <agent> Terminal button for each
 * coding agent NexTerm knows (`AGENT_IDS`, labelled by `agentLabel`), and
 * up to three recent agent sessions of the history (`launcherSessions`:
 * newest first, archived entries and agents this build does not know left
 * out).
 *
 * Nothing runs until a click. Drawing it asks the backend nothing and types
 * nothing: the history entries are read from the store as they are (the
 * app starts the history store, App.jsx), never loaded from here.
 *
 * - New Terminal opens a terminal in this pane (`createTab` with
 *   `{ paneId, groupId }`), as the pane always did.
 * - New <agent> Terminal opens one there and starts the agent in it
 *   (`startAgent`, which types the agent line after the shell's first
 *   prompt, through untilTypingSafe). A second click while the first is
 *   still opening its terminal does nothing: one click, one terminal.
 * - A recent session is resumed in this pane (`resumeFromHistory(key,
 *   { paneId, groupId })`): a terminal of this window that holds it is
 *   switched to instead, as everywhere else.
 *
 * There is no Close here: the kept empty pane is the one terminal pane
 * left (Q-C1). This file imports no terminal registry, so the workbench
 * never loads xterm through it.
 */
import React, { useMemo, useRef } from 'react';
import { Bot, Play } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useAgentHistoryStore } from '../../stores/agentHistoryStore.js';
import { AGENT_IDS, agentLabel } from '../../lib/agents.js';
import { historyDisplay } from '../../lib/agentHistory.js';
import { launcherSessions } from './agentSessionsModel.js';
import { cn } from '../../lib/utils.js';

const BUTTON =
  'px-3 py-1 rounded-sm bg-vsc-button-secondary border border-vsc-input-border hover:bg-vsc-item-hover text-vsc-fg transition';

/** The tooltip of a recent session's row: its folder, and what a click does. */
function sessionTooltip(shown, held) {
  return [
    `${shown.label}: ${shown.title}`,
    shown.folderPath,
    held ? 'Click to show its terminal' : 'Click to resume it in this pane',
  ].join('\n');
}

export function EmptyPaneLauncher({ paneId, groupId, newTerminalKeys }) {
  const entries = useAgentHistoryStore((s) => s.entries);
  const holders = useAgentHistoryStore((s) => s.holders);
  const recent = useMemo(() => launcherSessions(entries), [entries]);
  // One agent terminal per click: set while the first one is opening.
  const opening = useRef(false);

  const newTerminal = () => {
    useTerminalStore.getState().createTab(null, { paneId, groupId });
  };

  const newAgentTerminal = async (kind) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const created = await useTerminalStore.getState().createTab(null, { paneId, groupId });
      // Started, not waited for: it types once the shell is ready.
      if (created?.id) useTerminalStore.getState().startAgent(created.id, kind);
    } finally {
      opening.current = false;
    }
  };

  const resume = (key) => {
    useTerminalStore.getState().resumeFromHistory(key, { paneId, groupId });
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-ui-sm text-vsc-muted select-none overflow-auto p-2">
      <p className="m-0">No terminal in this pane</p>
      <button type="button" onClick={newTerminal} className={BUTTON}>
        New Terminal
        {newTerminalKeys ? <span className="ml-2 text-vsc-muted font-mono">{newTerminalKeys}</span> : null}
      </button>
      {AGENT_IDS.map((kind) => (
        <button
          key={kind}
          type="button"
          data-launcher-agent={kind}
          onClick={() => newAgentTerminal(kind)}
          title={`Open a terminal in this pane and start ${agentLabel(kind)} in it`}
          className={cn(BUTTON, 'inline-flex items-center gap-1.5')}
        >
          <Bot size={13} aria-hidden="true" />
          {`New ${agentLabel(kind)} Terminal`}
        </button>
      ))}
      {recent.length > 0 && (
        <div data-launcher-recent="" className="mt-2 flex flex-col items-stretch gap-1 w-full max-w-sm">
          <p className="m-0 text-vsc-muted">Recent agent sessions</p>
          {recent.map((entry) => {
            const shown = historyDisplay(entry);
            const held = Boolean(holders?.[entry.key]);
            return (
              <button
                key={entry.key}
                type="button"
                data-launcher-session={entry.key}
                onClick={() => resume(entry.key)}
                title={sessionTooltip(shown, held)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-left hover:bg-vsc-item-hover text-vsc-fg transition min-w-0"
              >
                <Play size={12} aria-hidden="true" className="shrink-0 text-vsc-muted" />
                <span className={cn('truncate', !shown.titled && 'italic')}>{shown.title}</span>
                <span className="shrink-0 text-vsc-muted">{shown.label}</span>
                <span className="ml-auto truncate text-vsc-muted">{shown.folder}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
