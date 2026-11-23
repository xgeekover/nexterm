# NexTerm style guide

The design and UX rules for anything new in NexTerm, and the decisions that
were made on purpose and should not be undone by accident. The values live in
`src/styles/index.css` (the `:root` tokens) and `tailwind.config.js` (the
Tailwind names for them); this file says how to use them and why. When this
file and the code disagree, the code is what ships and this file is out of
date: fix it in the same change.

`tests/render/runner.js` (RN-234) checks that this file still matches the
stylesheet: the key tokens it names exist in `:root`, every `--vsc-*` name it
mentions is a real token, and every recorded decision has a date and a reason.

## Palette and tokens

NexTerm is dark only. Every colour comes from a `--vsc-*` token, used through
Tailwind (`bg-vsc-widget`, `text-vsc-muted`, `border-vsc-border`, ...). Never
write a hex value, `rgb()` or a named colour in a component; if no token fits,
add one to `:root` and to `tailwind.config.js`.

Surfaces come in four tiers, darkest first:

1. Chrome and terminal: the title bar, activity bar, side bars, panel, status
   bar and every terminal (`--vsc-sidebar-bg`, `--vsc-panel-bg`,
   `--vsc-terminal-bg`, `--vsc-statusbar-bg`).
2. The editor and the active tab, which join into one surface
   (`--vsc-editor-bg`, `--vsc-tab-active-bg`).
3. Anything that floats: popovers, menus, dialogs, the palette, notices
   (`--vsc-widget-bg`, `--vsc-menu-bg`, `--vsc-quickinput-bg`).
4. Fields and hover (`--vsc-input-bg`, `--vsc-hover`).

A new surface takes one of these tiers; it does not get a fifth.

- Text is `--vsc-fg`, secondary text `--vsc-muted`, and the brightest text
  `--vsc-fg-bright`.
- Lines between areas are `--vsc-border`. The edge of a floating surface is
  `--vsc-widget-border`, and a field's edge is `--vsc-input-border`.
