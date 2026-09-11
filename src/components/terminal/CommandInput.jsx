import React, { useState, useRef, useEffect } from 'react';
import { GitBranch, Trash2, Folder } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';

export function CommandInput({ onExecute, onNavigateBlock = null }) {
  const cwd = useTerminalStore((s) => s.cwd);
  const history = useTerminalStore((s) => s.history);
  const clearBlocks = useTerminalStore((s) => s.clearBlocks);

  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef(null);

  useEffect(() => {
    // Focus input on mount
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && input.trim() === '') {
      if (onNavigateBlock) {
        e.preventDefault();
        onNavigateBlock(e.key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = input.trim();
      if (trimmed) {
        onExecute(trimmed);
        setInput('');
        setHistoryIndex(-1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIdx);
      setInput(history[nextIdx] || '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const nextIdx = historyIndex + 1;
      if (nextIdx >= history.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(nextIdx);
        setInput(history[nextIdx] || '');
      }
    }
  };

  const formattedCwd = cwd.replace('/workspace', '~/workspace');

  return (
    <div className="px-2 py-1.5 bg-vsc-panel border-t border-vsc-border select-none">
      <div className="flex items-center gap-2 rounded-sm bg-vsc-input border border-vsc-input-border px-2 py-1 focus-within:border-vsc-focus transition-colors">
        {/* CWD chip */}
        <div className="flex items-center gap-1 px-1.5 rounded-sm bg-vsc-button-secondary text-vsc-fg text-ui-sm font-mono shrink-0">
          <Folder size={12} className="text-vsc-info" />
          <span className="truncate max-w-[140px]">{formattedCwd}</span>
        </div>

        {/* Branch chip */}
        <div className="hidden sm:flex items-center gap-1 px-1.5 rounded-sm bg-vsc-button-secondary text-vsc-git-added text-ui-sm font-mono shrink-0">
          <GitBranch size={12} />
          <span>main</span>
        </div>

        {/* Command Input Field */}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a shell command..."
          className="flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-code text-vsc-fg placeholder:text-vsc-placeholder"
          spellCheck={false}
          autoComplete="off"
        />

        {/* Right actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => clearBlocks()}
            className="p-1 rounded text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors"
            title="Clear unpinned blocks (⌘L)"
          >
            <Trash2 size={14} />
          </button>

          <kbd
            className="px-1.5 py-0.5 rounded-sm bg-vsc-button-secondary text-vsc-muted font-mono text-ui-sm"
            title="Run"
          >
            ↵
          </kbd>
        </div>
      </div>
    </div>
  );
}

export default CommandInput;
