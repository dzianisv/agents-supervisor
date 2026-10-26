import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionStore, statePath } from '../core/session-store.mjs';
import { goalStore, writeProjectGoal, readProjectGoalContract } from '../core/goal.mjs';
import { hashFocusGoalContract, hashFocusText, isFocusFresh, FocusPolicyError } from '../core/focus.mjs';
import { bindFocus, invalidateFocus, recordFocusQuotes, claimFocusCorrection, setFocusHold, clearFocusHold, focusStamp } from '../core/focus-state.mjs';

const sid = 'pi-full-session-123456789';
function fixture(t, { bind = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-focus-state-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  goalStore.setGoal(cwd, sid, 'Repair current and report observations honestly.', {
    source: 'user', acceptanceCriteria: 'Current repaired, missing quotas marked unknown.', verification: 'Inspect current and report results.',
  });
  sessionStore.mutate(cwd, sid, (s) => {
    s.statusDiagram = true; s.plainspeak = false; s.maxAttempts = 7;
    s.unrelated = { keep: ['all', 'fields'] };
  });
  const expectedGoal = sessionStore.load(cwd, sid).goal;
  const originalText = 'Repair current; read old only for context. Use ./scripts/ssh.';
  const meta = {
    version: 1, runtime: 'pi', sessionId: sid, goalId: expectedGoal.id, contractHash: hashFocusGoalContract(expectedGoal),
    origin: { receiptId: 'receipt-1', originalUserEntryId: 'user-1', originalText,
      originalTextHash: hashFocusText(originalText), ingress: 'interactive', authority: 'operator-ingress', constraintSpans: [] },
    branch: { markerEntryId: 'marker-1', epoch: 1 }, human: { entryId: 'user-1', epoch: 1, turnKey: 'turn-1' }, generation: 1,
    temporaryWork: [],
  };
  if (bind) assert.deepEqual(bindFocus(cwd, sid, { expectedGoal, meta }), { bound: true });
  const load = () => sessionStore.load(cwd, sid);
  const stamp = (activityId = 'batch-1') => focusStamp(load().focus, activityId);
  const claim = (activityId = 'batch-1', extra = {}) => claimFocusCorrection(cwd, sid, {
    expectedGoal, stamp: stamp(activityId), key: `correction-${activityId}`, maxAttempts: 7, ...extra,
  });
  return { cwd, expectedGoal, meta, load, stamp, claim };
}
function preserved(f, before) {
  const after = f.load();
  for (const key of ['statusDiagram', 'plainspeak', 'maxAttempts', 'unrelated']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.goal.id, before.goal.id);
  assert.equal(after.goal.condition, before.goal.condition);
  assert.equal(after.goal.acceptanceCriteria, before.goal.acceptanceCriteria);
  assert.equal(after.goal.verification, before.goal.verification);
  assert.equal(after.goal.source, before.goal.source);
  assert.equal(after.goal.deadline, before.goal.deadline);
}

for (const status of ['active', 'paused', 'exhausted']) test(`accepted non-work quotes persist while ${status}, without lifecycle/counter mutation`, t => {
  const f = fixture(t); f.claim();
  sessionStore.mutate(f.cwd, sid, s => { s.goal.status = status; });
  const before = f.load();
  const quotes = [{ entryId: 'user-clarification', text: 'Do not send logs externally.' }];
  assert.equal(recordFocusQuotes(f.cwd, sid, { expectedGoal: before.goal, stamp: f.stamp(), quotes }).recorded, true);
  const after = f.load();
  assert.deepEqual(after.goal, before.goal); assert.deepEqual(after.attempts, before.attempts);
  assert.deepEqual(after.focus.human, before.focus.human); assert.deepEqual(after.focus.origin.constraintSpans, quotes);
  assert.equal(after.focus.generation, before.focus.generation + 1); preserved(f, before);
  assert.deepEqual(sessionStore.load(f.cwd, sid).focus.origin.constraintSpans, quotes, 'Quote is durable, not an in-memory resume buffer');
});

test('quote recording rejects stale/replaced contracts and duplicate authority instead of rewriting it', t => {
  const f = fixture(t), old = f.stamp(), quote = { entryId: 'later-user', text: 'Do not deploy.' };
  assert.equal(recordFocusQuotes(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: old, quotes: [quote] }).recorded, true);
  const before = f.load();
  assert.equal(recordFocusQuotes(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: old, quotes: [{ ...quote, text: 'Deploy.' }] }).recorded, false);
  assert.equal(recordFocusQuotes(f.cwd, sid, { expectedGoal: { ...f.expectedGoal, condition: 'Different mission' }, stamp: f.stamp(), quotes: [] }).recorded, false);
  assert.throws(() => recordFocusQuotes(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: f.stamp(), quotes: [quote, quote] }), FocusPolicyError);
  assert.deepEqual(f.load(), before);
});

