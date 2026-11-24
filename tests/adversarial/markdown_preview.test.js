/**
 * Markdown preview tabs (Orca bundle 5, B3), the safe model:
 * src/lib/markdownPreview.js, alone and with the remark plugin run through
 * the parser react-markdown uses (unified + remark-parse + remark-gfm; those
 * three are imported here only, never in src/).
 *
 *   AC-B3-3  links: http(s) external with addressToOpen's address, `#x` an
 *            anchor, a relative path inside the folder a file (backslashes,
 *            one percent-decoding), and the hostile list inert (MP-01..06);
 *            a host longer than DNS allows inert, so the confirmation always
 *            shows the whole origin (MP-07, reviewer A R3)
 *   AC-B3-4  images: inside the folder loaded, everything else a placeholder
 *            with its cleaned address; the count and byte caps, at most four
 *            reads at once (MP-10..14); one preview's reads shared across its
 *            rounds — never two of a path, never more than four (MP-15,
 *            reviewer A R4)
 *   AC-B3-5  the 2 MB limit and its words; nesting past the cap flattened
 *            without a stack overflow; 2 MB of deep nesting or backticks
 *            parsed and modelled in under 2 s (MP-20..27); the drawing cap's
 *            count (MP-28, reviewer A R2)
 *   AC-B3-6  ESC, BEL, U+202E and U+200B removed from headings, link text,
 *            titles and alt (MP-30..32)
 *   F-B3-2   unique ASCII-safe heading slugs (MP-40..42)
 *   F-B3-3   raw HTML as literal text, never an element (MP-50..51)
 *   urlTransform: no URL in the markup but `#…` (MP-60..61)
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { addressToOpen, hyperlinkTitle } from '../../src/lib/openExternal.js';
import { IMAGE_MAX_BYTES } from '../../src/lib/imagePreview.js';
import { MARKDOWN_PREVIEW_MAX_BYTES as STORE_MAX_BYTES } from '../../src/stores/editorStore.js';
import {
  HEADING_ID_PREFIX,
  HEADING_SLUG_FALLBACK,
  MARKDOWN_IMAGE_READS_AT_ONCE,
  MARKDOWN_MAX_CHILDREN,
  MARKDOWN_MAX_DEPTH,
  MARKDOWN_MAX_ELEMENTS,
  MARKDOWN_MAX_LINK_HOST,
  MARKDOWN_MAX_FOOTNOTE_REFERENCES,
  MARKDOWN_MAX_IMAGE_BYTES,
  MARKDOWN_MAX_IMAGES,
  MARKDOWN_MAX_PREFIX_COLUMNS,
  MARKDOWN_MAX_PREFIX_MARKERS,
  MARKDOWN_PREVIEW_MAX_BYTES,
  RAW_HTML_CLASS,
  boundMarkdownSource,
  classifyImageSource,
  classifyLink,
  cleanInlineText,
  createHeadingIds,
  createImageReads,
  hastPastElements,
  isMarkdownTooLarge,
  mapImageReads,
  markdownTooLargeText,
  markdownUrlTransform,
  modelMarkdownTree,
  planImageLoads,
  remarkMarkdownPreview,
  slugBase,
} from '../../src/lib/markdownPreview.js';
import { sizeLabel } from '../../src/lib/sizeLabel.js';

const MB = 1024 * 1024;

/** A few turns of the event loop: whatever can settle has settled. */
const letItSettle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A source file of the repository, line endings as LF whatever the checkout made them. */
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The Markdown file and folder most cases sit in. */
const AT = { filePath: '/w/docs/README.md', root: '/w' };
const WIN = { filePath: 'C:\\proj\\docs\\README.md', root: 'C:\\proj' };

/** What the preview must never show: C0/C1 controls, bidi marks and overrides, zero-width characters. */
const HOSTILE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/** Every node of `tree`, parents before children, with a stack (the trees here can be deep). */
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

/** `text` parsed as the preview parses it, the plugin run: `{ tree, images }` (mdast). */
function model(text, options = AT) {
  let images = null;
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMarkdownPreview, { ...options, onImages: (list) => { images = list; } });
  const tree = processor.runSync(processor.parse(text));
  return { tree, images };
}

/** `text` as far as hast: the tree react-markdown turns into elements. */
function toHast(text, options = AT) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMarkdownPreview, options).use(remarkRehype, { allowDangerousHtml: true });
  return processor.runSync(processor.parse(text));
}

/** `text` rendered by react-markdown as the preview renders it, without its components. */
function render(text, options = AT) {
  return renderToStaticMarkup(createElement(Markdown, {
    remarkPlugins: [remarkGfm, [remarkMarkdownPreview, options]],
    urlTransform: markdownUrlTransform,
  }, text));
}

/** The link nodes of a model, in order. */
const linksOf = (tree) => nodesOf(tree).filter((node) => node.type === 'link');

/** The hostile addresses AC-B3-3 names, verbatim. */
const AC_HOSTILE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  '\x01javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'mailto:someone@example.com',
  '//evil.example',
  '../../outside.md',
];

