import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  STATUS_DIAGRAM_DIRECTIVE,
  STATUS_DIRECTIVE_MARKER,
  appendStatusDirective,
  appendStatusDirectiveToSystem,
  hasStatusDirective,
  checkStatusCompliance,
  buildStatusCorrectionMessage,
} from '../core/status-directive.mjs';
import { buildEscalatingFeedback } from '../core/feedback.mjs';
import { goalStore, isStatusDiagramEnabled } from '../core/goal.mjs';

// ---------------------------------------------------------------------------
// The status/roadmap directive must ride along with EVERY supervisor
// continuation prompt (autopilot nudge + reflection feedback) so the roadmap
// survives context compaction. These tests pin its content and its position
// (always last).
// ---------------------------------------------------------------------------

test('STATUS_DIAGRAM_DIRECTIVE carries the required anchors', () => {
  for (const anchor of ['status.md', 'ROADMAP', 'YOU ARE HERE', 'WHY SLOW', 'NEXT']) {
    assert.ok(
      STATUS_DIAGRAM_DIRECTIVE.includes(anchor),
      `directive missing anchor: ${anchor}`
    );
  }
});

test('STATUS_DIAGRAM_DIRECTIVE leads with the stable idempotency marker', () => {
  assert.ok(
    STATUS_DIAGRAM_DIRECTIVE.startsWith(STATUS_DIRECTIVE_MARKER),
    'marker must be the first line so a substring test on it is unambiguous'
  );
  // HTML comment => invisible in every markdown renderer.
  assert.match(STATUS_DIRECTIVE_MARKER, /^<!--.*-->$/);
});

test('appendStatusDirective keeps the original text first and the directive last', () => {
  const out = appendStatusDirective('abc');
  assert.ok(out.startsWith('abc'), 'original text must lead');
  assert.ok(out.endsWith(STATUS_DIAGRAM_DIRECTIVE), 'directive must be last');
});

test('appendStatusDirective trims trailing whitespace on the input', () => {
  assert.equal(appendStatusDirective('abc   \n\n'), `abc\n\n${STATUS_DIAGRAM_DIRECTIVE}`);
});

test('buildEscalatingFeedback ends with the directive and keeps the verdict sections', () => {
  const out = buildEscalatingFeedback('medium',
    { feedback: 'x', missing: ['m'], next_actions: ['n'] });
  assert.ok(out.endsWith(STATUS_DIAGRAM_DIRECTIVE), 'directive must be last');
  assert.ok(out.includes('### Missing'), 'Missing section preserved');
  assert.ok(out.includes('### Next Actions'), 'Next Actions section preserved');
});

// ---------------------------------------------------------------------------
// System-prompt injection (opencode `experimental.chat.system.transform`).
//
// That hook fires MORE THAN ONCE per user turn on opencode 1.17.9 (verified
// empirically against a real `opencode serve`), so appending must be
// idempotent or the model gets the same instruction two, four, six times.
// ---------------------------------------------------------------------------

describe('appendStatusDirectiveToSystem', () => {
  test('appends once and reports that it did', () => {
    const system = ['base prompt'];
    assert.equal(appendStatusDirectiveToSystem(system), true);
    assert.equal(system.length, 2);
    assert.equal(system[1], STATUS_DIAGRAM_DIRECTIVE);
  });

  test('is idempotent — a second call is a no-op', () => {
    const system = ['base prompt'];
    appendStatusDirectiveToSystem(system);
    assert.equal(appendStatusDirectiveToSystem(system), false, 'second call must not append');
    appendStatusDirectiveToSystem(system);
    appendStatusDirectiveToSystem(system);
    const copies = system.filter((s) => s.includes(STATUS_DIRECTIVE_MARKER)).length;
    assert.equal(copies, 1, 'exactly one copy of the directive may exist');
    assert.equal(system.length, 2);
  });

  test('detects the marker even when the entry was merged into a larger string', () => {
    // opencode collapses multiple pushed system entries into one joined
    // string after the hook returns, so a later call sees the directive
    // embedded mid-string, not as its own element.
    const system = ['base prompt', `something else\n\n${STATUS_DIAGRAM_DIRECTIVE}\n\ntrailing`];
    assert.equal(hasStatusDirective(system), true);
    assert.equal(appendStatusDirectiveToSystem(system), false);
    assert.equal(system.length, 2);
  });

  test('tolerates non-array and non-string entries without throwing', () => {
    assert.equal(appendStatusDirectiveToSystem(undefined), false);
    assert.equal(appendStatusDirectiveToSystem(null), false);
    assert.equal(appendStatusDirectiveToSystem('not an array'), false);
    assert.equal(hasStatusDirective(undefined), false);
    const mixed = [null, 42, { a: 1 }];
    assert.equal(appendStatusDirectiveToSystem(mixed), true);
    assert.equal(mixed.length, 4);
  });
});

