/**
 * A Markdown preview tab (Orca bundle 5, B3): Markdown text in, a safe hast
 * tree out — the half of react-markdown that parses, run in the Markdown
 * worker (markdownWorker.js) and never on the window's thread (OQ-B3g,
 * 2026-11-24). The window draws what comes out with hast-util-to-jsx-runtime
 * (MarkdownPreview.jsx, step P7), as react-markdown's own `Markdown` does
 * after its `post` step.
 *
 * The parser (micromark, under remark-parse) takes seconds to minutes on a
 * few hundred kilobytes of hostile text, before any plugin runs; the worker
 * is stopped when it does not answer in time (markdownRenderClient.js).
 *
 * The one module in src/ that imports unified, remark-parse, remark-gfm or
 * remark-rehype, and only markdownWorker.js imports it (MW-40, WV-06b). Pure:
 * it runs in Node as well, which is how it is tested.
 *
 *   markdownToHast(text, { filePath, root }) → { hast, images }, in order:
 *     1. past MARKDOWN_PREVIEW_MAX_BYTES (UTF-8) it throws a RangeError
 *        whose message is `markdownTooLargeText(bytes)`;
 *     2. `boundMarkdownSource(text).text` is what is parsed;
 *     3. unified → remark-parse → remark-gfm → remarkMarkdownPreview (the P6
 *        plugin: raw HTML as literal text, links and images classified,
 *        heading ids, nesting flattened) → remark-rehype, never with
 *        `allowDangerousHtml`;
 *     4. `safeHast`: the URL rule and an allow-list, by hand. react-markdown's
 *        `post` reads its URL attributes from html-url-attributes; this
 *        keeps only what the preview draws instead (below), so an attribute
 *        nobody listed never reaches the markup, whatever put it there.
 *        Past MARKDOWN_MAX_ELEMENTS elements it stops building and throws a
 *        RangeError named MARKDOWN_TOO_COMPLEX_ERROR: the window's thread
 *        would take too long to draw the tree (the preview says "Too complex
 *        to preview", as for the time limit).
 *
 *   `hast` is plain data (root, element and text nodes; no `position`, no
 *   `data`), so it crosses `postMessage` as it is; `images` is what the
 *   plugin's `onImages` gave, every image in document order.
 *
 * THE ALLOW-LIST (SAFE_ELEMENTS, `keepProperties`)
 *
 *   Elements: those remark-rehype makes from CommonMark and GFM — a,
 *   blockquote, br, code, del, em, h1–h6, hr, img, input, li, ol, p, pre,
 *   section, strong, sup, table, tbody, td, th, thead, tr, ul — and the
 *   plugin's span and div for raw HTML. Any other element is its text. A
 *   `raw` node is literal text in the plugin's span; any other node is the
 *   text and raw values under it, or nothing (a comment or doctype has none).
 *
 *   Properties, everything else dropped:
 *     every element  className — only the names remark-rehype and the plugin
 *                    give (CLASS_NAMES, `language-<word>`);
 *                    id — only 'md-…' (headings), 'user-content-…' (GFM
 *                    footnotes) and 'footnote-label';
 *     a              href — only through `markdownUrlTransform`: a `#…` that
 *                    is an anchor or a GFM footnote link, never anything else;
 *                    title; dataLink, dataTarget; dataFootnoteRef,
 *                    dataFootnoteBackref, ariaDescribedBy, ariaLabel;
 *     img            alt, title, dataImage, dataImageIndex, dataAddress —
 *                    never src;
 *     input          type 'checkbox' only (any other input is dropped),
 *                    checked, and disabled — always true;
 *     ol             start;   th, td  align (left, right, center);
 *     section        dataFootnotes;   span, div  dataRawHtml.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import {
  MARKDOWN_MAX_ELEMENTS,
  MARKDOWN_TOO_COMPLEX_ERROR,
  RAW_HTML_CLASS,
  boundMarkdownSource,
  isMarkdownTooLarge,
  markdownTooLargeText,
  markdownUrlTransform,
  remarkMarkdownPreview,
} from './markdownPreview.js';

/** The elements the preview draws (see the top of this file). Any other is flattened to its text. */
export const SAFE_ELEMENTS = Object.freeze([
  'a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'input',
  'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

/** The class names an element keeps: remark-rehype's (task lists, footnotes) and the plugin's. */
export const CLASS_NAMES = Object.freeze([
  RAW_HTML_CLASS, 'task-list-item', 'contains-task-list', 'footnotes', 'sr-only', 'data-footnote-backref',
]);

const ELEMENTS = new Set(SAFE_ELEMENTS);
const CLASSES = new Set(CLASS_NAMES);

/** Elements that hold nothing: their children, if any, are dropped. */
const VOID = new Set(['br', 'hr', 'img', 'input']);

/** A code block's language class (```` ```js ````): one word, as remark-rehype writes it. */
const LANGUAGE_CLASS = /^language-[A-Za-z0-9_+#.-]{1,64}$/;

/** The ids a hast element keeps: a heading's 'md-…', a GFM footnote's 'user-content-…', the footnote label. */
const SAFE_ID = /^(?:md-[a-z0-9-]{1,160}|user-content-[^\s\p{Cc}]{1,4096}|footnote-label)$/u;

/** The longest title, alt, label or shown address kept (the plugin cuts them at 300 already). */
const TEXT_MAX = 1024;

/** The longest data-target kept: an address or path the plugin classified (it looks at 16 KiB). */
const TARGET_MAX = 16_384 + 1024;

const LINK_KINDS = new Set(['external', 'anchor', 'file', 'inert']);
const IMAGE_KINDS = new Set(['load', 'placeholder']);
const RAW_KINDS = new Set(['inline', 'block']);
const ALIGNS = new Set(['left', 'right', 'center']);

/** A string no longer than `max`, else undefined. */
const shortText = (max) => (value) => (typeof value === 'string' && value.length <= max ? value : undefined);
/** One of `allowed`, else undefined. */
const oneOf = (allowed) => (value) => (allowed.has(value) ? value : undefined);
/** `true` for a set flag (GFM writes `true` or ''), else undefined. */
const flag = (value) => (value === true || value === '' ? value : undefined);

/** Per element, the properties it keeps besides className and id, each with its check. */
const PROPERTIES = {
  a: {
    title: shortText(TEXT_MAX),
    dataLink: oneOf(LINK_KINDS),
    dataTarget: shortText(TARGET_MAX),
    dataFootnoteRef: flag,
    dataFootnoteBackref: flag,
    ariaDescribedBy: (value) => (Array.isArray(value) && value.length <= 4 && value.every((id) => typeof id === 'string' && SAFE_ID.test(id)) ? [...value] : undefined),
    ariaLabel: shortText(TEXT_MAX),
  },
  img: {
    alt: shortText(TEXT_MAX),
    title: shortText(TEXT_MAX),
    dataImage: oneOf(IMAGE_KINDS),
    dataImageIndex: (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined),
    dataAddress: shortText(TEXT_MAX),
  },
  input: {
    type: (value) => (value === 'checkbox' ? value : undefined),
    checked: (value) => (typeof value === 'boolean' ? value : undefined),
  },
  ol: { start: (value) => (Number.isSafeInteger(value) ? value : undefined) },
  th: { align: oneOf(ALIGNS) },
  td: { align: oneOf(ALIGNS) },
  section: { dataFootnotes: flag },
  span: { dataRawHtml: oneOf(RAW_KINDS) },
  div: { dataRawHtml: oneOf(RAW_KINDS) },
};

/** UTF-8 bytes of `text`, counted as an encoder would (a lone surrogate is three), without encoding it. */
function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The text of a hast node and everything under it, in order, with a stack of its own. */
function hastText(node) {
  let out = '';
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if ((current?.type === 'text' || current?.type === 'raw') && typeof current.value === 'string') out += current.value;
    if (Array.isArray(current?.children)) for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
  }
  return out;
}

/** The literal-text node raw HTML is drawn as: the plugin's span (markdownPreview.js `literalHtml`). */
function literalRaw(value) {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: [RAW_HTML_CLASS], dataRawHtml: 'inline' },
    children: [{ type: 'text', value }],
  };
}

