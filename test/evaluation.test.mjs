import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as evaluation from '../core/evaluation.mjs';

const { evaluateSelfAssessment, isTestRunnerCommand, hasLocalTestCommand } = evaluation;

// ---------------------------------------------------------------------------
// evaluateSelfAssessment — decision-table coverage.
//
// Policy under test (Fix A): the judge's reported `status` decides; the
// deterministic requires* gates only INFORM the outcome (populate
// missing/nextActions for visibility) and must never override a judge
// verdict of waiting_for_user, nor flip a confident `complete` back to
// "continue". Only in_progress/blocked/stuck (or low-confidence `complete`)
// may produce shouldContinue=true, and only when a concrete actionable item
// remains — with a SPECIFIC reason, never the old generic
// "Missing required workflow steps".
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

// (a) waiting_for_user never injects, even with every requires* gate unmet.
test('waiting_for_user: never continues even with all requires* gates unmet', () => {
  const assessment = {
    status: 'waiting_for_user',
    confidence: 0.9,
    remaining_work: [],
    next_steps: [],
    needs_user_action: ['Need the user to provide an OAuth token'],
    evidence: {},
  };
  const context = baseContext({ requiresTests: true, requiresBuild: true, requiresPR: true, requiresCI: true });
  const result = evaluateSelfAssessment(assessment, context);
  assert.equal(result.complete, false);
  assert.equal(result.shouldContinue, false, 'waiting_for_user must never continue');
  assert.equal(result.requiresHumanAction, true);
  assert.match(result.reason, /OAuth token/);
});

test('waiting_for_user: unconditional — wins even when needs_user_action text has no human-only keyword', () => {
  // isHumanOnlyAction's keyword heuristic would NOT flag "check the deploy logs"
  // as human-only, but a judge-reported waiting_for_user status must still win.
  const assessment = {
    status: 'waiting_for_user',
    confidence: 0.9,
    remaining_work: [],
    next_steps: [],
    needs_user_action: ['Please check the deploy logs and confirm'],
    evidence: {},
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.shouldContinue, false);
  assert.equal(result.requiresHumanAction, true);
});

// (b) complete @ confidence >= 0.6 never continues; unmet gates become an
// informational note only, never flipping the decision.
test('complete @ confidence >= 0.6: never continues, unmet gates become an informational note', () => {
  const assessment = {
    status: 'complete',
    confidence: 0.65,
    remaining_work: [],
    next_steps: [],
    needs_user_action: [],
    evidence: { tests: {}, build: {}, pr: {} },
  };
  const context = baseContext({ requiresTests: true });
  const result = evaluateSelfAssessment(assessment, context);
  assert.equal(result.complete, true);
  assert.equal(result.shouldContinue, false);
  assert.match(result.reason, /heuristic note/i);
  assert.match(result.reason, /Run tests/);
});

test('complete @ confidence exactly 0.6 boundary: still treated as confident complete', () => {
  const assessment = { status: 'complete', confidence: 0.6, remaining_work: [], next_steps: [], needs_user_action: [] };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, true);
  assert.equal(result.shouldContinue, false);
});

test('complete with no unmet gates: reason has no heuristic-note suffix', () => {
  const assessment = { status: 'complete', confidence: 0.95, remaining_work: [], next_steps: [], needs_user_action: [] };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, true);
  assert.doesNotMatch(result.reason, /heuristic note/i);
});

// (c) in_progress with a concrete remaining_work item: continues with a
// SPECIFIC reason — never the old generic "Missing required workflow steps".
test('in_progress with concrete remaining_work: continues with the SPECIFIC item as reason', () => {
  const assessment = {
    status: 'in_progress',
    confidence: 0.9,
    remaining_work: ['Wire the new endpoint into the router'],
    next_steps: [],
    needs_user_action: [],
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.shouldContinue, true);
  assert.equal(result.reason, 'Wire the new endpoint into the router');
  assert.notEqual(result.reason, 'Missing required workflow steps');
});

