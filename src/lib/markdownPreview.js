/**
 * A Markdown preview tab (Orca bundle 5, B3): the safe model the preview is
 * drawn from. Which links go where, which images are read and which are only
 * named, how many and how much, how deep a document may nest, the words for
 * a file past the limit, and a remark plugin that makes the tree safe before
 * react-markdown turns it into elements.
 *
 * Pure: no React, no stores, no DOM, no IPC — and none of the Markdown
 * library either (react-markdown, remark, unified, micromark, mdast, hast,
 * rehype). The editor store reads MARKDOWN_PREVIEW_MAX_BYTES from here and is
 * in the first chunk, which must not grow (WV-06b, AC-G-3); the plugin is a
 * plain walk over the tree react-markdown hands it.
 *
 * WHAT THE PREVIEW (MarkdownPreview.jsx, step P7) DOES WITH THIS
 *
 *   1. `boundMarkdownSource(text).text` is what react-markdown is given: a
 *      line whose container prefix (`>` and list markers, and the white
 *      space around them) is past MARKDOWN_MAX_PREFIX_MARKERS markers or
 *      MARKDOWN_MAX_PREFIX_COLUMNS columns is cut back to them. The parser
 *      itself overflows the stack on a few kilobytes of `>`, before any
 *      plugin runs, and slows down with the square of the depth.
 *   2. `remarkPlugins: [remarkGfm, [remarkMarkdownPreview, { filePath, root,
 *      onImages }]]`, the plugin last. It works on the mdast tree:
 *        - nesting past MARKDOWN_MAX_DEPTH is flattened into plain text;
 *        - raw HTML (block and inline `html` nodes) becomes literal text in a
 *          dimmed element, never an element of its own (below);
 *        - link and image references are resolved to links and images, so
 *          that every one is classified;
 *        - every link is classified (`classifyLink`) and every image
 *          (`classifyImageSource`), and the result is written on the node;
 *        - headings get unique ASCII-safe ids (`createHeadingIds`);
 *        - heading text, link text, titles and alt text are cleaned of
 *          control, bidirectional and invisible characters (`displayText`,
 *          the bundle-4 cleaning).
 *   3. `urlTransform: markdownUrlTransform`: no URL reaches the markup but a
 *      same-document `#…`. react-markdown's own default lets `//host` and
 *      `../../outside.md` through.
 *   4. `components` read what the plugin wrote (the hast properties below,
 *      which reach a component as `data-*` props).
 *
 * THE NODES THE PLUGIN WRITES (for P7)
 *
 *   Raw HTML, inline (inside a paragraph, heading, cell, link …):
 *     { type: 'text', value, data: { hName: 'span',
 *       hProperties: { className: ['md-raw-html'], dataRawHtml: 'inline' },
 *       hChildren: [{ type: 'text', value }] } }
 *     → <span class="md-raw-html" data-raw-html="inline">&lt;b&gt;</span>
 *   Raw HTML, block (directly in the root, a quote, a list item, a footnote):
 *     { type: 'paragraph', children: [], data: { hName: 'div',
 *       hProperties: { className: ['md-raw-html'], dataRawHtml: 'block' },
 *       hChildren: [{ type: 'text', value }] } }
 *     → <div class="md-raw-html" data-raw-html="block">&lt;script&gt;…</div>
 *       Its text keeps its line breaks: style it `white-space: pre-wrap`.
 *   mdast-util-to-hast turns `hName` on a text node into an element whose
 *   one child is `hChildren` — a hast text node, which React escapes. The
 *   tree holds no `html` node afterwards, so remark-rehype has no `raw` node
 *   to pass on, whatever `allowDangerousHtml` says.
 *
 *   A link: `url` is '#<id>' for an anchor and '' for anything else, and
 *     hProperties { dataLink: 'external' | 'anchor' | 'file' | 'inert',
 *                   dataTarget: address (external) | id (anchor) | path (file) }
 *     → <a data-link="external" data-target="https://example.com/">…</a>
 *   An image: `url` is always '', and
 *     hProperties { dataImage: 'load' | 'placeholder', dataImageIndex: n,
 *                   dataAddress: the cleaned address, for a placeholder }
 *     → <img alt="…" data-image="load" data-image-index="0">
 *     `onImages(list)` hands over every image in document order (index n),
 *     as `classifyImageSource` gives it; `planImageLoads` says which of the
 *     'load' ones are read, `mapImageReads` asks their sizes and
 *     `createImageReads` reads them, at most MARKDOWN_IMAGE_READS_AT_ONCE
 *     at once each — the reads counted across every round of one preview.
 *   A heading: hProperties { id: 'md-<slug>' }. GFM footnotes keep their
 *     own 'user-content-…' ids and '#user-content-…' links.
 *
 *   Look ids up inside the preview's own element, not the document: two
 *   previews of one file hold the same ids. The `md-` prefix keeps a heading
 *   called "Root" or "Config" from naming the app's own elements.
 */
