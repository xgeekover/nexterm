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
 *
 * That discard-on-mismatch policy is *destructive* for any caller that has a
 * real migration to run: by the time `loadState` has returned the fallback the
 * old payload is still on disk, but the caller has already bootstrapped a
 * default state and its own write-behind will overwrite it moments later.
 * `loadVersionedState` exists for exactly that case — it hands back the raw
 * `{ version, data }` pair at *any* version so the caller can branch on the
 * version itself and migrate instead of silently losing the user's data.
 */

export const SCHEMA_VERSION = 2;

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

/**
 * Read `key` WITHOUT the version gate, so a caller that knows how to migrate
 * an older payload can do so instead of losing it.
 *
 * Returns `{ version, data }` for any stored payload — including one written
 * by an older (or newer) schema — or `null` when the key is absent, the
 * storage is unreachable, or the payload is not a JSON object. `version` is
 * whatever was stamped (possibly `undefined` for a hand-written payload), so
 * callers must compare it explicitly and treat anything they don't recognise
 * as "no usable state" rather than assuming it is current.
 *
 * Additive on purpose: `loadState`/`saveState` behave exactly as before.
 */
export function loadVersionedState(key) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    const raw = localStorage.getItem(key);
    if (raw == null) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { version: parsed.version, data: parsed.data };
  } catch (_) {
    return null;
  }
}

export default { loadState, saveState, loadVersionedState, SCHEMA_VERSION };