test('in_progress with only next_steps (no remaining_work): still gets a specific reason', () => {
  const assessment = {
    status: 'in_progress',
    confidence: 0.9,
    remaining_work: [],
    next_steps: ['Run the linter and fix warnings'],
    needs_user_action: [],
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.shouldContinue, true);
  assert.equal(result.reason, 'Run the linter and fix warnings');
});

// (d) in_progress / blocked / stuck with NO concrete actionable items: does
// not continue (nothing left to name), and is not marked complete.
test('in_progress with no actionable items at all: does not continue, not complete', () => {
  const assessment = { status: 'in_progress', confidence: 0.9, remaining_work: [], next_steps: [], needs_user_action: [] };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false);
  assert.equal(result.shouldContinue, false);
  assert.equal(result.reason, 'Task not confirmed complete');
});

test('blocked status with no actionable items: does not continue', () => {
  const assessment = { status: 'blocked', confidence: 0.8, remaining_work: [], next_steps: [], needs_user_action: [] };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.shouldContinue, false);
});

// (e) low-confidence "complete": not trusted as complete; behaves like bucket 3.
test('complete @ low confidence with no actionable items: not complete, does not continue, distinct reason', () => {
  const assessment = { status: 'complete', confidence: 0.3, remaining_work: [], next_steps: [], needs_user_action: [] };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false, 'low-confidence complete must not be trusted');
  assert.equal(result.shouldContinue, false);
  assert.match(result.reason, /low confidence/i);
});

test('complete @ low confidence WITH concrete remaining_work: continues with the specific item', () => {
  const assessment = {
    status: 'complete',
    confidence: 0.3,
    remaining_work: ['Verify the migration ran in production'],
    next_steps: [],
    needs_user_action: [],
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.complete, false);
  assert.equal(result.shouldContinue, true);
  assert.equal(result.reason, 'Verify the migration ran in production');
});

// (f) human-only needs_user_action (keyword-detected), with NO other
// actionable work: pure human block — requiresHumanAction, no continue.
test('in_progress with only a human-only need_user_action item and nothing else actionable: requiresHumanAction, no continue', () => {
  const assessment = {
    status: 'in_progress',
    confidence: 0.9,
    remaining_work: [],
    next_steps: [],
    needs_user_action: ['Need the user to approve access to the production database'],
  };
  const result = evaluateSelfAssessment(assessment, baseContext());
  assert.equal(result.requiresHumanAction, true);
  assert.equal(result.shouldContinue, false);
  assert.equal(result.complete, false);
});

// Mixed case: a human-only need coexists with a separate agent-actionable gate
// (e.g. requiresTests unmet). shouldContinue reflects the actionable item;
// requiresHumanAction independently reflects the human-only signal — callers
// (the CC hook's `!requiresHumanAction` inject-gate; opencode's
// `requiresHumanAction && !shouldContinue` early-return) combine both flags
// themselves, so evaluateSelfAssessment must report them independently rather
// than let one silently overwrite the other.
test('mixed: human-only need_user_action PLUS an unmet requires* gate — both flags reported independently', () => {
  const assessment = {
    status: 'in_progress',
    confidence: 0.9,
    remaining_work: [],
    next_steps: [],
    needs_user_action: ['Need the user to approve access to the production database'],
    evidence: { tests: {} },
  };
  const context = baseContext({ requiresTests: true });
  const result = evaluateSelfAssessment(assessment, context);
  assert.equal(result.shouldContinue, true, 'the unmet test gate is agent-actionable');
  assert.equal(result.requiresHumanAction, true, 'the human-only need must still surface');
  assert.match(result.reason, /test/i);
});

// Gate-population sanity: requires* gates still populate missing/nextActions
// for visibility even though they can no longer flip the decision alone.
test('gates still populate missing[] for visibility even when they cannot flip the decision', () => {
  const assessment = { status: 'complete', confidence: 0.9, remaining_work: [], next_steps: [], needs_user_action: [], evidence: { tests: {} } };
  const context = baseContext({ requiresTests: true });
  const result = evaluateSelfAssessment(assessment, context);
  assert.ok(result.missing.some((m) => /test/i.test(m)), `expected a test-related missing item: ${result.missing}`);
  assert.equal(result.complete, true, 'gate must not flip a confident complete');
});