test('binding is additive, private 0600 state through the existing store; no transcript/project storage', (t) => {
  const f = fixture(t, { bind: false });
  const before = f.load();
  assert.deepEqual(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta }), { bound: true });
  assert.deepEqual(f.load().focus, f.meta);
  assert.deepEqual(f.load().goal, before.goal);
  preserved(f, before);
  assert.equal(fs.statSync(statePath(f.cwd, sid)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.cwd, '.agents')), false);
  f.meta.origin.originalText = 'caller mutation';
  assert.notEqual(f.load().focus.origin.originalText, 'caller mutation', 'persisted metadata must be detached');
});

test('idempotent binding cannot rewrite original, drop a hold or reset correction accounting', (t) => {
  const f = fixture(t);
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta }).bound, true);
  const changed = structuredClone(f.meta);
  changed.origin.originalText = 'agent summary replaces request';
  changed.origin.originalTextHash = hashFocusText(changed.origin.originalText);
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: changed }).bound, false);
  f.claim();
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta }).bound, false);
  setFocusHold(f.cwd, sid, { stamp: f.stamp(), reason: 'Need target identity.' });
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta }).bound, false);
  assert.ok(f.load().focus.hold);
  assert.equal(f.load().attempts.count, 1);
});

for (const field of ['id', 'condition', 'acceptanceCriteria', 'verification', 'source', 'startedAt', 'status', 'deadline']) {
  test(`bind rechecks full current goal inside mutation: changed ${field}`, (t) => {
    const f = fixture(t, { bind: false });
    sessionStore.mutate(f.cwd, sid, (s) => {
      s.goal[field] = field === 'source' ? 'agent' : field === 'status' ? 'paused'
        : typeof s.goal[field] === 'number' ? s.goal[field] + 1 : `${s.goal[field]}!`;
    });
    const before = f.load();
    assert.notEqual(before.goal[field], f.expectedGoal[field], 'the persisted contract must actually differ after normalization');
    assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta }).bound, false);
    assert.deepEqual(f.load(), before);
  });
}

test('bind rejects foreign session/goal/hash, missing receipt, forged text hash, inherited history and lifecycle state', (t) => {
  const f = fixture(t, { bind: false });
  const variants = [
    { ...f.meta, sessionId: `${sid}-fork` }, { ...f.meta, goalId: 'other-goal' },
    { ...f.meta, contractHash: 'wrong' }, { ...f.meta, runtime: 'other' },
    { ...f.meta, origin: { ...f.meta.origin, originalTextHash: 'wrong' } },
    { ...f.meta, origin: { ...f.meta.origin, originalUserEntryId: '' } },
    { ...f.meta, origin: { ...f.meta.origin, authority: 'agent-message' } },
    { ...f.meta, hold: { activityId: 'old', reason: 'old', since: 'old' } },
    { ...f.meta, correctionActivities: ['old'] }, { ...f.meta, generation: -1 },
  ];
  for (const meta of variants) assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta }).bound, false);
  assert.equal(f.load().focus, undefined);
  for (const status of ['paused', 'exhausted', 'achieved', 'cleared']) {
    sessionStore.mutate(f.cwd, sid, (s) => { s.goal.status = status; });
    assert.equal(bindFocus(f.cwd, sid, { expectedGoal: f.load().goal, meta: { ...f.meta, contractHash: hashFocusGoalContract(f.load().goal) } }).bound, false);
  }
});

test('project fallback without a real session ID is untouched and never materialized', (t) => {
  const f = fixture(t, { bind: false });
  goalStore.clearGoal(f.cwd, sid);
  writeProjectGoal(f.cwd, 'User project mission', { acceptanceCriteria: 'All customers audited.', verification: 'Read report.' });
  const project = readProjectGoalContract(f.cwd);
  const file = path.join(f.cwd, '.agents', 'supervisor', 'Goal.md');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: project, meta: f.meta }).bound, false);
  assert.equal(f.load().goal, undefined);
  assert.equal(f.load().goalCleared, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'tree navigation' }), null);
});

