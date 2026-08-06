import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statePath } from '../core/session-store.mjs';
import {
  goalStore, resolveMaxAttempts, decideGoalTransition,
  parseSupervisorCommand, buildGoalRequirementSection, DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SUPERVISOR_MODE, resolveSupervisorMode,
  extractGoalCondition, writeProjectGoal, readProjectGoalHistory,
} from '../core/goal.mjs';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-goal-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_GOAL_BIN = path.join(HERE, '..', 'bin', 'supervisor-goal.mjs');

test('goalStore: setGoal/load/clear round-trip, 0600 perms', () => {
  const d = mkcwd();
  assert.deepEqual(goalStore.load(d, 's1'), {});
  goalStore.setGoal(d, 's1', 'all tests pass');
  const st = goalStore.load(d, 's1');
  assert.equal(st.goal.condition, 'all tests pass');
  assert.equal(st.goal.status, 'active');
  assert.equal(st.goal.attempts, 0);
  const mode = fs.statSync(statePath(d, 's1')).mode & 0o777;
  assert.equal(mode, 0o600);
  goalStore.clearGoal(d, 's1');
  assert.equal(goalStore.load(d, 's1').goal, undefined);
});

test('goalStore.setRetry persists override; rejects path traversal', () => {
  const d = mkcwd();
  goalStore.setRetry(d, 's2', 24);
  assert.equal(goalStore.load(d, 's2').maxAttempts, 24);
  assert.throws(() => goalStore.save(d, '../evil', {}));
});

test('resolveMaxAttempts default is 16', () => {
  assert.equal(resolveMaxAttempts({}), DEFAULT_MAX_ATTEMPTS);
  assert.equal(DEFAULT_MAX_ATTEMPTS, 16);
});

test('decideGoalTransition order matches OpenCode impl', () => {
  const g = { condition: 'x', status: 'active', attempts: 0, tokenBaseline: 0, startedAt: 0, deadline: 9e9, lastReason: '' };
  assert.equal(decideGoalTransition({ goal: g, complete: true, now: 1, maxAttempts: 16 }).action, 'achieved');
  assert.equal(decideGoalTransition({ goal: g, complete: false, now: 1, maxAttempts: 16 }).action, 'continue');
  const exhausted = decideGoalTransition({ goal: { ...g, attempts: 16 }, complete: true, now: 1, maxAttempts: 16 });
  assert.equal(exhausted.action, 'exhausted');
  assert.equal(exhausted.reason, 'attempts');
  const past = decideGoalTransition({ goal: { ...g, deadline: 5 }, complete: true, now: 10, maxAttempts: 16 });
  assert.equal(past.action, 'exhausted');
  assert.equal(past.reason, 'deadline');
});

test('parseSupervisorCommand + buildGoalRequirementSection (shared logic)', () => {
  assert.deepEqual(parseSupervisorCommand('goal', 'ship it'), { kind: 'goal-set', condition: 'ship it' });
  assert.equal(parseSupervisorCommand('goal', 'off').kind, 'goal-clear');
  assert.match(buildGoalRequirementSection('ship it'), /MANDATORY/);
  assert.equal(buildGoalRequirementSection(''), '');
});

test('parseSupervisorCommand supports root /supervisor mode UX', () => {
  assert.deepEqual(parseSupervisorCommand('supervisor', ''), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'status'), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'off'), { kind: 'supervisor-off' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'on'), { kind: 'supervisor-on' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'autopilot'), { kind: 'mode-set', mode: 'autopilot' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'static'), { kind: 'mode-set', mode: 'autopilot' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'reflection'), { kind: 'mode-set', mode: 'reflection' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal'), { kind: 'goal-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal clear'), { kind: 'goal-clear' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal all tests pass'), { kind: 'goal-set', condition: 'all tests pass' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'retry 24'), { kind: 'retry-set', n: 24 });
});

test('goalStore persists supervisor mode and resolves legacy state', () => {
  const d = mkcwd();
  assert.equal(DEFAULT_SUPERVISOR_MODE, 'reflection');
  assert.equal(resolveSupervisorMode({}), 'reflection');
  assert.equal(resolveSupervisorMode({ autopilot: true }), 'autopilot');
  assert.equal(resolveSupervisorMode({ goal: { condition: 'x', status: 'active', attempts: 0, tokenBaseline: 0, startedAt: 0, deadline: 9e9, lastReason: '' } }), 'goal');

  goalStore.setGoal(d, 's3', 'ship it');
  assert.equal(goalStore.load(d, 's3').mode, 'goal');
  assert.equal(goalStore.load(d, 's3').autopilot, false);

  goalStore.setMode(d, 's3', 'autopilot');
  assert.equal(goalStore.load(d, 's3').mode, 'autopilot');
  assert.equal(goalStore.load(d, 's3').goal, undefined);
  assert.equal(resolveSupervisorMode(goalStore.load(d, 's3')), 'autopilot');

  goalStore.setAutopilot(d, 's3', false);
  assert.equal(goalStore.load(d, 's3').mode, 'reflection');
  assert.equal(goalStore.load(d, 's3').autopilot, false);
});