import { collapseDots, dirname, isInside, join, toPosix, withSepOf } from './paths.js';
import { displayText } from './projectCommands.js';
import { addressToOpen, hyperlinkTitle, isOpenable } from './openExternal.js';
import { IMAGE_MAX_BYTES } from './imagePreview.js';
import { sizeLabel } from './sizeLabel.js';

const MB = 1024 * 1024;

/** The largest Markdown file a preview shows, in UTF-8 bytes (the human's decision, 2026-11-24). */
export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * MB;

/** The most images one document shows; the rest are placeholders (the human's decision, 2026-11-24). */
export const MARKDOWN_MAX_IMAGES = 50;

/** The most image bytes one document reads, all images together (the human's decision, 2026-11-24). */
export const MARKDOWN_MAX_IMAGE_BYTES = 50 * MB;

/** How many images are read at once. */
export const MARKDOWN_IMAGE_READS_AT_ONCE = 4;

/** How deep the tree may nest; a node below it shows its text, flattened. */
export const MARKDOWN_MAX_DEPTH = 32;

/**
 * The most children a paragraph, heading, cell, emphasis or link keeps; the
 * rest are one text. mdast-util-to-hast spreads such a list into a call's
 * arguments (a tight list item's paragraph, an unresolved reference), and a
 * few hundred thousand of them overflow the stack.
 */
export const MARKDOWN_MAX_CHILDREN = 10_000;

/**
 * The most footnote references one document links; later ones are their
 * text. Every reference adds a back link to its footnote, and the footer
 * spreads those into a call's arguments too.
 */
export const MARKDOWN_MAX_FOOTNOTE_REFERENCES = 1000;

/**
 * The most elements one preview draws (the Queen's decision for OQ-B3g,
 * 2026-11-24). The worker parses, but the window's thread draws what it
 * answers — again on every live update — so the tree is capped where it is
 * built (markdownPipeline.js `safeHast`), and checked once more before it is
 * drawn (`hastPastElements`). Past it the preview says "Too complex to
 * preview" with Open as Text, as for the time limit.
 */
export const MARKDOWN_MAX_ELEMENTS = 100_000;

/**
 * The name of the error the pipeline throws past MARKDOWN_MAX_ELEMENTS. The
 * worker posts it as it posts any error's name, and the render client
 * (markdownRenderClient.js, which imports nothing and keeps a copy) answers
 * 'too-complex' for it.
 */
export const MARKDOWN_TOO_COMPLEX_ERROR = 'MarkdownTooComplexError';

/** The most container markers (`>`, `-`, `1.` …) one line's prefix keeps. */
export const MARKDOWN_MAX_PREFIX_MARKERS = 32;

/** The most columns of white space one line's container prefix keeps (a tab counts 4). */
export const MARKDOWN_MAX_PREFIX_COLUMNS = 64;

/** What every heading id starts with. */
export const HEADING_ID_PREFIX = 'md-';

/** A heading's slug when its text gives none (only symbols, or nothing). */
export const HEADING_SLUG_FALLBACK = 'section';

/** The class of the element raw HTML is shown in, as text. */
export const RAW_HTML_CLASS = 'md-raw-html';

/** The longest slug, before a number is added to make it unique. */
const SLUG_MAX = 64;

/** How much of a heading's text a slug is made from. */
const SLUG_INPUT_MAX = 1024;

/** How much of an address is looked at at all; a longer one is inert. */
const INPUT_MAX = 16_384;

/**
 * The longest host an external link may name: the most a DNS name holds
 * (253 characters, written without its final dot). A longer one resolves
 * nowhere, and its confirmation could not show it whole — so its link is
 * inert, decided here and nowhere else.
 */
export const MARKDOWN_MAX_LINK_HOST = 253;

/** The longest address a placeholder shows, and the longest alt and title. */
const SHOWN_MAX = 300;

/** The parents whose children are blocks: flattened, they hold one paragraph. */
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** The parents whose children are inline: flattened, they hold one text. */
const PHRASING_PARENTS = new Set(['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'link', 'linkReference']);

/** The nodes a flattened text puts a space before. */
const BLOCK_NODES = new Set(['paragraph', 'heading', 'blockquote', 'list', 'listItem', 'code', 'html', 'table', 'tableRow', 'tableCell', 'thematicBreak', 'footnoteDefinition']);

/* ------------------------------------------------------------------ sizes */

/** Whether a Markdown file of `bytes` is past the preview's limit. */
export function isMarkdownTooLarge(bytes) {
  return Number.isFinite(bytes) && bytes > MARKDOWN_PREVIEW_MAX_BYTES;
}

/** What a preview past the limit says: 'Too large to preview (2.1 MB; the limit is 2 MB)'. */
export function markdownTooLargeText(bytes) {
  const limit = `the limit is ${MARKDOWN_PREVIEW_MAX_BYTES / MB} MB`;
  // The size as the backend says it (`size_label`), from the one copy of it here.
  const size = sizeLabel(bytes);
  return size ? `Too large to preview (${size}; ${limit})` : `Too large to preview (${limit})`;
}

/**
 * Whether the hast tree `tree` holds more than `max` elements
 * (MARKDOWN_MAX_ELEMENTS): walked with a stack of its own, and stopped as
 * soon as it is past, so a tree of millions costs no more than `max` steps.
 */
export function hastPastElements(tree, max = MARKDOWN_MAX_ELEMENTS) {
  let elements = 0;
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node?.type === 'element') {
      elements += 1;
      if (elements > max) return true;
    }
    if (Array.isArray(node?.children)) for (const child of node.children) stack.push(child);
  }
  return false;
}

