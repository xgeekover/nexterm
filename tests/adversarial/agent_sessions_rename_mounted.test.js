/**
 * An AGENT SESSIONS name being edited in place, mounted
 * (src/components/terminal/TerminalsPanel.jsx; C-03 of the agent session
 * curation task).
 *
 * The input goes without a blur when its session leaves the list or its row
 * is no longer drawn: React unmounts it during a commit, when it ignores
 * events. The draft used to outlive both: kept for an entry archived, or
 * folded into its group, by another NexTerm, it came back with the stale text
 * and the focus when the row was drawn again, and a blur then saved that text
 * as the name; and for an entry that left the list, the typed name was gone
 * without a word. Now an agent session's draft counts only while its row is
 * drawn: dropped, it never comes back, and text the user changed is named in
 * the 'curationFailed' notice. Nothing is renamed either way.
 *
 * The panel is rendered with real React on the hand-written page of
 * react_page.js, bundled with esbuild as agent_resume_banner_mounted.test.js
 * does: React, react-dom and zustand real, the stores and the browser mock
 * bundled with it (their own instances, shared with nothing else), lucide's
 * icons stood in for. The other NexTerm is played through the mock's own
 * commands, and the panel's store then reads the list again. Sorting stays
 * off: its aim hold asks `document.elementFromPoint`, which the page lacks.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun, dispatch } from './react_page.js';

const h = React.createElement;
const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand']);

/** The names `file` imports from lucide-react, each stood in for by an icon that draws nothing. */
function lucideStandIn(file) {
  const names = new Set();
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return `const Icon = () => null; ${[...names].map((n) => `export const ${n} = Icon;`).join(' ')}`;
}

