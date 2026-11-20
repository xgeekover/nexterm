/**
 * Commands by the active pane's kind, and pane navigation across kinds
 * (editor placement, sibling C2, FC10/FC11/FC14; AC-C9, AC-C10, AC-C16's
 * unit part). The keys go through `dispatchKeydown` with the context
 * useKeybindings builds (`workbenchContext`), the menu through
 * `runMenuAction`, both over the app's real stores arranged with one group:
 *
 *   [ pane-e1 (e1) | pane-e2 (e2, e3) ]   files, above
 *   [ pane-t1 (t1) | pane-t2 (t2)     ]   terminals, below
 *
 * A fake page stands for the DOM: an xterm textarea per terminal pane and a
 * body per editor pane, so where the keyboard lands is read off
 * `document.activeElement` (terminals) and the editor's pane-scoped focus
 * request (`pendingReveal.paneId`, which that pane's Monaco takes on mount —
 * the real-browser half is workbench_focus_headless.test.js).
 */
import { readFileSync } from 'node:fs';
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';
import { useTerminalStore, activeKindOf, activePaneOf } from '../../src/stores/terminalStore.js';
import { useEditorStore, registerEditorBridge } from '../../src/stores/editorStore.js';
import { DEFAULT_RESOLVED, dispatchKeydown, resolveKeybindings } from '../../src/lib/keybindings.js';
import { parseChord } from '../../src/lib/chords.js';
import { moveEditorToNewPane, workbenchContext } from '../../src/lib/workbenchCommands.js';
import { runMenuAction } from '../../src/lib/menuActions.js';
import { focusTerminal, focusWorkspace } from '../../src/lib/workspaceFocus.js';

const T = useTerminalStore;
const E = useEditorStore;

const fileTab = (id, dirty = false) => ({ id, filePath: `/workspace/${id}.js`, fileName: `${id}.js`, content: dirty ? 'y' : 'x', savedContent: 'x', isDirty: dirty, language: 'javascript' });
const termTab = (id) => ({ id, title: `shell ${id}`, cwd: '/workspace', sessionId: `s-${id}` });
const editorLeaf = (id, tabIds) => ({ type: 'leaf', kind: 'editor', id, tabIds, activeTabId: tabIds[0] ?? null });
const terminalLeaf = (id, tabIds) => ({ type: 'leaf', id, tabIds, activeTabId: tabIds[0] ?? null });

function arrange({ kind = 'terminal', editorPane = 'pane-e2', terminalPane = 'pane-t1', dirty = [], e2Tabs = ['e2', 'e3'] } = {}) {
  // The real actions back, should a step before have spied on some.
  if (savedT) T.setState(savedT, true);
  if (savedE) E.setState(savedE, true);
  registerEditorBridge();
  E.setState({ tabs: ['e1', 'e2', 'e3'].map((id) => fileTab(id, dirty.includes(id))), activeTabId: 'e1', rootPath: '/workspace', pendingReveal: null, pendingClose: null });
  T.setState({
    tabs: ['t1', 't2'].map(termTab),
    activeTabId: terminalPane === 'pane-t2' ? 't2' : 't1',
    activeGroupId: 'group-1',
    notifications: [],
    groups: [
      {
        id: 'group-1', name: 'Group 1', createdAt: 0, activePaneId: terminalPane, editorPaneId: editorPane,
        ...(kind === 'editor' ? { activeKind: 'editor' } : {}),
        tree: {
          type: 'split', id: 'split-root', direction: 'vertical', sizes: [70, 30],
          children: [
            { type: 'split', id: 'split-e', direction: 'horizontal', sizes: [80, 20], children: [editorLeaf('pane-e1', ['e1']), editorLeaf('pane-e2', e2Tabs)] },
            { type: 'split', id: 'split-t', direction: 'horizontal', sizes: [50, 50], children: [terminalLeaf('pane-t1', ['t1']), terminalLeaf('pane-t2', ['t2'])] },
          ],
        },
      },
    ],
  });
}

