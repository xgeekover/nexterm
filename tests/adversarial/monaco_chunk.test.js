/**
 * Monaco stays out of the first chunk (editor placement, sibling C2; AC-C13),
 * read off the built app in dist/ — what `npm run build` wrote, which the
 * gate runs before the suites.
 *
 *   - MC-C1: the entry chunk named by dist/index.html, and every chunk it
 *     imports statically, hold no Monaco code: none of the strings only
 *     Monaco's own code carries (its `editor.action.*` command ids, the
 *     loader's "Monaco initialization" message, its `vs/editor` paths). A
 *     `.monaco-editor` CSS selector is the app's own code asking where the
 *     keyboard is, and is not looked for.
 *   - MC-C2: the editor pane's Monaco body is a chunk of its own
 *     (EditorPanel-*.js), which the entry loads only through a dynamic
 *     `import()`, and which does hold Monaco.
 *
 * Skipped, saying so, when there is no build to read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const ASSETS = join(DIST, 'assets');
const NO_BUILD = 'there is no build in dist/ to read — run `npm run build` first (the gate does)';
/** Strings only Monaco's own code carries. */
const MONACO_MARKS = ['editor.action.', 'Monaco initialization', 'vs/editor'];

function entryChunk() {
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(ASSETS)) skip(NO_BUILD);
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const src = /<script[^>]*type="module"[^>]*src="\/?(assets\/[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(src, 'dist/index.html names its entry chunk');
  return src.slice('assets/'.length);
}

/** The chunks `name` imports statically, `name` included, transitively. */
function staticClosure(name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  const code = readFileSync(join(ASSETS, name), 'utf8');
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[^'"()]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g)) staticClosure(m[1], seen);
  return seen;
}

describe('Monaco stays out of the first chunk (AC-C13)', () => {
  test('MC-C1: the entry chunk and what it imports statically hold no Monaco code', () => {
    const entry = entryChunk();
    const closure = [...staticClosure(entry)];
    assert.ok(closure.length >= 1);
    for (const name of closure) {
      const code = readFileSync(join(ASSETS, name), 'utf8');
      for (const mark of MONACO_MARKS) assert.equal(code.includes(mark), false, `${name} (loaded with the entry) holds Monaco code: "${mark}"`);
      assert.equal(/^EditorPanel-/.test(name), false, `${name}: the editor pane's Monaco body is loaded with the entry`);
    }
  });

  test('MC-C2: the editor pane\u{2019}s Monaco body is a chunk of its own, loaded by a dynamic import()', () => {
    const entry = entryChunk();
    const panel = readdirSync(ASSETS).filter((n) => /^EditorPanel-[^.]+\.js$/.test(n));
    assert.equal(panel.length, 1, `one EditorPanel chunk: ${panel.join(', ')}`);
    const code = readFileSync(join(ASSETS, panel[0]), 'utf8');
    assert.ok(MONACO_MARKS.some((mark) => code.includes(mark)), `${panel[0]} holds Monaco`);
    const closure = [...staticClosure(entry)].map((n) => readFileSync(join(ASSETS, n), 'utf8')).join('\n');
    assert.ok(closure.includes(`import("./${panel[0]}")`), `the entry loads ${panel[0]} through import()`);
  });
});
