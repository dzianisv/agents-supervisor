import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loopGuard, sanitizeCwd, readAttempts, writeAttemptCounter,
  writeVerdict, readTranscriptTail, buildStopContext,
  normalizeTranscriptToMessages, buildTaskContextFromTranscript,
  endsWithTrailingQuestion, computeTurnKey, buildFakeAssessment,
} from '../bin/supervisor-on-stop.mjs';
import { FEEDBACK_MARKER } from '../core/evaluation.mjs';

// Project root — used by new tests that must not write to /tmp.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mkcwd() {
  const d = fs.mkdtempSync(path.join(tmpdir(), 'sup-test-'));
  return d;
}

test('loopGuard fires only when stop_hook_active', () => {
  assert.equal(loopGuard({ stop_hook_active: true }), true);
  assert.equal(loopGuard({ stop_hook_active: false }), false);
  assert.equal(loopGuard({}), false);
});

test('endsWithTrailingQuestion: true when last non-empty line ends in ?', () => {
  assert.equal(endsWithTrailingQuestion('I fixed the bug.\n\nWant me to also add a test?'), true);
  assert.equal(endsWithTrailingQuestion('Should I proceed?'), true);
  assert.equal(endsWithTrailingQuestion('Which approach do you prefer?\n'), true, 'trailing blank line ignored');
});

test('endsWithTrailingQuestion: false for statements, non-strings, and empty input', () => {
  assert.equal(endsWithTrailingQuestion('I fixed the bug and ran the tests.'), false);
  assert.equal(endsWithTrailingQuestion('Is this right? Yes, it is.'), false, 'question not in final line');
  assert.equal(endsWithTrailingQuestion(''), false);
  assert.equal(endsWithTrailingQuestion(undefined), false);
  assert.equal(endsWithTrailingQuestion(null), false);
  assert.equal(endsWithTrailingQuestion(42), false);
});

test('sanitizeCwd rejects relative / traversal paths', () => {
  const d = mkcwd();
  assert.equal(sanitizeCwd(d), d);
  assert.throws(() => sanitizeCwd('rel/path'));
  assert.throws(() => sanitizeCwd(`${d}/../foo`));
});

test('attempt counter: round-trips and is monotonic', () => {
  const d = mkcwd();
  assert.equal(readAttempts('s1', d), 0);
  writeAttemptCounter('s1', 2, d);
  assert.equal(readAttempts('s1', d), 2);
  writeAttemptCounter('s1', 1, d); // lower ignored
  assert.equal(readAttempts('s1', d), 2);
  writeAttemptCounter('s1', 3, d);
  assert.equal(readAttempts('s1', d), 3);
});

// ---------------------------------------------------------------------------
// computeTurnKey + turn-scoped attempt counter (Fix C.1)
// ---------------------------------------------------------------------------

test('computeTurnKey: fingerprints the last real (non-supervisor) user message', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'fix the bug' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ]);
  assert.equal(computeTurnKey(msgs), 'fix the bug');
});

test('computeTurnKey: skips supervisor-injected feedback text, uses the real message underneath', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'fix the bug' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } },
    { type: 'user', message: { role: 'user', content: `${FEEDBACK_MARKER} Task Incomplete\nsome injected text` } },
  ]);
  assert.equal(computeTurnKey(msgs), 'fix the bug');
});

test('computeTurnKey: null when no genuine user message is present', () => {
  assert.equal(computeTurnKey([]), null);
  const msgs = normalizeTranscriptToMessages([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ]);
  assert.equal(computeTurnKey(msgs), null);
});

test('computeTurnKey: truncates to 300 chars', () => {
  const long = 'x'.repeat(500);
  const msgs = normalizeTranscriptToMessages([{ type: 'user', message: { role: 'user', content: long } }]);
  assert.equal(computeTurnKey(msgs).length, 300);
});

test('turn-scoped attempt counter: persists across the same turn_key, resets on a new one', () => {
  const d = mkcwd();
  writeAttemptCounter('s5', 1, d, 'turn-A');
  writeAttemptCounter('s5', 2, d, 'turn-A');
  assert.equal(readAttempts('s5', d, 'turn-A'), 2, 'same turn_key: counter persists');
  assert.equal(readAttempts('s5', d, 'turn-B'), 0, 'new turn_key: counter resets to 0');
});

