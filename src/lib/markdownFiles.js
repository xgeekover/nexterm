/**
 * Which files a Markdown preview opens for (Orca bundle 5, B3): by their
 * extension, `.md` or `.markdown`, whatever its case.
 *
 * One rule for every place that asks — the store's `openMarkdownPreview`,
 * the editor pane's breadcrumb button, the palette's Open Markdown Preview
 * and the Explorer's Open Preview — kept in a plain module of its own so
 * that the palette and the Explorer, which the mounted suites bundle with a
 * stand-in editor store, ask it without the store. editorStore.js exports
 * it as well: one value.
 */
import { extname } from './paths.js';

/** The extensions a Markdown preview opens for, lower case; matched whatever their case. */
export const MARKDOWN_EXTENSIONS = Object.freeze(['md', 'markdown']);

/** Whether `path` names a file a Markdown preview opens for: by its extension, whatever its case. */
export function isMarkdownPath(path) {
  return typeof path === 'string' && MARKDOWN_EXTENSIONS.includes(extname(path));
}
