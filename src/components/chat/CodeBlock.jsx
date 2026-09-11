import React, { useState } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';

export function CodeBlock({ language = 'plaintext', value = '' }) {
  const [copied, setCopied] = useState(false);
  const executeCommand = useTerminalStore((s) => s.executeCommand);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRunInTerminal = () => {
    setActiveView('terminal');
    executeCommand(value.trim());
  };

  const isShell = ['bash', 'sh', 'zsh', 'shell'].includes(language?.toLowerCase());

  return (
    <div className="my-2 bg-vsc-editor border border-vsc-border rounded-[3px] overflow-hidden">
      {/* CodeBlock Header */}
      <div className="flex items-center justify-between h-[26px] px-2.5 bg-vsc-panel border-b border-vsc-border select-none">
        <span className="font-mono text-ui-sm text-vsc-muted uppercase tracking-wide">
          {language}
        </span>

        <div className="flex items-center gap-0.5">
          {isShell && (
            <button
              type="button"
              onClick={handleRunInTerminal}
              className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
              title="Run in Terminal"
            >
              <Terminal size={14} />
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover transition-colors"
            title="Copy Code"
          >
            {copied ? <Check size={14} className="text-vsc-ok" /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {/* Code Body */}
      <pre className="p-3 overflow-x-auto font-mono text-code text-vsc-fg select-text">
        <code>{value}</code>
      </pre>
    </div>
  );
}

export default CodeBlock;
