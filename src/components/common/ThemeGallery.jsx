import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, FileUp, Trash2, X } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { ANSI_COLOR_KEYS, APP_THEME_TOKENS, MAX_CUSTOM_THEMES, terminalThemeChoices } from '../../lib/terminalThemes.js';
import { cn } from '../../lib/utils.js';
import { useThemeGalleryStore } from '../../stores/themeGalleryStore.js';
import {
  AT_CAPACITY,
  NO_PREVIEW,
  THEME_PREVIEWING,
  chosenCardId,
  deleteTheme,
  importScheme,
  previewAfter,
  previewShown,
  scrollDeltaToShow,
  tabStopId,
  themeFromFile,
  undoDelete,
  undoOffered,
} from './themeGalleryModel.js';
import { createGalleryInput } from './themeGalleryInput.js';

/**
 * Settings ▸ Terminal ▸ Color Theme (spec P5): a card for every theme, built
 * in or imported, that shows the theme on every terminal while it is pointed
 * at or focused, and keeps it only when it is chosen. The rules are in
 * themeGalleryModel.js; this draws them.
 *
 * Every component here is declared at module level. One declared inside
 * another's render is a new type each render, React remounts it, and a real
 * click — press and release on the SAME element — never lands (see
 * TEST_INFRA.md); a scripted `.click()` would still have worked.
 *
 * Nothing in a card moves when it is pointed at, pressed or chosen: the
 * border is always there and only changes colour, and the check that marks
 * the chosen theme has its room kept on every card. Previewing changes the
 * terminals' colours behind the window, never the layout in front of it.
 *
 * The cards are a radio group: one Tab stop, the arrow keys move within it
 * and preview, Enter or Space chooses, and Delete removes an imported theme.
 * How keys, the pointer, focus and clicks are taken is themeGalleryInput.js's
 * — kept out of the component so CI can drive it as a browser does.
 */

/** A colour of `theme` for a style, or the app token that colour falls back to (`dark-modern`, and whatever an import left out). */
const colorOf = (theme, key) => theme?.[key] ?? `var(${APP_THEME_TOKENS[key]})`;

/**
 * What a theme looks like: a prompt line in its colours and its 16 ANSI
 * colours, on its background. The colours are the theme's own, so they are
 * kept in forced-colours mode (`forced-color-adjust-none`) — repainted in the
 * system's, every card would look the same. Hidden from screen readers: the
 * card's name says which theme it is.
 */
