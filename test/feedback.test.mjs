import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalatingFeedback } from '../core/feedback.mjs';

// ---------------------------------------------------------------------------
// buildEscalatingFeedback — tone coverage (Fix B).
//
// Policy under test: no attempt-count escalation tiers (never "Final
// Attempt" / "LAST chance" / urgent-escalation wording, regardless of how
// close attemptCount is to the cap); confidence-aware framing when the
// judge itself was unsure; destructive git/filesystem actions never appear
// as ordinary agent-actionable work.
// ---------------------------------------------------------------------------

test('never emits "Final Attempt" or "LAST chance" wording, even at the last attempt before the cap', () => {
  const verdict = { missing: ['Run the test suite'], next_actions: [], feedback: 'tests not run yet' };
  // effectiveCap=3: attemptCount=2 is the old off-by-one boundary that used
  // to trigger the "Final Attempt" tier (attemptCount < effectiveCap - 1 was
  // false at 2 < 2).
  const out = buildEscalatingFeedback(2, 'HIGH', verdict, false, false, 3);
  assert.doesNotMatch(out, /Final Attempt/i);
  assert.doesNotMatch(out, /LAST chance/i);
  assert.doesNotMatch(out, /asked \d+ times/i);
  assert.match(out, /Task Incomplete/);
});

test('never emits tiered wording even once attemptCount reaches/exceeds the cap', () => {
  const verdict = { missing: ['Run the test suite'], next_actions: [], feedback: 'tests not run yet' };
  const atCap = buildEscalatingFeedback(3, 'HIGH', verdict, false, false, 3);
  const overCap = buildEscalatingFeedback(5, 'HIGH', verdict, false, false, 3);
  for (const out of [atCap, overCap]) {
    assert.doesNotMatch(out, /Final Attempt/i);
    assert.doesNotMatch(out, /LAST chance/i);
    assert.doesNotMatch(out, /supervisor stops/i);
  }
});

test('low confidence (< 0.7) uses "may be incomplete" framing, not an assertion', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.4 };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, false, false, 5);
  assert.match(out, /may be incomplete/i);
  assert.match(out, /not fully confident/i);
});

test('confidence >= 0.7 keeps the normal assertive "Task Incomplete" framing', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.9 };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, false, false, 5);
  assert.match(out, /Task Incomplete/);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('missing confidence field (backward compat, e.g. opencode autopilot loop verdicts) defaults to normal framing', () => {
  const verdict = { missing: [], next_actions: [], feedback: 'Autopilot loop detected — take concrete action.' };
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, false, false, 5);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('destructive missing/next_actions items are rewritten to a user-approval flag, not pushed as agent work', () => {
  const verdict = {
    missing: ['Force-push the branch to update the remote', 'Run the full test suite'],
    next_actions: ['git push --force origin main'],
    feedback: '',
  };
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, false, false, 5);
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
  const out = buildEscalatingFeedback(1, 'HIGH', verdict, false, false, 5);
  assert.match(out, /Flag to the user for approval: Run git reset --hard to discard local changes/);
  assert.match(out, /Flag to the user for approval: Rewrite git history to remove the secret/);
  assert.match(out, /Flag to the user for approval: Delete the old feature branch/);
  assert.match(out, /Flag to the user for approval: rm -rf the build directory and retry/);
});

test('non-destructive items are never rewritten', () => {
  const verdict = { missing: ['Push the commit to the feature branch', 'Add a unit test'], next_actions: [], feedback: '' };
  const out = buildEscalatingFeedback(1, 'LOW', verdict, false, false, 5);
  assert.doesNotMatch(out, /Flag to the user for approval/);
  assert.match(out, /- Push the commit to the feature branch/);
  assert.match(out, /- Add a unit test/);
});

test('planning-loop and action-loop branches are unaffected by the tone rewrite', () => {
  const planning = buildEscalatingFeedback(1, 'HIGH', {}, true, false, 5);
  assert.match(planning, /STOP: Planning Loop Detected/);
  const action = buildEscalatingFeedback(2, 'HIGH', {}, false, true, 5);
  assert.match(action, /STOP: Action Loop Detected \(attempt 2\/5\)/);
});

test('Missing/Next Actions sections still render as bulleted lists', () => {
  const verdict = { missing: ['A', 'B'], next_actions: ['C'], feedback: 'reason text' };
  const out = buildEscalatingFeedback(1, 'MEDIUM', verdict, false, false, 5);
  assert.match(out, /### Missing\n- A\n- B/);
  assert.match(out, /### Next Actions\n- C/);
});
