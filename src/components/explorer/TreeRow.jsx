import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { fileIconFor, folderIconFor } from './fileIcons.jsx';

/** VS Code's own geometry: 22px rows, 8px per level, a 16px twisty gutter. */
export const ROW_HEIGHT = 22;
export const INDENT_SIZE = 8;
export const BASE_PADDING = 8;
const TWISTY_WIDTH = 16;

/** Where a row's content starts, given its depth. */
export function indentFor(depth) {
  return BASE_PADDING + depth * INDENT_SIZE;
}

/** Inline editor for renaming, or for naming something new. */
export function NameInput({ initialValue = '', placeholder, onCommit, onCancel, selectBase }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // VS Code selects only the base name, so typing replaces "App" and keeps
    // ".jsx" — renaming a file is usually about the name, not the extension.
    const dot = selectBase ? initialValue.lastIndexOf('.') : -1;
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initialValue, selectBase]);

  const commit = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialValue) {
      onCancel();
      return;
    }
    try {
      await onCommit(trimmed);
      onCancel();
    } catch (err) {
      setError(err?.message || 'Failed');
    }
  };

  return (
    <div className="flex-1 min-w-0 flex items-center gap-1">
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onBlur={commit}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className={cn(
          'flex-1 min-w-0 h-[19px] bg-vsc-input border rounded-[2px] px-1 text-ui text-vsc-fg outline-none',
          error ? 'border-vsc-error' : 'border-vsc-focus'
        )}
      />
      {error && <span className="text-ui-sm text-vsc-error truncate shrink-0 pr-1">{error}</span>}
    </div>
  );
}

/**
 * One row of the explorer tree.
 *
 * Deliberately has no buttons of its own. VS Code puts every action in the
 * context menu and the section header; a delete button that appeared on hover
 * over every row sat exactly where the mouse lands on the way to a file, and
 * nothing else in the app looks like that.
 */
/**
 * The colour git's status gives a name, and the letter beside it.
 *
 * The `--vsc-git-*` tokens have been in the stylesheet and in the Tailwind
 * config since the first release, used by nothing — this is what they were
 * for. The letter matters as much as the colour: green for added and green for
 * untracked are the same green in VS Code too, and on a monochrome display or
 * to anyone who cannot tell those greens apart the row would say nothing at
 * all without it.
 */
const GIT_DECORATION = {
  modified: { className: 'text-vsc-git-modified', mark: 'M' },
  added: { className: 'text-vsc-git-added', mark: 'A' },
  deleted: { className: 'text-vsc-git-deleted', mark: 'D' },
  renamed: { className: 'text-vsc-git-modified', mark: 'R' },
  untracked: { className: 'text-vsc-git-untracked', mark: 'U' },
  conflicted: { className: 'text-vsc-git-deleted', mark: '!' },
};

export function TreeRow({
  row,
  gitStatus,
  isSelected,
  isFocused,
  isCut,
  onActivate,
  onToggle,
  onContextMenu,
  renaming,
  onRenameCommit,
  onRenameCancel,
}) {
  const { node, depth, isFolder, isExpanded } = row;
  const decoration = gitStatus ? GIT_DECORATION[gitStatus.status] ?? null : null;
  const paddingLeft = indentFor(depth);

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isFolder ? isExpanded : undefined}
      aria-selected={isSelected}
      data-path={node.path}
      onMouseDown={(e) => {
        // Left button only; the context menu handles the right one.
        if (e.button === 0) onActivate(row, e);
      }}
      onContextMenu={(e) => onContextMenu(e, row)}
      style={{ paddingLeft, height: ROW_HEIGHT }}
      className={cn(
        'relative flex items-center gap-1 pr-2 text-ui cursor-pointer whitespace-nowrap',
        isSelected
          ? isFocused
            ? 'bg-vsc-selection text-vsc-selection-fg'
            : 'bg-vsc-inactive-selection text-vsc-fg'
          : 'text-vsc-fg hover:bg-vsc-hover',
        isCut && 'opacity-50'
      )}
    >
      {/* Indent guides, one per ancestor level */}
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-vsc-indent-guide pointer-events-none"
          style={{ left: indentFor(i) + TWISTY_WIDTH / 2 }}
        />
      ))}

      {/* Twisty: only folders get one, but files reserve the space so every
          name in a folder lines up. */}
      <span
        className="shrink-0 flex items-center justify-center"
        style={{ width: TWISTY_WIDTH }}
        onMouseDown={(e) => {
          if (!isFolder) return;
          e.stopPropagation();
          e.preventDefault();
          onToggle(row);
        }}
      >
        {isFolder &&
          (isExpanded ? (
            <ChevronDown size={16} className="text-vsc-muted" />
          ) : (
            <ChevronRight size={16} className="text-vsc-muted" />
          ))}
      </span>

      <span className="shrink-0 flex items-center">
        {isFolder ? folderIconFor(node.name, isExpanded) : fileIconFor(node.name)}
      </span>

      {renaming ? (
        <NameInput
          initialValue={node.name}
          selectBase={!isFolder}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <>
          <span className={cn('truncate min-w-0', decoration?.className)}>{node.name}</span>
          {decoration && (
            <span
              title={gitStatus.staged ? `${gitStatus.status}, staged` : gitStatus.status}
              className={cn('ml-auto shrink-0 pl-1 text-ui-sm font-mono', decoration.className)}
            >
              {decoration.mark}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default TreeRow;
