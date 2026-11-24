import React, { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { displayText } from '../../lib/projectCommands.js';
import { useEditorStore } from '../../stores/editorStore.js';
import {
  canZoomIn,
  canZoomOut,
  fitScale,
  imageAltText,
  imageDataUri,
  imageSizeLabel,
  isSvgPath,
  zoomIn,
  zoomLabel,
  zoomOut,
} from '../../lib/imagePreview.js';

/*
 * The body of an image tab (Orca bundle 5, B4), drawn by EditorPane.jsx in
 * place of Monaco for a tab of kind 'image' — and, like Monaco, loaded from
 * there through `React.lazy`, so it is no part of the first chunk (WV-06).
 *
 * The picture is one `<img>` whose source is the `data:` URI
 * `imageDataUri` builds from what `fs_read_image` answered, and nothing
 * else: no URI, no `<img>`. An SVG is drawn that way too — as an image it
 * runs no script and loads nothing — and never as markup of its own: there
 * is no `<svg>`, `<object>`, `<embed>` or `<iframe>` here, not even an icon
 * (lucide's icons are `<svg>`s), so the controls are words and signs.
 *
 * Fit is the default and never enlarges (`fitScale` against the room the
 * scroller has, followed with a ResizeObserver where there is one). 100%
 * and the zoom buttons step between 10% and 800%; there is no wheel zoom.
 * A picture larger than the pane is panned by scrolling it, with the
 * pointer or, once it has the keyboard, with the arrow keys.
 *
 * An SVG is text as well (OQ-B4d): its tab offers Open as Text, in words,
 * which opens or reveals the file's text tab (editorStore.js
 * `openFileAsText`) — also when the picture is refused, a broken SVG being
 * the one most in need of its source. PNG, JPEG, GIF and WebP do not.
 *
 * Under a transparent picture is a checkerboard of two dark surface tones
 * (`.image-preview-checker`, src/styles/index.css), so that a transparent
 * PNG stays readable on the dark theme. Nothing here moves on its own.
 */

/** The room left round the picture inside the scroller, in px on each side (`p-4`). */
const PANE_PADDING = 16;

/** The size a picture is drawn at and the scale that is, or null for what is not known. */
export function imageDrawSize(size, pane, zoom) {
  const scale = zoom ?? fitScale(size, pane);
  const known = Number.isFinite(size?.width) && size.width > 0 && Number.isFinite(size?.height) && size.height > 0;
  return {
    scale,
    width: known ? Math.max(1, Math.round(size.width * scale)) : null,
    height: known ? Math.max(1, Math.round(size.height * scale)) : null,
  };
}

/** The room the scroller `el` gives a picture, inside its padding: `{ width, height }`, or null before it is laid out. */
function roomIn(el) {
  if (!el) return null;
  const width = el.clientWidth - 2 * PANE_PADDING;
  const height = el.clientHeight - 2 * PANE_PADDING;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** One of the zoom bar's buttons: words, never an icon. */
function ZoomButton({ label, title, pressed, disabled, onClick, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'min-w-[22px] h-[20px] px-1.5 flex items-center justify-center rounded-control text-ui-sm tabular-nums shrink-0',
        'disabled:text-vsc-muted disabled:opacity-60 disabled:hover:bg-transparent',
        pressed ? 'bg-vsc-item-active text-vsc-fg-bright' : 'text-vsc-fg hover:bg-vsc-item-hover'
      )}
    >
      {children}
    </button>
  );
}

/**
 * Open as Text, on an SVG's tab only: the file's source in another tab, the
 * picture staying open (`openFileAsText`). Words, never an icon. A file that will not
 * open as text says why on its own (`openFailure`).
 */
function OpenAsText({ filePath, className }) {
  const openFileAsText = useEditorStore((s) => s.openFileAsText);
  if (!isSvgPath(filePath)) return null;
  return (
    <button
      type="button"
      data-image-open-text=""
      title="Open the SVG source as text"
      onClick={() => {
        Promise.resolve(openFileAsText?.(filePath)).catch(() => {});
      }}
      className={cn('h-[20px] px-2 flex items-center rounded-control text-ui-sm text-vsc-fg hover:bg-vsc-item-hover shrink-0', className)}
    >
      Open as Text
    </button>
  );
}

/** The line at the foot: what the picture is, and that its file is gone. */
function StatusLine({ label, deleted }) {
  if (!label && !deleted) return null;
  return (
    <div
      data-image-status=""
      className="flex items-center gap-3 h-[22px] px-3 border-t border-vsc-border text-ui-sm text-vsc-muted select-none shrink-0"
    >
      {label && <span data-image-size="" className="truncate tabular-nums">{label}</span>}
      {deleted && (
        <span data-image-deleted="" className="shrink-0 text-vsc-warn">
          Deleted on disk
        </span>
      )}
    </div>
  );
}

