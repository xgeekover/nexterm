import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { useResourceUsageStore } from '../../stores/resourceUsageStore.js';
import { useResourceCardShown } from '../../hooks/useResourceSampler.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { unreadCountByTab } from '../../lib/attention.js';
import { shellPathOf } from '../../lib/terminalFileDrop.js';
import { cardPosition, chipDescribedBy, createHoverCardController, tabHoverCardRows } from '../../lib/tabHoverCard.js';
import { cn } from '../../lib/utils.js';
import { lastNoteOf } from './statusBoardModel.js';

/**
 * The hover card of a terminal tab chip (bundle 4, B12) — what it says is
 * decided in src/lib/tabHoverCard.js, and so is when it shows.
 *
 * A floating surface (STYLEGUIDE.md, Elevation), drawn in a portal so the
 * strip's `overflow` does not clip it, below its chip. `role="tooltip"`, and
 * nothing in it takes the pointer or the keyboard (`pointer-events: none`):
 * a click aimed at the terminal's first row under it lands on the terminal.
 * It fades in over 150 ms by opacity alone (`animate-overlay-in`), and not
 * at all under either reduced-motion switch (index.css, `[data-hover-card]`).
 */

/** Whether `el` has focus the way the keyboard gives it (`:focus-visible`); false where that cannot be asked. */
function focusVisible(el) {
  try {
    return Boolean(el?.matches?.(':focus-visible'));
  } catch (_) {
    return false;
  }
}

/** One row of the card, by its key (tabHoverCardRows). */
function CardRow({ row }) {
  switch (row.key) {
    case 'title':
      return (
        <div data-card-row="title" className="text-ui text-vsc-fg-bright break-words">
          <bdi>{row.text}</bdi>
        </div>
      );
    case 'status':
      return (
        <div data-card-row="status" data-status-state={row.state} className="flex items-baseline gap-1.5">
          {row.glyph && (
            <span aria-hidden="true" className="w-3 shrink-0 text-center">
              {row.glyph}
            </span>
          )}
          <span>{row.text}</span>
        </div>
      );
    case 'folder':
      return (
        <div data-card-row="folder" className="break-all">
          <span className="sr-only">Folder: </span>
          <bdi>{row.text}</bdi>
        </div>
      );
    case 'shell':
      return (
        <div data-card-row="shell">
          <span className="text-vsc-muted">Shell </span>
          {row.text}
        </div>
      );
    case 'usage':
      // Show CPU and Memory (B8): the short form for the eye, dimmed like
      // the shell's name and never coloured; its words for a screen reader.
      return (
        <div data-card-row="usage" data-usage-wsl={row.wsl ? '' : undefined}>
          <span className="text-vsc-muted" aria-hidden="true">
            Usage{' '}
          </span>
          <span aria-hidden="true" className="tabular-nums">
            {row.text}
          </span>
          <span className="sr-only">{row.words}</span>
        </div>
      );
    case 'flags':
      // Each in its own <bdi>, as the title is: "Controlled by …" carries
      // another terminal's title, which may be right-to-left.
      return (
        <div data-card-row="flags" className="flex flex-col">
          {row.items.map((item) => (
            <span key={item}>
              <bdi>{item}</bdi>
            </span>
          ))}
        </div>
      );
    default:
      return (
        <div data-card-row={row.key} className={cn('break-words', row.dim && 'text-vsc-muted')}>
          <bdi>{row.text}</bdi>
        </div>
      );
  }
}

/**
 * The card's body for terminal `tabId`, with id `id` — what the chip's
 * `aria-describedby` points at — or nothing when there is no such terminal.
 * Subscribed to exactly what it says, and mounted only while it is shown.
 * No portal, so the render suite can draw it.
 *
 * With Show CPU and Memory on (bundle 4, B8) it shows its terminal's CPU and
 * memory, and counts as a card on screen for the sampler while it is
 * mounted (`useResourceCardShown`), so the figures keep coming with the
 * TERMINALS panel hidden; unmounted — the card closed — or the setting
 * turned off, it lets go. Its figure is brought up to date by its own
 * entry of the resource usage store, compared field by field, and by
 * nothing else: not by the minute clock.
 */
export function TabHoverCardContent({ tabId, id, style, cardRef }) {
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === tabId) ?? null);
  const unread = useTerminalStore((s) => unreadCountByTab(s.notifications)[tabId] ?? 0);
  const progress = useTerminalStore((s) => s.progress?.[tabId] ?? null);
  const activity = useTerminalStore((s) => s.agentActivity?.[tabId] ?? null);
  const note = useTerminalStore((s) => lastNoteOf(s.notifications, tabId));
  const locked = useTerminalStore((s) => Boolean(s.secretInput?.[tabId]));
  const readOnly = useTerminalStore((s) => Boolean(s.readOnly?.[tabId]));
  const controlled = useTerminalStore((s) => s.controlled?.[tabId] ?? null);
  const defaultShell = useSettingsStore((s) => s.terminalDefaultShell);
  const os = useSystemStore((s) => s.os);
  const systemShell = useSystemStore((s) => s.defaultShell);
  const showUsage = useSettingsStore((s) => s.terminalShowResources === true);
  const usage = useResourceUsageStore(useShallow((s) => (showUsage ? s.byTab[tabId] ?? null : null)));
  useResourceCardShown(showUsage && tab !== null);
  // How long the state has held, as of when the card is drawn. Not on the
  // minute clock (useMinuteNow): only the TERMINALS lines listen to it, and
  // a card is up for seconds.
  const now = Date.now();
  if (!tab) return null;
  const rows = tabHoverCardRows(tab, {
    unread,
    progress,
    activity,
    note,
    now,
    locked,
    readOnly,
    shellPath: shellPathOf(tab, { defaultShell, systemShell }),
    platform: os,
    showUsage,
    usage,
    controlled,
  });
  return (
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      data-hover-card={tabId}
      style={style}
      className={cn(
        'fixed z-[70] min-w-[160px] max-w-[320px] px-2.5 py-1.5 flex flex-col gap-0.5',
        'rounded-popover bg-vsc-widget border border-vsc-widget-border shadow-widget',
        'text-ui-sm text-vsc-fg pointer-events-none select-none animate-overlay-in'
      )}
    >
      {rows.map((row) => (
        <CardRow key={row.key} row={row} />
      ))}
    </div>
  );
}