test('replacement needs fresh canonical identity and greater generation; no attempt reset', (t) => {
  const f = fixture(t);
  f.claim();
  goalStore.setGoal(f.cwd, sid, 'New explicit operator mission', { source: 'user' });
  const replacement = f.load().goal;
  const meta = { ...structuredClone(f.meta), goalId: replacement.id, contractHash: hashFocusGoalContract(replacement) };
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: replacement, meta }).bound, false);
  meta.generation++;
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal: replacement, meta }).bound, true);
  assert.equal(f.load().attempts.count, 1, 'binding itself cannot reset shared turn count');
  assert.equal(f.claim().claimed, false, 'old expected declaration cannot mutate replacement');
});

test('explicit shared resume can reanchor its extended deadline without rewriting receipt or clearing a hold', (t) => {
  const f = fixture(t);
  f.claim('A');
  setFocusHold(f.cwd, sid, { stamp: f.stamp('A'), reason: 'Need explicit clarification.' });
  const prior = f.load().focus;
  assert.equal(goalStore.pauseGoal(f.cwd, sid, { expectedGoal: f.expectedGoal, reason: 'stuck' }).paused, true);
  const resumed = goalStore.resumeGoal(f.cwd, sid, { now: f.expectedGoal.deadline + 1 });
  assert.equal(resumed.resumed, true);
  const expectedGoal = f.load().goal;
  assert.notEqual(hashFocusGoalContract(expectedGoal), prior.contractHash);
  const meta = { ...structuredClone(prior), contractHash: hashFocusGoalContract(expectedGoal), generation: prior.generation + 1 };
  delete meta.hold; delete meta.lastCorrection; delete meta.correctionActivities;
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal, meta }).bound, true);
  assert.deepEqual(f.load().focus.hold, prior.hold);
  assert.deepEqual(f.load().focus.correctionActivities, prior.correctionActivities);
  assert.deepEqual(f.load().focus.origin, prior.origin);
  assert.equal(clearFocusHold(f.cwd, sid, { expectedGoal, stamp: f.stamp(), authorized: true }).cleared, true);
});

test('invalidation advances generation, preserves original/goal/counters and fences pending approvals', (t) => {
  const f = fixture(t);
  f.claim();
  const before = f.load();
  const oldStamp = f.stamp();
  const m = invalidateFocus(f.cwd, sid, { reason: 'abort or compaction', stamp: oldStamp, expectedGoal: f.expectedGoal });
  assert.equal(m.generation, before.focus.generation + 1);
  assert.deepEqual(m.origin, before.focus.origin);
  assert.deepEqual(f.load().attempts, before.attempts);
  assert.equal(isFocusFresh(oldStamp, f.stamp()), false);
  assert.equal(f.claim('batch-2', { stamp: oldStamp }).claimed, false);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'late callback', stamp: oldStamp }), null);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'missing callback identity', stamp: null }), null);
  preserved(f, before);
  m.origin.originalText = 'changed returned copy';
  assert.notEqual(f.load().focus.origin.originalText, m.origin.originalText);
});

test('new genuine human resets the ONE counter and mirror; status/generated invalidation does not', (t) => {
  const f = fixture(t);
  f.claim('batch-1'); f.claim('batch-2');
  invalidateFocus(f.cwd, sid, { reason: 'status/control/compaction' });
  assert.equal(f.load().attempts.count, 2);
  assert.equal(f.load().goal.attempts, 2);
  const before = f.load();
  const nextHuman = { entryId: 'user-2', epoch: 2, turnKey: 'turn-2' };
  invalidateFocus(f.cwd, sid, { reason: 'accepted operator work turn', nextHuman });
  assert.equal(sessionStore.readAttempts(f.cwd, sid, 'turn-2'), 0);
  assert.equal(f.load().goal.attempts, 0);
  assert.equal(f.load().goal.lastTurnKey, 'turn-2');
  assert.equal(f.load().focus.correctionActivities, undefined);
  assert.equal(f.claim('batch-1').count, 1, 'same activity label on a new human turn has fresh accounting');
  preserved(f, before);
});

