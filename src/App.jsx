import React, { useEffect } from 'react';
import { TitleBar } from './components/layout/TitleBar.jsx';
import { Sidebar } from './components/layout/Sidebar.jsx';
import { StatusBar } from './components/layout/StatusBar.jsx';
import { PanelLayout } from './components/layout/PanelLayout.jsx';
import { CommandPalette } from './components/command/CommandPalette.jsx';
import { useKeybindings } from './hooks/useKeybindings.js';
import { useTheme } from './hooks/useTheme.js';
import { useTerminalStore } from './stores/terminalStore.js';
import { useEditorStore } from './stores/editorStore.js';
import { useAgentStore } from './stores/agentStore.js';
import { useChatStore } from './stores/chatStore.js';

export default function App() {
  // Initialize global theme and keyboard shortcuts
  useTheme();
  useKeybindings();

  const initTerminal = useTerminalStore((s) => s.init);
  const initEditor = useEditorStore((s) => s.init);
  const initAgents = useAgentStore((s) => s.initAgents);
  const initChat = useChatStore((s) => s.initChat);

  useEffect(() => {
    // Proactively initialize all IDE subsystems
    initTerminal();
    initEditor();
    initAgents();
    initChat();
  }, [initTerminal, initEditor, initAgents, initChat]);

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

      {/* Global ⌘K Command Palette */}
      <CommandPalette />
    </div>
  );
}
