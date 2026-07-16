// solofounder.test.mjs — coverage for the 'solofounder' supervisor mode:
// same judge-every-stop architecture as reflection/goal, but its goal
// condition lives in .agents/supervisor/solofounder.md, drives toward a $1M
// ARR bar, has an effectively unbounded duration, and its per-turn attempt
// budget resets every human turn instead of exhausting permanently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  goalStore,
  SUPERVISOR_MODES,
  DEFAULT_SUPERVISOR_MODE,
  DEFAULT_MAX_GOAL_DURATION_MS,
  DEFAULT_SOLOFOUNDER_DURATION_MS,
  resolveSupervisorMode,
  writeSolofounderGoal,
  readSolofounderGoal,
} from '../core/goal.mjs';
import { buildCeoDirective } from '../core/feedback.mjs';
import { FEEDBACK_MARKER } from '../core/evaluation.mjs';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-solofounder-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ON_STOP = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');

// ── 1. Mode registration + resolution ───────────────────────────────────────

test('solofounder is a registered SUPERVISOR_MODE and resolveSupervisorMode resolves it', () => {
  assert.ok(SUPERVISOR_MODES.includes('solofounder'));
  assert.equal(resolveSupervisorMode({ mode: 'solofounder' }), 'solofounder');
  assert.notEqual(DEFAULT_SUPERVISOR_MODE, 'solofounder', 'reflection stays the default mode');
});

// ── 2. setMode('solofounder') must not delete an existing goal ─────────────

test('setMode("solofounder") does NOT delete an existing goal (unlike switching to autopilot/reflection)', () => {
  const d = mkcwd();
  goalStore.setGoal(d, 's1', 'ship the feature');
  assert.ok(goalStore.load(d, 's1').goal, 'precondition: goal exists');

  goalStore.setMode(d, 's1', 'solofounder');
  const state = goalStore.load(d, 's1');
  assert.equal(state.mode, 'solofounder');
  assert.ok(state.goal, 'goal must survive the switch to solofounder mode');
  assert.equal(state.goal.condition, 'ship the feature');

  // Sanity: switching to a mode that genuinely doesn't use goal state still
  // deletes it — proves the fix is scoped, not a blanket "never delete".
  goalStore.setMode(d, 's1', 'autopilot');
  assert.equal(goalStore.load(d, 's1').goal, undefined);
});

// ── 3. Unbounded duration — the 30-minute default must NOT apply ───────────

test('setSolofounder uses an effectively unbounded (30-day) deadline, not the 30-minute goal default', () => {
  const d = mkcwd();
  const now = Date.now();
  const state = goalStore.setSolofounder(d, 's2', 'reach $1M ARR', { now });

  assert.equal(state.mode, 'solofounder');
  assert.equal(state.goal.status, 'active');
  assert.equal(state.goal.attempts, 0);
  assert.equal(state.goal.deadline, now + DEFAULT_SOLOFOUNDER_DURATION_MS);
  assert.ok(
    state.goal.deadline > now + DEFAULT_MAX_GOAL_DURATION_MS,
    'solofounder deadline must be far beyond the 30-minute plain-goal default'
  );
  // 30 days, not 30 minutes.
  assert.equal(DEFAULT_SOLOFOUNDER_DURATION_MS, 30 * 24 * 60 * 60 * 1000);
});

// ── 4. .agents/supervisor/solofounder.md write→read round-trip ─────────────