/**
 * The card of `tabId` below chip element `anchor`, in a portal on the page's
 * body. Placed when it opens, and again whenever its size changes — its
 * usage row arriving with the first sample, a notification, a longer title
 * — so a card above its chip never grows over the chip and one below it
 * never past the window's edge. That takes a ResizeObserver; where there is
 * none, it is placed once.
 */
export function TabHoverCard({ tabId, anchor, id }) {
  const cardRef = useRef(null);
  const [place, setPlace] = useState(() => cardPosition(anchor?.getBoundingClientRect?.()));
  useLayoutEffect(() => {
    const card = cardRef.current;
    const placeIt = () => {
      const rect = anchor?.getBoundingClientRect?.();
      if (!card || !rect) return;
      const next = cardPosition(rect, {
        width: card.offsetWidth,
        height: card.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setPlace((cur) => (cur.left === next.left && cur.top === next.top ? cur : next));
    };
    placeIt();
    if (!card || typeof ResizeObserver !== 'function') return undefined;
    const sized = new ResizeObserver(placeIt);
    sized.observe(card);
    return () => sized.disconnect();
  }, [anchor, tabId]);
  if (typeof document === 'undefined' || !document.body) return null;
  return createPortal(
    <TabHoverCardContent tabId={tabId} id={id} cardRef={cardRef} style={{ left: place.left, top: place.top }} />,
    document.body
  );
}

/** Whether chip element `el` is still on the page; true where that cannot be asked. */
function onPage(el) {
  if (!el) return false;
  if (typeof el.isConnected === 'boolean') return el.isConnected;
  return typeof el.ownerDocument?.contains === 'function' ? el.ownerDocument.contains(el) : true;
}

/**
 * The hover card of one row of chips (a pane's tab strip): one card at a
 * time, for the chip `shownId`.
 *
 * `blocked` is true during a drag, a rename or an open menu — no card then.
 * `tabIds` are the row's chips: a card whose chip went away goes too, and so
 * does one whose chip element was replaced, as when Hide Single Tab Strip
 * moves the strip between the pane's top and its overlay — a removed chip
 * hears no pointer leaving, and the card would stay where the old one was.
 *
 * Returns `chipProps(tabId)` — the pointer and focus handlers and the
 * `aria-describedby` to spread on a chip, which names the card only while it
 * is shown — `press(tabId)` for the chip's pointerdown, `escape()` for its
 * Escape (true when a card was there to close, and the key is then taken),
 * `card`, the element to draw, and `anchored()`, the tab ids whose chip
 * element it holds (for the suites): only chips of the row that are on the
 * page.
 */
export function useTabHoverCard({ blocked = false, tabIds = [] } = {}) {
  const [shownId, setShownId] = useState(null);
  const anchors = useRef(new Map());
  const [controller] = useState(() => createHoverCardController({ onChange: setShownId }));
  const cardId = `${useId()}tab-hover-card`;

  useEffect(() => () => controller.hide(), [controller]);
  useEffect(() => {
    controller.setBlocked(blocked);
  }, [controller, blocked]);
  const gone = shownId !== null && !tabIds.includes(shownId);
  useEffect(() => {
    if (gone) controller.hide();
  }, [controller, gone]);
  // After every draw of the row, before it is painted: forget the chip
  // elements of tabs that are gone and the ones no longer on the page — and,
  // in the controller, the pointer, focus, press and Escape held for them,
  // since a removed element hears no leave and no blur — and put away the
  // card shown or about to show for a chip whose element went.
  const rowIds = useRef([]);
  useLayoutEffect(() => {
    for (const id of rowIds.current) {
      if (!tabIds.includes(id)) controller.forget(id);
    }
    rowIds.current = [...tabIds];
    for (const [id, el] of anchors.current) {
      if (!tabIds.includes(id) || !onPage(el)) {
        anchors.current.delete(id);
        controller.forget(id);
      }
    }
    const active = controller.shown ?? controller.pending;
    if (active !== null && !anchors.current.has(active)) controller.hide();
  });

  const chipProps = (tabId) => ({
    // A finger has no hover: a tap is a click, and a card coming with it
    // would be in the way of the next one.
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return;
      anchors.current.set(tabId, e.currentTarget);
      controller.enter(tabId);
    },
    onPointerLeave: () => controller.leave(tabId),
    onFocus: (e) => {
      if (e.target !== e.currentTarget) return;
      anchors.current.set(tabId, e.currentTarget);
      controller.focus(tabId, focusVisible(e.currentTarget));
    },
    onBlur: (e) => {
      if (e.target !== e.currentTarget) return;
      controller.blur(tabId);
    },
    'aria-describedby': chipDescribedBy(gone ? null : shownId, tabId, cardId),
  });

  return {
    shownId,
    cardId,
    chipProps,
    press: (tabId) => controller.press(tabId),
    escape: () => controller.escape(),
    anchored: () => [...anchors.current.keys()],
    card:
      shownId !== null && !gone ? <TabHoverCard key={shownId} tabId={shownId} anchor={anchors.current.get(shownId)} id={cardId} /> : null,
  };
}
