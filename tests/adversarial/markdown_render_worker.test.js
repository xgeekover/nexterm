/**
 * Markdown preview tabs (Orca bundle 5, B3, step P6b; OQ-B3g, 2026-11-24):
 * Markdown is parsed in a worker, never on the window's thread.
 *
 *   src/lib/markdownPipeline.js      text in, safe hast out (unified +
 *                                    remark-parse + remark-gfm + the P6
 *                                    plugin + remark-rehype + the URL rule
 *                                    and allow-list)
 *   src/lib/markdownWorker.js        the worker: one answer per message
 *   src/lib/markdownRenderClient.js  the window's side: one parse at a time,
 *                                    the newest waiting, 5 s, terminate
 *   src/lib/markdownWorkerFactory.js Vite's `?worker`
 *
 *   AC-B3-5  the client on a fake worker and a fake clock: ok, the time
 *            limit terminates and says 'too-complex' and the next render
 *            makes a new worker, superseded queueing, stale ids, worker
 *            errors, dispose (MW-01..06); the worker's answers (MW-10); a
 *            real node:worker_threads worker stopped on '[a](' and '[^a]'
 *            repeated, its thread exiting, the window's thread free
 *            meanwhile, README.md answered (MW-20..21); only the worker
 *            imports the parser (MW-40); the worker as Vite builds it loads
 *            in a worker's scope (MW-50)
 *   AC-B3-1  the worker pipeline: the allow-list against hast and mdast a
 *            plugin bug could make, plain cloneable data, raw HTML literal,
 *            no src, no href but `#…`, the 2 MB limit (MW-30..37)
 *   OQ-B3g   the drawing cap (reviewer A, R2): past MARKDOWN_MAX_ELEMENTS
 *            the pipeline stops building and the worker's answer is
 *            too-complex for the client, the worker kept; a README is not
 *            touched by it (MW-60..61)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  MARKDOWN_MAX_DEPTH,
  MARKDOWN_MAX_ELEMENTS,
  MARKDOWN_PREVIEW_MAX_BYTES,
  MARKDOWN_TOO_COMPLEX_ERROR,
  RAW_HTML_CLASS,
  hastPastElements,
  markdownTooLargeText,
} from '../../src/lib/markdownPreview.js';
import { CLASS_NAMES, SAFE_ELEMENTS, markdownToHast, safeHast } from '../../src/lib/markdownPipeline.js';
import { answerMarkdownRequest } from '../../src/lib/markdownWorker.js';
import { MARKDOWN_PARSE_TIMEOUT_MS, TOO_COMPLEX_ERROR, createMarkdownRenderer } from '../../src/lib/markdownRenderClient.js';

const MB = 1024 * 1024;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');
const VITE_CONFIG = join(ROOT, 'vite.config.js');
const WORKER_URL = pathToFileURL(join(SRC, 'lib/markdownWorker.js')).href;
const FACTORY = join(SRC, 'lib/markdownWorkerFactory.js');

/** A source file, line endings as LF whatever the checkout made them. */
const source = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const AT = { filePath: '/w/docs/README.md', root: '/w' };

/** Every node of `tree`, parents before children, with a stack. */
function nodesOf(tree) {
  const out = [];
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node);
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return out;
}

/** How deep `tree` nests, with a stack. */
function depthOf(tree) {
  let max = 0;
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > max) max = depth;
    if (Array.isArray(node.children)) for (const child of node.children) stack.push([child, depth + 1]);
  }
  return max;
}

const elementsOf = (tree) => nodesOf(tree).filter((node) => node.type === 'element');

/** Fake setTimeout/clearTimeout with a clock that only moves when told to (as tab_hover_card's). */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    get live() {
      return timers.size;
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) if (timer.at <= target && (!due || timer.at < due[1].at)) due = [id, timer];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

/** A factory of fake workers, each recording what it was posted and whether it was terminated. */
function fakeWorkers() {
  const made = [];
  const createWorker = () => {
    const listeners = { message: [], error: [], messageerror: [] };
    const worker = {
      posted: [],
      terminated: false,
      postMessage(data) {
        if (worker.terminated) throw new Error('posted to a terminated worker');
        worker.posted.push(data);
      },
      terminate() {
        worker.terminated = true;
      },
      addEventListener(type, fn) {
        listeners[type]?.push(fn);
      },
      reply(data) {
        for (const fn of listeners.message) fn({ data });
      },
      fire(type, event) {
        for (const fn of listeners[type]) fn(event);
      },
    };
    made.push(worker);
    return worker;
  };
  return { made, createWorker };
}

/** What `promise` has settled to once every pending callback ran, or 'pending'. */
async function stateOf(promise) {
  const pending = Symbol('pending');
  const value = await Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(pending)))]);
  return value === pending ? 'pending' : value;
}

const HAST = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'x' }] }] };

