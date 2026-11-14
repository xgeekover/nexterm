/**
 * The agent session history in the command palette and the "Clear Agent
 * Session History?" question (AC17, AC18's UI half).
 *
 * What the palette lists is plain data (src/lib/paletteItems.js), pinned
 * first. What it does with a pick lives in CommandPalette.jsx's handlers, so
 * the palette is then mounted with real React on a page written by hand
 * (react_page.js), its stores stood in for, as palette_mounted.test.js does,
 * and driven as a user drives it: the keyboard and the pointer. Last, the
 * question itself, with the real history store and the browser mock: no,
 * and nothing is cleared; yes, and the list and its moved-aside copies go.
 *
 * AHP-99 puts the history store, the question, the storage and the mock back.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';
import {
  AGENT_SESSION_GROUP_LIMIT,
  agentSessionRows,
  buildPaletteGroups,
  focusAfterPalette,
  paletteCommands,
} from '../../src/lib/paletteItems.js';
import { useAgentHistoryStore } from '../../src/stores/agentHistoryStore.js';
import {
  clearAgentHistory,
  clearAgentHistoryQuestion,
  useAgentHistoryPromptStore,
} from '../../src/stores/agentHistoryPromptStore.js';
import {
  agentSessionRowHandlers,
  resumeAgentSessionWith,
  subjectExists,
  LIST_MENUS,
} from '../../src/components/terminal/statusBoardModel.js';
import { mockBridge } from '../../src/lib/ipc.js';

const h = React.createElement;

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const now = Date.now();
/** An entry as `agent_history_list` answers, last used `minutesAgo` minutes ago. */
const entry = (key, extra = {}, minutesAgo = 5) => ({
  key,
  kind: 'opencode',
  sessionId: null,
  cwd: '/work/app',
  title: null,
  startedAt: now - (minutesAgo + 60) * 60e3,
  lastUsedAt: now - minutesAgo * 60e3,
  endedAt: null,
  endReason: null,
  ...extra,
});
const LOGIN = entry('k-login', { sessionId: 'ses_abcdefgh1234567', title: 'Fix the login flow', cwd: '/work/api' }, 5);
const CLAUDE = entry('k-claude', { kind: 'claude', sessionId: UUID, cwd: '/work/web' }, 120);
const FREE = entry('k-free', { cwd: '/work/tools' }, 3 * 24 * 60);

const pick = (groups) => groups.find((g) => g.label === 'agent sessions') ?? null;
const keysOf = (rows) => rows.map((r) => r.historyKey);

// ---- What the palette lists ---------------------------------------------------

