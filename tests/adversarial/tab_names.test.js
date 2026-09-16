/**
 * Two terminals must never be called the same thing.
 *
 * The default name came from how many terminals there were —
 * `Terminal ${tabs.length + 1}` — so closing one in the middle dropped the
 * count and handed the next terminal a number still in use. Reproduced against
 * the real store: open three, close "Terminal 2", open one more, and the group
 * holds "Terminal 1", "Terminal 3", "Terminal 3".
 *
 * The number is now the lowest nothing is using, counting a number as taken
 * when EITHER name uses it. `defaultTitle`, because clearing a rename restores
 * it (see `renameTab`) and two tabs handed the same one would collide the
 * moment both renames were cleared. And the visible `title`, because a
 * restored layout keeps the titles it was saved with while their
 * `defaultTitle`s are renumbered from one — TN-02 caught exactly that, with a
 * new terminal shown as "Terminal 2" beside a restored one already called it.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';

const { useTerminalStore: S, PERSIST_KEY } = await import('../../src/stores/terminalStore.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tabs = () => S.getState().tabs;
const titles = () => tabs().map((t) => t.title);
const defaults = () => tabs().map((t) => t.defaultTitle);
const duplicatesIn = (list) => list.filter((v, i) => list.indexOf(v) !== i);

describe('Default terminal names stay unique', () => {
  beforeEach(async () => {
    S.getState().dispose();
    // Drop the persisted workspace as well: `init` restores it, so without
    // this each case would start from the tabs the previous one left behind.
    try {
      globalThis.localStorage?.removeItem(PERSIST_KEY);
    } catch (_) {
      // no storage in this environment — nothing to restore from either
    }
    S.setState({ tabs: [], activeTabId: null, isInitialized: false, savedGroups: [], savedWorkspaces: [] });
    await S.getState().init();
    await wait(50);
  });

  test('TN-01: closing one in the middle does not make the next a duplicate', async () => {
    await S.getState().createTab();
    await S.getState().createTab();
    await wait(50);
    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 2', 'Terminal 3']);

    await S.getState().closeTab(tabs()[1].id);
    await wait(50);
    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 3'], 'the middle one is gone');

    await S.getState().createTab();
    await wait(50);

    // Before the fix this was ['Terminal 1', 'Terminal 3', 'Terminal 3'].
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `two terminals share a name: ${JSON.stringify(titles())}`
    );
    assert.equal(titles()[2], 'Terminal 2', 'and the freed number is reused rather than skipped');
  });

  test('TN-02: churn never produces a duplicate, however long it runs', async () => {
    for (let i = 0; i < 4; i++) await S.getState().createTab();
    await wait(60);

    for (let round = 0; round < 8; round++) {
      // Close something that is not the last one, so the count always drops
      // below the highest number in use — the shape that caused this.
      const list = tabs();
      const victim = list[Math.min(1, list.length - 1)];
      await S.getState().closeTab(victim.id);
      await wait(20);
      await S.getState().createTab();
      await wait(20);

      assert.deepEqual(
        duplicatesIn(titles()),
        [],
        `round ${round}: duplicate visible name in ${JSON.stringify(titles())}`
      );
      assert.deepEqual(
        duplicatesIn(defaults()),
        [],
        `round ${round}: duplicate defaultTitle in ${JSON.stringify(defaults())}`
      );
    }
  });

  test('TN-03: a renamed terminal keeps its number, so clearing the rename is safe', async () => {
    await S.getState().createTab();
    await S.getState().createTab();
    await wait(50);
    const second = tabs()[1];
    assert.equal(second.defaultTitle, 'Terminal 2');

    S.getState().renameTab(second.id, 'build');
    await wait(20);
    assert.equal(tabs()[1].title, 'build');

    // The number 2 is still spoken for, even though nothing shows it.
    await S.getState().createTab();
    await wait(50);
    assert.deepEqual(duplicatesIn(defaults()), [], `defaults collided: ${JSON.stringify(defaults())}`);

    // Clearing the rename brings "Terminal 2" back — and it must still be the
    // only one. This is what matching on the visible title alone would miss.
    S.getState().renameTab(second.id, '');
    await wait(20);
    assert.equal(tabs()[1].title, 'Terminal 2');
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `clearing a rename revealed a duplicate: ${JSON.stringify(titles())}`
    );
  });

  test('TN-04: a restored layout does not get a duplicate from the next new terminal', async () => {
    // A layout saved after "Terminal 2" was closed: the titles have a gap, but
    // on restore the defaultTitles are renumbered from one. Matching only on
    // defaultTitle would then hand the next terminal the number 3, which the
    // restored tab is already showing.
    S.getState().dispose();
    globalThis.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        version: 2,
        data: {
          activeGroupId: 'group-tn',
          groups: [
            {
              id: 'group-tn',
              name: 'Restored',
              createdAt: 1,
              activePaneId: 'pane-tn',
              tree: { type: 'leaf', id: 'pane-tn', tabIds: ['t-1', 't-3'], activeTabId: 't-1' },
            },
          ],
          tabs: [
            { id: 't-1', title: 'Terminal 1', cwd: '/workspace' },
            { id: 't-3', title: 'Terminal 3', cwd: '/workspace' },
          ],
        },
      })
    );
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    await S.getState().init();
    await wait(60);

    assert.deepEqual(titles(), ['Terminal 1', 'Terminal 3'], 'the saved names come back as they were');

    await S.getState().createTab();
    await wait(60);
    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `the new terminal collided with a restored one: ${JSON.stringify(titles())}`
    );
    assert.equal(titles()[2], 'Terminal 2', 'and it takes the number the gap left free');
  });

  test('TN-05: a terminal the user named "Terminal 9" owns that number too', async () => {
    // Nothing stops someone typing a name that looks like a default one, and
    // once they have, the app must not hand the same name to a new terminal.
    // This is why a number counts as taken from the VISIBLE title as well.
    const first = tabs()[0];
    S.getState().renameTab(first.id, 'Terminal 9');
    await wait(20);
    assert.equal(tabs()[0].title, 'Terminal 9');

    // Open enough terminals to walk the numbering up to and past 9.
    for (let i = 0; i < 10; i++) await S.getState().createTab();
    await wait(120);

    assert.deepEqual(
      duplicatesIn(titles()),
      [],
      `a new terminal took a name already on screen: ${JSON.stringify(titles())}`
    );
    assert.equal(
      titles().filter((t) => t === 'Terminal 9').length,
      1,
      'only the one the user named is called that'
    );
  });

  test('TN-06: teardown — leave the store as the next suite expects it', () => {
    S.getState().dispose();
    S.setState({ tabs: [], activeTabId: null, isInitialized: false });
    assert.ok(true);
  });
});
