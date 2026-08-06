/**
 * task-context.test.mjs — the judge's INPUT CONTEXT.
 *
 * Covers the three structural biases documented in core/task-context.mjs:
 *   A. silent truncation blamed on the agent (169 false verdicts / 30 days)
 *   B. one extractor, not two disagreeing ones
 *   C. currentTask vs priorContext, and tool RESULTS as evidence
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_TEXT_LIMIT,
  truncateForPrompt,
  extractLastAssistantText,
  findLastRelevantUserIndex,
  splitUserTurns,
  buildTurnEvidence,
  userMessageText,
} from '../core/task-context.mjs';
import { buildSelfAssessmentPrompt, buildJudgePrompt } from '../core/assessment.mjs';
import { FEEDBACK_MARKER, SELF_ASSESSMENT_MARKER } from '../core/evaluation.mjs';

const user = (text) => ({ info: { role: 'user' }, parts: [{ type: 'text', text }] });
const assistant = (...parts) => ({ info: { role: 'assistant' }, parts });
const textPart = (text) => ({ type: 'text', text });
const toolPart = (tool, state) => ({ type: 'tool', tool, state });

// ---------------------------------------------------------------------------
// A. truncation is explicit and tail-preserving
// ---------------------------------------------------------------------------
describe('truncateForPrompt', () => {
  test('leaves short text completely untouched (no marker noise)', () => {
    assert.equal(truncateForPrompt('all done, tests pass', 100), 'all done, tests pass');
  });

  test('text exactly at the limit is not truncated', () => {
    const exact = 'x'.repeat(50);
    assert.equal(truncateForPrompt(exact, 50), exact);
  });

  test('tail mode keeps the ENDING, not the beginning', () => {
    const body = `${'A'.repeat(200)}TESTS PASSED. PR #42 opened.`;
    const out = truncateForPrompt(body, 40);
    assert.ok(out.endsWith('PR #42 opened.'), `expected the conclusion to survive: ${out}`);
    assert.ok(!out.includes('A'.repeat(60)), 'the stale preamble should have been dropped');
  });

  test('truncation ALWAYS carries an explicit supervisor-attributed marker', () => {
    const out = truncateForPrompt('y'.repeat(9000), 100);
    assert.match(out, /truncated by supervisor/i);
    assert.match(out, /NOT by the agent/i);
    assert.match(out, /do NOT treat/i);
  });

  test('marker states the real length so the judge can see nothing was lost by the agent', () => {
    const out = truncateForPrompt('z'.repeat(5877), 4000);
    assert.ok(out.includes('5877'), `marker must cite the true length: ${out.slice(0, 300)}`);
  });

  test('head mode keeps the beginning and appends the marker after it', () => {
    const out = truncateForPrompt('START' + 'q'.repeat(500), 20, { keep: 'head' });
    assert.ok(out.startsWith('START'));
    assert.match(out, /truncated by supervisor/i);
  });

  test('non-string input is safe', () => {
    assert.equal(truncateForPrompt(undefined), '');
    assert.equal(truncateForPrompt(null), '');
  });

  test('the shared limit is materially larger than the old hard-coded 4000', () => {
    assert.ok(PROMPT_TEXT_LIMIT > 4000, `expected a raised limit, got ${PROMPT_TEXT_LIMIT}`);
  });
});

describe('regression: the 169-false-verdict truncation bug', () => {
  // Reproduces ses_07004dd4bffeDsHbB8vJAOgEyl: a COMPLETE 5877-char report that
  // the old slice(0, 4000) cut mid-identifier, which the judge then quoted back
  // as proof the agent stopped mid-sentence.
  const completeReport = `${'detail '.repeat(820)}Everything above is done. Tests pass.`;

  test('a complete long report reaches the judge with its conclusion intact', () => {
    const prompt = buildSelfAssessmentPrompt(
      { taskSummary: 'ship it', taskType: 'coding', agentMode: 'build', toolsSummary: '(none)', detectedSignals: [] },
      '', completeReport, 0, undefined, 3
    );
    assert.ok(
      prompt.includes('Everything above is done. Tests pass.'),
      'the conclusion — the completion evidence — must survive truncation'
    );
  });

  test('when we DO truncate, the prompt says so in the supervisor\'s own name', () => {
    const huge = `${'x'.repeat(PROMPT_TEXT_LIMIT + 5000)}FINAL LINE: done.`;
    const prompt = buildSelfAssessmentPrompt(
      { taskSummary: 'ship it', taskType: 'coding', agentMode: 'build', toolsSummary: '(none)', detectedSignals: [] },
      '', huge, 0, undefined, 3
    );
    assert.match(prompt, /truncated by supervisor/i);
    assert.ok(prompt.includes('FINAL LINE: done.'), 'tail must be preserved');
  });

  test('judge prompt truncates the self-assessment with a marker too', () => {
    const prompt = buildJudgePrompt(
      { taskSummary: 't', taskType: 'coding', toolsSummary: '(none)' },
      'w'.repeat(PROMPT_TEXT_LIMIT + 100),
      null
    );
    assert.match(prompt, /truncated by supervisor/i);
  });
});

// ---------------------------------------------------------------------------
// B. one extractor
// ---------------------------------------------------------------------------
describe('extractLastAssistantText — the single extractor', () => {
  test('multi-part assistant message: keeps EVERY text part, not just first or last', () => {
    const messages = [
      user('do the thing'),
      assistant(
        textPart('Starting: I will edit the parser.'),
        toolPart('edit', { status: 'completed', input: { file_path: 'p.ts' }, output: 'ok' }),
        textPart('Done. Tests pass.')
      ),
    ];
    const out = extractLastAssistantText(messages);
    // The two old implementations each returned exactly one of these and
    // dropped the other, so which content the judge saw depended on call site.
    assert.ok(out.includes('Starting: I will edit the parser.'), 'first text part lost');
    assert.ok(out.includes('Done. Tests pass.'), 'last text part lost');
  });

  test('reads the LAST assistant message, not an earlier one', () => {
    const messages = [
      assistant(textPart('old turn')),
      user('next'),
      assistant(textPart('new turn')),
    ];
    assert.equal(extractLastAssistantText(messages), 'new turn');
  });

  test('skips trailing assistant messages that carry no text', () => {
    const messages = [
      assistant(textPart('the real answer')),
      assistant(toolPart('bash', { status: 'completed', input: { command: 'ls' }, output: 'x' })),
    ];
    assert.equal(extractLastAssistantText(messages), 'the real answer');
  });

  test('empty / non-array input is safe', () => {
    assert.equal(extractLastAssistantText([]), '');
    assert.equal(extractLastAssistantText(null), '');
  });
});

// ---------------------------------------------------------------------------
// C. currentTask vs priorContext
// ---------------------------------------------------------------------------
describe('splitUserTurns', () => {
  test('single turn: it is the current task, no prior context', () => {
    const { currentTask, priorContext } = splitUserTurns(['fix the tests']);
    assert.equal(currentTask, 'fix the tests');
    assert.equal(priorContext, '');
  });

  test('the LATEST turn is the current task; earlier ones become prior context', () => {
    const { currentTask, priorContext } = splitUserTurns(['first task', 'second task']);
    assert.equal(currentTask, 'second task');
    assert.match(priorContext, /first task/);
    assert.ok(!priorContext.includes('second task'), 'current task must not be duplicated as background');
  });

  test('regression: a topic change is judged on the NEW topic', () => {
    // ses_0726f33edffeaheBOml5Dpdexs — user asked to open the PR and deploy,
    // supervisor demanded "commit PRD.md and TDD.md" from an earlier turn.
    const { currentTask, priorContext } = splitUserTurns([
      'write PRD.md and TDD.md for the alerts feature',
      'open the PR, run the full next build, and proceed to deploy',
    ]);
    assert.equal(currentTask, 'open the PR, run the full next build, and proceed to deploy');
    assert.match(priorContext, /PRD\.md/);
  });

  test('prior context is capped by turn count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `turn ${i}`);
    const { priorContext } = splitUserTurns(many, { maxTurns: 3, maxChars: 10_000 });
    assert.ok(!priorContext.includes('turn 0'), 'oldest turns must be dropped');
    assert.ok(priorContext.includes('turn 28'), 'most recent prior turn must be kept');
  });

  test('prior context is capped by chars, dropping the STALEST first', () => {
    const many = ['A'.repeat(400), 'B'.repeat(400), 'C'.repeat(400)];
    const { currentTask, priorContext } = splitUserTurns(many, { maxTurns: 10, maxChars: 500 });
    assert.equal(currentTask, 'C'.repeat(400));
    assert.ok(priorContext.includes('B'.repeat(50)), 'newest prior turn kept');
    assert.ok(!priorContext.includes('A'.repeat(50)), 'stalest prior turn dropped');
  });

  test('prior turns are numbered so the judge can see ordering', () => {
    const { priorContext } = splitUserTurns(['one', 'two', 'three']);
    assert.match(priorContext, /\[turn 1\]/);
    assert.match(priorContext, /\[turn 2\]/);
  });

  test('empty / junk input is safe', () => {
    assert.deepEqual(splitUserTurns([]), { currentTask: '', priorContext: '' });
    assert.deepEqual(splitUserTurns(null), { currentTask: '', priorContext: '' });
    assert.deepEqual(splitUserTurns(['  ', '']), { currentTask: '', priorContext: '' });
  });
});

describe('prompt rendering keeps demand and background distinct', () => {
  const ctx = {
    taskSummary: 'deploy it',
    currentTask: 'deploy it',
    priorContext: '[turn 1] write the PRD',
    turnEvidence: '[tool] bash — npm test\n  result: 12 passing',
    taskType: 'coding',
    agentMode: 'build',
    toolsSummary: 'npm test',
    detectedSignals: [],
  };

  test('self-assessment prompt labels prior context as already addressed', () => {
    const p = buildSelfAssessmentPrompt(ctx, '', 'done', 0, undefined, 3);
    assert.match(p, /## Current Task/);
    assert.ok(p.includes('deploy it'));
    assert.match(p, /ALREADY ADDRESSED/i);
    assert.ok(p.includes('write the PRD'));
    assert.match(p, /Do NOT list them as missing work/i);
  });

  test('self-assessment prompt surfaces the turn evidence block', () => {
    const p = buildSelfAssessmentPrompt(ctx, '', 'done', 0, undefined, 3);
    assert.ok(p.includes('12 passing'), 'tool results must reach the judge');
  });

  test('judge prompt does the same', () => {
    const p = buildJudgePrompt(ctx, '{"complete":true}', null);
    assert.match(p, /## Current Task/);
    assert.match(p, /ALREADY ADDRESSED/i);
    assert.ok(p.includes('12 passing'));
  });

  test('falls back to taskSummary when currentTask is absent (legacy callers)', () => {
    const p = buildSelfAssessmentPrompt(
      { taskSummary: 'legacy summary', taskType: 'other', agentMode: 'build', toolsSummary: '(none)', detectedSignals: [] },
      '', '', 0, undefined, 3
    );
    assert.ok(p.includes('legacy summary'));
  });
});

// ---------------------------------------------------------------------------
// C2. tool results as evidence
// ---------------------------------------------------------------------------
describe('userMessageText / findLastRelevantUserIndex', () => {
  test('supervisor injections are not real user turns', () => {
    assert.equal(userMessageText(user(`${FEEDBACK_MARKER} Task Incomplete`)), null);
    assert.equal(userMessageText(user(`${SELF_ASSESSMENT_MARKER} blah`)), null);
  });

  test('task-notification metadata is not a real user turn', () => {
    assert.equal(userMessageText(user('<task-notification>done</task-notification>')), null);
  });

  test('finds the last REAL user message, skipping supervisor injections', () => {
    const messages = [
      user('the real ask'),
      assistant(textPart('ok')),
      user(`${FEEDBACK_MARKER} Task Incomplete (MEDIUM)`),
      assistant(textPart('continuing')),
    ];
    assert.equal(findLastRelevantUserIndex(messages), 0);
  });

  test('-1 when there is no user message at all', () => {
    assert.equal(findLastRelevantUserIndex([assistant(textPart('hi'))]), -1);
  });
});

describe('buildTurnEvidence', () => {
  test('includes tool RESULTS, not just tool inputs', () => {
    const messages = [
      user('run the tests'),
      assistant(
        toolPart('bash', {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'Test Suites: 12 passed, 12 total',
        }),
        textPart('All green.')
      ),
    ];
    const ev = buildTurnEvidence(messages);
    assert.ok(ev.includes('npm test'), 'tool input missing');
    assert.ok(ev.includes('12 passed'), 'tool RESULT missing — this was invisible to the judge before');
    assert.ok(ev.includes('All green.'), 'assistant text missing');
  });

  test('includes tool errors', () => {
    const messages = [
      user('build it'),
      assistant(toolPart('bash', { status: 'error', input: { command: 'npm run build' }, error: 'TS2345: type error' })),
    ];
    const ev = buildTurnEvidence(messages);
    assert.match(ev, /ERROR/);
    assert.ok(ev.includes('TS2345'));
  });

  test('covers ALL assistant messages of the current turn, not just the last one', () => {
    const messages = [
      user('do a and b'),
      assistant(textPart('did a')),
      assistant(textPart('did b')),
    ];
    const ev = buildTurnEvidence(messages);
    assert.ok(ev.includes('did a'));
    assert.ok(ev.includes('did b'));
  });

  test('excludes work from BEFORE the latest user request', () => {
    const messages = [
      user('old ask'),
      assistant(textPart('OLD WORK')),
      user('new ask'),
      assistant(textPart('NEW WORK')),
    ];
    const ev = buildTurnEvidence(messages);
    assert.ok(ev.includes('NEW WORK'));
    assert.ok(!ev.includes('OLD WORK'), 'previous turns are prior context, not current evidence');
  });

  test('work after a supervisor injection still counts as the current turn', () => {
    const messages = [
      user('fix it'),
      assistant(textPart('first attempt')),
      user(`${FEEDBACK_MARKER} Task Incomplete`),
      assistant(textPart('second attempt')),
    ];
    const ev = buildTurnEvidence(messages);
    assert.ok(ev.includes('first attempt'));
    assert.ok(ev.includes('second attempt'));
  });

  test('each tool result is individually bounded', () => {
    const messages = [
      user('run it'),
      assistant(toolPart('bash', { status: 'completed', input: { command: 'ls' }, output: 'X'.repeat(50_000) })),
    ];
    const ev = buildTurnEvidence(messages, { resultMaxChars: 300 });
    assert.ok(ev.length < 2000, `per-result cap not applied: ${ev.length}`);
    assert.match(ev, /truncated by supervisor/i);
  });

  test('total evidence is bounded, keeping the most RECENT steps', () => {
    const parts = Array.from({ length: 40 }, (_, i) => textPart(`step ${i} ${'y'.repeat(300)}`));
    const messages = [user('go'), assistant(...parts)];
    const ev = buildTurnEvidence(messages, { totalMaxChars: 2000 });
    assert.ok(ev.length < 4000, `total cap not applied: ${ev.length}`);
    assert.ok(ev.includes('step 39'), 'most recent step must survive');
    assert.ok(!ev.includes('step 0 '), 'oldest step should be dropped');
    assert.match(ev, /truncated by supervisor/i);
  });

  test('returns empty string when there is no evidence', () => {
    assert.equal(buildTurnEvidence([user('go')]), '');
    assert.equal(buildTurnEvidence(null), '');
  });
});
