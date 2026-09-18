import React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { X, GitCompare, ChevronRight } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';

const MONACO_DIFF_OPTIONS = {
  readOnly: true,
  renderSideBySide: true,
  fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  fontSize: 12,
  lineHeight: 18,
  minimap: { enabled: true },
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  bracketPairColorization: { enabled: true },
  padding: { top: 8 },
  automaticLayout: true,
};

export function DiffViewer() {
  const diffView = useEditorStore((s) => s.diffView);
  const closeDiffView = useEditorStore((s) => s.closeDiffView);

  if (!diffView || !diffView.open) return null;

  const handleAccept = () => {
    if (typeof diffView.onAccept === 'function') {
      diffView.onAccept(diffView.modified);
    }
    closeDiffView();
  };

  const handleReject = () => {
    if (typeof diffView.onReject === 'function') {
      diffView.onReject();
    }
    closeDiffView();
  };

  return (
    <div className="flex flex-col h-full w-full bg-vsc-editor overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between h-[28px] px-3 bg-vsc-panel border-b border-vsc-border select-none shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 text-ui-sm text-vsc-muted">
          <GitCompare size={14} className="shrink-0" />
          <span className="truncate">Original</span>
          <ChevronRight size={12} className="shrink-0" />
          <span className="truncate text-vsc-fg">{diffView.title || 'Modified'}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleReject}
            className="px-2 py-0.5 rounded-sm text-ui-sm text-vsc-fg hover:bg-vsc-item-hover transition"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={handleAccept}
            className="px-2 py-0.5 rounded-sm text-ui-sm bg-vsc-accent hover:bg-vsc-accent-hover text-vsc-accent-fg transition"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={closeDiffView}
            title="Close"
            className="p-0.5 rounded-sm text-vsc-muted hover:bg-vsc-item-hover hover:text-vsc-fg transition"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Monaco Diff Editor */}
      <div className="flex-1 overflow-hidden">
        <DiffEditor
          height="100%"
          original={diffView.original || ''}
          modified={diffView.modified || ''}
          language="javascript"
          theme="nexterm-dark"
          options={MONACO_DIFF_OPTIONS}
        />
      </div>
    </div>
  );
}

export default DiffViewer;