/* -------------------------------------------------------------- cleaning */

/**
 * `value` cleaned as `displayText` cleans (control, bidirectional and
 * invisible characters dropped, white space runs as one space), but keeping
 * a space at either end: a heading's text is several nodes, and "Hello " in
 * front of *world* must keep its space. Nothing is cut.
 */
export function cleanInlineText(value) {
  if (typeof value !== 'string' || value === '') return '';
  return displayText(`x${value}x`, Infinity).slice(1, -1);
}

/** An alt or a title as shown: cleaned, trimmed, at most SHOWN_MAX characters. */
function cleanShown(value) {
  return typeof value === 'string' ? displayText(value.slice(0, INPUT_MAX), SHOWN_MAX) : '';
}

/* ------------------------------------------------------------- addresses */

/** ASCII tab and line breaks, which a URL parser drops wherever they are (`java\tscript:`). */
const URL_DROPPED = /[\t\n\r]/g;

/** C0 controls and spaces at either end, which a URL parser strips (`\x01javascript:`). */
const URL_EDGES = /^[\u0000- ]+|[\u0000- ]+$/g;

/** A scheme, as a URL parser reads one. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** `raw` as a browser would read it as an address, or null when it is not a string or too long. */
function addressText(raw) {
  if (typeof raw !== 'string' || raw.length > INPUT_MAX) return null;
  return raw.replace(URL_DROPPED, '').replace(URL_EDGES, '');
}