describe('Markdown preview: where a link goes (AC-B3-3)', () => {
  test('MP-01: http and https are external, with the address openExternal is handed and the label the confirmation shows', () => {
    for (const url of ['https://example.com/a?b=1#c', 'http://example.com', 'HTTPS://Example.COM/x', '  https://example.com/sp ace', 'https://example.com@evil.example/a', 'https://bücher.example/']) {
      const link = classifyLink(url, AT);
      assert.equal(link.kind, 'external', url);
      assert.equal(link.address, addressToOpen(url.trim()), url);
      assert.equal(link.label, hyperlinkTitle(url.trim()), url);
      // The address shown and opened is the address it is: the user name is gone, the host is evil.example.
      assert.deepEqual(classifyLink(link.address, AT), link, `${url}: classifying the address again gives the same`);
    }
    assert.equal(classifyLink('https://example.com@evil.example/a', AT).address, 'https://evil.example/a');
    assert.equal(classifyLink('HTTPS://Example.COM/x', AT).address, 'https://example.com/x');
    assert.equal(classifyLink('https://bücher.example/', AT).address, 'https://xn--bcher-kva.example/');
    // A URL parser drops tabs and line breaks anywhere and C0 controls at the ends: so is it read here.
    assert.equal(classifyLink('ht\ttps://example.com/x', AT).address, 'https://example.com/x');
    assert.equal(classifyLink('\x01https://example.com/y\n', AT).address, 'https://example.com/y');
    assert.ok(classifyLink(`https://example.com/${'a'.repeat(2000)}`, AT).label.length <= 300, 'the label is cut');
  });

  test('MP-02: the hostile list of AC-B3-3 is inert, with nothing to open, in a folder and without one', () => {
    for (const url of AC_HOSTILE) {
      assert.deepEqual(classifyLink(url, AT), { kind: 'inert' }, JSON.stringify(url));
      assert.deepEqual(classifyLink(url, WIN), { kind: 'inert' }, `${JSON.stringify(url)} (Windows)`);
      assert.deepEqual(classifyLink(url, { filePath: null, root: null }), { kind: 'inert' }, `${JSON.stringify(url)} (no folder)`);
    }
  });

  test('MP-03: more of the same — other spellings, schemes, hosts, absolute paths and ways out of the folder are inert', () => {
    const more = [
      'java\nscript:alert(1)', 'java\r\nscript:alert(1)', ' \t javascript:alert(1)', '\x00javascript:alert(1)', 'javascript\x00:alert(1)',
      '\u200bjavascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:,x', 'DATA:text/html,x', 'VBScript:x', 'FILE:///C:/x',
      'ftp://example.com/x', 'tel:123', 'blob:https://example.com/x', 'about:blank', 'chrome://settings', 'tauri://localhost/x', 'ws://example.com',
      '\\\\evil.example\\share\\x.md', '/\\evil.example', '\\/evil.example', '///evil.example', '/etc/passwd', '/w/docs/guide.md',
      'C:\\Windows\\win.ini', 'c:/x.md', 'a:b', '..\\..\\outside.md', '../../../../../../etc/passwd', '..%2F..%2Foutside.md', '%2e%2e/%2e%2e/outside.md',
      '%2F%2Fevil.example', '%5C%5Cevil.example', '../../w2/x.md', '..', '../', './', '.', 'sub/', 'sub/..', 'sub\\', '?q=1', '', '   ', 'bad%zzescape.md', 'a\x07b.md',
      `https://example.com/${'a'.repeat(20000)}`,
    ];
    for (const url of more) assert.deepEqual(classifyLink(url, AT), { kind: 'inert' }, JSON.stringify(url.slice(0, 60)));
    for (const url of [null, undefined, 42, {}, ['https://example.com']]) assert.deepEqual(classifyLink(url, AT), { kind: 'inert' });
    assert.deepEqual(classifyLink('..\\..\\outside.md', WIN), { kind: 'inert' });
    assert.deepEqual(classifyLink('..\\..\\..\\Windows\\win.ini', WIN), { kind: 'inert' });
    assert.deepEqual(classifyLink('guide.md', { filePath: '/w/docs/README.md', root: null }), { kind: 'inert' }, 'no folder open');
    assert.deepEqual(classifyLink('guide.md', { filePath: null, root: '/w' }), { kind: 'inert' }, 'no file');
    assert.deepEqual(classifyLink('../../x.md', { filePath: '/other/a/README.md', root: '/w' }), { kind: 'inert' }, 'a file outside the folder links out of it');
  });

  test('MP-04: a relative path inside the folder is a file link — resolved against the Markdown file, decoded once, backslashes read as separators', () => {
    const file = (url, at = AT) => classifyLink(url, at);
    assert.deepEqual(file('guide.md'), { kind: 'file', path: '/w/docs/guide.md' });
    assert.deepEqual(file('./sub/a.txt'), { kind: 'file', path: '/w/docs/sub/a.txt' });
    assert.deepEqual(file('../README.md'), { kind: 'file', path: '/w/README.md' }, 'a .md opens its source, as any file');
    assert.deepEqual(file('../src/../src/main.rs'), { kind: 'file', path: '/w/src/main.rs' });
    assert.deepEqual(file('a%20b.md'), { kind: 'file', path: '/w/docs/a b.md' });
    assert.deepEqual(file('%252e%252e/x.md'), { kind: 'file', path: '/w/docs/%2e%2e/x.md' }, 'decoded once, not twice');
    assert.deepEqual(file('%E1%84%89%E1%85%A5%E1%86%AF.md'), { kind: 'file', path: '/w/docs/\u1109\u1165\u11af.md' });
    assert.deepEqual(file('guide.md#install'), { kind: 'file', path: '/w/docs/guide.md' }, 'the fragment is not part of the file');
    assert.deepEqual(file('guide.md?raw=1'), { kind: 'file', path: '/w/docs/guide.md' });
    assert.deepEqual(file('sub\\a.md'), { kind: 'file', path: '/w/docs/sub/a.md' });
    assert.deepEqual(file('sub\\a.md', WIN), { kind: 'file', path: 'C:\\proj\\docs\\sub\\a.md' });
    assert.deepEqual(file('..\\README.md', WIN), { kind: 'file', path: 'C:\\proj\\README.md' });
    assert.deepEqual(file('../src/x.rs', WIN), { kind: 'file', path: 'C:\\proj\\src\\x.rs' });
    assert.deepEqual(file('x.md', { filePath: '/w/README.md', root: '/w/' }), { kind: 'file', path: '/w/x.md' }, 'a root written with a trailing separator');
  });

  test('MP-05: `#x` is an anchor naming the heading id its slug gives; a fragment that names none has no target', () => {
    assert.deepEqual(classifyLink('#install', AT), { kind: 'anchor', id: 'md-install', href: '#md-install' });
    assert.deepEqual(classifyLink('#Install', AT), { kind: 'anchor', id: 'md-install', href: '#md-install' });
    assert.deepEqual(classifyLink('#whats-new', AT), classifyLink("#What's new?", AT));
    assert.equal(classifyLink('#foo-1', AT).id, 'md-foo-1');
    assert.equal(classifyLink('#설치-가이드', AT).id, `md-${slugBase('설치 가이드')}`);
    assert.equal(classifyLink('#%EC%84%A4%EC%B9%98', AT).id, `md-${slugBase('설치')}`, 'percent-encoded, decoded once');
    for (const url of ['#', '#%E0%A4', '#\u{1F680}', '#---']) assert.deepEqual(classifyLink(url, AT), { kind: 'anchor', id: null, href: null }, url);
    assert.equal(classifyLink('#x', { ...AT, idPrefix: 'p-' }).id, 'p-x');
    assert.equal(classifyLink('#x', { ...AT, idPrefix: 'BAD"' }).id, 'md-x', 'an unsafe prefix is not used');
  });

  test('MP-06: links in a document are classified on their nodes; only an anchor keeps a url; references go through their definitions', () => {
    const text = [
      '[ext](https://example.com@evil.example/a) [file](../src/a.md) [anchor](#title) [js](JaVaScRiPt:alert(1))',
      '[tab](java&#9;script:alert(1)) [ctl](&#1;javascript:alert(1)) [ent](jav&#x61;script:alert(1)) <javascript:alert(1)> <https://example.com/auto> www.example.com',
      '[ref][r] [missing][nope] [out][o] ![img ref][i]',
      '',
      '[r]: //evil.example',
      '[o]: ../../outside.md',
      '[i]: http://127.0.0.1:9/x.png',
    ].join('\n');
    const { tree, images } = model(text);
    const links = linksOf(tree).map((node) => ({ kind: node.data.hProperties.dataLink, target: node.data.hProperties.dataTarget, url: node.url }));
    assert.deepEqual(links, [
      { kind: 'external', target: 'https://evil.example/a', url: '' },
      { kind: 'file', target: '/w/src/a.md', url: '' },
      { kind: 'anchor', target: 'md-title', url: '#md-title' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'external', target: 'https://example.com/auto', url: '' },
      { kind: 'external', target: 'http://www.example.com/', url: '' },
      { kind: 'inert', target: undefined, url: '' },
      { kind: 'inert', target: undefined, url: '' },
    ]);
    assert.ok(!nodesOf(tree).some((node) => node.type === 'linkReference' && node.identifier !== 'nope'), 'a reference with a definition became a link');
    assert.deepEqual(images.map((image) => [image.kind, image.reason]), [['placeholder', 'remote']], 'the image reference too');
  });
});

