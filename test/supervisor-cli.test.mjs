/** Real CC CLI/hook entry points, isolated state, deterministic judge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goalStore, writeProjectGoal, readProjectGoalContract } from '../core/goal.mjs';
import { statePath, sessionStore } from '../core/session-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, '..', 'bin', 'supervisor.mjs');
const SUPERVISOR_GOAL = path.join(HERE, '..', 'bin', 'supervisor-goal.mjs');
const ON_STOP = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');
const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sup-cli-'));
const cleanEnv = () => ({ ...process.env, SUPERVISOR_SESSION_ID: '', CLAUDE_SESSION_ID: '' });

function writeSession(tmp, sid) {
  fs.mkdirSync(path.join(tmp, '.supervisor'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.supervisor', 'current_session'), sid);
}
function runSupervisor(tmp, args, env = {}) {
  const r = spawnSync('node', [SUPERVISOR, ...args], {
    cwd: tmp, encoding: 'utf8', env: { ...cleanEnv(), ...env },
  });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}
function loadState(tmp, sid) {
  try { return JSON.parse(fs.readFileSync(statePath(tmp, sid), 'utf8')); }
  catch { return null; }
}
function runHook(tmp, sid, text = 'Edited server.js. Next: run tests.', env = {}) {
  const tp = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(tp, [
    { type: 'user', message: { role: 'user', content: 'implement and verify the health endpoint' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ].map((turn) => JSON.stringify(turn)).join('\n'));
  const r = spawnSync('node', [ON_STOP], {
    input: JSON.stringify({ session_id: sid, cwd: tmp, transcript_path: tp, last_assistant_message: text }),
    encoding: 'utf8', env: { ...cleanEnv(), SUPERVISOR_FAKE_JUDGE: 'incomplete', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout || '').trim();
}

for (const args of [
  ['reflection'], ['autopilot'], ['autopilot', 'on'], ['autopilot', 'off'],
  ['autopilot', 'status'], ['mode', 'goal'], ['mode', 'reflection'],
  ['supervisor', 'autopilot'], ['supervisor', 'reflection'], ['supervisor', 'mode', 'goal'],
]) {
  test(`removed command ${args.join(' ')} fails nonzero without changing a goal`, () => {
    const tmp = mktmp();
    const sid = 'removed-command';
    writeSession(tmp, sid);
    runSupervisor(tmp, ['set-goal', 'all tests pass']);
    const before = loadState(tmp, sid);
    const out = runSupervisor(tmp, args);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /removed/i);
    assert.match(out.stdout, /set-goal/);
    assert.deepEqual(loadState(tmp, sid), before);
  });
}

test('removed command fails even without a session; does not silently enable', () => {
  const tmp = mktmp();
  const out = runSupervisor(tmp, ['autopilot']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /removed/i);
  assert.equal(fs.existsSync(path.join(tmp, '.supervisor', 'disabled')), false);
});

test('explicit goal contract persists as user-owned; clear suppresses project fallback', () => {
  const tmp = mktmp();
  const sid = 'contract';
  writeSession(tmp, sid);
  const out = runSupervisor(tmp, ['set-goal', 'Health endpoint works',
    '--acceptance-criteria', 'GET /health returns 200; failure has coverage',
    '--verification', 'npm test reports no failures']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /evidence|audit/i);
  const state = loadState(tmp, sid);
  assert.equal(state.goal.source, 'user');
  assert.equal(state.goal.acceptanceCriteria, 'GET /health returns 200; failure has coverage');
  assert.equal(state.goal.verification, 'npm test reports no failures');
  assert.equal(state.mode, undefined);
  assert.equal(state.autopilot, undefined);
  assert.match(fs.readFileSync(path.join(tmp, '.agents', 'supervisor', 'Goal.md'), 'utf8'), /Health endpoint works/);
  assert.equal(readProjectGoalContract(tmp).acceptanceCriteria, state.goal.acceptanceCriteria);
  assert.equal(readProjectGoalContract(tmp).verification, state.goal.verification);
  const status = runSupervisor(tmp, ['set-goal']).stdout;
  assert.match(status, /^Goal \(active\)/);
  assert.match(status, /source: user/);
  assert.match(status, /failure has coverage/);
  assert.match(status, /npm test reports no failures/);
  assert.match(runSupervisor(tmp, ['set-goal', 'clear']).stdout, /cleared/i);
  assert.equal(loadState(tmp, sid).goal, undefined);
  assert.equal(loadState(tmp, sid).goalCleared, true);
  assert.equal(runHook(tmp, sid), '', 'clear must not reactivate the saved project goal');
});

test('missing contract option value rejects before any goal write', () => {
  const tmp = mktmp();
  const out = runSupervisor(tmp, ['set-goal', 'ship it', '--session', 'bad-option', '--verification']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /requires a non-empty value/);
  assert.equal(loadState(tmp, 'bad-option'), null);
});

test('goal alias and shim retain explicit CLI behavior', () => {
  const tmp = mktmp();
  const sid = 'shim';
  writeSession(tmp, sid);
  const r = spawnSync('node', [SUPERVISOR_GOAL, 'goal', 'ship via shim'], {
    cwd: tmp, encoding: 'utf8', env: cleanEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Goal set for session/);
  assert.equal(loadState(tmp, sid).goal.condition, 'ship via shim');
});

test('resume preserves a paused contract and reports the actual lifecycle', () => {
  const tmp = mktmp();
  const sid = 'resume';
  writeSession(tmp, sid);
  goalStore.setGoal(tmp, sid, 'ship it', { acceptanceCriteria: 'coverage passes', verification: 'npm test' });
  sessionStore.mutate(tmp, sid, (s) => { s.goal.status = 'paused'; s.goal.lastReason = 'stuck'; });
  assert.match(runSupervisor(tmp, ['set-goal', 'resume']).stdout, /resumed/i);
  assert.equal(loadState(tmp, sid).goal.status, 'active');
  assert.equal(loadState(tmp, sid).goal.acceptanceCriteria, 'coverage passes');
  assert.equal(loadState(tmp, sid).goal.verification, 'npm test');
  assert.match(runSupervisor(tmp, ['set-goal', 'resume']).stdout, /already active/i);
});

test('retry values persist verbatim, with the effective CC cap reported', () => {
  for (const [arg, expected] of [['7', 7], ['500', 500], ['unlimited', 'unlimited'], ['0', 'unlimited'], ['off', 'unlimited']]) {
    const tmp = mktmp();
    writeSession(tmp, 'retry');
    const out = runSupervisor(tmp, ['retry', arg]);
    assert.equal(out.status, 0);
    assert.equal(loadState(tmp, 'retry').maxAttempts, expected);
    if (expected === 'unlimited' || expected > 7) assert.match(out.stdout, /Claude Code caps.*7/i);
    const status = runSupervisor(tmp, ['retry']).stdout;
    assert.match(status, /in effect: 7/);
    if (expected === 'unlimited') assert.match(status, /reduced from unlimited/i);
  }
});

test('invalid retry fails loudly without rewriting stored choice', () => {
  const tmp = mktmp();
  writeSession(tmp, 'retry-invalid');
  runSupervisor(tmp, ['retry', '9']);
  for (const bad of ['-5', '3.5', 'abc']) {
    const out = runSupervisor(tmp, ['retry', bad]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /Invalid retry value/);
    assert.equal(loadState(tmp, 'retry-invalid').maxAttempts, 9);
  }
});

test('off/on modify only the resolved disabled-list entry; env beats shared fallback', () => {
  const tmp = mktmp();
  writeSession(tmp, 'other-session');
  const env = { CLAUDE_SESSION_ID: 'caller-session' };
  const out = runSupervisor(tmp, ['off'], env);
  assert.match(out.stdout, /disabled for session: caller-session/);
  const disabled = path.join(tmp, '.supervisor', 'disabled');
  assert.equal(fs.readFileSync(disabled, 'utf8').trim(), 'caller-session');
  assert.match(runSupervisor(tmp, ['on'], env).stdout, /re-enabled/);
  assert.equal(fs.readFileSync(disabled, 'utf8').trim(), '');
});

test('status forwards explicit identity instead of reading another current_session', () => {
  const tmp = mktmp();
  goalStore.setGoal(tmp, 'caller-full-id', 'caller goal', { acceptanceCriteria: 'criterion alpha', verification: 'check alpha' });
  goalStore.setGoal(tmp, 'other-full-id', 'other goal');
  writeSession(tmp, 'other-full-id');
  const out = runSupervisor(tmp, ['status', '--session', 'caller-full-id']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /supervisor\s+goal-based/);
  assert.match(out.stdout, /goal condition\s+caller goal/);
  assert.match(out.stdout, /goal source\s+user/);
  assert.match(out.stdout, /acceptance criteria\s+.*criterion alpha/);
  assert.match(out.stdout, /verification\s+.*check alpha/);
  assert.doesNotMatch(out.stdout, /goal condition\s+other goal/);
});

test('status on/off toggles roadmap only, not supervision enablement or contract', () => {
  const tmp = mktmp();
  const sid = 'status-toggle';
  writeSession(tmp, sid);
  goalStore.setGoal(tmp, sid, 'finish task');
  runSupervisor(tmp, ['off']);
  assert.equal(runSupervisor(tmp, ['status', 'on']).status, 0);
  assert.equal(loadState(tmp, sid).statusDiagram, true);
  assert.equal(loadState(tmp, sid).goal.condition, 'finish task');
  assert.match(runSupervisor(tmp, ['status', 'off']).stdout, /status directive\s+off/);
  assert.equal(fs.readFileSync(path.join(tmp, '.supervisor', 'disabled'), 'utf8').trim(), sid);
});

test('unknown command lists current commands, not retired execution choices', () => {
  const out = runSupervisor(mktmp(), ['frobnicate']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /set-goal/);
  assert.doesNotMatch(out.stdout, /autopilot|reflection/);
});

test('no goal allows stop without calling judge or producing verdict/prompt', () => {
  const tmp = mktmp();
  const sid = 'no-goal';
  assert.equal(runHook(tmp, sid, 'Done.', {
    SUPERVISOR_FAKE_JUDGE: 'JUDGE_UNREACHABLE', SUPERVISOR_DUMP_PROMPT: '.supervisor/prompt.txt',
  }), '');
  assert.equal(sessionStore.lastVerdict(tmp, sid), null);
  assert.equal(fs.existsSync(path.join(tmp, '.supervisor', 'health.json')), false);
  assert.equal(fs.existsSync(path.join(tmp, '.supervisor', 'prompt.txt')), false);
  assert.equal(sessionStore.readAttempts(tmp, sid), 0);
});

test('completed sentinel still audits unmet criteria; contract reaches the judge', () => {
  const tmp = mktmp();
  const sid = 'completed-unverified';
  goalStore.setGoal(tmp, sid, 'health endpoint verified', {
    acceptanceCriteria: 'success and failure cases pass', verification: 'npm test: report count and result',
  });
  const out = runHook(tmp, sid, 'Done.\nSUPERVISOR_LOOP_EXIT: completed', {
    SUPERVISOR_DUMP_PROMPT: '.supervisor/prompt.txt',
  });
  assert.equal(JSON.parse(out).decision, 'block');
  assert.equal(goalStore.load(tmp, sid).goal.status, 'active');
  const prompt = fs.readFileSync(path.join(tmp, '.supervisor', 'prompt.txt'), 'utf8');
  assert.match(prompt, /success and failure cases pass/);
  assert.match(prompt, /npm test: report count and result/);
  assert.equal(sessionStore.lastVerdict(tmp, sid).goal, 'continue');
});

test('completed sentinel plus judge-confirmed evidence retires the goal', () => {
  const tmp = mktmp();
  const sid = 'completed-evidenced';
  goalStore.setGoal(tmp, sid, 'tests pass');
  assert.equal(runHook(tmp, sid, 'npm test: 42 passed, zero failures.\nSUPERVISOR_LOOP_EXIT: completed', {
    SUPERVISOR_FAKE_JUDGE: 'complete',
  }), '');
  assert.equal(goalStore.load(tmp, sid).goal, undefined);
  assert.equal(sessionStore.lastVerdict(tmp, sid).goal, 'achieved');
});

test('project fallback is judged; paused and cleared sessions never reactivate it', () => {
  const tmp = mktmp();
  writeProjectGoal(tmp, 'project contract');
  assert.equal(JSON.parse(runHook(tmp, 'inherits')).decision, 'block');
  goalStore.setGoal(tmp, 'paused', 'session contract');
  sessionStore.mutate(tmp, 'paused', (s) => { s.goal.status = 'paused'; });
  assert.equal(runHook(tmp, 'paused'), '');
  assert.equal(goalStore.load(tmp, 'paused').goal.status, 'paused');
  goalStore.clearGoal(tmp, 'cleared');
  assert.equal(runHook(tmp, 'cleared'), '');
});

test('project acceptance criteria and verification reach the CC judge, not just its condition', () => {
  const tmp = mktmp();
  writeProjectGoal(tmp, 'project condition', {
    acceptanceCriteria: 'project-specific acceptance case', verification: 'project-specific verification command',
  });
  const out = runHook(tmp, 'project-contract', 'Implementation still pending.', {
    SUPERVISOR_DUMP_PROMPT: '.supervisor/prompt.txt',
  });
  assert.equal(JSON.parse(out).decision, 'block');
  const prompt = fs.readFileSync(path.join(tmp, '.supervisor', 'prompt.txt'), 'utf8');
  assert.match(prompt, /project-specific acceptance case/);
  assert.match(prompt, /project-specific verification command/);
});

test('judge failure never achieves an active goal, even after completed sentinel', () => {
  const tmp = mktmp();
  const sid = 'unreachable-judge';
  goalStore.setGoal(tmp, sid, 'all tests pass');
  assert.equal(runHook(tmp, sid, 'SUPERVISOR_LOOP_EXIT: completed', {
    SUPERVISOR_FAKE_JUDGE: 'JUDGE_UNREACHABLE',
  }), '');
  assert.equal(goalStore.load(tmp, sid).goal.status, 'active');
  assert.equal(sessionStore.lastVerdict(tmp, sid), null);
  const health = JSON.parse(fs.readFileSync(path.join(tmp, '.supervisor', 'health.json'), 'utf8'));
  assert.equal(health.status, 'judge_unreachable');
});

test('stuck at the CC cap still pauses the goal and logs the declared reason', () => {
  const tmp = mktmp();
  const sid = 'capped-stuck';
  goalStore.setGoal(tmp, sid, 'all tests pass');
  sessionStore.writeAttempts(tmp, sid, 7, 'implement and verify the health endpoint');
  assert.equal(runHook(tmp, sid, 'SUPERVISOR_LOOP_EXIT: stuck — no credentials'), '');
  assert.equal(goalStore.load(tmp, sid).goal.status, 'paused');
  assert.equal(sessionStore.lastVerdict(tmp, sid).loop_exit, 'stuck');
  const rec = JSON.parse(fs.readFileSync(path.join(tmp, '.supervisor', 'loop-exit.log'), 'utf8').trim());
  assert.equal(rec.reason, 'stuck');
  assert.equal(sessionStore.readAttempts(tmp, sid), 7, 'a pause is not another injection');
});

test('stuck pauses inherited project goal, logs evidence and suppresses later fallback', () => {
  const tmp = mktmp();
  const sid = 'project-stuck';
  writeProjectGoal(tmp, 'project contract');
  assert.equal(runHook(tmp, sid, 'SUPERVISOR_LOOP_EXIT: stuck — needs credentials'), '');
  assert.equal(goalStore.load(tmp, sid).goal.status, 'paused');
  assert.equal(goalStore.load(tmp, sid).goal.condition, 'project contract');
  assert.equal(runHook(tmp, sid, 'Waiting for credentials.'), '');
  const log = fs.readFileSync(path.join(tmp, '.supervisor', 'loop-exit.log'), 'utf8');
  assert.equal(JSON.parse(log.trim()).reason, 'stuck');
});