test('writeAttemptCounter: a new turn\'s first write is never dropped by the monotonic dedup guard', () => {
  const d = mkcwd();
  writeAttemptCounter('s6', 5, d, 'turn-A');
  assert.equal(readAttempts('s6', d, 'turn-A'), 5);
  writeAttemptCounter('s6', 1, d, 'turn-B');
  assert.equal(readAttempts('s6', d, 'turn-B'), 1, "new turn's first write must not be dropped");
});

test('turn-key param omitted: behaves exactly as before (backward compat)', () => {
  const d = mkcwd();
  writeAttemptCounter('s7', 2, d);
  assert.equal(readAttempts('s7', d), 2);
  writeAttemptCounter('s7', 1, d);
  assert.equal(readAttempts('s7', d), 2);
});

test('readAttempts: turnKey passed against a file with no turn_key on disk is treated as same-turn (no spurious reset)', () => {
  const d = mkcwd();
  writeAttemptCounter('s8', 2, d);
  assert.equal(readAttempts('s8', d, 'turn-X'), 2, 'missing turn_key on disk must not be treated as a turn change');
});

test('writeVerdict writes parseable json under .supervisor/', () => {
  const d = mkcwd();
  writeVerdict('s2', { category: 'summary_drift_stop', injected: true }, d);
  const v = JSON.parse(fs.readFileSync(path.join(d, '.supervisor', 'verdict_s2.json'), 'utf8'));
  assert.equal(v.category, 'summary_drift_stop');
  assert.equal(v.injected, true);
});

test('readTranscriptTail parses jsonl, drops pure tool_result user turns', () => {
  const d = mkcwd();
  const f = path.join(d, 't.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Next step: run tests.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    'not json — skip me',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  fs.writeFileSync(f, lines);
  const tail = readTranscriptTail(f);
  assert.equal(tail.length, 2); // tool_result-only user turn excluded, bad line skipped
  assert.equal(tail[0].type, 'user');
  assert.equal(tail[1].type, 'assistant');
});

test('buildStopContext extracts final assistant text, user msgs, tools', () => {
  const d = mkcwd();
  const tail = [
    { type: 'user', message: { role: 'user', content: 'add feature X' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'text', text: 'I created the file. Next step: run the tests.' },
    ] } },
  ];
  const ctx = buildStopContext({ session_id: 's3', cwd: d }, tail);
  assert.equal(ctx.session_id, 's3');
  assert.match(ctx.final_assistant_text, /run the tests/);
  assert.deepEqual(ctx.user_messages, ['add feature X']);
  assert.deepEqual(ctx.tools_available_inferred, ['Bash']);
});

test('buildStopContext prefers payload.last_assistant_message', () => {
  const ctx = buildStopContext(
    { session_id: 's4', last_assistant_message: 'direct final text' },
    [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tail text' }] } }],
  );
  assert.equal(ctx.final_assistant_text, 'direct final text');
});

// ---------------------------------------------------------------------------
// normalizeTranscriptToMessages — no /tmp needed (pure function)
// ---------------------------------------------------------------------------

test('normalizeTranscriptToMessages: converts string content', () => {
  const tail = [
    { type: 'user', message: { role: 'user', content: 'hello world' } },
  ];
  const msgs = normalizeTranscriptToMessages(tail);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].info.role, 'user');
  assert.deepEqual(msgs[0].parts, [{ type: 'text', text: 'hello world' }]);
});

test('normalizeTranscriptToMessages: converts array content with text + tool_use', () => {
  const tail = [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'text', text: 'Tests passed.' },
        ],
      },
    },
  ];
  const msgs = normalizeTranscriptToMessages(tail);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].info.role, 'assistant');
  assert.equal(msgs[0].parts.length, 2);
  assert.deepEqual(msgs[0].parts[0], { type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } });
  assert.deepEqual(msgs[0].parts[1], { type: 'text', text: 'Tests passed.' });
});

test('normalizeTranscriptToMessages: skips non-user/assistant entries', () => {
  const tail = [
    { type: 'system', message: { content: 'ignored' } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ];
  const msgs = normalizeTranscriptToMessages(tail);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].info.role, 'user');
});

