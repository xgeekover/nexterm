/**
 * What the session and its groups are called.
 *
 * Both are names the app hands out or carries over on its own, and both went
 * wrong where nobody was looking:
 *
 *   - a new group was named `Group ${groups.length + 1}`, which reuses a number
 *     the moment a group in the middle closes — Group 1, 2 and 3, close Group 2,
 *     make another, and there are two "Group 3"s. Renaming already numbered by
 *     the lowest free number (`nextDefaultGroupName`); new groups did not.
 *   - loading a saved workspace in place of the session handed its name to
 *     `settle`, which returns the layout and nothing else, so the session kept
 *     its old name — and Save All Groups… then offered that one.
 *   - the session's name is saved with the layout and read back on launch, and
 *     was then dropped: every relaunch was "Default" again.
 */
import { describe, test, beforeEach, afterEach, assert } from '../e2e/harness/testFramework.js';

// --- localStorage shim, borrowed for the length of each case -----------------
const backing = new Map();
const shim = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear(),
};

/** Reinstall this file's shim for one case, then hand the global back — see layout_gaps. */
function borrowStorage() {
  const held = globalThis.localStorage;
  globalThis.localStorage = shim;
  return () => {
    globalThis.localStorage = held;
  };
}

const { useTerminalStore: S } = await import('../../src/stores/terminalStore.js');

const names = () => S.getState().groups.map((g) => g.name);
const groupNamed = (name) => S.getState().groups.find((g) => g.name === name);

/**
 * A launch: the store back to what a page load gives it — no terminals, and
 * the session called what a new store calls it — then started. `keepStorage`
 * leaves what the previous run saved, so the start restores it.
 */
async function launch({ keepStorage = false } = {}) {
  S.getState().dispose(); // writes out anything still pending
  if (!keepStorage) backing.clear();
  S.setState({
    tabs: [],
    activeTabId: null,
    isInitialized: false,
    savedGroups: [],
    savedWorkspaces: [],
    workspaceName: 'Default',
  });
  await S.getState().init();
}

describe('Workspace names: a new group takes the lowest number nobody uses', () => {
  let release;
  beforeEach(async () => {
    release = borrowStorage();
    await launch();
  });
  afterEach(() => release());

  test('WN-01: closing a group in the middle and making another gives no second "Group 3"', async () => {
    await S.getState().createGroup();
    await S.getState().createGroup();
    assert.deepEqual(names(), ['Group 1', 'Group 2', 'Group 3'], 'setup: three groups the app numbered');

    await S.getState().closeGroup(groupNamed('Group 2').id);
    await S.getState().createGroup();
    assert.deepEqual(names(), ['Group 1', 'Group 3', 'Group 2'], 'the free number, not the count plus one');

    await S.getState().createGroup();
    assert.deepEqual(names(), ['Group 1', 'Group 3', 'Group 2', 'Group 4']);
  });

  test('WN-02: a terminal moved into a group of its own is numbered the same way', async () => {
    await S.getState().createGroup();
    await S.getState().createGroup();
    await S.getState().closeGroup(groupNamed('Group 2').id);

    const extra = await S.getState().createTab();
    const id = S.getState().moveTabToNewGroup(extra.id);
    assert.ok(id, 'the tab was not alone in its group, so it moved');
    assert.equal(S.getState().groups.find((g) => g.id === id).name, 'Group 2');
    assert.equal(new Set(names()).size, names().length, `no two groups share a name: ${names()}`);
  });

  test('WN-03: a number counts as taken whoever gave it — and a name chosen by hand takes none', async () => {
    const first = S.getState().groups[0];
    S.getState().renameGroup(first.id, 'Group 2'); // typed by the user
    await S.getState().createGroup();
    assert.deepEqual(names(), ['Group 2', 'Group 1']);

    S.getState().renameGroup(first.id, 'Logs');
    await S.getState().createGroup();
    assert.deepEqual(names(), ['Logs', 'Group 1', 'Group 2']);

    // The name a caller asks for still wins.
    await S.getState().createGroup({ name: '  Build  ' });
    assert.equal(names().at(-1), 'Build');
  });
});

describe('Workspace names: the session is called what it is', () => {
  let release;
  beforeEach(async () => {
    release = borrowStorage();
    await launch();
  });
  afterEach(() => release());

  test('WN-04: loading a workspace in place of the session takes its name', async () => {
    S.getState().renameWorkspace('Gamma');
    const entry = S.getState().saveWorkspace('Beta');
    assert.equal(entry.name, 'Beta');
    assert.equal(S.getState().workspaceName, 'Gamma', 'saving a copy does not rename the session');

    await S.getState().loadWorkspace(entry.id, { mode: 'replace' });
    assert.equal(S.getState().workspaceName, 'Beta', 'you are now IN that workspace');

    // And Save All Groups… offers the name of the workspace you are in.
    assert.equal(S.getState().saveWorkspace().name, 'Beta');
  });

  test('WN-05: loading one alongside keeps the session\'s own name', async () => {
    S.getState().renameWorkspace('Gamma');
    const entry = S.getState().saveWorkspace('Beta');
    await S.getState().loadWorkspace(entry.id, { mode: 'append' });
    assert.equal(S.getState().workspaceName, 'Gamma');
  });

  test('WN-06: the name comes back on the next launch', async () => {
    S.getState().renameWorkspace('Release work');
    await launch({ keepStorage: true });
    assert.equal(S.getState().tabs.length, 1, 'the layout came back');
    assert.equal(S.getState().workspaceName, 'Release work');

    // …and is saved again as it is, not overwritten with the new store's own.
    await launch({ keepStorage: true });
    assert.equal(S.getState().workspaceName, 'Release work');
  });

  test('WN-07: the name comes back after a session closed down to no terminals', async () => {
    // Found in review: with nothing to restore the start is a fresh one, and
    // that kept "Default" — then saved it over the name.
    S.getState().renameWorkspace('Release work');
    for (const tab of [...S.getState().tabs]) await S.getState().closeTab(tab.id);
    assert.equal(S.getState().tabs.length, 0, 'setup: no terminals left');

    await launch({ keepStorage: true });
    assert.equal(S.getState().tabs.length, 1, 'a fresh start: one new terminal');
    assert.equal(S.getState().workspaceName, 'Release work');

    await launch({ keepStorage: true });
    assert.equal(S.getState().workspaceName, 'Release work', 'and it was saved as it is');
  });
});

describe('Workspace names: teardown', () => {
  test('WN-99: teardown — leave the store disposed and nothing persisted', () => {
    const release = borrowStorage();
    S.getState().dispose();
    backing.clear();
    release();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, workspaceName: 'Default' });
  });
});
