import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  sanitizeCwd, isDisabled, endsWithTrailingQuestion, computeTurnKey,
  extractFinalAssistantText, readTurnRecord, writeTurnRecord, alreadyFiredThisTurn,
  supervisorGoalActive, supervisorRecentlyBlocked, shouldCallLlm, isConfirmedVerbose,
  PLAINSPEAK_MARKER,
} from '../bin/plainspeak-on-stop.mjs';
import { FEEDBACK_MARKER, SELF_ASSESSMENT_MARKER } from '../core/evaluation.mjs';
import { statePath, verdictsPath, ensureSessionDir } from '../core/session-store.mjs';

function mkcwd() {
  return fs.mkdtempSync(path.join(tmpdir(), 'plainspeak-test-'));
}

// ---------------------------------------------------------------------------
// sanitizeCwd / isDisabled
// ---------------------------------------------------------------------------

test('sanitizeCwd: accepts an absolute, resolved path; rejects everything else', () => {
  const d = mkcwd();
  assert.equal(sanitizeCwd(d), d);
  assert.equal(sanitizeCwd('relative/path'), null);
  assert.equal(sanitizeCwd(`${d}/../foo`), null);
  assert.equal(sanitizeCwd(undefined), null);
  assert.equal(sanitizeCwd(42), null);
});

test('isDisabled: env var kill switch', () => {
  const d = mkcwd();
  const orig = process.env.PLAINSPEAK_DISABLED;
  process.env.PLAINSPEAK_DISABLED = '1';
  try {
    assert.equal(isDisabled(d), true);
  } finally {
    if (orig === undefined) delete process.env.PLAINSPEAK_DISABLED; else process.env.PLAINSPEAK_DISABLED = orig;
  }
});

test('isDisabled: file kill switch, independent of env var', () => {
  const d = mkcwd();
  assert.equal(isDisabled(d), false);
  fs.mkdirSync(path.join(d, '.plainspeak'), { recursive: true });
  fs.writeFileSync(path.join(d, '.plainspeak', 'disabled'), '');
  assert.equal(isDisabled(d), true);
});

// ---------------------------------------------------------------------------
// endsWithTrailingQuestion
// ---------------------------------------------------------------------------

test('endsWithTrailingQuestion: true only when the last non-empty line ends in ?', () => {
  assert.equal(endsWithTrailingQuestion('Fixed it.\n\nWant a test too?'), true);
  assert.equal(endsWithTrailingQuestion('Should I proceed?\n'), true, 'trailing blank line ignored');
  assert.equal(endsWithTrailingQuestion('Is this right? Yes.'), false);
  assert.equal(endsWithTrailingQuestion(''), false);
  assert.equal(endsWithTrailingQuestion(null), false);
});

// ---------------------------------------------------------------------------
// computeTurnKey — must skip supervisor's markers AND plainspeak's own
// ---------------------------------------------------------------------------

