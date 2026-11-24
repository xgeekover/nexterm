/**
 * An image tab (Orca bundle 5, B4): which files open as pictures, the
 * `data:` URI one is shown from, how large it is drawn, the line that says
 * what it is, and the reason shown when the backend would not hand it over.
 * Pure: no React, no stores, no DOM, no IPC.
 *
 * The backend reads the file (`fs_read_image`, src-tauri/src/fs/preview.rs)
 * and answers `{ mime, data, bytes, width, height }`: the format its bytes
 * say, never its name; the bytes as standard base64; the size its header
 * declares, null for an SVG. Its refusals start with fixed words, followed
 * by ": <path>" — the path as it resolved it — and the confinement's own
 * ("No folder is open", "Path is outside the workspace root (…)") come
 * before any of them.
 *
 * An image is only ever drawn as an `<img>` from a `data:` URI: the app's
 * CSP allows `img-src 'self' data:`, and an SVG used as an image runs no
 * script and loads nothing. Never inline `<svg>`, `<object>`, `<embed>` or
 * `<iframe>`.
 *
 * Fit is the default and never enlarges: a small image is drawn at 100%, a
 * large one shrunk to the pane. The zoom buttons step between 10% and 800%;
 * there is no wheel zoom.
 */
import { basename, extname } from './paths.js';
import { displayText } from './projectCommands.js';

/** The extensions opened as an image tab rather than as text, lower case; matched whatever their case. */
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** The formats the backend answers, by the MIME type it gives: the only ones a `data:` URI is built for. */
export const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

/** The largest image the backend reads (`MAX_IMAGE_BYTES`, src-tauri/src/fs/preview.rs). */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The fixed words the backend's refusals start with: `NOT_FOUND`,
 * `NOT_AN_IMAGE` and `TOO_LARGE` in src-tauri/src/fs/preview.rs.
 */
export const IMAGE_REFUSALS = Object.freeze({
  notFound: 'File not found',
  notAnImage: 'File is not an image NexTerm can show',
  tooLarge: 'Image is too large to preview',
});

/** The smallest and the largest zoom the buttons give, as a scale (1 is 100%). */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

/** The scales the zoom buttons step through, smallest first, from ZOOM_MIN to ZOOM_MAX. */
export const ZOOM_STEPS = Object.freeze([0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]);

/** How close two scales are to count as one step (floating point). */
const ZOOM_EPSILON = 1e-9;

/** The longest reason shown, in characters. */
const REASON_MAX = 300;

/** The longest file name used as alt text, in characters. */
const ALT_MAX = 120;

/** How much of any text is looked at at all, in UTF-16 units. */
const INPUT_MAX = 16_384;

/** The longest base64 the backend can send: IMAGE_MAX_BYTES, encoded. */
const DATA_MAX_CHARS = 4 * Math.ceil(IMAGE_MAX_BYTES / 3);

/** Standard base64 (`+` and `/`, padded) — what the backend sends. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A refusal, up to the ": <path>" it ends with: its fixed words and, in
 * brackets, why — none of which holds a bracket of its own.
 */
const IMAGE_REFUSAL = new RegExp(
  `^(${IMAGE_REFUSALS.notFound}|${IMAGE_REFUSALS.notAnImage} \\([^()]*\\)|${IMAGE_REFUSALS.tooLarge} \\([^()]*\\)): `
);

/** Whether `path` names a file opened as an image tab: by its extension, whatever its case. */
export function isImagePath(path) {
  return typeof path === 'string' && IMAGE_EXTENSIONS.includes(extname(path));
}

/**
 * Whether `path` names an SVG, by its extension, whatever its case: the one
 * image that is text as well (the human's decision OQ-B4d, 2026-11-24). It
 * opens as a picture, and its image tab offers Open as Text, which opens the
 * file's text in another tab (editorStore.js `openFileAsText`); an open that
 * asks for a line — a search result, a terminal link `icon.svg:12` — goes
 * to that text tab (`openFileAt`). PNG, JPEG, GIF and WebP are bytes, not
 * text, and get neither.
 */
