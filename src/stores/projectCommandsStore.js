/**
 * The commands a folder names in `.nexterm/commands.json`, the user's own
 * from Settings, and whether the folder's are trusted (spec D5–D8).
 *
 * The file is somebody else's text that ends up in the user's shell, so
 * nothing here ever types anything: the store reads, keeps what was read
 * and what is trusted, and opens the two dialogs — the review that trusts
 * one content of the file in one folder, and the run dialog that shows the
 * exact line before anything is typed. Typing is the terminal store's
 * (`runProjectCommand`), once the user has pressed Run.
 *
 * Reading (D6): the backend's `project_commands_read`, which reads only the
 * open folder's file and says why when it will not. Read again when the
 * folder changes, when something under `.nexterm` changes on disk, and when
 * the palette opens. A read that finds the same bytes (the same SHA-256)
 * changes nothing at all, so the palette's rows never move under the pointer
 * for a read that found nothing new; a read that answers for a folder that
 * is no longer open is dropped.
 *
 * Trust (D5) is kept as `(folder, SHA-256)` pairs in localStorage, through
 * projectCommands.js's helpers: any changed byte, and the commands are
 * reviewed again before they are offered.
 */
import { create } from 'zustand';
import { invoke, listen } from '../lib/ipc.js';
import { loadState, saveState } from '../lib/persistence.js';
import { isInside, join, samePath } from '../lib/paths.js';
import {
  COMMANDS_FILE,
  EXAMPLE_COMMANDS_FILE,
  LIMITS,
  TRUST_KEY,
  displayText,
  forgetting,
  normalizeTrust,
  parseCommandsFile,
  trustOf,
  trusting,
} from '../lib/projectCommands.js';
import { asSentence } from '../lib/projectCommandRun.js';
import { notifyTerminal } from '../lib/terminalNotice.js';
import { useEditorStore } from './editorStore.js';
import { useSettingsStore } from './settingsStore.js';
import { useTerminalStore } from './terminalStore.js';

/** How long changes under `.nexterm` are let settle before the file is read again. */
export const REREAD_DELAY_MS = 200;

const STATUSES = new Set(['none', 'ok', 'refused', 'error']);
const SHA256 = /^[0-9a-f]{64}$/u;

/** The folder's `.nexterm`, written with the folder's own separator. */
export function commandsDirOf(root) {
  return join(root, '.nexterm');
}

/** The folder's `.nexterm/commands.json`, written with the folder's own separator. */
export function commandsFileOf(root) {
  return join(commandsDirOf(root), 'commands.json');
}

/**
 * The open folder as far as reading goes: its path, null when none is open,
 * or undefined while the editor has not yet asked the backend — until then
 * `rootPath` is only the browser mock's placeholder.
 */
function folderNow() {
  const editor = useEditorStore.getState();
  if (!editor?.rootResolved) return undefined;
  return typeof editor.rootPath === 'string' && editor.rootPath ? editor.rootPath : null;
}

/** Whether `a` and `b` name the same folder (null for none). */
function sameFolder(a, b) {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return samePath(a, b);
}

/**
 * The user's commands from Settings: what `parseCommandsFile` says of the
 * text, or null when there is none. Worked out once per text: the palette,
 * the run dialog and Settings all ask for the same one.
 */
let userMemo = { text: undefined, parsed: null };
export function userCommandsFrom(text) {
  if (text === userMemo.text) return userMemo.parsed;
  const parsed =
    typeof text === 'string' && text.trim() !== '' ? parseCommandsFile(text, { source: 'user', maxLength: LIMITS.userText }) : null;
  userMemo = { text, parsed };
  return parsed;
}

/**
 * What Settings says under the User Commands field, as it is typed (spec
 * D8): `{ tone, lines }` — 'muted' for an empty field, 'error' for a text
 * that is no commands file or holds a refused command (each with its
 * reason), 'ok' otherwise — the validator's words, not a guess.
 */