- State colours mean state and nothing else: `--vsc-error` (failed),
  `--vsc-warn` (a warning, a paused progress bar), `--vsc-attention` ("a
  terminal wants you": the attention ring and the unread pills),
  `--vsc-ok` (succeeded) and `--vsc-info` (information, the marks of messages
  sent to Claude Code). Do not use them to decorate.
- Show a state by shape or words as well as colour wherever it can be done,
  so a colour-blind reader and forced colours (Windows High Contrast) still
  get it. The mark on a terminal tab and a group chip is the pattern: a
  filled, pulsing violet dot (`--vsc-accent`) while a command runs, a circled
  cross (lucide `CircleX`, the icon the TERMINALS side bar shows for a
  failed command) in `--vsc-error` when the last one failed, and the unread
  pill's count for notifications. In forced colours the dot is painted in
  Highlight and the cross in CanvasText, so the two still differ by shape.
- A read-only terminal (`src/lib/readOnly.js`) is marked by a keyboard with a
  stroke through it (lucide `KeyboardOff`), never the padlock, which means a
  password prompt: the two can be on at once and must not be confused. On a
  tab chip it is a 10px round badge (an 8px mark on the panel surface with
  a `--vsc-border` ring) on the chip's bottom-left corner, right under the
  lock's top-left one, taking no room and no pointer; on the TERMINALS row
  it sits in line right after the lock. It is drawn in `--vsc-fg-bright`
  on the panel surface, not in a state colour (nothing failed, nothing
  waits), so forced colours repaint it with the text; its words are in its
  `aria-label` and `title` and in the chip's and the row's tooltip. The
  handle of a hidden tab strip does not carry it: the strip in the pane
  (below) says it whether the tab strip shows or not.
- An in-pane notice is a row of its own ABOVE the terminal, never laid over
  it: over it, it hides the top rows, and in a full-screen program those
  never scroll into view. The terminal refits to the rest. The resume offer
  and the read-only strip are the pattern: the strip is 24px high, on
  `--vsc-panel-bg` with a `--vsc-border` line under it, the `KeyboardOff`
  mark, the words "Read-only: what you type does not reach this terminal",
  and a secondary Turn Off button (`rounded-control`). It is there only while
  the terminal is read-only, and Turn Off hands the keyboard back to it.
- The ANSI tokens (`--vsc-ansi-red` and the rest) are the terminal's palette,
  not the UI's.
- The terminal find colours (`--vsc-find-match`, `--vsc-find-match-other`)
  must stay `#RRGGBB`: xterm parses them itself and drops anything with an
  alpha channel.
- Contrast is tested, not eyeballed. RN-222 checks every text pair at 4.5:1
  and every UI-part pair at 3:1 (WCAG); a new pair of tokens is added to it.
  `src/lib/monaco.js` mirrors the editor's share of the palette and RN-229
  keeps the two equal.

## Accent

The accent is violet.

- `--vsc-accent` marks what is active: a pane, a tab, a view, a drop target,
  a running dot, a separator under the pointer or being dragged. It is drawn
  as a line, a bar, a dot or a mark. It never sits under text, because white on it is under 4.5:1.
- Text on a violet fill (a primary button, an accent badge) uses
  `--vsc-accent-solid` with `--vsc-accent-fg` on it, and
  `--vsc-accent-hover` and `--vsc-accent-pressed` for its states.
- Text or a glyph drawn in violet uses `--vsc-accent-text`. Links are
  `--vsc-link`. Selected text is `--vsc-selection`.
- One active mark per thing. The active pane of a group draws one 1px inset
  violet ring (PaneFrame), and only while more than one pane is on screen and
  the group is not zoomed. An editor pane draws no ring of its own.

## Focus

- Keyboard focus is one global ring: `:focus-visible` draws a 2px
  `--vsc-focus-ring` outline, inset by 2px. It shows on keyboard focus only;
  a click does not show it.
- A text field does not get the ring. It is a `.ui-field`: a 1px border in
  every state, which turns `--vsc-focus` while focused, so focus moves no
  pixel. A field with an invalid value keeps `--vsc-error` on its border.
- A separator is too thin for a ring inside it, so a focused separator shows
  a 3px light-violet line (`--vsc-focus-ring`) instead. It keeps keyboard
  focus (Tab, then the arrow keys move it); a pointer press does not leave it
  focused.
- Anything that takes focus must show it. A component that removes the ring
  shows focus another way (an active row, a selected option).
- Dismiss buttons on notices keep focus where it was (they cancel the
  mousedown), so closing a notice never steals focus from the terminal.

## Radii

- `--radius-control` (4px, `rounded-control`): fields, buttons and small
  controls.
- `--radius-popover` (8px, `rounded-popover`): anything that floats.
- `rounded-sm` (2px) stays on tab chips, group chips and inline items, and
  `rounded-full` is for dots and pills.

No other radius is introduced.

## Elevation

There is one elevation. Anything that floats (a popover, menu, dialog, the
palette, a corner notice) is `rounded-popover` with `shadow-widget`, on
`bg-vsc-widget` with a `border-vsc-widget-border` edge. On the near-black
surfaces the border does most of the separating; the shadow only lifts it.
Nothing else casts a shadow. (The active editor tab's 1px top line is drawn
with an inset box-shadow; it is a line, not elevation.)

## Motion and reduced motion

Motion is short and says what changed; it never decorates. The durations in
use:

- 120 ms: colour changes on a field's border and a separator.
- 200 ms: the wait before a hovered separator turns violet, so a pointer
  passing over it does not flash it. Leaving starts back at once, and a drag
  shows violet at once (no transition).
- 600 ms: the wait before a terminal tab's hover card opens, and 100 ms of
  grace after the pointer leaves (below). These and the separator's are the
  only delays in use.
- 150 ms: drag overlays and drop zones fading in and swapping.
- 150 ms: a toast fading in, and a confirmation toast fading out over the
  last 150 ms of its 3 s. By opacity only: a toast never slides.
- 180 ms: a region or panel fading in and out as it mounts and unmounts.
- 1200 ms: the attention flash; 2 s: the attention ring's pulse; 1.4 s: the
  indeterminate progress slide.

New motion stays within these unless it has a reason to differ.

Reduced motion has two switches, and every animation and transition must obey
both:

- the OS setting, through `@media (prefers-reduced-motion: reduce)`;
- Settings ▸ Workbench ▸ *Reduce Motion*, which PanelLayout mirrors onto
  `<html>` as the `reduce-motion` class (a media query cannot read the
  setting).

Under either, a finite animation or transition is cut to 0.01 ms, so it ends
at once in its final state. An infinite animation (a pulse, a slide) is not
sped up, because a sped-up loop stops at a random point of its cycle; it is
switched off (`animation: none`) and the element shows a steady resting
style. A state that only exists while it animates (the attention flash) shows
steadily for as long as it lasts instead. A delay is not shortened by the
cut, so whatever waits gets `transition-property: none` and no delay under
both switches: a separator's highlight then switches with its state, with no
wait and no fade.

## Density and sizes

NexTerm is dense, like VS Code. The sizes in `tailwind.config.js`:

- Text: `text-ui` 13px for the UI, `text-ui-sm` 11px for secondary lines,
  `text-code` 12px on 18px lines for code.
- The status bar is 22px (`h-statusbar`). The activity bar is 48px wide.
- Tab strips: editor tabs are 35px (`h-tab`), and a side bar or panel header
  with its view tabs is 35px (`h-panel-header`). A terminal pane's strip and
  the group switcher are 28px (`h-7`), with 22px chips in them.
- The activity mark on a tab or group chip takes 6px: the running dot is
  6px, and the failed cross is drawn at 10px, centred on a 6px box.
- A separator is a 1px line, and its hit area is the library's: 10px across
  for a mouse and 20px for touch, centred on the line. The whole hit area
  highlights on hover, after a drag too: a press focuses the separator, and
  PanelLayout lets go of that focus when the press ends
  (`src/lib/separatorFocus.js`): it blurs only a separator that the press
  itself focused. A separator focused before the press (by Tab) keeps its
  focus and its ring, whatever press ends elsewhere and also when it is
  dragged itself: the user chose keyboard focus.
- A strip of tabs or chips scrolls sideways and shows no scroll bar
  (`.no-scrollbar`). The side with more tabs fades out over its last 20px:
  `useEdgeFade` sets `data-edge-fade` on the scroller (`start`, `end`, `both`
  or `none`) and index.css masks it, black to transparent, with no colour
  token and no transition. A mask, never an overlay element, so a half-faded
  tab still takes its click. While a drag is over a strip it does not fade,
  so the insertion or drop marker is drawn whole.

## Hover cards

A terminal tab chip's tooltip is its hover card (`src/lib/tabHoverCard.js`,
`TabHoverCard.jsx`), and neither the chip nor anything on it the pointer
reaches without leaving it (its ✕, the unread count, the *controlled*
badge) has a native `title`: two tooltips would show at once. What such a
part says is its `aria-label`, and the card's.

