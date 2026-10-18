import React, { memo, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  BellRing,
  ChartPie,
  CircleAlert,
  CirclePause,
  CirclePlay,
  CircleStop,
  CircleX,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { folderForBranch, useFolderBranch } from '../../stores/branchStore.js';
import { unreadCountByTab } from '../../lib/attention.js';
import {
  agentLabel,
  branchLabel,
  branchTitle,
  groupSummaryItems,
  groupSummaryLabel,
  noteLine,
  noteTooltip,
  statusText,
  terminalStatus,
} from '../../lib/terminalStatus.js';
import {
  agentFits,
  compactStatusText,
  lastNoteOf,
  secondaryText,
  summaryCounts,
  summaryWords,
} from './statusBoardModel.js';
import { cn } from '../../lib/utils.js';

/**
 * The TERMINALS side bar's status board, drawn: each terminal's second line
 * (its agent and state, its branch, the last thing it told you), each
 * group's summary, and the ranks the side bar is sorted by when it is sorted
 * by attention. What any of it MEANS is decided in src/lib/terminalStatus.js;
 * what each piece listens to, and why so narrowly, is statusBoardModel.js.
 * This file exports components only (Fast Refresh, see that file).
 *
 * Every component is declared at module level (a component declared inside
 * another's render is a new type every render, and React remounts it).
 */

// ---- Icons and colour, which never say anything on their own ----------------------

/**
 * The icon of each state on a second line, and its colour. Icons rather than
 * the characters of `STATUS_GLYPHS`: at the line's 11px a dotted ring (◌)
 * was a 3px smudge and a small triangle (▸) a speck. Only the icon is
 * coloured; the word beside it says the same thing to whoever cannot tell
 * the colours apart, to a screen reader, and in forced colours, which
 * repaints all of it (an icon is drawn in `currentColor`, so it survives).
 * `info`'s blue rather than `accent`'s for the busy states: the accent is the
 * selection's own hue and all but vanishes on the active row.
 */
const STATE_ICON = Object.freeze({
  waiting: [BellRing, 'text-vsc-attention'],
  error: [CircleAlert, 'text-vsc-error'],
  failed: [CircleX, 'text-vsc-error'],
  progress: [ChartPie, 'text-vsc-info'],
  paused: [CirclePause, 'text-vsc-warn'],
  working: [LoaderCircle, 'text-vsc-info'],
  running: [CirclePlay, 'text-vsc-info'],
  exited: [CircleStop, 'text-vsc-muted'],
});

/** `[Icon, colour]` for a status (`terminalStatus`'s), a paused bar being its own. */
const iconOf = (status) => STATE_ICON[status.paused ? 'paused' : status.state] ?? null;


// ---- A terminal's second line ---------------------------------------------------

/** Read out between two items of the line, which are drawn apart by a gap alone. */
const Pause = () => <span className="sr-only">, </span>;

const measureCanvas = { ctx: null };

/** How wide `text` is in the font `el` draws in, in CSS pixels. */
function textWidth(el, text) {
  if (!measureCanvas.ctx) measureCanvas.ctx = document.createElement('canvas').getContext('2d');
  const ctx = measureCanvas.ctx;
  if (!ctx) return Infinity;
  const style = getComputedStyle(el);
  ctx.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  // A pixel of slack for the difference between canvas and layout metrics.
  return ctx.measureText(text).width + 1;
}

/**
 * Whether the agent's name `agent` fits whole on the second line `lineRef`
 * (`agentFits`), measured before paint and again whenever the line's width
 * changes. `shape` names what else is on the line, so a state growing from
 * "9%" to "10%" or a branch arriving measures it again. True until measured:
 * the server render, and the first paint of a wide side bar, show the name.
 */
function useAgentFits(lineRef, agent, shape) {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line || !agent) return undefined;
    const check = () => {
      const style = getComputedStyle(line);
      const innerPx = line.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const status = line.querySelector('[data-status-state]');
      setFits(
        agentFits({
          innerPx,
          gapPx: parseFloat(style.columnGap) || 0,
          agentPx: textWidth(line, agent),
          statusPx: status ? status.getBoundingClientRect().width : 0,
          hasBranch: Boolean(line.querySelector('[data-branch]')),
          hasNote: Boolean(line.querySelector('[data-last-note]')),
        })
      );
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(line);
    return () => observer.disconnect();
  }, [lineRef, agent, shape]);
  return fits;
}