describe('Agent session history in the palette: what it lists', () => {
  test("AHP-01: Resume Agent Session… opens the pick; Clear Agent Session History… asks in a dialog; a row resumes into a terminal (AC17)", () => {
    const resume = paletteCommands().find((c) => c.command === 'resume_agent_session');
    const clear = paletteCommands().find((c) => c.command === 'clear_agent_session_history');
    assert.equal(resume?.title, 'Resume Agent Session…');
    assert.equal(resume.opens, 'agent-sessions', 'it becomes the pick, keeping the palette');
    assert.equal(clear?.title, 'Clear Agent Session History…');
    assert.equal(clear.opensDialog, true);
    assert.equal(focusAfterPalette(clear), 'dialog', 'the question takes the keyboard');
    const [row] = agentSessionRows([LOGIN]);
    assert.equal(focusAfterPalette(row), 'terminal', 'the terminal it opens, or the one holding it, has the keyboard');
    // The dispatch names both rows' work, or a row does nothing.
    const palette = readFileSync(new URL('../../src/components/command/CommandPalette.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(palette, /item\.type === 'agent-session'\) \{[^}]*await resumeFromHistory\?\.\(item\.historyKey\);/);
    assert.match(palette, /case 'clear_agent_session_history':[^]*?await clearAgentHistory\(\);/);
  });

  test('AHP-02: mode agent-sessions lists every entry newest first, whatever order it is given (AC17)', () => {
    const [group] = buildPaletteGroups({ mode: 'agent-sessions', agentSessions: [FREE, LOGIN, CLAUDE] });
    assert.equal(group.label, 'agent sessions');
    assert.deepEqual(keysOf(group.items), ['k-login', 'k-claude', 'k-free']);
    assert.deepEqual(
      group.items.map((r) => [r.type, r.title, r.subtitle, r.hint]),
      [
        ['agent-session', 'Fix the login flow', '/work/api', 'opencode'],
        ['agent-session', 'd4bef4d0', '/work/web', 'Claude Code'],
        ['agent-session', 'most recent in folder', '/work/tools', 'opencode'],
      ]
    );
    // Equal times keep the given order; junk is no row.
    const a = entry('a', {}, 7);
    const b = entry('b', {}, 7);
    assert.deepEqual(keysOf(agentSessionRows([a, null, { title: 'no key' }, { ...a, key: '' }, b])), ['a', 'b']);
    assert.deepEqual(agentSessionRows(null), []);
  });

  test('AHP-03: a query on a folder, a title, an agent or an id prefix filters the pick; nothing fitting says so (AC17)', () => {
    const rows = (query) => keysOf(pick(buildPaletteGroups({ mode: 'agent-sessions', query, agentSessions: [LOGIN, CLAUDE, FREE] })).items);
    assert.deepEqual(rows('tools'), ['k-free'], 'a folder');
    assert.deepEqual(rows('login'), ['k-login'], 'a title');
    assert.deepEqual(rows('LOGIN flow'), ['k-login'], 'every word, case aside');
    assert.deepEqual(rows('claude'), ['k-claude'], 'an agent');
    assert.deepEqual(rows('d4bef'), ['k-claude'], 'the start of an id');
    assert.deepEqual(rows('ses_abc'), ['k-login']);
    assert.deepEqual(rows('work'), ['k-login', 'k-claude', 'k-free'], 'still newest first');
    assert.deepEqual(rows('bef4'), [], 'the middle of an id is not its start');
    const [none] = buildPaletteGroups({ mode: 'agent-sessions', query: 'nothing-like-it', agentSessions: [LOGIN] });
    assert.deepEqual(none.items, []);
    assert.equal(none.note, 'No agent session matches.');
    const [empty] = buildPaletteGroups({ mode: 'agent-sessions', agentSessions: [] });
    assert.match(empty.note, /^No agent sessions yet\./);
  });

  test('AHP-04: the default palette shows the entries a query names, after the commands, a few at most; not with nothing typed or in Go to File', () => {
    const all = (query, agentSessions = [LOGIN, CLAUDE, FREE]) => buildPaletteGroups({ mode: 'all', query, agentSessions });
    assert.equal(pick(all('')), null, 'nothing typed: Resume Agent Session… lists them');
    const groups = all('login');
    const at = groups.findIndex((g) => g.label === 'agent sessions');
    assert.ok(at > groups.findIndex((g) => g.label === 'commands'), 'after the commands');
    assert.deepEqual(keysOf(groups[at].items), ['k-login']);
    assert.equal(groups[at].more, 0);
    const many = Array.from({ length: AGENT_SESSION_GROUP_LIMIT + 3 }, (_, i) => entry(`m-${i}`, { title: `deploy ${i}` }, i + 1));
    const cut = pick(all('deploy', many));
    assert.deepEqual(keysOf(cut.items), many.slice(0, AGENT_SESSION_GROUP_LIMIT).map((e) => e.key), 'the newest few');
    assert.equal(cut.more, 3, 'the rest counted');
    assert.equal(pick(buildPaletteGroups({ mode: 'files', query: 'login', agentSessions: [LOGIN] })), null);
    assert.equal(pick(buildPaletteGroups({ mode: 'all', query: 'login' })), null, 'a caller without the history lists none');
  });

  test("AHP-05: the side bar's menu on an entry closes when the entry goes, and holds a sorted order while open", () => {
    const has = { agentSession: (key) => key === 'k-login' };
    assert.equal(subjectExists('agent-session', 'k-login', has), true);
    assert.equal(subjectExists('agent-session', 'k-gone', has), false);
    assert.equal(subjectExists('agent-session', 'k-login', {}), false, 'no lookup, no subject');
    assert.equal(subjectExists('agent-sessions', null, has), true, 'the header menu has no subject to lose');
    assert.ok(LIST_MENUS.has('agent-session') && LIST_MENUS.has('agent-sessions'));
    const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(panel, /agentSession: \(key\) => agentEntries\.some\(\(entry\) => entry\.key === key\)/);
    // Remove and Clear in its menu, the clear through the question.
    assert.match(panel, /key: 'remove', label: 'Remove from List', onSelect: \(\) => removeAgentEntry\(entry\.key\)/);
    assert.match(panel, /key: 'clear', label: 'Clear Agent Session History…', danger: true, onSelect: \(\) => clearAgentHistory\(\)/);
  });

  test("AHP-06: a side bar row — a click selects, a double-click or Enter resumes through resumeFromHistory, a right-click opens its menu (B-R5)", async () => {
    const calls = [];
    const select = (key) => calls.push(['select', key]);
    const resumeFromHistory = async (key) => {
      calls.push(['resumeFromHistory', key]);
      return { outcome: 'opened' };
    };
    const resume = (key) => resumeAgentSessionWith(key, { select, resumeFromHistory });
    const openMenu = (e, kind, id) => calls.push(['menu', e.type, kind, id]);
    const row = agentSessionRowHandlers('k-login', { select, resume, openMenu });
    const take = () => calls.splice(0);

    row.onClick({ type: 'click' });
    assert.deepEqual(take(), [['select', 'k-login']], 'a click only selects');
    row.onDoubleClick({ type: 'dblclick' });
    assert.deepEqual(take(), [['select', 'k-login'], ['resumeFromHistory', 'k-login']], 'a double-click resumes it');
    row.onKeyDown({ key: 'Enter' });
    assert.deepEqual(take(), [['select', 'k-login'], ['resumeFromHistory', 'k-login']], 'Enter resumes it');
    for (const key of [' ', 'a', 'ArrowDown', 'Escape', 'enter']) {
      row.onKeyDown({ key });
      assert.deepEqual(take(), [], `${JSON.stringify(key)} resumes nothing`);
    }
    row.onContextMenu({ type: 'contextmenu' });
    assert.deepEqual(take(), [['select', 'k-login'], ['menu', 'contextmenu', 'agent-session', 'k-login']]);
    assert.deepEqual(await resumeAgentSessionWith('k-x', { select, resumeFromHistory }), { outcome: 'opened' }, 'its answer');
    take();
    assert.equal(resumeAgentSessionWith('k-y', { select, resumeFromHistory: undefined }), undefined, 'no store: selected only');
    assert.deepEqual(take(), [['select', 'k-y']]);

    // The panel is wired to these, with the terminal store's resumeFromHistory.
    const panel = readFileSync(new URL('../../src/components/terminal/TerminalsPanel.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(panel, /const resumeFromHistory = useTerminalStore\(\(s\) => s\.resumeFromHistory\);/);
    assert.match(
      panel,
      /const resumeAgentSession = \(key\) => \{\n\s*resumeAgentSessionWith\(key, \{ select: setSelectedAgentKey, resumeFromHistory \}\);\n\s*\};/
    );
    assert.match(
      panel,
      /data-agent-session=\{entry\.key\}[^>]*\{\.\.\.agentSessionRowHandlers\(entry\.key, \{ select: setSelectedAgentKey, resume: resumeAgentSession, openMenu \}\)\}/,
      'on the agent session row itself'
    );
    assert.doesNotMatch(panel, /data-agent-session=\{entry\.key\}[^>]*\bon(Click|DoubleClick|KeyDown|ContextMenu)=/, 'and no handler of its own beside them');
    assert.match(panel, /onSelect: \(\) => resumeAgentSession\(entry\.key\)/, 'its menu resumes the same way');
  });
});

// ---- The palette, mounted -----------------------------------------------------

const COMMAND_DIR = fileURLToPath(new URL('../../src/components/command/', import.meta.url));
const REAL = new Set(['react', 'react/jsx-runtime', 'zustand']);

/** Every icon the palette imports, each a component that draws nothing. */
function lucideStandIn() {
  const source = readFileSync(new URL('../../src/components/command/CommandPalette.jsx', import.meta.url), 'utf8');
  const names = /import \{([^}]*)\} from 'lucide-react';/.exec(source)[1].split(',').map((n) => n.trim()).filter(Boolean);
  return names.map((n) => `export const ${n} = () => null;`).join('\n');
}

const STAND_INS = {
  calls: `export const calls = [];`,
  settingsStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useSettingsStore = create((set) => ({
      isCommandPaletteOpen: false,
      commandPaletteMode: 'all',
      keybindings: {},
      setCommandPaletteOpen: (open, mode = 'all') =>
        set({ isCommandPaletteOpen: open, commandPaletteMode: open ? mode : 'all' }),
      setActiveView: (view) => {
        calls.push(['setActiveView', view]);
      },
    }));`,
  editorStore: `
    import { create } from 'zustand';
    export const useEditorStore = create(() => ({
      fileTree: [], rootPath: '/w', recentRoots: [], tabs: [], activeTabId: null,
      openFile: async () => null, openRoot: async () => null, saveAll: async () => {}, focusEditor: () => {},
    }));`,
  terminalStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useTerminalStore = create(() => ({
      activeTabId: 't1',
      activeGroupId: 'g1',
      groups: [{ id: 'g1', activePaneId: 'pane-1' }],
      resumeFromHistory: async (key) => {
        calls.push(['resumeFromHistory', key]);
        return { outcome: 'opened', tabId: 't2', typed: true, notice: null };
      },
    }));`,
  projectCommandsStore: `
    import { create } from 'zustand';
    export const useProjectCommandsStore = create(() => ({
      status: 'idle', reason: null, trust: 'untrusted', project: null, user: null, refresh: async () => {},
    }));`,
  // The history as the palette reads it: what a case puts in \`entries\`;
  // \`clear\` waits on the confirmation it is handed, as the real one does.
  agentHistoryStore: `
    import { create } from 'zustand';
    import { calls } from 'stand-in:calls';
    export const useAgentHistoryStore = create(() => ({
      entries: [],
      holders: {},
      load: async () => {
        calls.push(['load']);
      },
      clear: async ({ confirm = null } = {}) => {
        calls.push(['clear']);
        const yes = typeof confirm === 'function' ? await confirm() : true;
        calls.push(['answered', yes]);
        return yes ? 3 : null;
      },
    }));`,
  ipc: `
    export async function invoke(command) {
      return command === 'fs_list_files' ? { files: [], truncated: false } : null;
    }
    export async function listen() {
      return () => {};
    }`,
  commandIndex: `export function commandHistory() { return []; }`,
  lucide: lucideStandIn(),
};

function standInFor(path) {
  if (path === 'stand-in:calls') return 'calls';
  if (path === 'lucide-react') return 'lucide';
  // Imported from a component (../../stores/x.js) or from another store (./x.js).
  const store = /(?:\/stores\/|^\.\/)(settings|editor|terminal|projectCommands|agentHistory)Store\.js$/.exec(path);
  if (store) return `${store[1]}Store`;
  if (/\/lib\/ipc\.js$/.test(path)) return 'ipc';
  if (/\/lib\/commandIndex\.js$/.test(path)) return 'commandIndex';
  return null;
}

let loading = null;
function loadPalette() {
  loading ??= build({
    stdin: {
      contents: [
        "export * from './CommandPalette.jsx';",
        "export { useSettingsStore } from '../../stores/settingsStore.js';",
        "export { useTerminalStore } from '../../stores/terminalStore.js';",
        "export { useAgentHistoryStore } from '../../stores/agentHistoryStore.js';",
        // Real: the question the clear waits on.
        "export { useAgentHistoryPromptStore } from '../../stores/agentHistoryPromptStore.js';",
        "export { calls } from 'stand-in:calls';",
      ].join('\n'),
      resolveDir: COMMAND_DIR,
      sourcefile: 'agent-history-palette-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'agent-history-palette-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            const standIn = standInFor(args.path);
            return standIn ? { path: standIn, namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, (args) => ({
            contents: STAND_INS[args.path],
            loader: 'js',
            resolveDir: COMMAND_DIR,
          }));
        },
      },
    ],
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`));
  return loading;
}

let ui = null;

async function fresh() {
  ui = await loadPalette();
  for (const store of [ui.useSettingsStore, ui.useTerminalStore, ui.useAgentHistoryStore]) {
    store.setState(store.getInitialState(), true);
  }
  ui.useAgentHistoryPromptStore.getState().answer(false);
  ui.calls.length = 0;
}

const rows = (p) => p.document.querySelectorAll('div').filter((d) => d.hasAttribute?.('data-palette-row'));
const rowTitles = (p) => rows(p).map((r) => r.childNodes[1]?.textContent);
const called = (name) => ui.calls.filter(([c]) => c === name);

async function openPalette(p, mode) {
  p.settled(() => ui.useSettingsStore.getState().setCommandPaletteOpen(true, mode));
  await letItRun(60);
}

describe('Agent session history in the palette, mounted', () => {
  beforeEach(fresh);

  test('AHP-10: Resume Agent Session… lists newest first; Enter resumes the selected row by its key, and the palette closes (AC17)', async () => {
    await onPage(async (p) => {
      ui.useAgentHistoryStore.setState({ entries: [FREE, CLAUDE, LOGIN] });
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'agent-sessions');
      assert.deepEqual(rowTitles(p), ['Fix the login flow', 'd4bef4d0', 'most recent in folder']);
      assert.equal(called('load').length, 1, 'the list is read again as the pick opens');
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun();
      assert.deepEqual(called('resumeFromHistory'), [['resumeFromHistory', 'k-claude']], 'the selected row, by its key');
      assert.equal(ui.useSettingsStore.getState().isCommandPaletteOpen, false);
      assert.deepEqual(called('setActiveView'), [['setActiveView', 'terminal']]);
    });
  });

  test('AHP-11: a click on a row resumes that one; a held Enter repeat chooses nothing (AC17)', async () => {
    await onPage(async (p) => {
      ui.useAgentHistoryStore.setState({ entries: [LOGIN, CLAUDE, FREE] });
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'agent-sessions');
      p.keydown('Enter', { repeat: true });
      await letItRun();
      assert.deepEqual(called('resumeFromHistory'), [], 'a repeat is not a pick');
      p.click(rows(p)[2]);
      await letItRun();
      assert.deepEqual(called('resumeFromHistory'), [['resumeFromHistory', 'k-free']]);
    });
  });

  test('AHP-12: Resume Agent Session… from the commands becomes the pick, keeping the palette open', async () => {
    await onPage(async (p) => {
      ui.useAgentHistoryStore.setState({ entries: [LOGIN] });
      p.render(h(ui.CommandPalette));
      await openPalette(p, 'all');
      const at = rowTitles(p).indexOf('Resume Agent Session…');
      assert.ok(at !== -1, `not listed: ${JSON.stringify(rowTitles(p))}`);
      p.click(rows(p)[at]);
      await letItRun(60);
      assert.equal(ui.useSettingsStore.getState().isCommandPaletteOpen, true);
      assert.equal(ui.useSettingsStore.getState().commandPaletteMode, 'agent-sessions');
      assert.deepEqual(rowTitles(p), ['Fix the login flow']);
      assert.deepEqual(called('resumeFromHistory'), [], 'nothing resumed by opening the pick');
    });
  });

  test('AHP-13: Clear Agent Session History… asks first: no, and the history is not cleared; yes, and it is (AC18)', async () => {
    await onPage(async (p) => {
      ui.useAgentHistoryStore.setState({ entries: [LOGIN, CLAUDE] });
      p.render(h(ui.CommandPalette));
      for (const yes of [false, true]) {
        ui.calls.length = 0;
        await openPalette(p, 'all');
        const at = rowTitles(p).indexOf('Clear Agent Session History…');
        assert.ok(at !== -1, 'not listed');
        p.click(rows(p)[at]);
        await letItRun();
        assert.equal(ui.useSettingsStore.getState().isCommandPaletteOpen, false, 'the palette made way for the question');
        assert.deepEqual(ui.calls, [['clear']], 'asked, and nothing answered yet');
        const { prompt } = ui.useAgentHistoryPromptStore.getState();
        assert.equal(prompt?.count, 2, 'the question counts the entries');
        ui.useAgentHistoryPromptStore.getState().answer(yes);
        await letItRun();
        assert.deepEqual(ui.calls, [['clear'], ['answered', yes]]);
        assert.equal(ui.useAgentHistoryPromptStore.getState().prompt, null, 'the question is gone');
      }
    });
  });
});

// ---- The question, with the real history store and the mock backend ------------

let saved = null;

/** `fn` with the mock's history in memory only and the stores as they were after. */
async function withHistory(fn) {
  saved ??= {
    storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    memory: mockBridge.agentHistoryMemory,
    bad: mockBridge.agentHistoryBad,
    history: { ...useAgentHistoryStore.getState() },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  useAgentHistoryStore.setState({ entries: [], loaded: false, error: null, holders: {} });
  try {
    await fn();
  } finally {
    useAgentHistoryPromptStore.getState().answer(false);
  }
}

const stored = (n) => ({ kind: 'claude', sessionId: null, cwd: `/w/${n}`, title: null, startedAt: n, lastUsedAt: n, endedAt: null, endReason: null });

describe('Agent session history: the question before clearing (AC18)', () => {
  test('AHP-20: no keeps every entry; yes empties the list and the moved-aside copies; the question counts what goes', async () => {
    await withHistory(async () => {
      for (const n of [1, 2, 3]) await mockBridge.invoke('agent_history_upsert', { entry: stored(n) });
      await useAgentHistoryStore.getState().load();
      assert.equal(useAgentHistoryStore.getState().entries.length, 3, 'premise');

      const no = clearAgentHistory();
      await letItRun();
      assert.equal(useAgentHistoryPromptStore.getState().prompt?.count, 3);
      useAgentHistoryPromptStore.getState().answer(false);
      assert.equal(await no, null, 'said no: not cleared');
      assert.equal((await mockBridge.invoke('agent_history_list')).length, 3, 'the file keeps every entry');

      mockBridge.agentHistoryBad = ['agent-sessions.json.bad-1'];
      const yes = clearAgentHistory();
      await letItRun();
      useAgentHistoryPromptStore.getState().answer(true);
      assert.equal(await yes, 3, 'said yes: three went');
      assert.deepEqual(useAgentHistoryStore.getState().entries, []);
      assert.deepEqual(await mockBridge.invoke('agent_history_list'), []);
      assert.deepEqual(mockBridge.agentHistoryBad, [], 'and the copies with them');
    });
  });

  test('AHP-21: a second question answers the first no; anything but true is no; the words say what goes and what stays', async () => {
    await withHistory(async () => {
      await mockBridge.invoke('agent_history_upsert', { entry: stored(1) });
      await useAgentHistoryStore.getState().load();
      const first = clearAgentHistory();
      await letItRun();
      const firstId = useAgentHistoryPromptStore.getState().prompt.id;
      const second = clearAgentHistory();
      await letItRun();
      assert.equal(await first, null, 'the older question is answered no');
      assert.notEqual(useAgentHistoryPromptStore.getState().prompt.id, firstId, 'a new question is up');
      useAgentHistoryPromptStore.getState().answer('yes');
      assert.equal(await second, null, "'yes' as text is not true");
      assert.equal((await mockBridge.invoke('agent_history_list')).length, 1);

      const one = clearAgentHistoryQuestion(1);
      assert.equal(one.title, 'Clear Agent Session History?');
      assert.equal(one.confirmLabel, 'Clear');
      assert.match(one.message, /^1 entry will be removed from AGENT SESSIONS, with the damaged copies/);
      assert.match(one.message, /conversations themselves stay with Claude Code and OpenCode/);
      assert.match(clearAgentHistoryQuestion(4).message, /^4 entries /);
      assert.match(clearAgentHistoryQuestion(-1).message, /^0 entries /);
    });
  });

  test('AHP-99: teardown — the storage, the mock and the stores as they were', () => {
    if (!saved) return;
    if (saved.storage) Object.defineProperty(globalThis, 'localStorage', saved.storage);
    else delete globalThis.localStorage;
    mockBridge.agentHistoryMemory = saved.memory;
    mockBridge.agentHistoryBad = saved.bad;
    useAgentHistoryStore.setState(saved.history, true);
    useAgentHistoryPromptStore.setState({ prompt: null });
    saved = null;
  });
});