test('normalizeTranscriptToMessages: empty string content produces no text part', () => {
  const tail = [
    { type: 'user', message: { role: 'user', content: '   ' } },
  ];
  const msgs = normalizeTranscriptToMessages(tail);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].parts.length, 0);
});

test('normalizeTranscriptToMessages: tool_result blocks are skipped', () => {
  const tail = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
      },
    },
  ];
  const msgs = normalizeTranscriptToMessages(tail);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].parts.length, 0); // tool_result not converted
});

// ---------------------------------------------------------------------------
// buildTaskContextFromTranscript — uses PROJECT_ROOT (has package.json + test/)
// ---------------------------------------------------------------------------

test('buildTaskContextFromTranscript: returns null for no human messages', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.equal(ctx, null);
});

test('buildTaskContextFromTranscript: returns null for empty tail', () => {
  assert.equal(buildTaskContextFromTranscript([], PROJECT_ROOT), null);
});

test('buildTaskContextFromTranscript: builds context with taskSummary from human messages', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'fix the broken tests' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix the tests now.' }] } },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx, 'should return a context object');
  assert.equal(ctx.taskSummary, 'fix the broken tests');
  assert.equal(ctx.taskType, 'coding');
  assert.ok(Array.isArray(ctx.humanMessages));
  assert.deepEqual(ctx.humanMessages, ['fix the broken tests']);
});

test('buildTaskContextFromTranscript: detects tool commands from Bash tool_use', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'run the tests' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'text', text: 'Tests ran.' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  // npm test should be detected as a local test command signal
  assert.ok(ctx.detectedSignals.includes('test-command'), `expected test-command in ${ctx.detectedSignals}`);
});

test('buildTaskContextFromTranscript: Task tool dispatch is visible to the judge (bug 1)', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'refactor the auth module' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: { description: 'Audit auth module for bugs', prompt: 'Full prompt text goes here...' },
          },
          { type: 'text', text: 'Dispatched a subagent to audit auth; waiting on it to report back.' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  // Subagent dispatches must show up in the "Tool Commands Run" summary, otherwise
  // the judge sees zero evidence a background subagent was launched and flags a
  // legitimate wait-for-subagent pause as a premature stop.
  assert.ok(
    ctx.toolsSummary.includes('Task: Audit auth module for bugs'),
    `expected Task dispatch in toolsSummary: ${ctx.toolsSummary}`,
  );
});

test('buildTaskContextFromTranscript: Agent tool dispatch falls back to prompt when no description (bug 1)', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'kick off some background research' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Agent', input: { prompt: 'Research competitor pricing pages and report back.' } },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  assert.ok(
    ctx.toolsSummary.includes('Task: Research competitor pricing pages'),
    `expected Agent dispatch (via prompt fallback) in toolsSummary: ${ctx.toolsSummary}`,
  );
});

test('buildTaskContextFromTranscript: requiresPR/requiresCI false for coding-classified task with no code changes (bug 3)', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'create GitHub epic issues for the Q3 roadmap' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'gh issue create --title "Epic: Q3 roadmap"' } },
          { type: 'text', text: 'Created the epic issues.' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  assert.equal(ctx.taskType, 'coding', `expected task to be classified 'coding': ${ctx.taskType}`);
  assert.equal(ctx.requiresPR, false, 'issue-only task should not require a PR');
  assert.equal(ctx.requiresCI, false, 'issue-only task should not require CI');
});

test('buildTaskContextFromTranscript: requiresPR/requiresCI stay true for coding task with real file edits (bug 3)', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'fix the bug in the parser' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/parser.js' } },
          { type: 'text', text: 'Fixed the parser bug.' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  assert.equal(ctx.taskType, 'coding', `expected task to be classified 'coding': ${ctx.taskType}`);
  assert.equal(ctx.requiresPR, true, 'real code-change task should still require a PR');
  assert.equal(ctx.requiresCI, true, 'real code-change task should still require CI');
});

