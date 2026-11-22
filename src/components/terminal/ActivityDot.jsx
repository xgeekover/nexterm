import React from 'react';
import { CircleX } from 'lucide-react';
import { tabActivity } from '../../lib/tabActivity.js';
import { cn } from '../../lib/utils.js';

/**
 * The mark on a terminal tab and on a group chip: a pulsing violet dot while
 * a command runs, a circled cross in the error red when the last one failed,
 * nothing otherwise. Unread notifications are not this mark's business: the
 * `UnreadPill` beside the title counts them.
 *
 * Two shapes as well as two colours, so the states stay apart for whoever
 * cannot tell violet from red, and in forced colours (Windows High Contrast),
 * which takes both colours away. There index.css paints the dot, a
 * background the mode would blank, in Highlight, and the cross, which keeps
 * a colour set on itself, in CanvasText. The cross is lucide's `CircleX`,
 * the icon StatusBoard draws for a failed command, so the two places agree.
 *
 * Small on purpose. A tab strip is chrome, and this has to read at a glance
 * without competing with the name beside it — the question it answers is "is
 * anything happening over there", not "what happened". The cross is drawn
 * at 10px, with the 1px line StatusBoard's 12px icons have, centred in a box
 * of the dot's 6px that it hangs 2px out of on either side: a caller's
 * classes go on that box, as on the dot, so a command failing moves nothing
 * beside it (the TERMINALS side bar keeps a 6px slot for the mark).
 *
 * The pulse is `animate-pulse`, which `:root.reduce-motion` in index.css stops
 * dead along with every other animation, so the Settings toggle and the OS
 * preference both cover it without this component knowing about either.
 *
 * `aria-hidden` because it is decoration: the state is already in the tab's
 * own `title`, which is what a screen reader reads (see `activityLabel`).
 */
export function ActivityDot({ tab, state: given, className }) {
  const state = given ?? tabActivity(tab);

  if (state === 'running') {
    return (
      <span
        aria-hidden="true"
        data-activity="running"
        className={cn('w-[6px] h-[6px] rounded-full shrink-0 bg-vsc-accent animate-pulse', className)}
      />
    );
  }
  if (state === 'failed') {
    return (
      <span aria-hidden="true" className={cn('w-[6px] h-[6px] shrink-0 flex items-center justify-center', className)}>
        <CircleX
          size={10}
          strokeWidth={2.4}
          aria-hidden="true"
          data-activity="failed"
          className="shrink-0 text-vsc-error"
        />
      </span>
    );
  }
  return null;
}

export default ActivityDot;
