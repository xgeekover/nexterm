/**
 * There are two menus: the native one macOS puts at the top of the screen
 * (src-tauri/src/menu.rs) and the one NexTerm draws inside its own title row
 * on Windows and Linux (src/lib/menuActions.js). They must stay the same menu.
 *
 * Both dispatch by item id through `runMenuAction`, so the failure these tests
 * guard against is an id that exists on one side only — a menu entry that
 * silently does nothing, or a Rust item nothing in the frontend answers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { MENU_BAR, runMenuAction, windowControls } from '../../src/lib/menuActions.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { useTerminalStore } from '../../src/stores/terminalStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';

const MENU_RS = readFileSync(fileURLToPath(new URL('../../src-tauri/src/menu.rs', import.meta.url)), 'utf8');
const ACTIONS_JS = readFileSync(fileURLToPath(new URL('../../src/lib/menuActions.js', import.meta.url)), 'utf8');

/** Ids the Rust menu declares, from `custom(...)` / `terminal_safe(...)`. */
const rustIds = new Set(
  [...MENU_RS.matchAll(/(?:custom|terminal_safe|per_platform)\("([a-z-]+)"/g)].map((m) => m[1])
);

/** Ids `runMenuAction` actually answers. */
const handledIds = new Set([...ACTIONS_JS.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));

/** Ids drawn only by the in-app menu. None today: both menus share every id. */
const IN_APP_ONLY = new Set();

const barIds = MENU_BAR.flatMap((menu) => menu.items.filter((i) => i.id).map((i) => i.id));

describe('Native and in-app menus describe the same commands', () => {
  test('the Rust menu declares ids and they are all handled', () => {
    assert.equal(rustIds.size > 0, true, 'no ids parsed out of menu.rs — the regex has drifted');
    const unhandled = [...rustIds].filter((id) => !handledIds.has(id));
    assert.deepEqual(unhandled, [], `menu.rs items nothing answers: ${unhandled.join(', ')}`);
  });

  test('every in-app menu item is handled', () => {
    const unhandled = barIds.filter((id) => !handledIds.has(id));
    assert.deepEqual(unhandled, [], `in-app menu items that do nothing: ${unhandled.join(', ')}`);
  });

  test('every in-app menu item exists in the native menu too, apart from Exit', () => {
    const strangers = barIds.filter((id) => !IN_APP_ONLY.has(id) && !rustIds.has(id));
    assert.deepEqual(strangers, [], `drawn off macOS but missing from menu.rs: ${strangers.join(', ')}`);
  });

  test('every native menu command is reachable from the in-app menu', () => {
    const missing = [...rustIds].filter((id) => !barIds.includes(id));
    assert.deepEqual(
      missing,
      [],
      `off macOS there is no native menu, so these would be unreachable: ${missing.join(', ')}`
    );
  });

  test('in-app menu ids are unique and every entry is an item or a separator', () => {
    assert.equal(new Set(barIds).size, barIds.length, 'duplicate id in MENU_BAR');
    for (const menu of MENU_BAR) {
      assert.equal(typeof menu.title, 'string');
      for (const item of menu.items) {
        assert.equal(
          item.type === 'separator' || (typeof item.id === 'string' && typeof item.label === 'string'),
          true,
          `malformed entry in the ${menu.title} menu: ${JSON.stringify(item)}`
        );
      }
    }
  });

  test('an unknown id is ignored rather than throwing', () => {
    assert.doesNotThrow(() => runMenuAction('no-such-menu-item'));
  });
});

/**
 * What each menu item runs, as `store.action(arguments)`.
 *
 * Every id either menu has needs a row, so a new item comes with a decision
 * about what it does. The cases above only collect `case '…':` labels from
 * the source, which is how Search in Files… came to fall through into Command
 * History: both labels were there, and the `break` between them was not.
 */
const ACTION_OF = {
  preferences: 'settings.setSettingsModalOpen(true)',
  'open-folder': 'editor.pickRoot()',
  'open-recent': 'settings.setCommandPaletteOpen(true,recent)',
  'new-terminal': 'terminal.createTab()',
  save: 'editor.saveFile(tab-1)',
  'command-palette': 'settings.setCommandPaletteOpen(true,all)',
  'quick-open': 'settings.setCommandPaletteOpen(true,files)',
  'search-in-files': 'settings.showView(search)',
  'toggle-sidebar': 'settings.toggleSidebar()',
  'toggle-panel': 'settings.togglePanel()',
  'toggle-secondary': 'settings.toggleSecondarySidebar()',
  'zoom-in': 'settings.zoomFont(1)',
  'zoom-out': 'settings.zoomFont(-1)',
  'zoom-reset': 'settings.resetZoom()',
  'split-right': 'terminal.splitActivePane(horizontal)',
  'split-down': 'terminal.splitActivePane(vertical)',
  'close-pane': 'terminal.closeActivePane()',
  'toggle-pane-zoom': 'terminal.togglePaneZoom()',
  'find-in-terminal': 'terminal.openFind()',
  'command-history': 'settings.setCommandPaletteOpen(true,history)',
  'clear-terminal': 'terminal.clearBlocks()',
  'close-window': 'window.close()',
};

/**
 * Run `fn` with every action of the three stores, and the window's close,
 * swapped for one that only writes its call down, so that whatever a menu
 * item runs — the action it should, or any other — is on the list. The
 * stores get their own state back afterwards, whether or not `fn` threw.
 */
function recordingActions(fn) {
  const calls = [];
  const stores = { settings: useSettingsStore, terminal: useTerminalStore, editor: useEditorStore };
  const saved = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, store.getState()]));
  const savedClose = windowControls.close;
  try {
    for (const [name, store] of Object.entries(stores)) {
      const stubs = {};
      for (const [key, value] of Object.entries(store.getState())) {
        if (typeof value === 'function') stubs[key] = (...args) => { calls.push(`${name}.${key}(${args.join(',')})`); };
      }
      store.setState(stubs);
    }
    // Save writes the file being edited, so there has to be one.
    useEditorStore.setState({ activeTabId: 'tab-1' });
    windowControls.close = (...args) => { calls.push(`window.close(${args.join(',')})`); };
    return fn(calls);
  } finally {
    for (const [name, store] of Object.entries(stores)) store.setState(saved[name], true);
    windowControls.close = savedClose;
  }
}

