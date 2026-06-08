import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  goalStore, resolveMaxAttempts, decideGoalTransition,
  parseSupervisorCommand, buildGoalRequirementSection, DEFAULT_MAX_ATTEMPTS,
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