test('computeTurnKey: fingerprints the last genuine user message', () => {
  const tail = [
    { type: 'user', message: { content: 'fix the bug' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  ];
  assert.equal(computeTurnKey(tail), 'fix the bug');
});

test('computeTurnKey: skips supervisor-injected text, resolves to the real message underneath', () => {
  const tail = [
    { type: 'user', message: { content: 'fix the bug' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
    { type: 'user', message: { content: `${FEEDBACK_MARKER} Task Incomplete\nsome injected text` } },
  ];
  assert.equal(computeTurnKey(tail), 'fix the bug');
});

test('computeTurnKey: skips plainspeak-injected text and the self-assessment marker too', () => {
  const tail = [
    { type: 'user', message: { content: 'fix the bug' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', message: { content: `${PLAINSPEAK_MARKER} Rewrite. Same facts, fewer words.` } },
    { type: 'user', message: { content: `${SELF_ASSESSMENT_MARKER}\n{}` } },
  ];
  assert.equal(computeTurnKey(tail), 'fix the bug');
});

test('computeTurnKey: returns null when no genuine user message is found', () => {
  assert.equal(computeTurnKey([]), null);
  assert.equal(computeTurnKey([{ type: 'user', message: { content: `${FEEDBACK_MARKER} only injected text` } }]), null);
});

// ---------------------------------------------------------------------------
// extractFinalAssistantText
// ---------------------------------------------------------------------------

test('extractFinalAssistantText: prefers payload.last_assistant_message', () => {
  assert.equal(extractFinalAssistantText({ last_assistant_message: 'from payload' }, []), 'from payload');
});

test('extractFinalAssistantText: falls back to scanning the transcript tail', () => {
  const tail = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'user', message: { content: 'more please' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } },
  ];
  assert.equal(extractFinalAssistantText({}, tail), 'final answer');
});

test('extractFinalAssistantText: empty when neither source has text', () => {
  assert.equal(extractFinalAssistantText({}, []), '');
});

// ---------------------------------------------------------------------------
// one-rewrite-per-turn hard cap
// ---------------------------------------------------------------------------

test('turn record round-trips and gates a second fire on the same turn', () => {
  const d = mkcwd();
  assert.equal(alreadyFiredThisTurn('s1', 'turn-a', d), false);
  writeTurnRecord('s1', 'turn-a', d);
  assert.equal(readTurnRecord('s1', d).turn_key, 'turn-a');
  assert.equal(alreadyFiredThisTurn('s1', 'turn-a', d), true, 'second Stop for the same turn must be capped');
  assert.equal(alreadyFiredThisTurn('s1', 'turn-b', d), false, 'a new turn key is a new turn');
});

test('alreadyFiredThisTurn: an unknown turn key (null) is always treated as already-used', () => {
  const d = mkcwd();
  assert.equal(alreadyFiredThisTurn('s1', null, d), true);
});

// ---------------------------------------------------------------------------
// supervisor coexistence guard
// ---------------------------------------------------------------------------

test('supervisorGoalActive: true when autopilot is on', () => {
  const d = mkcwd();
    ensureSessionDir(d, 's1');
    fs.writeFileSync(statePath(d, 's1'), JSON.stringify({ autopilot: true }));
  assert.equal(supervisorGoalActive(d, 's1'), true);
});

test('supervisorGoalActive: true when a goal is active', () => {
  const d = mkcwd();
    ensureSessionDir(d, 's1');
    fs.writeFileSync(statePath(d, 's1'), JSON.stringify({ goal: { status: 'active' } }));
  assert.equal(supervisorGoalActive(d, 's1'), true);
});

test('supervisorGoalActive: false when supervisor state is absent or idle', () => {
  const d = mkcwd();
  assert.equal(supervisorGoalActive(d, 'no-such-session'), false);
    ensureSessionDir(d, 's2');
    fs.writeFileSync(statePath(d, 's2'), JSON.stringify({ goal: { status: 'achieved' } }));
  assert.equal(supervisorGoalActive(d, 's2'), false);
});

test('supervisorRecentlyBlocked: true only for a fresh, injected:true verdict written at/after sinceMs', () => {
  const d = mkcwd();
  ensureSessionDir(d, 's1');
  const p = verdictsPath(d, 's1');
  const sinceMs = Date.now();
  fs.writeFileSync(p, JSON.stringify({ injected: true }));
  assert.equal(supervisorRecentlyBlocked(d, 's1', sinceMs), true);
});

test('supervisorRecentlyBlocked: false when the fresh verdict did not block (injected:false)', () => {
  const d = mkcwd();
  ensureSessionDir(d, 's1');
  const p = verdictsPath(d, 's1');
  const sinceMs = Date.now();
  fs.writeFileSync(p, JSON.stringify({ injected: false }));
  assert.equal(supervisorRecentlyBlocked(d, 's1', sinceMs), false);
});

test('supervisorRecentlyBlocked: false for a stale verdict (written well before sinceMs)', () => {
  const d = mkcwd();
  ensureSessionDir(d, 's1');
  const p = verdictsPath(d, 's1');
  fs.writeFileSync(p, JSON.stringify({ injected: true }));
  const farFuture = Date.now() + 60_000; // simulate "this hook started 60s after that write"
  assert.equal(supervisorRecentlyBlocked(d, 's1', farFuture), false);
});

test('supervisorRecentlyBlocked: false when no verdict file exists', () => {
  const d = mkcwd();
  assert.equal(supervisorRecentlyBlocked(d, 'no-such-session', Date.now()), false);
});

// ---------------------------------------------------------------------------
// LLM-routing decision (shouldCallLlm) and final confirmation (isConfirmedVerbose)
// ---------------------------------------------------------------------------

test('shouldCallLlm: never re-asks a deterministically confirmed verbose verdict', () => {
  assert.equal(shouldCallLlm({ verdict: 'verbose', stats: { proseWords: 500 } }), false);
});

test('shouldCallLlm: always calls the LLM on a suspect verdict', () => {
  assert.equal(shouldCallLlm({ verdict: 'suspect', stats: { proseWords: 10 } }), true);
});

test('shouldCallLlm: terse below the short-reply floor never calls the LLM', () => {
  assert.equal(shouldCallLlm({ verdict: 'terse', stats: { proseWords: 10 } }), false);
});

test('shouldCallLlm: terse at/above the floor calls the LLM by default (recall over cost, per calibration data)', () => {
  assert.equal(shouldCallLlm({ verdict: 'terse', stats: { proseWords: 200 } }), true);
});

test('shouldCallLlm: PLAINSPEAK_STRICT_TERSE_EXIT=1 restores the literal "skip LLM on any terse" behavior', () => {
  const orig = process.env.PLAINSPEAK_STRICT_TERSE_EXIT;
  process.env.PLAINSPEAK_STRICT_TERSE_EXIT = '1';
  try {
    assert.equal(shouldCallLlm({ verdict: 'terse', stats: { proseWords: 200 } }), false);
    assert.equal(shouldCallLlm({ verdict: 'suspect', stats: { proseWords: 200 } }), true, 'suspect is unaffected by strict mode');
  } finally {
    if (orig === undefined) delete process.env.PLAINSPEAK_STRICT_TERSE_EXIT; else process.env.PLAINSPEAK_STRICT_TERSE_EXIT = orig;
  }
});

test('isConfirmedVerbose: deterministic verbose is always confirmed, no llmJudge needed', () => {
  assert.equal(isConfirmedVerbose({ verdict: 'verbose' }, null), true);
});

test('isConfirmedVerbose: suspect requires the llmJudge to say verbose', () => {
  assert.equal(isConfirmedVerbose({ verdict: 'suspect' }, { verdict: 'verbose' }), true);
  assert.equal(isConfirmedVerbose({ verdict: 'suspect' }, { verdict: 'terse' }), false);
  assert.equal(isConfirmedVerbose({ verdict: 'suspect' }, null), false);
});

test('isConfirmedVerbose: terse is never confirmed', () => {
  assert.equal(isConfirmedVerbose({ verdict: 'terse' }, { verdict: 'verbose' }), false);
});