/** Reviewer A's probe (R3): a host past 253 characters that ends in evil.example. */
const LONG_HOST_PROBE = `https://accounts.google.com.${'signin-secure-session-verify.'.repeat(10)}evil.example/login`;

/** An https address whose host is `length` characters, ending in evil.example, and whose path is `path`. */
const hostOf = (length, path = '/') => {
  const tail = 'evil.example';
  const labels = [];
  let room = length - tail.length;
  while (room > 0) {
    const label = Math.min(room - 1, 63);
    labels.push('a'.repeat(label));
    room -= label + 1;
  }
  const host = `${labels.join('.')}.${tail}`;
  assert.equal(host.length, length, `setup: a host of ${length}`);
  return `https://${host}${path}`;
};

describe('Markdown preview: an external link shows its whole origin (reviewer A, R3)', () => {
  test('MP-07: a host past 253 characters (DNS\u{2019}s most) is inert; up to it the link is external and its label is the whole origin, the path cut with \u{2026}', () => {
    assert.equal(MARKDOWN_MAX_LINK_HOST, 253);
    assert.ok(new URL(LONG_HOST_PROBE).hostname.length > 253, 'setup: the probe\u{2019}s host is past the limit');
    assert.deepEqual(classifyLink(LONG_HOST_PROBE, AT), { kind: 'inert' }, 'the probe');
    assert.deepEqual(classifyLink(LONG_HOST_PROBE, { filePath: null, root: null }), { kind: 'inert' }, 'the probe, no folder');
    assert.deepEqual(classifyLink(hostOf(254), AT), { kind: 'inert' }, 'one past the limit');
    // In a document too: the probe inline, autolinked and by reference.
    const { tree } = model(`[sign in](${LONG_HOST_PROBE}) <${LONG_HOST_PROBE}> [ref][p]\n\n[p]: ${LONG_HOST_PROBE}`);
    assert.deepEqual(linksOf(tree).map((node) => node.data.hProperties.dataLink), ['inert', 'inert', 'inert']);

    // At the limit, with a path far past what a label shows: the whole origin, then the path cut.
    const atLimit = classifyLink(hostOf(253, `/${'p'.repeat(2000)}`), AT);
    assert.equal(atLimit.kind, 'external');
    const origin = new URL(atLimit.address).origin;
    assert.ok(atLimit.label.startsWith(`${origin}/p`) && origin.endsWith('evil.example'), `the label keeps the origin: ${atLimit.label}`);
    assert.ok(atLimit.label.endsWith('\u{2026}') && atLimit.label.length <= 300, `the path is cut: ${atLimit.label.length}`);
    // A short host and a long path: the same.
    const short = classifyLink(`https://example.com/${'a'.repeat(2000)}?q=1`, AT);
    assert.ok(short.label.startsWith('https://example.com/aaa') && short.label.endsWith('\u{2026}') && short.label.length === 300, short.label);
  });
});