describe('Markdown worker: the client, on a fake worker and a fake clock (AC-B3-5)', () => {
  test('MW-01: a render posts { id, text, filePath, root } to one worker, made on first use, and resolves ok with its tree and images', async () => {
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    assert.equal(made.length, 0, 'no worker before the first render');
    const result = renderer.render('# hi', AT);
    assert.equal(made.length, 1);
    assert.equal(made[0].posted.length, 1);
    const { id, ...rest } = made[0].posted[0];
    assert.deepEqual(rest, { text: '# hi', filePath: AT.filePath, root: AT.root });
    assert.equal(clock.live, 1, 'the time limit runs');
    made[0].reply({ id, ok: true, hast: HAST, images: [{ kind: 'load', path: '/w/a.png', address: 'a.png', index: 0 }] });
    assert.deepEqual(await result, { status: 'ok', hast: HAST, images: [{ kind: 'load', path: '/w/a.png', address: 'a.png', index: 0 }] });
    assert.equal(clock.live, 0, 'the time limit is cleared');
    // The same worker serves the next render.
    const again = renderer.render('two', { filePath: null, root: null });
    assert.equal(made.length, 1);
    made[0].reply({ id: made[0].posted[1].id, ok: true, hast: HAST });
    assert.deepEqual(await again, { status: 'ok', hast: HAST, images: [] }, 'no images is an empty list');
    assert.equal(made[0].terminated, false);
    renderer.dispose();
  });

  test('MW-02: past the time limit (5 s by default) the worker is terminated, the render is too-complex, and the next render makes a new worker', async () => {
    assert.equal(MARKDOWN_PARSE_TIMEOUT_MS, 5000);
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const slow = renderer.render('[a]('.repeat(1000), AT);
    clock.advance(MARKDOWN_PARSE_TIMEOUT_MS - 1);
    assert.equal(await stateOf(slow), 'pending', 'still parsing at 4999 ms');
    assert.equal(made[0].terminated, false);
    clock.advance(1);
    assert.deepEqual(await stateOf(slow), { status: 'too-complex' });
    assert.equal(made[0].terminated, true, 'the worker is terminated');
    assert.equal(made.length, 1, 'no new worker until one is needed');
    // The stopped worker's late answer changes nothing.
    made[0].reply({ id: made[0].posted[0].id, ok: true, hast: HAST });
    const next = renderer.render('# fine', AT);
    assert.equal(made.length, 2, 'a fresh worker for the next render');
    assert.equal(made[1].posted.length, 1);
    made[1].reply({ id: made[1].posted[0].id, ok: true, hast: HAST, images: [] });
    assert.equal((await next).status, 'ok');

    // A limit of its own is kept; a limit that is no positive number is the default.
    const short = fakeTimers();
    const workers = fakeWorkers();
    const quick = createMarkdownRenderer({ createWorker: workers.createWorker, timeoutMs: 500, setTimer: short.setTimer, clearTimer: short.clearTimer });
    const timed = quick.render('x');
    short.advance(500);
    assert.deepEqual(await timed, { status: 'too-complex' });
    for (const timeoutMs of [0, -1, Number.NaN, Infinity]) {
      const c = fakeTimers();
      const w = fakeWorkers();
      const r = createMarkdownRenderer({ createWorker: w.createWorker, timeoutMs, setTimer: c.setTimer, clearTimer: c.clearTimer });
      const p = r.render('x');
      c.advance(MARKDOWN_PARSE_TIMEOUT_MS - 1);
      assert.equal(await stateOf(p), 'pending', `timeoutMs ${timeoutMs}`);
      c.advance(1);
      assert.deepEqual(await p, { status: 'too-complex' }, `timeoutMs ${timeoutMs}`);
    }
    renderer.dispose();
    quick.dispose();
  });

  test('MW-03: one parse at a time; of the renders waiting only the newest is kept, the older resolve superseded and are never posted', async () => {
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const first = renderer.render('A', AT);
    const waiting = [];
    for (let n = 0; n < 100; n += 1) waiting.push(renderer.render(`B${n}`, AT));
    assert.equal(made[0].posted.length, 1, 'only the first is posted while it parses');
    for (let n = 0; n < 99; n += 1) assert.deepEqual(await stateOf(waiting[n]), { status: 'superseded' }, `B${n}`);
    assert.equal(await stateOf(waiting[99]), 'pending', 'the newest waits');
    assert.equal(clock.live, 1, 'one time limit: the one in flight');
    // A live update every 300 ms during a slow parse never piles up either.
    clock.advance(300);
    const later = renderer.render('C', AT);
    assert.deepEqual(await stateOf(waiting[99]), { status: 'superseded' });
    made[0].reply({ id: made[0].posted[0].id, ok: true, hast: HAST });
    assert.equal((await first).status, 'ok');
    assert.equal(made[0].posted.length, 2, 'then the newest is posted');
    assert.equal(made[0].posted[1].text, 'C');
    made[0].reply({ id: made[0].posted[1].id, ok: true, hast: HAST });
    assert.equal((await later).status, 'ok');
    // The waiting one gets a full time limit of its own, from when it is posted.
    const a = renderer.render('a');
    clock.advance(4000);
    const b = renderer.render('b');
    made[0].reply({ id: made[0].posted[2].id, ok: true, hast: HAST });
    await a;
    clock.advance(4999);
    assert.equal(await stateOf(b), 'pending', 'b has its own 5 s');
    clock.advance(1);
    assert.deepEqual(await b, { status: 'too-complex' });
    renderer.dispose();
  });

  test('MW-04: a reply whose id is not the one in flight is ignored, and so is anything but a plain reply', async () => {
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const one = renderer.render('one');
    const id = made[0].posted[0].id;
    for (const data of [{ id: id + 1, ok: true, hast: HAST }, { id: id - 1, ok: true, hast: HAST }, { id: String(id), ok: true, hast: HAST }, { ok: true, hast: HAST }, null, undefined, 'text', 7]) {
      made[0].reply(data);
      assert.equal(await stateOf(one), 'pending', JSON.stringify(data));
    }
    made[0].fire('message', undefined);
    assert.equal(await stateOf(one), 'pending', 'an event with no data');
    made[0].reply({ id, ok: true, hast: HAST });
    assert.equal((await one).status, 'ok');
    // The first render's id, answered again while the second is in flight, does not settle the second.
    const two = renderer.render('two');
    made[0].reply({ id, ok: true, hast: HAST });
    assert.equal(await stateOf(two), 'pending');
    // ok without a tree is no tree: an error, not a crash in the preview.
    made[0].reply({ id: made[0].posted[1].id, ok: true, hast: null });
    assert.equal((await two).status, 'error');
    renderer.dispose();
  });

  test('MW-05: a worker error, a message it cannot read and a failed load are errors; the worker is terminated and the next render makes a new one', async () => {
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    // The pipeline threw: an error with its words; the worker stays.
    const threw = renderer.render('x');
    made[0].reply({ id: made[0].posted[0].id, ok: false, error: { name: 'RangeError', message: 'Too large to preview (2.1 MB; the limit is 2 MB)' } });
    assert.deepEqual(await threw, { status: 'error', name: 'RangeError', message: 'Too large to preview (2.1 MB; the limit is 2 MB)' });
    assert.equal(made[0].terminated, false, 'a thrown error is an answer: the worker is fine');
    const long = renderer.render('x');
    made[0].reply({ id: made[0].posted[1].id, ok: false, error: { name: 'Error', message: 'm'.repeat(10_000) } });
    assert.equal((await long).message.length, 500, 'the message is cut');

    for (const type of ['error', 'messageerror']) {
      const before = made.length;
      const crash = renderer.render('y');
      const worker = made[made.length - 1];
      worker.fire(type, type === 'error' ? { message: 'Uncaught ReferenceError: document is not defined' } : {});
      const result = await crash;
      assert.equal(result.status, 'error', type);
      assert.ok(result.message.length > 0, `${type}: a message`);
      if (type === 'error') assert.equal(result.message, 'Uncaught ReferenceError: document is not defined');
      assert.equal(worker.terminated, true, `${type}: the worker is terminated`);
      assert.equal(clock.live, 0, `${type}: the time limit is cleared`);
      const next = renderer.render('z');
      assert.equal(made.length, before + 1, `${type}: a new worker for the next render`);
      made[made.length - 1].reply({ id: made[made.length - 1].posted[0].id, ok: true, hast: HAST });
      assert.equal((await next).status, 'ok');
    }
    // An error event with nothing in flight still retires the worker.
    const idle = made[made.length - 1];
    idle.fire('error', {});
    assert.equal(idle.terminated, true);

    // A worker that cannot be made (a failed load) is an error, and the waiting render still runs.
    let fail = true;
    const flaky = fakeWorkers();
    const unlucky = createMarkdownRenderer({
      createWorker: () => {
        if (fail) throw new Error('Failed to construct Worker');
        return flaky.createWorker();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    assert.deepEqual(await unlucky.render('a'), { status: 'error', name: 'Error', message: 'Failed to construct Worker' });
    fail = false;
    const then = unlucky.render('b');
    flaky.made[0].reply({ id: flaky.made[0].posted[0].id, ok: true, hast: HAST });
    assert.equal((await then).status, 'ok');
    const broken = createMarkdownRenderer({ createWorker: () => null, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    assert.equal((await broken.render('a')).status, 'error', 'a factory that gives nothing');
    renderer.dispose();
    unlucky.dispose();
  });

  test('MW-06: dispose terminates the worker and resolves what is in flight and waiting as superseded; later renders are superseded at once', async () => {
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const inFlight = renderer.render('a');
    const queued = renderer.render('b');
    renderer.dispose();
    assert.deepEqual(await inFlight, { status: 'superseded' });
    assert.deepEqual(await queued, { status: 'superseded' });
    assert.equal(made[0].terminated, true);
    assert.equal(clock.live, 0, 'no time limit left running');
    made[0].reply({ id: made[0].posted[0].id, ok: true, hast: HAST });
    made[0].fire('error', {});
    assert.deepEqual(await renderer.render('c'), { status: 'superseded' });
    assert.equal(made.length, 1, 'no worker made after dispose');
    clock.advance(10 * MARKDOWN_PARSE_TIMEOUT_MS);
    renderer.dispose();
    // Disposed before any render: nothing to stop.
    const unused = fakeWorkers();
    createMarkdownRenderer({ createWorker: unused.createWorker }).dispose();
    assert.equal(unused.made.length, 0);
  });
});

describe('Markdown worker: its answers (AC-B3-5)', () => {
  test('MW-10: one answer per message — ok with the tree and images, or the error\'s name and message and never its stack', () => {
    const ok = answerMarkdownRequest({ id: 3, text: '# T\n\n![p](p.png)', filePath: AT.filePath, root: AT.root });
    assert.equal(ok.id, 3);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok, { id: 3, ok: true, ...markdownToHast('# T\n\n![p](p.png)', AT) });
    assert.equal(ok.images[0].kind, 'load');

    const big = answerMarkdownRequest({ id: 4, text: 'a'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1), ...AT });
    assert.deepEqual(big, { id: 4, ok: false, error: { name: 'RangeError', message: markdownTooLargeText(MARKDOWN_PREVIEW_MAX_BYTES + 1) } });
    assert.ok(!JSON.stringify(big).includes('    at '), 'no stack');
    assert.deepEqual(answerMarkdownRequest({ id: 5, text: 42 }), { id: 5, ok: false, error: { name: 'TypeError', message: 'The Markdown text is not a string' } });
    assert.equal(answerMarkdownRequest(null).ok, false, 'a request that is nothing');
    // Paths that are not strings are no folder: links and images are inert and placeholders.
    const loose = answerMarkdownRequest({ id: 6, text: '[f](a.md) ![i](a.png)', filePath: 7, root: {} });
    assert.ok(!JSON.stringify(loose.hast).includes('data-link":"file'));
    assert.equal(loose.images[0].kind, 'placeholder');
    assert.equal(structuredClone(big).error.message, big.error.message);
  });
});

/**
 * A node:worker_threads worker running src/lib/markdownWorker.js, seen
 * through the client's worker interface. The worker's scope is given the
 * two functions a Web Worker has (`addEventListener('message')` and
 * `postMessage`), so the module answers as it does in the app.
 */
function nodeMarkdownWorker() {
  const code = [
    "const { parentPort } = require('node:worker_threads');",
    "globalThis.addEventListener = (type, listener) => { if (type === 'message') parentPort.on('message', (data) => listener({ data })); };",
    'globalThis.postMessage = (data) => parentPort.postMessage(data);',
    `import(${JSON.stringify(WORKER_URL)});`,
  ].join('\n');
  const thread = new Worker(code, { eval: true });
  const adapter = {
    thread,
    exited: new Promise((resolve) => thread.once('exit', resolve)),
    postMessage: (data) => thread.postMessage(data),
    terminate: () => {
      adapter.terminateCalls += 1;
      thread.terminate();
    },
    terminateCalls: 0,
    addEventListener(type, listener) {
      if (type === 'message') thread.on('message', (data) => listener({ data }));
      else if (type === 'error') thread.on('error', (err) => listener({ message: String(err?.message ?? err) }));
      else if (type === 'messageerror') thread.on('messageerror', (err) => listener({ message: String(err?.message ?? err) }));
    },
  };
  return adapter;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Markdown worker: a real worker thread (AC-B3-5)', () => {
  test('MW-20: \'[a](\' and \'[^a]\' repeated to 2 MB pass the time limit: too-complex, the thread exits, and the window\'s thread runs on meanwhile', async () => {
    const workers = [];
    // 1 s: a cold worker thread answers in about 0.1 s, so the renders that follow a stop are not cut short.
    const renderer = createMarkdownRenderer({ createWorker: () => workers[workers.push(nodeMarkdownWorker()) - 1], timeoutMs: 1000 });
    try {
      // Started and answering first, so that the limit below is the parse's alone.
      assert.equal((await renderer.render('# warm', AT)).status, 'ok', 'the worker answers');
      for (const hostile of ['[a]('.repeat(500_000), '[^a]'.repeat(500_000)]) {
        assert.ok(hostile.length <= MARKDOWN_PREVIEW_MAX_BYTES, 'within the 2 MB limit: only the parse is slow');
        const worker = workers[workers.length - 1];
        let ticks = 0;
        const ticker = setInterval(() => { ticks += 1; }, 20);
        const started = performance.now();
        const result = await renderer.render(hostile, AT);
        const took = performance.now() - started;
        clearInterval(ticker);
        assert.deepEqual(result, { status: 'too-complex' }, hostile.slice(0, 8));
        assert.ok(took >= 950 && took < 4000, `stopped after ${took.toFixed(0)} ms`);
        assert.ok(ticks >= 20, `the window's thread ticked ${ticks} times while the worker parsed`);
        assert.equal(worker.terminateCalls, 1, 'terminate() was called');
        const exit = await Promise.race([worker.exited, sleep(5000).then(() => 'still running')]);
        assert.notEqual(exit, 'still running', 'the thread really stopped: its exit event fired');
        // The next render starts a fresh worker, which answers.
        const count = workers.length;
        assert.equal((await renderer.render('# again', AT)).status, 'ok');
        assert.equal(workers.length, count + 1, 'a fresh worker');
      }
    } finally {
      renderer.dispose();
      await Promise.all(workers.map((w) => w.exited));
    }
  });

  test('MW-21: README.md through the real worker is ok, and its tree is the one markdownToHast gives, across the thread', async () => {
    const workers = [];
    const renderer = createMarkdownRenderer({ createWorker: () => workers[workers.push(nodeMarkdownWorker()) - 1] });
    try {
      const readme = source('README.md');
      const options = { filePath: join(ROOT, 'README.md'), root: ROOT };
      const result = await renderer.render(readme, options);
      assert.equal(result.status, 'ok', JSON.stringify(result).slice(0, 300));
      assert.deepEqual({ hast: result.hast, images: result.images }, markdownToHast(readme, options));
      assert.ok(elementsOf(result.hast).some((node) => /^h[1-6]$/.test(node.tagName)), 'headings drawn');
      // Too large is the worker's error, with its words.
      const big = await renderer.render('x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1), options);
      assert.deepEqual(big, { status: 'error', name: 'RangeError', message: markdownTooLargeText(MARKDOWN_PREVIEW_MAX_BYTES + 1) });
      assert.equal(workers.length, 1, 'one worker for all of it');
    } finally {
      renderer.dispose();
      await Promise.all(workers.map((w) => w.exited));
    }
  });
});

/** An `<a>` or `<img>` with properties no preview element may carry, as a plugin bug might leave them. */
const HOSTILE_PROPERTIES = {
  onClick: 'alert(1)', onclick: 'alert(1)', onError: 'alert(1)', onLoad: 'x', onMouseOver: 'x', style: 'position:fixed;inset:0',
  src: 'https://evil.example/x.png', srcSet: 'https://evil.example/x.png 1x', srcDoc: '<script>alert(1)</script>',
  action: 'https://evil.example', formAction: 'javascript:alert(1)', xLinkHref: 'javascript:alert(1)', ping: 'https://evil.example',
  background: 'https://evil.example', poster: 'https://evil.example', cite: 'https://evil.example', target: '_blank',
  dangerouslySetInnerHTML: { __html: '<b>x</b>' }, ref: 'x', key: 'x', tabIndex: 0, contentEditable: true, autoFocus: true,
  dataFoo: 'bar', ariaHidden: true, name: 'x', value: 'x', hidden: true, title: 'kept',
};

describe('Markdown worker: the pipeline — URL rule and allow-list (AC-B3-1, F-B3-2..5)', () => {
  test('MW-30: a hand-made hast: event handlers, style and URL attributes are dropped; elements outside the set are their text; raw is literal', () => {
    const hast = {
      type: 'root',
      position: { start: { line: 1, column: 1 } },
      children: [
        { type: 'element', tagName: 'a', properties: { ...HOSTILE_PROPERTIES, href: 'https://example.com', dataLink: 'external', dataTarget: 'https://example.com/' }, children: [{ type: 'text', value: 'e' }] },
        { type: 'element', tagName: 'a', properties: { href: 'javascript:alert(1)' }, children: [{ type: 'text', value: 'j' }] },
        { type: 'element', tagName: 'a', properties: { href: '#x', dataLink: 'external' }, children: [] },
        { type: 'element', tagName: 'a', properties: { href: '#md-ok', dataLink: 'anchor', dataTarget: 'md-ok' }, children: [] },
        { type: 'element', tagName: 'a', properties: { href: '#user-content-fn-1', id: 'user-content-fnref-1', dataFootnoteRef: true, ariaDescribedBy: ['footnote-label'] }, children: [] },
        { type: 'element', tagName: 'img', properties: { ...HOSTILE_PROPERTIES, alt: 'a', dataImage: 'load', dataImageIndex: 0 }, children: [{ type: 'text', value: 'inside an img' }] },
        { type: 'element', tagName: 'script', properties: { src: 'x.js' }, children: [{ type: 'text', value: 'alert(1)' }] },
        { type: 'element', tagName: 'iframe', properties: { srcDoc: 'x' }, children: [{ type: 'element', tagName: 'b', properties: {}, children: [{ type: 'text', value: 'framed' }] }] },
        { type: 'element', tagName: 'svg', properties: { onLoad: 'x' }, children: [] },
        { type: 'element', tagName: 'style', properties: {}, children: [{ type: 'text', value: 'body{display:none}' }] },
        { type: 'element', tagName: 'input', properties: { type: 'text', value: 'x', onFocus: 'x' }, children: [] },
        { type: 'element', tagName: 'input', properties: { type: 'checkbox', checked: true, disabled: false, onChange: 'x' }, children: [] },
        { type: 'element', tagName: 'p', properties: { className: ['fixed', 'inset-0', 'md-raw-html', 'language-js', 'language-a b'], id: 'root' }, children: [{ type: 'raw', value: '<img src=x onerror=alert(1)>' }] },
        { type: 'element', tagName: 'h2', properties: { id: 'md-title', className: 'not-an-array' }, data: { meta: 'x' }, children: [{ type: 'comment', value: 'c' }, { type: 'text', value: 'T' }] },
        { type: 'element', tagName: 'td', properties: { align: 'center', style: 'x', vAlign: 'top' }, children: [] },
        { type: 'element', tagName: 'th', properties: { align: 'javascript' }, children: [] },
        { type: 'element', tagName: 'ol', properties: { start: 3, reversed: true, type: 'a' }, children: [] },
        { type: 'element', tagName: 'ol', properties: { start: '3' }, children: [] },
        { type: 'element', tagName: 'span', properties: { className: [RAW_HTML_CLASS], dataRawHtml: 'inline', dataLink: 'external' }, children: [] },
        { type: 'element', tagName: 'div', properties: { dataRawHtml: 'evil' }, children: [] },
        { type: 'doctype' },
        { type: 'element', tagName: 'li', properties: { id: 'user-content-fn-1' }, children: [] },
        { type: 'element', tagName: 'h2', properties: { id: 'footnote-label', className: ['sr-only'] }, children: [] },
        { type: 'element', tagName: 'section', properties: { dataFootnotes: true, className: ['footnotes'] }, children: [] },
        { type: 'element', tagName: 'a', properties: { href: '#user-content-fnref-1', dataFootnoteBackref: '', ariaLabel: 'Back to reference 1', className: ['data-footnote-backref'] }, children: [] },
      ],
    };
    const safe = safeHast(hast);
    // Dropped: the svg (no text), the text input, the doctype.
    const [ext, js, mislabelled, anchor, footRef, img, script, iframe, style, checkbox, p, h2, td, th, ol, olString, span, div, li, label, section, backref] = safe.children;
    assert.deepEqual(ext, { type: 'element', tagName: 'a', properties: { title: 'kept', dataLink: 'external', dataTarget: 'https://example.com/' }, children: [{ type: 'text', value: 'e' }] });
    assert.deepEqual(js.properties, {}, 'javascript: href dropped');
    assert.deepEqual(mislabelled.properties, { dataLink: 'external' }, 'a "#" href on a link the plugin called external is dropped');
    assert.deepEqual(anchor.properties, { dataLink: 'anchor', dataTarget: 'md-ok', href: '#md-ok' });
    assert.deepEqual(footRef.properties, { id: 'user-content-fnref-1', dataFootnoteRef: true, ariaDescribedBy: ['footnote-label'], href: '#user-content-fn-1' });
    assert.deepEqual(img, { type: 'element', tagName: 'img', properties: { alt: 'a', title: 'kept', dataImage: 'load', dataImageIndex: 0 }, children: [] }, 'no src, no handler, no children');
    assert.deepEqual(script, { type: 'text', value: 'alert(1)' }, 'a script is its text');
    assert.deepEqual(iframe, { type: 'text', value: 'framed' });
    assert.deepEqual(style, { type: 'text', value: 'body{display:none}' });
    assert.deepEqual(checkbox, { type: 'element', tagName: 'input', properties: { type: 'checkbox', checked: true, disabled: true }, children: [] }, 'a text input is dropped; a checkbox is always disabled');
    assert.deepEqual(p.properties, { className: [RAW_HTML_CLASS, 'language-js'] }, 'only known classes; id "root" dropped');
    assert.deepEqual(p.children, [{ type: 'element', tagName: 'span', properties: { className: [RAW_HTML_CLASS], dataRawHtml: 'inline' }, children: [{ type: 'text', value: '<img src=x onerror=alert(1)>' }] }], 'raw is the plugin\'s literal span');
    assert.deepEqual(h2, { type: 'element', tagName: 'h2', properties: { id: 'md-title' }, children: [{ type: 'text', value: 'T' }] }, 'no data, no comment');
    assert.deepEqual(td.properties, { align: 'center' });
    assert.deepEqual(th.properties, {});
    assert.deepEqual(ol.properties, { start: 3 });
    assert.deepEqual(olString.properties, {});
    assert.deepEqual(span.properties, { className: [RAW_HTML_CLASS], dataRawHtml: 'inline' });
    assert.deepEqual(div.properties, {});
    assert.deepEqual(li.properties, { id: 'user-content-fn-1' });
    assert.deepEqual(label.properties, { className: ['sr-only'], id: 'footnote-label' });
    assert.deepEqual(section.properties, { className: ['footnotes'], dataFootnotes: true });
    assert.deepEqual(backref.properties, { className: ['data-footnote-backref'], dataFootnoteBackref: '', ariaLabel: 'Back to reference 1', href: '#user-content-fnref-1' });
    assert.equal(safe.children.length, 22, 'the svg (no text), the text input, the doctype are gone');
    assert.ok(!('position' in safe));
    assert.equal(hast.children[0].properties.onClick, 'alert(1)', 'the input is not changed');
  });

  test('MW-31: a plugin bug in the mdast (hName, hProperties, hChildren) still yields only the allow-list', () => {
    const mdast = {
      type: 'root',
      children: [
        { type: 'paragraph', data: { hName: 'script', hProperties: { src: 'x.js' } }, children: [{ type: 'text', value: 'boom' }] },
        { type: 'paragraph', data: { hProperties: { onClick: 'alert(1)', style: 'color:red', id: 'app', className: ['hidden'] } }, children: [{ type: 'text', value: 'p' }] },
        { type: 'link', url: 'javascript:alert(1)', data: { hProperties: { href: 'https://evil.example', dataLink: 'anchor' } }, children: [{ type: 'text', value: 'l' }] },
        { type: 'image', url: 'https://evil.example/x.png', alt: 'i', data: { hProperties: { onError: 'alert(1)', srcSet: 'x' } } },
        { type: 'text', value: 'raw', data: { hName: 'span', hChildren: [{ type: 'raw', value: '<b onclick=x>' }, { type: 'element', tagName: 'object', properties: { data: 'x.swf' }, children: [] }] } },
      ],
    };
    const hast = unified().use(remarkRehype).runSync(mdast);
    const safe = safeHast(hast);
    const text = JSON.stringify(safe);
    for (const bad of ['onClick', 'style', 'src', 'srcSet', 'onError', 'https://evil.example', '"app"', 'hidden', 'script', 'object']) assert.ok(!text.includes(bad), `${bad} in ${text}`);
    assert.ok(text.includes('"value":"boom"'), 'the script element is its text');
    for (const node of elementsOf(safe)) assert.ok(SAFE_ELEMENTS.includes(node.tagName), node.tagName);
    const links = elementsOf(safe).filter((node) => node.tagName === 'a');
    assert.deepEqual(links.map((node) => node.properties), [{ dataLink: 'anchor' }], 'an https href is no anchor, whatever dataLink says');
    assert.ok(elementsOf(safe).some((node) => node.tagName === 'span' && node.children.some((c) => c.tagName === 'span' && c.properties.className?.[0] === RAW_HTML_CLASS)), 'raw in hChildren is literal');
  });

  test('MW-32: the tree is plain data — only type, tagName, properties, children and value; structuredClone gives it back unchanged', () => {
    const text = `${source('README.md')}\n\n# Ünïcödé\n\n- [x] t\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\nx[^n]\n\n[^n]: note\n\n<div onclick=x>raw</div>\n\n1986. start`;
    const { hast, images } = markdownToHast(text, AT);
    for (const node of nodesOf(hast)) {
      for (const key of Object.keys(node)) assert.ok(['type', 'tagName', 'properties', 'children', 'value'].includes(key), `${node.type} has ${key}`);
      assert.ok(['root', 'element', 'text'].includes(node.type), node.type);
      if (node.type === 'element') {
        for (const value of Object.values(node.properties)) {
          assert.ok(['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every((v) => typeof v === 'string')), `${node.tagName}: ${JSON.stringify(value)}`);
        }
      }
    }
    assert.deepEqual(structuredClone({ hast, images }), { hast, images });
    assert.deepEqual(JSON.parse(JSON.stringify(hast)), hast, 'nothing but JSON either');
    assert.ok(elementsOf(hast).some((node) => node.tagName === 'ol' && node.properties.start === 1986));
    assert.ok(elementsOf(hast).some((node) => node.tagName === 'td' && node.properties.align === 'right'));
  });

  test('MW-33: raw HTML stays literal text in the plugin\'s span or div, and no element outside the set is made', () => {
    const text = [
      '<script>alert(1)</script>', '', '<img src=x onerror=alert(1)>', '', '<iframe src="https://evil.example"></iframe>', '',
      'Inline <a href="javascript:alert(1)">click</a> and <b onclick="x()">bold</b> <svg onload=alert(3)>', '',
      '| <i>c</i> | <style>x</style> |', '|---|---|', '| a | b |', '', '# Title <img src=y onerror=alert(4)>',
    ].join('\n');
    const { hast } = markdownToHast(text, AT);
    const elements = elementsOf(hast);
    for (const node of elements) assert.ok(SAFE_ELEMENTS.includes(node.tagName), `<${node.tagName}>`);
    for (const tag of ['script', 'img', 'iframe', 'svg', 'b', 'i', 'style']) assert.ok(!elements.some((node) => node.tagName === tag), `no <${tag}>`);
    const literal = elements.filter((node) => node.properties.className?.includes(RAW_HTML_CLASS));
    assert.ok(literal.length >= 10, `${literal.length} literal elements`);
    for (const node of literal) {
      assert.ok(node.tagName === 'span' || node.tagName === 'div', node.tagName);
      assert.equal(node.children.length, 1);
      assert.equal(node.children[0].type, 'text');
    }
    assert.ok(literal.some((node) => node.tagName === 'div' && node.children[0].value === '<script>alert(1)</script>'));
    for (const node of elements) for (const key of Object.keys(node.properties)) assert.ok(!/^on|^style$|^src/i.test(key), `${node.tagName} ${key}`);
    // Never allowDangerousHtml: true, anywhere in src.
    const pipeline = source('src/lib/markdownPipeline.js');
    assert.match(pipeline, /\.use\(remarkRehype, \{ allowDangerousHtml: false \}\)/);
    for (const file of srcFiles()) assert.ok(!/allowDangerousHtml\s*:\s*true/.test(stripComments(read(file))), `${file} passes allowDangerousHtml: true`);
  });

  test('MW-34: no image carries a src; external, file and inert links carry no href; anchors and footnotes keep their #…', () => {
    const hostile = ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'file:///etc/passwd', 'mailto:a@b.c', '//evil.example', '../../outside.md'];
    const text = [
      '# Top', '',
      `${hostile.map((url, n) => `[h${n}](<${url}>)`).join(' ')} [e](https://example.com) [f](guide.md) [t](#top) [r][ref] x[^1] <https://auto.example>`, '',
      '![local](img/a.png) ![remote](https://example.com/x.png) ![ref][img] ![data](data:image/png;base64,AAAA)', '',
      '[ref]: https://example.com/ref', '[img]: ../../../etc/x.png', '[^1]: note',
    ].join('\n');
    const { hast, images } = markdownToHast(text, AT);
    const elements = elementsOf(hast);
    for (const img of elements.filter((node) => node.tagName === 'img')) {
      assert.ok(!('src' in img.properties), `src on ${JSON.stringify(img.properties)}`);
      assert.ok(['load', 'placeholder'].includes(img.properties.dataImage));
    }
    assert.equal(images.length, 4);
    assert.deepEqual(images.map((image) => image.kind), ['load', 'placeholder', 'placeholder', 'placeholder']);
    const links = elements.filter((node) => node.tagName === 'a');
    for (const link of links) {
      const { href, dataLink } = link.properties;
      if (dataLink === 'external' || dataLink === 'file' || dataLink === 'inert') assert.equal(href, undefined, `${dataLink} link with href ${href}`);
      if (href !== undefined) assert.ok(href.startsWith('#'), href);
    }
    const kinds = links.map((link) => link.properties.dataLink ?? 'footnote');
    assert.equal(kinds.filter((kind) => kind === 'inert').length, hostile.length, 'every hostile link inert');
    assert.ok(links.some((link) => link.properties.dataLink === 'anchor' && link.properties.href === '#md-top'));
    assert.ok(links.some((link) => link.properties.dataLink === 'file' && link.properties.dataTarget === '/w/docs/guide.md'));
    assert.ok(links.some((link) => link.properties.dataLink === 'external' && link.properties.dataTarget === 'https://auto.example/'), 'an autolink');
    assert.ok(links.some((link) => link.properties.href === '#user-content-fn-1'), 'a footnote reference');
    assert.ok(links.some((link) => link.properties.href === '#user-content-fnref-1'), 'a footnote back link');
  });

  test('MW-35: past 2 MB (UTF-8) the pipeline throws the too-large words before parsing; at 2 MB it parses', () => {
    const tooLarge = (text) => {
      const started = performance.now();
      assert.throws(() => markdownToHast(text, AT), (err) => err instanceof RangeError && /^Too large to preview \(2\.1 MB; the limit is 2 MB\)$/.test(err.message));
      assert.ok(performance.now() - started < 500, 'refused before any parse');
    };
    tooLarge('a'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1));
    // Bytes, not characters: three bytes each, four for a surrogate pair, three for a lone surrogate (as an encoder writes it).
    tooLarge('€'.repeat(Math.ceil((MARKDOWN_PREVIEW_MAX_BYTES + 1) / 3)));
    tooLarge('😀'.repeat(MARKDOWN_PREVIEW_MAX_BYTES / 4 + 1));
    tooLarge('\ud800'.repeat(Math.ceil((MARKDOWN_PREVIEW_MAX_BYTES + 1) / 3)));
    assert.equal(markdownToHast('a'.repeat(MARKDOWN_PREVIEW_MAX_BYTES), AT).hast.type, 'root', 'exactly 2 MB is parsed');
    assert.equal(markdownToHast('😀'.repeat(MARKDOWN_PREVIEW_MAX_BYTES / 4), AT).hast.type, 'root', 'exactly 2 MB of four-byte characters too');
    assert.throws(() => markdownToHast(null, AT), TypeError);
  });

  test('MW-36: the source is bounded before parsing: 100,000 quote markers parse quickly to a bounded tree', () => {
    const started = performance.now();
    const { hast } = markdownToHast(`${'>'.repeat(100_000)} deep`, AT);
    assert.ok(performance.now() - started < 2000, `${(performance.now() - started).toFixed(0)} ms`);
    assert.ok(depthOf(hast) <= 2 * MARKDOWN_MAX_DEPTH + 8, `depth ${depthOf(hast)}`);
    assert.ok(nodesOf(hast).some((node) => node.type === 'text' && node.value.includes('deep')));
  });

  test('MW-37: the allow-list is CommonMark and GFM\'s elements and the plugin\'s two, and the known class names', () => {
    assert.deepEqual([...SAFE_ELEMENTS].sort(), ['a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'input', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
    assert.deepEqual([...CLASS_NAMES].sort(), ['contains-task-list', 'data-footnote-backref', 'footnotes', RAW_HTML_CLASS, 'sr-only', 'task-list-item'].sort());
    // Every element F-B3-2 lists comes through.
    const text = '# h1\n\n## h2\n\n###### h6\n\np *em* **strong** ~~del~~ `code`  \nbreak\n\n```js\nfenced\n```\n\n> quote\n\n1. one\n\n- [ ] task\n\n| a |\n|---|\n| b |\n\n---\n\n[l](#h1) ![i](a.png) x[^1]\n\n[^1]: n';
    const tags = new Set(elementsOf(markdownToHast(text, AT).hast).map((node) => node.tagName));
    for (const tag of ['h1', 'h2', 'h6', 'p', 'em', 'strong', 'del', 'code', 'br', 'pre', 'blockquote', 'ol', 'ul', 'li', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'img', 'sup', 'section']) {
      assert.ok(tags.has(tag), `<${tag}> missing`);
    }
  });
});

/* ------------------------------------------------- what imports what */

/** Every .js, .jsx and .mjs file under src/, relative to src/ with forward slashes. */
function srcFiles() {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(jsx?|mjs)$/.test(name)) out.push(relative(SRC, path).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  return out;
}

const read = (rel) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** `text` without the comments that start a line (a `/*` or `//` inside a string is no comment). */
const stripComments = (text) => text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');

/** Every module `text` names: static imports and re-exports, `import()`, and `new URL(…, import.meta.url)`. */
function importsOf(text) {
  const code = stripComments(text);
  return [
    ...code.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm),
    ...code.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g),
    ...code.matchAll(/\bnew\s+URL\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g),
  ].map((m) => m[1] ?? m[2]);
}

/** The src/ file a relative specifier in `from` names, without its `?query`; null for a package. */
function targetOf(from, spec) {
  if (!spec.startsWith('.')) return null;
  const path = relative(SRC, join(SRC, dirname(from), spec.replace(/\?.*$/, ''))).replace(/\\/g, '/');
  return /\.(jsx?|mjs)$/.test(path) ? path : `${path}.js`;
}

/** The packages that parse Markdown: whoever imports one parses on its own thread. */
const PARSER = /^(?:unified|remark(?:-[\w-]+)?|micromark(?:-[\w-]+)?|mdast-util-from-markdown|react-markdown)(?:\/|$)/;

describe('Markdown worker: the window\'s thread never parses (AC-B3-5, OQ-B3g)', () => {
  test('MW-40: only markdownPipeline.js imports a parser, only markdownWorker.js the pipeline, only the factory the worker (with ?worker); no html-url-attributes', () => {
    const files = srcFiles();
    assert.ok(files.length > 50 && files.includes('main.jsx'), `setup: ${files.length} files`);
    const parsers = [];
    const pipelineUsers = [];
    const workerUsers = [];
    for (const file of files) {
      for (const spec of importsOf(read(file))) {
        if (PARSER.test(spec)) parsers.push(`${file} -> ${spec}`);
        if (/^html-url-attributes(?:\/|$)/.test(spec)) assert.fail(`${file} imports html-url-attributes`);
        const target = targetOf(file, spec);
        if (target === 'lib/markdownPipeline.js') pipelineUsers.push(file);
        if (target === 'lib/markdownWorker.js') workerUsers.push(`${file} -> ${spec}`);
      }
    }
    assert.deepEqual([...new Set(parsers.map((entry) => entry.split(' -> ')[0]))], ['lib/markdownPipeline.js'], `parser imports: ${parsers.join(', ')}`);
    assert.deepEqual(parsers.map((entry) => entry.split(' -> ')[1]).sort(), ['remark-gfm', 'remark-parse', 'remark-rehype', 'unified']);
    assert.deepEqual(pipelineUsers, ['lib/markdownWorker.js']);
    assert.deepEqual(workerUsers, ['lib/markdownWorkerFactory.js -> ./markdownWorker.js?worker']);
    assert.deepEqual(importsOf(read('lib/markdownRenderClient.js')), [], 'the client imports nothing');
    assert.match(read('lib/markdownWorkerFactory.js'), /new MarkdownWorker\(\{ name: 'markdown-preview' \}\)/);
    // The check reads dynamic imports and worker URLs too.
    assert.deepEqual(importsOf("const a = () => import('unified');\nnew Worker(new URL('./markdownPipeline.js', import.meta.url));\n// import('remark-parse')"), ['unified', './markdownPipeline.js']);
  });
});

/* ------------------------------------------- the worker as Vite builds it */

/**
 * The Markdown worker file as `vite build` emits it with the project's own
 * vite.config.js — built in memory (nothing written) from a stand-in for the
 * lazy MarkdownPreview.jsx that imports the factory — and the chunk that
 * makes it.
 */
async function viteBuiltWorker() {
  const { build } = await import('vite');
  // A build sets NODE_ENV when it is unset; the suites after this one keep theirs.
  const nodeEnv = process.env.NODE_ENV;
  const output = await build({
    configFile: VITE_CONFIG,
    root: ROOT,
    logLevel: 'silent',
    plugins: [{
      name: 'markdown-worker-probe',
      resolveId: (id) => (id === 'virtual:markdown-worker-probe' ? '\0markdown-worker-probe' : null),
      load: (id) => (id === '\0markdown-worker-probe' ? `import(${JSON.stringify(FACTORY)}).then((m) => { globalThis.probe = m.createMarkdownWorker; });` : null),
    }],
    build: { write: false, minify: false, emptyOutDir: false, reportCompressedSize: false, rollupOptions: { input: 'virtual:markdown-worker-probe' } },
  }).finally(() => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });
  const files = (Array.isArray(output) ? output : [output]).flatMap((bundle) => bundle.output);
  const worker = files.find((file) => /(?:^|\/)markdownWorker-[\w-]+\.js$/.test(file.fileName));
  const maker = files.find((file) => file.type === 'chunk' && /new Worker\(/.test(file.code));
  return { worker: worker && String(worker.source ?? worker.code), workerName: worker?.fileName, maker: maker?.code ?? '' };
}

/** Runs `code` in a context with a worker's globals only — no window, no document — and posts it `request`. */
function runInWorkerScope(code, request) {
  const listeners = [];
  const replies = [];
  const scope = {
    console, TextEncoder, TextDecoder, atob, btoa, structuredClone, setTimeout, clearTimeout, queueMicrotask, URL,
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
    postMessage: (data) => replies.push(data),
  };
  scope.self = scope;
  scope.globalThis = scope;
  try {
    vm.runInContext(code, vm.createContext(scope), { filename: 'markdownWorker.js' });
  } catch (err) {
    return { loadError: `${err?.name}: ${err?.message}` };
  }
  for (const listener of listeners) listener({ data: request });
  return { listeners: listeners.length, replies };
}

/* ----------------------------------------------------- the drawing cap */

describe('Markdown worker: the drawing cap (OQ-B3g; reviewer A, R2)', () => {
  test('MW-60: past MARKDOWN_MAX_ELEMENTS the pipeline stops building; the worker answers the cap\u{2019}s error and the client resolves too-complex, the worker kept', async () => {
    assert.equal(MARKDOWN_MAX_ELEMENTS, 100_000);
    assert.equal(MARKDOWN_TOO_COMPLEX_ERROR, 'MarkdownTooComplexError');
    assert.equal(TOO_COMPLEX_ERROR, MARKDOWN_TOO_COMPLEX_ERROR, 'the client\u{2019}s copy of the name is the one the pipeline throws');

    // safeHast counts what it makes, raw HTML's literal spans included: at the cap it builds, one past it throws.
    const hast = (n) => ({ type: 'root', children: Array.from({ length: n }, (_, i) => (i % 2 ? { type: 'raw', value: '<b>' } : { type: 'element', tagName: 'em', properties: {}, children: [{ type: 'text', value: 'a' }] })) });
    assert.equal(safeHast(hast(10), { maxElements: 10 }).children.length, 10);
    assert.throws(() => safeHast(hast(11), { maxElements: 10 }), (err) => err instanceof RangeError && err.name === MARKDOWN_TOO_COMPLEX_ERROR);
    // Elements outside the set are their text and cost nothing.
    const flattened = { type: 'root', children: Array.from({ length: 50 }, () => ({ type: 'element', tagName: 'script', properties: {}, children: [{ type: 'text', value: 'x' }] })) };
    assert.equal(safeHast(flattened, { maxElements: 0 }).children.length, 50);

    // '*a*' paragraphs, two elements each: 400 KB of them was 320,000 nodes (the reviewer's measure).
    const past = '*a*\n\n'.repeat(MARKDOWN_MAX_ELEMENTS / 2 + 1);
    assert.throws(() => markdownToHast(past, AT), (err) => err.name === MARKDOWN_TOO_COMPLEX_ERROR && /100000 elements/.test(err.message));
    const answer = answerMarkdownRequest({ id: 7, text: past, ...AT });
    assert.deepEqual({ id: answer.id, ok: answer.ok, name: answer.error?.name }, { id: 7, ok: false, name: MARKDOWN_TOO_COMPLEX_ERROR });
    assert.equal(answer.hast, undefined, 'a tree went out with the refusal');

    // The client: that answer is too-complex, not an error; the worker is kept and serves the next render.
    const clock = fakeTimers();
    const { made, createWorker } = fakeWorkers();
    const renderer = createMarkdownRenderer({ createWorker, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const result = renderer.render(past, AT);
    made[0].reply({ ...answer, id: made[0].posted[0].id });
    assert.deepEqual(await result, { status: 'too-complex' });
    assert.equal(made[0].terminated, false, 'the worker was stopped for an answer it gave');
    assert.equal(clock.live, 0, 'the time limit is cleared');
    const next = renderer.render('# ok', AT);
    assert.equal(made.length, 1, 'the next render made a new worker');
    made[0].reply({ id: made[0].posted[1].id, ok: true, hast: HAST });
    assert.deepEqual(await next, { status: 'ok', hast: HAST, images: [] });
    // Another error, even a RangeError, is still an error.
    const other = renderer.render('x', AT);
    made[0].reply({ id: made[0].posted[2].id, ok: false, error: { name: 'RangeError', message: 'Maximum call stack size exceeded' } });
    assert.deepEqual(await other, { status: 'error', name: 'RangeError', message: 'Maximum call stack size exceeded' });
    renderer.dispose();
  });

  test('MW-61: a real README, and a document of exactly MARKDOWN_MAX_ELEMENTS elements, are not touched by the cap', () => {
    const readme = markdownToHast(source('README.md'), { filePath: join(ROOT, 'README.md'), root: ROOT });
    const elements = elementsOf(readme.hast).length;
    assert.ok(elements > 500 && elements < MARKDOWN_MAX_ELEMENTS / 10, `setup: the README draws ${elements} elements`);
    assert.equal(answerMarkdownRequest({ id: 1, text: source('README.md'), filePath: join(ROOT, 'README.md'), root: ROOT }).ok, true);
    const atCap = markdownToHast('*a*\n\n'.repeat(MARKDOWN_MAX_ELEMENTS / 2), AT);
    assert.equal(elementsOf(atCap.hast).length, MARKDOWN_MAX_ELEMENTS, 'exactly the cap is built');
    assert.equal(hastPastElements(atCap.hast), false, 'and the window\u{2019}s own check passes it');
  });
});

describe('Markdown worker: as Vite builds it (AC-B3-5, AC-G-3)', () => {
  test('MW-50: the built worker is a file of its own, a classic worker from the app\'s origin, holding the parser; it loads in a worker\'s scope and answers', async () => {
    const { worker, workerName, maker } = await viteBuiltWorker();
    assert.ok(worker, 'a markdownWorker-*.js file is emitted');
    assert.match(workerName, /^assets\/markdownWorker-[\w-]+\.js$/);
    assert.ok(/thematicBreakSequence/.test(worker) && /footnote-label/.test(worker), 'micromark and remark-rehype are inside it');
    assert.ok(!/\bimport\s*\(|^\s*import\s/m.test(worker), 'one classic script: no import of its own');
    const made = maker.match(/new Worker\(([^)]*)\)/g) ?? [];
    assert.ok(made.some((call) => call.includes(workerName)), `the factory makes it from its own file: ${made}`);
    assert.ok(made.every((call) => !/type:\s*["']module/.test(call)), 'a classic worker');

    const run = runInWorkerScope(worker, { id: 1, text: '# A &amp; B &copy;\n\n[x](https://example.com) <b>', filePath: AT.filePath, root: AT.root });
    assert.equal(run.loadError, undefined,
      `the built worker cannot load in a worker's scope (${run.loadError}). A worker has no \`document\`: Vite resolves `
      + 'decode-named-character-reference, which micromark imports, to its "browser" build (index.dom.js), and that '
      + 'calls document.createElement at load. Its "worker" export condition names the DOM-free index.js; '
      + 'vite.config.js must resolve it so (see the P6b report).');
    assert.equal(run.listeners, 1);
    assert.equal(run.replies.length, 1);
    const [reply] = run.replies;
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(reply.hast.children[0].children[0].value, 'A & B ©', 'named character references decoded');
    assert.equal(reply.hast.children[2].children[0].properties.dataLink, 'external');
  });
});
