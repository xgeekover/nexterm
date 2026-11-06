import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { runProblem, useProjectCommandsStore } from '../../stores/projectCommandsStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { useSystemStore } from '../../stores/systemStore.js';
import { useTerminalStore } from '../../stores/terminalStore.js';
import { COMMANDS_FILE, renderCommand } from '../../lib/projectCommands.js';
import {
  BUSY_DETAIL,
  BUSY_REASON,
  TYPE_ONLY_NOTE,
  activationCounts,
  asSentence,
  pinTarget,
  runDialogKey,
  runTargetView,
  runTargets,
  targetShell,
} from '../../lib/projectCommandRun.js';
import { isMultiLine } from '../../lib/startupCommands.js';
import { focusTerminal, focusWorkspace } from '../../lib/workspaceFocus.js';
import { swallowRepeatsOf } from '../../lib/heldKeys.js';
import { holdModal } from '../../lib/modalLock.js';
import { dialogReturn, focusBack } from '../../lib/dialogReturn.js';
import { backdropCancels } from '../common/ConfirmDialog.jsx';
import { cn } from '../../lib/utils.js';

/**
 * Why a paste into a value was not taken. An `<input>` quietly deletes the
 * line breaks of what is pasted into it, so two lines would arrive as one
 * word nobody wrote — the paste is stopped instead, and this says why.
 */
export const MULTI_LINE_VALUE = 'Not pasted: it is more than one line, and a value is one word of one line. Paste one line.';

/**
 * The line in the order it is typed: a right-to-left word in it (`cp א ב`)
 * is otherwise drawn reordered, and what is read is not what runs.
 */
const LINE_ORDER = { direction: 'ltr', unicodeBidi: 'bidi-override' };

const buttonClass =
  'h-[26px] px-3 text-ui rounded-[3px] disabled:opacity-50 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vsc-focus';

/**
 * One blank of the command: its label, what it is for, and a field — a
 * select for a blank with choices — with a line under it, always there,
 * for why its value cannot be typed. The line keeps its height when it is
 * empty, so nothing below it moves as a reason comes and goes.
 */
