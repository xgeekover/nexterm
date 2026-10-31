/**
 * The command lines performance mode types into shells (stage 4): Node,
 * with one of tests/perf's scripts, its path quoted for the shell that will
 * read it (src/lib/dropPaths.js's rules — the ones a dropped file gets).
 *
 * Kept apart from perfRunner.js, which needs the live app, so the suites
 * can check what would be typed into cmd, PowerShell and a POSIX shell.
 */
import { quotePath } from '../dropPaths.js';

/** `dir` and `name` joined the way `platform` spells a path. */
export function joinPath(dir, name, platform) {
  const sep = platform === 'windows' ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`;
}

/**
 * `node <script> <args>` for a shell of `kind`, or null when the script's
 * path cannot be quoted for it (a quote in a cmd path, a control character).
 * `args` are typed as given: the runner builds them from numbers and paths
 * it has quoted itself.
 */
export function nodeCommand(script, args, kind) {
  const quoted = quotePath(script, kind);
  return quoted ? `node ${quoted}${args ? ` ${args}` : ''}` : null;
}
