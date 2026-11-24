import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { useEditorStore } from '../../stores/editorStore.js';
import { invoke, listen } from '../../lib/ipc.js';
import { imageDataUri } from '../../lib/imagePreview.js';
import { hyperlinkTitle, openExternal } from '../../lib/openExternal.js';
import { basename, isInside, samePath } from '../../lib/paths.js';
import { displayText } from '../../lib/projectCommands.js';
import { MARKDOWN_MAX_IMAGES, createImageReads, hastPastElements, mapImageReads, markdownTooLargeText, planImageLoads } from '../../lib/markdownPreview.js';
import { createMarkdownRenderer } from '../../lib/markdownRenderClient.js';

/*
 * The body of a Markdown preview tab (Orca bundle 5, B3), drawn by
 * EditorPane.jsx in place of Monaco for a tab of kind 'markdown' — and, like
 * Monaco, loaded from there through `React.lazy`, so neither this nor the
 * renderer it draws with is part of the first chunk (WV-06b).
 *
 * The window never parses Markdown (OQ-B3g, 2026-11-24). The text goes to a
 * Web Worker (markdownRenderClient.js, markdownWorker.js), which answers
 * with a safe hast tree: only the elements and properties the preview draws,
 * raw HTML already turned into literal text, no `src` on any image and no
 * `href` but `#…` on any link. That tree is drawn here with
 * hast-util-to-jsx-runtime, as react-markdown's own component draws it —
 * never a tree past MARKDOWN_MAX_ELEMENTS, which the worker refuses to build
 * and which is counted again here before it is drawn (`drawableResult`) —
 * with two elements of our own:
 *
 *   a    by `data-link`: 'external' (http, https) asks first, in a NexTerm
 *        dialog showing the cleaned address, and only its Open hands the
 *        address to `openExternal`; 'anchor' and GFM's footnote links scroll
 *        to their id inside this preview; 'file' opens the file in the
 *        folder with `openFile`, without asking; anything else is text. No
 *        link can make the webview go anywhere: the only `href`s are `#…`,
 *        and their clicks are taken.
 *   img  only from a `data:` URI that `imageDataUri` built from what
 *        `fs_read_image` read — at most 4 reads at once, counted across
 *        every round of the preview, and never two of one path
 *        (`createImageReads`), within the document's count and byte limits
 *        (`planImageLoads`). Anything
 *        else, a remote image above all, is a dimmed box naming its
 *        address, and nothing is fetched. What was read is kept, by path,
 *        for as long as the preview is mounted (`newImageCache`): a new
 *        text — a keystroke in the source, 300 ms on — reads none of it
 *        again. A change on disk of an image's own path (`fs-change`,
 *        `forgetChangedImages`) has that one read again, the others drawn
 *        as they were; a change of a folder above images has their sizes
 *        asked again, and only one whose size changed, or that is gone, is
 *        read again.
 *
 * Markup is never written from a string anywhere in this file (RN-255).
 *
 * The worker's factory is imported when the preview mounts, not with this
 * module: its `?worker` import is Vite's alone, and Node, which the render
 * and mounted tests run in, cannot load it.
 */

/** How long a first render may take before the preview says it is rendering (STYLEGUIDE.md, In-flight feedback: from 1 s). */
export const RENDERING_NOTICE_MS = 1000;

/** What a preview whose parse passed the time limit says. */
export const TOO_COMPLEX_TEXT = 'Too complex to preview';

/** The longest address, alt or path a preview shows. */
const SHOWN_MAX = 300;

/** The longest error message a preview shows. */
const MESSAGE_MAX = 500;

/** The preview's renderer: one per mounted preview, with the Vite-built worker. */
async function createPreviewRenderer() {
  const { createMarkdownWorker } = await import('../../lib/markdownWorkerFactory.js');
  return createMarkdownRenderer({ createWorker: createMarkdownWorker });
}

/** `value` as shown: cleaned of control, bidi and invisible characters, and cut. */
function shown(value, max = SHOWN_MAX) {
  return typeof value === 'string' ? displayText(value, max) : '';
}