export function isSvgPath(path) {
  return typeof path === 'string' && extname(path) === 'svg';
}

/**
 * The `data:` URI to show `image` from — `{ mime, data }` as the backend
 * answers — or null when it is not one of IMAGE_MIMES, or `data` is not
 * standard base64 of at most IMAGE_MAX_BYTES. Nothing else ever becomes a
 * source: a `data:text/html` or a `javascript:` cannot be built here.
 */
export function imageDataUri(image) {
  if (image === null || typeof image !== 'object') return null;
  const { mime, data } = image;
  if (!IMAGE_MIMES.includes(mime)) return null;
  if (typeof data !== 'string' || data.length === 0 || data.length > DATA_MAX_CHARS || data.length % 4 !== 0) return null;
  if (!BASE64.test(data)) return null;
  return `data:${mime};base64,${data}`;
}

/** `value` when it is a positive finite number, else null. */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The scale that fits `image` (`{ width, height }` in pixels) into `pane`
 * (`{ width, height }`, the room it has): the smaller of the two ratios,
 * and never above 1 — fitting never enlarges. 1 when a size is not known
 * (an SVG, a pane not laid out yet). It may be below ZOOM_MIN: a very large
 * image is fitted whole.
 */
export function fitScale(image, pane) {
  const width = positive(image?.width);
  const height = positive(image?.height);
  const room = { width: positive(pane?.width), height: positive(pane?.height) };
  if (!width || !height || !room.width || !room.height) return 1;
  return Math.min(1, room.width / width, room.height / height);
}

