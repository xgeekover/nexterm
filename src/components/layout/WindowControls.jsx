import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { windowControls } from '../../lib/menuActions.js';
import { cn } from '../../lib/utils.js';

const button =
  'w-[46px] h-full flex items-center justify-center text-vsc-muted hover:text-vsc-fg transition-colors';

/**
 * Minimise / maximise / close for the frameless window off macOS. macOS keeps
 * its native traffic lights, so this is not rendered there.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      Promise.resolve(windowControls.isMaximized())
        .then((value) => {
          if (!cancelled) setMaximized(Boolean(value));
        })
        .catch(() => {});
    };
    sync();
    window.addEventListener('resize', sync);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', sync);
    };
  }, []);

  return (
    // Not a drag region: these must stay clickable.
    <div className="flex items-stretch h-full shrink-0 ml-1">
      <button type="button" title="Minimize" onClick={() => windowControls.minimize()} className={cn(button, 'hover:bg-vsc-item-hover')}>
        <Minus size={14} />
      </button>
      <button
        type="button"
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => windowControls.toggleMaximize()}
        className={cn(button, 'hover:bg-vsc-item-hover')}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        title="Close"
        onClick={() => windowControls.close()}
        className={cn(button, 'hover:bg-vsc-error hover:text-white')}
      >
        <X size={15} />
      </button>
    </div>
  );
}

export default WindowControls;