describe('Markdown preview: where an image comes from (AC-B3-4)', () => {
  test('MP-10: a relative path landing inside the open folder is loaded — resolved against the Markdown file, decoded once, backslashes as separators', () => {
    assert.deepEqual(classifyImageSource('img/a.png', AT), { kind: 'load', path: '/w/docs/img/a.png', address: 'img/a.png' });
    assert.deepEqual(classifyImageSource('../assets/b.png', AT), { kind: 'load', path: '/w/assets/b.png', address: '../assets/b.png' });
    assert.deepEqual(classifyImageSource('my%20pic.png', AT), { kind: 'load', path: '/w/docs/my pic.png', address: 'my%20pic.png' });
    assert.deepEqual(classifyImageSource('..\\assets\\c.png', WIN), { kind: 'load', path: 'C:\\proj\\assets\\c.png', address: '..\\assets\\c.png' });
    assert.deepEqual(classifyImageSource('x.png', { filePath: '/w/sub/deep/a.md', root: '/w' }), { kind: 'load', path: '/w/sub/deep/x.png', address: 'x.png' });
  });

  test('MP-11: anything else is a placeholder naming why and showing the cleaned address — never read, never fetched', () => {
    const cases = [
      ['../../x.png', 'outside', '../../x.png'],
      ['..\\..\\x.png', 'outside', '..\\..\\x.png'],
      ['%2e%2e/%2e%2e/x.png', 'outside', '%2e%2e/%2e%2e/x.png'],
      ['/etc/x.png', 'outside', '/etc/x.png'],
      ['C:\\x.png', 'unsupported', 'C:\\x.png'],
      ['file:///w/docs/a.png', 'outside', 'file:///w/docs/a.png'],
      ['http://127.0.0.1:8080/x.png', 'remote', 'http://127.0.0.1:8080/x.png'],
      ['https://user@evil.example/x.png', 'remote', 'https://evil.example/x.png'],
      ['HTTPS://EXAMPLE.com/x.png', 'remote', 'https://example.com/x.png'],
      ['//evil.example/x.png', 'remote', '//evil.example/x.png'],
      ['data:image/png;base64,AAAA', 'unsupported', 'data:image/png;base64,AAAA'],
      ['javascript:alert(1)', 'unsupported', 'javascript:alert(1)'],
      ['#x', 'unsupported', '#x'],
      ['', 'unsupported', ''],
    ];
    for (const [url, reason, address] of cases) {
      assert.deepEqual(classifyImageSource(url, AT), { kind: 'placeholder', reason, address }, url);
    }
    assert.deepEqual(classifyImageSource('img/a.png', { filePath: '/w/docs/README.md', root: null }), { kind: 'placeholder', reason: 'outside', address: 'img/a.png' }, 'no folder open');
    const hostile = classifyImageSource('http://ex\u202Eample.com/\x1b[31mx\u200B.png', AT);
    assert.equal(hostile.kind, 'placeholder');
    assert.ok(!HOSTILE_CHARS.test(hostile.address), `the address shown is cleaned: ${JSON.stringify(hostile.address)}`);
    const long = classifyImageSource(`data:image/png;base64,${'A'.repeat(100_000)}`, AT);
    assert.ok(long.address.length <= 300 && long.address.startsWith('data:image/png;base64,AAA'), 'a long address is cut');
  });

  test('MP-12: the plan reads at most 50 images, 50 MB together and none past the backend\'s 20 MB; the rest become placeholders, in document order', () => {
    assert.equal(MARKDOWN_MAX_IMAGES, 50);
    assert.equal(MARKDOWN_MAX_IMAGE_BYTES, 50 * MB);
    const load = (n) => ({ kind: 'load', path: `/w/i${n}.png`, address: `i${n}.png` });
    const many = Array.from({ length: 53 }, (_, n) => load(n));
    const small = new Map(many.map((image) => [image.path, 1000]));
    const counted = planImageLoads(many, small);
    assert.equal(counted.images.filter((image) => image.kind === 'load').length, 50);
    assert.deepEqual(counted.images.slice(50), [50, 51, 52].map((n) => ({ kind: 'placeholder', reason: 'count', address: `i${n}.png` })));
    assert.equal(counted.reads.length, 50);
    assert.equal(counted.bytes, 50_000);

    const remote = { kind: 'placeholder', reason: 'remote', address: 'https://example.com/x.png' };
    const sources = [load(1), remote, load(2), load(3), load(4), load(5), load(1), load(6), load(7)];
    const sizes = new Map([
      ['/w/i1.png', 20 * MB],
      ['/w/i2.png', 20 * MB],
      ['/w/i3.png', 10 * MB + 1],
      ['/w/i4.png', 10 * MB],
      ['/w/i5.png', IMAGE_MAX_BYTES + 1],
      ['/w/i6.png', 'big'],
    ]);
    const plan = planImageLoads(sources, sizes);
    assert.deepEqual(plan.images.map((image) => image.kind === 'load' ? 'load' : image.reason), [
      'load', 'remote', 'load', 'bytes', 'load', 'too-large', 'load', 'unknown-size', 'unknown-size',
    ], 'exactly 50 MB is within; 1 byte past is not; a smaller one after it still loads; the same file again costs nothing');
    assert.deepEqual(plan.reads, ['/w/i1.png', '/w/i2.png', '/w/i4.png'], 'each file is read once');
    assert.equal(plan.bytes, 50 * MB);
    assert.equal(plan.images[1], remote, 'a placeholder stays as it was');

    const twice = planImageLoads(Array.from({ length: 51 }, () => load(9)), new Map([['/w/i9.png', 10]]));
    assert.deepEqual([twice.images.filter((image) => image.kind === 'load').length, twice.reads, twice.bytes], [50, ['/w/i9.png'], 10], 'the same file 51 times: 50 shown, read once');
    assert.deepEqual(planImageLoads(null, null), { images: [], reads: [], bytes: 0 });
  });

  test('MP-13: images are read at most four at once, in order, every outcome kept; an abort starts no more', async () => {
    assert.equal(MARKDOWN_IMAGE_READS_AT_ONCE, 4);
    let running = 0;
    let most = 0;
    const started = [];
    const read = async (path, at) => {
      started.push(at);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 2 + (at % 3)));
      running -= 1;
      if (path === 'bad') throw new Error('refused');
      return `data:${path}`;
    };
    const paths = ['a', 'b', 'bad', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const results = await mapImageReads(paths, read);
    assert.equal(most, 4, 'four at once, no more and no fewer');
    assert.deepEqual(started, paths.map((_, at) => at), 'started in order');
    assert.equal(results.length, paths.length);
    assert.deepEqual(results[0], { status: 'fulfilled', value: 'data:a' });
    assert.equal(results[2].status, 'rejected');
    assert.equal(results[2].reason.message, 'refused');
    assert.deepEqual(results[9], { status: 'fulfilled', value: 'data:i' });

    const controller = new AbortController();
    let calls = 0;
    const stopped = await mapImageReads(paths, async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return 'x';
    }, { signal: controller.signal });
    assert.ok(calls <= 4, `no read starts after the abort (${calls} started)`);
    assert.deepEqual(stopped.slice(4), paths.slice(4).map(() => ({ status: 'cancelled' })));
    assert.deepEqual(await mapImageReads([], read), []);
  });

  test('MP-15: one preview\u{2019}s reads are shared by its rounds: never two of a path at once, never more than four in all, an answer taken by the round that still wants it, a stale read replaced only once it settled, its answer given to nobody', async () => {
    const held = [];
    let running = 0;
    let most = 0;
    const out = new Map();
    let twice = 0;
    const read = (path) => {
      running += 1;
      most = Math.max(most, running);
      out.set(path, (out.get(path) ?? 0) + 1);
      if (out.get(path) > 1) twice += 1;
      return new Promise((resolve, reject) => {
        held.push({
          path,
          done: false,
          settle: (ok = true) => {
            running -= 1;
            out.set(path, out.get(path) - 1);
            if (ok) resolve(`data:${path}`);
            else reject(new Error('refused'));
          },
        });
      });
    };
    /** Answers the oldest read of `path` still out. */
    const settleOf = (path, ok = true) => {
      const pending = held.find((r) => r.path === path && !r.done);
      pending.done = true;
      pending.settle(ok);
    };
    const reads = createImageReads(read);
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'];

    // Round 1 asks for six: four go out, in order.
    const one = new AbortController();
    const first = paths.map((path) => reads.get(path, one.signal));
    await letItSettle();
    assert.deepEqual(held.map((r) => r.path), ['a', 'b', 'c', 'd']);
    assert.equal(reads.running, 4);

    // Rounds 2 and 3 (a change on disk, twice) stop the one before and ask for the same six.
    one.abort();
    assert.deepEqual(await Promise.all(first), paths.map(() => ({ status: 'cancelled' })), 'round 1 answers cancelled');
    const two = new AbortController();
    const second = paths.map((path) => reads.get(path, two.signal));
    two.abort();
    await Promise.all(second);
    const three = new AbortController();
    const third = paths.map((path) => reads.get(path, three.signal));
    await letItSettle();
    assert.equal(held.length, 4, 'a round started reads of its own while four were out');

    // The reads round 1 sent answer round 3, and e and f follow, one per freed place.
    settleOf('a');
    settleOf('b', false);
    await letItSettle();
    assert.deepEqual(held.map((r) => r.path), ['a', 'b', 'c', 'd', 'e', 'f']);
    for (const path of ['c', 'd', 'e', 'f']) settleOf(path);
    const answers = await Promise.all(third);
    assert.deepEqual(answers.map((answer) => answer.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    assert.equal(answers[0].value, 'data:a');
    assert.equal(answers[1].reason.message, 'refused');
    assert.equal(held.length, 6, 'each path read once for all three rounds');

    // A read nobody waits for any more is never started.
    const four = new AbortController();
    const many = ['g', 'h', 'i', 'j', 'k', 'l'].map((path) => reads.get(path, four.signal));
    await letItSettle();
    four.abort();
    await Promise.all(many);
    for (const path of ['g', 'h', 'i', 'j']) settleOf(path);
    await letItSettle();
    assert.deepEqual(held.slice(6).map((r) => r.path), ['g', 'h', 'i', 'j'], 'k and l were read for nobody');
    assert.equal(reads.running, 0);

    // A file changed while its read was out: the new read waits for the old one, and gets its own answer.
    const five = new AbortController();
    reads.get('m', five.signal);
    const before = reads.get('m', new AbortController().signal);
    await letItSettle();
    assert.equal(reads.staleWhere((path) => path === 'm'), true, 'the read out was marked');
    assert.equal(reads.staleWhere((path) => path === 'zzz'), false, 'nothing else is out');
    five.abort();
    const six = new AbortController();
    const renewed = reads.get('m', six.signal);
    await letItSettle();
    assert.equal(held.filter((r) => r.path === 'm').length, 1, 'a second read of m went out while the first was');
    settleOf('m');
    await letItSettle();
    assert.deepEqual(await before, { status: 'stale' }, 'one who asked before the mark was given what the stale read brought (reviewer C3 R1)');
    assert.equal(held.filter((r) => r.path === 'm').length, 2, 'the fresh read of m never started');
    settleOf('m');
    assert.deepEqual(await renewed, { status: 'fulfilled', value: 'data:m' });

    assert.equal(most, 4, `more than four out at once (${most})`);
    assert.equal(twice, 0, 'two reads of one path were out at once');
    const gone = new AbortController();
    gone.abort();
    assert.deepEqual(await reads.get('n', gone.signal), { status: 'cancelled' }, 'an aborted round asks nothing');
    assert.equal(held.some((r) => r.path === 'n'), false);
  });

  test('MP-14: through the plugin, every image is listed in document order and drawn with no src at all', () => {
    const text = '![a](img/a.png) ![b](http://127.0.0.1:9/b.png "t") ![c](../../c.png) [![d](d.png)](https://example.com)';
    const { tree, images } = model(text);
    assert.deepEqual(images, [
      { kind: 'load', path: '/w/docs/img/a.png', address: 'img/a.png', index: 0 },
      { kind: 'placeholder', reason: 'remote', address: 'http://127.0.0.1:9/b.png', index: 1 },
      { kind: 'placeholder', reason: 'outside', address: '../../c.png', index: 2 },
      { kind: 'load', path: '/w/docs/d.png', address: 'd.png', index: 3 },
    ]);
    const nodes = nodesOf(tree).filter((node) => node.type === 'image');
    assert.deepEqual(nodes.map((node) => [node.url, node.data.hProperties.dataImage, node.data.hProperties.dataImageIndex]), [
      ['', 'load', 0], ['', 'placeholder', 1], ['', 'placeholder', 2], ['', 'load', 3],
    ]);
    const markup = render(text);
    assert.ok(!/\ssrc=/.test(markup), `no src in the markup: ${markup}`);
    assert.ok(!markup.includes('127.0.0.1:9/b.png"') || markup.includes('data-address="http://127.0.0.1:9/b.png"'), 'the remote address is only named');
  });
});