// ---------------------------------------------------------------------------
// checkStatusCompliance — the deterministic, LLM-free gate that decides
// whether a "task complete" verdict actually did the status checkpoint.
// ---------------------------------------------------------------------------

describe('checkStatusCompliance', () => {
  let dir;
  const statusPath = () => join(dir, 'status.md');

  const setup = () => { dir = mkdtempSync(join(tmpdir(), 'status-compliance-')); };
  const teardown = () => { if (dir) rmSync(dir, { recursive: true, force: true }); };

  test('branch 1: compliant when the reply contains the roadmap block', (t) => {
    setup(); t.after(teardown);
    const res = checkStatusCompliance({
      lastAssistantText: 'ROADMAP  ███  1/3 done\n [~] 1. thing   <-- YOU ARE HERE',
      statusFilePath: statusPath(),   // does not exist — text alone must suffice
      turnStartedAtMs: Date.now(),
    });
    assert.equal(res.compliant, true);
    assert.match(res.reason, /roadmap/i);
  });

  test('branch 1: both anchors are required, not either', (t) => {
    setup(); t.after(teardown);
    // "roadmap" alone appears in ordinary prose all the time.
    const onlyRoadmap = checkStatusCompliance({
      lastAssistantText: 'I updated the roadmap for Q3 and shipped it.',
      statusFilePath: statusPath(),
      turnStartedAtMs: Date.now(),
    });
    assert.equal(onlyRoadmap.compliant, false);

    const onlyCursor = checkStatusCompliance({
      lastAssistantText: 'YOU ARE HERE now, at the end of the migration.',
      statusFilePath: statusPath(),
      turnStartedAtMs: Date.now(),
    });
    assert.equal(onlyCursor.compliant, false);
  });

  test('branch 2: compliant when status.md mtime is at/after the turn start', (t) => {
    setup(); t.after(teardown);
    const turnStartedAtMs = Date.now() - 60_000;
    writeFileSync(statusPath(), '# status\n');   // written now => fresh
    const res = checkStatusCompliance({
      lastAssistantText: 'Done. All tests pass.',
      statusFilePath: statusPath(),
      turnStartedAtMs,
    });
    assert.equal(res.compliant, true);
    assert.match(res.reason, /status\.md/);
  });

  test('branch 3: NOT compliant when status.md is stale (predates the turn)', (t) => {
    setup(); t.after(teardown);
    writeFileSync(statusPath(), '# status\n');
    // Backdate the file an hour; the turn started a minute ago.
    const hourAgoSec = Date.now() / 1000 - 3600;
    utimesSync(statusPath(), hourAgoSec, hourAgoSec);
    const res = checkStatusCompliance({
      lastAssistantText: 'Done. All tests pass.',
      statusFilePath: statusPath(),
      turnStartedAtMs: Date.now() - 60_000,
    });
    assert.equal(res.compliant, false);
    assert.match(res.reason, /not updated/i);
  });

  test('branch 4: NOT compliant when status.md is missing entirely', (t) => {
    setup(); t.after(teardown);
    const res = checkStatusCompliance({
      lastAssistantText: 'Done. All tests pass.',
      statusFilePath: statusPath(),
      turnStartedAtMs: Date.now(),
    });
    assert.equal(res.compliant, false);
    assert.match(res.reason, /missing/i);
  });

  test('fails OPEN: unknown turn start (0) lets any existing status.md count', (t) => {
    setup(); t.after(teardown);
    writeFileSync(statusPath(), '# status\n');
    const hourAgoSec = Date.now() / 1000 - 3600;
    utimesSync(statusPath(), hourAgoSec, hourAgoSec);
    // turnStartedAtMs unknown => must NOT manufacture a nag on a guess.
    const res = checkStatusCompliance({
      lastAssistantText: 'Done.',
      statusFilePath: statusPath(),
      turnStartedAtMs: 0,
    });
    assert.equal(res.compliant, true);
  });

  test('no path and no roadmap text is not compliant, and never throws', () => {
    assert.equal(checkStatusCompliance({}).compliant, false);
    assert.equal(checkStatusCompliance().compliant, false);
    assert.equal(
      checkStatusCompliance({ lastAssistantText: null, statusFilePath: null }).compliant,
      false
    );
  });
});