test('legacy loop-detector symbols are absent from exports and source files', () => {
  const symbol = (...parts) => parts.join('');
  const removedSymbols = [
    symbol('detect', 'Planning', 'Loop'),
    symbol('shouldApply', 'Planning', 'Loop'),
    symbol('detect', 'Action', 'Loop'),
    symbol('PLANNING', '_LOOP', '_MIN_TOOL_CALLS'),
    symbol('PLANNING', '_LOOP', '_WRITE_RATIO_THRESHOLD'),
    symbol('ACTION', '_LOOP', '_MIN_COMMANDS'),
    symbol('ACTION', '_LOOP', '_REPETITION_THRESHOLD'),
    // Tool-activity telemetry. Its only surviving consumer was a line in the
    // autopilot nudge that reported the agent's own tool-call counts back to
    // it — noise that needed an "informational only, not a verdict"
    // disclaimer to stay safe, and that existed on the opencode runtime only.
    symbol('summarize', 'Tool', 'Activity'),
    symbol('describe', 'Tool', 'Activity'),
    symbol('tool', 'Activity', 'Note'),
  ];

  for (const symbol of removedSymbols) {
    assert.equal(symbol in evaluation, false, `evaluation.mjs should not export ${symbol}`);
  }

  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const evaluationSource = readFileSync(join(rootDir, 'core', 'evaluation.mjs'), 'utf8');
  const supervisorSource = readFileSync(join(rootDir, 'opencode', 'supervisor-impl.ts'), 'utf8');
  for (const symbol of removedSymbols) {
    assert.equal(evaluationSource.includes(symbol), false, `core/evaluation.mjs still references ${symbol}`);
    assert.equal(supervisorSource.includes(symbol), false, `opencode/supervisor-impl.ts still references ${symbol}`);
  }
});

// ---------------------------------------------------------------------------
// isTestRunnerCommand / hasLocalTestCommand — recognizing actual test-runner
// invocations (not mere mentions of a test tool's name in an install, config
// read, or search command).
// ---------------------------------------------------------------------------

test('isTestRunnerCommand: recognizes newly-added ecosystems (positive cases)', () => {
  const positives = [
    'node --test',
    'node --experimental-strip-types --test test/*.test.mjs',
    'vitest',
    'vitest run',
    'npx vitest',
    'jest',
    'npx jest',
    'mocha',
    'npx mocha',
    'deno test',
    'bun test',
  ];
  for (const cmd of positives) {
    assert.equal(isTestRunnerCommand(cmd), true, `expected isTestRunnerCommand to match: ${cmd}`);
  }
});

test('isTestRunnerCommand: retains regression coverage for pre-existing ecosystems', () => {
  const positives = [
    'npm test',
    'npm run test',
    'pnpm test',
    'yarn test',
    'pytest',
    'go test',
    'cargo test',
  ];
  for (const cmd of positives) {
    assert.equal(isTestRunnerCommand(cmd), true, `expected isTestRunnerCommand to match: ${cmd}`);
  }
});

test('isTestRunnerCommand: does not match install/config-read/search false positives', () => {
  const negatives = [
    'npm install --save-dev vitest',
    'npm i -D jest',
    'pnpm add mocha',
    'cat vitest.config.ts',
    'cat jest.config.js',
    'grep -r jest src/',
    'find . -name "*.test.js"',
    'which mocha',
    'npm ls jest',
  ];
  for (const cmd of negatives) {
    assert.equal(isTestRunnerCommand(cmd), false, `expected isTestRunnerCommand NOT to match: ${cmd}`);
  }
});

test('isTestRunnerCommand: matches a test runner invoked after a chained shell operator', () => {
  assert.equal(
    isTestRunnerCommand('cd project && npm run build && node --test test/foo.test.mjs'),
    true
  );
});

test('hasLocalTestCommand: delegates to isTestRunnerCommand across a command list', () => {
  assert.equal(hasLocalTestCommand(['git status', 'npx vitest run']), true);
  assert.equal(hasLocalTestCommand(['git status', 'npm install --save-dev vitest']), false);
  assert.equal(hasLocalTestCommand([]), false);
});
