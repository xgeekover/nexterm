import React, { useEffect } from 'react';
import { TitleBar } from './components/layout/TitleBar.jsx';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { StatusBar } from './components/layout/StatusBar.jsx';
import { PanelLayout } from './components/layout/PanelLayout.jsx';
import { CommandPalette } from './components/command/CommandPalette.jsx';
import { SettingsWindow } from './components/common/SettingsWindow.jsx';
import { OpenFailureNotice } from './components/editor/OpenFailureNotice.jsx';
import { PasteWarningDialog } from './components/terminal/PasteWarningDialog.jsx';
import { useKeybindings } from './hooks/useKeybindings.js';
import { useMenuEvents } from './hooks/useMenuEvents.js';
import { useUnsavedGuard } from './hooks/useUnsavedGuard.js';
import { useTerminalFileDrop } from './hooks/useTerminalFileDrop.js';
import { useAttention } from './hooks/useAttention.js';
import { useBranchLookups } from './hooks/useBranchLookups.js';
import { useTerminalStore } from './stores/terminalStore.js';
import { loadCommandHistory } from './lib/commandIndex.js';
import { useEditorStore } from './stores/editorStore.js';
import { useSettingsStore } from './stores/settingsStore.js';
import { mockBridge } from './lib/ipc.js';
import { startPerfMode } from './lib/perf/perfMode.js';

// QA hook: expose stores + the browser mock so tests/scripts can seed state.
// Only in dev builds or when the page is opened with `?debug`.
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
  window.__nexterm = { useTerminalStore, useEditorStore, useSettingsStore, mockBridge };
}

export default function App() {
  // Initialize global theme and keyboard shortcuts
  useKeybindings();
  useMenuEvents();
  // Closing the window or quitting asks about unsaved editor tabs first.
  useUnsavedGuard();
  // Files dropped from the OS on a terminal pane go in as their paths.
  useTerminalFileDrop();
  // The window coming back to the front marks the terminal on screen read,
  // and every terminal's progress goes to the taskbar. Once, here: mounted
  // twice, the taskbar would be told everything twice.
  useAttention();
  // The branch of each terminal's folder, for the TERMINALS side bar: looked
  // up when a folder changes, a command ends, or the workspace's git status
  // refreshes. Once, here: mounted twice, every folder would be asked twice.
  useBranchLookups();

  const initTerminal = useTerminalStore((s) => s.init);
  const initEditor = useEditorStore((s) => s.init);

  useEffect(() => {
    // What earlier sessions ran. Read once, before anything can record over
    // it — the history palette is worth much more when it outlives the window.
    loadCommandHistory();
    // Proactively initialize all IDE subsystems
    initTerminal();
    initEditor();
    // Only when the app was started to be measured (NEXTERM_PERF): one
    // question to the backend otherwise. See src/lib/perf/perfMode.js.
    startPerfMode();
    // Detach event listeners on unmount / HMR so they never stack up;
    // the bootstrap state (PTY sessions, agents) is kept.
    return () => {
      useTerminalStore.getState().dispose?.();
      useEditorStore.getState().dispose?.();
    };
  }, [initTerminal, initEditor]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-vsc-editor text-vsc-fg font-ui">
      {/* Draggable TitleBar */}
      <TitleBar />

      {/* Main IDE Workspace Area */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Icon Navigation Rail */}
        <Sidebar />

        {/* Dynamic Panels (Terminal, Monaco Editor, Explorer, Mission Control, Chat) */}
        <main className="flex-1 flex overflow-hidden">
          <PanelLayout />
        </main>
      </div>

      {/* Persistent Bottom Status Bar */}
      <StatusBar />

      {/* Why a file that was asked for did not open */}
      <OpenFailureNotice />

      {/* Global ⌘K Command Palette */}
      <CommandPalette />

      {/* VS Code-style Settings window — opened from the activity bar / menu */}
      <SettingsWindow />

      {/* "Paste N lines?" before a multi-line paste a program would run line by line */}
      <PasteWarningDialog />
    </div>
  );
}