export function userCommandsCheck(text) {
  const parsed = userCommandsFrom(text);
  if (!parsed) return { tone: 'muted', lines: ['No user commands.'] };
  if (!parsed.ok) return { tone: 'error', lines: [`Not read: ${parsed.reason}`] };
  const n = parsed.commands.length;
  const count = `${n} command${n === 1 ? '' : 's'}`;
  if (parsed.refused.length === 0) return { tone: 'ok', lines: [`${count}, offered in the command palette with the hint User.`] };
  return {
    tone: 'error',
    lines: [
      `${count}; ${parsed.refused.length} refused, and not offered:`,
      ...parsed.refused.map((r) => `Command ${r.index + 1}${r.name ? ` (${r.name})` : ''}: ${asSentence(r.reason)}.`),
    ],
  };
}

/**
 * Why the command a run dialog was opened with may no longer be typed, or
 * null (review S2). A folder's command belongs to the file as it was when
 * trusted: another folder open since, the file read again with other bytes,
 * or its trust taken back, and the line shown is no longer one the user
 * trusted — Run is off in the dialog, and refused right before typing. The
 * user's own commands are theirs; nothing to ask.
 */
export function runProblem(state, run) {
  if (!run || run.command?.source !== 'project') return null;
  if (!sameFolder(state?.root ?? null, run.root ?? null)) return 'another folder is open now';
  if (state?.status !== 'ok' || state.sha256 !== run.sha256) return "this folder's commands file has changed since this opened — review it again";
  if (state.trust !== 'trusted') return "this folder's commands are no longer trusted";
  return null;
}

/** Whether the folder's commands — `status` 'ok', the file read — are trusted, by `entries`. */
function trustFor(entries, root, sha256, status) {
  return status === 'ok' && root && sha256 ? trustOf(entries, root, sha256) : 'untrusted';
}

/** The trust entries storage holds, cleaned; [] when it holds nothing usable or cannot be read. */
function storedTrust() {
  return normalizeTrust(loadState(TRUST_KEY, []));
}

/**
 * Say `message` where the user is looking: the active terminal, as every
 * other refusal of something typed on their behalf is said — else the
 * console, with no terminal to draw it.
 */
function say(message) {
  const tabId = useTerminalStore.getState()?.activeTabId ?? null;
  if (!notifyTerminal(tabId, message)) console.warn(`[ProjectCommands] ${message}`);
}

/** What a rejected backend call said, as one line of display text. */
function failureOf(err) {
  const raw = typeof err === 'string' ? err : err?.message ?? String(err);
  return displayText(raw, 300) || 'The backend did not say why.';
}

// The read loop (`refresh`). One read at a time, so the answers arrive in
// the order they were asked for; a refresh asked for while one is reading
// is one more read after it, never lost and never two at once.
let reading = null;
let wanted = false;
// Bumped whenever the open folder changes. A read remembers it as it starts;
// an answer that comes back under another one is for a folder no longer
// open, and is dropped.
let generation = 0;
// Ids for the dialogs, so a second Run on the same opening types nothing.
let opened = 0;
// `start` once: the subscriptions it makes.
let stopListening = null;

