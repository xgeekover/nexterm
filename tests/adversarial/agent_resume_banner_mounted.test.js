/**
 * The resume offer's "Choose…" list, mounted (src/components/terminal/
 * AgentResumeBanner.jsx).
 *
 * When Resume cannot tell which conversation a terminal had, the list opens
 * by itself. A review (2026-10-13) mounted two such offers — two panes, each
 * asking — and one ArrowDown and Enter picked the first conversation in BOTH
 * lists: every open list listened for keys on the whole window. With an
 * empty list that was `--continue` typed twice. Now one list opens by itself
 * at a time, the active pane's, and without taking focus — whoever was
 * typing into a terminal keeps typing there; a list takes keys only while
 * focus is in it or in its own offer; and a conversation another terminal
 * has is shown but cannot be picked.
 *
 * What effects and listeners do is out of reach of `renderToString`, so the
 * banner is rendered with real React on the hand-written page of
 * react_page.js, bundled with esbuild as palette_mounted.test.js does —
 * lucide's icons stood in for.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { onPage, letItRun } from './react_page.js';

const h = React.createElement;
const TERMINAL_DIR = fileURLToPath(new URL('../../src/components/terminal/', import.meta.url));
/** Kept real: the React the page renders with must be the one the component calls. */
const REAL = new Set(['react', 'react/jsx-runtime', 'react-dom', 'zustand']);

let loading = null;
function loadBanner() {
  loading ??= build({
    stdin: {
      contents: "export * from './AgentResumeBanner.jsx';",
      resolveDir: TERMINAL_DIR,
      sourcefile: 'banner-under-test.js',
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
        name: 'banner-stand-ins',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (REAL.has(args.path)) return { path: import.meta.resolve(args.path), external: true };
            return args.path === 'lucide-react' ? { path: 'lucide', namespace: 'stand-in' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({
            contents: 'const Icon = () => null; export const Check = Icon, ListOrdered = Icon, Play = Icon, X = Icon;',
            loader: 'js',
          }));
        },
      },
    ],
  }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  );
  return loading;
}

const A = 'ses_aaaaaaaaaaaaAAAAAAAAAAAAAA';
const B = 'ses_bbbbbbbbbbbbBBBBBBBBBBBBBB';
const C = 'ses_ccccccccccccCCCCCCCCCCCCCC';

/** A restored terminal whose Resume could not tell, with notice number `seq`. */
const asking = (id, seq) => ({
  id,
  title: id,
  agent: { kind: 'opencode', sessionId: null, startedAt: Date.now() - 1000, title: `In ${id}` },
  agentResumeOffered: true,
  agentResumeNotice: { kind: 'unsure', reason: null, shared: true, seq },
});

/**
 * Two offers on one page, each asking, as two panes show them, and what
 * picking from them asks for. `active` is the pane whose offer may open its
 * list by itself.
 */
async function twoOffers(p, ui, sessions, { active = ['tab-1', 'tab-2'] } = {}) {
  // The page lays nothing out: every element sits at the same place.
  const proto = Object.getPrototypeOf(p.document.createElement('div'));
  proto.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 30, right: 100, width: 90, height: 20 });
  Object.assign(p.window, { innerWidth: 1600, innerHeight: 900 });
  const picks = [];
  const offer = (id, seq) =>
    h(ui.AgentResumeBanner, {
      key: id,
      tab: asking(id, seq),
      fallback: 'ask',
      autoOpen: active.includes(id),
      onResume: () => {},
      onDismiss: () => {},
      onListSessions: async () => sessions,
      onResumeWith: (choice) => picks.push([id, choice]),
    });
  p.render(h('div', null, offer('tab-1', 1), offer('tab-2', 2)));
  await letItRun(5);
  return picks;
}

const openMenus = (p) => p.document.querySelectorAll('[role="menu"]');

/** The button called `text` in the `nth` offer on the page. */
const offerButton = (p, nth, text) =>
  p.document
    .querySelectorAll('[data-agent-resume]')
    [nth].querySelectorAll('button')
    .find((b) => b.textContent === text);

