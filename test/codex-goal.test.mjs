import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionStore } from '../core/session-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'bin', 'codex-supervisor-hook.mjs');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-goal-hook-'));
  fs.mkdirSync(path.join(cwd, '.supervisor'), { recursive: true });
  return cwd;
}

function run(cwd, input) {
  return spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify(input), encoding: 'utf8' });
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function reviewer(cwd, answers) {
  const script = path.join(cwd, 'reviewer.mjs');
  const answersFile = path.join(cwd, 'answers.json');
  const callsFile = path.join(cwd, 'calls.jsonl');
  writeJson(answersFile, answers);
  fs.writeFileSync(script, `import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
fs.appendFileSync(${JSON.stringify(callsFile)}, input + '\\n');
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answersFile)}, 'utf8'));
const output = parsed.kind === 'goal-derive' ? answers.derive : parsed.kind === 'goal-review' ? answers.review : answers.observer;
console.log(JSON.stringify(output));
`);
  return { script, callsFile, answersFile };
}

function calls(callsFile) {
  if (!fs.existsSync(callsFile)) return [];
  return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function configure(cwd, script, goal = {}) {
  writeJson(path.join(cwd, '.supervisor', 'codex.json'), {
    enabled: true,
    observer: { enabled: false },
    goal: { enabled: true, infer: true, judgeOnStop: true, ...goal },
    reviewerCommand: [process.execPath, script],
  });
}

function prompt(cwd, text = 'Implement the requested change.') {
  const result = run(cwd, { hook_event_name: 'UserPromptSubmit', session_id: 's1', turn_id: 't1', prompt: text });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
}

function post(cwd, i = 1, extra = {}) {
  return run(cwd, {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    turn_id: 't1',
    tool_use_id: `call-${i}`,
    tool_name: 'exec_command',
    model: 'gpt-6-luna',
    tool_input: { command: 'npm test', path: 'test/example.test.mjs' },
    tool_response: 'not yet run',
    ...extra,
  });
}

function stop(cwd, text, extra = {}) {
  return run(cwd, { hook_event_name: 'Stop', session_id: 's1', turn_id: 't1', last_assistant_message: text, ...extra });
}

const derived = { goal: 'All tests in test/ pass and the implementation is complete.', falsifiable: true, rationale: 'Running the test command proves it.' };
const incomplete = { complete: false, reason: 'The tests were not run.', correction: 'Run npm test and report the exact result.', evidence: '' };
const complete = { complete: true, reason: 'The test suite passed.', correction: '', evidence: 'npm test exited 0 with 49 passing tests.' };

test('derives one goal per turn, then blocks Stop until the reviewer sees completion', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: incomplete });
  configure(cwd, script, { maxAttempts: 2 });
  prompt(cwd);

  const first = post(cwd);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {});
  const state = sessionStore.load(cwd, 's1');
  assert.equal(state.goal.condition, derived.goal);
  assert.equal(state.goal.source, 'inferred');
  assert.equal(state.goal.status, 'active');
  assert.equal(calls(callsFile).length, 1);
  assert.equal(calls(callsFile)[0].kind, 'goal-derive');
  assert.match(calls(callsFile)[0].goal_prompt, /Implement the requested change/);
  assert.match(calls(callsFile)[0].goal_prompt, /npm test/);

  const second = post(cwd, 2);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(calls(callsFile).length, 1, 'a second tool call must not derive another goal');

  const blocked = stop(cwd, 'Done.');
  assert.equal(blocked.status, 0, blocked.stderr);
  const output = JSON.parse(blocked.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Run npm test and report the exact result/);
  assert.match(output.reason, /SUPERVISOR_LOOP_EXIT: completed/);

  const after = sessionStore.load(cwd, 's1');
  assert.equal(after.goal.attempts, 1);
  assert.equal(after.attempts.count, 1);
  assert.equal(after.attempts.turnKey, 't1');
  const review = calls(callsFile).at(-1);
  assert.equal(review.kind, 'goal-review');
  assert.match(review.goal_prompt, /All tests in test\/ pass/);
  assert.match(review.goal_prompt, /Done\./);
  assert.match(review.goal_prompt, /npm test/);
});

test('Stop falls back to the Codex transcript when last_assistant_message is null', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: incomplete });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  const transcript = path.join(cwd, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Implement the requested change.' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done from transcript.' }] } }),
  ].join('\n') + '\n');
  const result = stop(cwd, '', { last_assistant_message: null, transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  assert.match(calls(callsFile).at(-1).goal_prompt, /Done from transcript\./);
});

test('runaway cap persists exhaustion and stops blocking', () => {
  const cwd = fixture();
  const { script } = reviewer(cwd, { derive: derived, review: incomplete });
  configure(cwd, script, { maxAttempts: 1 });
  prompt(cwd);
  post(cwd);
  assert.equal(JSON.parse(stop(cwd, 'Done.').stdout).decision, 'block');

  const exhausted = stop(cwd, 'Still done.');
  assert.equal(exhausted.status, 0, exhausted.stderr);
  assert.deepEqual(JSON.parse(exhausted.stdout), {});
  const state = sessionStore.load(cwd, 's1');
  assert.equal(state.goal.status, 'exhausted');
  assert.match(state.goal.lastReason, /set-goal resume/);
  assert.match(state.goal.lastReason, /--session "s1"/);
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'goal-turn-budget-spent');
});