describe('Markdown preview: limits, nesting and time (AC-B3-5)', () => {
  test('MP-20: the limits are the human\'s, and the store\'s 2 MB is this one value', () => {
    assert.equal(MARKDOWN_PREVIEW_MAX_BYTES, 2 * MB);
    assert.equal(STORE_MAX_BYTES, MARKDOWN_PREVIEW_MAX_BYTES);
    const store = source('src/stores/editorStore.js');
    assert.ok(/import \{ MARKDOWN_PREVIEW_MAX_BYTES \} from '\.\.\/lib\/markdownPreview\.js';/.test(store), 'the store takes it from here');
    assert.ok(!/MARKDOWN_PREVIEW_MAX_BYTES\s*=/.test(store), 'the store keeps no second copy');
    assert.equal(isMarkdownTooLarge(2 * MB), false);
    assert.equal(isMarkdownTooLarge(2 * MB + 1), true);
    assert.equal(isMarkdownTooLarge(undefined), false);
  });

  test('MP-21: past the limit the preview says "Too large to preview (<size>; the limit is 2 MB)", the size as the backend rounds it', () => {
    assert.equal(markdownTooLargeText(2 * MB + 1), 'Too large to preview (2.1 MB; the limit is 2 MB)');
    assert.equal(markdownTooLargeText(3 * MB), 'Too large to preview (3.0 MB; the limit is 2 MB)');
    assert.equal(markdownTooLargeText(25 * MB - 1), 'Too large to preview (25.0 MB; the limit is 2 MB)');
    assert.equal(markdownTooLargeText(10 * 1024 * MB), 'Too large to preview (10.0 GB; the limit is 2 MB)');
    assert.equal(markdownTooLargeText(null), 'Too large to preview (the limit is 2 MB)');
    assert.equal(sizeLabel(-1), '');
    assert.equal(sizeLabel(1.5), '');
    assert.equal(sizeLabel('3'), '');

    // Reviewer B R4: one copy of the backend's size_label, held to the backend's own table, row by row.
    const rust = source('src-tauri/src/fs/mod.rs');
    const table = /fn a_size_is_said_in_tenths_of_a_mb_rounded_up\(\) \{\n\s*for \(bytes, words\) in \[\n([\s\S]*?)\n\s*\] \{/.exec(rust)?.[1];
    assert.ok(table, 'the backend\u{2019}s size table in src-tauri/src/fs/mod.rs');
    const product = (term) => term.split('*').map((n) => Number(n.trim())).reduce((a, b) => a * b, 1);
    const rows = [...table.matchAll(/^\s*\(([0-9 *+-]+), "([^"]+)"\),$/gm)].map(([, expr, words]) => {
      const [first, ...rest] = expr.trim().split(/\s+([+-])\s+/);
      let bytes = product(first);
      for (let i = 0; i < rest.length; i += 2) bytes += (rest[i] === '+' ? 1 : -1) * product(rest[i + 1]);
      return [bytes, words];
    });
    assert.equal(rows.length, table.trim().split('\n').length, 'a row of the table was not read');
    assert.ok(rows.length >= 15, `${rows.length} rows`);
    assert.deepEqual(rows.map(([bytes]) => [bytes, sizeLabel(bytes)]), rows, 'the copy says a size otherwise than the backend');
    assert.match(rust, /let tenths = \(u128::from\(bytes\) \* 10\)\.div_ceil\(u128::from\(MB\)\);/);
    // And it is the only copy: the preview and the browser mock take it, and say no size of their own.
    for (const file of ['src/lib/markdownPreview.js', 'src/lib/ipc.js']) {
      const code = source(file);
      assert.match(code, /^import \{ sizeLabel \} from '\.\/sizeLabel\.js';$/m, `${file} does not take sizeLabel`);
      assert.ok(!/Math\.ceil\(\(bytes \* 10\)/.test(code), `${file} keeps a size formatter of its own`);
    }
    assert.ok(!/markdownSizeLabel|mockSizeLabel/.test(source('src/lib/markdownPreview.js') + source('src/lib/ipc.js')), 'an old copy is still there');
  });

  test('MP-22: the source bound leaves a real document exactly as it is, and cuts a line nesting past it back to the bound', () => {
    const readme = source('README.md');
    assert.deepEqual(boundMarkdownSource(readme), { text: readme, flattened: false }, 'README.md is untouched');
    const normal = '> quote\n> > nested\n- a\n  - b\n    1. c\n* * *\n**bold** -x 1.5 *a*\n\tcode\r\n';
    assert.deepEqual(boundMarkdownSource(normal), { text: normal, flattened: false });

    const deep = boundMarkdownSource(`${'>'.repeat(40)} hello\nnext`);
    assert.deepEqual(deep, { text: `${'>'.repeat(MARKDOWN_MAX_PREFIX_MARKERS)} hello\nnext`, flattened: true });
    assert.equal(boundMarkdownSource(`${'- '.repeat(40)}a`).text, `${'- '.repeat(MARKDOWN_MAX_PREFIX_MARKERS - 1)}- a`);
    assert.equal(boundMarkdownSource(`${' '.repeat(200)}- a`).text, `${' '.repeat(MARKDOWN_MAX_PREFIX_COLUMNS)}- a`);
    assert.equal(boundMarkdownSource(`${'\t'.repeat(40)}- a`).text, `${' '.repeat(MARKDOWN_MAX_PREFIX_COLUMNS)}- a`, 'a tab counts four');
    assert.equal(boundMarkdownSource(`${'> '.repeat(33)}x\r\ny`).text, `${'> '.repeat(31)}> x\r\ny`, 'CRLF kept');
    assert.equal(boundMarkdownSource(`${'>'.repeat(32)} at the bound`).flattened, false);
    // A thematic break of many markers is still one after the cut.
    const rule = model(boundMarkdownSource(`${'* '.repeat(40)}`).text).tree;
    assert.deepEqual(rule.children.map((node) => node.type), ['thematicBreak']);
    assert.deepEqual(boundMarkdownSource(null), { text: '', flattened: false });
  });

  test('MP-23: a tree nesting past the cap is flattened to its text with a stack of its own — 200,000 levels, no stack overflow', () => {
    let leaf = { type: 'paragraph', children: [{ type: 'text', value: 'bottom\u202E' }, { type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', value: 'x' }] }] };
    for (let i = 0; i < 200_000; i += 1) leaf = { type: 'blockquote', children: [leaf] };
    const quotes = { type: 'root', children: [leaf] };
    const result = modelMarkdownTree(quotes, AT);
    assert.equal(result.flattened, 1);
    assert.ok(depthOf(quotes) <= MARKDOWN_MAX_DEPTH + 3, `depth ${depthOf(quotes)}`);
    const flat = nodesOf(quotes).filter((node) => node.type === 'text');
    assert.deepEqual(flat.map((node) => node.value), ['bottomx'], 'its text, cleaned, and the link gone');

    let strong = { type: 'text', value: 'core' };
    for (let i = 0; i < 200_000; i += 1) strong = { type: i % 2 ? 'strong' : 'emphasis', children: [strong] };
    const emphasis = { type: 'root', children: [{ type: 'heading', depth: 1, children: [strong] }] };
    modelMarkdownTree(emphasis, AT);
    assert.ok(depthOf(emphasis) <= MARKDOWN_MAX_DEPTH + 3);
    assert.ok(nodesOf(emphasis).some((node) => node.type === 'text' && node.value === 'core'));
    assert.match(emphasis.children[0].data.hProperties.id, /^md-core$/);

    const shallow = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }] }] };
    assert.equal(modelMarkdownTree(shallow, AT).flattened, 0);
    assert.deepEqual(shallow.children[0].children, [{ type: 'text', value: 'a' }], 'a shallow tree keeps its shape');
  });

  test('MP-24: a paragraph keeps at most MARKDOWN_MAX_CHILDREN children, the rest one text, so no call spreads a huge list', () => {
    const children = Array.from({ length: 50_000 }, (_, n) => (n % 2 ? { type: 'inlineCode', value: `c${n}` } : { type: 'text', value: `t${n}` }));
    const tree = { type: 'root', children: [{ type: 'list', children: [{ type: 'listItem', spread: false, children: [{ type: 'paragraph', children }] }] }] };
    modelMarkdownTree(tree, AT);
    const paragraph = tree.children[0].children[0].children[0];
    assert.equal(paragraph.children.length, MARKDOWN_MAX_CHILDREN);
    const last = paragraph.children[MARKDOWN_MAX_CHILDREN - 1];
    assert.equal(last.type, 'text');
    assert.ok(last.value.startsWith('c9999t10000') && last.value.endsWith('c49999'), 'the rest is one text, in order');
    // A tight list item whose paragraph has 300,000 children: mdast-util-to-hast spreads them into one call,
    // which throws a RangeError without the cap. (Built here: the parser takes minutes to make such a line.)
    const many = Array.from({ length: 300_000 }, (_, n) => (n % 2 ? { type: 'emphasis', children: [{ type: 'text', value: 'a' }] } : { type: 'text', value: ' ' }));
    const wide = { type: 'root', children: [{ type: 'list', ordered: false, spread: false, children: [{ type: 'listItem', spread: false, children: [{ type: 'paragraph', children: many }] }] }] };
    modelMarkdownTree(wide, AT);
    const hast = unified().use(remarkRehype).runSync(wide);
    assert.ok(depthOf(hast) < 10);
    assert.ok(nodesOf(hast).length < 4 * MARKDOWN_MAX_CHILDREN);
  });

  test('MP-25: footnote references past the cap are their text, so the footer does not spread a huge list either', () => {
    const text = `${'x[^a] '.repeat(MARKDOWN_MAX_FOOTNOTE_REFERENCES + 200)}\n\n[^a]: note`;
    const { tree } = model(text);
    assert.equal(nodesOf(tree).filter((node) => node.type === 'footnoteReference').length, MARKDOWN_MAX_FOOTNOTE_REFERENCES);
    assert.equal(nodesOf(tree).filter((node) => node.type === 'text' && node.value === '[^a]').length, 200);
    assert.ok(render(text).includes('note'));
  });

  test('MP-26: 2 MB of deep nesting, or of backticks, is parsed and modelled in under 2 s, and drawn without a stack overflow', () => {
    const SIZE = 2 * MB;
    let indented = '';
    for (let i = 0; indented.length < SIZE; i += 1) indented += `${' '.repeat(2 * i)}- a\n`;
    let stairs = '';
    for (let i = 1; stairs.length < SIZE; i += 1) stairs += `${'>'.repeat(i)} a\n`;
    // [input, whether the bound must cut it]
    const inputs = {
      'one line of >': ['>'.repeat(SIZE), true],
      '> - repeated': ['> - '.repeat(SIZE / 4), true],
      '- repeated': [`${'- '.repeat(SIZE / 2)}a`, true],
      'a list nested by indentation': [indented.slice(0, SIZE), true],
      'quotes one deeper each line': [stairs.slice(0, SIZE), true],
      'one run of backticks': ['`'.repeat(SIZE), false],
    };
    for (const [name, [text, cut]] of Object.entries(inputs)) {
      assert.ok(text.length >= SIZE - 4, `${name}: 2 MB`);
      const started = performance.now();
      const bounded = boundMarkdownSource(text);
      // A bound that does not hold fails here, before a parse that would take minutes.
      assert.equal(bounded.flattened, cut, `${name}: cut`);
      if (cut) assert.ok(bounded.text.length <= 400_000, `${name}: bounded to ${bounded.text.length}`);
      const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMarkdownPreview, AT).use(remarkRehype);
      const hast = processor.runSync(processor.parse(bounded.text));
      const took = performance.now() - started;
      assert.ok(took < 2000, `${name}: ${took.toFixed(0)} ms`);
      assert.ok(depthOf(hast) <= 2 * MARKDOWN_MAX_DEPTH + 8, `${name}: depth ${depthOf(hast)}`);
    }
    const markup = render(boundMarkdownSource(inputs['one line of >'][0]).text);
    assert.ok((markup.match(/<blockquote>/g) ?? []).length <= MARKDOWN_MAX_PREFIX_MARKERS);
  });

  test('MP-27: emphasis nested a thousand deep by the parser is flattened by the plugin and drawn without a stack overflow', () => {
    const text = `${'*'.repeat(2048)}deep${'*'.repeat(2048)}`;
    const { tree } = model(text);
    assert.ok(depthOf(tree) <= MARKDOWN_MAX_DEPTH + 3, `depth ${depthOf(tree)}`);
    assert.ok(nodesOf(tree).some((node) => node.type === 'text' && node.value.includes('deep')));
    const markup = render(text);
    assert.ok(markup.includes('deep'));
    assert.ok((markup.match(/<(em|strong)>/g) ?? []).length <= MARKDOWN_MAX_DEPTH);
  });
});

