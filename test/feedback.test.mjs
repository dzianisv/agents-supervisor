import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalatingFeedback } from '../core/feedback.mjs';

// ---------------------------------------------------------------------------
// buildEscalatingFeedback — tone coverage (Fix B) + no-static-override
// contract (align-supervisor-modes).
//
// Policy under test: no attempt-count escalation tiers (never "Final
// Attempt" / "LAST chance" / urgent-escalation wording — the function does
// not even receive an attempt count any more); confidence-aware framing when the
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
  const out = buildEscalatingFeedback('HIGH', verdict);
  assert.doesNotMatch(out, /Final Attempt/i);
  assert.doesNotMatch(out, /LAST chance/i);
  assert.doesNotMatch(out, /asked \d+ times/i);
  assert.match(out, /Task Incomplete/);
});

// The escalation question, settled. buildEscalatingFeedback used to take
// (attemptCount, severity, verdict, maxAttempts, opts) and read NEITHER count:
// `attemptCount` was never referenced and the `maxAttempts`-derived
// `effectiveCap` was computed and discarded. A silently-ignored parameter is a
// standing invitation to display a number the code cannot honour, so both were
// removed rather than wired up. This pins the arity so they cannot creep back.
test('takes no attempt count at all: arity is (severity, verdict, opts) and no "n/N" is rendered', () => {
  assert.equal(
    buildEscalatingFeedback.length, 2,
    'buildEscalatingFeedback must declare exactly (severity, verdict) + the defaulted opts — ' +
    'a re-added attemptCount/maxAttempts parameter would be dead again',
  );
  const verdict = { missing: ['Run the test suite'], next_actions: [], feedback: 'tests not run yet' };
  const out = buildEscalatingFeedback('HIGH', verdict);
  assert.doesNotMatch(out, /Final Attempt/i);
  assert.doesNotMatch(out, /LAST chance/i);
  assert.doesNotMatch(out, /supervisor stops/i);
  // No "attempt 2 of 5" style counter: this message never had a truthful one.
  assert.doesNotMatch(out, /\battempt\s+\d+\s*(of|\/)\s*\d+/i);
  assert.doesNotMatch(out, /\(\s*\d+\s*\/\s*\d+\s*\)/);
});

test('low confidence (< 0.7) uses "may be incomplete" framing, not an assertion', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.4 };
  const out = buildEscalatingFeedback('MEDIUM', verdict);
  assert.match(out, /may be incomplete/i);
  assert.match(out, /not fully confident/i);
});

test('confidence >= 0.7 keeps the normal assertive "Task Incomplete" framing', () => {
  const verdict = { missing: ['Verify the migration ran'], next_actions: [], feedback: '', confidence: 0.9 };
  const out = buildEscalatingFeedback('MEDIUM', verdict);
  assert.match(out, /Task Incomplete/);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('missing confidence field (backward compat, e.g. opencode autopilot loop verdicts) defaults to normal framing', () => {
  const verdict = { missing: [], next_actions: [], feedback: 'Autopilot loop detected — take concrete action.' };
  const out = buildEscalatingFeedback('HIGH', verdict);
  assert.doesNotMatch(out, /may be incomplete/i);
});

test('destructive missing/next_actions items are rewritten to a user-approval flag, not pushed as agent work', () => {
  const verdict = {
    missing: ['Force-push the branch to update the remote', 'Run the full test suite'],
    next_actions: ['git push --force origin main'],
    feedback: '',
  };
  const out = buildEscalatingFeedback('HIGH', verdict);
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
  const out = buildEscalatingFeedback('HIGH', verdict);
  assert.match(out, /Flag to the user for approval: Run git reset --hard to discard local changes/);
  assert.match(out, /Flag to the user for approval: Rewrite git history to remove the secret/);
  assert.match(out, /Flag to the user for approval: Delete the old feature branch/);
  assert.match(out, /Flag to the user for approval: rm -rf the build directory and retry/);
});

test('non-destructive items are never rewritten', () => {
  const verdict = { missing: ['Push the commit to the feature branch', 'Add a unit test'], next_actions: [], feedback: '' };
  const out = buildEscalatingFeedback('LOW', verdict);
  assert.doesNotMatch(out, /Flag to the user for approval/);
  assert.match(out, /- Push the commit to the feature branch/);
  assert.match(out, /- Add a unit test/);
});

test('signature no longer accepts isPlanningLoop/isActionLoop: extra positional args are ignored, never produce STOP override text', () => {
  // A caller passing extra positional args by accident must not resurrect any
  // loop-detection behaviour (there is none left to resurrect).
  const out = buildEscalatingFeedback('HIGH', { missing: ['Do the thing'], next_actions: [], feedback: '' }, {}, true);
  assert.doesNotMatch(out, /STOP: Planning Loop Detected/);
  assert.doesNotMatch(out, /STOP: Action Loop Detected/);
  assert.doesNotMatch(out, /\bSTOP\b/);
});

test('no static STOP/planning-loop/action-loop override exists for any verdict shape, including an empty verdict', () => {
  // An empty/near-empty verdict used to be exactly the shape passed alongside
  // isPlanningLoop=true in the old call sites. With the override removed,
  // this must render the calm generic template — never the canned STOP text.
  const out = buildEscalatingFeedback('HIGH', {});
  assert.doesNotMatch(out, /STOP: Planning Loop Detected/);
  assert.doesNotMatch(out, /STOP: Action Loop Detected/);
  assert.doesNotMatch(out, /DO NOT:/);
  assert.doesNotMatch(out, /Start coding NOW/);
  assert.match(out, /Task Incomplete|may be incomplete/);
});

test('Missing/Next Actions sections still render as bulleted lists', () => {
  const verdict = { missing: ['A', 'B'], next_actions: ['C'], feedback: 'reason text' };
  const out = buildEscalatingFeedback('MEDIUM', verdict);
  assert.match(out, /### Missing\n- A\n- B/);
  assert.match(out, /### Next Actions\n- C/);
});
