/**
 * The activity bar's Explorer and Search icons, and the side bar they open.
 *
 * Which view a region shows used to be the layout's own state, and the
 * activity bar guessed it from the last `showView` request — which the
 * layout drops as soon as it has applied it. So with Search on screen the
 * Explorer was lit, and a click on the Explorer hid the side bar instead of
 * showing the Explorer: it took a second click to get there.
 *
 * Both now read `shownView` / `isViewShown` from the settings store, and the
 * icons act through `showView` and `toggleView`. These cases drive the store
 * as the layout and the icons do; the render suite (RN-62) checks that what
 * is drawn agrees.
 */
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { useSettingsStore, isViewShown, shownView } from '../../src/stores/settingsStore.js';

const S = useSettingsStore;
const store = () => S.getState();
const lit = () => ({ explorer: isViewShown(store(), 'explorer'), search: isViewShown(store(), 'search') });

/** The layout as the app starts it, nothing chosen and every region shown. */
function fresh() {
  S.setState({
    viewLocations: { explorer: 'left', search: 'left', terminal: 'bottom', terminals: 'right' },
    chosenViews: {},
    requestedView: null,
    sidebarVisible: true,
    panelVisible: true,
    secondarySidebarVisible: true,
  });
}

/** Ctrl/⌘+Shift+F, or the Search icon: what the layout then does with the request. */
function showSearch() {
  store().showView('search');
  store().clearRequestedView();
}

describe('Activity bar: lit for the view on screen, and the Explorer icon shows the Explorer', () => {
  beforeEach(fresh);

  test('AB-01: once Search is showing, Search is lit and the Explorer is not', () => {
    showSearch();
    assert.equal(shownView(store(), 'left'), 'search');
    assert.deepEqual(lit(), { explorer: false, search: true });
  });

  test('AB-02: the Explorer icon, with Search showing, shows the Explorer and keeps the side bar', () => {
    showSearch();
    store().toggleView('explorer');
    assert.equal(store().sidebarVisible, true, 'the side bar was hidden instead');
    assert.equal(shownView(store(), 'left'), 'explorer');
    assert.deepEqual(lit(), { explorer: true, search: false });
  });

  test('AB-03: the Explorer icon, with the Explorer showing, hides the side bar, and brings it back', () => {
    assert.deepEqual(lit(), { explorer: true, search: false }, 'the side bar starts on the Explorer');
    store().toggleView('explorer');
    assert.equal(store().sidebarVisible, false);
    assert.deepEqual(lit(), { explorer: false, search: false }, 'nothing is lit for a hidden side bar');
    store().toggleView('explorer');
    assert.equal(store().sidebarVisible, true);
    assert.deepEqual(lit(), { explorer: true, search: false });
  });

  test('AB-04: Search hidden with the side bar comes back as Search', () => {
    showSearch();
    store().toggleSidebar();
    assert.deepEqual(lit(), { explorer: false, search: false });
    showSearch();
    assert.equal(store().sidebarVisible, true);
    assert.deepEqual(lit(), { explorer: false, search: true });
  });

  test('AB-05: a tab clicked in the side bar\'s own header is what the bar lights', () => {
    store().chooseView('left', 'search');
    assert.deepEqual(lit(), { explorer: false, search: true });
    store().chooseView('left', 'explorer');
    assert.deepEqual(lit(), { explorer: true, search: false });
  });

  test('AB-06: a view dragged to another region is lit, and toggled, where it is', () => {
    store().moveView('explorer', 'bottom');
    // The side bar has only Search left, and shows it; the panel shows the
    // Explorer, its first view.
    assert.equal(shownView(store(), 'left'), 'search');
    assert.equal(shownView(store(), 'bottom'), 'explorer');
    assert.deepEqual(lit(), { explorer: true, search: true });
    store().toggleView('explorer');
    assert.equal(store().panelVisible, false, 'the Explorer\'s own region is the one hidden');
    assert.equal(store().sidebarVisible, true);
    store().toggleView('explorer');
    assert.equal(store().panelVisible, true);
  });

  test('AB-07: a choice the region no longer holds falls back to its first view', () => {
    store().chooseView('left', 'search');
    store().moveView('search', 'right');
    assert.equal(shownView(store(), 'left'), 'explorer');
    assert.equal(shownView(store(), 'right'), 'search', 'VIEW_ORDER puts Search before Terminals');
  });

  test('AB-08: showView still says that a view was asked for, once per request', () => {
    // A view may act on being asked for again while already on screen.
    store().showView('search');
    const first = store().requestedView;
    assert.equal(first?.view, 'search');
    assert.equal(first?.region, 'left');
    store().clearRequestedView();
    store().showView('search');
    assert.notEqual(store().requestedView, first, 'a second request is a new one');
  });

  test('AB-09: teardown — the layout as the app starts it', () => {
    fresh();
    assert.deepEqual(lit(), { explorer: true, search: false });
  });
});
