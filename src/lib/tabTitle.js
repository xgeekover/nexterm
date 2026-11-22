/**
 * What a terminal is called wherever its name is drawn: its chip and the tab
 * strip, its TERMINALS row, the hidden-strip handle and the title
 * `nexterm-cli list` reports.
 *
 * Three names can claim a terminal, and the first one present wins:
 *
 *  1. The user's own name. `renameTab` keeps it as `title`; a terminal the
 *     user never named (or whose rename was cleared) has a `title` equal to
 *     its `defaultTitle`, so a `title` that differs from it is a name someone
 *     chose — whatever a program sends with `set-title` never covers it.
 *  2. The title a program in it gave it (`nexterm-cli set-title`), kept as
 *     `programTitle` by `setProgramTitle`, already cleaned there. Gone with
 *     `set-title --clear`, with the shell's exit and with a new shell.
 *  3. Its default name, `Terminal N`.
 *
 * Clearing a rename therefore shows the program's title again when there is
 * one. Nothing here is stored: Rename still stores what the user typed, and
 * the workspace never holds `programTitle`.
 *
 * What says WHO acted on a terminal — the "Controlled by" mark and the
 * control log's caller and target — names it by `nexTermTitle` instead,
 * which leaves out step 2: a program that could choose those names could
 * pass as another terminal (`set-title "Terminal 2"`) while it typed into a
 * third.
 */

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** Whether `tab` carries a name the user gave it (see above). */
export function hasUserTitle(tab) {
  const title = text(tab?.title);
  return title !== null && title !== tab.defaultTitle;
}

/**
 * The label to draw for `tab`; `fallback` when there is no tab or it has no
 * name of any kind.
 */
export function displayTitle(tab, fallback = 'Terminal') {
  if (!tab) return fallback;
  if (hasUserTitle(tab)) return tab.title;
  return text(tab.programTitle) ?? text(tab.defaultTitle) ?? text(tab.title) ?? fallback;
}

/**
 * NexTerm's own name for `tab`, which no program can set: the user's name,
 * else its default (`title`, else `defaultTitle`), never `programTitle`;
 * `fallback` when there is no tab or it has neither. For what says who acted
 * on a terminal (see above).
 */
export function nexTermTitle(tab, fallback = 'Terminal') {
  return text(tab?.title) ?? text(tab?.defaultTitle) ?? fallback;
}
