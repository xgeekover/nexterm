import React from 'react';
import Editor from '@monaco-editor/react';
import { Code2, ChevronRight } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { EditorTabs } from './EditorTabs.jsx';
import { DiffViewer } from './DiffViewer.jsx';
import { cn } from '../../lib/utils.js';
import { chord } from '../../lib/platform.js';

const MONACO_OPTIONS = {
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

const WATERMARK_SHORTCUTS = [
  ['Show All Commands', chord('mod', 'k')],
  ['Open File', chord('mod', 'p')],
  ['Toggle Terminal', chord('ctrl', '`')],
  ['New Terminal', chord('ctrl', 'shift', '`')],
];

function Kbd({ children }) {
  return (
    <kbd className="bg-vsc-button-secondary border border-vsc-border rounded-sm px-1.5 py-0.5 font-mono text-ui-sm">
      {children}
    </kbd>
  );
}

export function EditorPanel() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const editBuffer = useEditorStore((s) => s.editBuffer);
  const saveFile = useEditorStore((s) => s.saveFile);
  const diffView = useEditorStore((s) => s.diffView);
  const rootPath = useEditorStore((s) => s.rootPath);
  const monacoTheme = useSettingsStore((s) => s.monacoTheme);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  if (diffView && diffView.open) {
    return <DiffViewer />;
  }

  // Breadcrumb segments = file path relative to the workspace root.
  let relativePath = '';
  if (activeTab) {
    const base = (rootPath || '').replace(/\/+$/, '');
    relativePath = base && activeTab.filePath.startsWith(base)
      ? activeTab.filePath.slice(base.length)
      : activeTab.filePath;
    relativePath = relativePath.replace(/^\/+/, '');
  }
  const segments = relativePath ? relativePath.split('/').filter(Boolean) : [];

  return (
    <div className="flex flex-col h-full w-full bg-vsc-editor overflow-hidden">
      <EditorTabs />

      {activeTab ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Breadcrumb row */}
          <div className="flex items-center justify-between h-[22px] px-3 border-b border-vsc-border bg-vsc-editor text-ui-sm text-vsc-muted select-none shrink-0">
            <div className="flex items-center gap-1 min-w-0 overflow-hidden">
              {segments.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ChevronRight size={12} className="shrink-0" />}
                  <span className={cn('truncate', i === segments.length - 1 && 'text-vsc-fg')}>
                    {seg}
                  </span>
                </React.Fragment>
              ))}
            </div>

            {activeTab.isDirty && (
              <button
                type="button"
                onClick={() => saveFile(activeTab.id)}
                className="shrink-0 ml-2 text-vsc-link hover:underline"
                title={`Save (${chord('mod', 's')})`}
              >
                Save
              </button>
            )}
          </div>

          {/* Monaco Editor */}
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language={activeTab.language || 'javascript'}
              theme={monacoTheme}
              value={activeTab.content}
              onChange={(value) => editBuffer(activeTab.id, value ?? '')}
              options={MONACO_OPTIONS}
            />
          </div>
        </div>
      ) : (
        /* Empty state — VS Code watermark */
        <div className="flex-1 flex flex-col items-center justify-center select-none">
          <Code2 size={96} className="text-vsc-border mb-6" />
          <table className="text-vsc-muted text-ui">
            <tbody>
              {WATERMARK_SHORTCUTS.map(([label, keys]) => (
                <tr key={label}>
                  <td className="pr-3 py-1 text-right">{label}</td>
                  <td className="py-1">
                    <Kbd>{keys}</Kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default EditorPanel;
