/**
 * Tiny, dependency-free JSON persistence over `localStorage`.
 *
 * Both private/incognito windows and the Tauri webview can throw on mere
 * *access* to `localStorage` (not just be missing it), so every touch of the
 * global is wrapped in try/catch — never assume it's safe to read/write.
 *
 * Every saved payload is stamped with `SCHEMA_VERSION`. If that ever changes
 * (the persisted shape changes), `loadState` treats any payload written by an
 * older version as absent rather than trying to interpret it — a future
 * shape change is discarded safely instead of crashing the app.
 */

export const SCHEMA_VERSION = 1;

/** Read `key` from localStorage. Returns `fallback` on any miss, parse error, or version mismatch. */
export function loadState(key, fallback) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return fallback;
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== SCHEMA_VERSION) {
      return fallback;
    }
    return parsed.data;
  } catch (_) {
    return fallback;
  }
}

/** Write `value` to localStorage under `key`, stamped with the current schema version. Returns whether it succeeded. */
export function saveState(key, value) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return false;
    localStorage.setItem(key, JSON.stringify({ version: SCHEMA_VERSION, data: value }));
    return true;
  } catch (_) {
    return false;
  }
}

export default { loadState, saveState, SCHEMA_VERSION };
