import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as evaluation from '../core/evaluation.mjs';

const { evaluateSelfAssessment, isHumanOnlyAction } = evaluation;

// ---------------------------------------------------------------------------
// Judge-pushback coverage for two stuck-loop patterns:
//   Pattern A — permission-for-in-scope-work: a `complete` verdict that still
//     lists agent-actionable remaining_work/next_steps (the agent is asking
//     permission / deferring in-scope work). Must NOT be trusted as done.
//   Pattern B — single-blocker total-stop: a waiting_for_user / blocked verdict
//     that ALSO has agent-actionable remaining_work/next_steps. Must CONTINUE on
//     the autonomous items and only surface the gated blocker.
// ---------------------------------------------------------------------------

function baseContext(overrides = {}) {
  return {
    taskSummary: 'do the thing',
    taskType: 'coding',
    agentMode: 'build',
    humanMessages: ['do the thing'],
    toolsSummary: '(none)',
    detectedSignals: [],
    recentCommands: [],
    pushedToDefaultBranch: false,
    requiresTests: false,
    requiresBuild: false,
    requiresPR: false,
    requiresCI: false,
    requiresLocalTests: false,
    requiresLocalTestsEvidence: false,
    ...overrides,
  };
}

// Realistic item strings used across these tests.
const AGENT_ACTIONABLE = ['Run npm test', 'Finalize launch-post drafts', 'Deploy the fix'];
const HUMAN_ONLY = [
  'Grant access to the billing dashboard',
  'Provide the API key for deployment',
  'Founder must approve the spending increase',
];

// Sanity: the heuristic classifies the fixtures exactly as this suite assumes.
// If this fails, the FIX is not wrong — the test STRINGS are; fix the strings,
// never weaken the fix to match a bad string.
test('fixture sanity: isHumanOnlyAction classifies the test strings as expected', () => {
  for (const item of AGENT_ACTIONABLE) {
    assert.equal(isHumanOnlyAction(item), false, `expected agent-actionable: ${item}`);
  }
  for (const item of HUMAN_ONLY) {
    assert.equal(isHumanOnlyAction(item), true, `expected human-only: ${item}`);
  }
});

// 1. Pattern B: waiting_for_user + agent-actionable remaining_work → continue,
//    but still flag requiresHumanAction so the gated blocker surfaces.
test('waiting_for_user + agent-actionable remaining_work: continues, requiresHumanAction', () => {
  const assessment = {
    status: 'waiting_for_user',
    confidence: 0.9,
    remaining_work: ['Finalize launch-post drafts'],
    next_steps: ['Run npm test'],
    needs_user_action: ['Founder must approve the spending increase'],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false);
  assert.equal(result.shouldContinue, true, 'agent-actionable work must not be halted by one gated item');
  assert.equal(result.requiresHumanAction, true, 'the gated blocker must still surface');
});

// 2. Pattern B guard: waiting_for_user with ONLY human-only items → pure block
//    still stops unconditionally.
test('waiting_for_user + ONLY human-only items: pure block still stops', () => {
  const assessment = {
    status: 'waiting_for_user',
    confidence: 0.9,
    remaining_work: ['Provide the API key for deployment'],
    next_steps: ['Grant access to the billing dashboard'],
    needs_user_action: ['Founder must approve the spending increase'],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.shouldContinue, false, 'no agent-actionable work → still stops');
  assert.equal(result.requiresHumanAction, true);
});

// 3. Pattern A: high-confidence complete + agent-actionable next_steps present →
//    NOT trusted complete → continue.
test('complete @ 0.9 WITH agent-actionable next_steps: not trusted complete, continues', () => {
  const assessment = {
    status: 'complete',
    confidence: 0.9,
    remaining_work: [],
    next_steps: ['Deploy the fix'],
    needs_user_action: [],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false, 'a complete verdict that defers in-scope work is not done');
  assert.equal(result.shouldContinue, true);
  assert.equal(result.reason, 'Deploy the fix');
});

// 4. Pattern A guard: high-confidence complete + only human-only leftovers →
//    still trusted complete.
test('complete @ 0.9 with only human-only leftovers: still trusted complete', () => {
  const assessment = {
    status: 'complete',
    confidence: 0.9,
    remaining_work: ['Founder must approve the spending increase'],
    next_steps: ['Provide the API key for deployment'],
    needs_user_action: [],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, true, 'human-only leftovers do not block a complete verdict');
  assert.equal(result.shouldContinue, false);
});

// 5. Pattern B mixed: blocked + one human-only + one agent-actionable → continue,
//    requiresHumanAction.
test('blocked + mixed (human-only + agent-actionable): continues, requiresHumanAction', () => {
  const assessment = {
    status: 'blocked',
    confidence: 0.85,
    remaining_work: ['Run npm test'],
    next_steps: [],
    needs_user_action: ['Grant access to the billing dashboard'],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false);
  assert.equal(result.shouldContinue, true, 'the agent-actionable item drives continuation');
  assert.equal(result.requiresHumanAction, true, 'the gated item still surfaces');
});