const group = () => T.getState().groups.find((g) => g.id === T.getState().activeGroupId);
const leaves = (node, acc = []) => {
  if (node?.type === 'leaf') acc.push(node);
  else node?.children?.forEach((c) => leaves(c, acc));
  return acc;
};
function parentOf(node, id) {
  if (!node || node.type !== 'split') return null;
  for (const child of node.children) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}

// --- the fake page ----------------------------------------------------------
let doc = null;
let hadDocument = false;
let previousDocument;
function fakePage() {
  const body = { tagName: 'BODY', closest: () => null, focus() {}, blur() {} };
  const page = { activeElement: body, body, focusLog: [] };
  // A Monaco or an editor body sits in its pane's `data-editor-pane-body` box
  // (EditorPane.jsx); a Monaco with no pane id is one outside every pane.
  const paneBox = (paneId) => ({ getAttribute: (name) => (name === 'data-editor-pane-body' ? paneId : null) });
  const element = (kind, paneId) => ({
    tagName: kind === 'xterm' ? 'TEXTAREA' : 'DIV',
    kind,
    paneId,
    closest: (sel) => {
      if ((sel === '.xterm' && kind === 'xterm') || (sel === '.monaco-editor' && kind === 'monaco')) return page.activeElement;
      if (sel === '[data-editor-pane-body]' && (kind === 'monaco' || kind === 'editor-body') && paneId) return paneBox(paneId);
      return null;
    },
    focus() {
      page.activeElement = this;
      page.focusLog.push(`${kind}:${paneId}`);
    },
    blur() {
      if (page.activeElement === this) page.activeElement = body;
    },
  });
  const xterms = new Map(['pane-t1', 'pane-t2'].map((id) => [id, element('xterm', id)]));
  const bodies = new Map(['pane-e1', 'pane-e2'].map((id) => [id, element('editor-body', id)]));
  page.querySelector = (sel) => {
    const xterm = /^\[data-pane-body="([^"]+)"\] \.xterm-helper-textarea$/.exec(sel);
    if (xterm) return xterms.get(xterm[1]) ?? null;
    const ed = /^\[data-editor-pane-body="([^"]+)"\]$/.exec(sel);
    if (ed) return bodies.get(ed[1]) ?? null;
    return null;
  };
  page.xterm = (id) => xterms.get(id);
  page.monaco = (paneId) => element('monaco', paneId);
  return page;
}