let loading = null;
function loadPanel() {
  loading ??= build({
    stdin: {
      contents: [
        "export { TerminalsPanel } from './TerminalsPanel.jsx';",
        "export { useAgentHistoryStore } from '../../stores/agentHistoryStore.js';",
        "export { useTerminalStore } from '../../stores/terminalStore.js';",
        "export { mockBridge } from '../../lib/ipc.js';",
      ].join('\n'),
      resolveDir: TERMINAL_DIR,
      sourcefile: 'panel-under-test.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    jsx: 'automatic',
    // xterm's style sheet, which the terminal registry imports: nothing is drawn here.
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'panel-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            return args.path === 'lucide-react' ? { path: args.importer, namespace: 'lucide' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'lucide' }, (args) => ({ contents: lucideStandIn(args.path), loader: 'js' }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
const SES = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const GROUP = 'g-renamed';
/** An entry as the recorder writes it. */
const entry = (kind, sessionId, title, lastUsedAt = 2000, cwd = '/workspace/src') => ({
  kind, sessionId, cwd, title, startedAt: 1000, lastUsedAt, endedAt: lastUsedAt, endReason: 'closed',
});
const emptyStore = () => ({ entries: [], loaded: false, error: null, holders: {}, groups: [], readOnly: false, version: null });

/**
 * The panel mounted on a page with the bundled mock's file empty, its calls
 * logged, and `seed(write)` run first (`write` the mock's own command, as
 * another NexTerm sends it); then `fn(it)` with `it`: `write`, `sent` (the
 * calls made), `load()` (the store reads the list again and the panel draws
 * it), `row(key)`, `rename(key)` (Rename… from the row's menu), `notice()`.
 */
async function withPanel(ui, seed, fn, { typing = false } = {}) {
  const { mockBridge, useAgentHistoryStore: H, useTerminalStore: T } = ui;
  const sent = [];
  const original = mockBridge.invoke;
  // A storage of its own, empty: the mock keeps its file there when there is
  // one, and a suite before this one may have left one in place.
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const backing = new Map();
  const shim = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  mockBridge.agentHistoryMemory = null;
  mockBridge.agentHistoryBad = [];
  H.setState(emptyStore());
  T.setState({ agentHistoryNotice: null });
  mockBridge.invoke = async function (command, args, ...rest) {
    sent.push({ command, args: args === undefined ? undefined : structuredClone(args) });
    return original.call(this, command, args, ...rest);
  };
  const write = (command, args) => original.call(mockBridge, command, args);
  // Every notice put up, in order.
  const notices = [];
  const unwatch = T.subscribe((state, prev) => {
    if (state.agentHistoryNotice && state.agentHistoryNotice !== prev.agentHistoryNotice) notices.push(state.agentHistoryNotice);
  });
  try {
    await onPage(async (p) => {
      // The page lays nothing out: every element sits at the same place.
      const proto = Object.getPrototypeOf(p.document.createElement('div'));
      const had = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
      proto.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 30, right: 200, width: 190, height: 20 });
      Object.assign(p.window, { innerWidth: 1600, innerHeight: 900 });
      try {
        const keys = await seed(write);
        await H.getState().load();
        p.render(h(ui.TerminalsPanel));
        await letItRun();
        const it = {
          p,
          keys,
          write,
          sent,
          load: async () => {
            await H.getState().load();
            await letItRun();
          },
          row: (key) => p.document.querySelector(`[data-agent-session="${key}"]`),
          inputs: () => p.document.querySelectorAll('input'),
          rename: async (key) => {
            const row = it.row(key);
            assert.ok(row, `premise: the row of ${key} is drawn`);
            p.settled(() => dispatch(p.window, row, { type: 'contextmenu', button: 2, clientX: 40, clientY: 40 }));
            const item = p.document.querySelectorAll('[role="menuitem"]').find((n) => n.textContent === 'Rename…');
            assert.ok(item, 'premise: its menu has Rename…');
            p.click(item);
            await letItRun();
            const input = it.row(key)?.querySelector('input');
            assert.ok(input, 'premise: the row’s name is being edited');
            assert.equal(p.document.activeElement, input, 'premise: with the focus in it');
            return input;
          },
          renamesSent: () => sent.filter((c) => c.command === 'agent_history_update' && c.args?.changes && 'name' in c.args.changes),
          notice: () => T.getState().agentHistoryNotice,
          notices,
        };
        await fn(it);
        p.unmount();
      } finally {
        if (had) Object.defineProperty(proto, 'getBoundingClientRect', had);
        else delete proto.getBoundingClientRect;
      }
    }, { typing });
  } finally {
    unwatch();
    mockBridge.invoke = original;
    mockBridge.agentHistoryMemory = null;
    H.setState(emptyStore());
    T.setState({ agentHistoryNotice: null });
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
  }
}

/** The editor gone for good: no input drawn, the focus elsewhere, no name sent. */
function noEditor(it, what) {
  assert.equal(it.inputs().length, 0, `${what}: no input is drawn`);
  assert.notEqual(it.p.document.activeElement?.tagName, 'INPUT', `${what}: the focus is in no input`);
  assert.deepEqual(it.renamesSent(), [], `${what}: no rename was sent`);
}

describe('An agent session being renamed in place is dropped when its row is not drawn (C-03)', () => {
  test('ASR-01: archived by another NexTerm while Archived is closed, the editor goes; opening Archived draws the row with its title and no editor, the focus in no input, nothing renamed', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title') })).key],
      async (it) => {
        const [key] = it.keys;
        await it.rename(key);
        assert.ok((await it.write('agent_history_update', { key, changes: { archived: true } }))?.archived, 'premise: archived in the file');
        await it.load();
        assert.equal(it.row(key), null, 'Archived closed: the row is not drawn');
        noEditor(it, 'archived');
        const archived = it.p.document.querySelector('[data-agent-archived]');
        assert.ok(archived, 'premise: the Archived sub-list header');
        it.p.click(archived);
        await letItRun();
        const row = it.row(key);
        assert.ok(row, 'Archived open: the row is drawn');
        assert.ok(row.textContent.includes('Auto title'), 'with its title');
        noEditor(it, 'Archived opened');
        assert.equal(it.notice(), null, 'the text was not changed: nothing said');
      }
    );
  });

  test('ASR-02: its group folded in the file by another NexTerm, the editor goes; unfolded again, the row has its title and no editor', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => {
        const { key } = await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title') });
        await write('agent_history_group_create', { group: { id: GROUP, name: 'Mine' }, move_key: key });
        return [key];
      },
      async (it) => {
        const [key] = it.keys;
        await it.rename(key);
        await it.write('agent_history_group_update', { id: GROUP, changes: { collapsed: true } });
        await it.load();
        assert.equal(it.row(key), null, 'its group folded: the row is not drawn');
        noEditor(it, 'folded');
        await it.write('agent_history_group_update', { id: GROUP, changes: { collapsed: false } });
        await it.load();
        assert.ok(it.row(key)?.textContent.includes('Auto title'), 'unfolded: drawn with its title');
        noEditor(it, 'unfolded');
      }
    );
  });

  test('ASR-03: pushed past the 15 shown rows by 15 newer sessions, the editor goes; back within them, the row has its title and no editor', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title', 2000) })).key],
      async (it) => {
        const [key] = it.keys;
        await it.rename(key);
        const newer = [];
        for (let i = 0; i < 15; i += 1) {
          const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
          newer.push((await it.write('agent_history_upsert', { entry: entry('claude', id, `Newer ${i}`, 3000 + i) })).key);
        }
        await it.load();
        assert.equal(it.row(key), null, 'the 16th: not drawn');
        assert.ok(it.row(newer[0]), 'premise: the 15 newer are');
        noEditor(it, 'past the rows shown');
        for (const k of newer) await it.write('agent_history_remove', { key: k });
        await it.load();
        assert.ok(it.row(key)?.textContent.includes('Auto title'), 'back within the rows shown: drawn with its title');
        noEditor(it, 'back');
      }
    );
  });
});