/** `text` with its percent-escapes decoded once; null when they are not valid. */
function decodeOnce(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** The address a placeholder shows for `text`: cleaned and cut. */
function shownAddress(text) {
  return typeof text === 'string' ? displayText(text.slice(0, INPUT_MAX), SHOWN_MAX) : '';
}

/**
 * The file a relative address in the Markdown file `filePath` names, when it
 * lies inside the open folder `root`; null otherwise. Its query and fragment
 * are dropped, its percent-escapes decoded once, a backslash read as a
 * separator (Windows), its `.` and `..` worked out by spelling, as the
 * backend works them out (`collapseDots`). The answer is written with the
 * root's separator. The backend confines again on every read.
 *
 * Never a file: an absolute path, `//host` or `\\host`, a drive (`C:`), a
 * colon before the first separator (a scheme that did not parse), a control
 * character, a folder by its spelling (`docs/`, `./`, `..`), anything that
 * leaves the folder, and the folder itself.
 */
function fileInside(value, filePath, root) {
  if (typeof filePath !== 'string' || !filePath || typeof root !== 'string' || !root) return null;
  const decoded = decodeOnce(value.replace(/[?#][\s\S]*$/, ''));
  if (!decoded || /\p{Cc}/u.test(decoded)) return null;
  const relative = decoded.replace(/\\/g, '/');
  if (relative.startsWith('/') || /^[^/]*:/.test(relative) || /(?:^|\/)\.{0,2}$/.test(relative)) return null;
  const target = collapseDots(join(toPosix(dirname(filePath)), relative));
  return isInside(root, target) ? withSepOf(target, root) : null;
}

/**
 * Where a link in the Markdown file `filePath` goes, the open folder being
 * `root` (null: none):
 *
 *   { kind: 'external', address, label }  http or https: `address` is what
 *       `openExternal` is handed (`addressToOpen`), `label` what the
 *       confirmation shows (`hyperlinkTitle`: parsed, no user name, the
 *       whole origin and the rest cut) — only for a host of at most
 *       MARKDOWN_MAX_LINK_HOST characters, so the origin always shows whole;
 *   { kind: 'anchor', id, href }  `#x`: the heading id it names (`#Install`
 *       and `#install` are `md-install`), and '#md-install'; both null for
 *       a fragment that names none;
 *   { kind: 'file', path }  a relative path inside the folder (`fileInside`)
 *       — a `.md` among them opens its source, like any file;
 *   { kind: 'inert' }  everything else, shown as text with no href:
 *       `javascript:` in any case and with tab, line break or control
 *       characters in or before it, `data:`, `vbscript:`, `file:`,
 *       `mailto:`, any other scheme, `//host`, absolute paths, paths out of
 *       the folder, an empty address, an address longer than 16 KiB, and an
 *       http or https address whose host is past MARKDOWN_MAX_LINK_HOST.
 */
export function classifyLink(url, { filePath = null, root = null, idPrefix = HEADING_ID_PREFIX } = {}) {
  const value = addressText(url);
  if (!value) return { kind: 'inert' };
  if (value.startsWith('#')) {
    const fragment = decodeOnce(value.slice(1));
    const slug = fragment === null ? '' : slugBase(fragment);
    const id = slug ? `${safePrefix(idPrefix)}${slug}` : null;
    return { kind: 'anchor', id, href: id ? `#${id}` : null };
  }
  const scheme = SCHEME.exec(value)?.[1].toLowerCase();
  if (scheme) {
    if ((scheme === 'http' || scheme === 'https') && isOpenable(value) && new URL(value).hostname.length <= MARKDOWN_MAX_LINK_HOST) {
      return { kind: 'external', address: addressToOpen(value), label: hyperlinkTitle(value) };
    }
    return { kind: 'inert' };
  }
  const path = fileInside(value, filePath, root);
  return path ? { kind: 'file', path } : { kind: 'inert' };
}

/**
 * Where an image in the Markdown file `filePath` comes from, the open folder
 * being `root`:
 *
 *   { kind: 'load', path, address }  a relative path, resolved against the
 *       Markdown file's folder, that lands inside the open folder: read
 *       with fs_read_image (which confines again) and shown from a data: URI;
 *   { kind: 'placeholder', reason, address }  never read, a placeholder
 *       showing `address` (cleaned, cut at 300 characters) — `reason` is
 *       'remote' (http, https, `//host`: never fetched), 'outside' (an
 *       absolute path, `file:`, a path that leaves the folder, no folder
 *       open) or 'unsupported' (`data:`, any other scheme, `#…`, nothing).
 */
export function classifyImageSource(url, { filePath = null, root = null } = {}) {
  const value = addressText(url);
  const placeholder = (reason, shown = value ?? url) => ({ kind: 'placeholder', reason, address: shownAddress(shown) });
  if (!value || value.startsWith('#')) return placeholder('unsupported');
  const scheme = SCHEME.exec(value)?.[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return placeholder('remote', hyperlinkTitle(value) ?? value);
  if (scheme === 'file') return placeholder('outside');
  if (scheme) return placeholder('unsupported');
  if (/^[\\/]{2}/.test(value)) return placeholder('remote');
  const path = fileInside(value, filePath, root);
  return path ? { kind: 'load', path, address: shownAddress(value) } : placeholder('outside');
}

/* ----------------------------------------------------------- the images */

/**
 * Which images of one document are read: `sources` as `classifyImageSource`
 * gives them, in document order; `sizes` a Map from path to the size the
 * backend reported (`fs_file_size`). Walking in order, a 'load' image is
 * read unless
 *   - MARKDOWN_MAX_IMAGES images are already shown ('count'; every image
 *     counts, the same file twice is two images),
 *   - its size is not known ('unknown-size'),
 *   - it is past the backend's own limit, IMAGE_MAX_BYTES ('too-large'),
 *   - its bytes would take the document past MARKDOWN_MAX_IMAGE_BYTES
 *     ('bytes'; a file shown twice is read, and counted, once);
 * and then it becomes a placeholder with that reason. Placeholders stay
 * placeholders. Answers `{ images, reads, bytes }`: `images` in the order of
 * `sources`, `reads` the distinct paths to read, `bytes` their total.
 */
export function planImageLoads(sources, sizes) {
  const known = sizes instanceof Map ? sizes : new Map();
  const reads = [];
  const read = new Set();
  let shown = 0;
  let bytes = 0;
  const images = (Array.isArray(sources) ? sources : []).map((source) => {
    if (!source || source.kind !== 'load') return source;
    const refuse = (reason) => ({ kind: 'placeholder', reason, address: source.address ?? '' });
    if (shown >= MARKDOWN_MAX_IMAGES) return refuse('count');
    const size = known.get(source.path);
    if (!Number.isSafeInteger(size) || size < 0) return refuse('unknown-size');
    if (size > IMAGE_MAX_BYTES) return refuse('too-large');
    const cost = read.has(source.path) ? 0 : size;
    if (bytes + cost > MARKDOWN_MAX_IMAGE_BYTES) return refuse('bytes');
    shown += 1;
    bytes += cost;
    if (!read.has(source.path)) {
      read.add(source.path);
      reads.push(source.path);
    }
    return source;
  });
  return { images, reads, bytes };
}

/**
 * `read(path, index)` for every path, never more than
 * MARKDOWN_IMAGE_READS_AT_ONCE at once, starting them in order. Resolves to
 * one result per path, in order: `{ status: 'fulfilled', value }`,
 * `{ status: 'rejected', reason }`, or `{ status: 'cancelled' }` for one
 * never started because `signal` was aborted first.
 */
export async function mapImageReads(paths, read, { signal } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const results = list.map(() => ({ status: 'cancelled' }));
  let next = 0;
  const lane = async () => {
    while (next < list.length && !signal?.aborted) {
      const at = next;
      next += 1;
      try {
        results[at] = { status: 'fulfilled', value: await read(list[at], at) };
      } catch (reason) {
        results[at] = { status: 'rejected', reason };
      }
    }
  };
  const lanes = Math.min(MARKDOWN_IMAGE_READS_AT_ONCE, list.length);
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/**
 * The image reads of one mounted preview, shared by all its rounds — a new
 * document, a change on disk — so that rounds never stack: `read(path)` runs
 * at most once at a time for a path, and never more than `limit`
 * (MARKDOWN_IMAGE_READS_AT_ONCE) at once in all, however many rounds ask. A
 * read already sent cannot be called back: one that nobody waits for any
 * more still counts until it settles, and its answer goes to nobody.
 *
 *   const reads = createImageReads(read);
 *   const answer = await reads.get(path, signal);
 *
 * `get` resolves — it never rejects — to `{ status: 'fulfilled', value }`,
 * `{ status: 'rejected', reason }`, `{ status: 'cancelled' }` when `signal`
 * was aborted before the answer came, or `{ status: 'stale' }` (below).
 * Asked for a path whose read is in flight, it waits for that read and
 * shares its answer — unless `staleWhere` marked that read after it started
 * (the file changed on disk meanwhile): then a new read of the path waits
 * for the old one to settle and starts after it, and those who asked before
 * the mark get `{ status: 'stale' }` when the old one settles, never its
 * answer, which may hold the file as it was or half written (reviewer C3
 * R1). A read nobody waits for any more is never started. Reads start in
 * the order they were asked.
 */
export function createImageReads(read, { limit = MARKDOWN_IMAGE_READS_AT_ONCE } = {}) {
  const most = Number.isSafeInteger(limit) && limit > 0 ? limit : MARKDOWN_IMAGE_READS_AT_ONCE;
  /** The newest request for each path: { path, waiters, started, stale }. */
  const newest = new Map();
  /** The requests not started yet, in the order asked. */
  const queue = [];
  /** The paths whose read is out, stale or not: one at most for each path. */
  const running = new Set();

  const pump = () => {
    for (let i = 0; i < queue.length && running.size < most;) {
      const request = queue[i];
      // A stale read of the path is still out: this one starts after it.
      if (running.has(request.path)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      start(request);
    }
  };

  const settle = (request, answer) => {
    running.delete(request.path);
    if (newest.get(request.path) === request) newest.delete(request.path);
    const waiters = [...request.waiters];
    request.waiters.clear();
    // Marked stale while it was out: what it read is kept by nobody.
    const given = request.stale ? { status: 'stale' } : answer;
    for (const resolve of waiters) resolve(given);
    pump();
  };

  const start = (request) => {
    request.started = true;
    running.add(request.path);
    let pending;
    try {
      pending = Promise.resolve(read(request.path));
    } catch (reason) {
      pending = Promise.reject(reason);
    }
    pending.then(
      (value) => settle(request, { status: 'fulfilled', value }),
      (reason) => settle(request, { status: 'rejected', reason })
    );
  };

  /** A request nobody waits for: forgotten, unless its read is out already. */
  const drop = (request) => {
    if (request.started) return;
    const at = queue.indexOf(request);
    if (at >= 0) queue.splice(at, 1);
    if (newest.get(request.path) === request) newest.delete(request.path);
  };

  return {
    /** The answer for `path` (see above), until `signal` is aborted. */
    get(path, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve({ status: 'cancelled' });
          return;
        }
        let request = newest.get(path);
        if (!request || request.stale) {
          request = { path, waiters: new Set(), started: false, stale: false };
          newest.set(path, request);
          queue.push(request);
        }
        const waiter = (answer) => resolve(answer);
        request.waiters.add(waiter);
        signal?.addEventListener(
          'abort',
          () => {
            if (!request.waiters.delete(waiter)) return;
            resolve({ status: 'cancelled' });
            if (request.waiters.size === 0) drop(request);
          },
          { once: true }
        );
        pump();
      });
    },
    /** Marks every read out now whose path `changed(path)` says changed; whether there was one. */
    staleWhere(changed) {
      let any = false;
      for (const request of newest.values()) {
        if (request.started && !request.stale && changed(request.path)) {
          request.stale = true;
          any = true;
        }
      }
      return any;
    },
    /** How many reads are out now, stale ones and ones nobody waits for included. */
    get running() {
      return running.size;
    },
  };
}

/* ------------------------------------------------------------- headings */

/** `prefix` when it is ASCII-safe (`a-z0-9-`, starting with a letter), else HEADING_ID_PREFIX. */
function safePrefix(prefix) {
  return typeof prefix === 'string' && /^[a-z][a-z0-9-]*$/.test(prefix) ? prefix : HEADING_ID_PREFIX;
}

/**
 * The slug `text` gives, before it is made unique: lower case; a-z and 0-9
 * kept; white space, '-' and '_' a '-'; a letter or digit outside ASCII
 * written as 'u' and its code point in hex, so '설치' is 'uc124-uce58'; any
 * other character dropped (as GitHub drops punctuation, so "What's new?"
 * and `#whats-new` meet); runs of '-' as one, none at either end, at most
 * 64 characters. '' when nothing is left. A link's `#fragment` goes through
 * the same steps, which is how it finds its heading.
 */
export function slugBase(text) {
  if (typeof text !== 'string') return '';
  let out = '';
  for (const char of text.slice(0, SLUG_INPUT_MAX).toLowerCase()) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) out += char;
    else if (char === '-' || char === '_' || /^\s$/u.test(char)) out += '-';
    else if (/^[\p{L}\p{N}]$/u.test(char)) out += `-u${char.codePointAt(0).toString(16)}-`;
    if (out.length > SLUG_MAX * 2) break;
  }
  return out.replace(/-+/g, '-').replace(/^-/, '').slice(0, SLUG_MAX).replace(/-$/, '');
}

/**
 * A function giving each heading text, in document order, its id: the
 * prefix and its slug; HEADING_SLUG_FALLBACK when the slug is empty; the
 * second of a slug '-1', the third '-2' — and never one already given, so
 * "Foo", "Foo", "Foo 1" are md-foo, md-foo-1, md-foo-1-1.
 */
export function createHeadingIds(idPrefix = HEADING_ID_PREFIX) {
  const prefix = safePrefix(idPrefix);
  const given = new Set();
  const last = new Map();
  return (text) => {
    const base = slugBase(text) || HEADING_SLUG_FALLBACK;
    let n = last.get(base) ?? 0;
    let slug = n === 0 ? base : `${base}-${n}`;
    while (given.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    last.set(base, n);
    given.add(slug);
    return `${prefix}${slug}`;
  };
}

/* ------------------------------------------------- the source, bounded */

/** The length of the container marker at `at` in `text`, before `end`; 0 when there is none. */
function markerAt(text, at, end) {
  const char = text[at];
  const spaced = (next) => next >= end || text[next] === ' ' || text[next] === '\t';
  if (char === '>') return 1;
  if (char === '-' || char === '+' || char === '*') return spaced(at + 1) ? 1 : 0;
  let digits = at;
  while (digits < end && digits - at < 9 && text[digits] >= '0' && text[digits] <= '9') digits += 1;
  if (digits === at || digits >= end || (text[digits] !== '.' && text[digits] !== ')')) return 0;
  return spaced(digits + 1) ? digits + 1 - at : 0;
}

/** The columns of the white space run from `at`, and where it ends. */
function spaceRun(text, at, end) {
  let columns = 0;
  let to = at;
  while (to < end && (text[to] === ' ' || text[to] === '\t')) {
    columns += text[to] === '\t' ? 4 : 1;
    to += 1;
  }
  return { columns, to };
}

/** The first characters a container prefix can start with. */
const PREFIX_START = /[ \t>\-+*0-9]/;

/**
 * The line `text[start, end)` with its container prefix cut back to
 * MARKDOWN_MAX_PREFIX_MARKERS markers and MARKDOWN_MAX_PREFIX_COLUMNS columns
 * of white space, or null when it is within both (left exactly as it was).
 */
function boundedLine(text, start, end) {
  if (start >= end || !PREFIX_START.test(text[start])) return null;
  let markers = 0;
  let columns = 0;
  let at = start;
  let prefixEnd = start;
  for (;;) {
    const run = spaceRun(text, at, end);
    const marker = run.to < end ? markerAt(text, run.to, end) : 0;
    if (!marker) break;
    markers += 1;
    columns += run.columns;
    at = run.to + marker;
    prefixEnd = at;
  }
  if (markers <= MARKDOWN_MAX_PREFIX_MARKERS && columns <= MARKDOWN_MAX_PREFIX_COLUMNS) return null;
  let kept = '';
  let budget = MARKDOWN_MAX_PREFIX_COLUMNS;
  at = start;
  for (let n = 0; n < MARKDOWN_MAX_PREFIX_MARKERS && at < prefixEnd; n += 1) {
    const run = spaceRun(text, at, prefixEnd);
    const marker = markerAt(text, run.to, end);
    // Two markers keep a space between them, or `- -` would read as `--`.
    const room = run.columns === 0 ? 0 : Math.max(1, Math.min(run.columns, budget));
    budget = Math.max(0, budget - room);
    kept += ' '.repeat(room) + text.slice(run.to, run.to + marker);
    at = run.to + marker;
  }
  return kept + text.slice(prefixEnd, end);
}

/**
 * `text` as the preview hands it to the parser: every line whose container
 * prefix nests past the bounds (`boundedLine`) cut back to them, the rest of
 * the line kept; every other line exactly as it was. `flattened` says
 * whether any line was cut. Linear in the length of `text`.
 *
 * Without it, a few kilobytes of `>` overflow the parser's stack before any
 * plugin sees a tree, and a deep list or quote parses in time growing with
 * the square of its depth. The bound is wide enough that no document a
 * person writes meets it; a line in a code block that does is cut like any
 * other.
 */
export function boundMarkdownSource(text) {
  if (typeof text !== 'string') return { text: '', flattened: false };
  const pieces = [];
  let copied = 0;
  let start = 0;
  while (start <= text.length) {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
    const line = boundedLine(text, start, end);
    if (line !== null) {
      pieces.push(text.slice(copied, start), line);
      copied = end;
    }
    start = end + 1;
  }
  if (pieces.length === 0) return { text, flattened: false };
  pieces.push(text.slice(copied));
  return { text: pieces.join(''), flattened: true };
}

/* -------------------------------------------------------- the tree model */

/**
 * The text of `node` and everything under it, in order — text, code and
 * raw HTML as written, an image as its alt, a space before each block —
 * walked with a stack of its own, however deep.
 */
function textOf(node) {
  let out = '';
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== node && BLOCK_NODES.has(current.type)) out += ' ';
    if (current.type === 'image' || current.type === 'imageReference') out += typeof current.alt === 'string' ? current.alt : '';
    else if (current.type === 'break') out += ' ';
    else if (typeof current.value === 'string') out += current.value;
    if (Array.isArray(current.children)) {
      for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
    }
  }
  return out;
}

/** Whether every child of `node` is a leaf. */
function childrenAreLeaves(node) {
  return node.children.every((child) => !Array.isArray(child.children) || child.children.length === 0);
}

/**
 * Flattens `tree` below MARKDOWN_MAX_DEPTH: a quote, list item or footnote
 * that deep keeps one paragraph of its text, a paragraph, heading, cell,
 * emphasis or link one text — cleaned, and with no link, image or element
 * left in it. Lists, tables and rows are walked through, as their items and
 * cells can be flattened. At any depth, a paragraph, heading, cell, emphasis
 * or link keeps MARKDOWN_MAX_CHILDREN children, the last of them one text
 * of all the rest. Answers how many nodes were flattened. A stack of its
 * own, never recursion: the depth is whatever the file made it.
 */
function flattenDeep(tree) {
  let flattened = 0;
  const stack = [[tree, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (!Array.isArray(node.children) || node.children.length === 0) continue;
    const flow = FLOW_PARENTS.has(node.type);
    if (depth >= MARKDOWN_MAX_DEPTH && (flow || PHRASING_PARENTS.has(node.type)) && !childrenAreLeaves(node)) {
      const text = cleanInlineText(textOf(node)).trim();
      const leaf = { type: 'text', value: text };
      node.children = !text ? [] : flow ? [{ type: 'paragraph', children: [leaf] }] : [leaf];
      flattened += 1;
      continue;
    }
    if (PHRASING_PARENTS.has(node.type) && node.children.length > MARKDOWN_MAX_CHILDREN) {
      const rest = { type: 'paragraph', children: node.children.slice(MARKDOWN_MAX_CHILDREN - 1) };
      node.children = [...node.children.slice(0, MARKDOWN_MAX_CHILDREN - 1), { type: 'text', value: cleanInlineText(textOf(rest)) }];
      flattened += 1;
    }
    for (const child of node.children) stack.push([child, depth + 1]);
  }
  return flattened;
}

/** The node raw HTML `value` is shown as: literal text in a dimmed span (inline) or div (block). */
function literalHtml(value, block) {
  const hChildren = [{ type: 'text', value }];
  const hProperties = { className: [RAW_HTML_CLASS], dataRawHtml: block ? 'block' : 'inline' };
  return block
    ? { type: 'paragraph', children: [], data: { hName: 'div', hProperties, hChildren } }
    : { type: 'text', value, data: { hName: 'span', hProperties, hChildren } };
}

/** `node.data.hProperties` with `properties` added. */
function setProperties(node, properties) {
  node.data = { ...(node.data ?? {}), hProperties: { ...(node.data?.hProperties ?? {}), ...properties } };
}

/** A link or image reference resolved through its definition, in place: a link or an image. */
function resolveReference(node, definitions) {
  const definition = definitions.get(node.identifier);
  if (!definition) return false;
  node.type = node.type === 'linkReference' ? 'link' : 'image';
  node.url = definition.url;
  node.title = definition.title ?? null;
  delete node.identifier;
  delete node.label;
  delete node.referenceType;
  return true;
}

/**
 * Makes the mdast `tree` of the Markdown file `filePath` safe to draw, in
 * place (see the top of this file): flattened below MARKDOWN_MAX_DEPTH, raw
 * HTML as literal text, references resolved, links and images classified,
 * heading ids given, heading and link text, titles and alt cleaned. Answers
 * `{ flattened, images }`: how many nodes were flattened, and every image's
 * source in document order (`classifyImageSource`, with its `index`).
 */
export function modelMarkdownTree(tree, { filePath = null, root = null, idPrefix = HEADING_ID_PREFIX } = {}) {
  const images = [];
  if (!tree || !Array.isArray(tree.children)) return { flattened: 0, images };
  const flattened = flattenDeep(tree);
  const context = { filePath, root, idPrefix: safePrefix(idPrefix) };
  const headingId = createHeadingIds(context.idPrefix);
  let footnoteReferences = 0;

  const definitions = new Map();
  const all = [tree];
  while (all.length > 0) {
    const node = all.pop();
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i -= 1) all.push(node.children[i]);
  }

  // Document order, with whether a node sits in a heading or a link.
  // Each entry names its node by parent and index, read when it is taken, so
  // that a node replaced in its parent is seen as what replaced it.
  const stack = [{ parent: null, index: -1, clean: false }];
  while (stack.length > 0) {
    const { parent, index, clean } = stack.pop();
    const node = parent ? parent.children[index] : tree;
    if (node.type === 'html') {
      const literal = literalHtml(clean ? cleanInlineText(node.value) : String(node.value ?? ''), FLOW_PARENTS.has(parent?.type));
      parent.children[index] = literal;
      continue;
    }
    if (node.type === 'footnoteReference') {
      footnoteReferences += 1;
      if (footnoteReferences > MARKDOWN_MAX_FOOTNOTE_REFERENCES) {
        parent.children[index] = { type: 'text', value: cleanInlineText(`[^${String(node.label ?? node.identifier ?? '')}]`) };
        continue;
      }
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') resolveReference(node, definitions);
    if (clean && (node.type === 'text' || node.type === 'inlineCode')) node.value = cleanInlineText(node.value);
    if (node.type === 'heading') setProperties(node, { id: headingId(cleanInlineText(textOf(node))) });
    if (node.type === 'link') {
      const link = classifyLink(node.url, context);
      const target = link.kind === 'external' ? link.address : link.kind === 'anchor' ? link.id : link.kind === 'file' ? link.path : null;
      node.url = link.kind === 'anchor' && link.href ? link.href : '';
      if (node.title != null) node.title = cleanShown(node.title) || null;
      setProperties(node, target ? { dataLink: link.kind, dataTarget: target } : { dataLink: link.kind });
    }
    if (node.type === 'image') {
      const source = { ...classifyImageSource(node.url, context), index: images.length };
      images.push(source);
      node.url = '';
      node.alt = cleanShown(node.alt);
      if (node.title != null) node.title = cleanShown(node.title) || null;
      const shown = source.kind === 'placeholder' ? { dataAddress: source.address } : {};
      setProperties(node, { dataImage: source.kind, dataImageIndex: source.index, ...shown });
    }
    if (Array.isArray(node.children)) {
      const inside = clean || node.type === 'heading' || node.type === 'link' || node.type === 'linkReference';
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push({ parent: node, index: i, clean: inside });
    }
  }
  return { flattened, images };
}

/**
 * The remark plugin the preview runs last, after remark-gfm:
 * `[remarkMarkdownPreview, { filePath, root, onImages }]`. It runs
 * `modelMarkdownTree` over the tree, then hands `onImages` the images in
 * document order.
 */
export function remarkMarkdownPreview(options = {}) {
  const { onImages, ...context } = options ?? {};
  return (tree) => {
    const { images } = modelMarkdownTree(tree, context);
    if (typeof onImages === 'function') onImages(images);
  };
}

/** Characters no same-document address holds: white space and controls. */
const NOT_IN_ANCHOR = /[\s\p{Cc}]/u;

/**
 * react-markdown's `urlTransform` for the preview: the URL an element's
 * `key` attribute keeps — only an `<a>`'s `href` that stays in the document
 * (`#…`, as the plugin writes for an anchor and GFM for a footnote), and only
 * when the plugin did not call the link something else. Everything else,
 * every image's `src` included, is null: no attribute at all. The preview
 * reads where a link goes from `data-link` and `data-target`, and draws an
 * image from a data: URI of its own.
 */
export function markdownUrlTransform(value, key, node) {
  if (key !== 'href' || node?.tagName !== 'a' || typeof value !== 'string') return null;
  const kind = node.properties?.dataLink;
  if (kind !== undefined && kind !== 'anchor') return null;
  if (!value.startsWith('#') || value.length > INPUT_MAX || NOT_IN_ANCHOR.test(value)) return null;
  return value;
}
