import React from 'react';
import { tabActivity } from '../../lib/tabActivity.js';
import { cn } from '../../lib/utils.js';

/**
 * The dot on a terminal tab: blue while a command runs, red when the last one
 * failed, nothing otherwise.
 *
 * Small on purpose. A tab strip is chrome, and this has to read at a glance
 * without competing with the name beside it — the question it answers is "is
 * anything happening over there", not "what happened".
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
  if (state !== 'running' && state !== 'failed') return null;

  return (
    <span
      aria-hidden="true"
      data-activity={state}
      className={cn(
        'w-[6px] h-[6px] rounded-full shrink-0',
        state === 'running' ? 'bg-vsc-accent animate-pulse' : 'bg-vsc-error',
        className
      )}
    />
  );
}

export default ActivityDot;