describe('Choose\u{2026} opens by itself in one offer at a time, and keys go to the list that has focus', () => {
  test('BM-01: two offers asking at once \u{2014} one list open, and one ArrowDown and Enter picks once', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      const picks = await twoOffers(p, ui, [
        { id: A, title: 'Alpha', updated: 2, created: 2, heldBy: null },
        { id: B, title: 'Beta', updated: 1, created: 1, heldBy: null },
      ]);
      assert.equal(openMenus(p).length, 1, 'both lists open, both listening');
      // Into the offer whose list is open — the second, which opened last.
      offerButton(p, 1, 'Resume').focus();
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun(5);
      assert.deepEqual(picks, [['tab-2', { sessionId: A, title: 'Alpha' }]], 'one key, one pick, in the list that opened last');
      p.unmount();
    });
  });

  test('BM-02: an empty list (nothing listed, a repository from the wrong folder) cannot type `--continue` twice', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      const picks = await twoOffers(p, ui, []);
      offerButton(p, 1, 'Resume').focus();
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun(5);
      assert.deepEqual(picks, [['tab-2', { latest: true }]]);
      p.unmount();
    });
  });

  test('BM-03: only the active pane\u{2019}s offer opens its list; the other says why and keeps its Choose\u{2026}', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      const picks = await twoOffers(p, ui, [{ id: A, title: 'Alpha', updated: 2, created: 2, heldBy: null }], {
        active: ['tab-1'],
      });
      assert.equal(openMenus(p).length, 1);
      const notices = p.document.querySelectorAll('[data-agent-resume-notice]');
      assert.equal(notices.length, 2, 'both say they could not tell');
      offerButton(p, 0, 'Resume').focus();
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun(5);
      assert.deepEqual(picks, [['tab-1', { sessionId: A, title: 'Alpha' }]]);
      p.unmount();
    });
  });

  test('BM-04: a list without focus takes no keys', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      const picks = await twoOffers(p, ui, [{ id: A, title: 'Alpha', updated: 2, created: 2, heldBy: null }], {
        active: ['tab-1'],
      });
      // Focus goes elsewhere — the terminal, say — with the list still open.
      p.el('textarea').focus();
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun(5);
      assert.deepEqual(picks, [], 'typed into the terminal, picked in the list');
      assert.equal(openMenus(p).length, 1);
      p.unmount();
    });
  });

  test('BM-05: a conversation another terminal has is listed with where it is, and skipped', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      const picks = await twoOffers(
        p,
        ui,
        [
          { id: A, title: 'Alpha', updated: 3, created: 3, heldBy: 'Terminal 3' },
          { id: B, title: 'Beta', updated: 2, created: 2, heldBy: null },
          { id: C, title: 'Gamma', updated: 1, created: 1, heldBy: null },
        ],
        { active: ['tab-1'] }
      );
      const items = p.document.querySelectorAll('[role="menuitem"]');
      const held = items.find((item) => item.textContent.includes('Alpha'));
      assert.ok(held.textContent.includes('open in Terminal 3'), held.textContent);
      assert.equal(held.getAttribute('aria-disabled'), 'true');
      offerButton(p, 0, 'Resume').focus();
      p.keydown('ArrowDown');
      p.keydown('Enter');
      await letItRun(5);
      assert.deepEqual(picks, [['tab-1', { sessionId: B, title: 'Beta' }]]);
      p.unmount();
    });
  });

  test('BM-06: a list that opens by itself leaves focus where it was; Escape closes it from its offer, and Enter there still presses the button', async () => {
    const ui = await loadBanner();
    await onPage(async (p) => {
      // The user clicked into the terminal while Resume looked.
      const terminal = p.el('textarea');
      terminal.focus();
      const picks = await twoOffers(p, ui, [{ id: A, title: 'Alpha', updated: 2, created: 2, heldBy: null }], {
        active: ['tab-1'],
      });
      assert.equal(openMenus(p).length, 1, 'setup: the list opened');
      // Compared as a yes or no: a failure message that printed both page
      // elements would print the whole page.
      assert.ok(p.document.activeElement === terminal, 'the list took the focus from the terminal being typed into');
      p.keydown('ArrowDown');
      p.keydown('Enter');
      p.keydown('Escape');
      await letItRun(5);
      assert.deepEqual(picks, [], 'keys meant for the terminal picked in the list');
      assert.equal(openMenus(p).length, 1, 'Escape meant for the terminal closed the list');

      // Focus on the offer: Enter with no row chosen is the button's.
      const resume = offerButton(p, 0, 'Resume');
      resume.focus();
      const enter = p.keydown('Enter');
      assert.equal(enter.defaultPrevented, false, 'the list swallowed Enter on the offer\u{2019}s own button');
      p.keydown('Escape');
      await letItRun(5);
      assert.equal(openMenus(p).length, 0, 'Escape on the offer left the list open');
      assert.deepEqual(picks, []);
      p.unmount();
    });
  });
});