test('writeSolofounderGoal/readSolofounderGoal: round-trip via ## Goal Condition section', () => {
  const d = mkcwd();
  const condition = 'Stripe MRR x 12 >= $1,000,000, read via: stripe balance summary --live. DONE only if quoted.';
  writeSolofounderGoal(d, condition);

  const filePath = path.join(d, '.agents', 'supervisor', 'solofounder.md');
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.match(raw, /## Goal Condition/);
  assert.match(raw, /## Workstream State/);
  assert.match(raw, new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.equal(readSolofounderGoal(d), condition);
});

test('readSolofounderGoal: missing file returns "" (best effort, never throws)', () => {
  const d = mkcwd();
  assert.equal(readSolofounderGoal(d), '');
});

// ── 5. buildCeoDirective starts with the FEEDBACK_MARKER ────────────────────

test('buildCeoDirective output starts with FEEDBACK_MARKER and restates the ARR bar', () => {
  const msg = buildCeoDirective({
    goalCondition: 'reach $1,000,000 ARR',
    analysis: { missing: ['ship pricing page'], nextActions: ['spawn a doer for pricing'], reason: 'no pricing page yet' },
    attempt: 2,
    effectiveMax: 7,
  });
  assert.ok(msg.startsWith(FEEDBACK_MARKER), `must start with FEEDBACK_MARKER, got: ${msg.slice(0, 60)}`);
  assert.match(msg, /\$1,000,000 ARR/);
  assert.match(msg, /CEO/i);
  assert.match(msg, /doer/i);
  assert.match(msg, /never nudge/i, 'must explicitly refuse destructive/wasteful nudges');
});

test('buildCeoDirective: destructive missing/next-action items are rewritten to a flag-for-approval note', () => {
  const msg = buildCeoDirective({
    goalCondition: 'reach $1,000,000 ARR',
    analysis: { missing: ['force-push the release branch'], nextActions: [], reason: '' },
    attempt: 1,
    effectiveMax: 7,
  });
  assert.doesNotMatch(msg, /- force-push the release branch\b/);
  assert.match(msg, /Flag to the user for approval: force-push the release branch/);
});

// ── 6. Per-turn attempt budget: resets on turnKey change, capped within a turn ──

function runOnStop(payload, env = {}) {
  const r = spawnSync('node', [ON_STOP], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env, SUPERVISOR_FAKE_JUDGE: env.SUPERVISOR_FAKE_JUDGE ?? 'incomplete' },
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function mkTranscript(tmp, turns, name) {
  const tp = path.join(tmp, `${name}.jsonl`);
  fs.writeFileSync(tp, turns.map((t) => JSON.stringify(t)).join('\n'), 'utf8');
  return tp;
}

function loadGoalState(tmp, sid) {
  const p = path.join(tmp, '.supervisor', 'goals', `${sid}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test(
  'solofounder: goal.attempts resets on turnKey change (no permanent exhaustion), respects per-turn HARD_CAP within a turn',
  { timeout: 30_000 },
  () => {
    const d = mkcwd();
    const sid = 'sf-turnkey-test';
    goalStore.setSolofounder(d, sid, 'reach $1,000,000 ARR');

    const turnA = [
      { type: 'user', message: { role: 'user', content: 'turn A: push the product forward' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working workstream A.' }] } },
    ];
    const tpA = mkTranscript(d, turnA, 'turnA');
    const payloadA = { session_id: sid, cwd: d, transcript_path: tpA, last_assistant_message: 'Working workstream A.' };

    // HARD_CAP is 7 (see bin/supervisor-on-stop.mjs) — drive exactly to it
    // within the SAME human turn.
    for (let i = 0; i < 7; i++) {
      const out = runOnStop(payloadA);
      assert.equal(out.code, 0, `call ${i + 1} should exit 0`);
      const parsed = JSON.parse(out.stdout);
      assert.equal(parsed.decision, 'block', `call ${i + 1} should inject a CEO directive`);
      assert.ok(parsed.reason.startsWith(FEEDBACK_MARKER), `call ${i + 1} reason must start with FEEDBACK_MARKER`);
    }
    const afterCap = loadGoalState(d, sid);
    assert.equal(afterCap.goal.attempts, 7, 'goal.attempts should reach exactly the per-turn cap');
    assert.equal(afterCap.goal.status, 'active', 'still active at the cap — not flagged exhausted');

    // One more call in the SAME turn hits the per-turn cap: no injection, but
    // MUST NOT flip status to 'exhausted' (that would kill the drive forever).
    const capped = runOnStop(payloadA);
    assert.equal(capped.code, 0);
    assert.equal(capped.stdout, '', 'no injection once the per-turn cap is hit');
    const stillActive = loadGoalState(d, sid);
    assert.equal(stillActive.goal.status, 'active', 'solofounder must never be permanently exhausted by a per-turn cap');
    assert.equal(stillActive.goal.attempts, 7, 'attempts untouched by the capped call');

    // A NEW human turn (different final user message → different turnKey)
    // must resume the drive with a reset budget, not stay capped/exhausted.
    const turnB = [
      ...turnA,
      { type: 'user', message: { role: 'user', content: 'turn B: new direction, keep driving toward ARR' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working workstream B.' }] } },
    ];
    const tpB = mkTranscript(d, turnB, 'turnB');
    const payloadB = { session_id: sid, cwd: d, transcript_path: tpB, last_assistant_message: 'Working workstream B.' };

    const resumed = runOnStop(payloadB);
    assert.equal(resumed.code, 0);
    const parsedB = JSON.parse(resumed.stdout);
    assert.equal(parsedB.decision, 'block', 'a new human turn must resume the drive, not stay silently capped');
    const afterNewTurn = loadGoalState(d, sid);
    assert.equal(
      afterNewTurn.goal.attempts, 1,
      'attempts reset to 0 on the new turnKey then re-incremented to 1 — no cumulative carryover from turn A'
    );
    assert.equal(afterNewTurn.goal.status, 'active');
  }
);

test('solofounder: judge status "complete" allows the stop (goal achieved, not injected)', { timeout: 15_000 }, () => {
  const d = mkcwd();
  const sid = 'sf-achieved-test';
  goalStore.setSolofounder(d, sid, 'reach $1,000,000 ARR');

  const turns = [
    { type: 'user', message: { role: 'user', content: 'drive to $1M ARR' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Stripe MRR x12 clears $1,000,000. Done.' }] } },
  ];
  const tp = mkTranscript(d, turns, 'achieved');
  const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'Stripe MRR x12 clears $1,000,000. Done.' };

  const out = runOnStop(payload, { SUPERVISOR_FAKE_JUDGE: 'complete' });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '', 'a complete judge verdict must not inject — the stop is allowed');
  const state = loadGoalState(d, sid);
  assert.equal(state.goal.status, 'achieved');
});
