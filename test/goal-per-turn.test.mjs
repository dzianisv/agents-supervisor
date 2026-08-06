// goal-per-turn.test.mjs — the goal loop's per-turn budget contract.
//
// These behaviors used to live in a separate `solofounder` supervisor mode
// (its own state file, its own deadline, its own continuation template). That
// mode was folded into plain `goal` mode: everything that made it different is
// now goal mode's default, and the CEO playbook lives in the skill prompt
// (skills/solofounder/SKILL.md) instead of the hook. What this file pins:
//
//   1. solofounder is NOT a supervisor mode any more.
//   2. The attempt budget is per HUMAN TURN — goal.attempts resets when the
//      human speaks again, so a goal is never permanently exhausted
//      mid-session by the attempts cap.
//   3. Hitting the per-turn cap stands down for that turn only; status stays
//      'active'.
//   4. The judge actually SEES the goal condition as a mandatory requirement.
//   5. The deadline is a long backstop (30 days), not a 30-minute session cap.
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
  resolveSupervisorMode,
  parseSupervisorCommand,
} from '../core/goal.mjs';
import { FEEDBACK_MARKER } from '../core/evaluation.mjs';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-goal-turn-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ON_STOP = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');

// ── 1. solofounder is gone as a mode, alive only as a command alias ─────────

test('solofounder is no longer a supervisor mode', () => {
  assert.deepEqual([...SUPERVISOR_MODES], ['autopilot', 'goal', 'reflection']);
  assert.equal(resolveSupervisorMode({ mode: 'solofounder' }), DEFAULT_SUPERVISOR_MODE,
    'an unknown/retired mode value must fall back to the default, not resolve');
  assert.throws(() => goalStore.setMode(mkcwd(), 's0', 'solofounder'), /Invalid supervisor mode/);
  assert.equal(typeof goalStore.setSolofounder, 'undefined', 'setSolofounder must be gone');
});

test('the retired `solofounder` command word now just arms a plain goal', () => {
  assert.deepEqual(
    parseSupervisorCommand('solofounder', 'revenue x 12 >= $1,000,000, read via stripe balance'),
    { kind: 'goal-set', condition: 'revenue x 12 >= $1,000,000, read via stripe balance' }
  );
  // …including through the bare `/supervisor <word>` dispatcher.
  assert.deepEqual(
    parseSupervisorCommand('supervisor', 'solofounder drive to $1M ARR'),
    { kind: 'goal-set', condition: 'drive to $1M ARR' }
  );
});

// ── 2. setMode: only goal mode keeps the goal ──────────────────────────────

test('setMode("goal") keeps an existing goal; other modes still drop it', () => {
  const d = mkcwd();
  goalStore.setGoal(d, 's1', 'ship the feature');
  goalStore.setMode(d, 's1', 'goal');
  const state = goalStore.load(d, 's1');
  assert.equal(state.mode, 'goal');
  assert.equal(state.goal.condition, 'ship the feature');

  goalStore.setMode(d, 's1', 'autopilot');
  assert.equal(goalStore.load(d, 's1').goal, undefined);
});

// ── 3. Deadline is a long backstop, not a 30-minute session cap ────────────

test('setGoal deadline is the 30-day backstop, not the old 30-minute cap', () => {
  const d = mkcwd();
  const now = Date.now();
  const state = goalStore.setGoal(d, 's2', 'all tests pass', { now });

  assert.equal(state.mode, 'goal');
  assert.equal(state.goal.status, 'active');
  assert.equal(state.goal.attempts, 0);
  assert.equal(state.goal.lastTurnKey, null, 'seeded so the first stop stamps without resetting');
  assert.equal(state.goal.deadline, now + DEFAULT_MAX_GOAL_DURATION_MS);
  assert.equal(DEFAULT_MAX_GOAL_DURATION_MS, 30 * 24 * 60 * 60 * 1000);
});