describe('Each menu item does one thing', () => {
  test('MC-01: every id either menu has says what it runs', () => {
    const ids = [...new Set([...barIds, ...rustIds, ...handledIds])];
    const unlisted = ids.filter((id) => !(id in ACTION_OF));
    assert.deepEqual(unlisted, [], `menu ids with no expected action here: ${unlisted.join(', ')}`);
  });

  test('MC-02: every menu item runs exactly its own action, once, and nothing else', () => {
    const ids = [...new Set([...barIds, ...rustIds, ...handledIds])];
    recordingActions((calls) => {
      for (const id of ids) {
        calls.length = 0;
        runMenuAction(id);
        assert.deepEqual(
          calls,
          [ACTION_OF[id]],
          `${id} must run ${ACTION_OF[id]} and nothing else; it ran [${calls.join(', ')}]`
        );
      }
    });
  });

  test('MC-03: the stores are given back as they were', () => {
    // MC-02 swaps every action out; a later suite in the same process must
    // find the real ones.
    for (const fn of [useSettingsStore.getState().showView, useTerminalStore.getState().openFind, windowControls.close]) {
      assert.equal(String(fn).includes('calls.push'), false, 'a recorder was left in place');
    }
    useSettingsStore.getState().setCommandPaletteOpen(true, 'history');
    assert.equal(useSettingsStore.getState().isCommandPaletteOpen, true);
    useSettingsStore.getState().setCommandPaletteOpen(false);
  });
});
