/**
 * Path handling that survives Windows.
 *
 * The backend hands back whatever the OS uses: `/Users/me/project/src` on
 * macOS and Linux, `C:\Users\me\project\src` on Windows. Code that assumed `/`
 * did not merely look wrong on Windows — the explorer's root filter compared
 * `"C:\proj\src".startsWith("C:\proj/")`, which is false for every entry, so
 * the whole tree rendered empty and no amount of fixing the tree itself
 * helped.
 *
 * Everything that takes a path apart or puts one together goes through here.
 */

/** The separator `path` is written with. Falls back to the posix one. */
export function sepOf(path) {
  if (typeof path !== 'string') return '/';
  // A Windows path may legitimately contain both (`C:\a/b`), and the backend
  // is consistent per platform, so the first separator seen wins.
  const bs = path.indexOf('\\');
  const fs = path.indexOf('/');
  if (bs === -1) return '/';
  if (fs === -1) return '\\';
  return bs < fs ? '\\' : '/';
}

/** `path` with every separator turned into `/`, for comparisons only. */
export function toPosix(path) {
  return typeof path === 'string' ? path.replace(/\\/g, '/') : '';
}

/** Drop any trailing separators (but never turn "/" or "C:\" into ""). */
export function stripTrailingSep(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed || path.slice(0, 1);
}

/** The last segment: `basename('/a/b.txt') === 'b.txt'`. */
export function basename(path) {
  const clean = stripTrailingSep(path);
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Everything but the last segment. Returns the root when there is no parent. */
export function dirname(path) {
  const clean = stripTrailingSep(path);
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (idx === -1) return clean;
  if (idx === 0) return clean.slice(0, 1); // "/a" -> "/"
  return clean.slice(0, idx);
}

/** The file extension without the dot, lowercased, or '' when there is none. */
export function extname(path) {
  const name = basename(path);
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? '' : name.slice(idx + 1).toLowerCase();
}

/** Join `name` onto `base` using whatever separator `base` already uses. */
export function join(base, name) {
  const sep = sepOf(base);
  const left = stripTrailingSep(base);
  const right = String(name ?? '').replace(/^[\\/]+/, '');
  if (!right) return left;
  return left.endsWith(sep) ? `${left}${right}` : `${left}${sep}${right}`;
}

/** Whether two paths name the same entry, separators aside. */
export function samePath(a, b) {
  return toPosix(stripTrailingSep(a)) === toPosix(stripTrailingSep(b));
}

/**
 * Whether `child` sits underneath `parent` (strictly — a path is not inside
 * itself). Separator-agnostic, and never matches a sibling whose name merely
 * starts the same way (`/a/bc` is not inside `/a/b`).
 */
export function isInside(parent, child) {
  const p = toPosix(stripTrailingSep(parent));
  const c = toPosix(stripTrailingSep(child));
  return c.length > p.length && c.startsWith(p) && c[p.length] === '/';
}

/** Whether `child` is a DIRECT child of `parent`. */
export function isDirectChild(parent, child) {
  if (!isInside(parent, child)) return false;
  const rest = toPosix(stripTrailingSep(child)).slice(toPosix(stripTrailingSep(parent)).length + 1);
  return rest.length > 0 && !rest.includes('/');
}

/** `path` expressed relative to `root`, or `path` unchanged if it is outside. */
export function relativeTo(root, path) {
  if (samePath(root, path)) return '.';
  if (!isInside(root, path)) return path;
  const base = stripTrailingSep(root);
  return stripTrailingSep(path).slice(base.length + 1);
}

/** Re-root `path` from `fromPath` onto `toPath` (used when a folder is renamed). */
export function reparent(path, fromPath, toPath) {
  if (samePath(path, fromPath)) return toPath;
  if (!isInside(fromPath, path)) return path;
  return toPath + path.slice(stripTrailingSep(fromPath).length);
}

/** How many levels deep `path` is — for ordering parents before children. */
export function depthOf(path) {
  return toPosix(stripTrailingSep(path)).split('/').filter(Boolean).length;
}

/**
 * A path shortened for display: the home directory becomes `~`, and a long
 * path keeps its last `keep` segments behind an ellipsis.
 */
export function displayPath(path, { home = null, keep = 3 } = {}) {
  if (!path) return '';
  let shown = stripTrailingSep(path);
  if (home && (samePath(home, shown) || isInside(home, shown))) {
    const rest = samePath(home, shown) ? '' : relativeTo(home, shown);
    shown = rest ? `~${sepOf(path)}${rest}` : '~';
  }
  const sep = sepOf(shown) === '\\' ? '\\' : '/';
  const parts = shown.split(/[\\/]/).filter(Boolean);
  const rooted = parts[0] === '~';
  // `~` says which home this is under; dropping it to save two characters
  // turns a recognisable path into an anonymous one.
  const budget = rooted ? keep + 1 : keep;
  if (parts.length <= budget) return shown;
  const tail = parts.slice(-keep).join(sep);
  return rooted ? `~${sep}…${sep}${tail}` : `…${sep}${tail}`;
}