describe('A name typed for an agent session that leaves the list is named in the notice (C-03)', () => {
  test('ASR-04: “QA lost” typed, the entry removed by another NexTerm — the editor goes, the curationFailed notice quotes “QA lost”, nothing is renamed', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title') })).key],
      async (it) => {
        const [key] = it.keys;
        const input = await it.rename(key);
        it.p.type(input, 'QA lost');
        assert.equal(it.row(key).querySelector('input')?.value, 'QA lost', 'premise: typed');
        await it.write('agent_history_remove', { key });
        await it.load();
        assert.equal(it.row(key), null, 'the entry is gone');
        noEditor(it, 'removed');
        assert.equal(it.notice()?.kind, 'curationFailed');
        assert.ok(it.notice().text.includes('“QA lost”'), it.notice().text);
        assert.equal(it.notices.length, 1, 'said once');
      },
      { typing: true }
    );
  });

  test('ASR-05: “QA lost” typed on an OpenCode session that then learns its id (re-keyed through an upsert with `replaces`) — the editor goes, the notice quotes it, the new row has its title and no editor', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('opencode', null, 'Auto title') })).key],
      async (it) => {
        const [provisional] = it.keys;
        const input = await it.rename(provisional);
        it.p.type(input, 'QA lost');
        const learned = await it.write('agent_history_upsert', { entry: entry('opencode', SES, 'Auto title', 2100), replaces: provisional });
        assert.notEqual(learned.key, provisional, 'premise: re-keyed');
        await it.load();
        assert.equal(it.row(provisional), null, 'the provisional row is gone');
        assert.ok(it.row(learned.key)?.textContent.includes('Auto title'), 'the session is listed under its new key, with its title');
        noEditor(it, 're-keyed');
        assert.equal(it.notice()?.kind, 'curationFailed');
        assert.ok(it.notice().text.includes('“QA lost”'), it.notice().text);
        assert.equal(it.notices.length, 1, 'said once');
      },
      { typing: true }
    );
  });

  test('ASR-06: the editor’s text unchanged when the entry is removed — it goes silently, no notice', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title') })).key],
      async (it) => {
        const [key] = it.keys;
        const input = await it.rename(key);
        it.p.type(input, ' Auto title ');
        await it.write('agent_history_remove', { key });
        await it.load();
        noEditor(it, 'removed unchanged');
        assert.equal(it.notice(), null, 'nothing lost: nothing said');
        assert.deepEqual(it.notices, []);
      },
      { typing: true }
    );
  });

  test('ASR-07: typing still renames as before — Enter sends the typed name for the key, once', async () => {
    const ui = await loadPanel();
    await withPanel(
      ui,
      async (write) => [(await write('agent_history_upsert', { entry: entry('claude', UUID, 'Auto title') })).key],
      async (it) => {
        const [key] = it.keys;
        const input = await it.rename(key);
        it.p.type(input, 'Kept');
        it.p.keydown('Enter');
        await ui.useAgentHistoryStore.getState().flush?.();
        await letItRun(20);
        await it.load();
        assert.deepEqual(it.renamesSent().map((c) => [c.args.key, c.args.changes.name]), [[key, 'Kept']]);
        assert.ok(it.row(key)?.textContent.includes('Kept'), 'the row shows the name');
        assert.equal(it.inputs().length, 0, 'the editor closed');
        assert.equal(it.notice(), null);
      },
      { typing: true }
    );
  });
});
