/**
 * The ☰ application menu in the Windows/Linux title row: File, View and
 * Terminal folded into one two-level dropdown. The component only renders;
 * where the keyboard and the pointer go is decided in appMenuNav.js.
 */

import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { MENU_BAR } from '../../src/lib/menuActions.js';
import { CLOSED, openMenu, hoverTitle, hoverItem, menuKey } from '../../src/lib/appMenuNav.js';

const MENUS = [
  { title: 'A', items: [{ id: 'a1', label: 'A1' }, { type: 'separator' }, { id: 'a2', label: 'A2' }] },
  { title: 'B', items: [{ type: 'separator' }, { id: 'b1', label: 'B1' }] },
];

/** Press `keys` in order; the last `run` wins. */
function press(menus, state, keys) {
  let run;
  for (const key of keys) {
    const result = menuKey(menus, state, key);
    state = result.state;
    if (result.run) run = result.run;
  }
  return { state, run };
}

describe('Application menu: keyboard and pointer', () => {
  test('APPM-01: opening highlights the first title and expands nothing', () => {
    assert.deepEqual(openMenu(), { open: true, top: 0, expanded: -1, sub: -1 });
  });

  test('APPM-02: Up/Down walk the titles, wrap, and fold away an expanded menu', () => {
    assert.equal(press(MENUS, openMenu(), ['ArrowUp']).state.top, 1);
    assert.equal(press(MENUS, openMenu(), ['ArrowDown', 'ArrowDown']).state.top, 0);
    const next = press(MENUS, hoverTitle(openMenu(), 0), ['ArrowDown']).state;
    assert.deepEqual([next.top, next.expanded, next.sub], [1, -1, -1]);
  });

  test('APPM-03: Right opens a menu on its first item, and Enter runs it and closes', () => {
    const opened = press(MENUS, openMenu(), ['ArrowRight']).state;
    assert.deepEqual([opened.expanded, opened.sub], [0, 0]);
    const { state, run } = press(MENUS, opened, ['Enter']);
    assert.equal(run, 'a1');
    assert.deepEqual(state, CLOSED);
  });

  test('APPM-04: separators are never landed on, in either direction', () => {
    assert.equal(press(MENUS, openMenu(), ['ArrowRight', 'ArrowDown']).state.sub, 2);
    assert.equal(press(MENUS, openMenu(), ['ArrowRight', 'ArrowDown', 'ArrowDown']).state.sub, 0);
    assert.equal(press(MENUS, openMenu(), ['ArrowRight', 'ArrowUp']).state.sub, 2);
    // A menu that starts with a separator opens on the item after it.
    assert.equal(press(MENUS, openMenu(), ['ArrowDown', 'ArrowRight']).state.sub, 1);
  });

  test('APPM-05: Left and Escape back out one level at a time', () => {
    const left = press(MENUS, openMenu(), ['ArrowRight', 'ArrowLeft']).state;
    assert.deepEqual(left, { open: true, top: 0, expanded: -1, sub: -1 });
    const once = press(MENUS, openMenu(), ['ArrowRight', 'Escape']).state;
    assert.equal(once.open, true, 'the first Escape only folds the items away');
    assert.equal(once.expanded, -1);
    assert.deepEqual(press(MENUS, once, ['Escape']).state, CLOSED);
  });

  test('APPM-06: hovering a title shows its items; Enter runs the hovered item', () => {
    const shown = hoverTitle(openMenu(), 1);
    assert.deepEqual([shown.top, shown.expanded, shown.sub], [1, 1, -1]);
    assert.equal(press(MENUS, hoverItem(shown, 1), ['Enter']).run, 'b1');
    // Hovered open but no item highlighted: Enter steps in instead of running anything.
    const stepped = press(MENUS, shown, ['Enter']);
    assert.equal(stepped.run, undefined);
    assert.equal(stepped.state.sub, 1);
  });

  test('APPM-07: a closed menu handles no key, so the terminal keeps them all', () => {
    for (const key of ['ArrowDown', 'Enter', 'Escape', 'a', ' ']) {
      assert.equal(menuKey(MENUS, CLOSED, key).handled, false, `closed menu swallowed ${JSON.stringify(key)}`);
    }
    assert.equal(menuKey(MENUS, openMenu(), 'a').handled, false);
  });

  test('APPM-08: every item of the real menu can be reached and run from the keyboard', () => {
    const expected = MENU_BAR.flatMap((menu) => menu.items.filter((i) => i.id).map((i) => i.id));
    const reached = [];
    MENU_BAR.forEach((menu, t) => {
      const count = menu.items.filter((i) => i.id).length;
      for (let k = 0; k < count; k++) {
        const keys = [...Array(t).fill('ArrowDown'), 'ArrowRight', ...Array(k).fill('ArrowDown'), 'Enter'];
        reached.push(press(MENU_BAR, openMenu(), keys).run);
      }
    });
    assert.deepEqual(reached, expected);
  });
});