- It opens 600 ms after the pointer rests on the chip, or after keyboard
  focus (`:focus-visible`) lands on it, and goes 100 ms after the pointer
  leaves. Moving to the next chip while one is shown switches at once.
  `Escape` closes it and the keyboard stays on the chip; while it is only
  about to open, `Escape` drops the wait and goes on to whatever else takes
  it. Never during a drag, a rename or an open menu, nor after a press on
  the chip. It goes when its chip's element does (the strip moving into or
  out of the hidden strip's overlay).
- It is a floating surface (Elevation): `rounded-popover`, `shadow-widget`,
  `bg-vsc-widget`, a `border-vsc-widget-border` edge, drawn below the chip in
  a portal, above the chip when there is no room below; placed again
  whenever its size changes (a ResizeObserver), so a row arriving never
  pushes it over the chip or past the window's edge. `role="tooltip"`,
  `pointer-events: none`, nothing in it to press or focus, so a click where
  it is lands on the terminal. The chip names it in `aria-describedby` only
  while it is shown.
- It fades in by opacity over 150 ms (`animate-overlay-in`) and, under
  either reduced-motion switch, not at all (`[data-hover-card]`).
- What may appear, in this order: the full title; glyph, agent, state and how
  long in words, from the TERMINALS row's own helpers (terminalStatus.js);
  the folder, shortened in the middle; the shell; with Show CPU and Memory
  on, *Usage* and 'CPU% · memory' in the TERMINALS row's own words
  (resourceUsage.js); the flags (typing hidden, read-only, controlled by
  another terminal, N unread); the
  last notification, dimmed; the dimmed hint "Drag to reorder or move ·
  Double-click to rename".
