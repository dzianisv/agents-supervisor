/**
 * task-context.test.mjs — the judge's INPUT CONTEXT.
 *
 * Covers:
 *   A. silent truncation blamed on the agent (169 false verdicts / 30 days)
 *   B. one extractor, not two disagreeing ones
 *   C. the conversation chain — the judge's ONLY context (owner decision
 *      2026-08-06). Tool calls / inputs / results, the "[1]..[n]" demand blob
 *      and the currentTask/priorContext/turnEvidence split are all gone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMPT_TEXT_LIMIT,
  CHAIN_MAX_CHARS,
  truncateForPrompt,
  extractLastAssistantText,
  findLastRelevantUserIndex,
  currentUserTask,
  collectConversationTurns,
  buildConversationChain,
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
// ---------------------------------------------------------------------------
// C. the conversation chain — the judge's ONLY context
// ---------------------------------------------------------------------------
describe('currentUserTask', () => {
  test('is the latest non-blank human message', () => {
    assert.equal(currentUserTask(['first', 'second']), 'second');
  });

  test('blank / junk input is safe', () => {
    assert.equal(currentUserTask([]), '');
    assert.equal(currentUserTask(null), '');
    assert.equal(currentUserTask(['  ', '']), '');
  });
});

describe('collectConversationTurns', () => {
  test('groups assistant messages under the human turn they answer', () => {
    const turns = collectConversationTurns([
      user('a'),
      assistant(textPart('a1')),
      assistant(textPart('a2')),
      user('b'),
      assistant(textPart('b1')),
    ]);
    assert.deepEqual(turns, [
      { user: 'a', assistant: 'a1\n\na2' },
      { user: 'b', assistant: 'b1' },
    ]);
  });

  test('assistant text before the first human turn has no turn and is dropped', () => {
    const turns = collectConversationTurns([assistant(textPart('orphan')), user('ask')]);
    assert.deepEqual(turns, [{ user: 'ask', assistant: '' }]);
  });
});

describe('buildConversationChain', () => {
  test('renders alternating user/assistant blocks, oldest -> newest', () => {
    const chain = buildConversationChain([
      user('first ask'),
      assistant(textPart('first reply')),
      user('second ask'),
      assistant(textPart('second reply')),
    ]);
    assert.equal(
      chain,
      'user:\nfirst ask\n\nassistant:\nfirst reply\n\n---\n\nuser:\nsecond ask\n\nassistant:\nsecond reply'
    );
  });

  test('a session with no assistant reply yet still renders the user turn', () => {
    const chain = buildConversationChain([user('do the thing')]);
    assert.equal(chain, 'user:\ndo the thing');
  });

  test('supervisor-injected messages are NEVER a turn in the chain', () => {
    const chain = buildConversationChain([
      user('fix it'),
      assistant(textPart('first attempt')),
      user(`${FEEDBACK_MARKER} Task Incomplete (MEDIUM)`),
      assistant(textPart('second attempt')),
      user(`${SELF_ASSESSMENT_MARKER} assess yourself`),
    ]);
    assert.ok(!chain.includes(FEEDBACK_MARKER), 'feedback injection leaked into the chain');
    assert.ok(!chain.includes(SELF_ASSESSMENT_MARKER), 'self-assessment injection leaked into the chain');
    assert.ok(!chain.includes('Task Incomplete'), 'injected verdict text leaked into the chain');
    // ...and the work done after an injection stays attached to the human turn.
    assert.ok(chain.includes('first attempt'));
    assert.ok(chain.includes('second attempt'));
    assert.equal(chain.match(/^user:/gm).length, 1, 'exactly one human turn');
  });

  test('<task-notification> metadata is NEVER a turn in the chain', () => {
    const chain = buildConversationChain([
      user('<task-notification>background job finished</task-notification>'),
      user('real ask'),
      assistant(textPart('real reply')),
    ]);
    assert.ok(!chain.includes('task-notification'));
    assert.ok(!chain.includes('background job finished'));
    assert.equal(chain, 'user:\nreal ask\n\nassistant:\nreal reply');
  });

  test('tool calls, tool inputs and tool results appear NOWHERE', () => {
    const chain = buildConversationChain([
      user('run the tests'),
      assistant(
        textPart('Running them now.'),
        toolPart('bash', {
          status: 'completed',
          input: { command: 'npm test --coverage' },
          output: 'Test Suites: 12 passed, 12 total',
        }),
        toolPart('edit', { status: 'error', input: { file_path: 'src/x.ts' }, error: 'TS2345: type error' }),
        textPart('All green.')
      ),
    ]);
    for (const forbidden of ['npm test --coverage', '12 passed', 'TS2345', 'src/x.ts', '[tool]', 'bash']) {
      assert.ok(!chain.includes(forbidden), `tool data leaked into the chain: ${forbidden}`);
    }
    assert.ok(chain.includes('Running them now.'));
    assert.ok(chain.includes('All green.'));
  });

  test('the newest pair survives IN FULL even when it alone blows the budget', () => {
    const bigAsk = `PLEASE ${'q'.repeat(3000)} END-OF-ASK`;
    const bigReply = `${'r'.repeat(3000)} FINAL: shipped.`;
    const chain = buildConversationChain([user('old'), assistant(textPart('old reply')), user(bigAsk), assistant(textPart(bigReply))], {
      maxChars: 500,
    });
    assert.ok(chain.includes(bigAsk), 'newest user message must survive whole');
    assert.ok(chain.includes(bigReply), 'newest assistant message must survive whole');
    assert.ok(chain.length > 6000, `newest pair was cut to the budget: ${chain.length}`);
  });

  test('the newest pair is still capped at PROMPT_TEXT_LIMIT, tail-preserved and marked', () => {
    const reply = `${'z'.repeat(PROMPT_TEXT_LIMIT + 5000)}FINAL LINE: done.`;
    const chain = buildConversationChain([user('go'), assistant(textPart(reply))]);
    assert.ok(chain.includes('FINAL LINE: done.'), 'conclusion must survive');
    assert.match(chain, /truncated by supervisor/i);
  });

  test('older pairs are TRIMMED to fit, not silently dropped, and the trim is marked', () => {
    const chain = buildConversationChain(
      [
        user(`OLDSTART ${'a'.repeat(4000)}`),
        assistant(textPart(`${'b'.repeat(4000)} OLDEND`)),
        user('newest ask'),
        assistant(textPart('newest reply')),
      ],
      { maxChars: 900 }
    );
    // the older turn is present in shortened form...
    assert.ok(chain.includes('OLDSTART'), 'older user turn was dropped instead of trimmed');
    assert.ok(chain.includes('OLDEND'), 'older assistant turn was dropped instead of trimmed');
    assert.ok(!chain.includes('a'.repeat(3000)), 'older turn was not actually trimmed');
    // ...and the judge is told WE did the cutting.
    assert.match(chain, /conversation trimmed by supervisor/i);
    assert.match(chain, /NOT by the agent/i);
    // ...and the newest pair is intact.
    assert.ok(chain.includes('newest ask'));
    assert.ok(chain.includes('newest reply'));
  });

  test('turns older than the budget are dropped and COUNTED in the marker', () => {
    const msgs = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(user(`ask ${i} ${'x'.repeat(1500)}`), assistant(textPart(`reply ${i} ${'y'.repeat(1500)}`)));
    }
    const chain = buildConversationChain(msgs, { maxChars: 4000 });
    assert.match(chain, /conversation trimmed by supervisor/i);
    assert.match(chain, /turn\(s\) omitted entirely/i);
    assert.ok(!chain.includes('ask 0 '), 'the stalest turn should be gone');
    assert.ok(chain.includes('ask 11 '), 'the newest turn must survive');
  });

  test('the trim marker is the FIRST thing the judge reads', () => {
    const chain = buildConversationChain(
      [user('old '.repeat(500)), assistant(textPart('old reply')), user('new'), assistant(textPart('new reply'))],
      { maxChars: 300 }
    );
    assert.ok(chain.startsWith('[…conversation trimmed by supervisor'), chain.slice(0, 120));
  });

  test('an untrimmed chain carries NO marker noise', () => {
    const chain = buildConversationChain([user('short'), assistant(textPart('also short'))]);
    assert.ok(!chain.includes('trimmed by supervisor'));
    assert.ok(!chain.includes('truncated by supervisor'));
  });

  test('empty / junk input is safe', () => {
    assert.equal(buildConversationChain([]), '');
    assert.equal(buildConversationChain(null), '');
    assert.equal(buildConversationChain([assistant(textPart('no user yet'))]), '');
  });

  test('the chain budget is a real bound, materially smaller than unbounded history', () => {
    assert.ok(CHAIN_MAX_CHARS >= 4000 && CHAIN_MAX_CHARS <= 20000, `unexpected budget: ${CHAIN_MAX_CHARS}`);
  });
});

describe('the judge prompts carry the chain and nothing else', () => {
  const ctx = {
    taskSummary: 'deploy it',
    currentTask: 'deploy it',
    conversationChain:
      'user:\nwrite the PRD\n\nassistant:\nPRD written\n\n---\n\nuser:\ndeploy it\n\nassistant:\nDeployed.',
    taskType: 'coding',
    agentMode: 'build',
    toolsSummary: 'bash: npm test\nbash: kubectl apply',
    detectedSignals: [],
  };

  test('self-assessment prompt renders the whole conversation', () => {
    const p = buildSelfAssessmentPrompt(ctx, '', 'Deployed.', 0, undefined, 3);
    assert.match(p, /## Conversation/);
    assert.ok(p.includes('write the PRD'), 'earlier turn missing');
    assert.ok(p.includes('Deployed.'), 'latest reply missing');
    assert.match(p, /judge ONLY whether the LAST user request was satisfied/i);
  });

  test('judge prompt does the same', () => {
    const p = buildJudgePrompt(ctx, '{"complete":true}', null);
    assert.match(p, /## Conversation/);
    assert.ok(p.includes('write the PRD'));
    assert.ok(p.includes('Deployed.'));
  });

  test('tool commands / tool activity are NOT in either judge prompt', () => {
    for (const p of [buildSelfAssessmentPrompt(ctx, '', 'Deployed.', 0, undefined, 3), buildJudgePrompt(ctx, '{}', null)]) {
      assert.ok(!p.includes('kubectl apply'), 'toolsSummary leaked into a judge prompt');
      assert.ok(!p.includes('Recent tool activity'), 'tool-activity telemetry must never reach a judge prompt');
      assert.ok(!p.includes('Tool Commands Run'));
      assert.ok(!p.includes('Tool Signals'));
    }
  });

  test('legacy context without a chain still renders its ask as a one-turn chain', () => {
    const p = buildSelfAssessmentPrompt(
      { taskSummary: 'legacy summary', taskType: 'other', agentMode: 'build', toolsSummary: '(none)', detectedSignals: [] },
      '', 'legacy reply', 0, undefined, 3
    );
    assert.match(p, /## Conversation/);
    assert.ok(p.includes('user:\nlegacy summary'));
    assert.ok(p.includes('assistant:\nlegacy reply'));
  });
});