/**
 * The second line of terminal `tab`'s row in the TERMINALS side bar (S1):
 * the agent running in it and what it is doing, the branch its folder is on,
 * and the last thing it told you — each only while its setting is on
 * (`showAgent`, `showBranch`, `showLastNote`). `active`: the row is the
 * active one, drawn on the selection colour.
 *
 * Subscribed to exactly what it draws (S9): its tab's unread count, its
 * tab's bar, its tab's newest entry, and its folder's branch. `memo`, so the
 * panel redrawing for anything else — a rename, another tab's title — passes
 * it by while its own tab is the same object.
 *
 * Its height is fixed and everything in it is on one line: an item coming,
 * going or growing moves only what follows it on this line, never the title
 * above it or the next row.
 *
 * WHEN THE LINE IS TOO NARROW:
 *   - the state never gives way, and is short (`compactStatusText`: "100%",
 *     "Paused 40%", "Waiting"); its full words are the line's tooltip and
 *     part of what is read out;
 *   - the branch gives way first, down to its icon (`shrink-[1000000]`: a
 *     weight so large that nothing else's share of the shortfall reaches the
 *     1/64 px the browser lays out in — any share at all ellipsised the
 *     agent's name while the branch still had room to give);
 *   - the agent's name is drawn whole or not at all (`useAgentFits`): it is
 *     left out when it would not fit beside the state, the branch's icon and
 *     the note's 40%, and is then said in the line's tooltip and read out;
 *   - the last note takes the rest, cut with an ellipsis at its end however
 *     little is left (`min-w-0`) — never clipped mid-glyph by the line's edge.
 *
 * Read out as one sentence ("OpenCode, Waiting, branch main, last
 * notification, unread: Session done"): the icons are hidden, and what the
 * gaps say to the eye is said in words.
 */