/**
 * The address an external link's confirmation and tooltip show, or '' when
 * it is no address to open: `hyperlinkTitle`'s, cleaned — the whole origin,
 * then the path, query and fragment cut with '…' to fit. Never cut again
 * here: the origin says where Open goes, so it always shows whole (a link
 * whose host is too long to show is inert, markdownPreview.js `classifyLink`).
 */
export function externalLinkLabel(address) {
  if (typeof address !== 'string' || !address) return '';
  let label = null;
  try {
    label = hyperlinkTitle(address);
  } catch {
    label = null;
  }
  return shown(label ?? '', Infinity);
}

/** `id` as a CSS string, for `[id="…"]`. */
function cssString(id) {
  if (typeof globalThis.CSS?.escape === 'function') return globalThis.CSS.escape(id);
  return id.replace(/["\\]/g, '\\$&');
}

/**
 * Scrolls the preview's scroller so that the element with `id` inside
 * `root` — this preview's document, never the page: two previews of one
 * file hold the same ids — is at its top. Only that scroller moves; nothing
 * navigates and nothing around the pane is scrolled.
 */
export function scrollToId(root, scroller, id) {
  if (!root || !scroller || typeof id !== 'string' || !id) return false;
  const target = root.querySelector(`[id="${cssString(id)}"]`);
  if (!target || typeof target.getBoundingClientRect !== 'function' || typeof scroller.getBoundingClientRect !== 'function') return false;
  const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) + offset);
  return true;
}

/* -------------------------------------------------------------- links */

/** What the links of a preview do: set by MarkdownPreview, nothing in a static render. */
const LinkContext = createContext(null);