// ── 4. Per-turn attempt budget through the real Stop hook ──────────────────

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
  'goal: goal.attempts resets on turnKey change (no permanent exhaustion), respects per-turn HARD_CAP within a turn',
  { timeout: 30_000 },
  () => {
    const d = mkcwd();
    const sid = 'goal-turnkey-test';
    goalStore.setGoal(d, sid, 'all tests in test/auth pass and the PR is open with green CI');

    const turnA = [
      { type: 'user', message: { role: 'user', content: 'turn A: get the auth tests green' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
    ];
    const tpA = mkTranscript(d, turnA, 'turnA');
    const payloadA = { session_id: sid, cwd: d, transcript_path: tpA, last_assistant_message: 'Working on it.' };

    // HARD_CAP is 7 (see bin/supervisor-on-stop.mjs) — drive exactly to it
    // within the SAME human turn.
    for (let i = 0; i < 7; i++) {
      const out = runOnStop(payloadA);
      assert.equal(out.code, 0, `call ${i + 1} should exit 0`);
      const parsed = JSON.parse(out.stdout);
      assert.equal(parsed.decision, 'block', `call ${i + 1} should inject a continuation`);
      // The marker must be present (computeTurnKey skips any user message
      // containing it — an injection without it corrupts the per-turn counter).
      assert.ok(parsed.reason.includes(FEEDBACK_MARKER), `call ${i + 1} reason must carry FEEDBACK_MARKER`);
      assert.match(parsed.reason, /Goal not yet met/, `call ${i + 1} must restate the goal`);
    }
    const afterCap = loadGoalState(d, sid);
    assert.equal(afterCap.goal.attempts, 7, 'goal.attempts should reach exactly the per-turn cap');
    assert.equal(afterCap.goal.status, 'active', 'still active at the cap — not flagged exhausted');

    // One more call in the SAME turn hits the per-turn cap: no injection, but
    // MUST NOT flip status to 'exhausted' (that would kill the goal forever).
    const capped = runOnStop(payloadA);
    assert.equal(capped.code, 0);
    assert.equal(capped.stdout, '', 'no injection once the per-turn cap is hit');
    const stillActive = loadGoalState(d, sid);
    assert.equal(stillActive.goal.status, 'active', 'a goal must never be permanently exhausted by a per-turn cap');
    assert.equal(stillActive.goal.attempts, 7, 'attempts untouched by the capped call');

    // A NEW human turn (different final user message → different turnKey)
    // must resume the loop with a reset budget, not stay capped/exhausted.
    const turnB = [
      ...turnA,
      { type: 'user', message: { role: 'user', content: 'turn B: also cover the refresh-token path' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }] } },
    ];
    const tpB = mkTranscript(d, turnB, 'turnB');
    const payloadB = { session_id: sid, cwd: d, transcript_path: tpB, last_assistant_message: 'Continuing.' };

    const resumed = runOnStop(payloadB);
    assert.equal(resumed.code, 0);
    const parsedB = JSON.parse(resumed.stdout);
    assert.equal(parsedB.decision, 'block', 'a new human turn must resume the loop, not stay silently capped');
    const afterNewTurn = loadGoalState(d, sid);
    assert.equal(
      afterNewTurn.goal.attempts, 1,
      'attempts reset to 0 on the new turnKey then re-incremented to 1 — no cumulative carryover from turn A'
    );
    assert.equal(afterNewTurn.goal.status, 'active');
  }
);

// ── 4b. Issue #57: one counter, one cap, no unreachable exhaust branch ─────
//
// The hook used to keep TWO independent tallies of "how many times have we
// pushed the agent this turn": the turn-scoped file counter (gated against the
// clamped effectiveMax) and goal.attempts (checked by decideGoalTransition).
// The file gate runs first with the SAME cap, so goal.attempts could never
// reach it — decideGoalTransition's reason:'attempts' branch, and the
// `turn_budget_spent` verdict it feeds, were dead code on Claude Code.
//
// Contract now: goal.attempts IS the file counter, and hitting the per-turn
// cap with an active goal emits a real `turn_budget_spent` verdict (rather
// than exiting silently) while leaving the goal active.