export const useProjectCommandsStore = create((set, get) => {
  /** Keep what `answer` said for `root`, or nothing at all when it says what is already kept. */
  const apply = (root, answer) => {
    let status = STATUSES.has(answer?.status) ? answer.status : 'error';
    let reason = status === 'refused' || status === 'error' ? displayText(String(answer?.reason ?? ''), 300) || 'The backend did not say why.' : null;
    let sha256 = null;
    let text = null;
    if (status === 'ok') {
      if (typeof answer.text !== 'string' || typeof answer.sha256 !== 'string' || !SHA256.test(answer.sha256)) {
        status = 'error';
        reason = 'The backend sent the file without its text or its hash.';
      } else {
        sha256 = answer.sha256;
        text = answer.text;
      }
    }
    const now = get();
    // The same answer as last time — the same bytes, read again: nothing is
    // set, so nothing is drawn again and no row moves.
    if (sameFolder(now.root, root) && now.status === status && now.reason === reason && now.sha256 === sha256) return;
    set({
      root,
      status,
      reason,
      sha256,
      project: status === 'ok' ? parseCommandsFile(text, { source: 'project' }) : null,
      trust: trustFor(now.trustEntries, root, sha256, status),
    });
  };

  /** One read of the open folder's file. */
  const readOnce = async () => {
    const root = folderNow();
    // Not known yet: the folder change that makes it known asks again.
    if (root === undefined) return;
    if (root === null) {
      apply(null, { status: 'none' });
      return;
    }
    const asked = generation;
    let answer;
    try {
      answer = await invoke('project_commands_read');
    } catch (err) {
      answer = { status: 'error', reason: failureOf(err) };
    }
    if (asked !== generation || !sameFolder(root, folderNow())) {
      // For the folder that was open when it was asked. The one open now is
      // read again — whoever changed the folder asked too, but one asked
      // for here costs nothing more when that is already pending.
      wanted = true;
      return;
    }
    // The backend says which folder it read (`root`; absent with no folder
    // open, and from an older backend). One that read another folder than
    // the one asked about — the folder changed in the backend first — is
    // not this folder's answer: dropped, and trust is never keyed to it.
    // The read the folder change asks for answers for the right one.
    if (typeof answer?.root === 'string' && !sameFolder(answer.root, root)) return;
    apply(root, answer);
  };

  const loop = async () => {
    // `reading` is set before any of this runs, so a refresh asked for from
    // here on sees it and waits its turn rather than starting a second loop.
    await null;
    try {
      while (wanted) {
        wanted = false;
        await readOnce();
      }
    } finally {
      reading = null;
    }
  };

  /** The folder changed: what was kept is for the one left, so it goes now, before the new one is read. */
  const folderChanged = () => {
    generation += 1;
    const root = folderNow();
    set({
      root: root ?? null,
      status: root ? 'reading' : root === null ? 'none' : 'idle',
      reason: null,
      sha256: null,
      project: null,
      trust: 'untrusted',
    });
    if (root !== undefined) get().refresh();
  };

  /** Whether an `fs-change` for `path` is about the open folder's `.nexterm` — the folder itself or anything in it. */
  const touchesCommands = (path) => {
    const root = get().root;
    if (!root || typeof path !== 'string' || !path) return false;
    const dir = commandsDirOf(root);
    return samePath(dir, path) || isInside(dir, path);
  };

  return {
    /** The folder the read below is of; null for none. */
    root: null,
    /**
     * What the last read said: 'idle' before anything could be read, 'reading'
     * while a new folder's first read is out, then the backend's own answer —
     * 'none' (no folder, no `.nexterm`, no file), 'ok', 'refused' (the folder
     * is on another computer, `.nexterm` or the file a link) or 'error' (not
     * a regular file, too big, not UTF-8). `reason` says why for the last two.
     */
    status: 'idle',
    reason: null,
    /** The SHA-256 of the file's bytes, for 'ok'. */
    sha256: null,
    /** What `parseCommandsFile` made of the file, for 'ok'. */
    project: null,
    /** Whether the folder's commands are trusted: 'trusted', 'changed' (since they were) or 'untrusted'. */
    trust: 'untrusted',
    /** Every folder trusted, `{ root, sha256, at }`, newest first (TRUST_KEY). */
    trustEntries: storedTrust(),
    /** The user's commands from Settings, parsed — null when the field is empty. */
    user: userCommandsFrom(useSettingsStore.getState()?.terminalUserCommands),
    /**
     * The review open now — `{ id, root, sha256, project, trust }`: what it
     * SHOWS. Trust is given to that, never to a read made after it opened.
     */
    reviewing: null,
    /** The run dialog open now — `{ id, command }` — or null. */
    running: null,

    /**
     * Read the open folder's file again. Resolves once the reads asked for
     * so far, and any asked for while they ran, are done.
     */
    refresh: () => {
      wanted = true;
      reading ??= loop();
      return reading;
    },

    /** Read the trust entries from storage again (a fresh start; the suites). */
    loadTrust: () => {
      const entries = storedTrust();
      set((s) => ({ trustEntries: entries, trust: trustFor(entries, s.root, s.sha256, s.status) }));
    },

    /**
     * Follow the open folder, the files under its `.nexterm`, and the user's
     * commands in Settings. Returns what stops it; started once however often
     * it is asked (StrictMode runs effects twice).
     */
    start: () => {
      if (stopListening) return stopListening;
      let live = true;
      let timer = null;
      let offFs = null;
      let lastFolder = folderNow();
      const offEditor = useEditorStore.subscribe((editor) => {
        const folder = editor?.rootResolved ? (typeof editor.rootPath === 'string' && editor.rootPath ? editor.rootPath : null) : undefined;
        if (folder === lastFolder || (folder && lastFolder && samePath(folder, lastFolder))) return;
        lastFolder = folder;
        folderChanged();
      });
      const offSettings = useSettingsStore.subscribe((settings, before) => {
        if (settings?.terminalUserCommands === before?.terminalUserCommands) return;
        set({ user: userCommandsFrom(settings?.terminalUserCommands) });
      });
      // A save, a `git pull`, a checkout: settled for a moment, then read.
      // Only what is under `.nexterm` — a build writes thousands of files,
      // none of them this one.
      listen('fs-change', (payload) => {
        if (!touchesCommands(payload?.path)) return;
        clearTimeout(timer);
        timer = setTimeout(() => get().refresh(), REREAD_DELAY_MS);
      }).then(
        (off) => {
          if (live) offFs = off;
          else off();
        },
        () => {}
      );
      set({ user: userCommandsFrom(useSettingsStore.getState()?.terminalUserCommands) });
      if (lastFolder !== undefined) folderChanged();
      const stop = () => {
        live = false;
        clearTimeout(timer);
        offEditor();
        offSettings();
        offFs?.();
        if (stopListening === stop) stopListening = null;
      };
      stopListening = stop;
      return stop;
    },

    /**
     * Every command the palette may offer: the folder's while they are
     * trusted, and the user's.
     */
    available: () => {
      const s = get();
      const project = s.status === 'ok' && s.trust === 'trusted' && s.project?.ok ? s.project.commands : [];
      const user = s.user?.ok ? s.user.commands : [];
      return [...project, ...user];
    },

    /** Open the review of the folder's commands, as they were last read. */
    openReview: () => {
      const s = get();
      if (s.status !== 'ok' || !s.project) return false;
      opened += 1;
      set({ reviewing: { id: opened, root: s.root, sha256: s.sha256, project: s.project, trust: s.trust } });
      return true;
    },

    closeReview: () => set({ reviewing: null }),

    /**
     * Trust what the review open now SHOWS: its folder and its hash. Not a
     * read made since — the file may have changed while the review was open,
     * and the user has seen only what it showed. Closes the review.
     */
    trustCurrent: () => {
      const shown = get().reviewing;
      if (!shown?.root || !shown.sha256) return false;
      const entries = trusting(get().trustEntries, shown.root, shown.sha256, Date.now());
      saveState(TRUST_KEY, entries);
      set((s) => ({ trustEntries: entries, trust: trustFor(entries, s.root, s.sha256, s.status), reviewing: null }));
      return true;
    },

    /**
     * "Stop Trusting This Folder's Commands": forget the open folder, so its
     * commands are reviewed again before they are offered. Only while they
     * are trusted; otherwise the user is told there is nothing to forget.
     */
    distrustCurrent: () => {
      const s = get();
      if (s.status !== 'ok' || s.trust !== 'trusted' || !s.root) {
        say("Nothing in this folder is trusted: its commands are not offered until you review them (Review This Folder's Commands… in the command palette).");
        return false;
      }
      const entries = forgetting(s.trustEntries, s.root);
      saveState(TRUST_KEY, entries);
      set((now) => ({ trustEntries: entries, trust: trustFor(entries, now.root, now.sha256, now.status) }));
      say(`This folder's commands are no longer trusted. They are reviewed again before the palette offers them.`);
      return true;
    },

    /** Open the run dialog for the command `key`, if it is one the palette may offer now. */
    openRun: (key) => {
      const s = get();
      const command = s.available().find((c) => c.key === key);
      if (!command) return false;
      opened += 1;
      // A folder's command is opened from the file as it was trusted: its
      // folder and hash go with it, and Run asks again that they still hold
      // (`runProblem`).
      set({ running: { id: opened, command, root: s.root, sha256: command.source === 'project' ? s.sha256 : null } });
      return true;
    },

    closeRun: () => set({ running: null }),

    /**
     * Run what run dialog `id` showed: close it, and have the terminal store
     * type `plan.line` (`runProjectCommand`). A second Run of the same
     * opening — a double-click, an Enter while the first is still typing —
     * finds it closed and types nothing. Resolves with whether it was typed.
     */
    submitRun: (id, plan) => {
      const open = get().running;
      if (!open || open.id !== id) return Promise.resolve(false);
      const stale = runProblem(get(), open);
      if (stale) {
        // The dialog shows why and keeps Run off; one that got here anyway
        // types nothing.
        say(`The command was not typed: ${stale}.`);
        return Promise.resolve(false);
      }
      set({ running: null });
      // Asked again right before the line is typed — after the wait for a
      // new split's shell, the file may have changed under it.
      const check = () => {
        const why = runProblem(get(), open);
        return why ? `${why}` : null;
      };
      return Promise.resolve(useTerminalStore.getState().runProjectCommand?.({ ...plan, check }) ?? false).catch((err) => {
        say(`The command was not typed: ${failureOf(err)}`);
        return false;
      });
    },

    /**
     * "Open Project Commands File": the open folder's `.nexterm/commands.json`
     * in the editor — made first, with a working example, when there is none
     * (an explicit pick, inside the open folder, through the backend's
     * confined file commands). Not when the backend refused to read it: a
     * `.nexterm` that is a link may lead to another computer, and opening it
     * would go there; nor when it is not a file to open (a FIFO would hang
     * the read). Resolves with whether a file was opened.
     */
    openCommandsFile: async () => {
      const root = folderNow();
      if (!root) {
        say(`No folder is open. Open a folder first: its commands go in ${COMMANDS_FILE} inside it.`);
        return false;
      }
      await get().refresh();
      const s = get();
      if (!sameFolder(s.root, root)) return false;
      if (s.status === 'refused' || s.status === 'error') {
        say(`${COMMANDS_FILE} not opened: ${s.reason}`);
        return false;
      }
      const path = commandsFileOf(root);
      if (s.status === 'none') {
        try {
          await invoke('fs_create_dir', { path: commandsDirOf(root) });
          // Made only where nothing is — no file, no link (`create_new`) —
          // and only then written.
          await invoke('fs_create_file', { path });
          await invoke('fs_write_file', { path, content: EXAMPLE_COMMANDS_FILE });
        } catch (err) {
          say(`Could not make ${COMMANDS_FILE}: ${failureOf(err)}`);
          return false;
        }
        await useEditorStore.getState().refreshExplorer?.();
      }
      await useEditorStore.getState().openFile(path);
      // On screen, with the keyboard, as a file picked in the palette is.
      useSettingsStore.getState().setActiveView?.('editor');
      useEditorStore.getState().focusEditor?.();
      return true;
    },
  };
});

export default useProjectCommandsStore;
