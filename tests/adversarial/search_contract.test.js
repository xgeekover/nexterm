/**
 * The mock's search must answer in the shape the backend answers in.
 *
 * When the mock and the real backend disagree, the mock wins the test and the
 * user loses — that has happened twice in this project and both times the mock
 * was the bug. The real search lives in Rust (`src-tauri/src/fs/search.rs`,
 * which has its own cases for what it finds and what it skips); these read the
 * field names straight out of that source and hold the browser mock to them,
 * so a rename on either side is a failure here rather than an empty panel in
 * the packaged app.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';

const SEARCH_RS = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/fs/search.rs', import.meta.url)),
  'utf8'
);

/** The `pub` field names of one struct in search.rs. */
function fieldsOf(structName) {
  const start = SEARCH_RS.indexOf(`pub struct ${structName} {`);
  assert.notEqual(start, -1, `${structName} is gone from search.rs`);
  const body = SEARCH_RS.slice(start, SEARCH_RS.indexOf('\n}', start));
  return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1]).sort();
}

describe('Search: the mock answers in the backend’s shape', () => {
  test('SC-01: the result envelope has the fields Rust serialises', async () => {
    const found = await mockBridge.invoke('fs_search', { query: 'a' });
    assert.deepEqual(Object.keys(found).sort(), fieldsOf('SearchResults'));
  });

  test('SC-02: a file entry does too', async () => {
    const found = await mockBridge.invoke('fs_search', { query: 'nexterm' });
    assert.ok(found.files.length > 0, 'the mock workspace should contain this');
    assert.deepEqual(Object.keys(found.files[0]).sort(), fieldsOf('SearchFile'));
  });

  test('SC-03: and a match', async () => {
    const found = await mockBridge.invoke('fs_search', { query: 'nexterm' });
    assert.deepEqual(Object.keys(found.files[0].matches[0]).sort(), fieldsOf('SearchMatch'));
  });

  test('SC-04: line and column are 1-based, because the editor is', async () => {
    const found = await mockBridge.invoke('fs_search', { query: 'nexterm' });
    for (const file of found.files) {
      for (const match of file.matches) {
        assert.ok(match.line >= 1, `line ${match.line} is not 1-based`);
        assert.ok(match.column >= 1, `column ${match.column} is not 1-based`);
      }
    }
  });

  test('SC-05: an empty query is not a search', async () => {
    for (const query of ['', '   ']) {
      const found = await mockBridge.invoke('fs_search', { query });
      assert.deepEqual(found.files, []);
      assert.equal(found.total_matches, 0);
    }
  });

  test('SC-06: what the Explorer hides, search hides', async () => {
    // A search that returns node_modules is a search nobody uses twice. The
    // Rust side asserts the same thing against a real directory tree.
    const found = await mockBridge.invoke('fs_search', { query: 'e' });
    const leaked = found.files.map((f) => f.path).filter((p) => /node_modules|\.git|target|dist/.test(p));
    assert.deepEqual(leaked, []);
  });

  test('SC-07: a bad pattern rejects rather than returning nothing', async () => {
    // Silently returning no results would read as "no matches", which is a
    // different and wrong answer.
    let threw = false;
    try {
      await mockBridge.invoke('fs_search', { query: 'a(', regex: true });
    } catch (err) {
      threw = true;
      assert.ok(/bad pattern/.test(String(err.message)), `unexpected error: ${err.message}`);
    }
    assert.equal(threw, true, 'an unparseable regex must not look like zero results');
  });
});