/** `scale` within ZOOM_MIN and ZOOM_MAX; 1 for anything that is not a finite number. */
export function clampZoom(scale) {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * The scale the zoom-in button goes to from `scale`: the next step up, at
 * most ZOOM_MAX. From below ZOOM_MIN (a fitted large image) that is
 * ZOOM_MIN; a scale above ZOOM_MAX, which no button and no fit gives, comes
 * back to ZOOM_MAX.
 */
export function zoomIn(scale) {
  const from = typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
  return ZOOM_STEPS.find((step) => step > from + ZOOM_EPSILON) ?? ZOOM_MAX;
}

/**
 * The scale the zoom-out button goes to from `scale`: the next step down,
 * at least ZOOM_MIN. From ZOOM_MIN or below — a fit that shrank a large
 * image further — it stays where it is: zooming out never enlarges.
 */
export function zoomOut(scale) {
  const from = typeof scale === 'number' && Number.isFinite(scale) ? scale : 1;
  if (from > ZOOM_MAX) return ZOOM_MAX;
  for (let at = ZOOM_STEPS.length - 1; at >= 0; at -= 1) {
    if (ZOOM_STEPS[at] < from - ZOOM_EPSILON) return ZOOM_STEPS[at];
  }
  return from;
}

/** Whether the zoom-in button has somewhere to go from `scale`. */
export function canZoomIn(scale) {
  return zoomIn(scale) > (typeof scale === 'number' && Number.isFinite(scale) ? scale : 1) + ZOOM_EPSILON;
}

/** Whether the zoom-out button has somewhere to go from `scale`. */
export function canZoomOut(scale) {
  return zoomOut(scale) < (typeof scale === 'number' && Number.isFinite(scale) ? scale : 1) - ZOOM_EPSILON;
}

/** `scale` as the zoom control shows it: '25%', '100%', '800%'; '<1%' for a fit below one percent. */
export function zoomLabel(scale) {
  const percent = Math.round((typeof scale === 'number' && Number.isFinite(scale) ? scale : 1) * 100);
  return percent < 1 ? '<1%' : `${percent}%`;
}

/**
 * A file's size in binary units, one decimal from KB on: '512 B', '3.4 KB',
 * '2.4 MB', '1.0 GB' (1 KB = 1024 bytes). A size that rounds to 1024 of one
 * unit is already one of the next. '' for anything that is not a byte count.
 *
 * Not the backend's `size_label` (src/lib/sizeLabel.js), on purpose: that
 * one says how far past a limit a refused file is, so it is always in MB
 * and rounds up; this one describes a picture that was shown — an 80-byte
 * icon is '80 B', not '0.1 MB' — so it picks the unit and rounds to nearest.
 */
export function formatImageBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  for (const unit of ['KB', 'MB']) {
    const tenths = Math.round(value * 10);
    if (tenths < 1024 * 10) return `${(tenths / 10).toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${(Math.round(value * 10) / 10).toFixed(1)} GB`;
}

/** Whether `side` is a size a header can declare: a positive whole number. */
function isSide(side) {
  return Number.isSafeInteger(side) && side > 0;
}

/**
 * The dimmed line under an image: '1920 × 1080 · 2.4 MB' — the size its
 * header declares and its size on disk. An SVG has no pixel size of its own:
 * 'SVG · 3.1 KB'. Whichever half is not known is left out; '' when neither
 * is.
 */
export function imageSizeLabel(image) {
  const width = image?.width;
  const height = image?.height;
  const dimensions = isSide(width) && isSide(height)
    ? `${width} \u{00d7} ${height}`
    : image?.mime === 'image/svg+xml' ? 'SVG' : '';
  return [dimensions, formatImageBytes(image?.bytes)].filter(Boolean).join(' \u{00b7} ');
}

/** The image's alt text: its file name, cleaned of control, bidirectional and invisible characters; 'Image' when nothing is left. */
export function imageAltText(path) {
  const name = typeof path === 'string' ? basename(path.slice(0, INPUT_MAX)) : '';
  return displayText(name, ALT_MAX) || 'Image';
}

/** A failure's words: Tauri rejects with the command's own string, the browser mock with an Error. */
function errorText(err) {
  return typeof err === 'string' ? err : String(err?.message ?? err ?? '');
}

/**
 * Which refusal `err` is: 'not-found' (nothing at the path — deleted, or
 * never there), 'not-an-image', 'too-large', or 'failed' for anything else
 * (a confinement refusal, a read that failed).
 */
export function imageRefusalKind(err) {
  const text = errorText(err).trim();
  if (text.startsWith(`${IMAGE_REFUSALS.notFound}: `)) return 'not-found';
  if (text.startsWith(`${IMAGE_REFUSALS.notAnImage} (`)) return 'not-an-image';
  if (text.startsWith(`${IMAGE_REFUSALS.tooLarge} (`)) return 'too-large';
  return 'failed';
}

/**
 * Why `fs_read_image` would not hand over `path`, for the user to read: the
 * backend's own words without the ": <path>" they end with, which the tab
 * names already — "File not found", "File is not an image NexTerm can show
 * (its header is not valid)", "Image is too large to preview (25.0 MB; the
 * limit is 20 MB)", "No folder is open", "Path is outside the workspace root
 * (/work)". The fixed refusals are told by their words, as the path they
 * end with is the one the backend resolved and need not be `path`.
 * Cleaned of control, bidirectional and invisible characters, and cut at
 * 300 characters.
 */
export function imageFailureReason(err, path) {
  const text = errorText(err).slice(0, INPUT_MAX).trim();
  let reason;
  const refusal = IMAGE_REFUSAL.exec(text);
  if (refusal) reason = refusal[1];
  else if (typeof path === 'string' && path && text.endsWith(`: ${path}`) && text.length > path.length + 2) {
    reason = text.slice(0, -(path.length + 2));
  } else {
    const failed = /^Failed to read file '.*': (.+)$/s.exec(text);
    reason = failed ? `Failed to read file: ${failed[1]}` : text;
  }
  return displayText(reason, REASON_MAX) || 'Unknown error';
}
