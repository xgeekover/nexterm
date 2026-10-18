/**
 * A terminal asking for a password (spec P4): its typing is hidden.
 *
 * The backend reads the terminal's line discipline after output — echo off in
 * canonical mode is what sudo, ssh, `read -s` and getpass leave it in, and
 * what no shell prompt or full-screen program does (src-tauri/src/pty/
 * echo_watch.rs) — and says `pty-echo { session_id, secret }` whenever that
 * changes, and `secret: false` as a session that ended secret ends. Unix
 * only: on Windows nothing is ever said, and nothing is ever locked.
 *
 * The store keeps it per terminal, in a map of its own beside `tabs`
 * (`secretInput`: tab id -> true) — as the progress bars are kept — so the
 * few marks that draw it subscribe to one terminal's boolean and nothing
 * else redraws. These are the map's rules, with no store in them.
 */

/** What a lock says, wherever one is drawn — its tooltip and what a screen reader reads. */
export const TYPING_HIDDEN_LABEL = 'Typing is hidden (password prompt)';

/** `map` with `tabId` secret or not — the same object when that is what it already said. */
export function withSecret(map, tabId, secret) {
  const current = map ?? {};
  if (!tabId || Boolean(current[tabId]) === Boolean(secret)) return map ?? current;
  const next = { ...current };
  if (secret) next[tabId] = true;
  else delete next[tabId];
  return next;
}

/** `map` without `tabIds` — the same object when it held none of them. */
export function withoutSecret(map, tabIds) {
  if (!map || !tabIds?.some((id) => map[id])) return map;
  const next = { ...map };
  for (const id of tabIds) delete next[id];
  return next;
}

/** Whether `tabId`'s terminal is asking for a password, in a store state. */
export function typingHidden(state, tabId) {
  return Boolean(tabId && state?.secretInput?.[tabId]);
}
