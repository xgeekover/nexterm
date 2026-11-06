import React, { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ConfirmDialog } from '../common/ConfirmDialog.jsx';
import { useProjectCommandsStore } from '../../stores/projectCommandsStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { COMMANDS_FILE } from '../../lib/projectCommands.js';
import { asSentence } from '../../lib/projectCommandRun.js';
import { focusWorkspace } from '../../lib/workspaceFocus.js';
import { swallowRepeatsOf } from '../../lib/heldKeys.js';
import { holdModal } from '../../lib/modalLock.js';
import { dialogReturn, focusBack } from '../../lib/dialogReturn.js';

/** "1 command", "3 commands". */
const commandsCount = (n) => `${n} command${n === 1 ? '' : 's'}`;

/**
 * A command line in the order it is typed. A right-to-left word in it
 * (`cp א ב`) is otherwise drawn reordered — `cp ב א` — and what is read is
 * not what runs.
 */
export const LINE_ORDER = { direction: 'ltr', unicodeBidi: 'bidi-override' };

/** How many refused commands are listed one by one; the rest are counted. */
const REFUSED_SHOWN = 50;

/**
 * Every command of the file, as the review shows it: its name, what it says
 * it does, and the whole line in monospace, wrapped — what would be typed,
 * blanks and all, with nothing cut, in the order it is typed. Then the
 * commands that were refused, and why, so a command missing from the list is
 * never a silent one.
 */