- The CPU and memory figure, on the card and at the end of a TERMINALS
  row's second line, is plain dimmed text in `tabular-nums`, never coloured
  however high it is: colour is for state, and a figure is not one. Its
  words ("CPU 12% of one core, …") are its tooltip and what a screen reader
  reads; with the setting off, or no sample yet, nothing is drawn, not even
  a gap — and after sampling stops nothing old is kept to draw, so a figure
  is never one from before a pause. Its CPU reads *measuring* for the first
  sample of each start and has a figure 1 s later
  (`RESOURCE_FOLLOW_UP_MS`). It refreshes from its own store entry while
  shown, never from the minute clock.
- What may never appear: anything of the terminal's screen or scrollback,
  and the command line running in it.
- Every row is someone else's text and is cleaned where it is drawn
  (`displayText`): no control, bidirectional or zero-width character.

## Copy

- Never overclaim. Say what happened, no more: "Copied" only after the copy
  succeeded, "Saved" only after the write returned. When something cannot be
  checked, say what was done rather than what it achieved.
- No filler words: no "successfully", "please", "simply" or "just". Name the
  thing and what happened to it ("Path copied").
- Cancel, Dismiss and Close are quiet buttons: secondary style, never the
  violet fill. Only the action that goes ahead gets the fill.
- In a dialog or a field, Enter submits and Esc backs out without changing
  anything.
- How long something has lasted, where a line keeps it up to date (the
  TERMINALS rows' "Working 3m"): whole minutes, rounded down, and nothing
  under one minute ("Working", never "Working 0m"); then "3m", "59m",
  "1h 0m", "2h 5m". Never seconds: such a line is redrawn once a minute, on
  the minute, so a count of seconds would be wrong as soon as it was drawn,
  and redrawing every second would cost for nothing. The tooltip and the
  screen-reader words spell it out ("Working for 3 minutes").

## In-flight feedback

How long an action may take decides what it shows while it runs:

- Under 100 ms: nothing. Any feedback would only flicker.
- From 100 ms to 1 s: the control that started it is disabled, and nothing
  else changes.
- From 1 s to 3 s: a spinner or a label swap ("Saving…").
- Over 3 s: stage labels ("Reading files…", "Writing…") or real progress, so
  the user can tell it is still moving.

The result is then shown where the action was started. A confirmation fades by
itself; an error stays until it is dismissed.

An action whose result shows nowhere else (a copy changes nothing on screen)
says it in a toast, over the bottom right corner above the status bar
(`src/stores/toastStore.js`, `src/components/common/ToastHost.jsx`):

- Toasts are for short confirmations ("Path copied"). A confirmation goes by
  itself after 3 s and is announced politely (`role="status"`,
  `aria-live="polite"`, in the one region described below).
- Errors stay until they are dismissed, and are announced at once
  (`role="alert"`). An error that went while the user looked away would never
  have been said.
- At most three are up, the newest at the bottom; a fourth drops the oldest.
  The same text again replaces the toast already up and starts its 3 s again,
  so it is never shown twice.
- A toast never takes focus, and its Dismiss keeps focus where it was, so
  typing in the terminal goes on. Toasts sit beside the corner notices
  (OpenFailureNotice, AgentHistoryNotice), never over them: in the next 400px
  column while the window has room for it (824px beside one notice, 1232px
  beside two), else at the right edge directly above the notices, 8px clear
  of the taller one, so a toast is always whole on screen.
- The polite region is mounted all the time, empty and visually hidden, and a
  confirmation's text is added to it, so a screen reader that ignores a live
  region arriving with its first text still says it. The drawn confirmation
  is not a live region of its own, and its words are `aria-hidden`, so the
  region is their one copy and browse mode does not read them twice. An
  error is read where it is drawn.
- The copy runs inside the click or Enter that asked for it; only the toast
  waits for the clipboard's answer (`src/lib/copyFeedback.js`). Wired so far:
  Copy Path (TERMINALS row, tab chip, Explorer) says "Path copied", Copy
  Context (row and chip menus, the palette) says "Copied N lines (secrets
  masked)" ("1 line" for one), and Copy Session ID (AGENT SESSIONS) says
  "Session ID copied"; a refused copy, or nothing to copy, is an error that
  starts "Not copied: " and says why ("Not copied: the clipboard refused
  it"). Copy Path is off, with its reason, for a terminal that has no
  directory yet. The other copy actions (Copy Relative Path, a terminal's or
  an editor's selection, the rest) are later work.
- Bundle 4 uses the same toasts. Copy Last Command Output says "Copied N
  lines of the output of "<command>" (secrets masked)", the command masked
  and shortened, and says when its start or its oldest lines are missing;
  it is off with its reason in the menus and in the Command Palette, which
  lists it whenever the terminal has been shown, and a reason found only
  when it is picked is a "Not copied: " error. Send to Agent confirms
  "Typed <the reference> into <agent> in "<terminal>" — Enter not pressed"
  and refuses with an error that starts "Not sent: "; Monaco's menu cannot
  grey an entry out with a reason, so the editor's entries are always
  offered and refuse that way. Input a read-only terminal drops is an
  error that starts "Not typed: " and names how to turn read-only off, at
  most once every 3 s.
- Anything that needs a decision, or says more than a line, is a notice or a
  dialog, not a toast.

## Recorded decisions

Decisions made on purpose. Each was weighed against the alternative; undo one
only by recording a new decision here.

- **A closed tab keeps nothing on disk** (2026-11-14). A terminal tab the user
  closes is never restored, and its saved scrollback is deleted; at start-up
  every scrollback file that does not belong to a restored tab is deleted too
  (`src/lib/scrollbackSession.js`, `src/stores/terminalStore.js`).
  Reason: the rule of stage 6 of the sessions task (T-20261114-192901-6863), as
  the code records it: a closed tab is never restored, so nothing of it is
  kept.
- **Q-C1: a group that holds files keeps a terminal pane** (2026-11-18). When
  the last terminal of a group that still has files open goes, the group keeps
  one empty terminal pane with New Terminal, and that pane has no Close.
  Reason: the human's answer to Q-C1 (the recommended option A; queen-notes
  of task T-20261118-133426-988a): it keeps New Terminal, the TERMINALS
  panel's split buttons, `activePaneId` and the restore code as they were
  tested, and adds no risk to a task that was already large.
- **F8: the scrollbar ruler shows prompt marks only** (2026-11-18). The
  terminal's scrollbar ruler draws prompt marks (and the marks of messages
  sent to Claude Code); find matches do not share it, and the find bar
  highlights them in the text instead.
  Reason: the human's choice (task T-20261118-083542-a7f4).
