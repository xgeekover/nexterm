import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * VS Code-style modal confirmation. Replaces the native `confirm()` which
 * blocks the whole webview and cannot be styled.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    confirmRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel?.();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-[440px] max-w-[92vw] bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-vsc-fg"
      >
        <div className="h-[35px] px-3 flex items-center justify-between border-b border-vsc-border">
          <h2 id="confirm-dialog-title" className="text-ui font-semibold m-0">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            title="Close"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3 py-3 text-ui text-vsc-fg">{message}</div>
        <div className="px-3 pb-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-[26px] px-3 text-ui rounded-[3px] bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              'h-[26px] px-3 text-ui rounded-[3px] text-vsc-accent-fg',
              danger ? 'bg-vsc-error hover:opacity-90' : 'bg-vsc-accent hover:bg-vsc-accent-hover'
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
