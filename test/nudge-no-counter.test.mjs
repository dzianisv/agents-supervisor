// The agent-facing autopilot nudge must NOT display an attempt counter on
// EITHER runtime. A visible "n/N" denominator tells the agent a fixed budget
// exists and invites pacing / premature "I'd better wrap up" behaviour, and
// treats the number as permission to stop. The only intended stop is the
// agent's own supervisor_loop_exit tool (opencode) / SUPERVISOR_LOOP_EXIT
// sentinel (Claude Code) — the counter is now just an internal runaway safety
// valve (core/goal.mjs RUNAWAY_CEILING) and never leaks into the prompt.
//
// This is a source-level guard so the display cannot creep back: re-adding the
// old `(${autopilotAttempt}/${runawayLimit})` / `(${nextAttempt}/${runawayLimit})`
// to either nudge template fails this test. The counter may still go to the
// debug log, the operator TOAST, and the JUDGE's prompt — only the nudge is
// covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const OC_SRC = fs.readFileSync(new URL('../opencode/supervisor-impl.ts', import.meta.url), 'utf8');
const CC_SRC = fs.readFileSync(new URL('../bin/supervisor-on-stop.mjs', import.meta.url), 'utf8');

// Extract the `const baseNudge = \`...\`` template literal, tolerating escaped
// backticks inside it (the Claude Code nudge quotes `SUPERVISOR_LOOP_EXIT`
// with escaped backticks). Returns the raw template SOURCE (interpolations
// intact) so we can look for a counter interpolation, not just a literal.
function extractBaseNudge(src) {
  const marker = 'const baseNudge = `';
  const at = src.indexOf(marker);
  assert.ok(at >= 0, 'could not find `const baseNudge = \\`` in source');
  let i = at + marker.length;
  let out = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += ch + src[i + 1]; i++; continue; }
    if (ch === '`') break;
    out += ch;
  }
  assert.ok(i < src.length, 'unterminated baseNudge template literal');
  return out;
}

// An interpolated counter like `(${autopilotAttempt}/${runawayLimit})`.
const INTERPOLATED_COUNTER = /\(\s*\$\{[^}]+\}\s*\/\s*\$\{[^}]+\}\s*\)/;
// A literal counter like `(3/50)`.
const LITERAL_COUNTER = /\(\s*\d+\s*\/\s*\d+\s*\)/;

for (const [runtime, src] of [['opencode', OC_SRC], ['claude-code', CC_SRC]]) {
  test(`${runtime}: the autopilot nudge names Autopilot but shows NO n/N counter`, () => {
    const nudge = extractBaseNudge(src);
    assert.match(nudge, /Autopilot/, 'sanity: extracted the autopilot nudge template');
    assert.doesNotMatch(
      nudge, INTERPOLATED_COUNTER,
      `${runtime} autopilot nudge must not interpolate an "n/N" counter into the agent-facing text`,
    );
    assert.doesNotMatch(
      nudge, LITERAL_COUNTER,
      `${runtime} autopilot nudge must not contain a literal "n/N" counter`,
    );
  });

  test(`${runtime}: no source line renders "Autopilot (\${...}" into the nudge`, () => {
    // The exact shape of the pre-refactor counter nudge on both runtimes was
    // `${FEEDBACK_MARKER} Autopilot (${...`. The operator toasts use distinct
    // wording ("Autopilot continuing (", "Autopilot runaway limit reached ("),
    // so this substring uniquely fingerprints the counter nudge.
    assert.ok(
      !src.includes('Autopilot (${'),
      `${runtime} still renders "Autopilot (\${...}" — the budget counter is back in the nudge`,
    );
  });
}