describe('Markdown preview: the drawing cap (reviewer A, R2)', () => {
  test('MP-28: hastPastElements counts elements only, is false at MARKDOWN_MAX_ELEMENTS and true one past, and stops once past', () => {
    assert.equal(MARKDOWN_MAX_ELEMENTS, 100_000);
    const tree = (n) => ({ type: 'root', children: Array.from({ length: n }, () => ({ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'a' }] })) });
    assert.equal(hastPastElements(tree(MARKDOWN_MAX_ELEMENTS)), false, 'exactly at the cap');
    assert.equal(hastPastElements(tree(MARKDOWN_MAX_ELEMENTS + 1)), true, 'one past it');
    assert.equal(hastPastElements(tree(3), 3), false);
    assert.equal(hastPastElements(tree(4), 3), true);
    // Deep, with a stack of its own; text nodes are not elements.
    let deep = { type: 'text', value: 'x' };
    for (let i = 0; i < 200_000; i += 1) deep = { type: 'element', tagName: 'em', properties: {}, children: [deep, { type: 'text', value: 'y' }] };
    assert.equal(hastPastElements({ type: 'root', children: [deep] }, 200_000), false);
    assert.equal(hastPastElements({ type: 'root', children: [deep] }, 199_999), true);
    // Stops once past: the nodes after that are never looked at.
    let looked = 0;
    const counted = { type: 'root', children: Array.from({ length: 10 }, () => ({ get type() { looked += 1; return 'element'; } })) };
    assert.equal(hastPastElements(counted, 2), true);
    assert.ok(looked <= 4, `looked at ${looked} nodes`);
    assert.equal(hastPastElements(null), false);
    assert.equal(hastPastElements({ type: 'root', children: [] }), false);
  });
});