// --- keys -------------------------------------------------------------------
function press(key, { platform = 'macos', inMonaco = false, inTerminal = false, editorPane = null, extra = {} } = {}) {
  const chord = parseChord(key);
  const e = { ctrlKey: Boolean(chord.ctrl), metaKey: Boolean(chord.cmd), shiftKey: Boolean(chord.shift), altKey: Boolean(chord.alt), key: '', code: '', prevented: false };
  if (chord.mod) {
    if (platform === 'macos') e.metaKey = true;
    else e.ctrlKey = true;
  }
  if (chord.code) {
    e.code = chord.code;
    e.key = { Backquote: '`', Enter: 'Enter', ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' }[chord.code] ?? chord.code;
  } else if (chord.key.length === 1) {
    e.key = e.shiftKey ? chord.key.toUpperCase() : chord.key;
    e.code = `Key${chord.key.toUpperCase()}`;
  } else {
    e.key = chord.key;
    e.code = chord.key;
  }
  e.preventDefault = () => {
    e.prevented = true;
  };
  const ctx = {
    bindings: DEFAULT_RESOLVED,
    isMod: platform === 'macos' ? e.metaKey : e.ctrlKey,
    isInMonacoEditor: inMonaco,
    isInTerminal: inTerminal,
    isWindows: platform === 'windows',
    isCommandPaletteOpen: false,
    modalOpen: () => false,
    createTerminalTab: () => calls.push(['createTerminalTab', T.getState().activeTabId]),
    clearTerminal: () => calls.push(['clearTerminal', T.getState().activeTabId]),
    terminalClaimsMarkKeys: () => true,
    jumpToPrompt: (direction) => calls.push(['jumpToPrompt', T.getState().activeTabId, direction]),
    // `editorPane`: the pane whose body holds the element the key was
    // pressed in, as useKeybindings reads it off the event's target.
    ...workbenchContext({ isInMonacoEditor: inMonaco, editorPaneId: editorPane }),
    ...extra,
  };
  return { fired: dispatchKeydown(e, ctx), prevented: e.prevented };
}

let calls = [];
let savedT = null;
let savedE = null;
function spyOn(store, names) {
  const spies = {};
  for (const name of names) spies[name] = (...args) => calls.push([name, ...args]);
  store.setState(spies);
}

describe('Commands by the active pane kind, and navigation across kinds (C2)', () => {
  beforeEach(() => {
    savedT = T.getState();
    savedE = E.getState();
    calls = [];
    hadDocument = 'document' in globalThis;
    previousDocument = globalThis.document;
    doc = fakePage();
    globalThis.document = doc;
  });
  afterEach(() => {
    T.setState(savedT, true);
    E.setState(savedE, true);
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  });

  test('WC-01: Save writes the active editor pane\u{2019}s shown file; from a terminal pane, the editor\u{2019}s active tab; inside Monaco, the editor\u{2019}s', () => {
    arrange({ kind: 'editor' });
    spyOn(E, ['saveFile']);
    assert.equal(press('mod+s').fired, 'save');
    assert.deepEqual(calls, [['saveFile', 'e2']], 'the editor pane pane-e2 shows e2');
    calls = [];
    arrange({ kind: 'terminal' });
    spyOn(E, ['saveFile']);
    const editorActive = E.getState().activeTabId;
    assert.ok(editorActive, 'setup: the editor has an active tab');
    press('mod+s');
    assert.deepEqual(calls, [['saveFile', editorActive]], 'a terminal pane: the editor\u{2019}s active tab, as before');
    calls = [];
    press('mod+s', { inMonaco: true });
    assert.deepEqual(calls, [['saveFile', 'e2']], 'inside Monaco the kind is the editor\u{2019}s, whatever the store says');
    calls = [];
    runMenuAction('save');
    assert.deepEqual(calls, [['saveFile', editorActive]], 'the menu: the same rule');
  });

  test('WC-02: Close Pane — a clean file tab closes, a dirty one asks, an empty editor pane closes itself, a terminal pane as before', () => {
    arrange({ kind: 'editor' });
    spyOn(E, ['requestCloseTab', 'requestCloseEditorPane']);
    spyOn(T, ['closeActivePane']);
    const inMonaco = press('mod+w', { inMonaco: true });
    assert.equal(inMonaco.fired, 'close-pane', 'claimed inside Monaco (Q5)');
    assert.equal(inMonaco.prevented, true);
    assert.deepEqual(calls, [['requestCloseTab', 'e2']], 'its shown tab, never the shell');

    // Dirty: the real action asks, and nothing is closed yet.
    arrange({ kind: 'editor', dirty: ['e2'] });
    press('mod+w');
    assert.equal(E.getState().pendingClose?.kind, 'tab', 'the unsaved prompt is up');
    assert.deepEqual(E.getState().pendingClose?.tabIds, ['e2']);
    assert.ok(E.getState().tabs.some((t) => t.id === 'e2'), 'and the file is still open');

    // Clean: the real action closes the tab, and the pane shows the next one.
    arrange({ kind: 'editor' });
    press('mod+w');
    assert.equal(E.getState().tabs.some((t) => t.id === 'e2'), false, 'a clean tab closes at once');
    assert.deepEqual(leaves(group().tree).find((l) => l.id === 'pane-e2')?.tabIds, ['e3']);

    // Empty editor leaf: the pane itself.
    calls = [];
    arrange({ kind: 'editor', e2Tabs: [] });
    spyOn(E, ['requestCloseTab', 'requestCloseEditorPane']);
    spyOn(T, ['closeActivePane']);
    press('mod+w');
    assert.deepEqual(calls, [['requestCloseEditorPane', 'pane-e2']]);

    calls = [];
    arrange({ kind: 'terminal' });
    spyOn(E, ['requestCloseTab', 'requestCloseEditorPane']);
    spyOn(T, ['closeActivePane']);
    press('mod+w', { platform: 'windows' });
    runMenuAction('close-pane');
    assert.deepEqual(calls, [['closeActivePane'], ['closeActivePane']], 'a terminal pane: closeActivePane, from the key and the menu');
  });

  test('WC-03: Split Right/Down from an editor pane makes an empty editor pane, the active one; ⌘D passes through in Monaco, Ctrl+Alt+D splits there', () => {
    for (const [key, direction, platform] of [['ctrl+alt+d', 'horizontal', 'windows'], ['mod+shift+d', 'vertical', 'macos']]) {
      arrange({ kind: 'editor' });
      assert.equal(press(key, { platform }).fired.startsWith('split-'), true);
      const g = group();
      const fresh = activePaneOf(g);
      assert.notEqual(fresh, 'pane-e2');
      assert.equal(activeKindOf(g), 'editor', `${key}: the new pane is THE active pane`);
      const leaf = leaves(g.tree).find((l) => l.id === fresh);
      assert.deepEqual({ kind: leaf.kind, tabIds: leaf.tabIds }, { kind: 'editor', tabIds: [] }, `${key}: an empty editor leaf`);
      assert.equal(parentOf(g.tree, fresh).direction, direction);
    }
    arrange({ kind: 'editor' });
    const cmdD = press('cmd+d', { inMonaco: true });
    assert.equal(cmdD.fired, 'pass:split-right', '⌘D is Monaco\u{2019}s next match');
    assert.equal(cmdD.prevented, false);
    assert.equal(press('ctrl+alt+d', { platform: 'windows', inMonaco: true }).fired, 'split-right');
    assert.equal(leaves(group().tree).length, 5, 'Ctrl+Alt+D inside Monaco split the editor pane');

    arrange({ kind: 'terminal' });
    spyOn(T, ['splitActivePane']);
    press('ctrl+alt+d', { platform: 'windows' });
    runMenuAction('split-down');
    assert.deepEqual(calls, [['splitActivePane', 'horizontal'], ['splitActivePane', 'vertical']], 'a terminal pane splits as before');
  });

  test('WC-04: Find — Monaco\u{2019}s own inside Monaco, the editor pane\u{2019}s find from elsewhere, the terminal\u{2019}s find bar in a terminal pane', () => {
    arrange({ kind: 'editor' });
    spyOn(T, ['openFind']);
    const inside = press('mod+f', { inMonaco: true });
    assert.deepEqual([inside.fired, inside.prevented], ['pass:find-in-terminal', false]);
    press('mod+f');
    assert.deepEqual(E.getState().pendingReveal, { filePath: '/workspace/e2.js', line: null, column: null, paneId: 'pane-e2', find: true }, 'that pane\u{2019}s editor, with its find');
    assert.deepEqual(calls, [], 'not the terminal\u{2019}s find bar');
    arrange({ kind: 'terminal' });
    spyOn(T, ['openFind']);
    press('mod+f', { inTerminal: true });
    runMenuAction('find-in-terminal');
    assert.deepEqual(calls, [['openFind'], ['openFind']]);
  });

  test('WC-05: Toggle Pane Zoom and Equalize Splits act on THE active pane\u{2019}s group, an editor pane included', () => {
    arrange({ kind: 'editor' });
    press('mod+shift+enter');
    assert.equal(group().zoomedPaneId, 'pane-e2', 'the editor pane is zoomed');
    assert.equal(press('mod+shift+enter', { inMonaco: true }).fired, 'pass:toggle-pane-zoom', 'inside Monaco the chord stays Monaco\u{2019}s');
    runMenuAction('toggle-pane-zoom');
    assert.equal(group().zoomedPaneId ?? null, null, 'the menu unzooms');
    // Equalize Splits has no chord as shipped and no menu item (menuId
    // null): driven through the chord a user gives it, as useKeybindings
    // runs it (C2 review N-04), from the editor pane and inside Monaco.
    const { bindings, problems } = resolveKeybindings({ 'equalize-splits': 'mod+alt+e' });
    assert.deepEqual(problems, [], 'setup: the chord is taken');
    for (const inMonaco of [false, true]) {
      arrange({ kind: 'editor' });
      assert.deepEqual(parentOf(group().tree, 'pane-e2').sizes, [80, 20], 'setup: unequal');
      assert.equal(press('mod+alt+e', { inMonaco, extra: { bindings } }).fired, 'equalize-splits');
      assert.deepEqual(parentOf(group().tree, 'pane-e2').sizes, [50, 50], `inMonaco ${inMonaco}: the file panes equalized`);
      assert.deepEqual(group().tree.sizes, [50, 50], `inMonaco ${inMonaco}: and the split around them`);
      assert.equal(activePaneOf(group()), 'pane-e2', 'the editor pane stays THE active pane');
    }
  });

  test('WC-06: New Terminal, Clear Terminal and the prompt jumps hit the terminal pane while an editor pane is active', () => {
    arrange({ kind: 'editor', terminalPane: 'pane-t2' });
    press('ctrl+shift+backquote');
    press('mod+l');
    press('mod+shift+up', { inTerminal: true });
    press('mod+shift+down', { inTerminal: true });
    assert.deepEqual(calls, [
      ['createTerminalTab', 't2'],
      ['clearTerminal', 't2'],
      ['jumpToPrompt', 't2', 'previous'],
      ['jumpToPrompt', 't2', 'next'],
    ]);
    assert.equal(activePaneOf(group()), 'pane-e2', 'the editor pane stays the active one');
  });

  test('WC-07: Focus Next/Previous Pane cycle both kinds in screen order and land the keyboard there', () => {
    arrange({ kind: 'terminal', terminalPane: 'pane-t1' });
    doc.xterm('pane-t1').focus();
    press('mod+alt+right');
    assert.equal(activePaneOf(group()), 'pane-t2');
    assert.equal(doc.activeElement, doc.xterm('pane-t2'), 'the next xterm has the keyboard');
    press('mod+alt+right');
    assert.equal(activePaneOf(group()), 'pane-e1', 'wraps onto the first file pane, above');
    assert.equal(doc.activeElement, doc.body, 'out of the xterm');
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e1', 'and into pane-e1\u{2019}s editor');
    press('mod+alt+right');
    assert.equal(activePaneOf(group()), 'pane-e2');
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e2');
    press('mod+alt+left');
    press('mod+alt+left');
    assert.equal(activePaneOf(group()), 'pane-t2', 'back over the file panes to the last terminal');
    assert.equal(activeKindOf(group()), 'terminal');
    assert.equal(doc.activeElement, doc.xterm('pane-t2'));
  });

  test('WC-08: Swap Pane With… lists both kinds, a file pane by its file name; a cross-kind swap keeps the terminal tab object and the file tab', () => {
    arrange({ kind: 'terminal', terminalPane: 'pane-t1' });
    const { panes, note, fromPaneId } = T.getState().swapTargets(null, E.getState().tabs);
    assert.equal(note, null);
    assert.equal(fromPaneId, 'pane-t1');
    assert.deepEqual(
      panes.map((p) => [p.paneId, p.title, p.kind, p.terminals]),
      [['pane-e1', 'e1.js', 'editor', 1], ['pane-e2', 'e2.js', 'editor', 2], ['pane-t2', 'shell t2', 'terminal', 1]]
    );
    const t1 = T.getState().tabs.find((t) => t.id === 't1');
    const e1 = E.getState().tabs.find((t) => t.id === 'e1');
    assert.equal(T.getState().swapActivePane('pane-e1'), true);
    const now = leaves(group().tree);
    assert.deepEqual(now.find((l) => l.id === 'pane-e1').tabIds, ['t1']);
    assert.equal(now.find((l) => l.id === 'pane-e1').kind, undefined, 'pane-e1 holds the terminal now');
    assert.equal(now.find((l) => l.id === 'pane-t1').kind, 'editor');
    assert.equal(T.getState().tabs.find((t) => t.id === 't1'), t1, 'the same terminal tab object');
    assert.equal(E.getState().tabs.find((t) => t.id === 'e1'), e1, 'the same file tab');
    assert.equal(group().activePaneId, 'pane-e1', 'the keyboard\u{2019}s pane follows the terminal');

    arrange({ kind: 'editor', editorPane: 'pane-e2' });
    assert.equal(T.getState().swapTargets(null, E.getState().tabs).fromPaneId, 'pane-e2', 'from an editor pane when it is THE active one');
  });

  test('WC-09: Move Editor to New Pane Right/Down splits the file out beside its pane and returns the new pane id', async () => {
    for (const [direction, split] of [['horizontal', 'horizontal'], ['vertical', 'vertical']]) {
      arrange({ kind: 'editor' });
      const paneId = E.getState().moveEditorTabToNewPane('e3', direction);
      assert.ok(paneId && paneId !== 'pane-e2', `${direction}: a new pane id`);
      const g = group();
      const leaf = leaves(g.tree).find((l) => l.id === paneId);
      assert.deepEqual({ kind: leaf.kind, tabIds: leaf.tabIds }, { kind: 'editor', tabIds: ['e3'] });
      const around = parentOf(g.tree, paneId);
      assert.equal(around.direction, split);
      const at = around.children.findIndex((c) => c.id === paneId);
      assert.equal(around.children[at - 1]?.id, 'pane-e2', `${direction}: right of / below its old pane`);
    }
    arrange({ kind: 'editor' });
    assert.equal(E.getState().moveEditorTabToNewPane('e1', 'horizontal'), null, 'a file alone in its pane stays');
    // A terminal still gets its new pane back, of its kind.
    arrange({ kind: 'terminal' });
    T.setState((s) => ({
      groups: s.groups.map((g) => ({ ...g, tree: { ...g.tree, children: [g.tree.children[0], terminalLeaf('pane-t1', ['t1', 't2'])] } })),
    }));
    const fresh = T.getState().moveTabToNewPane('t2', 'vertical');
    assert.ok(fresh && fresh !== 'pane-t1');
    assert.deepEqual(leaves(group().tree).find((l) => l.id === fresh).tabIds, ['t2']);
  });

  test('WC-10: focusWorkspace gives the keyboard back to THE active pane\u{2019}s kind', () => {
    arrange({ kind: 'editor' });
    doc.xterm('pane-t1').focus();
    assert.equal(focusWorkspace(), true);
    assert.equal(doc.activeElement, doc.body, 'out of the shell');
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e2', 'into the active editor pane');
    arrange({ kind: 'terminal', terminalPane: 'pane-t2' });
    doc.activeElement = doc.body;
    assert.equal(focusWorkspace('terminal'), true);
    assert.equal(doc.activeElement, doc.xterm('pane-t2'));
  });

  test('WC-11 (M-02): activeKindOf answers editor only for a group whose editor pane is THE active pane', () => {
    const tree = { type: 'split', id: 's', direction: 'vertical', children: [editorLeaf('pe', ['e1']), terminalLeaf('pt', ['t1'])] };
    assert.equal(activeKindOf({ id: 'g', tree, activeKind: 'editor', activePaneId: undefined }), 'terminal', 'no editor pane named, activePaneId undefined');
    assert.equal(activeKindOf({ id: 'g', tree: terminalLeaf('pt', []), activePaneId: undefined }), 'terminal');
    assert.equal(activeKindOf({ id: 'g', tree, activeKind: 'editor', editorPaneId: 'gone', activePaneId: 'pt' }), 'terminal', 'an editor pane that is not there');
    assert.equal(activeKindOf({ id: 'g', tree, activeKind: 'editor', editorPaneId: 'pe', activePaneId: undefined }), 'editor');
    assert.equal(activeKindOf(null), 'terminal');
  });

  test('WC-12 (M-05): no module in src imports EditorPanel.jsx statically, and nothing imports pressActivatesGroup from it', () => {
    const panel = readFileSync(new URL('../../src/components/editor/EditorPanel.jsx', import.meta.url), 'utf8');
    assert.equal(/export\s*\{[^}]*pressActivatesGroup/.test(panel), false, 'EditorPanel.jsx re-exports nothing from EditorPane.jsx');
    // The tree-wide import check is WV-06 (workbench_editor_area.test.js).
  });

  // C2 review N-04: what the palette's two commands and a file chip's menu
  // run (CommandPalette.jsx, EditorTabs.jsx), not the store action under it.
  test('WC-13: workbenchCommands.moveEditorToNewPane moves the file and hands the new pane the keyboard', () => {
    for (const direction of ['horizontal', 'vertical']) {
      arrange({ kind: 'editor' });
      doc.xterm('pane-t1').focus();
      const fresh = moveEditorToNewPane(direction);
      assert.ok(fresh && fresh !== 'pane-e2', `${direction}: a new pane id`);
      assert.deepEqual(leaves(group().tree).find((l) => l.id === fresh)?.tabIds, ['e2'], `${direction}: the file pane-e2 showed`);
      assert.equal(parentOf(group().tree, fresh).direction, direction);
      assert.deepEqual([activePaneOf(group()), activeKindOf(group())], [fresh, 'editor'], `${direction}: the new pane is THE active pane`);
      assert.deepEqual(E.getState().pendingReveal, { filePath: '/workspace/e2.js', line: null, column: null, paneId: fresh }, `${direction}: its editor is asked to take the keyboard`);
      assert.equal(doc.activeElement, doc.body, `${direction}: out of the shell`);
    }
    // A chip's menu names its own tab.
    arrange({ kind: 'editor' });
    const chip = moveEditorToNewPane('horizontal', 'e3');
    assert.deepEqual(leaves(group().tree).find((l) => l.id === chip)?.tabIds, ['e3']);
    assert.equal(E.getState().pendingReveal?.paneId, chip, 'the chip\u{2019}s file: the request is on its new pane');
    // From a terminal pane: the editor's active tab, the file last edited.
    arrange({ kind: 'terminal' });
    E.setState({ activeTabId: 'e3' });
    const fromShell = moveEditorToNewPane('vertical');
    assert.deepEqual(leaves(group().tree).find((l) => l.id === fromShell)?.tabIds, ['e3']);
    assert.equal(activePaneOf(group()), fromShell);
    assert.equal(E.getState().pendingReveal?.paneId, fromShell);
    // A file alone in its pane: nothing moves, and nothing is asked.
    arrange({ kind: 'editor' });
    assert.equal(moveEditorToNewPane('horizontal', 'e1'), null);
    assert.equal(E.getState().pendingReveal, null);
  });

  // C2 review N-03: the pane commands take the editor pane from the element
  // holding the keyboard, and a key pressed inside Monaco never reaches a
  // terminal's action.
  test('WC-14: inside Monaco the pane is the one holding the keyboard; with no editor pane to act on, nothing happens', () => {
    // The store names pane-e2, the keyboard is in pane-e1's editor.
    arrange({ kind: 'editor' });
    spyOn(E, ['requestCloseTab', 'requestCloseEditorPane', 'saveFile']);
    spyOn(T, ['closeActivePane', 'splitActivePane', 'openFind']);
    assert.equal(press('mod+w', { inMonaco: true, editorPane: 'pane-e1' }).fired, 'close-pane');
    press('mod+s', { inMonaco: true, editorPane: 'pane-e1' });
    assert.deepEqual(calls, [['requestCloseTab', 'e1'], ['saveFile', 'e1']], 'pane-e1\u{2019}s file, not pane-e2\u{2019}s');

    // Inside a Monaco with no editor pane behind it (the store's editor pane
    // is gone, no pane box around the editor): Close Pane, Split and Find do
    // nothing at all — never the terminal's.
    calls = [];
    arrange({ kind: 'terminal', editorPane: 'gone' });
    spyOn(E, ['requestCloseTab', 'requestCloseEditorPane', 'splitEditorPane']);
    spyOn(T, ['closeActivePane', 'splitActivePane', 'openFind']);
    const before = group().tree;
    assert.equal(press('mod+w', { inMonaco: true, platform: 'windows' }).fired, 'close-pane');
    assert.equal(press('ctrl+alt+d', { inMonaco: true, platform: 'windows' }).fired, 'split-right');
    doc.activeElement = doc.monaco(null);
    runMenuAction('close-pane');
    runMenuAction('split-down');
    runMenuAction('find-in-terminal');
    assert.deepEqual(calls, [], 'no shell closed, split or searched from inside a file');
    assert.equal(group().tree, before, 'the layout untouched');

    // The menu reads the pane off the keyboard too.
    calls = [];
    arrange({ kind: 'editor' });
    spyOn(E, ['requestCloseTab', 'saveFile']);
    doc.activeElement = doc.monaco('pane-e1');
    runMenuAction('save');
    runMenuAction('close-pane');
    assert.deepEqual(calls, [['saveFile', 'e1'], ['requestCloseTab', 'e1']]);
  });

  // C2 review N-02: a pane-scoped focus request (`focusEditorPane`) waits
  // for that pane's Monaco to mount. It must go once the keyboard goes
  // elsewhere, and it must never take the place of a line a link asked for.
  test('WC-15: a pane\u{2019}s focus request is dropped when the keyboard moves on', () => {
    // Focus Next onto pane-e1, whose editor has not mounted, and back.
    arrange({ kind: 'terminal', terminalPane: 'pane-t2' });
    doc.xterm('pane-t2').focus();
    press('mod+alt+right');
    assert.equal(activePaneOf(group()), 'pane-e1', 'setup: wrapped onto pane-e1');
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e1', 'setup: the request waits for pane-e1\u{2019}s editor');
    press('mod+alt+left');
    assert.equal(doc.activeElement, doc.xterm('pane-t2'), 'the shell has the keyboard');
    assert.equal(E.getState().pendingReveal, null, 'dropped: left there, pane-e1\u{2019}s editor took the keyboard from the shell as it mounted');

    // The active pane moved away by other means (a click on a terminal).
    arrange({ kind: 'editor' });
    assert.equal(E.getState().focusEditorPane('pane-e2'), true);
    T.getState().setActivePane('pane-t1');
    assert.equal(activePaneOf(group()), 'pane-t1', 'setup: a terminal pane is THE active pane');
    assert.equal(E.getState().pendingReveal, null, 'dropped when THE active pane is no longer its pane');

    // Another group brought on screen.
    arrange({ kind: 'editor' });
    E.getState().focusEditorPane('pane-e2');
    T.setState((s) => ({ groups: [...s.groups, { id: 'group-2', name: 'Group 2', createdAt: 1, tree: terminalLeaf('pane-g2', []), activePaneId: 'pane-g2' }] }));
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e2', 'an unrelated change of the groups keeps it');
    T.setState({ activeGroupId: 'group-2' });
    assert.equal(E.getState().pendingReveal, null, 'dropped when its group is no longer on screen');

    // Anything else that keeps pane-e2 THE active pane keeps the request.
    arrange({ kind: 'editor' });
    E.getState().focusEditorPane('pane-e2');
    T.getState().togglePaneZoom();
    assert.equal(group().zoomedPaneId, 'pane-e2');
    assert.equal(E.getState().pendingReveal?.paneId, 'pane-e2', 'a zoom of its own pane keeps it (its Monaco remounts and takes it)');
  });

  test('WC-16: a link\u{2019}s line, then focusWorkspace before the editor mounted — the line is still revealed', async () => {
    // A link's line, then the keyboard given back to the workspace before
    // the editor mounted: the line stays, and its editor takes the keyboard
    // with the caret on it (EditorPanel's reveal focuses).
    arrange({ kind: 'editor' });
    await E.getState().openFileAt('/workspace/e3.js', 7, 2);
    const line = { filePath: '/workspace/e3.js', line: 7, column: 2 };
    assert.deepEqual(E.getState().pendingReveal, line, 'setup: the line waits for the editor');
    assert.deepEqual([activePaneOf(group()), activeKindOf(group())], ['pane-e2', 'editor'], 'setup: the file\u{2019}s pane is THE active pane');
    assert.equal(focusWorkspace(), true);
    assert.deepEqual(E.getState().pendingReveal, line, 'focusWorkspace kept the line');
    E.getState().focusEditorPane('pane-e2', { find: true });
    assert.deepEqual(E.getState().pendingReveal, line, 'and so does any pane focus request');
    T.getState().setActivePane('pane-t1');
    assert.deepEqual(E.getState().pendingReveal, line, 'a line is not a pane\u{2019}s focus request: moving on keeps it');
    focusTerminal();
    assert.deepEqual(E.getState().pendingReveal, line);
  });
});
