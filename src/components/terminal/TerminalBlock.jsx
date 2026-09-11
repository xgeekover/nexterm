import React, { useState } from 'react';
import {
  Check,
  XCircle,
  Clock,
  Copy,
  Pin,
  Sparkles,
  ChevronDown,
  ChevronRight,
  RotateCw,
  Terminal as TermIcon,
  CheckCheck,
  Folder,
  GitBranch,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { AnsiText } from '../../lib/ansiParser.js';
import { formatDuration, formatTimestamp, cn } from '../../lib/utils.js';

const MAX_VISIBLE_LINES = 200;

const toolbarBtn =
  'p-1 rounded text-vsc-muted hover:text-vsc-fg-bright hover:bg-vsc-item-hover transition-colors';

export function TerminalBlock({ block, tabId = null, selected = false, onSelect = null }) {
  const pinBlock = useTerminalStore((s) => s.pinBlock);
  const executeCommand = useTerminalStore((s) => s.executeCommand);
  const attachContext = useChatStore((s) => s.attachContext);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setActiveView = useSettingsStore((s) => s.setActiveView);

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showAllLines, setShowAllLines] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);

  const isRunning = block.status === 'running';
  const isFailed = block.status === 'failed' || (block.exitCode !== null && block.exitCode !== 0);
  const isSuccess = block.status === 'completed' && block.exitCode === 0;

  const outputLines = block.output ? block.output.split('\n') : [];
  const totalLines = outputLines.length;
  const isLongOutput = totalLines > MAX_VISIBLE_LINES;
  const visibleOutput =
    isLongOutput && !showAllLines ? outputLines.slice(0, MAX_VISIBLE_LINES).join('\n') : block.output;

  const formattedCwd = (block.cwd || '').replace('/workspace', '~/workspace');

  const stopAnd = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(block.command);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyOutput = () => {
    navigator.clipboard.writeText(block.output || '');
    setCopiedOut(true);
    setTimeout(() => setCopiedOut(false), 2000);
  };

  const handleRerun = () => {
    executeCommand(block.command, tabId);
  };

  const handleExplainWithAI = () => {
    attachContext({
      title: `Terminal Error: ${block.command}`,
      content: `Command: ${block.command}\nExit Code: ${block.exitCode}\nOutput:\n${block.output}`,
    });
    setActiveView('chat');
    sendMessage('agent-architect-01', `Explain this terminal error and propose a concrete fix:\n${block.command}`);
  };

  return (
    <div
      onClick={() => onSelect?.(block.id)}
      className={cn(
        'group relative border-l-2 border-b border-b-vsc-border pl-3 pr-2 py-2 cursor-default transition-colors',
        selected && 'bg-vsc-inactive-selection',
        isRunning && 'border-l-vsc-info',
        isSuccess && 'border-l-vsc-ok',
        isFailed && 'border-l-vsc-error',
        !isRunning && !isSuccess && !isFailed && 'border-l-vsc-border'
      )}
    >
      {/* Header line: prompt chips + command */}
      <div className="flex items-center gap-2 min-w-0 text-ui-sm select-none">
        <button
          type="button"
          onClick={stopAnd(() => setIsCollapsed((c) => !c))}
          className={toolbarBtn}
          title={isCollapsed ? 'Expand block' : 'Collapse block'}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        {formattedCwd && (
          <span className="inline-flex items-center gap-1 px-1.5 rounded-sm bg-vsc-button-secondary text-vsc-fg font-mono text-ui-sm shrink-0">
            <Folder size={12} className="text-vsc-info" />
            <span className="truncate max-w-[140px]">{formattedCwd}</span>
          </span>
        )}

        <span className="inline-flex items-center gap-1 px-1.5 rounded-sm bg-vsc-button-secondary text-vsc-git-added font-mono text-ui-sm shrink-0">
          <GitBranch size={12} />
          <span>main</span>
        </span>

        <span className="font-mono text-code text-vsc-fg-bright truncate min-w-0">{block.command}</span>

        <div className="flex-1" />

        {/* Status / metadata */}
        {isRunning && (
          <span className="w-1.5 h-1.5 rounded-full bg-vsc-info animate-pulse shrink-0" title="Running" />
        )}
        {isSuccess && <Check size={14} className="text-vsc-ok shrink-0" />}
        {isFailed && (
          <span className="inline-flex items-center gap-1 text-ui-sm text-vsc-error shrink-0">
            <XCircle size={12} />
            Exit {block.exitCode ?? 1}
          </span>
        )}
        {block.durationMs > 0 && (
          <span className="hidden sm:inline-flex items-center gap-1 text-ui-sm text-vsc-muted font-mono shrink-0">
            <Clock size={12} />
            {formatDuration(block.durationMs / 1000)}
          </span>
        )}
        <span className="hidden md:inline text-ui-sm text-vsc-muted shrink-0">
          {formatTimestamp(block.startTime)}
        </span>

        {isFailed && (
          <button
            type="button"
            onClick={stopAnd(handleExplainWithAI)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-vsc-info hover:bg-vsc-item-hover text-ui-sm shrink-0"
            title="Explain error with AI"
          >
            <Sparkles size={12} />
            <span className="hidden lg:inline">Explain</span>
          </button>
        )}

        {/* Hover toolbar */}
        <div className="hidden group-hover:flex items-center gap-0.5 pl-1 border-l border-vsc-border shrink-0">
          <button type="button" onClick={stopAnd(handleCopyCommand)} className={toolbarBtn} title="Copy command">
            {copiedCmd ? <CheckCheck size={14} className="text-vsc-ok" /> : <TermIcon size={14} />}
          </button>
          <button type="button" onClick={stopAnd(handleCopyOutput)} className={toolbarBtn} title="Copy output">
            {copiedOut ? <CheckCheck size={14} className="text-vsc-ok" /> : <Copy size={14} />}
          </button>
          <button type="button" onClick={stopAnd(handleRerun)} className={toolbarBtn} title="Re-run command">
            <RotateCw size={14} />
          </button>
          <button
            type="button"
            onClick={stopAnd(() => pinBlock(block.id))}
            className={cn(toolbarBtn, block.pinned && 'text-vsc-warn')}
            title={block.pinned ? 'Unpin block' : 'Pin block'}
          >
            <Pin size={14} className={block.pinned ? 'fill-current' : undefined} />
          </button>
        </div>
      </div>

      {/* Output */}
      {!isCollapsed && (
        <div className="mt-1 pl-6 overflow-x-auto">
          {block.output ? (
            <>
              <AnsiText text={visibleOutput} className="text-vsc-fg" />
              {isLongOutput && !showAllLines && (
                <button
                  type="button"
                  onClick={stopAnd(() => setShowAllLines(true))}
                  className="mt-1 text-ui-sm text-vsc-link hover:underline"
                >
                  Show all {totalLines} lines
                </button>
              )}
            </>
          ) : isRunning ? (
            <div className="flex items-center gap-2 text-vsc-muted italic py-1 text-code font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-vsc-info animate-pulse" />
              Executing command...
            </div>
          ) : (
            <span className="text-vsc-muted italic text-code font-mono">No output</span>
          )}
        </div>
      )}
    </div>
  );
}

export default TerminalBlock;
