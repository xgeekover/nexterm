import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode2,
  FileJson,
  FileText,
  File,
  Trash2,
} from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { cn } from '../../lib/utils.js';

const INDENT_SIZE = 8; // px per depth level
const ROW_PADDING = 4; // px base gutter before the guides/chevron start

function getFileIcon(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const className = 'text-vsc-muted shrink-0';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return <FileCode2 size={16} className={className} />;
    case 'json':
      return <FileJson size={16} className={className} />;
    case 'md':
    case 'txt':
      return <FileText size={16} className={className} />;
    default:
      return <File size={16} className={className} />;
  }
}

export function FileTreeNode({ node, depth = 0, allNodes = [] }) {
  const expandedFolders = useEditorStore((s) => s.expandedFolders);
  const toggleFolder = useEditorStore((s) => s.toggleFolder);
  const openFile = useEditorStore((s) => s.openFile);
  const deletePath = useEditorStore((s) => s.deletePath);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const tabs = useEditorStore((s) => s.tabs);

  const isFolder = Boolean(node.is_dir);
  const isExpanded = expandedFolders.has(node.path);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isSelected = activeTab?.filePath === node.path;

  // Find children if node is folder
  const children = isFolder
    ? allNodes.filter((n) => {
        if (n.path === node.path) return false;
        if (!n.path.startsWith(node.path + '/')) return false;
        const relative = n.path.slice(node.path.length + 1);
        return !relative.includes('/');
      })
    : [];

  const openOrToggle = () => {
    if (isFolder) {
      toggleFolder(node.path);
    } else {
      openFile(node.path);
    }
  };

  const handleClick = (e) => {
    e.stopPropagation();
    openOrToggle();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openOrToggle();
    } else if (e.key === 'ArrowRight') {
      if (isFolder && !isExpanded) {
        e.preventDefault();
        toggleFolder(node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      if (isFolder && isExpanded) {
        e.preventDefault();
        toggleFolder(node.path);
      }
    }
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (confirm(`Delete ${node.name}?`)) {
      deletePath(node.path, isFolder);
    }
  };

  const paddingLeft = depth * INDENT_SIZE + ROW_PADDING;

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-selected={isSelected}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        style={{ paddingLeft: `${paddingLeft}px` }}
        className={cn(
          'group relative flex items-center gap-1 h-[22px] pr-2 text-ui cursor-pointer',
          isSelected
            ? 'bg-vsc-selection text-vsc-selection-fg'
            : 'text-vsc-fg hover:bg-vsc-hover'
        )}
      >
        {/* Indent guides — one per ancestor level */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="absolute top-0 bottom-0 border-l border-vsc-indent-guide pointer-events-none"
            style={{ left: `${ROW_PADDING + i * INDENT_SIZE + 4}px` }}
          />
        ))}

        {isFolder ? (
          isExpanded ? (
            <ChevronDown size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-vsc-muted shrink-0" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {isFolder ? (
          isExpanded ? (
            <FolderOpen size={16} className="text-vsc-muted shrink-0" />
          ) : (
            <Folder size={16} className="text-vsc-muted shrink-0" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        <span className="truncate flex-1 min-w-0 text-ui">{node.name}</span>

        <button
          type="button"
          onClick={handleDelete}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-error hover:bg-vsc-item-hover transition shrink-0"
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {isFolder && isExpanded && (
        <div role="group">
          {children.length > 0 ? (
            children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                allNodes={allNodes}
              />
            ))
          ) : (
            <div
              style={{ paddingLeft: `${(depth + 1) * INDENT_SIZE + ROW_PADDING + 20}px` }}
              className="h-[22px] flex items-center text-ui-sm text-vsc-muted italic"
            >
              Empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default FileTreeNode;