export function BlankField({ placeholder, value, error, onChange, onRefusePaste, inputRef }) {
  const id = `project-blank-${placeholder.name}`;
  const describedBy = [placeholder.description ? `${id}-description` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const refuseIfMultiLine = (e, text) => {
    if (!isMultiLine(text)) return;
    e.preventDefault();
    onRefusePaste?.();
  };
  const fieldClass = cn(
    'mt-1 w-full h-[24px] px-1.5 rounded-sm bg-vsc-input border text-ui font-mono text-vsc-fg outline-none',
    error ? 'border-vsc-error' : 'border-vsc-input-border focus:border-vsc-focus'
  );
  return (
    <div data-blank-field={placeholder.name} className="py-0.5">
      <label htmlFor={id} className="block text-ui font-medium text-vsc-fg break-words">
        {placeholder.label}
      </label>
      {placeholder.description ? (
        <p id={`${id}-description`} className="m-0 text-ui-sm text-vsc-muted break-words">
          {placeholder.description}
        </p>
      ) : null}
      {placeholder.choices ? (
        <select
          id={id}
          ref={inputRef}
          value={value}
          data-run-focus=""
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => onChange?.(e.target.value)}
          className={fieldClass}
        >
          {placeholder.choices.map((choice, i) => (
            <option key={i} value={choice}>
              {choice === '' ? '(nothing)' : choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          ref={inputRef}
          type="text"
          value={value}
          data-run-focus=""
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(e) => onChange?.(e.target.value)}
          onPaste={(e) => refuseIfMultiLine(e, e.clipboardData?.getData('text'))}
          onDrop={(e) => refuseIfMultiLine(e, e.dataTransfer?.getData('text'))}
          className={fieldClass}
        />
      )}
      <p
        id={`${id}-error`}
        data-blank-error={placeholder.name}
        role={error ? 'alert' : undefined}
        title={error || undefined}
        className="m-0 mt-0.5 h-[28px] text-ui-sm text-vsc-error line-clamp-2"
      >
        {error || ''}
      </p>
    </div>
  );
}

/**
 * The line as it will be typed, in the order it is typed, the values set
 * apart from the command's own text — and a blank whose value cannot be
 * typed shown as the blank, in the error colour. A fixed height, scrolled,
 * and focusable to scroll from the keyboard: a value growing as it is typed
 * never moves the buttons under it. When the line is longer than the box,
 * its heading says so — the end of a line is where a second command hides.
 */
export function RunPreview({ rendered, label, previewId, headingId, overflows = false, preRef }) {
  return (
    <div className="pt-1">
      <div className="flex items-baseline justify-between gap-2">
        <div id={headingId} className="text-ui font-medium text-vsc-fg">
          {label ? `Typed into ${label}` : 'Nowhere to type it'}
        </div>
        <div data-run-preview-more="" className="text-ui-sm text-vsc-warn">
          {overflows ? 'Longer than the box: scroll it to read the whole line' : ''}
        </div>
      </div>
      <pre
        ref={preRef}
        id={previewId}
        data-run-preview=""
        data-run-focus=""
        tabIndex={0}
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-labelledby={headingId}
        style={LINE_ORDER}
        className="m-0 mt-1 h-[64px] overflow-y-auto font-mono text-ui text-vsc-fg whitespace-pre-wrap break-all bg-vsc-input border border-vsc-input-border rounded-sm px-1.5 py-1 outline-none focus:border-vsc-focus"
      >
        {rendered.parts.map((part, i) =>
          'blank' in part ? (
            <span
              key={i}
              data-blank={part.blank}
              className={rendered.errors[part.blank] ? 'text-vsc-error' : 'text-vsc-link underline decoration-dotted'}
            >
              {part.text}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
      </pre>
      <p data-run-line-error="" role={rendered.lineError ? 'alert' : undefined} className="m-0 mt-0.5 h-[16px] truncate text-ui-sm text-vsc-error" title={rendered.lineError ? asSentence(rendered.lineError) : undefined}>
        {rendered.lineError ? `${asSentence(rendered.lineError)}.` : ''}
      </p>
    </div>
  );
}

/**
 * Where the line goes: the terminal the dialog was opened over, unless it
 * cannot take the line now — something runs in it, something is typed at
 * its prompt, it never says where its prompt is — which it says on its own
 * line; or a new split beside it, whose shell the preview is quoted for.
 * With no terminal at all, a new one. The choice is the user's: a terminal
 * that becomes busy keeps its choice, with Run off and the reason said.
 */
export function RunTargets({ targets, choice, name, onChoose }) {
  const option = (value, text, why) => (
    <label
      data-run-target={value}
      title={why === BUSY_REASON ? BUSY_DETAIL : why ? `Not offered: ${why}.` : undefined}
      className={cn('flex items-center gap-2 h-[22px] min-w-0 text-ui', why ? 'text-vsc-muted' : 'text-vsc-fg cursor-pointer')}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={choice === value}
        disabled={Boolean(why)}
        data-run-focus=""
        onChange={() => onChoose(value)}
        className="h-[14px] w-[14px] accent-current flex-shrink-0"
      />
      {/* One line, so the options below never move as one becomes busy:
          the reason's first part here, all of it in the tooltip and — for
          the chosen one — under the buttons. */}
      <span className="truncate">{why ? `${text} — not offered: ${why.split(' — ')[0]}` : text}</span>
    </label>
  );
  return (
    <fieldset data-run-targets="" className="m-0 p-0 border-0 min-w-0">
      <legend className="p-0 text-ui font-medium text-vsc-fg">Type it into</legend>
      <div className="mt-1 flex flex-col">
        {targets.this ? option('this', `This terminal (${targets.this.title})`, targets.this.busy) : null}
        {targets.split ? option('split', 'New split', targets.split.busy) : null}
        {targets.newTab ? option('new-tab', 'New terminal', null) : null}
      </div>
    </fieldset>
  );
}

/**
 * The run dialog of a project or user command (spec D7). Open while the
 * store holds `running`; keyed by it, so each opening starts afresh.
 */
export function ProjectCommandDialog() {
  const running = useProjectCommandsStore((s) => s.running);
  if (!running) return null;
  return <RunDialog key={running.id} run={running} />;
}

/**
 * Why Run is off, in words (shown under the buttons as well as on them):
 * the file changed or is no longer trusted, the target cannot take the line,
 * the line or a value cannot be typed.
 */
function whyNot({ stale, shell, choice, rendered }) {
  if (stale) return `${asSentence(stale)}.`;
  if (!shell) return 'There is no terminal to type it into.';
  if (shell.busy) return `${choice === 'this' ? 'This terminal' : choice === 'split' ? 'New split' : 'New terminal'}: ${shell.busy}.`;
  if (rendered.lineError) return `${asSentence(rendered.lineError)}.`;
  if (!rendered.ok) return `A value above cannot be typed for ${shell.label}.`;
  return null;
}

/**
 * Its blanks, where the line goes, the exact line for that terminal's shell,
 * and Run (the line and Enter), Type Only (the line, no Enter) or Cancel —
 * for a command with no blanks too: always a look before Enter.
 *
 * - The terminal is pinned as it opens (`pinTarget`): the line goes into
 *   that terminal, or a new split beside it, never into whichever is active
 *   by then. One that closes or restarts its shell takes nothing; the dialog
 *   says why.
 * - A new split is the choice it opens with. Into the terminal already open
 *   the line is only typed and left at its prompt — Type is the button there,
 *   Run is off, and the dialog says why (TYPE_ONLY_NOTE): what its shell
 *   still holds cannot be known from outside it.
 * - While it is open the app's chords and menu do nothing (modalLock.js),
 *   and the keyboard stays in it.
 * - Keyboard only, end to end: the first field has the keyboard (Run or
 *   Type, with no blanks), Enter in a field runs — or types, into the
 *   terminal already open — when the line can be typed, Enter on a button is
 *   that button, Escape cancels, Tab goes round inside.
 * - Nothing runs before the line could be read: Run, Type Only and Enter do
 *   nothing for ACTIVATION_GRACE_MS after it opens — from the keyboard too,
 *   two quick Enters ran a line never seen — and a held Enter runs nothing.
 *   The Enter that commits a Hangul syllable is the syllable's.
 * - Run, Type Only and Enter type once per opening: the first closes the
 *   dialog (`submitRun`), which re-reads the values as they are then.
 *
 * Reads of the terminal store are the primitives `runTargetView` picks:
 * a terminal starting a program redraws this; one printing output does not.
 */
function RunDialog({ run }) {
  const { command } = run;
  const closeRun = useProjectCommandsStore((s) => s.closeRun);
  const submitRun = useProjectCommandsStore((s) => s.submitRun);
  const stale = useProjectCommandsStore((s) => runProblem(s, run));
  const [pinned] = useState(() => pinTarget(useTerminalStore.getState()));
  const view = useTerminalStore(useShallow((s) => runTargetView(s, pinned)));
  const defaultShell = useSettingsStore((s) => s.terminalDefaultShell);
  const splitCwd = useSettingsStore((s) => s.terminalSplitCwd);
  const os = useSystemStore((s) => s.os);
  const systemShell = useSystemStore((s) => s.defaultShell);
  const targets = useMemo(
    () => runTargets(view, { defaultShell, systemShell, os, splitCwd }),
    [view, defaultShell, systemShell, os, splitCwd]
  );

  // Chosen once, as it opens; from then on the user's — never switched to
  // another target because this one became busy (review M4).
  const [choice, setChoice] = useState(() => targets.initial);
  const shell = targetShell(targets, choice);
  const [values, setValues] = useState(() => Object.fromEntries(command.placeholders.map((p) => [p.name, p.default])));
  // The values as typed, read at Run: the Enter that commits an IME
  // syllable can come before the render that holds it.
  const valuesRef = useRef(values);
  const [refusedPaste, setRefusedPaste] = useState({});
  const rendered = useMemo(() => renderCommand(command, values, shell?.kind ?? 'unknown'), [command, values, shell?.kind]);
  const why = whyNot({ stale, shell, choice, rendered });
  const canType = !why;
  // Into a terminal already open the line is only typed, never run (review
  // round 3, TYPE_ONLY_NOTE): there Type is the dialog's button, and Run is
  // for a new split or a new terminal.
  const typeOnly = choice === 'this';
  const canRun = canType && !typeOnly;

  const boxRef = useRef(null);
  const firstFieldRef = useRef(null);
  const runRef = useRef(null);
  const typeRef = useRef(null);
  const cancelRef = useRef(null);
  const previewRef = useRef(null);
  const openedAtRef = useRef(null);
  const sentRef = useRef(false);
  const compositionEndRef = useRef(-Infinity);
  // Where the keyboard goes as this closes: the terminal typed into, or back.
  const afterCloseRef = useRef(null);
  const [overflows, setOverflows] = useState(false);
  const [returnTo] = useState(() => dialogReturn());

  const cancel = () => {
    sentRef.current = true;
    closeRun();
  };

  const submit = (asked) => {
    if (sentRef.current || !activationCounts(openedAtRef.current, Date.now())) return;
    // Never an Enter into a terminal already open: Enter in a field there types.
    const enter = asked && choice !== 'this';
    const latest = renderCommand(command, valuesRef.current, shell?.kind ?? 'unknown');
    if (whyNot({ stale, shell, choice, rendered: latest })) return;
    sentRef.current = true;
    afterCloseRef.current = choice === 'this' ? 'terminal' : null;
    if (choice === 'this') useSettingsStore.getState().setActiveView?.('terminal');
    submitRun(run.id, {
      target: choice,
      tabId: pinned?.tabId ?? null,
      sessionId: pinned?.sessionId ?? null,
      line: latest.line,
      enter,
      kind: shell.kind,
      label: shell.label,
      // A value typed for this shell's quoting: the line is for this shell.
      quoted: latest.parts.some((part) => 'blank' in part && part.text !== ''),
    });
  };

  // Read by the key listener, which is set up once per opening.
  const actionsRef = useRef({ cancel, submit });
  actionsRef.current = { cancel, submit };

  // The app's chords and menu do nothing while this is open (modalLock.js).
  useEffect(() => holdModal(), []);

  useEffect(() => {
    const box = boxRef.current;
    const focused = document.activeElement;
    const opener = returnTo ?? (box?.contains(focused) || focused === document.body ? null : focused);
    openedAtRef.current = Date.now();
    const usable = (ref) => (ref.current && !ref.current.disabled ? ref.current : null);
    const first = firstFieldRef.current ?? usable(runRef) ?? usable(typeRef) ?? cancelRef.current;
    first?.focus();

    // In the capture phase, ahead of the element the key was aimed at: a
    // terminal behind the dialog must not also get a key the dialog keeps.
    const onKey = (e) => {
      const inBox = Boolean(box?.contains(e.target));
      const tag = e.target?.tagName;
      const where = !inBox ? 'other' : tag === 'BUTTON' ? 'button' : tag === 'INPUT' || tag === 'SELECT' ? 'field' : 'other';
      const action = runDialogKey(e, where, { msSinceCompositionEnd: Date.now() - compositionEndRef.current });
      if (action === 'pass') return;
      e.preventDefault();
      e.stopPropagation();
      // Closed by a key, the rest of that key's repeats would reach what has
      // the keyboard next — the terminal, as empty lines after the command,
      // or as Escapes into the program running there.
      if (action === 'cancel') {
        swallowRepeatsOf('Escape');
        actionsRef.current.cancel();
      } else if (action === 'run') {
        swallowRepeatsOf('Enter');
        actionsRef.current.submit(true);
      } else if (action === 'next' || action === 'previous') {
        const stops = Array.from(box?.querySelectorAll('[data-run-focus]') ?? []).filter(
          (el) => !el.disabled && (el.type !== 'radio' || el.checked)
        );
        if (stops.length === 0) return;
        const at = stops.indexOf(e.target);
        const next = at === -1 ? (action === 'previous' ? stops.length - 1 : 0) : (at + (action === 'previous' ? stops.length - 1 : 1)) % stops.length;
        stops[next]?.focus();
      }
    };
    // The keyboard stays in the dialog: a pane made active behind it takes
    // focus as it does (TerminalView), and the next keys went to its shell.
    const onFocusIn = (e) => {
      if (!box || box.contains(e.target)) return;
      (firstFieldRef.current ?? box).focus?.();
    };
    // When a field's IME composition ended: the plain Enter Chrome sends
    // right after the one that commits a Hangul syllable is the syllable's.
    const onCompositionEnd = () => {
      compositionEndRef.current = Date.now();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    box?.addEventListener('compositionend', onCompositionEnd, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      box?.removeEventListener('compositionend', onCompositionEnd, true);
      // Still on the page: not closed — React's StrictMode runs the effects
      // of a dialog that just opened twice in development, and giving the
      // keyboard back between the two sent a focus report to the terminal.
      if (box?.isConnected) return;
      // Closing unmounts the control that had the keyboard, and it fell to
      // the page. Typed into this terminal: the terminal has it, to see the
      // line and, after Type Only, to edit or run it. A new split takes it
      // itself once it is the active pane. Otherwise back where it was.
      const now = document.activeElement;
      const lost = !now || now === document.body || Boolean(box?.contains(now));
      if (!lost) return;
      if (afterCloseRef.current === 'terminal' && focusTerminal()) return;
      focusBack(opener, () => focusWorkspace('terminal'));
    };
    // Once per opening; what it reads later is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whether the line is longer than its box, said in its heading.
  useEffect(() => {
    const pre = previewRef.current;
    if (!pre) return;
    const longer = pre.scrollHeight > pre.clientHeight + 1;
    setOverflows((was) => (was === longer ? was : longer));
  }, [rendered.line]);

  // Run and Type Only count only once the line could have been read — from
  // the pointer and from the keyboard alike (`detail` 0 is Enter or Space
  // on the button; a held Enter repeats on after the button has gone).
  const press = (e, enter) => {
    if (e.detail === 0) swallowRepeatsOf('Enter');
    if (!activationCounts(openedAtRef.current, Date.now())) return;
    submit(enter);
  };

  const titleId = `project-run-title-${run.id}`;
  const previewId = `project-run-preview-${run.id}`;
  const headingId = `project-run-heading-${run.id}`;
  const whyId = `project-run-why-${run.id}`;
  let firstField = true;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The keyboard stays in the dialog, whatever the press does: left to
        // the browser it went to the page, and Enter then reached nothing.
        e.preventDefault();
        if (e.detail > 1) return;
        if (backdropCancels(openedAtRef.current, Date.now())) cancel();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-project-run-dialog=""
        // A click on its words keeps the keyboard in the dialog (the box
        // takes it) rather than dropping it to the page.
        tabIndex={-1}
        onMouseDown={(e) => {
          // The second press of the double-click that chose the command lands
          // in here as it opens — on its title, say — and took the keyboard
          // from its first field. Moments after it opens, a press beside the
          // controls keeps it where it is; later the text is the user's to
          // select.
          if (!backdropCancels(openedAtRef.current, Date.now()) && !e.target.closest?.('input, select, button, label')) e.preventDefault();
        }}
        className="w-[600px] max-w-[94vw] max-h-[80vh] flex flex-col bg-vsc-widget border border-vsc-widget-border shadow-widget rounded-[3px] text-vsc-fg outline-none"
      >
        <div className="h-[35px] shrink-0 px-3 flex items-center justify-between gap-2 border-b border-vsc-border">
          <h2 id={titleId} title={command.name} className="m-0 text-ui font-semibold truncate">
            {command.name}
          </h2>
          <button
            type="button"
            onClick={cancel}
            title="Close"
            className="p-1 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2">
          <div>
            <p data-run-source="" className="m-0 text-ui-sm text-vsc-muted">
              {command.source === 'user' ? 'From your User Commands' : `From ${COMMANDS_FILE} in this folder`}
            </p>
            {command.description ? <p className="m-0 mt-0.5 text-ui text-vsc-fg break-words">{command.description}</p> : null}
          </div>

          {command.placeholders.length > 0 ? (
            <div data-run-blanks="">
              {command.placeholders.map((placeholder) => {
                const inputRef = firstField ? firstFieldRef : undefined;
                firstField = false;
                const error = refusedPaste[placeholder.name] ?? (rendered.errors[placeholder.name] ? asSentence(rendered.errors[placeholder.name]) : null);
                return (
                  <BlankField
                    key={placeholder.name}
                    placeholder={placeholder}
                    value={values[placeholder.name] ?? ''}
                    error={error}
                    inputRef={inputRef}
                    onChange={(value) => {
                      valuesRef.current = { ...valuesRef.current, [placeholder.name]: value };
                      setValues(valuesRef.current);
                      setRefusedPaste((r) => {
                        if (!(placeholder.name in r)) return r;
                        const { [placeholder.name]: _gone, ...rest } = r;
                        return rest;
                      });
                    }}
                    onRefusePaste={() => setRefusedPaste((r) => ({ ...r, [placeholder.name]: MULTI_LINE_VALUE }))}
                  />
                );
              })}
            </div>
          ) : null}

          <RunTargets targets={targets} choice={choice} name={`project-run-target-${run.id}`} onChoose={setChoice} />

          <RunPreview
            rendered={rendered}
            label={shell?.label ?? null}
            previewId={previewId}
            headingId={headingId}
            overflows={overflows}
            preRef={previewRef}
          />
          {/* Why there is no Run into this terminal, said where Run's own
              words would be — not only on a button that is off. */}
          <p data-run-mode="" className={cn('m-0 text-ui-sm', typeOnly ? 'text-vsc-fg' : 'text-vsc-muted')}>
            {typeOnly ? TYPE_ONLY_NOTE : 'Run types the line and presses Enter. Type Only leaves it at the prompt, for you to edit or run.'}
          </p>
        </div>

        <div className="shrink-0 px-3 py-2.5 flex items-center justify-end gap-2 border-t border-vsc-border">
          {/* Why Run is off, in words — not only in a tooltip. One line, so
              the buttons beside it never move as it comes and goes. */}
          <p id={whyId} data-run-why="" title={why ?? undefined} className="m-0 mr-auto min-w-0 flex-1 truncate text-ui-sm text-vsc-error">
            {why ?? ''}
          </p>
          <button
            ref={cancelRef}
            type="button"
            data-run-focus=""
            onClick={(e) => {
              if (e.detail === 0) swallowRepeatsOf('Enter');
              cancel();
            }}
            className={cn(buttonClass, 'bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover')}
          >
            Cancel
          </button>
          {/* Into a terminal already open: Type is the button (the accent
              one), and Run is off — the note above says why. */}
          <button
            ref={typeRef}
            type="button"
            data-run-focus=""
            data-run-type-only=""
            disabled={!canType}
            title={why ?? undefined}
            aria-describedby={canType ? previewId : whyId}
            onClick={(e) => press(e, false)}
            className={cn(
              buttonClass,
              typeOnly ? 'text-vsc-accent-fg bg-vsc-accent hover:bg-vsc-accent-hover' : 'bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover'
            )}
          >
            {typeOnly ? 'Type' : 'Type Only'}
          </button>
          <button
            ref={runRef}
            type="button"
            data-run-focus=""
            data-run-run=""
            disabled={!canRun}
            title={why ?? (typeOnly ? TYPE_ONLY_NOTE : undefined)}
            aria-describedby={canRun ? previewId : whyId}
            onClick={(e) => press(e, true)}
            className={cn(
              buttonClass,
              typeOnly ? 'bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover' : 'text-vsc-accent-fg bg-vsc-accent hover:bg-vsc-accent-hover'
            )}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProjectCommandDialog;
