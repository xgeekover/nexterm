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
import { MENU_BAR, runMenuAction } from '../../src/lib/menuActions.js';

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