test('buildTaskContextFromTranscript: latest turn is currentTask, earlier turns are prior context', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'first task' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: 'second task' } },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  // Was: taskSummary joined EVERY user message as "[1]..[n]", unweighted, so a
  // 20-turn session's judge demanded turn 1's deliverables on turn 20. Now the
  // latest ask is the demand and earlier turns are labelled background.
  assert.equal(ctx.currentTask, 'second task');
  assert.equal(ctx.taskSummary, 'second task');
  assert.match(ctx.priorContext, /first task/);
  assert.ok(!ctx.priorContext.includes('second task'));
});

test('buildTaskContextFromTranscript: has required TaskContext fields', () => {
  const msgs = normalizeTranscriptToMessages([
    { type: 'user', message: { role: 'user', content: 'implement a feature' } },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  // All required TaskContext fields must be present
  for (const field of ['taskSummary', 'taskType', 'agentMode', 'humanMessages',
    'toolsSummary', 'detectedSignals', 'recentCommands', 'pushedToDefaultBranch',
    'requiresTests', 'requiresBuild', 'requiresPR', 'requiresCI',
    'requiresLocalTests', 'requiresLocalTestsEvidence']) {
    assert.ok(field in ctx, `missing field: ${field}`);
  }
});

// ---------------------------------------------------------------------------
// buildTaskContextFromTranscript — <task-notification> exclusion.
// Async task-notification blocks are status metadata, not user task
// instructions, and must not leak into taskSummary/humanMessages/combinedText.
// ---------------------------------------------------------------------------

test('buildTaskContextFromTranscript: skips a leading task-notification part and picks up the real text', () => {
  const msgs = normalizeTranscriptToMessages([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<task-notification>Agent X finished with status: done</task-notification>' },
          { type: 'text', text: 'please review the PR' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx, 'should return a context object');
  assert.deepEqual(ctx.humanMessages, ['please review the PR']);
  assert.match(ctx.taskSummary, /please review the PR/);
  assert.doesNotMatch(ctx.taskSummary, /<task-notification>/);
});

test('buildTaskContextFromTranscript: returns null when the only user part is a task-notification', () => {
  const msgs = normalizeTranscriptToMessages([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<task-notification>Agent X finished with status: done</task-notification>' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.equal(ctx, null);
});

test('buildTaskContextFromTranscript: task-notification with leading whitespace is still excluded', () => {
  const msgs = normalizeTranscriptToMessages([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '  <task-notification>Agent X finished with status: done</task-notification>' },
          { type: 'text', text: 'ship the fix' },
        ],
      },
    },
  ]);
  const ctx = buildTaskContextFromTranscript(msgs, PROJECT_ROOT);
  assert.ok(ctx);
  assert.deepEqual(ctx.humanMessages, ['ship the fix']);
});

// ---------------------------------------------------------------------------
// buildFakeAssessment — test-only fake-judge escape hatch (SUPERVISOR_FAKE_JUDGE)
// ---------------------------------------------------------------------------

function baseFakeTaskContext(overrides = {}) {
  return {
    taskSummary: 'do the thing',
    taskType: 'coding',
    agentMode: 'build',
    humanMessages: ['do the thing'],
    toolsSummary: '(none)',
    detectedSignals: [],
    recentCommands: [],
    pushedToDefaultBranch: false,
    requiresTests: true,
    requiresBuild: false,
    requiresPR: false,
    requiresCI: false,
    requiresLocalTests: true,
    requiresLocalTestsEvidence: false,
    ...overrides,
  };
}

test('buildFakeAssessment: recentTestCommands includes real test-runner invocations and excludes install commands', () => {
  const ctx = baseFakeTaskContext({
    recentCommands: ['npm install vitest', 'vitest run', 'node --test test/foo.test.mjs', 'git status'],
  });
  const assessment = buildFakeAssessment(ctx, 'complete');
  assert.deepEqual(assessment.evidence.tests.commands, ['vitest run', 'node --test test/foo.test.mjs']);
  assert.equal(assessment.evidence.tests.ran, true);
});

test('buildFakeAssessment: no matching test commands leaves tests.commands empty', () => {
  const ctx = baseFakeTaskContext({
    recentCommands: ['npm install vitest', 'git status'],
  });
  const assessment = buildFakeAssessment(ctx, 'complete');
  assert.deepEqual(assessment.evidence.tests.commands, []);
  assert.equal(assessment.evidence.tests.ran, false);
});
