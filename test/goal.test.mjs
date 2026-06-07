// Goal-loop (supervisor-mode) coverage. Requires --experimental-strip-types to import the .ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSupervisorCommand, resolveMaxAttempts, decideGoalTransition,
  parseRubric, buildGoalRequirementSection,
} from '../opencode/supervisor.ts';

test('parseSupervisorCommand: goal set/status/clear (+aliases) and retry', () => {
  assert.deepEqual(parseSupervisorCommand('goal', 'all tests pass'), { kind: 'goal-set', condition: 'all tests pass' });
  assert.deepEqual(parseSupervisorCommand('goal', ''), { kind: 'goal-status' });
  for (const a of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
    assert.equal(parseSupervisorCommand('goal', a).kind, 'goal-clear', a);
  }
  assert.deepEqual(parseSupervisorCommand('retry', '24'), { kind: 'retry-set', n: 24 });
  assert.deepEqual(parseSupervisorCommand('retry', ''), { kind: 'retry-status' });
});

test('resolveMaxAttempts: sessionOverride > config > default 16, clamped [1,100]', () => {
  assert.equal(resolveMaxAttempts({}), 16);
  assert.equal(resolveMaxAttempts({ config: 8 }), 8);
  assert.equal(resolveMaxAttempts({ sessionOverride: 5, config: 8 }), 5);
  assert.equal(resolveMaxAttempts({ sessionOverride: 999 }), 100); // clamp high
  assert.equal(resolveMaxAttempts({ sessionOverride: 0 }), 1);     // clamp low
  assert.equal(resolveMaxAttempts({ sessionOverride: NaN }), 16);  // non-finite → default
});

test('decideGoalTransition: exhausted > achieved > continue', () => {
  const base = { condition: 'x', status: 'active', attempts: 0, tokenBaseline: 0, startedAt: 0, deadline: 10_000, lastReason: '' };
  // exhausted by attempts
  assert.equal(decideGoalTransition({ goal: { ...base, attempts: 16 }, complete: true, now: 1, maxAttempts: 16 }).action, 'exhausted');
  // exhausted by deadline
  assert.equal(decideGoalTransition({ goal: base, complete: true, now: 20_000, maxAttempts: 16 }).action, 'exhausted');
  // achieved
  assert.equal(decideGoalTransition({ goal: base, complete: true, now: 1, maxAttempts: 16 }).action, 'achieved');
  // continue increments attempts, doesn't mutate input
  const t = decideGoalTransition({ goal: base, complete: false, now: 1, maxAttempts: 16 });
  assert.equal(t.action, 'continue');
  assert.equal(t.goal.attempts, 1);
  assert.equal(base.attempts, 0);
});

test('parseRubric: splits Patterns / Antipatterns sections', () => {
  const r = parseRubric('## Patterns\nP1\nP2\n## Antipatterns\nA1\nA2');
  assert.match(r.patterns, /P1/);
  assert.match(r.antipatterns, /A1/);
});

test('buildGoalRequirementSection: emits mandatory block, empty on blank', () => {
  assert.equal(buildGoalRequirementSection(''), '');
  assert.match(buildGoalRequirementSection('all tests pass'), /GOAL|MANDATORY/i);
  assert.match(buildGoalRequirementSection('all tests pass'), /all tests pass/);
});
