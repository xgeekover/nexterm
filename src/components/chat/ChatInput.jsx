import React, { useState, useRef } from 'react';
import {
  Send,
  Square,
  Paperclip,
  X,
  FileCode,
  Terminal,
  ChevronDown,
} from 'lucide-react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAgentStore } from '../../stores/agentStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';

export function ChatInput() {
  const [input, setInput] = useState('');
  const textareaRef = useRef(null);

  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopGenerating = useChatStore((s) => s.stopGenerating);
  const chatContext = useChatStore((s) => s.chatContext);
  const attachContext = useChatStore((s) => s.attachContext);
  const clearContext = useChatStore((s) => s.clearContext);

  const agents = useAgentStore((s) => s.agents);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const selectAgent = useAgentStore((s) => s.selectAgent);

  const activeEditorTabId = useEditorStore((s) => s.activeTabId);
  const editorTabs = useEditorStore((s) => s.tabs);
  const activeEditorTab = editorTabs.find((t) => t.id === activeEditorTabId) || null;

  const terminalTabs = useTerminalStore((s) => s.tabs);
  const activeTerminalTabId = useTerminalStore((s) => s.activeTabId);
  const activeTerminalTab = terminalTabs.find((t) => t.id === activeTerminalTabId) || terminalTabs[0] || null;

  const LINE_HEIGHT = 18;
  const MIN_ROWS = 1;
  const MAX_ROWS = 8;

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await sendMessage(selectedAgentId || 'agent-architect-01', trimmed);
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAttachActiveFile = () => {
    if (activeEditorTab) {
      attachContext({
        title: `File: ${activeEditorTab.fileName}`,
        content: activeEditorTab.content,
      });
    }
  };

  const handleAttachTerminal = () => {
    if (activeTerminalTab && activeTerminalTab.blocks.length > 0) {
      const lastBlock = activeTerminalTab.blocks[activeTerminalTab.blocks.length - 1];
      attachContext({
        title: `Terminal: ${lastBlock.command}`,
        content: `Command: ${lastBlock.command}\nOutput:\n${lastBlock.output}`,
      });
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  return (
    <div className="p-2 border-t border-vsc-border flex-shrink-0">
      {/* Context Badge */}
      {chatContext && (
        <div className="mb-1.5 flex items-center justify-between px-2 py-1 rounded-sm bg-vsc-input border border-vsc-input-border text-vsc-fg text-ui-sm">
          <div className="flex items-center gap-1.5 truncate">
            <Paperclip size={12} className="flex-shrink-0 text-vsc-muted" />
            <span className="truncate">{chatContext.title}</span>
          </div>
          <button
            type="button"
            onClick={clearContext}
            className="p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors flex-shrink-0"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Input container */}
      <div className="rounded-[3px] bg-vsc-input border border-vsc-input-border focus-within:border-vsc-focus transition-colors">
        <textarea
          ref={textareaRef}
          rows={MIN_ROWS}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = 'auto';
            const maxHeight = LINE_HEIGHT * MAX_ROWS;
            e.target.style.height = `${Math.min(maxHeight, e.target.scrollHeight)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${selectedAgent?.name || 'Agent'}…`}
          className="w-full px-2.5 pt-2 bg-transparent border-none outline-none font-sans text-ui text-vsc-fg placeholder:text-vsc-placeholder resize-none"
        />

        {/* Toolbar below textarea */}
        <div className="flex items-center justify-between px-2 py-1.5 select-none">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* Agent Selector Chip */}
            <div className="relative flex items-center gap-1 bg-vsc-button-secondary rounded-sm px-1.5 h-[20px]">
              <select
                value={selectedAgentId}
                onChange={(e) => selectAgent(e.target.value)}
                className="appearance-none bg-transparent border-none outline-none text-ui-sm text-vsc-fg pr-3 cursor-pointer max-w-[140px]"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id} className="bg-vsc-menu text-vsc-fg">
                    {a.name} ({a.model})
                  </option>
                ))}
              </select>
              <ChevronDown size={12} className="text-vsc-muted absolute right-1.5 pointer-events-none" />
            </div>

            {/* Quick Context Injection Buttons */}
            {activeEditorTab && (
              <button
                type="button"
                onClick={handleAttachActiveFile}
                className="hidden sm:flex items-center gap-1 px-1.5 h-[20px] rounded-sm text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
                title="Attach active file to context"
              >
                <FileCode size={12} />
                <span className="truncate max-w-[80px]">{activeEditorTab.fileName}</span>
              </button>
            )}

            {activeTerminalTab && activeTerminalTab.blocks.length > 0 && (
              <button
                type="button"
                onClick={handleAttachTerminal}
                className="hidden sm:flex items-center gap-1 px-1.5 h-[20px] rounded-sm text-ui-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
                title="Attach last terminal command & output"
              >
                <Terminal size={12} />
                <span>Last Output</span>
              </button>
            )}
          </div>

          <div className="flex items-center flex-shrink-0">
            {isStreaming ? (
              <button
                type="button"
                onClick={stopGenerating}
                className="p-1 rounded-sm text-vsc-error hover:bg-vsc-item-hover transition-colors"
                title="Stop generating"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className="p-1 rounded-sm text-vsc-accent hover:bg-vsc-item-hover disabled:text-vsc-muted disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
                title="Send (Enter)"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatInput;
