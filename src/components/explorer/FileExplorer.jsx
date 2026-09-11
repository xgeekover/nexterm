import React, { useState, useEffect } from 'react';
import {
  FolderPlus,
  FolderOpen,
  FilePlus,
  RefreshCw,
  ChevronsDownUp,
  ChevronDown,
  ChevronRight,
  Check,
  X,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { FileTreeNode } from './FileTreeNode.jsx';

export function FileExplorer() {
  const fileTree = useEditorStore((s) => s.fileTree);
  const isLoadingTree = useEditorStore((s) => s.isLoadingTree);
  const refreshExplorer = useEditorStore((s) => s.refreshExplorer);
  const rootPath = useEditorStore((s) => s.rootPath);
  const pickRoot = useEditorStore((s) => s.pickRoot);
  const createFile = useEditorStore((s) => s.createFile);
  const createFolder = useEditorStore((s) => s.createFolder);
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const toggleFolder = useEditorStore((s) => s.toggleFolder);

  const [creatingType, setCreatingType] = useState(null); // 'file' | 'folder' | null
  const [newItemName, setNewItemName] = useState('');
  const [rootExpanded, setRootExpanded] = useState(true);

  useEffect(() => {
    refreshExplorer();
  }, [refreshExplorer]);

  const handleCreateSubmit = async (e) => {
    e?.preventDefault();
    const trimmed = newItemName.trim();
    if (!trimmed) {
      setCreatingType(null);
      return;
    }

    const base = rootPath.replace(/\/+$/, '');
    const fullPath = `${base}/${trimmed.replace(/^\/+/, '')}`;
    try {
      if (creatingType === 'file') {
        await createFile(fullPath);
      } else if (creatingType === 'folder') {
        await createFolder(fullPath);
      }
      setNewItemName('');
      setCreatingType(null);
    } catch (err) {
      alert(`Error creating ${creatingType}: ${err.message}`);
    }
  };

  const handleCollapseAll = () => {
    Array.from(expandedFolders).forEach((path) => toggleFolder(path));
  };

  if (!rootPath) {
    return (
      <div className="flex flex-col h-full w-full bg-vsc-sidebar select-none overflow-hidden">
        <div className="h-[35px] flex items-center px-4 shrink-0">
          <span className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
            Explorer
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-ui-sm text-vsc-muted">No folder opened</p>
          <button
            type="button"
            onClick={() => pickRoot()}
            className="px-3 py-1 rounded-sm text-ui-sm bg-vsc-accent hover:bg-vsc-accent-hover text-vsc-accent-fg transition"
          >
            Open Folder
          </button>
        </div>
      </div>
    );
  }

  // Find root nodes (direct children of the workspace root)
  const rootPrefix = rootPath.replace(/\/+$/, '') + '/';
  const rootNodes = fileTree.filter((n) => {
    if (n.path === rootPath) return false;
    if (!n.path.startsWith(rootPrefix)) return false;
    return !n.path.slice(rootPrefix.length).includes('/');
  });

  const rootName = rootPath.replace(/\/+$/, '').split('/').filter(Boolean).pop() || rootPath;

  return (
    <div className="group flex flex-col h-full w-full bg-vsc-sidebar select-none overflow-hidden">
      {/* Section header */}
      <div className="h-[35px] flex items-center px-4 shrink-0">
        <span className="text-ui-sm uppercase tracking-wide text-vsc-fg font-semibold">
          Explorer
        </span>
      </div>

      {/* Folder header row */}
      <div className="h-[22px] flex items-center justify-between pl-2 pr-1 shrink-0">
        <button
          type="button"
          onClick={() => setRootExpanded((v) => !v)}
          className="flex items-center gap-1 min-w-0 text-ui-sm font-semibold text-vsc-fg hover:text-vsc-fg-bright"
        >
          {rootExpanded ? (
            <ChevronDown size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-vsc-muted shrink-0" />
          )}
          <span className="truncate uppercase">{rootName}</span>
        </button>

        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            onClick={() => pickRoot()}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title={`Open Folder… (current: ${rootPath})`}
          >
            <FolderOpen size={16} />
          </button>

          <button
            type="button"
            onClick={() => {
              setCreatingType('file');
              setNewItemName('');
            }}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="New File"
          >
            <FilePlus size={16} />
          </button>

          <button
            type="button"
            onClick={() => {
              setCreatingType('folder');
              setNewItemName('');
            }}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="New Folder"
          >
            <FolderPlus size={16} />
          </button>

          <button
            type="button"
            onClick={() => refreshExplorer()}
            disabled={isLoadingTree}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition disabled:opacity-50"
            title="Refresh Explorer"
          >
            <RefreshCw size={16} className={isLoadingTree ? 'animate-spin' : ''} />
          </button>

          <button
            type="button"
            onClick={handleCollapseAll}
            className="p-1 rounded-sm hover:bg-vsc-item-hover text-vsc-muted hover:text-vsc-fg transition"
            title="Collapse All"
          >
            <ChevronsDownUp size={16} />
          </button>
        </div>
      </div>

      {/* Inline Creation Input */}
      {creatingType && (
        <form onSubmit={handleCreateSubmit} className="px-2 py-1 border-b border-vsc-border shrink-0">
          <div className="flex items-center gap-1 bg-vsc-input border border-vsc-focus rounded-sm px-2 py-1">
            <span className="text-ui-sm font-mono text-vsc-muted">/</span>
            <input
              type="text"
              autoFocus
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={`New ${creatingType} name…`}
              className="flex-1 bg-transparent border-none outline-none font-mono text-ui-sm text-vsc-fg placeholder-vsc-placeholder"
            />
            <button type="submit" className="text-vsc-ok hover:text-vsc-fg p-0.5">
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCreatingType(null)}
              className="text-vsc-muted hover:text-vsc-error p-0.5"
            >
              <X size={14} />
            </button>
          </div>
        </form>
      )}

      {/* Directory Tree */}
      {rootExpanded && (
        <div className="flex-1 overflow-y-auto">
          {rootNodes.length > 0 ? (
            rootNodes.map((node) => (
              <FileTreeNode key={node.path} node={node} depth={0} allNodes={fileTree} />
            ))
          ) : (
            <div className="px-4 py-3 text-center text-vsc-muted text-ui-sm italic">
              {isLoadingTree ? 'Loading files…' : 'No files found'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default FileExplorer;
