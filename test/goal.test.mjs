// Goal-loop (supervisor-mode) coverage. Requires --experimental-strip-types to import the .ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSupervisorCommand, resolveMaxAttempts, decideGoalTransition,
  parseRubric, buildGoalRequirementSection, DEFAULT_SUPERVISOR_MODE,
  resolveSupervisorMode, supervisorStore, SupervisorPlugin,
  trackSessionScopedToolSession,
} from '../opencode/supervisor-impl.ts';
import * as runtimeSupervisor from '../opencode/supervisor.ts';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-opencode-goal-'));

test('runtime supervisor entrypoint exports only plugin functions', () => {
  assert.equal(typeof runtimeSupervisor.default, 'function');
  assert.deepEqual(
    Object.entries(runtimeSupervisor).filter(([, value]) => typeof value !== 'function'),
    []
  );
});

test('supervisor command tool tracks session from tool execute hook', async () => {
  const hooks = await SupervisorPlugin({
    client: {},
    directory: mkcwd(),
  });

  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.equal(
    trackSessionScopedToolSession(null, { tool: 'supervisor', sessionID: 'ses_command_hook_test' }),
    'ses_command_hook_test'
  );
  assert.equal(
    trackSessionScopedToolSession('ses_command_hook_test', { tool: 'bash', sessionID: 'ses_other' }),
    'ses_command_hook_test'
  );

  await hooks['tool.execute.before'](
    { tool: 'supervisor', sessionID: 'ses_command_hook_test', callID: 'call_1' },
    { args: {} }
  );
});

test('parseSupervisorCommand: goal set/status/clear (+aliases) and retry', () => {
  assert.deepEqual(parseSupervisorCommand('goal', 'all tests pass'), { kind: 'goal-set', condition: 'all tests pass' });
  assert.deepEqual(parseSupervisorCommand('goal', ''), { kind: 'goal-status' });
  for (const a of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
    assert.equal(parseSupervisorCommand('goal', a).kind, 'goal-clear', a);
  }
  assert.deepEqual(parseSupervisorCommand('retry', '24'), { kind: 'retry-set', n: 24 });
  assert.deepEqual(parseSupervisorCommand('retry', ''), { kind: 'retry-status' });
});

test('parseSupervisorCommand: root supervisor supports mode UX', () => {
  assert.deepEqual(parseSupervisorCommand('supervisor', ''), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'status'), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'off'), { kind: 'supervisor-off' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'on'), { kind: 'supervisor-on' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'autopilot'), { kind: 'mode-set', mode: 'autopilot' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'reminder'), { kind: 'mode-set', mode: 'autopilot' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'reflection'), { kind: 'mode-set', mode: 'reflection' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal all tests pass'), { kind: 'goal-set', condition: 'all tests pass' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal clear'), { kind: 'goal-clear' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'retry 24'), { kind: 'retry-set', n: 24 });
});

test('supervisorStore persists mode and resolves legacy autopilot state', async () => {
  const d = mkcwd();
  assert.equal(DEFAULT_SUPERVISOR_MODE, 'reflection');
  assert.equal(resolveSupervisorMode({}), 'reflection');
  assert.equal(resolveSupervisorMode({ autopilot: true }), 'autopilot');

  await supervisorStore.setMode(d, 's1', 'autopilot');
  assert.equal(resolveSupervisorMode(await supervisorStore.load(d, 's1')), 'autopilot');

  await supervisorStore.setAutopilot(d, 's1', false);
  const reflected = await supervisorStore.load(d, 's1');
  assert.equal(reflected.mode, 'reflection');
  assert.equal(reflected.autopilot, false);

  await supervisorStore.setGoal(d, 's1', 'ship it');
  const goalState = await supervisorStore.load(d, 's1');
  assert.equal(goalState.mode, 'goal');
  assert.equal(goalState.autopilot, false);

  await supervisorStore.clearGoal(d, 's1');
  assert.equal((await supervisorStore.load(d, 's1')).mode, 'reflection');
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