describe('Markdown preview: hostile text cleaned (AC-B3-6)', () => {
  test('MP-30: ESC, BEL, U+202E and U+200B are removed from heading text, which keeps its spaces; its id is built from the clean text', () => {
    const { tree } = model('# Hi\x1b[31m\x07 \u202Eevil\u200B *the\u200Bre* `co\x1bde`\n');
    const heading = tree.children[0];
    const texts = nodesOf(heading).filter((node) => typeof node.value === 'string').map((node) => node.value);
    assert.deepEqual(texts, ['Hi[31m evil ', 'there', ' ', 'code']);
    for (const text of texts) assert.ok(!HOSTILE_CHARS.test(text), JSON.stringify(text));
    assert.equal(heading.data.hProperties.id, 'md-hi31m-evil-there-code');
  });

  test('MP-31: link text, link and image titles and alt are cleaned; references too', () => {
    const text = [
      '[\u202Egnp.exe\x1b](https://example.com "ti\u200Btle\x07") ![a\u202Eb\x1b](img.png "T\u200B") [r\u2066ef][r] ![al\u200Bt][i]',
      '',
      '[r]: https://example.com "re\u202Ef"',
      '[i]: img.png "im\x07g"',
    ].join('\n');
    const { tree } = model(text);
    const links = linksOf(tree);
    assert.deepEqual(links.map((node) => [node.children.map((child) => child.value).join(''), node.title]), [['gnp.exe', 'title'], ['ref', 'ref']]);
    const images = nodesOf(tree).filter((node) => node.type === 'image');
    assert.deepEqual(images.map((node) => [node.alt, node.title]), [['ab', 'T'], ['alt', 'img']]);
    const markup = render(text);
    assert.ok(!HOSTILE_CHARS.test(markup.replace(/\n/g, '')), 'nothing hostile reaches the markup');
  });

  test('MP-32: cleanInlineText drops what displayText drops and keeps a space at either end', () => {
    assert.equal(cleanInlineText(' a\x1b\x07\u202E\u200Bb '), ' ab ');
    assert.equal(cleanInlineText('\u200B'), '');
    assert.equal(cleanInlineText('a\n\tb'), 'a b');
    assert.equal(cleanInlineText('\u{1F44D}\u{FE0F}'), '\u{1F44D}\u{FE0F}', 'a variation selector is kept');
    assert.equal(cleanInlineText(null), '');
    assert.equal(cleanInlineText(''), '');
  });
});

describe('Markdown preview: heading ids (F-B3-2)', () => {
  test('MP-40: a slug is a-z, 0-9 and single dashes, made the same way from a heading and a link fragment', () => {
    const cases = [
      ['Hello World', 'hello-world'],
      ["What's new?", 'whats-new'],
      ['foo_bar  baz', 'foo-bar-baz'],
      ['  --Trim--  ', 'trim'],
      ['설치 가이드', 'uc124-uce58-uac00-uc774-ub4dc'],
      ['Café', 'caf-ue9'],
      ['\u{1F680}', ''],
      ['!!!', ''],
      ['', ''],
    ];
    for (const [text, slug] of cases) assert.equal(slugBase(text), slug, text);
    assert.equal(slugBase('설치-가이드'), slugBase('설치 가이드'));
    const long = slugBase('word '.repeat(100));
    assert.ok(long.length <= 64 && !long.endsWith('-'));
    for (const text of ['\u202Eevil', 'a\x1bb', 'Ünïcödé ✓ ⚠ 数字 123', 'x'.repeat(5000), slugBase('İstanbul')]) {
      assert.match(slugBase(text), /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/, text.slice(0, 20));
    }
    assert.equal(slugBase(null), '');
  });

  test('MP-41: ids are unique: duplicates numbered, never one already given, the fallback for an empty slug', () => {
    const id = createHeadingIds();
    assert.deepEqual(['Foo', 'Foo', 'Foo 1', 'foo', '\u{1F680}', '\u{1F680}', '', 'Section'].map(id), [
      'md-foo', 'md-foo-1', 'md-foo-1-1', 'md-foo-2', `md-${HEADING_SLUG_FALLBACK}`, 'md-section-1', 'md-section-2', 'md-section-3',
    ]);
    assert.equal(HEADING_ID_PREFIX, 'md-');
    assert.equal(createHeadingIds('x-')('A'), 'x-a');
    assert.equal(createHeadingIds('<script>')('A'), 'md-a', 'an unsafe prefix is not used');
    const many = createHeadingIds();
    const given = new Set(Array.from({ length: 5000 }, () => many('Same')));
    assert.equal(given.size, 5000);
  });

  test('MP-42: through the plugin, headings get their ids and anchor links find them', () => {
    const text = '# Intro\n\n## Intro\n\n## 설치\n\n### \u{1F680}\n\n[a](#intro) [b](#intro-1) [c](#%EC%84%A4%EC%B9%98) [d](#nowhere)\n';
    const { tree } = model(text);
    const ids = tree.children.filter((node) => node.type === 'heading').map((node) => node.data.hProperties.id);
    assert.deepEqual(ids, ['md-intro', 'md-intro-1', `md-${slugBase('설치')}`, 'md-section']);
    assert.deepEqual(linksOf(tree).map((node) => node.data.hProperties.dataTarget), ['md-intro', 'md-intro-1', `md-${slugBase('설치')}`, 'md-nowhere']);
    const markup = render(text);
    for (const headingId of ids) assert.ok(markup.includes(`id="${headingId}"`), headingId);
    assert.ok(markup.includes('href="#md-intro-1"'));
  });
});

