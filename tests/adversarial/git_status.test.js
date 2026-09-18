/**
 * What git says, and what the app does with it.
 *
 * The status bar printed a branch of "main" whatever was checked out, and it
 * was removed for lying rather than replaced — so the bar carrying a branch
 * again has to be the real one or not be there at all. The parsing lives in
 * Rust (`src-tauri/src/fs/git.rs`, which has its own cases including one
 * against this very repository); these hold the frontend half.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach, assert } from '../e2e/harness/testFramework.js';
import { buildStatusItems } from '../../src/lib/statusInfo.js';
import { fileStatusIn } from '../../src/stores/gitStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const GIT_RS = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/fs/git.rs', import.meta.url)),
  'utf8'
);

const item = (items, id) => items.find((i) => i.id === id) ?? null;
const repo = (over = {}) => ({ branch: 'main', ahead: 0, behind: 0, truncated: false, files: [], ...over });

describe('Git: the status bar', () => {
  test('GT-01: nothing at all when there is no repository', () => {
    // No folder, not a repository, no git on the machine — the same answer,
    // and the bar must not invent one. That is what was removed from it.
    const { left } = buildStatusItems({ os: 'darwin', git: null });
    assert.equal(item(left, 'git'), null);
  });

  test('GT-02: the branch, when there is one', () => {
    const { left } = buildStatusItems({ os: 'darwin', git: repo() });
    assert.equal(item(left, 'git').text, 'main');
    assert.equal(item(left, 'git').icon, 'branch');
  });

  test('GT-03: a detached head says so rather than naming a branch', () => {
    const chip = item(buildStatusItems({ os: 'darwin', git: repo({ branch: null }) }).left, 'git');
    assert.equal(chip.text, 'detached');
    assert.equal(/Detached head/.test(chip.title), true);
  });

  test('GT-04: ahead and behind, in the direction they are read', () => {
    const chip = item(buildStatusItems({ os: 'darwin', git: repo({ ahead: 2, behind: 3 }) }).left, 'git');
    assert.equal(chip.text, 'main ↓3 ↑2');
    assert.equal(/2 commits to push/.test(chip.title), true);
    assert.equal(/3 commits to pull/.test(chip.title), true);
  });

  test('GT-05: a clean tree shows no count', () => {
    const chip = item(buildStatusItems({ os: 'darwin', git: repo() }).left, 'git');
    assert.equal(chip.text, 'main', 'a zero is noise');
    assert.equal(/Nothing changed/.test(chip.title), true);
  });

  test('GT-06: a capped repository says the count is a floor', () => {
    const files = Array.from({ length: 2000 }, (_, i) => ({ path: `/w/f${i}`, status: 'modified' }));
    const chip = item(buildStatusItems({ os: 'darwin', git: repo({ files, truncated: true }) }).left, 'git');
    assert.equal(/2000\+●/.test(chip.text), true, `got ${chip.text}`);
    assert.equal(/or more/.test(chip.title), true);
  });
});

describe('Git: the Explorer', () => {
  const status = repo({
    files: [
      { path: '/w/src/a.js', status: 'modified', staged: false },
      { path: '/w/new.txt', status: 'untracked', staged: false },
    ],
  });

  test('GT-07: a file gets its own status and nothing else does', () => {
    assert.equal(fileStatusIn(status, '/w/src/a.js').status, 'modified');
    assert.equal(fileStatusIn(status, '/w/new.txt').status, 'untracked');
    assert.equal(fileStatusIn(status, '/w/src/untouched.js'), null);
  });

  test('GT-08: nothing to look in is null, not a throw', () => {
    assert.equal(fileStatusIn(null, '/w/src/a.js'), null);
    assert.equal(fileStatusIn(status, null), null);
    assert.equal(fileStatusIn(null, null), null);
  });

  test('GT-09: the lookup survives the status being replaced', () => {
    // It caches an index keyed on the files array; a new status must not be
    // answered from the old one's index.
    assert.equal(fileStatusIn(status, '/w/src/a.js').status, 'modified');
    const next = repo({ files: [{ path: '/w/src/a.js', status: 'deleted', staged: true }] });
    assert.equal(fileStatusIn(next, '/w/src/a.js').status, 'deleted');
    assert.equal(fileStatusIn(next, '/w/new.txt'), null, 'the old file is gone');
  });
});

describe('Git: the mock answers in the backend’s shape', () => {
  test('GT-10: every field Rust serialises', async () => {
    const fields = (name) => {
      const start = GIT_RS.indexOf(`pub struct ${name} {`);
      assert.notEqual(start, -1, `${name} is gone from git.rs`);
      const body = GIT_RS.slice(start, GIT_RS.indexOf('\n}', start));
      return [...body.matchAll(/pub (\w+):/g)].map((m) => m[1]).sort();
    };
    const status = await mockBridge.invoke('git_status');
    assert.deepEqual(Object.keys(status).sort(), fields('GitStatus'));
    assert.deepEqual(Object.keys(status.files[0]).sort(), fields('GitFile'));
  });

  test('GT-11: the statuses it reports are ones Rust can produce', async () => {
    // `GitFileStatus` is serialised lowercase; a value outside that set would
    // colour nothing and fail silently in the Explorer.
    const known = [...GIT_RS.matchAll(/^\s{4}(Added|Modified|Deleted|Renamed|Untracked|Conflicted),$/gm)]
      .map((m) => m[1].toLowerCase());
    assert.equal(known.length, 6, 'the enum changed shape');
    const status = await mockBridge.invoke('git_status');
    for (const file of status.files) {
      assert.equal(known.includes(file.status), true, `${file.status} is not a status Rust emits`);
    }
  });
});
