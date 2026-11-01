/**
 * Stage 5: what the project commands store keeps (src/stores/
 * projectCommandsStore.js) — the open folder's `.nexterm/commands.json` as
 * the backend reads it, whether it is trusted, and the user's own commands.
 *
 * Driven through the browser mock's `project_commands_read`, which reads the
 * mock's virtual tree with the real SHA-256 (project_commands_backend_mock.
 * test.js holds that), and answers what a case forces where the disk cannot
 * be had (`projectCommandsAnswer`: a link, a network drive). Reads are held
 * where a case needs to say what arrives while another is out.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { mockBridge } from '../../src/lib/ipc.js';
import { setTerminalNoticeSink } from '../../src/lib/terminalNotice.js';
import { EXAMPLE_COMMANDS_FILE, TRUST_KEY, TRUST_LIMIT } from '../../src/lib/projectCommands.js';
import { REREAD_DELAY_MS, runProblem, useProjectCommandsStore, userCommandsCheck } from '../../src/stores/projectCommandsStore.js';
import { useEditorStore } from '../../src/stores/editorStore.js';
import { useSettingsStore } from '../../src/stores/settingsStore.js';
import { buildPaletteGroups } from '../../src/lib/paletteItems.js';

const P = useProjectCommandsStore;
const ROOT = '/workspace';
const OTHER = '/elsewhere';
const fileOf = (root) => `${root}/.nexterm/commands.json`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `pred()` holds, or fail saying `what`. */
async function until(pred, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const TWO = JSON.stringify({
  version: 1,
  commands: [
    { name: 'Test', description: 'Run every test', command: 'npm test' },
    { name: 'One file', command: 'npm test -- {{file}}', placeholders: { file: { default: 'a.test.js' } } },
    { name: 'Broken', command: 'echo "{{x}}"' },
  ],
});
const CHANGED = TWO.replace('npm test"', 'npm test --watch"');

/** The pristine store, taken before any case touches it. */
const PRISTINE = (({ root, status, reason, sha256, project, trust, trustEntries, user, reviewing, running }) => ({
  root, status, reason, sha256, project, trust, trustEntries, user, reviewing, running,
}))(P.getState());

/**
 * Run `fn` in a world of its own: storage of its own, the mock's `.nexterm`
 * folders empty, the editor on ROOT, every notice caught — and put it all
 * back after, whatever happens.
 */
async function world(fn) {
  const backing = new Map();
  const hadStorage = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  const hadRoot = Object.prototype.hasOwnProperty.call(mockBridge, 'root');
  const mockRoot = mockBridge.root;
  const forced = mockBridge.projectCommandsAnswer;
  const invoke = mockBridge.invoke;
  const editor = (({ rootPath, rootResolved, tabs, activeTabId }) => ({ rootPath, rootResolved, tabs, activeTabId }))(useEditorStore.getState());
  const notices = [];
  const unsink = setTerminalNoticeSink((tabId, message) => {
    notices.push(message);
    return true;
  });
  const clearMock = () => {
    for (const root of [ROOT, OTHER]) {
      const dir = `${root}/.nexterm`;
      for (const key of [...mockBridge.files.keys()]) if (key === dir || key.startsWith(`${dir}/`)) mockBridge.files.delete(key);
      for (const key of [...mockBridge.directories]) if (key === dir || key.startsWith(`${dir}/`)) mockBridge.directories.delete(key);
    }
  };
  clearMock();
  mockBridge.root = ROOT;
  mockBridge.projectCommandsAnswer = null;
  useEditorStore.setState({ rootPath: ROOT, rootResolved: true });
  useSettingsStore.getState().setSetting('terminalUserCommands', '');
  P.setState({ ...PRISTINE, trustEntries: [] });
  P.getState().loadTrust();
  let stop = null;
  const reads = () => mockBridge.projectCommandsReads.length;
  try {
    await fn({
      backing,
      notices,
      reads,
      start: () => {
        stop = P.getState().start();
        return stop;
      },
    });
  } finally {
    stop?.();
    mockBridge.invoke = invoke;
    // Whatever is still reading finishes against an empty world, before the next case.
    clearMock();
    await P.getState().refresh();
    unsink();
    useSettingsStore.getState().setSetting('terminalUserCommands', '');
    useEditorStore.setState(editor);
    mockBridge.projectCommandsAnswer = forced;
    if (hadRoot) mockBridge.root = mockRoot;
    else delete mockBridge.root;
    P.setState({ ...PRISTINE });
    if (hadStorage) globalThis.localStorage = previousStorage;
    else delete globalThis.localStorage;
  }
}

/**
 * Hold every `project_commands_read`: each is answered as the mock would
 * answer it when it was asked, but only once the case lets it through.
 */
function holdReads() {
  const original = mockBridge.invoke;
  const held = [];
  mockBridge.invoke = function (command, args, ...rest) {
    if (command !== 'project_commands_read') return original.call(this, command, args, ...rest);
    const answer = original.call(this, command, args, ...rest);
    return new Promise((resolve) => held.push(() => resolve(answer)));
  };
  return {
    held,
    // Every read still held is let through, so a case that failed with one
    // out does not leave the next case waiting on it.
    restore: () => {
      mockBridge.invoke = original;
      for (const release of held) release();
    },
  };
}

const reviewRows = (state) =>
  buildPaletteGroups({ mode: 'all', projectCommands: state })
    .find((g) => g.label === 'project commands')
    ?.items.map((row) => row.type) ?? [];

describe('Project commands store: what the folder\'s file says', () => {
  test('PCS-01: no file — none, nothing offered; a file — read, parsed, and not trusted until it is', async () => {
    await world(async ({ reads, start }) => {
      const before = reads();
      start();
      await until(() => P.getState().status === 'none', 'the first read');
      assert.equal(P.getState().root, ROOT);
      assert.equal(reads() - before, 1, 'read once as the folder became known');
      assert.deepEqual(reviewRows(P.getState()), []);

      mockBridge.files.set(fileOf(ROOT), TWO);
      await P.getState().refresh();
      const s = P.getState();
      assert.equal(s.status, 'ok');
      assert.match(s.sha256, /^[0-9a-f]{64}$/);
      assert.equal(s.project.ok, true);
      assert.deepEqual(s.project.commands.map((c) => c.name), ['Test', 'One file']);
      assert.equal(s.project.refused.length, 1, 'a blank inside quotes is refused, the rest still load');
      assert.equal(s.trust, 'untrusted');
      assert.deepEqual(P.getState().available(), [], 'nothing of an untrusted file is offered');
      assert.deepEqual(reviewRows(s), ['project-review'], 'one row: review them first');
    });
  });

  test('PCS-02: refused and error say why, offer nothing, and clear what an earlier read had', async () => {
    await world(async ({ start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      mockBridge.projectCommandsAnswer = { status: 'refused', reason: '.nexterm is a link.' };
      await P.getState().refresh();
      let s = P.getState();
      assert.deepEqual([s.status, s.reason, s.sha256, s.project], ['refused', '.nexterm is a link.', null, null]);
      assert.deepEqual(reviewRows(s), [], 'no row that would open what was refused');
      mockBridge.projectCommandsAnswer = { status: 'error', reason: 'larger than 256 KB' };
      await P.getState().refresh();
      s = P.getState();
      assert.deepEqual([s.status, s.reason], ['error', 'larger than 256 KB']);
      // A backend that rejects is an error in its words; an answer of no
      // known shape is an error too, never an 'ok' with nothing in it.
      mockBridge.projectCommandsAnswer = null;
      const original = mockBridge.invoke;
      mockBridge.invoke = function (command, ...rest) {
        return command === 'project_commands_read' ? Promise.reject(new Error('Unknown IPC command')) : original.call(this, command, ...rest);
      };
      await P.getState().refresh();
      assert.deepEqual([P.getState().status, P.getState().reason], ['error', 'Unknown IPC command']);
      mockBridge.invoke = function (command, ...rest) {
        return command === 'project_commands_read' ? Promise.resolve({ status: 'ok', text: '{}' }) : original.call(this, command, ...rest);
      };
      await P.getState().refresh();
      assert.equal(P.getState().status, 'error', 'ok without a hash is not ok');
      mockBridge.invoke = original;
    });
  });

  test('PCS-03: a read that finds the same bytes sets nothing — the rows the palette drew stay as they are', async () => {
    await world(async ({ start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      const project = P.getState().project;
      let writes = 0;
      const off = P.subscribe(() => (writes += 1));
      try {
        await P.getState().refresh();
        await P.getState().refresh();
      } finally {
        off();
      }
      assert.equal(writes, 0, `${writes} store writes for reads that found nothing new`);
      assert.equal(P.getState().project, project, 'the same parsed object');
      // Other bytes: a new read is kept.
      mockBridge.files.set(fileOf(ROOT), CHANGED);
      await P.getState().refresh();
      assert.notEqual(P.getState().project, project);
    });
  });
});

describe('Project commands store: trust', () => {
  test('PCS-04: trusted is (folder, hash) — offered then; a changed byte asks again; Stop Trusting forgets the folder', async () => {
    await world(async ({ backing, start, notices }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      const trustedHash = P.getState().sha256;
      assert.equal(P.getState().openReview(), true);
      assert.equal(P.getState().trustCurrent(), true);
      let s = P.getState();
      assert.equal(s.trust, 'trusted');
      assert.equal(s.reviewing, null, 'trusting closes the review');
      assert.deepEqual(s.available().map((c) => c.name), ['Test', 'One file']);
      const saved = JSON.parse(backing.get(TRUST_KEY)).data;
      assert.deepEqual(saved.map(({ root, sha256 }) => ({ root, sha256 })), [{ root: ROOT, sha256: trustedHash }]);

      mockBridge.files.set(fileOf(ROOT), CHANGED);
      await P.getState().refresh();
      s = P.getState();
      assert.equal(s.trust, 'changed');
      assert.deepEqual(s.available(), [], 'nothing of a changed file is offered');
      const [row] = buildPaletteGroups({ mode: 'all', projectCommands: s }).find((g) => g.label === 'project commands').items;
      assert.match(row.subtitle, /changed since you trusted them/);

      // The bytes that were trusted, back: trusted again, without asking.
      mockBridge.files.set(fileOf(ROOT), TWO);
      await P.getState().refresh();
      assert.equal(P.getState().trust, 'trusted');

      assert.equal(P.getState().distrustCurrent(), true);
      assert.equal(P.getState().trust, 'untrusted');
      assert.deepEqual(JSON.parse(backing.get(TRUST_KEY)).data, [], 'forgotten in storage too');
      assert.match(notices.at(-1), /no longer trusted/);
      assert.equal(P.getState().distrustCurrent(), false, 'nothing left to forget');
      assert.match(notices.at(-1), /Nothing in this folder is trusted/);
    });
  });

  test('PCS-05: Trust trusts what the review SHOWED — not a read made while it was open', async () => {
    await world(async ({ start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      const shown = P.getState().sha256;
      P.getState().openReview();
      // Swapped on disk while the user reads the review.
      mockBridge.files.set(fileOf(ROOT), CHANGED);
      await P.getState().refresh();
      assert.notEqual(P.getState().sha256, shown, 'setup: a new read');
      assert.equal(P.getState().reviewing.sha256, shown, 'the review still shows what it opened with');
      P.getState().trustCurrent();
      assert.deepEqual(
        P.getState().trustEntries.map((e) => e.sha256),
        [shown],
        'the hash of what was shown is trusted'
      );
      assert.equal(P.getState().trust, 'changed', 'and what is on disk now is not');
      assert.deepEqual(P.getState().available(), []);
    });
  });

  test('PCS-06: another folder is its own question; storage that throws or holds garbage costs nothing but memory', async () => {
    await world(async ({ backing }) => {
      backing.set(
        TRUST_KEY,
        JSON.stringify({
          version: 2,
          data: [
            { root: ROOT, sha256: 'a'.repeat(64), at: 1 },
            { root: 7, sha256: 'b'.repeat(64), at: 2 },
            'junk',
            { root: OTHER, sha256: 'not a hash', at: 3 },
          ],
        })
      );
      P.getState().loadTrust();
      assert.deepEqual(P.getState().trustEntries, [{ root: ROOT, sha256: 'a'.repeat(64), at: 1 }]);
      // The same bytes in another folder: not trusted — a clone of a trusted
      // repository is somebody else's copy.
      P.setState({ root: OTHER, status: 'ok', sha256: 'a'.repeat(64), project: { ok: true, commands: [], refused: [] } });
      P.getState().loadTrust();
      assert.equal(P.getState().trust, 'untrusted');
      P.setState({ root: ROOT });
      P.getState().loadTrust();
      assert.equal(P.getState().trust, 'trusted', 'and in its own folder it is');
      backing.set(TRUST_KEY, '{ not json');
      P.getState().loadTrust();
      assert.deepEqual(P.getState().trustEntries, []);

      // Storage that throws on every touch.
      const working = globalThis.localStorage;
      globalThis.localStorage = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      };
      try {
        P.getState().loadTrust();
        assert.deepEqual(P.getState().trustEntries, []);
        P.setState({ root: ROOT, status: 'ok', sha256: 'c'.repeat(64), project: { ok: true, commands: [], refused: [] } });
        assert.equal(P.getState().openReview(), true);
        assert.equal(P.getState().trustCurrent(), true, 'trusted, for this session at least');
        assert.equal(P.getState().trust, 'trusted');
      } finally {
        globalThis.localStorage = working;
      }
      // At most TRUST_LIMIT folders, the newest kept.
      const many = Array.from({ length: TRUST_LIMIT + 5 }, (_, i) => ({ root: `/r${i}`, sha256: 'd'.repeat(64), at: i }));
      backing.set(TRUST_KEY, JSON.stringify({ version: 2, data: many }));
      P.getState().loadTrust();
      assert.equal(P.getState().trustEntries.length, TRUST_LIMIT);
      assert.equal(P.getState().trustEntries[0].root, `/r${TRUST_LIMIT + 4}`);
    });
  });
});

describe('Project commands store: when it reads', () => {
  test('PCS-07: a read asked for while one is out is one more read after it — never lost, never two at once', async () => {
    await world(async ({ reads, start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      const gate = holdReads();
      try {
        const before = reads();
        start();
        await until(() => gate.held.length === 1, 'the first read to be asked');
        // Three more asks while it is out — the palette opening, a save.
        P.getState().refresh();
        P.getState().refresh();
        const done = P.getState().refresh();
        await sleep(20);
        assert.equal(gate.held.length, 1, 'no second read while the first is out');
        mockBridge.files.set(fileOf(ROOT), CHANGED);
        gate.held[0]();
        await until(() => gate.held.length === 2, 'one more read after it');
        gate.held[1]();
        await done;
        await sleep(20);
        assert.equal(gate.held.length, 2, 'the asks made during the first read are one read, not three');
        assert.equal(reads() - before, 2);
        assert.equal(P.getState().project.commands[0].template, 'npm test --watch', 'and that read is the one kept');
      } finally {
        gate.restore();
      }
    });
  });

  test('PCS-08: a read that answers after the folder changed is dropped; the new folder is read and nothing of the old one shows', async () => {
    await world(async ({ start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      mockBridge.files.set(fileOf(OTHER), JSON.stringify({ version: 1, commands: [{ name: 'Other', command: 'make' }] }));
      const gate = holdReads();
      try {
        start();
        await until(() => gate.held.length === 1, 'the read of the first folder');
        // Open Recent, while that read is out.
        mockBridge.root = OTHER;
        useEditorStore.setState({ rootPath: OTHER });
        assert.equal(P.getState().root, OTHER, 'the folder left is let go at once');
        assert.equal(P.getState().project, null);
        gate.held[0]();
        await until(() => gate.held.length === 2, 'the new folder read');
        assert.equal(P.getState().root, OTHER);
        assert.equal(P.getState().project, null, "the old folder's answer was dropped, not shown under the new one");
        gate.held[1]();
        await until(() => P.getState().status === 'ok', 'the new folder read to land');
        assert.deepEqual(P.getState().project.commands.map((c) => c.name), ['Other']);
      } finally {
        gate.restore();
      }
    });
  });

  test('PCS-09: a change under .nexterm reads again once things settle; a change anywhere else does not', async () => {
    await world(async ({ reads, start }) => {
      start();
      await until(() => P.getState().status === 'none', 'the first read');
      const before = reads();
      await mockBridge.emit('fs-change', { path: `${ROOT}/src/app.js`, kind: 'modify' });
      await mockBridge.emit('fs-change', { path: `${ROOT}/.nextermish/x`, kind: 'modify' });
      await sleep(REREAD_DELAY_MS + 80);
      assert.equal(reads() - before, 0, 'read for a file that is not under .nexterm');
      mockBridge.files.set(fileOf(ROOT), TWO);
      await mockBridge.emit('fs-change', { path: `${ROOT}/.nexterm`, kind: 'create_dir' });
      await mockBridge.emit('fs-change', { path: fileOf(ROOT), kind: 'create' });
      await mockBridge.emit('fs-change', { path: fileOf(ROOT), kind: 'modify' });
      await sleep(REREAD_DELAY_MS / 2);
      assert.equal(reads() - before, 0, 'not before the changes settle');
      await until(() => P.getState().status === 'ok', 'the read after they settle');
      assert.equal(reads() - before, 1, 'three changes, one read');
    });
  });

  test('PCS-10: no folder open: nothing to read, and Open Project Commands File says so and makes nothing', async () => {
    await world(async ({ reads, start, notices }) => {
      useEditorStore.setState({ rootPath: null });
      const before = reads();
      start();
      await P.getState().refresh();
      assert.equal(P.getState().status, 'none');
      assert.equal(reads() - before, 0, 'the backend is not asked about no folder');
      assert.equal(await P.getState().openCommandsFile(), false);
      assert.match(notices.at(-1), /No folder is open/);
    });
  });
});

describe('Project commands store: the file, and the user\'s own commands', () => {
  test('PCS-11: Open Project Commands File makes .nexterm/commands.json with the example when there is none, then opens it', async () => {
    await world(async ({ start }) => {
      start();
      await until(() => P.getState().status === 'none', 'the first read');
      assert.equal(await P.getState().openCommandsFile(), true);
      assert.equal(mockBridge.files.get(fileOf(ROOT)), EXAMPLE_COMMANDS_FILE);
      assert.equal(useEditorStore.getState().getActiveTab()?.filePath, fileOf(ROOT), 'opened in the editor');
      // There now: opened as it is, not written again.
      mockBridge.files.set(fileOf(ROOT), TWO);
      await P.getState().refresh();
      assert.equal(await P.getState().openCommandsFile(), true);
      assert.equal(mockBridge.files.get(fileOf(ROOT)), TWO, 'an existing file is never overwritten');
    });
  });

  test('PCS-12: a file the backend refused to read is not opened — the link may lead to another computer', async () => {
    await world(async ({ start, notices }) => {
      mockBridge.projectCommandsAnswer = { status: 'refused', reason: '.nexterm is a link.' };
      start();
      await until(() => P.getState().status === 'refused', 'the first read');
      const asked = [];
      const original = mockBridge.invoke;
      mockBridge.invoke = function (command, args, ...rest) {
        asked.push(command);
        return original.call(this, command, args, ...rest);
      };
      try {
        assert.equal(await P.getState().openCommandsFile(), false);
      } finally {
        mockBridge.invoke = original;
      }
      assert.deepEqual(asked.filter((c) => c !== 'project_commands_read'), [], 'nothing made, nothing read');
      assert.match(notices.at(-1), /not opened: \.nexterm is a link\./);
    });
  });

  test('PCS-13: the user\'s commands follow Settings, are offered (trusted: the user wrote them), and Settings says what the validator says', async () => {
    await world(async ({ start }) => {
      start();
      const text = JSON.stringify({ version: 1, commands: [{ name: 'Deploy', command: 'npm run deploy -- {{stage}}' }, { name: 'bad', comand: 'x' }] });
      useSettingsStore.getState().setSetting('terminalUserCommands', text);
      const user = P.getState().user;
      assert.equal(user.ok, true);
      assert.deepEqual(user.commands.map((c) => [c.name, c.source, c.key]), [['Deploy', 'user', 'user:0']]);
      assert.ok(P.getState().available().some((c) => c.key === 'user:0'), 'offered without a review');
      const check = userCommandsCheck(text);
      assert.equal(check.tone, 'error');
      assert.match(check.lines[0], /^1 command; 1 refused/);
      assert.match(check.lines[1], /^Command 2 \(bad\): A key NexTerm does not know: "comand"\.$/);
      assert.deepEqual(userCommandsCheck(''), { tone: 'muted', lines: ['No user commands.'] });
      assert.match(userCommandsCheck('{').lines[0], /^Not read: It is not valid JSON/);
      assert.equal(userCommandsCheck('x'.repeat(65537)).lines[0], 'Not read: It is longer than 65536 characters.');
      useSettingsStore.getState().setSetting('terminalUserCommands', '');
      assert.equal(P.getState().user, null);
    });
  });

  test('PCS-14: the run dialog opens only for a command the palette may offer now, and a second Run of one opening types nothing', async () => {
    await world(async ({ start }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      assert.equal(P.getState().openRun('project:0'), false, 'not before it is trusted');
      P.getState().openReview();
      P.getState().trustCurrent();
      assert.equal(P.getState().openRun('project:0'), true);
      const { id } = P.getState().running;
      const { useTerminalStore } = await import('../../src/stores/terminalStore.js');
      const calls = [];
      const original = useTerminalStore.getState().runProjectCommand;
      useTerminalStore.setState({ runProjectCommand: async (plan) => (calls.push(plan), true) });
      try {
        const plan = { target: 'this', tabId: 't1', line: 'npm test', enter: true };
        const first = P.getState().submitRun(id, plan);
        const second = P.getState().submitRun(id, plan);
        assert.equal(await second, false);
        assert.equal(await first, true);
        assert.equal(P.getState().running, null, 'the dialog closed on the first');
        assert.deepEqual(calls.map(({ check, ...rest }) => rest), [plan], 'typed once');
        assert.equal(typeof calls[0].check, 'function', 'with the check asked right before typing');
      } finally {
        useTerminalStore.setState({ runProjectCommand: original });
      }
    });
  });
});

describe('Project commands store: what the backend says it read, and a dialog open meanwhile', () => {
  test('PCS-15: an answer for another folder than the one asked about is dropped; one that names none is taken (an older backend)', async () => {
    await world(async ({ start }) => {
      start();
      await until(() => P.getState().status === 'none', 'the first read');
      const sha = 'e'.repeat(64);
      const text = JSON.stringify({ version: 1, commands: [{ name: 'Other', command: 'make' }] });
      mockBridge.projectCommandsAnswer = { status: 'ok', root: OTHER, text, sha256: sha };
      await P.getState().refresh();
      assert.equal(P.getState().status, 'none', "another folder's commands are never shown under this one");
      assert.equal(P.getState().sha256, null);
      mockBridge.projectCommandsAnswer = { status: 'ok', root: `${ROOT}/`, text, sha256: sha };
      await P.getState().refresh();
      assert.equal(P.getState().status, 'ok', 'the same folder, spelled with a trailing separator');
      mockBridge.projectCommandsAnswer = { status: 'refused', reason: 'x' };
      await P.getState().refresh();
      assert.equal(P.getState().status, 'refused', 'no root: taken as before');
    });
  });

  test('PCS-16: a run dialog opened on a folder command stops counting once the file changes, its trust is taken back, or another folder opens — Run refuses then', async () => {
    await world(async ({ start, notices }) => {
      mockBridge.files.set(fileOf(ROOT), TWO);
      start();
      await until(() => P.getState().status === 'ok', 'the first read');
      P.getState().openReview();
      P.getState().trustCurrent();
      assert.equal(P.getState().openRun('project:0'), true);
      const run = P.getState().running;
      assert.equal(run.sha256, P.getState().sha256, 'opened from the file as it was trusted');
      assert.equal(runProblem(P.getState(), run), null);

      mockBridge.files.set(fileOf(ROOT), CHANGED);
      await P.getState().refresh();
      assert.match(runProblem(P.getState(), run), /changed since this opened/);
      const { useTerminalStore } = await import('../../src/stores/terminalStore.js');
      const calls = [];
      const original = useTerminalStore.getState().runProjectCommand;
      useTerminalStore.setState({ runProjectCommand: async (plan) => (calls.push(plan), true) });
      try {
        assert.equal(await P.getState().submitRun(run.id, { target: 'this', tabId: 't1', line: 'npm test' }), false);
        assert.deepEqual(calls, [], 'nothing typed');
        assert.match(notices.at(-1), /not typed: this folder's commands file has changed since this opened/);
        assert.ok(P.getState().running, 'the dialog stays, saying why');

        // The bytes it was opened with, back — and then its trust taken back.
        mockBridge.files.set(fileOf(ROOT), TWO);
        await P.getState().refresh();
        assert.equal(runProblem(P.getState(), run), null);
        P.getState().distrustCurrent();
        assert.match(runProblem(P.getState(), run), /no longer trusted/);
        P.getState().openReview();
        P.getState().trustCurrent();
        // Another folder open.
        mockBridge.root = OTHER;
        useEditorStore.setState({ rootPath: OTHER });
        assert.match(runProblem(P.getState(), run), /another folder/);

        // Checked again right before typing: trusted when Run was pressed,
        // changed by the time the line would be typed.
        mockBridge.root = ROOT;
        useEditorStore.setState({ rootPath: ROOT });
        await until(() => P.getState().status === 'ok', 'the folder read again');
        assert.equal(runProblem(P.getState(), run), null);
        assert.equal(await P.getState().submitRun(run.id, { target: 'this', tabId: 't1', line: 'npm test' }), true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].check(), null, 'still trusted');
        mockBridge.files.set(fileOf(ROOT), CHANGED);
        await P.getState().refresh();
        assert.match(calls[0].check(), /changed since this opened/, 'the check made right before typing sees the change');
      } finally {
        useTerminalStore.setState({ runProjectCommand: original });
      }
      // The user's own commands are theirs: nothing to ask.
      assert.equal(runProblem(P.getState(), { command: { source: 'user' } }), null);
    });
  });
});