/** Enter on a link that has no `href` (and so no native Enter): the same as a click. */
function onEnter(act) {
  return (e) => {
    // React's event has no isComposing: an Enter that ends an IME composition is the native event's.
    if (e.key !== 'Enter' || e.repeat || e.nativeEvent?.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    act(e);
  };
}

/** A link of the document (see the top of this file). Never an `href` but `#…`. */
function MarkdownLink(props) {
  const links = useContext(LinkContext);
  const { children } = props;
  const kind = props['data-link'];
  const target = typeof props['data-target'] === 'string' ? props['data-target'] : '';
  const href = typeof props.href === 'string' && props.href.length > 1 && props.href.startsWith('#') ? props.href : null;

  if (kind === 'external') {
    const label = externalLinkLabel(target);
    if (label) {
      const open = (e) => {
        e.preventDefault();
        links?.external(target, label);
      };
      return (
        <a data-link="external" role="link" tabIndex={0} title={label} className="md-link" onClick={open} onKeyDown={onEnter(open)}>
          {children}
        </a>
      );
    }
  }

  if (kind === 'file' && target) {
    const open = (e) => {
      e.preventDefault();
      links?.file(target);
    };
    return (
      <a data-link="file" role="link" tabIndex={0} title={shown(target)} className="md-link" onClick={open} onKeyDown={onEnter(open)}>
        {children}
      </a>
    );
  }

  // An anchor the plugin resolved, and GFM's footnote links, which carry no
  // `data-link` but a `#user-content-…` of their own.
  if (href && (kind === 'anchor' || kind === undefined)) {
    const id = kind === 'anchor' && target ? target : href.slice(1);
    const go = (e) => {
      e.preventDefault();
      links?.anchor(id);
    };
    return (
      <a
        data-link={kind === 'anchor' ? 'anchor' : undefined}
        href={href}
        id={props.id}
        title={typeof props.title === 'string' ? shown(props.title) || undefined : undefined}
        className={props.className ? `md-link ${props.className}` : 'md-link'}
        aria-describedby={props['aria-describedby']}
        aria-label={props['aria-label']}
        data-footnote-ref={props['data-footnote-ref']}
        data-footnote-backref={props['data-footnote-backref']}
        onClick={go}
        // A middle click opens nothing either.
        onAuxClick={(e) => e.preventDefault()}
      >
        {children}
      </a>
    );
  }

  // Inert: text, with no href, no handler and no place in the Tab order.
  return <span data-link="inert">{children}</span>;
}

/* ------------------------------------------------------------- images */

/**
 * What the images of a preview show: `{ list, plan, uris, failed }` — the
 * images as the worker listed them, the plan `planImageLoads` made from
 * the sizes known (`imageViewFrom`; null with no image to load), the data:
 * URIs read by path, and the paths whose read failed. Nothing read in a
 * static render.
 */
const ImageContext = createContext(null);

/** No image read, none planned: every 'load' image waits. */
const NO_IMAGES = Object.freeze({ list: [], plan: null, uris: new Map(), failed: new Set() });

/**
 * The image at `path`, read with fs_read_image: `{ uri, bytes }`, the data:
 * URI to draw it from (null when it is no image to show) and the bytes the
 * read brought in — the backend's count, or what the data holds when that
 * is more. A file that grew after its size was asked brings in more than
 * was planned for it (reviewer A2 R1).
 */
async function readImageUri(path) {
  const image = await invoke('fs_read_image', { path });
  const uri = imageDataUri(image);
  const told = Number.isSafeInteger(image?.bytes) && image.bytes >= 0 ? image.bytes : 0;
  if (!uri) return { uri: null, bytes: told };
  const data = image.data;
  const held = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  return { uri, bytes: Math.max(told, held) };
}

/**
 * What a preview has learned of its images, by path, while it is mounted:
 * `sizes` (what `fs_file_size` answered, or what a read brought in when
 * that was more; null when it would not), `uris` (the data: URI each read
 * made) and `failed` (the paths whose read failed). `recheck` holds the
 * paths whose size is to be asked again, a folder above them having
 * changed (`forgetChangedImages`): what was read of them stays until the
 * answer says otherwise (`learnSizes`). Only the paths of the document
 * drawn last are kept (`keepImagesOf`), and of those only the pictures its
 * last plan reads (`keepPlanned`), so it never holds more than the images
 * one document draws. `capped` holds the paths that plan left out for the
 * caps, with the reason. `reads` are its reads in flight
 * (`createImageReads`, with `read`), shared by every round: a round that
 * stops leaves its reads to the next one.
 */
export function newImageCache(read = readImageUri) {
  return { sizes: new Map(), uris: new Map(), failed: new Set(), recheck: new Set(), capped: new Map(), reads: createImageReads(read) };
}

/** The distinct local paths the images `list` load, the first MARKDOWN_MAX_IMAGES: the ones whose size is asked. */
function imagePathsOf(list) {
  const paths = list.filter((image) => image?.kind === 'load' && typeof image.path === 'string').map((image) => image.path);
  return [...new Set(paths)].slice(0, MARKDOWN_MAX_IMAGES);
}

/** What `cache` holds for no path in `paths` goes. */
function keepImagesOf(cache, paths) {
  const kept = new Set(paths);
  for (const path of [...cache.sizes.keys()]) if (!kept.has(path)) cache.sizes.delete(path);
  for (const path of [...cache.uris.keys()]) if (!kept.has(path)) cache.uris.delete(path);
  for (const path of [...cache.failed]) if (!kept.has(path)) cache.failed.delete(path);
  for (const path of [...cache.recheck]) if (!kept.has(path)) cache.recheck.delete(path);
  for (const path of [...cache.capped.keys()]) if (!kept.has(path)) cache.capped.delete(path);
}

/** The plan `planImageLoads` makes for the images `list` from the sizes `cache` knows of `paths`. */
function planFrom(cache, list, paths) {
  const sizes = new Map();
  for (const path of paths) if (Number.isFinite(cache.sizes.get(path))) sizes.set(path, cache.sizes.get(path));
  return planImageLoads(list, sizes);
}

/**
 * `plan`, made for the images `list` with every size known, is what the
 * preview draws now: a picture it does not read goes from `cache` — one an
 * earlier image's new size pushed past the caps is a box, and its data: URI
 * is not kept for it (reviewer A2 R1) — and the paths it left out for the
 * caps ('count', 'bytes') are kept in `capped`, with the reason, for
 * `imageViewFrom`.
 */
export function keepPlanned(cache, list, plan) {
  const reads = new Set(plan.reads);
  for (const path of [...cache.uris.keys()]) if (!reads.has(path)) cache.uris.delete(path);
  cache.capped.clear();
  plan.images.forEach((image, i) => {
    const path = list[i]?.kind === 'load' ? list[i].path : null;
    if (path && !reads.has(path) && image?.kind === 'placeholder' && (image.reason === 'count' || image.reason === 'bytes')) cache.capped.set(path, image.reason);
  });
}

/**
 * The `fs-change` kinds after which an image is looked at again: the ones the
 * watcher sends (src-tauri/src/fs/watcher.rs), a rename being a 'modify' of
 * both names. Not 'other': an access — on Linux, the preview's own read.
 */
const IMAGE_FOLLOWS = new Set(['modify', 'create', 'delete']);

/**
 * The watcher reported `payload` (`fs-change`, `{ path, kind }`). An image
 * at that very path is forgotten — its size, its picture, a failed read —
 * to be read again, and a read of it in flight is marked stale, so that its
 * answer is not kept. An image under that path — a folder renamed, written
 * into, deleted or made — keeps what it shows: its size is asked again
 * (`recheck`), and only an answer that differs, or none, has it read again
 * (`learnSizes`). Matched without regard to case or separators: a path
 * looked at that did not need to be only costs a read. Returns whether
 * anything went or is to be asked.
 */
export function forgetChangedImages(cache, payload) {
  const changed = typeof payload?.path === 'string' ? payload.path.toLowerCase() : '';
  if (!changed || !IMAGE_FOLLOWS.has(payload.kind)) return false;
  const own = (path) => samePath(path.toLowerCase(), changed);
  let gone = false;
  for (const map of [cache.sizes, cache.uris]) {
    for (const path of [...map.keys()]) {
      if (own(path)) gone = map.delete(path) || gone;
    }
  }
  for (const set of [cache.failed, cache.recheck]) {
    for (const path of [...set]) {
      if (own(path)) gone = set.delete(path) || gone;
    }
  }
  const stale = cache.reads?.staleWhere(own) ?? false;
  let recheck = false;
  for (const path of cache.sizes.keys()) {
    if (isInside(changed, path.toLowerCase()) && !cache.recheck.has(path)) {
      cache.recheck.add(path);
      recheck = true;
    }
  }
  return gone || stale || recheck;
}

/**
 * What `fs_file_size` answered for `paths` (`answers`, as `mapImageReads`
 * gives them), into `cache`. A path still to be sized takes its size, null
 * when there was none. A path asked again (`recheck`) whose size is the one
 * known keeps its picture, or its failed read; one whose size changed, or
 * that is gone, is forgotten but for the new size, and a read of it in
 * flight is marked stale (`staleWhere`): it is read again after that one
 * settles, never alongside it.
 */
export function learnSizes(cache, paths, answers) {
  paths.forEach((path, i) => {
    const answer = answers[i];
    const size = answer?.status === 'fulfilled' && Number.isFinite(answer.value) ? answer.value : null;
    if (cache.recheck.delete(path) && cache.sizes.has(path)) {
      if (cache.sizes.get(path) === size) return;
      cache.uris.delete(path);
      cache.failed.delete(path);
      cache.reads?.staleWhere((p) => p === path);
    }
    cache.sizes.set(path, size);
  });
}

/**
 * The images of `result` as `cache` knows them: the plan `planImageLoads`
 * makes from the sizes known, with the data: URIs read and the failed
 * reads. An image whose size is still to come waits, a box saying it is
 * loading, while every other is drawn as it was: the plan counts only the
 * sizes it has, so what it draws never passes MARKDOWN_MAX_IMAGES or
 * MARKDOWN_MAX_IMAGE_BYTES. Nothing is read from such a plan: a round reads
 * only once every size is in (see MarkdownPreview), so an image the caps
 * leave out once an earlier one's size is known — the 51st, the byte past
 * 50 MB — is never read, and turns into its box then. An image the last
 * full plan left out for the caps (`capped`) keeps that box, and its
 * reason, while the size of an image before it is still to come: it does
 * not turn into a loading box and back (reviewer B2 F5).
 */
export function imageViewFrom(cache, result) {
  if (result?.status !== 'ok') return NO_IMAGES;
  const list = Array.isArray(result.images) ? result.images : [];
  const paths = imagePathsOf(list);
  if (paths.length === 0) return NO_IMAGES;
  const plan = planFrom(cache, list, paths);
  let sizeToCome = false;
  const images = plan.images.map((image, i) => {
    const source = list[i];
    const path = source?.kind === 'load' ? source.path : null;
    let shown = image;
    // Refused for a size not known yet, rather than one the backend would not give: it waits.
    if (image?.kind === 'placeholder' && image.reason === 'unknown-size' && !cache.sizes.has(path)) shown = source;
    else if (sizeToCome && image?.kind === 'load' && cache.capped.has(path)) shown = { kind: 'placeholder', reason: cache.capped.get(path), address: source.address ?? '' };
    if (path && !cache.sizes.has(path)) sizeToCome = true;
    return shown;
  });
  const uris = new Map();
  const failed = new Set();
  for (const path of plan.reads) {
    if (cache.uris.has(path)) uris.set(path, cache.uris.get(path));
    else if (cache.failed.has(path)) failed.add(path);
  }
  return { list: [], plan: images, uris, failed };
}

/** An image of the document (see the top of this file): a data: URI picture, or a box naming it. */
function MarkdownImage(props) {
  const view = useContext(ImageContext) ?? NO_IMAGES;
  const alt = shown(props.alt);
  const index = Number(props['data-image-index']);
  const planned = props['data-image'] === 'load' && Number.isSafeInteger(index) && index >= 0 ? (view.plan?.[index] ?? null) : null;
  const path = planned?.kind === 'load' && typeof planned.path === 'string' ? planned.path : null;
  const uri = path ? view.uris.get(path) : null;
  if (typeof uri === 'string' && uri.startsWith('data:image/')) {
    return <img data-image="load" src={uri} alt={alt} title={shown(props.title) || undefined} draggable={false} className="md-image" />;
  }

  // Why it is a box: the plugin's reason ('remote', 'outside', …), the plan's, or where its read is.
  const listed = Number.isSafeInteger(index) && index >= 0 ? view.list?.[index] : null;
  let state = typeof listed?.reason === 'string' ? listed.reason : 'placeholder';
  if (props['data-image'] === 'load') {
    if (planned?.kind === 'placeholder') state = typeof planned.reason === 'string' ? planned.reason : 'placeholder';
    else if (path && view.failed.has(path)) state = 'failed';
    else state = 'loading';
  }
  const address = shown(props['data-address'] ?? planned?.address ?? listed?.address ?? '');
  const words = [alt, address].filter(Boolean).join(', ');
  return (
    <span data-image-placeholder={state} role="img" aria-label={words ? `Image not shown: ${words}` : 'Image not shown'} className="md-image-placeholder">
      <span className="md-image-alt">{alt || 'Image'}</span>
      {address && <span className="md-image-address">{address}</span>}
    </span>
  );
}

/* ------------------------------------------------------------ drawing */

/** The elements the preview draws itself; every other one is the tree's own. */
const COMPONENTS = Object.freeze({ a: MarkdownLink, img: MarkdownImage });

/**
 * The safe hast tree `hast` (markdownPipeline.js, from the worker) as React
 * elements — with the options react-markdown's own `post` step uses.
 */
export function drawMarkdownHast(hast) {
  return toJsxRuntime(hast, { Fragment, jsx, jsxs, components: COMPONENTS, ignoreInvalidStyle: true, passKeys: true, passNode: true });
}

/**
 * `result` as the preview may draw it: an 'ok' tree past
 * MARKDOWN_MAX_ELEMENTS is 'too-complex'. The worker already refuses to
 * build one; this is the window's own check, whatever answered.
 */
export function drawableResult(result) {
  return result?.status === 'ok' && hastPastElements(result.hast) ? { status: 'too-complex' } : result;
}

/** The line at the foot, as ImagePreview's: that the file is gone. */
function StatusLine({ deleted }) {
  if (!deleted) return null;
  return (
    <div
      data-markdown-status=""
      className="flex items-center gap-3 h-[22px] px-3 border-t border-vsc-border text-ui-sm text-vsc-muted select-none shrink-0"
    >
      <span data-markdown-deleted="" className="shrink-0 text-vsc-warn">
        Deleted on disk
      </span>
    </div>
  );
}

/** Why the preview shows no document, and the way to the text instead. */
function Notice({ state, words, onOpenAsText }) {
  return (
    <div data-markdown-notice={state} className="flex flex-col items-center justify-center gap-2 min-h-full px-6 py-8 text-center select-text">
      <p className="m-0 max-w-[480px] text-ui text-vsc-fg break-words">{words}</p>
      <button
        type="button"
        onClick={onOpenAsText}
        className="h-[26px] px-3 text-ui rounded-control bg-vsc-button-secondary border border-vsc-input-border text-vsc-fg hover:bg-vsc-item-hover"
      >
        Open as Text
      </button>
    </div>
  );
}

/**
 * What a preview shows, for the state it is in — drawn by MarkdownPreview,
 * and on its own by the render tests:
 *
 *   tab.tooLarge        the too-large words and Open as Text; nothing parsed;
 *   result null         nothing yet, then "Rendering preview…" once `slow`;
 *   'ok'                the document;
 *   'too-complex'       "Too complex to preview" and Open as Text: past
 *                       the time limit, or past the drawing cap;
 *   'error'             the worker's words, cleaned, and Open as Text.
 *
 * `tab.deleted` adds "Deleted on disk" below whatever is shown.
 */
export function MarkdownPreviewView({ tab, result = null, images = NO_IMAGES, links = null, slow = false, onOpenAsText, documentRef, scrollerRef }) {
  const name = shown(basename(typeof tab?.filePath === 'string' ? tab.filePath : '')) || 'Markdown';
  const drawn = useMemo(() => (result?.status === 'ok' ? drawMarkdownHast(result.hast) : null), [result]);
  const imageView = useMemo(() => ({ ...images, list: Array.isArray(result?.images) ? result.images : [] }), [images, result]);

  let body;
  if (tab?.tooLarge === true) {
    body = <Notice state="too-large" words={markdownTooLargeText(tab.bytes)} onOpenAsText={onOpenAsText} />;
  } else if (result?.status === 'ok') {
    body = (
      <LinkContext.Provider value={links}>
        <ImageContext.Provider value={imageView}>
          <article ref={documentRef} className="markdown-preview">
            {drawn}
          </article>
        </ImageContext.Provider>
      </LinkContext.Provider>
    );
  } else if (result?.status === 'too-complex') {
    body = <Notice state="too-complex" words={TOO_COMPLEX_TEXT} onOpenAsText={onOpenAsText} />;
  } else if (result?.status === 'error') {
    const words = shown(typeof result.message === 'string' ? result.message : '', MESSAGE_MAX) || 'The preview could not be drawn';
    body = <Notice state="error" words={words} onOpenAsText={onOpenAsText} />;
  } else {
    // The frame is kept, empty, so a quick parse draws into it with nothing flashing first.
    body = slow ? (
      <p data-markdown-rendering="" className="m-0 px-6 py-4 text-ui-sm text-vsc-muted select-none">
        Rendering preview…
      </p>
    ) : null;
  }

  return (
    <div data-markdown-preview="" className="flex flex-col h-full w-full bg-vsc-editor">
      {/* Scrolled with the pointer or, once it has the keyboard (Tab), with the arrows and Page keys. */}
      <div
        ref={scrollerRef}
        data-markdown-scroller=""
        tabIndex={0}
        aria-label={`${name}, preview`}
        className="flex-1 min-h-0 overflow-auto"
      >
        {body}
      </div>
      <StatusLine deleted={tab?.deleted === true} />
    </div>
  );
}

/**
 * The Markdown preview tab `tab` (`{ kind: 'markdown', filePath, text,
 * bytes, tooLarge, deleted }`, editorStore.js), drawn from `text` — the
 * tab's own text unless one is passed (step P8 passes the source tab's
 * buffer). One renderer per mounted preview, disposed when it goes; a
 * result that comes after that, or after a newer text was sent, is dropped.
 * A file past the limit is never sent at all.
 */
export function MarkdownPreview({ tab, text = tab?.text }) {
  const openFile = useEditorStore((s) => s.openFile);
  const root = useEditorStore((s) => s.rootPath);
  const filePath = typeof tab?.filePath === 'string' ? tab.filePath : null;
  const tooLarge = tab?.tooLarge === true;
  const source = typeof text === 'string' ? text : null;

  const [renderer, setRenderer] = useState(null);
  const [result, setResult] = useState(null);
  const [slow, setSlow] = useState(false);
  const [images, setImages] = useState({ result: null, view: NO_IMAGES });
  // What this preview has read of its images (`newImageCache`), and a count
  // of the changes on disk that made it forget some.
  const imageCache = useRef(null);
  imageCache.current ??= newImageCache();
  const [imagesForgotten, setImagesForgotten] = useState(0);
  const [asking, setAsking] = useState(null);
  const documentRef = useRef(null);
  const scrollerRef = useRef(null);

  // One renderer for as long as this preview is mounted.
  useEffect(() => {
    let alive = true;
    let made = null;
    createPreviewRenderer().then(
      (next) => {
        if (!alive) {
          next.dispose();
          return;
        }
        made = next;
        setRenderer(next);
      },
      (err) => {
        if (alive) setResult({ status: 'error', name: 'Error', message: String(err?.message ?? err ?? '') });
      }
    );
    return () => {
      alive = false;
      made?.dispose();
    };
  }, []);

  // Each text is sent once; only the answer to the newest is kept.
  useEffect(() => {
    if (!renderer || tooLarge || source === null) return undefined;
    let newest = true;
    renderer.render(source, { filePath, root: root ?? null }).then((next) => {
      if (!newest || !next || next.status === 'superseded') return;
      setResult(drawableResult(next));
    });
    return () => {
      newest = false;
    };
  }, [renderer, source, filePath, root, tooLarge]);

  // "Rendering preview…" only for a first render that takes a while.
  const waiting = result === null && !tooLarge;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => setSlow(true), RENDERING_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  // A change on disk of an image's path has it read again, and one of a
  // folder above it has its size asked again (`forgetChangedImages`):
  // through the watcher the app already runs, as the palette's file list
  // follows it.
  useEffect(() => {
    let live = true;
    let unlisten = null;
    listen('fs-change', (payload) => {
      if (live && forgetChangedImages(imageCache.current, payload)) setImagesForgotten((n) => n + 1);
    }).then(
      (off) => {
        if (live) unlisten = off;
        else off?.();
      },
      () => {}
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // The images of a document: what is not known yet — sizes first, then
  // the reads the plan allows, 4 at once each way. What was read before is
  // not read again. Stopped by the next document, a change on disk, or the
  // unmount: an answer that comes after that is not kept, nor one that
  // comes between a change on disk and the stop, for an image the change
  // made the preview forget or size again. The reads go through the cache's
  // `reads`, shared by every round, so a read a stopped round sent is never
  // sent again while it is out, and the next round takes its answer when it
  // still wants it and its file did not change meanwhile.
  useEffect(() => {
    if (result?.status !== 'ok') return undefined;
    const cache = imageCache.current;
    const list = Array.isArray(result.images) ? result.images : [];
    const paths = imagePathsOf(list);
    keepImagesOf(cache, paths);
    setImages({ result, view: imageViewFrom(cache, result) });
    if (paths.length === 0) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const learned = () => {
      if (!signal.aborted) setImages({ result, view: imageViewFrom(cache, result) });
    };
    (async () => {
      // The sizes not known yet, and the ones to ask again: a folder above them changed.
      const ask = paths.filter((path) => !cache.sizes.has(path) || cache.recheck.has(path));
      if (ask.length > 0) {
        const sized = await mapImageReads(ask, (path) => invoke('fs_file_size', { path }), { signal });
        if (signal.aborted) return;
        learnSizes(cache, ask, sized);
      }
      // Every size is in: the plan, and what it does not read goes.
      const plan = planFrom(cache, list, paths);
      keepPlanned(cache, list, plan);
      if (ask.length > 0) learned();
      // The paths this round has a read out for: one at a time each.
      const out = new Set();
      const readOne = async (path) => {
        out.add(path);
        const answer = await cache.reads.get(path, signal);
        out.delete(path);
        // Stopped, or read before its file changed again (`staleWhere`): not kept.
        if (signal.aborted || (answer.status !== 'fulfilled' && answer.status !== 'rejected')) return;
        // Forgotten, or to be sized again, since this round planned it: a change on disk this round has not
        // stopped for yet. The next round asks and reads it; a read never puts back a size (reviewer C3 R1).
        const planned = cache.sizes.get(path);
        if (!Number.isFinite(planned) || cache.recheck.has(path)) return;
        const read = answer.status === 'fulfilled' ? answer.value : null;
        if (typeof read?.uri === 'string' && read.uri) {
          // More than its size said: the file grew after it was asked. Planned again with what was read, the
          // picture is drawn only if it still fits, and an image after it that no longer does is a box.
          if (read.bytes > planned) cache.sizes.set(path, read.bytes);
          cache.uris.set(path, read.uri);
        } else cache.failed.add(path);
        // Planned again only with every size known: a plan short of one skips past it and could leave out a
        // picture the full plan keeps. An image the new plan lets in that has no picture, no failed read and no
        // read out — one a grown read made room for — is read now, in this round (reviewer C3 R2).
        let more = [];
        if (paths.every((p) => cache.sizes.has(p))) {
          const next = planFrom(cache, list, paths);
          keepPlanned(cache, list, next);
          more = next.reads.filter((p) => !out.has(p) && !cache.uris.has(p) && !cache.failed.has(p));
        }
        learned();
        await Promise.all(more.map(readOne));
      };
      const unread = plan.reads.filter((path) => !cache.uris.has(path) && !cache.failed.has(path));
      await Promise.all(unread.map(readOne));
    })().catch(() => {});
    return () => controller.abort();
  }, [result, imagesForgotten]);

  // A new document draws at once with what is known of its images: one
  // whose images were all read before shows them from its first frame.
  const cachedImages = useMemo(() => imageViewFrom(imageCache.current, result), [result]);

  const links = useMemo(
    () => ({
      external: (address, label) => setAsking({ address, label }),
      anchor: (id) => scrollToId(documentRef.current, scrollerRef.current, id),
      file: (path) => {
        Promise.resolve(openFile(path)).catch(() => {});
      },
    }),
    [openFile]
  );

  const openAsText = () => {
    if (filePath) Promise.resolve(openFile(filePath)).catch(() => {});
  };

  return (
    <>
      <MarkdownPreviewView
        tab={tab}
        result={result}
        images={images.result === result ? images.view : cachedImages}
        links={links}
        slow={slow}
        onOpenAsText={openAsText}
        documentRef={documentRef}
        scrollerRef={scrollerRef}
      />
      {asking &&
        createPortal(
          <ConfirmDialog
            key={asking.address}
            open
            title="Open External Link?"
            message={
              <>
                <p className="m-0">This opens the address in your browser:</p>
                <p data-confirm-address="" className="m-0 mt-2 font-mono text-ui-sm break-all text-vsc-fg-bright">
                  {asking.label}
                </p>
              </>
            }
            confirmLabel="Open"
            cancelLabel="Cancel"
            onConfirm={() => {
              const { address } = asking;
              setAsking(null);
              Promise.resolve(openExternal(address)).catch(() => {});
            }}
            onCancel={() => setAsking(null)}
            fallbackFocus={() => scrollerRef.current?.focus()}
          />,
          document.body
        )}
    </>
  );
}

export default MarkdownPreview;
