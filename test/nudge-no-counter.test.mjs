// Agent continuation feedback must not advertise the internal runaway budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildEscalatingFeedback } from '../core/feedback.mjs';

for (const severity of ['LOW', 'MEDIUM', 'HIGH']) {
  test(`${severity}: goal feedback does not expose a work budget`, () => {
    const feedback = buildEscalatingFeedback(severity, {
      feedback: 'The requested tests have not passed',
      missing: ['Passing test evidence'], next_actions: ['Run the requested tests'],
      goal_condition: 'The requested change is verified',
    }, { statusDirective: false });
    assert.match(feedback, /Run the requested tests/);
    assert.doesNotMatch(feedback, /\(\s*\d+\s*\/\s*\d+\s*\)/);
    assert.doesNotMatch(feedback, /Autopilot|attempts? remaining/i);
  });
}

for (const [runtime, path] of [
  ['opencode', '../opencode/supervisor-impl.ts'],
  ['claude-code', '../bin/supervisor-on-stop.mjs'],
]) {
  test(`${runtime}: no judge-less continuation template survives`, () => {
    const src = fs.readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(src, /You are in autopilot mode|const baseNudge\s*=/);
  });
}
