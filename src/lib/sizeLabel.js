/**
 * A file's size in the backend's words: `size_label` in
 * src-tauri/src/fs/mod.rs, which its refusals say a size in — "File is too
 * large to open (120.0 MB; …)", "Image is too large to preview (20.1 MB; …)".
 * The one copy of it on this side, for the Markdown preview's too-large
 * notice (src/lib/markdownPreview.js) and the browser mock's refusals
 * (src/lib/ipc.js). It imports nothing, so the mock may take it: ipc.js is
 * in the first chunk. Held to the backend's own table by MP-21
 * (tests/adversarial/markdown_preview.test.js).
 */

const MB = 1024 * 1024;

/**
 * `bytes` in MB, in tenths rounded up — so a file one byte past 2 MB is
 * '2.1 MB', never a '2.0 MB' that reads as within the limit — and in GB, one
 * decimal, once that is 1024.0 MB: '1023.1 MB', then '1.0 GB'. '' for
 * anything that is not a byte count.
 */
export function sizeLabel(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  const tenths = Math.ceil((bytes * 10) / MB);
  if (tenths >= 10 * 1024) return `${(tenths / 10 / 1024).toFixed(1)} GB`;
  return `${Math.floor(tenths / 10)}.${tenths % 10} MB`;
}
