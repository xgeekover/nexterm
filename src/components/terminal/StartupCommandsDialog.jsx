import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { isMultiLine, MULTI_LINE_REASON } from '../../lib/startupCommands.js';
import { cn } from '../../lib/utils.js';

/**
 * One terminal's row: what it is called, where it opens, and the command it
 * types when the template opens.
 *
 * A single-line input on purpose, and one that refuses a multi-line paste
 * rather than taking it: an `<input>` quietly deletes the line breaks of what
 * is pasted into it, so `npm install` and `npm run dev` on two lines would
 * arrive as `npm installnpm run dev` — a command nobody wrote. The paste is
 * stopped and the row says why instead.
 */
export function StartupCommandField({ id, title, cwd, value, error, onChange, onRefuse, onSubmit, onCancel, inputRef }) {
  const refuseIfMultiLine = (e, text) => {
    if (!isMultiLine(text)) return;
    e.preventDefault();
    onRefuse?.();
  };
  return (
    <div className="py-1.5" data-startup-field={id}>
      <label htmlFor={`startup-${id}`} className="flex items-baseline gap-2 min-w-0 text-ui">
        <span className="shrink-0 max-w-[45%] truncate font-medium text-vsc-fg">{title}</span>
        {cwd ? (
          <span className="flex-1 min-w-0 truncate-start text-ui-sm text-vsc-muted">
            <bdi>{cwd}</bdi>
          </span>
        ) : null}
      </label>
      <input
        id={`startup-${id}`}
        ref={inputRef}
        type="text"
        value={value}
        placeholder="just a shell"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `startup-${id}-error` : undefined}
        onChange={(e) => onChange?.(e.target.value)}
        onPaste={(e) => refuseIfMultiLine(e, e.clipboardData?.getData('text'))}
        onDrop={(e) => refuseIfMultiLine(e, e.dataTransfer?.getData('text'))}
        onKeyDown={(e) => {
          // An Enter or Escape that ends an IME composition — a Korean path
          // typed into the field — belongs to the composition, not the dialog.
          if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
          // The dialog's keys, kept out of every other listener: Enter saves
          // and Escape cancels, as in every dialog in the app.
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            onSubmit?.();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel?.();
          }
        }}
        className={cn(
          'mt-1 w-full h-[24px] px-1.5 rounded-sm bg-vsc-input border text-ui font-mono text-vsc-fg outline-none',
          'placeholder:text-vsc-placeholder placeholder:font-sans',
          error ? 'border-vsc-error' : 'border-vsc-input-border focus:border-vsc-focus'
        )}
      />
      {error ? (
        <p id={`startup-${id}-error`} role="alert" className="m-0 mt-1 text-ui-sm text-vsc-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Edit Startup Commands…": the command each terminal of a saved group — or
 * of every group in a saved workspace — types when it is opened.
 *
 * `sections` is `[{ key, label, terminals: [{ key, title, cwd, command }] }]`:
 * one section for a saved group (no label), one per group for a workspace.
 * Every terminal's `key` is unique across all of them, and `onSave` gets the
 * drafts by those keys. It answers `{ ok: true }`, and the caller closes the
 * dialog, or `{ ok: false, errors }` — a reason by key — and the dialog stays
 * open with each reason under its field. Nothing is cleaned here; the store
 * does that, and says why it refused.
 *
 * Mounted when it opens and gone when it closes, so the drafts always start
 * from what is saved.
 */
export function StartupCommandsDialog({ title, intro, sections = [], onSave, onCancel }) {
  const [drafts, setDrafts] = useState(() => {
    const initial = {};
    for (const section of sections) {
      for (const terminal of section.terminals || []) initial[terminal.key] = terminal.command || '';
    }
    return initial;
  });
  const [errors, setErrors] = useState({});
  const firstFieldRef = useRef(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const save = () => {
    const result = onSave?.(drafts);
    if (result && result.ok === false) setErrors(result.errors || {});
  };

  const setDraft = (key, value) => {
    setDrafts((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _fixed, ...rest } = e;
      return rest;
    });
  };

  let first = true;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-commands-title"
        data-startup-commands-dialog=""
        onKeyDown={(e) => {
          // Escape from anywhere in it — a field handles its own first, and a
          // button has nothing else to do with the key.
          if (e.key !== 'Escape' || e.nativeEvent?.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          onCancel?.();
        }}
        className="w-[560px] max-w-[94vw] max-h-[76vh] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-vsc-fg"
      >
        <div className="h-[35px] shrink-0 px-3 flex items-center justify-between border-b border-vsc-border">
          <h2 id="startup-commands-title" className="m-0 text-ui font-semibold truncate">
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

        {intro ? <p className="m-0 px-3 pt-2.5 text-ui-sm text-vsc-muted">{intro}</p> : null}

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-1.5">
          {sections.map((section) => (
            <div key={section.key} className="py-1">
              {section.label ? (
                <h3 className="m-0 pt-1 text-ui-sm uppercase tracking-wide font-semibold text-vsc-muted">
                  {section.label}
                </h3>
              ) : null}
              {(section.terminals || []).map((terminal) => {
                const inputRef = first ? firstFieldRef : undefined;
                first = false;
                return (
                  <StartupCommandField
                    key={terminal.key}
                    id={terminal.key}
                    title={terminal.title}
                    cwd={terminal.cwd}
                    value={drafts[terminal.key] ?? ''}
                    error={errors[terminal.key]}
                    onChange={(value) => setDraft(terminal.key, value)}
                    onRefuse={() => setErrors((e) => ({ ...e, [terminal.key]: MULTI_LINE_REASON }))}
                    onSubmit={save}
                    onCancel={onCancel}
                    inputRef={inputRef}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div className="shrink-0 px-3 py-2.5 flex items-center justify-end gap-2 border-t border-vsc-border">
          <button
            type="button"
            onClick={onCancel}
            className="h-[26px] px-3 text-ui rounded-[3px] bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="h-[26px] px-3 text-ui rounded-[3px] text-vsc-accent-fg bg-vsc-accent hover:bg-vsc-accent-hover"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default StartupCommandsDialog;