/**
 * The image tab `tab` (`{ kind: 'image', filePath, image, failure, deleted }`,
 * editorStore.js). A refusal (`failure`) is said in its own words, with no
 * picture; a tab whose file has gone keeps the picture it last showed and
 * says so.
 */
export function ImagePreview({ tab }) {
  const scrollerRef = useRef(null);
  const [pane, setPane] = useState(null);
  // null: Fit. A number: the scale 100% or a zoom button chose.
  const [zoom, setZoom] = useState(null);
  // The size the webview decoded, which wins over the header's: it is what
  // is drawn (a JPEG turned by its EXIF data, an SVG with no size of its own).
  const [natural, setNatural] = useState(null);
  const [broken, setBroken] = useState(null);

  const failure = typeof tab?.failure === 'string' && tab.failure ? displayText(tab.failure, 300) : null;
  const uri = failure ? null : imageDataUri(tab?.image);
  const image = uri ? tab.image : null;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const measure = () => {
      const next = roomIn(el);
      setPane((cur) => (cur?.width === next?.width && cur?.height === next?.height ? cur : next));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [uri]);

  const deleted = tab?.deleted === true;
  const name = imageAltText(tab?.filePath);

  if (!uri || broken === uri) {
    const reason = failure ?? (uri ? 'The picture could not be drawn.' : 'There is no picture to show.');
    return (
      <div data-image-preview="" className="flex flex-col h-full w-full bg-vsc-editor">
        <div
          data-image-failure=""
          className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 px-6 text-center select-text"
        >
          <p className="m-0 text-ui text-vsc-fg">Cannot show {name}</p>
          <p className="m-0 max-w-[480px] text-ui-sm text-vsc-muted break-words">{reason}</p>
          <OpenAsText filePath={tab?.filePath} className="mt-2 border border-vsc-input-border" />
        </div>
        <StatusLine label={image ? imageSizeLabel(image) : ''} deleted={deleted} />
      </div>
    );
  }

  const decoded = natural?.src === uri ? natural : null;
  const size = decoded ?? { width: image.width, height: image.height };
  const drawn = imageDrawSize(size, pane, zoom);
  const sized = drawn.width != null;
  const fit = zoom === null;

  return (
    <div data-image-preview="" className="flex flex-col h-full w-full bg-vsc-editor">
      <div
        role="toolbar"
        aria-label="Image zoom"
        className="flex items-center gap-0.5 h-[26px] px-2 border-b border-vsc-border select-none shrink-0"
      >
        <ZoomButton label="Fit to pane" title="Fit" pressed={fit} onClick={() => setZoom(null)}>
          Fit
        </ZoomButton>
        <ZoomButton
          label="Actual size"
          title="100%"
          pressed={!fit && zoom === 1}
          disabled={!sized}
          onClick={() => setZoom(1)}
        >
          100%
        </ZoomButton>
        <span aria-hidden="true" className="w-px h-3 mx-1 bg-vsc-border shrink-0" />
        <ZoomButton
          label="Zoom out"
          title="Zoom Out"
          disabled={!sized || !canZoomOut(drawn.scale)}
          onClick={() => setZoom(zoomOut(drawn.scale))}
        >
          {'\u{2212}'}
        </ZoomButton>
        <span data-image-zoom="" className="min-w-[40px] text-center text-ui-sm text-vsc-muted tabular-nums">
          {zoomLabel(drawn.scale)}
        </span>
        <ZoomButton
          label="Zoom in"
          title="Zoom In"
          disabled={!sized || !canZoomIn(drawn.scale)}
          onClick={() => setZoom(zoomIn(drawn.scale))}
        >
          +
        </ZoomButton>
        <OpenAsText filePath={tab?.filePath} className="ml-auto" />
      </div>

      {/* Scrolled to pan; a keyboard reaches it with Tab and pans with the arrows. */}
      <div
        ref={scrollerRef}
        data-image-scroller=""
        tabIndex={0}
        aria-label={`${name}, scroll to pan`}
        className="flex-1 min-h-0 overflow-auto"
      >
        <div className="flex w-max min-w-full min-h-full p-4">
          <img
            src={uri}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
              if (width > 0 && height > 0) setNatural({ src: uri, width, height });
            }}
            onError={() => setBroken(uri)}
            className="image-preview-checker block m-auto max-w-none shrink-0"
            style={
              sized
                ? {
                    width: `${drawn.width}px`,
                    height: `${drawn.height}px`,
                    // A raster picture past 100% shows its pixels rather than a blur.
                    imageRendering: drawn.scale > 1 && image.mime !== 'image/svg+xml' ? 'pixelated' : 'auto',
                  }
                : // No size known yet (an SVG before it is decoded): at most
                  // the room there is, which a picture never grows to fill.
                  { maxWidth: pane ? `${pane.width}px` : '100%', maxHeight: pane ? `${pane.height}px` : undefined }
            }
          />
        </div>
      </div>

      <StatusLine label={imageSizeLabel(image)} deleted={deleted} />
    </div>
  );
}

export default ImagePreview;