export function TrustReviewBody({ project, trust }) {
  const commands = project?.ok ? project.commands : [];
  const refused = project?.ok ? project.refused : [];
  return (
    <div data-trust-review="" className="flex flex-col gap-2">
      <p className="m-0">
        {`${COMMANDS_FILE} in this folder names ${commandsCount(commands.length)}. Someone else may have written them: read each line. Trusted, the palette offers them, and each still shows its exact line before anything is typed. Any change to the file asks again.`}
      </p>
      {trust === 'changed' ? (
        <p data-trust-changed="" role="status" className="m-0 text-vsc-warn">
          The file has changed since you trusted its commands.
        </p>
      ) : null}
      {project && !project.ok ? (
        <p data-trust-file-reason="" role="alert" className="m-0 text-vsc-error">
          {`${COMMANDS_FILE} is not a commands file: ${project.reason}`}
        </p>
      ) : null}
      {commands.length > 0 ? (
        <ul data-trust-commands="" className="m-0 p-0 list-none flex flex-col gap-2 border border-vsc-border rounded-[3px] px-2 py-1.5">
          {commands.map((cmd) => (
            <li key={cmd.key} data-trust-command={cmd.key} className="min-w-0">
              <div className="font-medium text-vsc-fg break-words">{cmd.name}</div>
              {cmd.description ? <div className="text-ui-sm text-vsc-muted break-words">{cmd.description}</div> : null}
              <pre
                style={LINE_ORDER}
                className="m-0 mt-0.5 font-mono text-ui-sm text-vsc-fg whitespace-pre-wrap break-all bg-vsc-input rounded-sm px-1.5 py-1"
              >
                {cmd.template}
              </pre>
            </li>
          ))}
        </ul>
      ) : null}
      {refused.length > 0 ? (
        <div data-trust-refused="" className="text-ui-sm">
          <div className="text-vsc-muted">{`Refused, and not offered (${refused.length}):`}</div>
          <ul className="m-0 pl-4">
            {refused.slice(0, REFUSED_SHOWN).map((r) => (
              <li key={r.index} className="text-vsc-error break-words">
                {`Command ${r.index + 1}${r.name ? ` (${r.name})` : ''}: ${asSentence(r.reason)}.`}
              </li>
            ))}
          </ul>
          {refused.length > REFUSED_SHOWN ? (
            <div className="text-vsc-muted">{`…and ${refused.length - REFUSED_SHOWN} more: Open Project Commands File to see the file.`}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Review This Folder's Commands…" (spec D5): the folder's commands, every
 * line in full, and Trust / Cancel.
 *
 * ConfirmDialog's, with all of its guards: Cancel has the keyboard when it
 * opens, Escape cancels, Enter on a button is that button, a held Enter is
 * not a press, and a click on Trust within moments of it opening — the
 * second click of the double-click that chose the row — does not count.
 * Trust gives trust to what the dialog SHOWS (`trustCurrent`), never to a
 * read made since, and only once however often it is pressed; the palette
 * then lists the commands, which is what the user came for.
 *
 * Keyed by the review, so each opening starts with Cancel focused again.
 */
export function ProjectCommandsTrustDialog() {
  const reviewing = useProjectCommandsStore((s) => s.reviewing);
  if (!reviewing) return null;
  return <TrustDialog key={reviewing.id} reviewing={reviewing} />;
}

/**
 * Whether what the review shows is still the file: the same folder, read,
 * with the same bytes. A file that changed while the review was open is not
 * swapped in under the pointer; Trust goes off until the new version is
 * shown (review L7).
 */
export function reviewIsCurrent(now, reviewing) {
  return now.status === 'ok' && now.root === reviewing.root && now.sha256 === reviewing.sha256;
}

function TrustDialog({ reviewing }) {
  const trustCurrent = useProjectCommandsStore((s) => s.trustCurrent);
  const closeReview = useProjectCommandsStore((s) => s.closeReview);
  const openReview = useProjectCommandsStore((s) => s.openReview);
  const now = useProjectCommandsStore(useShallow((s) => ({ status: s.status, root: s.root, sha256: s.sha256 })));
  const setCommandPaletteOpen = useSettingsStore((s) => s.setCommandPaletteOpen);
  const answered = useRef(false);
  // What had the keyboard before the palette that opened this (if it did).
  const [returnTo] = useState(() => dialogReturn());
  const current = reviewIsCurrent(now, reviewing);
  const changed = reviewing.trust === 'changed';

  // The app's chords and menu do nothing while this is open (modalLock.js).
  useEffect(() => holdModal(), []);

  const stale = current ? null : (
    <div data-trust-stale="" role="alert" className="mb-2 p-2 rounded-[3px] border border-vsc-warn text-vsc-warn">
      <p className="m-0">
        {now.status === 'ok' && now.root === reviewing.root
          ? 'The file has changed since this opened. Trust is off until you have seen the new version.'
          : 'The file is not what this shows any more. Trust is off.'}
      </p>
      {now.status === 'ok' && now.root === reviewing.root ? (
        <button
          type="button"
          onClick={() => openReview()}
          className="mt-1.5 h-[24px] px-2 text-ui-sm rounded-[3px] bg-vsc-button-secondary text-vsc-fg hover:bg-vsc-item-hover"
        >
          Show the New Version
        </button>
      ) : null}
    </div>
  );

  return (
    <ConfirmDialog
      open
      title={changed ? "This Folder's Commands Have Changed" : "Trust This Folder's Commands?"}
      message={
        <>
          {stale}
          <TrustReviewBody project={reviewing.project} trust={reviewing.trust} />
        </>
      }
      confirmLabel="Trust"
      confirmDisabled={!current}
      confirmDisabledReason="The file has changed since this opened"
      initialFocus="cancel"
      // An Enter held on either button — or an Escape held — repeats on after
      // the dialog has gone, into the terminal the keyboard goes back to:
      // those repeats are not presses. (After a mouse click this only waits
      // for the next press of the key.)
      onConfirm={() => {
        if (answered.current || !current) return;
        answered.current = true;
        swallowRepeatsOf('Enter');
        if (trustCurrent()) setCommandPaletteOpen(true, 'project-commands');
      }}
      onCancel={() => {
        answered.current = true;
        swallowRepeatsOf('Enter');
        swallowRepeatsOf('Escape');
        closeReview();
      }}
      fallbackFocus={() => focusBack(returnTo, () => focusWorkspace('terminal'))}
    />
  );
}

export default ProjectCommandsTrustDialog;