function ThemeSample({ theme }) {
  return (
    <span
      aria-hidden="true"
      className="block forced-color-adjust-none px-2 pt-2 pb-2"
      style={{ background: colorOf(theme, 'background'), color: colorOf(theme, 'foreground') }}
    >
      <span className="block font-mono text-[11px] leading-[14px] whitespace-nowrap overflow-hidden">
        <span style={{ color: colorOf(theme, 'green') }}>~/src</span>
        <span style={{ color: colorOf(theme, 'blue') }}> main</span>
        <span> $ ls</span>
        <span
          className="inline-block w-[6px] h-[12px] align-[-2px] ml-[2px]"
          style={{ background: colorOf(theme, 'cursor') }}
        />
      </span>
      {[ANSI_COLOR_KEYS.slice(0, 8), ANSI_COLOR_KEYS.slice(8)].map((row, r) => (
        <span key={r} className={cn('grid grid-cols-8 gap-[3px]', r === 0 ? 'mt-2' : 'mt-[3px]')}>
          {row.map((key) => (
            <span key={key} className="block h-[10px] rounded-[2px]" style={{ background: colorOf(theme, key) }} />
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * One theme: a radio in the gallery's group — checked when it is the chosen
 * theme, one Tab stop for the whole group (`tabStop`), Enter and Space
 * choosing it as a click does — with a check in front of the name saying so
 * to the eye in any colour mode. The whole name is its tooltip: a long one
 * is cut. An imported theme has a delete button beside it, outside the
 * radio (a button cannot hold another) and out of the Tab order: the
 * keyboard deletes with the Delete key on the card instead.
 */
function ThemeCard({ choice, chosen, tabStop, onCardClick, onFocusCard, onKeyNav, onTrashClick, cardRef }) {
  return (
    <div className="relative min-w-0" data-theme-card={choice.id}>
      <button
        ref={cardRef}
        type="button"
        role="radio"
        aria-checked={chosen}
        tabIndex={tabStop ? 0 : -1}
        title={choice.label}
        aria-keyshortcuts={choice.custom ? 'Delete' : undefined}
        onClick={(e) => onCardClick(e, choice.id)}
        onFocus={() => onFocusCard(choice.id)}
        onKeyDown={(e) => onKeyNav(e, choice)}
        className={cn(
          'block w-full text-left rounded-[4px] border-2 overflow-hidden outline-none transition-colors',
          'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-vsc-focus',
          chosen ? 'border-vsc-focus' : 'border-vsc-widget-border hover:border-vsc-muted'
        )}
      >
        <ThemeSample theme={choice.theme} />
        <span className="flex items-center gap-1 h-[24px] pl-1.5 pr-2 bg-vsc-input text-ui-sm text-vsc-fg">
          <span className="w-[12px] shrink-0 flex items-center justify-center">
            {chosen && <Check size={12} aria-hidden="true" />}
          </span>
          <span className="min-w-0 truncate">{choice.label}</span>
          {choice.custom && <span className="ml-auto shrink-0 text-vsc-muted">Imported</span>}
        </span>
      </button>
      {choice.custom && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => onTrashClick(e, choice.id)}
          aria-label={`Delete ${choice.label}`}
          title={`Delete ${choice.label}`}
          className="absolute top-1.5 right-1.5 p-[3px] rounded-sm border border-vsc-widget-border bg-vsc-widget text-vsc-muted hover:text-vsc-error hover:bg-vsc-input focus-visible:outline focus-visible:outline-1 focus-visible:outline-vsc-focus"
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * What an import or a delete did — or, for a file holding several Windows
 * Terminal schemes, the schemes to pick from, the refused ones listed with
 * their reasons.
 *
 * Held to the bottom of the visible part of the Settings list (`sticky`)
 * while the gallery is on screen: deleting a card in the top rows left the
 * Undo offer below the fold, out of sight. Its own room, under the cards —
 * it never pushes a card down under the pointer.
 *
 * Only the one-sentence summary is read out (the live region, always there
 * so the first result is heard too): the buttons and the reasons are there
 * to be moved through, not recited.
 */
export function ThemeNotice({ notice, canUndo = Boolean(notice?.undo), onPick, onUndo, onDismiss, boxRef, onFocusIn, onFocusOut }) {
  return (
    <div
      ref={boxRef}
      className={cn('sticky bottom-0 z-[1]', notice && 'bg-vsc-widget pt-2 pb-1')}
      data-theme-notice={notice?.kind ?? ''}
      onFocus={onFocusIn}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onFocusOut?.();
      }}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {notice?.text ?? ''}
      </div>
      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 px-2 py-1.5 rounded-sm border text-ui-sm bg-vsc-widget',
            notice.kind === 'error' ? 'border-vsc-error text-vsc-error' : 'border-vsc-widget-border text-vsc-fg'
          )}
        >
          {notice.kind === 'error' ? (
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          ) : notice.kind === 'pick' ? null : (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-vsc-ok" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p>{notice.text}</p>
            {notice.detail && <p className="mt-0.5 text-vsc-muted">{notice.detail}</p>}
            {notice.kind === 'pick' && (
              <ul className="mt-1.5 max-h-[180px] overflow-y-auto flex flex-col gap-0.5">
                {notice.schemes.map((scheme, i) => (
                  <li key={i}>
                    {scheme.ok ? (
                      <button
                        type="button"
                        onClick={(e) => onPick(scheme, e)}
                        className="inline-flex items-center gap-2 px-1.5 py-0.5 rounded-sm text-vsc-fg hover:bg-vsc-item-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vsc-focus"
                      >
                        <span
                          aria-hidden="true"
                          className="w-[12px] h-[12px] rounded-[2px] border border-vsc-widget-border forced-color-adjust-none"
                          style={{ background: colorOf(scheme.theme, 'background') }}
                        />
                        {scheme.name}
                      </button>
                    ) : (
                      <span className="block px-1.5 py-0.5 text-vsc-muted">{`${scheme.name}: ${scheme.error}`}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canUndo && (
              <button
                type="button"
                onClick={onUndo}
                className="mt-1 px-1.5 py-0.5 rounded-sm text-vsc-link hover:bg-vsc-item-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vsc-focus"
              >
                Undo
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
            className="shrink-0 p-0.5 rounded-sm text-vsc-muted hover:text-vsc-fg hover:bg-vsc-item-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vsc-focus"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** The nearest ancestor that scrolls vertically — the Settings window's list. */
function scrollParentOf(node) {
  for (let el = node?.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
  }
  return null;
}

export function ThemeGallery() {
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const customThemes = useSettingsStore((s) => s.terminalCustomThemes);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const previewTerminalTheme = useSettingsStore((s) => s.previewTerminalTheme);
  const notice = useThemeGalleryStore((s) => s.notice);
  const setNotice = useThemeGalleryStore((s) => s.setNotice);

  const choices = useMemo(() => terminalThemeChoices(customThemes), [customThemes]);
  const chosen = chosenCardId(terminalTheme, choices);

  const [previewState, setPreviewState] = useState(NO_PREVIEW);
  const [lastFocused, setLastFocused] = useState(null);
  const cardRefs = useRef(new Map());
  const fileRef = useRef(null);
  const noticeRef = useRef(null);
  const mounted = useRef(false);
  // A card to give the keyboard once it is drawn: one beside a deleted one,
  // one just imported or put back. The button that did it is gone by then,
  // and focus would otherwise fall to the page.
  const focusWhenDrawn = useRef(null);

  const preview = previewShown(previewState, chosen, choices);
  const tabStop = tabStopId(choices, { lastFocused, chosen });
  const dispatch = (event) => setPreviewState((state) => previewAfter(state, event));

  /**
   * Scroll the list just enough that `node` is not under the notice held at
   * its bottom, nor above the top: the notice covered the focused card, and
   * the Import button, entirely.
   */
  const keepInView = (node) => {
    const list = scrollParentOf(node);
    if (!node || !list) return;
    const view = list.getBoundingClientRect();
    const box = noticeRef.current?.getBoundingClientRect();
    const covered = box && box.height > 0 && !noticeRef.current.contains(node) ? Math.min(view.bottom, box.top) : view.bottom;
    const delta = scrollDeltaToShow(node.getBoundingClientRect(), { top: view.top, bottom: covered });
    if (delta) list.scrollTop += delta;
  };

  /** Focus a card (the browser fires its focus event, which decides about a preview) and keep it in view. */
  const focusCard = (id) => {
    const node = cardRefs.current.get(id);
    if (!node) return;
    node.focus({ preventScroll: true });
    keepInView(node);
  };

  /**
   * Write the store's theme settings: the list first, so a theme just
   * imported is there to be chosen. (Deleting the chosen one leaves the
   * setting naming a missing theme between the two writes, which the
   * resolver draws as the default — the theme it is about to be anyway.)
   */
  const commit = ({ themes, chosen: nextChosen }) => {
    if (themes) setSetting('terminalCustomThemes', themes);
    if (nextChosen !== undefined && nextChosen !== useSettingsStore.getState().terminalTheme) {
      setSetting('terminalTheme', nextChosen);
    }
  };

  /** A click, Enter or Space: the theme is kept, and the preview ends — whatever the pointer rests on. */
  const choose = (id) => {
    dispatch({ type: 'choose' });
    if (id !== useSettingsStore.getState().terminalTheme) setSetting('terminalTheme', id);
  };

  const onDelete = (id) => {
    const current = useThemeGalleryStore.getState().notice;
    const pending = undoOffered(current, useSettingsStore.getState().terminalCustomThemes) ? current.undo : null;
    const outcome = deleteTheme(useSettingsStore.getState(), id, pending);
    if (!outcome) return;
    dispatch({ type: 'reset' });
    // Beside the deleted card, not rows away — once the notice it brings is
    // drawn, so the card is kept clear of it.
    focusWhenDrawn.current = outcome.focusAfter;
    commit(outcome);
    setNotice(outcome.notice);
  };

  // What the controller acts on, read at the moment it acts: it is made once
  // and outlives every render.
  const latest = useRef(null);
  latest.current = { dispatch, focusCard, onDelete, choose, keepInView };
  const inputRef = useRef(null);
  if (!inputRef.current) {
    inputRef.current = createGalleryInput({
      dispatch: (event) => latest.current.dispatch(event),
      focusCard: (id) => latest.current.focusCard(id),
      deleteCard: (id) => latest.current.onDelete(id),
      choose: (id) => latest.current.choose(id),
      keepInView: (node) => latest.current.keepInView(node),
      later: (fn) => setTimeout(fn, 0),
      now: () => Date.now(),
    });
  }
  const input = inputRef.current;

  useEffect(() => {
    previewTerminalTheme(preview);
  }, [preview, previewTerminalTheme]);

  useEffect(() => {
    const onKeyDown = (e) => input.windowKeyDown(e);
    const onKeyUp = (e) => input.windowKeyUp(e);
    const onBlur = () => input.windowBlur();
    const onMove = (e) => input.windowPointerMove(e);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [input]);

  // After each render: the card the keyboard is owed, then the keyboard lost
  // with a notice that went away from under it.
  useEffect(() => {
    const id = focusWhenDrawn.current;
    if (id && cardRefs.current.has(id)) {
      focusWhenDrawn.current = null;
      focusCard(id);
    }
    const active = document.activeElement;
    input.afterRender({
      focusLost: !active || active === document.body || !document.contains(active),
      focusInNoticeNow: Boolean(noticeRef.current?.contains(active)),
      tabStop,
    });
  });

  // An Undo stands only while the imported themes are the list its deletes
  // left: Reset All, or any other change since, takes the offer back.
  useEffect(() => {
    if (notice?.undo && !undoOffered(notice, customThemes)) setNotice(null);
  }, [notice, customThemes, setNotice]);

  // Unmounted — Settings closed, or a search hid this row — puts the chosen
  // theme back. An Undo on offer stays in the store for when the gallery is
  // back; any other notice goes. Set again on mount: StrictMode mounts twice
  // in development.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewTerminalTheme(null);
      useThemeGalleryStore.getState().galleryClosed();
    };
  }, [previewTerminalTheme]);

  const onFocusCard = (id) => {
    setLastFocused(id);
    input.cardFocus(id);
  };

  const addScheme = (scheme, fileName) => {
    const outcome = importScheme(useSettingsStore.getState().terminalCustomThemes, scheme, fileName);
    if (outcome.themes) {
      dispatch({ type: 'reset' });
      focusWhenDrawn.current = outcome.chosen;
      commit(outcome);
    }
    setNotice(outcome.notice);
  };

  const onImport = () => {
    if (useSettingsStore.getState().terminalCustomThemes.length >= MAX_CUSTOM_THEMES) {
      setNotice({ kind: 'error', text: AT_CAPACITY });
      return;
    }
    fileRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    // Cleared, so picking the same file again is a change again.
    e.target.value = '';
    if (!file) return;
    const result = await themeFromFile(file);
    if (!mounted.current) return;
    if (result.kind === 'error') setNotice({ kind: 'error', text: result.text });
    else if (result.kind === 'pick') setNotice(result);
    else addScheme(result.scheme, result.fileName);
  };

  const onUndo = () => {
    const outcome = undoDelete(useSettingsStore.getState(), notice?.undo);
    if (!outcome) return;
    if (outcome.themes) {
      dispatch({ type: 'reset' });
      focusWhenDrawn.current = outcome.focus;
      commit(outcome);
    }
    setNotice(outcome.notice);
  };

  return (
    <div
      {...{ [THEME_PREVIEWING]: preview ? '' : undefined }}
      data-theme-gallery=""
      onKeyDown={(e) => input.galleryKeyDown(e, { preview, chosen })}
      onFocus={(e) => input.galleryFocus(e)}
    >
      <div
        role="radiogroup"
        aria-label="Terminal color themes"
        className="grid grid-cols-3 gap-2"
        onPointerMove={(e) => input.gridPointerMove(e)}
        onPointerLeave={() => input.gridPointerLeave()}
        onBlur={(e) => input.gridBlur(!e.currentTarget.contains(e.relatedTarget))}
      >
        {choices.map((choice) => (
          <ThemeCard
            key={choice.id}
            choice={choice}
            chosen={choice.id === chosen}
            tabStop={choice.id === tabStop}
            onCardClick={(e, id) => input.cardClick(e, id)}
            onFocusCard={onFocusCard}
            onKeyNav={(e, card) => input.cardKeyDown(e, card, choices)}
            onTrashClick={(e, id) => input.trashClick(e, id)}
            cardRef={(node) => {
              if (node) cardRefs.current.set(choice.id, node);
              else cardRefs.current.delete(choice.id);
            }}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onImport}
          className="shrink-0 inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-[3px] text-ui-sm bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-vsc-focus"
        >
          <FileUp size={14} aria-hidden="true" />
          Import Theme…
        </button>
        <span className="min-w-0 text-ui-sm text-vsc-muted">
          {`A Ghostty theme file, a Windows Terminal color scheme (.json) or an iTerm2 .itermcolors file. ${customThemes.length} of ${MAX_CUSTOM_THEMES} imported; Delete on an imported theme removes it.`}
        </span>
        {/* The webview's own file picker: the file's bytes reach the app,
            its path never reaches the backend. No `accept` filter — Ghostty's
            theme files have no extension, and a filter would grey them out. */}
        <input ref={fileRef} type="file" className="hidden" tabIndex={-1} aria-hidden="true" onChange={onFile} />
      </div>

      <ThemeNotice
        notice={notice}
        boxRef={noticeRef}
        canUndo={undoOffered(notice, customThemes)}
        onPick={(scheme, e) => {
          if (input.allowClick(e)) addScheme(scheme, notice?.fileName);
        }}
        onUndo={(e) => {
          if (input.allowClick(e)) onUndo();
        }}
        onDismiss={(e) => {
          if (input.allowClick(e)) setNotice(null);
        }}
        onFocusIn={() => input.noticeFocusIn()}
        onFocusOut={() => input.noticeFocusOut()}
      />
    </div>
  );
}

export default ThemeGallery;
