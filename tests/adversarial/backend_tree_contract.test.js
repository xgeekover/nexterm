/**
 * The other half of the explorer's contract with the backend.
 *
 * `src-tauri/src/fs/mod.rs::explorer_contract_tests` reads a directory tree
 * that really exists and writes what `fs_read_dir` returned to
 * `tests/fixtures/backend-tree.json`. This file picks those exact bytes up and
 * pushes them through the REAL explorer pipeline. On the Windows CI job the
 * fixture was produced by a Windows filesystem, which is the only way — short
 * of standing at the machine — to show that the tree is not empty there.
 *
 * The explorer WAS empty on Windows for two releases and nothing caught it:
 * the Rust tests ran only on ubuntu, and the JS tests fed themselves
 * hand-written paths. Neither half was wrong on its own; nothing checked them
 * against each other.
 */
import { describe, test, assert, skip } from '../e2e/harness/testFramework.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { flattenVisible } from '../../src/components/explorer/treeRows.js';
import { basename, isDirectChild, isInside, relativeTo, sepOf } from '../../src/lib/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'backend-tree.json');

/** Every node in the tree, depth first. */
function allNodes(nodes, acc = []) {
  for (const n of nodes || []) {
    acc.push(n);
    if (n.children) allNodes(n.children, acc);
  }
  return acc;
}

const available = existsSync(FIXTURE);
const fixture = available ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;

describe('Backend → explorer contract, against a real filesystem listing', () => {
  test('BT-00: the fixture exists — run `cargo test` first if this fails', () => {
    if (!available) {
      const where = path.relative(process.cwd(), FIXTURE);
      // In CI `cargo test` always runs before this, so a missing fixture there
      // means the contract went unchecked — which is the state this whole file
      // exists to prevent. Locally it just means the JS suite was run alone.
      // In CI `cargo test` always runs first, so a missing fixture there means
      // the contract went unchecked — a hard failure, not a skip. Locally it
      // just means the JS suite was run on its own.
      assert.equal(
        Boolean(process.env.CI),
        false,
        `${where} is missing in CI — the backend contract went unchecked`
      );
      skip(`no ${where} — run \`cd src-tauri && cargo test\` first`);
    }
    assert.ok(fixture.platform, 'the fixture records which platform produced it');
    assert.ok(Array.isArray(fixture.nodes), 'and the listing itself');
  });

  test('BT-01: the explorer renders rows — it must never come up empty', () => {
    if (!available) skip('no tests/fixtures/backend-tree.json — run `cd src-tauri && cargo test` first');
    // The store puts `fs_read_dir`'s result straight into `fileTree`, and the
    // panel renders `flattenVisible(fileTree, expanded)`. Nothing in between.
    const rows = flattenVisible(fixture.nodes, new Set());
    assert.ok(
      rows.length > 0,
      `a real ${fixture.platform} listing produced no rows — this is the Windows bug`
    );
    assert.deepEqual(
      rows.map((r) => r.node.name),
      ['src', 'tests', 'package.json'],
      'and in the order the backend chose'
    );

    // Rendering rows is not the whole of it. The explorer used to derive the
    // root's listing by testing each path against the root, and on Windows
    // that test was false for every entry — so the tree was handed data and
    // still drew nothing. `flattenVisible` alone never touches a path, so
    // without this the case passes with the path helpers completely broken,
    // which is exactly what it claims to cover.
    for (const row of rows) {
      assert.ok(
        isDirectChild(fixture.root, row.node.path),
        `a rendered row is not understood as a child of the root: ${row.node.path}`
      );
    }
  });

  test('BT-02: expanding a folder reveals what the backend nested inside it', () => {
    if (!available) skip('no tests/fixtures/backend-tree.json — run `cd src-tauri && cargo test` first');
    const src = fixture.nodes.find((n) => n.name === 'src');
    assert.ok(src, 'the fixture has a src directory');

    const collapsed = flattenVisible(fixture.nodes, new Set());
    const expanded = flattenVisible(fixture.nodes, new Set([src.path]));
    assert.ok(expanded.length > collapsed.length, 'expanding must add rows');

    const shown = expanded.map((r) => r.node.name);
    assert.ok(shown.includes('components'), 'src’s own subdirectory appears');
    assert.ok(shown.includes('index.js'), 'and its file');

    // Two levels down, which is where a flat-vs-nested mistake shows up.
    const components = src.children.find((n) => n.name === 'components');
    const deep = flattenVisible(fixture.nodes, new Set([src.path, components.path]));
    const deepRow = deep.find((r) => r.node.name === 'App.jsx');
    assert.ok(deepRow, 'a file two levels down is reachable');
    assert.equal(deepRow.depth, 2, 'and is drawn at the right indent');
  });

  test('BT-03: the path helpers agree with the paths the backend actually produced', () => {
    if (!available) skip('no tests/fixtures/backend-tree.json — run `cd src-tauri && cargo test` first');
    const { root, nodes, separator } = fixture;

    assert.equal(sepOf(nodes[0].path), separator, 'the separator is the one the OS reported');

    for (const node of nodes) {
      assert.ok(isDirectChild(root, node.path), `${node.path} must read as a direct child of the root`);
      assert.equal(basename(node.path), node.name, 'basename matches the backend’s own name');
    }

    for (const node of allNodes(nodes)) {
      assert.ok(isInside(root, node.path), `${node.path} must read as inside the root`);
      const rel = relativeTo(root, node.path);
      assert.ok(rel && rel !== node.path, `a relative path must be derivable for ${node.path}`);
      assert.equal(rel.startsWith(separator), false, 'and must not start with a separator');
    }

    // Parent/child checked against the nesting the backend chose, rather than
    // against a path convention we assumed.
    for (const node of allNodes(nodes)) {
      for (const child of node.children || []) {
        assert.ok(
          isDirectChild(node.path, child.path),
          `${child.path} is nested under ${node.path} but does not read as its direct child`
        );
      }
    }
  });

  test('BT-04: a Windows listing is exercised on Windows, not merely simulated', () => {
    if (!available) skip('no tests/fixtures/backend-tree.json — run `cd src-tauri && cargo test` first');
    if (fixture.platform === 'windows') {
      assert.equal(fixture.separator, '\\', 'a Windows fixture uses backslashes');
      assert.ok(/^[A-Za-z]:\\/.test(fixture.root), `and a drive-rooted path: ${fixture.root}`);
    } else {
      // Not a failure — a note that this run proves nothing about Windows.
      assert.equal(fixture.separator, '/', `${fixture.platform} fixture uses forward slashes`);
    }
  });
});