test('completed reviewer verdict clears an inferred goal and records evidence', () => {
  const cwd = fixture();
  const { script } = reviewer(cwd, { derive: derived, review: complete });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  const result = stop(cwd, 'All tests pass.');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const state = sessionStore.load(cwd, 's1');
  assert.equal(state.goal, undefined);
  const audit = sessionStore.readVerdicts(cwd, 's1');
  assert.equal(audit.at(-1).decision, 'goal-achieved');
  assert.match(audit.at(-1).evidence, /49 passing tests/);
});

test('a project goal is adopted, then retired only after a complete verdict', () => {
  const cwd = fixture();
  const { script, answersFile } = reviewer(cwd, { derive: derived, review: incomplete });
  configure(cwd, script);
  fs.mkdirSync(path.join(cwd, '.agents', 'supervisor'), { recursive: true });
  const goalFile = path.join(cwd, '.agents', 'supervisor', 'goal.md');
  fs.writeFileSync(goalFile, 'All tests in test/ pass.');
  prompt(cwd);
  post(cwd);
  assert.equal(JSON.parse(stop(cwd, 'Tests are still running.').stdout).decision, 'block');
  assert.equal(sessionStore.load(cwd, 's1').goal.source, 'project');

  writeJson(answersFile, { derive: derived, review: complete });
  const result = stop(cwd, 'All tests pass.');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(fs.existsSync(goalFile), false);
  assert.equal(sessionStore.load(cwd, 's1').goal, undefined);
  const log = fs.readFileSync(path.join(cwd, '.supervisor', 'goal-achieved.log'), 'utf8');
  assert.match(log, /codex:project-goal-achieved/);
});

test('stuck sentinel pauses the goal and never runs the completion judge', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: complete });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  const result = stop(cwd, 'I cannot finish this.\nSUPERVISOR_LOOP_EXIT: stuck — tests need a service I cannot start.');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const state = sessionStore.load(cwd, 's1');
  assert.equal(state.goal.status, 'paused');
  assert.match(state.goal.lastReason, /service I cannot start/);
  assert.match(state.goal.lastReason, /set-goal resume/);
  assert.match(state.goal.lastReason, /--session "s1"/);
  assert.equal(calls(callsFile).length, 1, 'stuck must not call the goal reviewer');
  const log = fs.readFileSync(path.join(cwd, '.supervisor', 'loop-exit.log'), 'utf8');
  assert.match(log, /"reason":"stuck"/);
});

test('completed sentinel stops the loop without judging or clearing an active goal', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: complete });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  const result = stop(cwd, 'Work finished.\nSUPERVISOR_LOOP_EXIT: completed');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(sessionStore.load(cwd, 's1').goal.status, 'active');
  assert.equal(calls(callsFile).length, 1);
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'goal-loop-exit');
});

test('reviewer failure fails open, leaves the goal active, and audits the warning', () => {
  const cwd = fixture();
  const { script } = reviewer(cwd, { derive: derived, review: { complete: 'not-a-boolean' } });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  const result = stop(cwd, 'Done.');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(sessionStore.load(cwd, 's1').goal.status, 'active');
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'goal-review-warning');
});

test('derivation failure never fabricates a goal', () => {
  const cwd = fixture();
  const { script } = reviewer(cwd, { derive: { goal: '', falsifiable: false, rationale: 'Not enough context.' }, review: complete });
  configure(cwd, script);
  prompt(cwd);
  post(cwd);
  assert.equal(sessionStore.load(cwd, 's1').goal, undefined);
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'goal-derivation-warning');
});

test('goal mode stays disabled when infer is false or the top-level switch is off', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: complete });
  configure(cwd, script, { infer: false });
  prompt(cwd);
  post(cwd);
  assert.equal(sessionStore.load(cwd, 's1').goal, undefined);
  assert.equal(calls(callsFile).length, 0);

  const off = fixture();
  const offReviewer = reviewer(off, { derive: derived, review: complete });
  writeJson(path.join(off, '.supervisor', 'codex.json'), {
    enabled: false,
    observer: { enabled: false },
    goal: { enabled: true, infer: true },
    reviewerCommand: [process.execPath, offReviewer.script],
  });
  prompt(off);
  post(off);
  assert.equal(sessionStore.load(off, 's1').goal, undefined);
  assert.equal(calls(offReviewer.callsFile).length, 0);
});

test('a repeated final answer stands down instead of judging forever', () => {
  const cwd = fixture();
  const { script, callsFile } = reviewer(cwd, { derive: derived, review: incomplete });
  configure(cwd, script, { maxAttempts: 10 });
  prompt(cwd);
  post(cwd);
  assert.equal(JSON.parse(stop(cwd, 'Same answer.').stdout).decision, 'block');
  assert.equal(JSON.parse(stop(cwd, 'Same answer.').stdout).decision, 'block');
  const third = stop(cwd, 'Same answer.');
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(JSON.parse(third.stdout), {});
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'goal-no-progress');
  assert.equal(calls(callsFile).filter((call) => call.kind === 'goal-review').length, 2);
});