test('buildStatusCorrectionMessage is short, scoped, and ends with the directive', () => {
  const msg = buildStatusCorrectionMessage();
  assert.ok(msg.endsWith(STATUS_DIAGRAM_DIRECTIVE), 'directive must be last');
  assert.match(msg, /status\.md/);
  // Must not read as "start more work" — that is the loop this guards against.
  assert.match(msg, /Do not\s*\n?start new work/i);
});

// ---------------------------------------------------------------------------
// Toggle: `statusDiagram` is DEFAULT-OFF. Absent key => off. Only explicit
// true (`/supervisor status on`) enables. Both runtimes read the same key off the same file.
// ---------------------------------------------------------------------------

describe('statusDiagram toggle', () => {
  test('isStatusDiagramEnabled treats absent/undefined/false as OFF', () => {
    assert.equal(isStatusDiagramEnabled({}), false, 'absent key must default OFF');
    assert.equal(isStatusDiagramEnabled({ statusDiagram: undefined }), false);
    assert.equal(isStatusDiagramEnabled({ statusDiagram: false }), false);
    assert.equal(isStatusDiagramEnabled(undefined), false);
    assert.equal(isStatusDiagramEnabled(null), false);
  });

  test('only an explicit true enables it', () => {
    assert.equal(isStatusDiagramEnabled({ statusDiagram: true }), true);
    // Truthiness traps: these are NOT true, so they must stay OFF.
    assert.equal(isStatusDiagramEnabled({ statusDiagram: 1 }), false);
    assert.equal(isStatusDiagramEnabled({ statusDiagram: 'on' }), false);
  });

  test('setStatusDiagram(false) persists and load() reads it back', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'status-toggle-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const sid = 'ses_statustoggle';

    // Fresh session: nothing on disk, gate reads default-off.
    assert.equal(isStatusDiagramEnabled(goalStore.load(cwd, sid)), false);

    goalStore.setStatusDiagram(cwd, sid, false);
    assert.equal(goalStore.load(cwd, sid).statusDiagram, false);
    assert.equal(isStatusDiagramEnabled(goalStore.load(cwd, sid)), false);

    goalStore.setStatusDiagram(cwd, sid, true);
    assert.equal(goalStore.load(cwd, sid).statusDiagram, true);
    assert.equal(isStatusDiagramEnabled(goalStore.load(cwd, sid)), true);
  });

  test('the toggle does not clobber unrelated session state', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'status-toggle2-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const sid = 'ses_statuskeep';
    goalStore.setRetry(cwd, sid, 9);
    goalStore.setStatusDiagram(cwd, sid, false);
    const state = goalStore.load(cwd, sid);
    assert.equal(state.maxAttempts, 9, 'retry budget must survive the status toggle');
    assert.equal(state.statusDiagram, false);
  });
});

// ---------------------------------------------------------------------------
// One-shot correction bookkeeping.
//
// Mirrors the Map the plugin keeps (statusCorrectionSent: sessionId ->
// lastUserMsgId). The invariant under test is the one that makes a loop
// impossible: at most ONE correction per human turn, forever — including
// after the agent replies and a fresh session.idle re-enters the same branch.
// ---------------------------------------------------------------------------

describe('one-shot status correction gate', () => {
  /** The exact predicate + write the plugin performs, isolated. */
  function shouldSend(map, sessionId, lastUserMsgId) {
    return map.get(sessionId) !== lastUserMsgId;
  }
  function markSent(map, sessionId, lastUserMsgId) {
    map.set(sessionId, lastUserMsgId);
  }

  test('fires once, then never again for the same turn', () => {
    const sent = new Map();
    const sid = 'ses_a';
    const turn = 'msg_1';

    assert.equal(shouldSend(sent, sid, turn), true, 'first idle on this turn must fire');
    markSent(sent, sid, turn);

    // The agent replies -> new session.idle -> same lastUserMsgId (the
    // correction itself carries FEEDBACK_MARKER, so it is not a "relevant"
    // user message and the turn key does not move).
    assert.equal(shouldSend(sent, sid, turn), false, 'second idle on the same turn must NOT fire');
    assert.equal(shouldSend(sent, sid, turn), false, 'and stays off however many idles follow');
  });

  test('re-arms on a genuinely new human turn', () => {
    const sent = new Map();
    const sid = 'ses_a';
    markSent(sent, sid, 'msg_1');
    assert.equal(shouldSend(sent, sid, 'msg_1'), false);
    assert.equal(shouldSend(sent, sid, 'msg_2'), true, 'a new user message re-arms the gate');
  });

  test('is scoped per session — one session does not silence another', () => {
    const sent = new Map();
    markSent(sent, 'ses_a', 'msg_1');
    assert.equal(shouldSend(sent, 'ses_b', 'msg_1'), true);
  });
});