function loadVerdict(tmp, sid) {
  const p = path.join(tmp, '.supervisor', `verdict_${sid}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test(
  'goal: hitting the per-turn cap emits a turn_budget_spent verdict (reason:"attempts" is reachable)',
  { timeout: 30_000 },
  () => {
    const d = mkcwd();
    const sid = 'goal-budget-spent-test';
    goalStore.setGoal(d, sid, 'the migration is applied and verified in staging');

    const turns = [
      { type: 'user', message: { role: 'user', content: 'apply the migration' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
    ];
    const tp = mkTranscript(d, turns, 'budget');
    const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'Working on it.' };

    // Burn the whole per-turn budget (HARD_CAP = 7) inside ONE human turn.
    for (let i = 0; i < 7; i++) {
      const out = runOnStop(payload);
      assert.equal(out.code, 0, `call ${i + 1} should exit 0`);
      assert.equal(JSON.parse(out.stdout).decision, 'block', `call ${i + 1} should inject`);
    }

    // The single counter: goal.attempts must equal the file counter exactly.
    const fileAttempts = JSON.parse(
      fs.readFileSync(path.join(d, '.supervisor', `${sid}_attempts.json`), 'utf8')
    ).count;
    assert.equal(fileAttempts, 7, 'file counter should be at the per-turn cap');
    assert.equal(
      loadGoalState(d, sid).goal.attempts, fileAttempts,
      'goal.attempts must BE the per-turn file counter, not a second independent tally'
    );

    // The capped call: no injection, goal stays active, but it must now leave
    // a verdict saying WHY the supervisor went quiet. Pre-fix this exited
    // silently at the cap gate and no such verdict was ever written.
    const capped = runOnStop(payload);
    assert.equal(capped.code, 0);
    assert.equal(capped.stdout, '', 'no injection once the per-turn cap is hit');

    const verdict = loadVerdict(d, sid);
    assert.equal(
      verdict.goal, 'turn_budget_spent',
      'hitting the per-turn cap with an active goal must emit turn_budget_spent — ' +
      'the discriminator is dead code if the cap gate stands down silently'
    );
    assert.equal(verdict.injected, false);
    assert.equal(
      loadGoalState(d, sid).goal.status, 'active',
      'a spent per-turn budget is NOT terminal — the goal must survive to the next human turn'
    );
  }
);

test('goal: judge status "complete" allows the stop (goal achieved, not injected)', { timeout: 15_000 }, () => {
  const d = mkcwd();
  const sid = 'goal-achieved-test';
  goalStore.setGoal(d, sid, 'all tests pass');

  const turns = [
    { type: 'user', message: { role: 'user', content: 'get the tests green' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'npm test: 42 passing, 0 failing.' }] } },
  ];
  const tp = mkTranscript(d, turns, 'achieved');
  const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'npm test: 42 passing, 0 failing.' };

  const out = runOnStop(payload, { SUPERVISOR_FAKE_JUDGE: 'complete' });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '', 'a complete judge verdict must not inject — the stop is allowed');
  // An achieved goal is RETIRED, not left sitting in state: previously the
  // hook persisted status:'achieved' and left the condition (and any project
  // Goal.md) behind, so the next session re-read it and the goal resurrected
  // forever. The achievement is still recoverable from
  // .supervisor/goal-achieved.log.
  const state = loadGoalState(d, sid);
  assert.equal(state.goal, undefined, 'session goal must be cleared once achieved');
  assert.equal(state.mode, 'reflection');
});

// ── 5. The judge prompt must actually carry the session goal condition ─────
//
// Regression: on Claude Code the session goal only reached the continuation
// feedback text, never the judge prompt, so the judge decided "complete"
// against generic workflow gates and the goal loop then trusted that verdict.
// OpenCode always injected it (supervisor-impl.ts's goalSection).

test('goal: the session goal condition reaches the judge prompt as a mandatory requirement', { timeout: 15_000 }, () => {
  const d = mkcwd();
  const sid = 'goal-prompt-test';
  const condition = 'the refresh-token rotation test passes';
  goalStore.setGoal(d, sid, condition);

  const turns = [
    { type: 'user', message: { role: 'user', content: 'fix auth' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Edited the handler.' }] } },
  ];
  const tp = mkTranscript(d, turns, 'prompt');
  const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'Edited the handler.' };

  // SUPERVISOR_DEBUG writes the built prompt into the debug log; assert on the
  // injected continuation plus the persisted verdict instead of the raw call.
  // SUPERVISOR_DUMP_PROMPT is confined to the project's .supervisor/ dir —
  // the dump contains transcript text, so an arbitrary path is not honored.
  const dumpPath = path.join(d, '.supervisor', 'prompt.txt');
  const out = runOnStop(payload, { SUPERVISOR_DUMP_PROMPT: dumpPath });
  assert.equal(out.code, 0);

  const dumped = fs.readFileSync(dumpPath, 'utf8');
  assert.match(dumped, /GOAL \(mandatory completion requirement\)/);
  assert.match(dumped, new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ── 6. SUPERVISOR_DUMP_PROMPT is confined to the project's .supervisor/ dir ─
//
// The dumped judge prompt embeds transcript text. This escape hatch ships in
// production code, so an env var alone must not be able to redirect that
// content to an arbitrary path on disk.

test('goal: SUPERVISOR_DUMP_PROMPT refuses a destination outside .supervisor/', { timeout: 15_000 }, () => {
  const d = mkcwd();
  const sid = 'goal-dump-escape-test';
  goalStore.setGoal(d, sid, 'the refresh-token rotation test passes');

  const turns = [
    { type: 'user', message: { role: 'user', content: 'fix auth' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Edited the handler.' }] } },
  ];
  const tp = mkTranscript(d, turns, 'escape');
  const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'Edited the handler.' };

  const outside = path.join(d, 'leaked-prompt.txt');
  const out = runOnStop(payload, { SUPERVISOR_DUMP_PROMPT: outside });
  assert.equal(out.code, 0, 'a rejected dump path must never break the hook');
  assert.equal(fs.existsSync(outside), false, 'prompt must not be written outside .supervisor/');

  const traversal = path.join(d, '.supervisor', '..', 'traversed.txt');
  runOnStop(payload, { SUPERVISOR_DUMP_PROMPT: traversal });
  assert.equal(fs.existsSync(path.join(d, 'traversed.txt')), false, '.. traversal out of .supervisor/ must be rejected');
});
