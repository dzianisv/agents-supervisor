import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalatingFeedback } from '../core/feedback.mjs';

// ---------------------------------------------------------------------------
// buildEscalatingFeedback — tone coverage (Fix B) + no-static-override
// contract (align-supervisor-modes).
//
// Policy under test: no attempt-count escalation tiers (never "Final
// Attempt" / "LAST chance" / urgent-escalation wording, regardless of how
// close attemptCount is to the cap); confidence-aware framing when the
// judge itself was unsure; destructive git/filesystem actions never appear
// as ordinary agent-actionable work; and — the reflection mode is the SOLE
// completion authority — this function must never substitute a
// deterministic "STOP: Planning/Action Loop Detected" script for the
// judge's own verdict. buildEscalatingFeedback's signature no longer accepts
// isPlanningLoop/isActionLoop flags at all: there is no code path left that
// can produce that canned text.
// ---------------------------------------------------------------------------

test('never emits "Final Attempt" or "LAST chance" wording, even at the last attempt before the cap', () => {
  const verdict = { missing: ['Run the test suite'], next_actions: [], feedback: 'tests not run yet' };
  // effectiveCap=3: attemptCount=2 is the old off-by-one boundary that used
  // to trigger the "Final Attempt" tier (attemptCount < effectiveCap - 1 was
  // false at 2 < 2).
  const out = buildEscalatingFeedback(2, 'HIGH', verdict, 3);
  assert.doesNotMatch(out, /Final Attempt/i);
  assert.doesNotMatch(out, /LAST chance/i);
  assert.doesNotMatch(out, /asked \d+ times/i);
  assert.match(out, /Task Incomplete/);
});

test('never emits tiered wording even once attemptCount reaches/exceeds the cap', () => {
  const verdict = { missing: ['Run the test suite'], next_actions: [], feedback: 'tests not run yet' };
  const atCap = buildEscalatingFeedback(3, 'HIGH', verdict, 3);
  const overCap = buildEscalatingFeedback(5, 'HIGH', verdict, 3);
  for (const out of [atCap, overCap]) {
    assert.doesNotMatch(out, /Final Attempt/i);
    assert.doesNotMatch(out, /LAST chance/i);
    assert.doesNotMatch(out, /supervisor stops/i);
  }
});

test('low confidence (< 0.7) uses "may be incomplete" framing, not an assertion', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.4 };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, 5);
  assert.match(out, /may be incomplete/i);
  assert.match(out, /not fully confident/i);
});

test('confidence >= 0.7 keeps the normal assertive "Task Incomplete" framing', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.9 };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, 5);
  assert.match(out, /Task Incomplete/);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('missing confidence field (backward compat, e.g. opencode autopilot loop verdicts) defaults to normal framing', () => {
  const verdict = { missing: [], next_actions: [], feedback: 'Autopilot loop detected — take concrete action.' };
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, 5);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('destructive missing/next_actions items are rewritten to a user-approval flag, not pushed as agent work', () => {
  const verdict = {
    missing: ['Force-push the branch to update the remote', 'Run the full test suite'],
    next_actions: ['git push --force origin main'],
    feedback: '',
  };
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, 5);
  assert.match(out, /Flag to the user for approval: Force-push the branch to update the remote/);
  assert.match(out, /Flag to the user for approval: git push --force origin main/);
  // Non-destructive item passes through unchanged.
  assert.match(out, /- Run the full test suite/);
});

test('destructive-action patterns: reset --hard, history rewrite, branch delete, rm -rf', () => {
  const verdict = {
    missing: [
      'Run git reset --hard to discard local changes',
      'Rewrite git history to remove the secret',
      'Delete the old feature branch',
      'rm -rf the build directory and retry',
    ],
    next_actions: [],
    feedback: '',
  };
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, 5);
  assert.match(out, /Flag to the user for approval: Run git reset --hard to discard local changes/);
  assert.match(out, /Flag to the user for approval: Rewrite git history to remove the secret/);
  assert.match(out, /Flag to the user for approval: Delete the old feature branch/);
  assert.match(out, /Flag to the user for approval: rm -rf the build directory and retry/);
});

test('non-destructive items are never rewritten', () => {
  const verdict = { missing: ['Push the commit to the feature branch', 'Add a unit test'], next_actions: [], feedback: '' };
  const out = buildEscalatingFeedback(1, 'LOW', verdict, 5);
  assert.doesNotMatch(out, /Flag to the user for approval/);
  assert.match(out, /- Push the commit to the feature branch/);
  assert.match(out, /- Add a unit test/);
});

test('signature no longer accepts isPlanningLoop/isActionLoop: extra positional args are ignored, never produce STOP override text', () => {
  // Simulate a caller still passing the old (removed) positional args by
  // accident — buildEscalatingFeedback(attemptCount, severity, verdict, maxAttempts)
  // reads its 4th parameter as maxAttempts, so passing `true` there must NOT
  // resurrect any loop-detection behavior (there is none left to resurrect).
  const out = buildEscalatingFeedback(1, 'HIGH', { missing: ['Do the thing'], next_actions: [], feedback: '' }, /* maxAttempts */ true);
  assert.doesNotMatch(out, /STOP: Planning Loop Detected/);
  assert.doesNotMatch(out, /STOP: Action Loop Detected/);
  assert.doesNotMatch(out, /\bSTOP\b/);
});

test('no static STOP/planning-loop/action-loop override exists for any verdict shape, including an empty verdict', () => {
  // An empty/near-empty verdict used to be exactly the shape passed alongside
  // isPlanningLoop=true in the old call sites. With the override removed,
  // this must render the calm generic template — never the canned STOP text.
  const out = buildEscalatingFeedback(1, 'HIGH', {}, 5);
  assert.doesNotMatch(out, /STOP: Planning Loop Detected/);
  assert.doesNotMatch(out, /STOP: Action Loop Detected/);
  assert.doesNotMatch(out, /DO NOT:/);
  assert.doesNotMatch(out, /Start coding NOW/);
  assert.match(out, /Task Incomplete|may be incomplete/);
});

test('Missing/Next Actions sections still render as bulleted lists', () => {
  const verdict = { missing: ['A', 'B'], next_actions: ['C'], feedback: 'reason text' };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, 5);
  assert.match(out, /### Missing\n- A\n- B/);
  assert.match(out, /### Next Actions\n- C/);
});