describe('Markdown preview: raw HTML is literal text (F-B3-3)', () => {
  const HOSTILE_HTML = [
    '<script>alert(1)</script>',
    '',
    '<img src=x onerror=alert(1)>',
    '',
    '<iframe src="https://evil.example"></iframe>',
    '',
    '<details open><summary>s</summary>hidden</details>',
    '',
    '<!-- a comment -->',
    '',
    'Inline <a href="javascript:alert(1)">click</a>, <b onclick="x()">bold</b> and <img src=x onerror=alert(2)> and <!-- c -->.',
    '',
    '- item <span style="x">s</span>',
    '',
    '| a | b |',
    '|---|---|',
    '| <i>c</i> | <svg onload=alert(3)> |',
    '',
    '# Title <img src=y onerror=alert(4)>',
  ].join('\n');

  test('MP-50: the plugin turns every html node, block and inline, into a literal node of the documented shape; no raw node reaches hast', () => {
    const { tree } = model(HOSTILE_HTML);
    const nodes = nodesOf(tree);
    assert.ok(!nodes.some((node) => node.type === 'html'), 'no html node is left');
    const literals = nodes.filter((node) => node.data?.hProperties?.className?.includes(RAW_HTML_CLASS));
    const blocks = literals.filter((node) => node.data.hProperties.dataRawHtml === 'block');
    const inline = literals.filter((node) => node.data.hProperties.dataRawHtml === 'inline');
    assert.equal(blocks.length, 5);
    assert.ok(inline.length >= 10, `${inline.length} inline`);
    for (const node of blocks) {
      assert.deepEqual([node.type, node.children, node.data.hName, node.data.hChildren.length, node.data.hChildren[0].type], ['paragraph', [], 'div', 1, 'text']);
    }
    for (const node of inline) {
      assert.deepEqual([node.type, node.data.hName, node.data.hChildren[0].type, node.data.hChildren[0].value], ['text', 'span', 'text', node.value]);
    }
    assert.equal(blocks[0].data.hChildren[0].value, '<script>alert(1)</script>');

    const hast = toHast(HOSTILE_HTML);
    const hastNodes = nodesOf(hast);
    assert.ok(!hastNodes.some((node) => node.type === 'raw'), 'no raw node, even with allowDangerousHtml');
    const tags = new Set(hastNodes.filter((node) => node.type === 'element').map((node) => node.tagName));
    for (const tag of ['script', 'img', 'iframe', 'details', 'summary', 'svg', 'b', 'i', 'a']) assert.ok(!tags.has(tag), `no <${tag}> element`);
  });

  test('MP-51: rendered by react-markdown, none of it is an element; all of it is escaped text in the dimmed element', () => {
    const markup = render(HOSTILE_HTML);
    for (const bad of ['<script', '<iframe', '<details', '<summary', '<svg', '<img', '<b ', '<i>', '<!--']) {
      assert.ok(!markup.includes(bad), `${bad} in ${markup}`);
    }
    // The words stay, as text: "onerror=" is in the markup only between &lt; and &gt;, never in a tag.
    const tags = markup.match(/<[a-z][^>]*>/g) ?? [];
    for (const tag of tags) assert.ok(!/\s(?:on\w+|style|srcdoc|href|src)=/i.test(tag), `an attribute from the HTML: ${tag}`);
    assert.ok(markup.includes('onerror=alert(1)&gt;'), 'shown as text');
    for (const shown of ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;img src=x onerror=alert(1)&gt;', '&lt;iframe src=&quot;https://evil.example&quot;&gt;&lt;/iframe&gt;', '&lt;details open&gt;', '&lt;!-- a comment --&gt;', '&lt;svg onload=alert(3)&gt;']) {
      assert.ok(markup.includes(shown), `${shown} not shown`);
    }
    assert.ok(markup.includes(`<div class="${RAW_HTML_CLASS}" data-raw-html="block">`));
    assert.ok(markup.includes(`<span class="${RAW_HTML_CLASS}" data-raw-html="inline">`));
  });
});

describe('Markdown preview: the urlTransform (no URL but #…)', () => {
  test('MP-60: only an <a> href staying in the document survives; every src and every other URL is null', () => {
    const a = (dataLink) => ({ type: 'element', tagName: 'a', properties: dataLink ? { dataLink } : {} });
    assert.equal(markdownUrlTransform('#md-x', 'href', a('anchor')), '#md-x');
    assert.equal(markdownUrlTransform('#user-content-fn-1', 'href', a()), '#user-content-fn-1', 'a GFM footnote link');
    for (const value of ['https://example.com', '//evil.example', '../../outside.md', 'javascript:alert(1)', '', '#a b', '#a\u0000', `#${'a'.repeat(20000)}`]) {
      assert.equal(markdownUrlTransform(value, 'href', a()), null, JSON.stringify(value.slice(0, 30)));
    }
    for (const kind of ['external', 'file', 'inert']) assert.equal(markdownUrlTransform('#x', 'href', a(kind)), null, kind);
    const img = { type: 'element', tagName: 'img', properties: { dataImage: 'load' } };
    for (const value of ['img/a.png', 'data:image/png;base64,AAAA', 'https://example.com/x.png', '#x', '']) assert.equal(markdownUrlTransform(value, 'src', img), null);
    assert.equal(markdownUrlTransform('#x', 'cite', { type: 'element', tagName: 'blockquote', properties: {} }), null);
    assert.equal(markdownUrlTransform('#x', 'href', { type: 'element', tagName: 'link', properties: {} }), null);
    assert.equal(markdownUrlTransform(null, 'href', a()), null);
    assert.equal(markdownUrlTransform('#x', 'href', undefined), null);
  });

  test('MP-61: in the rendered markup every href is #…, and every hostile link of AC-B3-3 is text with no href', () => {
    const hostile = AC_HOSTILE.map((url, n) => `[h${n}](<${url.replace(/\t/g, '&#9;').replace(/\x01/g, '&#1;')}>)`).join(' ');
    const text = `# Top\n\n${hostile} [e](https://example.com) [f](guide.md) [t](#top) [n][fn] x[^1]\n\n[fn]: //evil.example\n[^1]: note\n`;
    const markup = render(text);
    const hrefs = [...markup.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]);
    assert.ok(hrefs.length >= 2, `anchors keep their href: ${hrefs}`);
    for (const href of hrefs) assert.ok(href.startsWith('#'), `href ${href}`);
    assert.ok(!/\ssrc=/.test(markup));
    for (let n = 0; n < AC_HOSTILE.length; n += 1) {
      assert.ok(markup.includes(`<a data-link="inert">h${n}</a>`), `h${n} (${JSON.stringify(AC_HOSTILE[n])}) is inert text: ${markup}`);
    }
    assert.ok(markup.includes('<a data-link="external" data-target="https://example.com/">e</a>'));
    assert.ok(markup.includes('<a data-link="file" data-target="/w/docs/guide.md">f</a>'));
    assert.ok(markup.includes('<a href="#md-top" data-link="anchor" data-target="md-top">t</a>'));
    assert.ok(markup.includes('<a data-link="inert">n</a>'), 'a reference to //evil.example');
  });
});