test('branch navigation invalidates without restarting the mission or resetting turn accounting', (t) => {
  const f = fixture(t);
  f.claim();
  const before = f.load();
  const m = invalidateFocus(f.cwd, sid, { reason: 'same-anchor tree navigation', nextBranch: { markerEntryId: 'marker-2', epoch: 2 } });
  assert.equal(m.branch.epoch, 2);
  assert.equal(m.branch.markerEntryId, 'marker-2');
  assert.deepEqual(f.load().attempts, before.attempts);
  assert.deepEqual(m.origin, before.focus.origin);
  preserved(f, before);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'older branch', nextBranch: { markerEntryId: 'marker-1', epoch: 1 } }), null);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'same epoch different turn', nextHuman: { entryId: 'u2', epoch: 1, turnKey: 't2' } }), null);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'fake new turn', nextHuman: { entryId: 'user-1', epoch: 2, turnKey: 'turn-2' } }), null);
});

test('later constraints append quotations without rewriting original; detours are annotations only', (t) => {
  const f = fixture(t);
  const before = f.load();
  const span = { entryId: 'user-2', text: 'Also redact secrets in the report.' };
  const m = invalidateFocus(f.cwd, sid, { reason: 'accepted constraints', appendConstraints: [span],
    temporaryWork: [{ authorizationEntryId: 'user-2', description: 'Local report redaction only.' }] });
  assert.equal(m.origin.originalText, before.focus.origin.originalText);
  assert.equal(m.origin.originalTextHash, before.focus.origin.originalTextHash);
  assert.deepEqual(m.origin.constraintSpans, [span]);
  assert.equal(m.generation, 2);
  assert.deepEqual(f.load().goal, before.goal);
});

test('same batch siblings cost one, even interleaved A/B/A; different batches and settlement share counter', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.claim('A', { key: 'sibling-1' }), { claimed: true, count: 1 });
  assert.deepEqual(f.claim('A', { key: 'sibling-2' }), { claimed: false, count: 1, reason: 'duplicate' });
  assert.deepEqual(f.claim('B'), { claimed: true, count: 2 });
  assert.deepEqual(f.claim('A', { key: 'late-sibling' }), { claimed: false, count: 2, reason: 'duplicate' });
  assert.deepEqual(f.claim('settlement-1'), { claimed: true, count: 3 });
  const state = f.load();
  assert.equal(sessionStore.readAttempts(f.cwd, sid, 'turn-1'), 3);
  assert.equal(state.goal.attempts, 3);
  assert.deepEqual(Object.keys(state.attempts).sort(), ['count', 'lastIso', 'turnKey']);
  assert.equal(state.attempts.turnKey, 'turn-1');
  assert.ok(Number.isFinite(Date.parse(state.attempts.lastIso)));
  assert.deepEqual(state.focus.correctionActivities, ['A', 'B', 'settlement-1']);
});

test('existing store writes and focus claims use one shared count (failed delivery has no refund)', (t) => {
  const f = fixture(t);
  sessionStore.writeAttempts(f.cwd, sid, 3, 'turn-1');
  assert.deepEqual(f.claim('batch-1'), { claimed: true, count: 4 });
  sessionStore.writeAttempts(f.cwd, sid, 5, 'turn-1');
  assert.deepEqual(f.claim('settlement-1'), { claimed: true, count: 6 });
  assert.equal(f.load().goal.attempts, 6);
  assert.deepEqual(f.claim('batch-1'), { claimed: false, count: 6, reason: 'duplicate' });
});

test('counter semantics carry null turn keys; real changed keys begin a new turn', (t) => {
  const f = fixture(t);
  sessionStore.mutate(f.cwd, sid, (s) => { s.attempts = { count: 3, turnKey: null, lastIso: null }; });
  assert.equal(f.claim('A').count, 4);
  sessionStore.mutate(f.cwd, sid, (s) => { s.attempts = { count: 7, turnKey: 'old-turn', lastIso: null }; });
  assert.equal(f.claim('B').count, 1);
  assert.equal(f.load().goal.attempts, 1);
});