// ---------------------------------------------------------------------------
// extractGoalCondition — consolidated from 3 duplicate implementations
// (opencode/supervisor-impl.ts x2, bin/supervisor-on-stop.mjs). Behavior must be
// unchanged for all 3 former call sites.
// ---------------------------------------------------------------------------

test('extractGoalCondition: strips HTML comments', () => {
  const content = '<!-- generated file, do not edit -->\nship the feature';
  assert.equal(extractGoalCondition(content), 'ship the feature');
});

test('extractGoalCondition: prefers ## Goal Condition section when present', () => {
  const content = '# Project Goal\n\nsome preamble\n\n## Goal Condition\nall tests pass and PR is merged\n\n## Notes\nirrelevant';
  assert.equal(extractGoalCondition(content), 'all tests pass and PR is merged');
});

test('extractGoalCondition: falls back to whole trimmed text when no section header', () => {
  assert.equal(extractGoalCondition('  ship it already  \n'), 'ship it already');
});

test('extractGoalCondition: null/empty content returns "" (matches the tryRead(...) call site)', () => {
  assert.equal(extractGoalCondition(null), '');
  assert.equal(extractGoalCondition(''), '');
  assert.equal(extractGoalCondition(undefined), '');
});

// ---------------------------------------------------------------------------
// writeProjectGoal / readProjectGoalHistory — the concurrency fix.
// Bug: .agents/supervisor/Goal.md was a bare writeFile overwrite, no lock, no
// history — concurrent goal-set calls silently destroyed each other (proven:
// 30 concurrent calls in, 1 survivor, 29 gone with zero trace). These tests
// must fail against the old bare-writeFile behavior and pass against the fix.
// ---------------------------------------------------------------------------

test('writeProjectGoal: single write — Goal.md + history both contain the condition', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'ship the feature');
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.equal(goalMd, 'ship the feature');
  const history = readProjectGoalHistory(d);
  assert.equal(history.length, 1);
  assert.equal(history[0].condition, 'ship the feature');
  assert.ok(history[0].ts && history[0].pid, 'history entry must carry ts + pid');
});

test('writeProjectGoal: sequential double-write — current pointer is the last write, history has both', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  writeProjectGoal(d, 'condition B');
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.equal(goalMd, 'condition B', 'current pointer matches today\'s semantics: last write wins');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

test('writeProjectGoal: history survives even when the current-pointer file is deleted', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  fs.rmSync(path.join(d, '.agents', 'supervisor', 'Goal.md'));
  writeProjectGoal(d, 'condition B');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

test('readProjectGoalHistory: missing file returns [] (best effort, never throws)', () => {
  const d = mkcwd();
  assert.deepEqual(readProjectGoalHistory(d), []);
});

test('readProjectGoalHistory: skips a corrupt line instead of failing the whole read', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  fs.appendFileSync(path.join(d, '.agents', 'supervisor', 'goal-history.jsonl'), 'not-json\n');
  writeProjectGoal(d, 'condition B');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

// ---------------------------------------------------------------------------
// Real concurrent OS processes — ports the exact shell repro from
// .tasks/40/bug.md into the test runner. Sync fs calls within ONE process
// can never race each other (the JS event loop serializes them by
// construction) — the actual bug only reproduces across independent
// processes racing the same file, so this spawns real `node
// bin/supervisor-goal.mjs` child processes, not in-process calls.
// ---------------------------------------------------------------------------

function runGoalSet(cwd, condition) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR_GOAL_BIN, 'goal', condition], { cwd });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`supervisor-goal.mjs exited ${code}: ${stderr}`));
    });
  });
}

test('concurrent real processes: 0 conditions lost across N racing goal-set calls', { timeout: 60_000 }, async () => {
  const d = mkcwd();
  fs.mkdirSync(path.join(d, '.supervisor'), { recursive: true });
  fs.writeFileSync(path.join(d, '.supervisor', 'current_session'), 'concurrency-test-session', 'utf8');

  const PER_SIDE = 10; // matches the order of magnitude of the manual repro (15+15)
  const conditions = [];
  for (let i = 0; i < PER_SIDE; i++) {
    conditions.push(`condition-A-run${i}`, `condition-B-run${i}`);
  }

  await Promise.all(conditions.map((c) => runGoalSet(d, c)));

  const history = readProjectGoalHistory(d);
  const recovered = new Set(history.map((h) => h.condition));
  const missing = conditions.filter((c) => !recovered.has(c));
  assert.deepEqual(missing, [], `Lost ${missing.length}/${conditions.length} conditions to the race — history: ${JSON.stringify([...recovered])}`);
  assert.equal(recovered.size, conditions.length, 'every condition must be independently recoverable, no duplicates collapsing the count');

  // The current pointer must be exactly one of the raced conditions — never
  // corrupted/blank/partial (atomic rename guarantees this even though which
  // one wins is non-deterministic).
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.ok(conditions.includes(goalMd), `Goal.md current pointer must be one of the raced conditions, got: ${JSON.stringify(goalMd)}`);
});
