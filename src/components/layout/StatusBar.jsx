import React, { useEffect, useMemo } from 'react';
import { Folder, TerminalSquare, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { buildStatusItems } from '../../lib/statusInfo.js';
import { runMenuAction } from '../../lib/menuActions.js';
import { cn } from '../../lib/utils.js';

const ICONS = { folder: Folder, terminal: TerminalSquare, x: XCircle };

/**
 * One chip. An item carrying an `action` is a real control and renders as a
 * button; everything else is a read-out and stays a div, so nothing on this
 * bar looks clickable without being clickable — which is exactly what the
 * notifications bell that used to sit at the end of it did for four versions.
 */
function StatusItem({ item }) {
  const Icon = item.icon ? ICONS[item.icon] : null;
  const className = cn(
    'h-full px-2 flex items-center gap-1 shrink-0 whitespace-nowrap',
    item.action ? 'cursor-pointer' : 'cursor-default',
    item.kind === 'accent' && 'bg-vsc-accent text-vsc-accent-fg font-medium',
    item.kind === 'error' && 'bg-vsc-error text-white',
    item.kind === 'plain' && 'text-vsc-fg hover:bg-vsc-item-hover'
  );
  const body = (
    <>
      {Icon && <Icon size={13} className="shrink-0" />}
      <span className="truncate">{item.text}</span>
    </>
  );

  if (item.action) {
    return (
      <button
        type="button"
        data-status-id={item.id}
        title={item.title || undefined}
        onClick={() => runMenuAction(item.action)}
        className={className}
      >
        {body}
      </button>
    );
  }

  return (
    <div data-status-id={item.id} title={item.title || undefined} className={className}>
      {body}
    </div>
  );
}

/**
 * The status bar.
 *
 * Everything here is read from real state. It used to claim a git branch of
 * "main" and a shell of "zsh" no matter what was running, which on a Windows
 * machine in cmd.exe was wrong twice over — and a bar that lies is worse than
 * no bar. What genuinely differs by platform (line endings, the code page
 * Windows consoles still get wrong, what a shell is called, whether `~` means
 * anything) differs here too, in src/lib/statusInfo.js.
 */
export function StatusBar() {
  const initSystem = useSystemStore((s) => s.init);
  const os = useSystemStore((s) => s.os);
  const arch = useSystemStore((s) => s.arch);
  const homeDir = useSystemStore((s) => s.homeDir);
  const systemShell = useSystemStore((s) => s.defaultShell);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const groups = useTerminalStore((s) => s.groups);
  const storeCwd = useTerminalStore((s) => s.cwd);
  // Null until the backend has been asked, and while no folder is open.
  const rootPath = useEditorStore((s) => (s.rootResolved ? s.rootPath : null));
  const configuredShell = useSettingsStore((s) => s.terminalDefaultShell);
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const defaultFontSize = useSettingsStore((s) => s.settingsDefaults.terminalFontSize);

  useEffect(() => {
    initSystem();
  }, [initSystem]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  // `lastSize` is written by the store on every PTY resize, as "<cols>x<rows>".
  const [cols, rows] = useMemo(() => {
    const parsed = /^(\d+)x(\d+)$/.exec(activeTab?.lastSize || '');
    return parsed ? [Number(parsed[1]), Number(parsed[2])] : [null, null];
  }, [activeTab?.lastSize]);

  // The shell's own verdict on the last command, recorded from
  // `pty-command-done` — which fires for anything typed, not only for the
  // commands the block UI happens to be tracking.
  const lastExitCode = activeTab?.lastExitCode ?? null;

  const { left, right } = useMemo(
    () =>
      buildStatusItems({
        os,
        arch,
        homeDir,
        workspacePath: rootPath,
        cwd: activeTab?.cwd || storeCwd,
        shell: configuredShell && configuredShell !== 'default' ? configuredShell : systemShell,
        cols,
        rows,
        groupCount: groups.length,
        terminalCount: tabs.length,
        lastExitCode,
        shellExited: Boolean(activeTab?.exited),
        fontSize: terminalFontSize,
        defaultFontSize,
      }),
    [
      os, arch, homeDir, rootPath, activeTab?.cwd, activeTab?.exited, storeCwd,
      configuredShell, systemShell, cols, rows, groups.length, tabs.length, lastExitCode,
      terminalFontSize, defaultFontSize,
    ]
  );

  return (
    <footer
      role="status"
      className="h-statusbar shrink-0 flex items-center justify-between bg-vsc-statusbar border-t border-vsc-border text-[12px] text-vsc-fg select-none overflow-hidden"
    >
      <div className="flex items-center h-full min-w-0">
        {left.map((it) => (
          <StatusItem key={it.id} item={it} />
        ))}
      </div>

      <div className="flex items-center h-full min-w-0">
        {right.map((it) => (
          <StatusItem key={it.id} item={it} />
        ))}
      </div>
    </footer>
  );
}

export default StatusBar;