test('ceiling skips leave contract active; duplicate at ceiling is still a duplicate, never an allow', (t) => {
  const f = fixture(t);
  const before = f.load();
  assert.equal(f.claim('A', { maxAttempts: 1 }).count, 1);
  assert.deepEqual(f.claim('B', { maxAttempts: 1 }), { claimed: false, count: 1, reason: 'attempts' });
  assert.deepEqual(f.claim('A', { maxAttempts: 1 }), { claimed: false, count: 1, reason: 'duplicate' });
  assert.equal(f.load().goal.status, 'active');
  preserved(f, before);
  assert.equal(f.claim('C', { maxAttempts: 'unlimited' }).count, 2);
  assert.equal(f.claim('D', { maxAttempts: Infinity }).count, 3);
  assert.equal(f.claim('E', { maxAttempts: 0 }).count, 4);
});

test('invalid limits reject loudly and malformed counters never reset into a free correction', (t) => {
  const f = fixture(t);
  for (const maxAttempts of [undefined, null, '', -1, 1.5, NaN, 'invalid']) {
    assert.throws(() => f.claim('A', { maxAttempts }), FocusPolicyError);
  }
  for (const attempts of [{ count: -1 }, { count: NaN }, { count: 1.5 }, { count: '3' }, { count: 1, turnKey: 12 }, []]) {
    // NaN serializes to null in the real store and must still be rejected.
    sessionStore.mutate(f.cwd, sid, (s) => { s.attempts = attempts; });
    assert.equal(f.claim('A').reason, 'invalid-counter');
  }
});

for (const field of ['sessionId', 'goalId', 'contractHash', 'branchEpoch', 'markerEntryId', 'humanEpoch', 'generation']) {
  test(`claim and hold reject stale/foreign stamp dimension ${field}`, (t) => {
    const f = fixture(t);
    const stamp = f.stamp();
    stamp[field] = typeof stamp[field] === 'number' ? stamp[field] + 1 : `${stamp[field]}-other`;
    const before = f.load();
    assert.equal(f.claim('batch-1', { stamp }).claimed, false);
    assert.equal(setFocusHold(f.cwd, sid, { stamp, reason: 'late hold' }).held, false);
    assert.deepEqual(f.load(), before);
  });
}

test('missing or empty activity stamps never claim; distinct nonempty activities spend separately', (t) => {
  const f = fixture(t);
  assert.equal(f.claim('A', { stamp: undefined }).claimed, false);
  assert.equal(f.claim('A', { stamp: { ...f.stamp(), activityId: '' } }).claimed, false);
  assert.equal(f.claim('A').claimed, true);
  assert.equal(f.claim('B').claimed, true);
});

test('canonical goal change, clear or pause makes pending correction and hold stale', (t) => {
  const f = fixture(t);
  const stamp = f.stamp();
  sessionStore.mutate(f.cwd, sid, (s) => { s.goal.deadline++; });
  assert.equal(f.claim('A', { stamp }).claimed, false);
  assert.equal(setFocusHold(f.cwd, sid, { stamp, reason: 'late' }).held, false);
  assert.equal(invalidateFocus(f.cwd, sid, { reason: 'stale anchor' }), null);
  goalStore.clearGoal(f.cwd, sid);
  assert.equal(f.claim('A', { stamp }).claimed, false);
  assert.equal(setFocusHold(f.cwd, sid, { stamp, reason: 'late' }).held, false);
  assert.equal(f.load().attempts, undefined);
  assert.equal(f.load().goalCleared, true);
});

test('expired deadline prevents claim without adding goal lifecycle semantics', (t) => {
  const f = fixture(t, { bind: false });
  sessionStore.mutate(f.cwd, sid, (s) => { s.goal.deadline = Date.now() - 1; });
  const expectedGoal = f.load().goal;
  const meta = { ...f.meta, contractHash: hashFocusGoalContract(expectedGoal) };
  assert.equal(bindFocus(f.cwd, sid, { expectedGoal, meta }).bound, true);
  assert.equal(f.claim('A', { expectedGoal }).reason, 'deadline');
  assert.equal(f.load().goal.status, 'active', 'only existing lifecycle helpers retire/pause goals');
  assert.equal(f.load().attempts, undefined);
});