export const TerminalStatusLine = memo(function TerminalStatusLine({
  tab,
  showAgent,
  showBranch,
  showLastNote,
  active = false,
  className,
}) {
  const tabId = tab.id;
  const unread = useTerminalStore((s) => (showAgent ? unreadCountByTab(s.notifications)[tabId] ?? 0 : 0));
  const bar = useTerminalStore((s) => (showAgent ? s.progress?.[tabId] ?? null : null));
  const note = useTerminalStore((s) => (showLastNote ? lastNoteOf(s.notifications, tabId) : null));
  const os = useSystemStore((s) => s.os);
  const branch = useFolderBranch(showBranch ? folderForBranch(tab, os) : null);
  const lineRef = useRef(null);

  const agent = showAgent ? agentLabel(tab) : '';
  const status = showAgent ? terminalStatus(tab, { unread, progress: bar }) : null;
  const words = status ? statusText(status) : '';
  const shortWords = status ? compactStatusText(status) : '';
  const branchName = showBranch ? branchLabel(branch) : '';
  const fits = useAgentFits(lineRef, agent, `${shortWords.length}|${Boolean(branchName)}|${Boolean(note)}`);
  const agentShown = Boolean(agent) && fits;
  // The agent's name, drawn, already says who spoke; left out for width, the
  // note keeps a title that says it (terminalStatus.js).
  const noteText = note ? noteLine(note, { agentShown }) : '';
  const quiet = secondaryText(active);
  // What the line says in full, for its tooltip: the agent's name even when
  // there was no room to draw it, and the state's whole words.
  const said = [agent, words].filter(Boolean).join(' \u{2014} ');

  const items = [];
  if (agent) {
    items.push(
      agentShown ? (
        <span key="agent" data-agent={tab.agent.kind} className={cn('shrink-0 whitespace-nowrap', quiet)}>
          {agent}
        </span>
      ) : (
        // Left out for width, and still read out: hidden from the eye only,
        // so it takes no room and leaves no gap.
        <span key="agent" data-agent-hidden={tab.agent.kind} className="sr-only">
          {agent}
        </span>
      )
    );
  }
  if (words) {
    const [Icon, colour] = iconOf(status) ?? [null, ''];
    items.push(
      <span
        key="status"
        data-status-state={status.state}
        data-status-value={status.value}
        className="shrink-0 flex items-center gap-[3px] whitespace-nowrap"
      >
        {Icon && <Icon size={12} aria-hidden="true" data-status-icon="" className={cn('shrink-0', colour)} />}
        {shortWords === words ? (
          <span className="tabular-nums">{words}</span>
        ) : (
          <>
            <span aria-hidden="true" className="tabular-nums">
              {shortWords}
            </span>
            <span className="sr-only">{words}</span>
          </>
        )}
      </span>
    );
  }
  if (branchName) {
    // A detached head is a commit, not a branch, and must not pass for one:
    // its own icon, and the word.
    const BranchIcon = branch.detached ? GitCommitHorizontal : GitBranch;
    items.push(
      <span
        key="branch"
        data-branch={branchName}
        data-branch-detached={branch.detached ? '' : undefined}
        title={branchTitle(branch)}
        className={cn('min-w-[10px] shrink-[1000000] flex items-center gap-[3px] overflow-hidden', quiet)}
      >
        <BranchIcon size={10} aria-hidden="true" className="shrink-0" />
        {branch.detached ? (
          <span className="min-w-0 truncate">
            detached <bdi>{branchName}</bdi>
          </span>
        ) : (
          <>
            <span className="sr-only">branch </span>
            <span className="min-w-0 truncate">
              <bdi>{branchName}</bdi>
            </span>
          </>
        )}
      </span>
    );
  }
  if (noteText) {
    items.push(
      <span
        key="note"
        data-last-note={note.read ? 'read' : 'unread'}
        title={noteTooltip(note)}
        // "3m ago" is true when it is drawn and goes on ageing; the line is
        // not redrawn for the clock, so the tooltip is brought up to date as
        // the pointer arrives to read it.
        onPointerEnter={(e) => {
          e.currentTarget.title = noteTooltip(note);
        }}
        className={cn('min-w-0 flex-[1_1_40%] flex items-center gap-1 overflow-hidden', note.read && quiet)}
      >
        {/* Unread and read differ by more than colour: an unread note has
            the bell list's own unread dot, which forced colours paint in
            Highlight (index.css). */}
        {!note.read && (
          <span aria-hidden="true" data-unread-dot="" className="w-[5px] h-[5px] rounded-full shrink-0 bg-vsc-attention" />
        )}
        <span className="sr-only">{note.read ? 'last notification: ' : 'last notification, unread: '}</span>
        <span className="min-w-0 truncate">
          <bdi>{noteText}</bdi>
        </span>
      </span>
    );
  }

  return (
    <span
      ref={lineRef}
      data-status-line={tabId}
      title={said || undefined}
      className={cn('h-[16px] flex items-center gap-1.5 min-w-0 overflow-hidden text-ui-sm leading-[16px]', className)}
    >
      {items.map((item, i) => (
        <React.Fragment key={item.key}>
          {i > 0 && <Pause />}
          {item}
        </React.Fragment>
      ))}
    </span>
  );
});

// ---- A group's summary ----------------------------------------------------------

const SUMMARY_ICON = Object.freeze({
  waiting: STATE_ICON.waiting,
  running: STATE_ICON.running,
  failed: STATE_ICON.failed,
});


/**
 * How many of a group's terminals are waiting, running and failed, on its
 * row in the side bar (S6): an icon and a number for each count that is not
 * zero, and the counts in words as its tooltip and its accessible name
 * (`summaryWords`). Nothing at all for a quiet group.
 *
 * Subscribed to the counts of `tabIds` alone (numbers, compared one by one),
 * so a bar moving in the group does not redraw it.
 */
export const GroupSummary = memo(function GroupSummary({ tabIds, className }) {
  const counts = useTerminalStore(useShallow((s) => summaryCounts(s, tabIds)));
  const items = groupSummaryItems(counts);
  if (items.length === 0) return null;
  const label = groupSummaryLabel(counts);
  const words = summaryWords(label);
  return (
    <span
      role="img"
      aria-label={words}
      title={words}
      data-group-summary={label}
      className={cn('shrink-0 flex items-center gap-1 tabular-nums', className)}
    >
      {items.map((item) => {
        const [Icon, colour] = SUMMARY_ICON[item.key];
        return (
          <span key={item.key} data-summary-item={item.key} data-summary-count={item.count} className="flex items-center gap-px">
            <Icon size={11} aria-hidden="true" data-status-icon="" className={cn('shrink-0', colour)} />
            {item.count}
          </span>
        );
      })}
    </span>
  );
});
