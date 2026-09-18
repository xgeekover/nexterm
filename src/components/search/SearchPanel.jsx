import React, { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, Regex, WholeWord } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore.js';
import { invoke } from '../../lib/ipc.js';
import { basename, dirname, relativeTo } from '../../lib/paths.js';
import { cn } from '../../lib/utils.js';

/**
 * Search across the open folder's files.
 *
 * The Explorer's funnel narrows by NAME. This answers the other question —
 * where does this text appear — which until now meant leaving the app for
 * `rg`. The terminal being right there made that cheap, but it still cost you
 * the result being something you can click.
 *
 * The activity bar has had a magnifying glass labelled "Search" since the
 * first release, sitting exactly where VS Code puts this. It opened the
 * command palette. That is the same family as the notifications bell with no
 * handler and the status bar's invented git branch: a control that says one
 * thing and does another. It opens this now.
 *
 * Searching is explicit — Enter, not every keystroke. A grep of a real
 * repository is not something to fire on the `e` of `error`, and an input that
 * silently starts work is how a search box becomes a thing you avoid.
 */
function Toggle({ title, icon: Icon, on, onToggle }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'w-[20px] h-[20px] flex items-center justify-center rounded-[3px] shrink-0',
        on ? 'bg-vsc-item-active text-vsc-fg-bright' : 'text-vsc-muted hover:bg-vsc-item-hover'
      )}
    >
      <Icon size={14} />
    </button>
  );
}

export function SearchPanel() {
  const rootPath = useEditorStore((s) => (s.rootResolved ? s.rootPath : null));
  const openFileAt = useEditorStore((s) => s.openFileAt);

  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setError('');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const found = await invoke('fs_search', {
        query: trimmed,
        case_sensitive: caseSensitive,
        whole_word: wholeWord,
        regex,
      });
      setResults(found);
      setCollapsed(new Set());
    } catch (err) {
      // A bad regex is the common one, and it is the user's to fix — said
      // where they typed it rather than in a console they will not open.
      setResults(null);
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const toggleFile = (path) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!rootPath) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-ui-sm text-vsc-muted select-none">
        <p className="m-0">No folder opened</p>
        <p className="m-0">There is nothing to search until one is.</p>
      </div>
    );
  }

  const files = results?.files ?? [];
  const summary = results
    ? results.total_matches === 0
      ? 'No results'
      : `${results.total_matches} result${results.total_matches === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${results.truncated ? ' (showing the first of them)' : ''}`
    : '';

  return (
    <div className="h-full w-full flex flex-col bg-vsc-sidebar overflow-hidden select-none">
      <div className="px-2 pt-2 pb-1 shrink-0">
        <div className="flex items-center gap-1 px-1 bg-vsc-input border border-vsc-input-border rounded-[2px] focus-within:border-vsc-focus">
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search"
            aria-label="Search across files"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                run();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setQuery('');
                setResults(null);
                setError('');
              }
            }}
            className="flex-1 min-w-0 h-[24px] px-1 bg-transparent text-ui text-vsc-fg outline-none placeholder:text-vsc-placeholder"
          />
          <div className="flex items-center gap-[2px] pr-1">
            <Toggle title="Match Case" icon={CaseSensitive} on={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
            <Toggle title="Match Whole Word" icon={WholeWord} on={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
            <Toggle title="Use Regular Expression" icon={Regex} on={regex} onToggle={() => setRegex((v) => !v)} />
          </div>
        </div>

        <p className="mt-1 mb-0 h-[16px] text-ui-sm text-vsc-muted truncate">
          {busy ? 'Searching…' : error ? <span className="text-vsc-error">{error}</span> : summary || 'Press Enter to search'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {files.map((file) => {
          const isCollapsed = collapsed.has(file.path);
          const relative = relativeTo(rootPath, file.path) || file.path;
          return (
            <div key={file.path}>
              <button
                type="button"
                onClick={() => toggleFile(file.path)}
                title={file.path}
                className="w-full h-[22px] px-1 flex items-center gap-1 text-left text-ui hover:bg-vsc-hover"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="shrink-0 text-vsc-muted" />
                ) : (
                  <ChevronDown size={14} className="shrink-0 text-vsc-muted" />
                )}
                <span className="truncate text-vsc-fg">{basename(file.path)}</span>
                <span className="truncate text-ui-sm text-vsc-muted">{dirname(relative)}</span>
                <span className="ml-auto shrink-0 pr-1 text-ui-sm text-vsc-muted tabular-nums">
                  {file.matches.length}
                  {file.truncated ? '+' : ''}
                </span>
              </button>

              {!isCollapsed &&
                file.matches.map((match) => (
                  <button
                    key={`${file.path}:${match.line}:${match.column}`}
                    type="button"
                    // The whole point of a result being in the app rather than
                    // in `rg`'s output: it is somewhere you can go.
                    onClick={() => openFileAt(file.path, match.line, match.column)}
                    title={`${file.path}:${match.line}:${match.column}`}
                    className="w-full h-[22px] pl-6 pr-2 flex items-center gap-2 text-left hover:bg-vsc-hover"
                  >
                    <span className="shrink-0 text-ui-sm text-vsc-muted tabular-nums w-[36px] text-right">
                      {match.line}
                    </span>
                    <span className="truncate text-ui font-mono text-vsc-fg">{match.text.trim()}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SearchPanel;