test('hold persists independently, redacts displayed reason, spends no attempts and suppresses claims for every activity', (t) => {
  const f = fixture(t);
  const before = f.load();
  assert.equal(setFocusHold(f.cwd, sid, { stamp: f.stamp('A'), reason: 'Target unknown; password="fixture-secret"' }).held, true);
  const hold = f.load().focus.hold;
  assert.equal(hold.reason.includes('fixture-secret'), false);
  assert.ok(hold.reason.includes('[REDACTED]'));
  assert.ok(Number.isFinite(Date.parse(hold.since)));
  assert.equal(setFocusHold(f.cwd, sid, { stamp: f.stamp('B'), reason: 'different reason' }).held, true);
  assert.deepEqual(f.load().focus.hold, hold, 'first reason wins');
  assert.equal(f.claim('A').reason, 'held');
  assert.equal(f.claim('B').reason, 'held');
  invalidateFocus(f.cwd, sid, { reason: 'generated retry/abort' });
  assert.deepEqual(f.load().focus.hold, hold);
  invalidateFocus(f.cwd, sid, { reason: 'new genuine human', nextHuman: { entryId: 'u2', epoch: 2, turnKey: 't2' } });
  assert.deepEqual(f.load().focus.hold, hold, 'even a new human needs explicit adapter-authorized recovery');
  assert.equal(f.claim('C').reason, 'held');
  assert.equal(f.load().attempts.count, 0);
  preserved(f, before);
});

test('explicit recovery checks expected full goal and stamp, clears once, invalidates approvals, preserves attempts', (t) => {
  const f = fixture(t);
  f.claim();
  const beforeStamp = f.stamp();
  setFocusHold(f.cwd, sid, { stamp: beforeStamp, reason: 'Need target clarification.' });
  for (const options of [
    { authorized: false }, { authorized: undefined }, { expectedGoal: { ...f.expectedGoal, deadline: 1 } },
    { stamp: { ...beforeStamp, generation: 99 } },
  ]) assert.equal(clearFocusHold(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: beforeStamp, authorized: true, ...options }).cleared, false);
  assert.equal(clearFocusHold(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: beforeStamp, authorized: true }).cleared, true);
  assert.equal(f.load().focus.hold, undefined);
  assert.equal(f.load().focus.generation, beforeStamp.generation + 1);
  assert.equal(f.load().attempts.count, 1);
  assert.equal(f.claim('B', { stamp: beforeStamp }).claimed, false);
  assert.equal(f.claim('B').count, 2);
  assert.equal(clearFocusHold(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: f.stamp(), authorized: true }).cleared, false);
});

test('forked full session IDs do not inherit another session anchor or counter', (t) => {
  const f = fixture(t);
  const fork = `${sid}-fork`;
  sessionStore.save(f.cwd, fork, f.load()); // Simulate copied transcript/state, not an adoption.
  const stamp = { ...f.stamp(), sessionId: fork };
  assert.equal(claimFocusCorrection(f.cwd, fork, { expectedGoal: f.expectedGoal, stamp, key: 'x', maxAttempts: 7 }).claimed, false);
  assert.equal(setFocusHold(f.cwd, fork, { stamp, reason: 'unknown inheritance' }).held, false);
  assert.equal(invalidateFocus(f.cwd, fork, { reason: 'restore' }), null);
  assert.equal(sessionStore.load(f.cwd, fork).attempts, undefined);
  assert.throws(() => bindFocus(f.cwd, '../escape', { expectedGoal: f.expectedGoal, meta: f.meta }));
});

test('every facade write uses mutate and sees changes made immediately before the locked reload', (t) => {
  const f = fixture(t);
  const original = sessionStore.mutate;
  let mutations = 0;
  let inject = false;
  sessionStore.mutate = (cwd, sessionId, fn) => {
    mutations++;
    if (inject) {
      inject = false;
      original(cwd, sessionId, (s) => {
        s.unrelated.concurrent = true;
        s.goal.deadline++; // Not covered by sameGoalContract alone.
      });
    }
    return original(cwd, sessionId, fn);
  };
  t.after(() => { sessionStore.mutate = original; });
  const oldStamp = f.stamp();
  inject = true;
  assert.equal(f.claim('A', { stamp: oldStamp }).claimed, false);
  assert.equal(f.load().attempts, undefined);
  assert.equal(f.load().unrelated.concurrent, true);
  setFocusHold(f.cwd, sid, { stamp: oldStamp, reason: 'stale' });
  clearFocusHold(f.cwd, sid, { expectedGoal: f.expectedGoal, stamp: oldStamp, authorized: true });
  invalidateFocus(f.cwd, sid, { reason: 'stale' });
  bindFocus(f.cwd, sid, { expectedGoal: f.expectedGoal, meta: f.meta });
  assert.equal(mutations, 5);
  assert.equal(f.load().unrelated.concurrent, true);
});
