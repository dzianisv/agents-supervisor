import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  goalStore, resolveMaxAttempts, decideGoalTransition,
  parseSupervisorCommand, buildGoalRequirementSection, DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SUPERVISOR_MODE, resolveSupervisorMode,
} from '../core/goal.mjs';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-goal-'));

test('goalStore: setGoal/load/clear round-trip, 0600 perms', () => {
  const d = mkcwd();
  assert.deepEqual(goalStore.load(d, 's1'), {});
  goalStore.setGoal(d, 's1', 'all tests pass');
  const st = goalStore.load(d, 's1');
  assert.equal(st.goal.condition, 'all tests pass');
  assert.equal(st.goal.status, 'active');
  assert.equal(st.goal.attempts, 0);
  const mode = fs.statSync(path.join(d, '.supervisor', 'goals', 's1.json')).mode & 0o777;
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
  assert.equal(decideGoalTransition({ goal: { ...g, attempts: 16 }, complete: true, now: 1, maxAttempts: 16 }).action, 'exhausted');
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