- **Prompt jumps are Ctrl+Shift+Up/Down, Cmd+Shift+Up/Down on macOS**
  (2026-11-18), as `src/lib/keybindings.js` cites.
  Reason: the human's choice of keys.
- **Git read-only** (2026-11-21, Orca comparison C1). NexTerm reads git state
  to show it, and never changes a repository: no diff view, no line comments,
  no staging and no commits.
  Reason: a diff and review view is the largest item of all, and review
  already works in the terminal with `git diff` and an agent. A read-only diff
  of one file may be looked at again later.
- **Dark only** (2026-11-21, Orca comparison C3). Light mode was removed and
  no light theme is planned.
  Reason: a light theme is a large change that nobody asked for.
- **Find matches stay off the scrollbar** (2026-11-21, Orca comparison C2).
  Reason: it keeps F8. Orca draws matches there because it has no prompt
  marks; NexTerm has them.
- **No search across agent transcripts** (2026-11-21, Orca comparison C4),
  deferred.
  Reason: reading conversation bodies widens what NexTerm reads of the user's
  data, and Orca's version does not mask secrets.
- **No Dock badge and no tray icon** (2026-11-21, Orca comparison C5).
  Reason: the notification bell and the Dock bounce already say a terminal
  wants you, and Orca dropped its own on purpose.
- **Inactive windows are not dimmed** (2026-11-21, Orca comparison C6).
  Reason: dimming would push terminal text under 4.5:1; the active pane's 1px
  violet ring already says where you are.
- **OSC 52 clipboard writes are off by default** (2026-11-21). Settings ▸
  Terminal turns them on; while they are off, the first write a terminal sees
  prints one notice in it (`src/lib/osc52.js`).
  Reason: anything that prints to a terminal, such as a file being shown or a
  log line, could set the clipboard, and the next paste would run what it put
  there. NexTerm ships the safe default.
