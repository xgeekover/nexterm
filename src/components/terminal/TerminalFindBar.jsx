import React, { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { searchInTerminal, clearTerminalSearch } from './terminalRegistry.js';
import { cn } from '../../lib/utils.js';

/**
 * Find, over a terminal's scrollback.
 *
 * The buffer is 5000 lines deep by default and until now there was no way to
 * look through it at all — a build log scrolled past was gone unless you could
 * find it by eye. xterm's search addon does the matching; this is the bar, and
 * the rules it follows are the ones every editor's find bar follows, because
 * anything else would surprise:
 *
 *   - typing searches incrementally (the selection grows while it still
 *     matches, rather than jumping to the next occurrence per keystroke)
 *   - Enter is next, Shift+Enter is previous, Escape closes and hands focus
 *     back to the terminal
 *   - the query survives a close, so reopening and pressing Enter repeats it
 *
 * It renders inside the focused pane rather than over the window, so in a
 * split it is obvious WHICH terminal is being searched.
 */
/**
 * One of the three search options.
 *
 * Declared here rather than inside `TerminalFindBar` on purpose. Inline, React
 * sees a new component type on every parent render and remounts the button —
 * and a real click is mousedown plus mouseup ON THE SAME ELEMENT, so every
 * click landed on an element that no longer existed by the time the mouse came
 * up. The buttons rendered perfectly and did nothing; `.click()` from a script
 * still worked, which is exactly why no test caught it.
 */
function FindToggle({ title, icon: Icon, on, onToggle }) {
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

export function TerminalFindBar({ tabId, onClose }) {
  const inputRef = useRef(null);
  const find = useTerminalStore((s) => s.find);
  const setFindQuery = useTerminalStore((s) => s.setFindQuery);
  const toggleFindOption = useTerminalStore((s) => s.toggleFindOption);

  const { query, caseSensitive, wholeWord, regex, resultIndex, resultCount } = find;

  // Select whatever is there on open, so a second ⌘F replaces the old query by
  // typing instead of making the user clear it first.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [tabId]);

  // Re-run as the query or the options change. Incremental so that typing
  // `err` does not walk three matches forward on the way.
  useEffect(() => {
    if (!query) {
      clearTerminalSearch(tabId);
      return;
    }
    searchInTerminal(tabId, query, {
      direction: 'incremental',
      caseSensitive,
      wholeWord,
      regex,
    });
  }, [tabId, query, caseSensitive, wholeWord, regex]);

  const step = (direction) => {
    if (!query) return;
    searchInTerminal(tabId, query, { direction, caseSensitive, wholeWord, regex });
  };

  const onKeyDown = (e) => {
    // This bar is a text field inside a terminal pane. Every key it handles is
    // stopped here so neither xterm's capture handler nor the window's
    // keybindings see it — Escape especially, which would otherwise also be
    // read as "dismiss whatever is on screen".
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      step(e.shiftKey ? 'previous' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    }
  };

  // -1 is xterm's "more matches than it will count" answer, not a position.
  const countLabel = resultCount === 0
    ? (query ? 'No results' : '')
    : resultIndex < 0
      ? `${resultCount} results`
      : `${resultIndex + 1} of ${resultCount}`;

  return (
    <div
      role="search"
      aria-label="Find in terminal"
      // Clicking the bar must not be read as "focus this pane's terminal",
      // which would take the caret out of the field on every click.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      className="absolute top-0 right-0 z-20 m-1 flex items-center gap-1 px-1 py-1 bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px]"
    >
      <div className="flex items-center bg-vsc-input border border-vsc-input-border rounded-[2px] focus-within:border-vsc-focus">
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          onChange={(e) => setFindQuery(e.target.value)}
          className="w-[180px] h-[22px] px-2 bg-transparent text-vsc-fg text-ui outline-none placeholder:text-vsc-placeholder"
        />
        <div className="flex items-center gap-[2px] pr-1">
          <FindToggle
            title="Match Case"
            icon={CaseSensitive}
            on={caseSensitive}
            onToggle={() => toggleFindOption('caseSensitive')}
          />
          <FindToggle
            title="Match Whole Word"
            icon={WholeWord}
            on={wholeWord}
            onToggle={() => toggleFindOption('wholeWord')}
          />
          <FindToggle
            title="Use Regular Expression"
            icon={Regex}
            on={regex}
            onToggle={() => toggleFindOption('regex')}
          />
        </div>
      </div>

      <span
        data-find-count
        className={cn(
          'min-w-[68px] px-1 text-ui-sm tabular-nums truncate',
          resultCount === 0 && query ? 'text-vsc-error' : 'text-vsc-muted'
        )}
      >
        {countLabel}
      </span>

      <button
        type="button"
        title="Previous Match (Shift+Enter)"
        aria-label="Previous match"
        disabled={!query}
        onClick={() => step('previous')}
        className="w-[22px] h-[22px] flex items-center justify-center rounded-[3px] text-vsc-fg hover:bg-vsc-item-hover disabled:text-vsc-muted disabled:hover:bg-transparent"
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        title="Next Match (Enter)"
        aria-label="Next match"
        disabled={!query}
        onClick={() => step('next')}
        className="w-[22px] h-[22px] flex items-center justify-center rounded-[3px] text-vsc-fg hover:bg-vsc-item-hover disabled:text-vsc-muted disabled:hover:bg-transparent"
      >
        <ArrowDown size={14} />
      </button>
      <button
        type="button"
        title="Close (Escape)"
        aria-label="Close find"
        onClick={() => onClose?.()}
        className="w-[22px] h-[22px] flex items-center justify-center rounded-[3px] text-vsc-fg hover:bg-vsc-item-hover"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default TerminalFindBar;