/**
 * The properties element `tagName` keeps of `properties` (see the top of
 * this file): a new object, nothing else copied. `href` last, through
 * `markdownUrlTransform`, which reads the kept `dataLink`.
 */
function keepProperties(tagName, properties) {
  const from = properties && typeof properties === 'object' ? properties : {};
  const kept = {};
  if (Array.isArray(from.className)) {
    const names = from.className.filter((name) => typeof name === 'string' && (CLASSES.has(name) || LANGUAGE_CLASS.test(name)));
    if (names.length > 0) kept.className = names;
  }
  if (typeof from.id === 'string' && SAFE_ID.test(from.id)) kept.id = from.id;
  const checks = PROPERTIES[tagName];
  if (checks) {
    for (const [key, check] of Object.entries(checks)) {
      if (!Object.hasOwn(from, key)) continue;
      const value = check(from[key]);
      if (value !== undefined) kept[key] = value;
    }
  }
  if (tagName === 'input') kept.disabled = true;
  if (tagName === 'a' && Object.hasOwn(from, 'href')) {
    const href = markdownUrlTransform(String(from.href ?? ''), 'href', { type: 'element', tagName, properties: kept });
    if (href !== null) kept.href = href;
  }
  return kept;
}

/**
 * The safe copy of one hast node, without its children: an element of
 * SAFE_ELEMENTS with `keepProperties`, a text, a literal span for `raw`, the
 * text under anything else (`hastText`: a comment's own value is not text),
 * or null for nothing.
 */
function safeNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'text') return { type: 'text', value: typeof node.value === 'string' ? node.value : '' };
  if (node.type === 'raw') return typeof node.value === 'string' && node.value ? literalRaw(node.value) : null;
  if (node.type === 'element' && ELEMENTS.has(node.tagName)) {
    if (node.tagName === 'input' && node.properties?.type !== 'checkbox') return null;
    return { type: 'element', tagName: node.tagName, properties: keepProperties(node.tagName, node.properties), children: [] };
  }
  const text = hastText(node);
  return text ? { type: 'text', value: text } : null;
}

/** What `safeHast` throws past `max` elements: a RangeError named MARKDOWN_TOO_COMPLEX_ERROR. */
function tooComplex(max) {
  const err = new RangeError(`The Markdown makes more than ${max} elements to draw`);
  err.name = MARKDOWN_TOO_COMPLEX_ERROR;
  return err;
}

/**
 * `tree` (hast, from remark-rehype) as the preview may draw it: a new tree of
 * the allow-listed elements and properties only (see the top of this file),
 * walked with a stack of its own. Plain data: no `position`, no `data`.
 * Every element it makes is counted, and past `maxElements`
 * (MARKDOWN_MAX_ELEMENTS) it stops and throws `tooComplex`.
 */
export function safeHast(tree, { maxElements = MARKDOWN_MAX_ELEMENTS } = {}) {
  const root = { type: 'root', children: [] };
  const stack = [{ from: tree, to: root }];
  let elements = 0;
  while (stack.length > 0) {
    const { from, to } = stack.pop();
    if (!Array.isArray(from?.children)) continue;
    for (const child of from.children) {
      const safe = safeNode(child);
      if (!safe) continue;
      if (safe.type === 'element') {
        elements += 1;
        if (elements > maxElements) throw tooComplex(maxElements);
      }
      to.children.push(safe);
      if (safe.type === 'element' && !VOID.has(safe.tagName)) stack.push({ from: child, to: safe });
    }
  }
  return root;
}

/**
 * The Markdown file `filePath` (in the open folder `root`, null: none) as the
 * preview draws it: `{ hast, images }` (see the top of this file). Throws a
 * RangeError past the 2 MB limit (`markdownTooLargeText`), one named
 * MARKDOWN_TOO_COMPLEX_ERROR past MARKDOWN_MAX_ELEMENTS (`safeHast`), a
 * TypeError for text that is not a string, and whatever the parser throws.
 */
export function markdownToHast(text, { filePath = null, root = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('The Markdown text is not a string');
  const bytes = utf8Bytes(text);
  if (isMarkdownTooLarge(bytes)) throw new RangeError(markdownTooLargeText(bytes));
  let images = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMarkdownPreview, { filePath, root, onImages: (list) => { images = list; } })
    .use(remarkRehype, { allowDangerousHtml: false });
  const tree = processor.runSync(processor.parse(boundMarkdownSource(text).text));
  return { hast: safeHast(tree), images: images.map((image) => ({ ...image })) };
}
