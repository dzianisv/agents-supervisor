#!/usr/bin/env node
/**
 * e2e-cc.mjs — end-to-end test of the Claude Code Stop hook (bin/supervisor-on-stop.mjs).
 *
 * Exercises the REAL hook entry point exactly as Claude Code invokes it: a Stop
 * payload on stdin, a real transcript jsonl on disk, and the hook's stdout
 * decision contract. Deterministic by default via SUPERVISOR_FAKE_JUDGE; set
 * SUPERVISOR_CC_LIVE=1 to classify with the real judge LLM (needs Claude Code
 * OAuth or ANTHROPIC_API_KEY).
 *
 * Run: node test/e2e-cc.mjs   (also `npm run test:cc`)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verdictsPath } from '../core/session-store.mjs';
import { goalStore, readGoalAchievedLog } from '../core/goal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');
const LIVE = process.env.SUPERVISOR_CC_LIVE === '1';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✖ ${name}\n  ${e.message}`);
    fail++;
  }
}

function mkSession(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-e2e-'));
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, turns.map((t) => JSON.stringify(t)).join('\n'));
  return { dir, tp };
}

/** Invoke the hook as CC does: payload on stdin → returns {code, stdout, verdict}. */
function runHook(payload, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let verdict = null;
  try {
    const vf = verdictsPath(payload.cwd, payload.session_id);
    if (fs.existsSync(vf)) verdict = JSON.parse(fs.readFileSync(vf, 'utf8'));
  } catch { /* none */ }
  return { code: r.status, stdout: (r.stdout || '').trim(), verdict };
}

const driftTurns = [
  { type: 'user', message: { role: 'user', content: 'add a /health endpoint and verify it' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: {} },
    { type: 'text', text: 'I added the route to server.js. Next step: run the tests to verify it.' },
  ] } },
];

const completeTurns = [
  { type: 'user', message: { role: 'user', content: 'what is 2+2?' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '4.' }] } },
];

const fakeEnv = (cat) => (LIVE ? {} : { SUPERVISOR_FAKE_JUDGE: `${cat}:0.95` });

check('summary_drift_stop → injects {decision:block} + writes verdict', () => {
  const { dir, tp } = mkSession(driftTurns);
  const payload = { session_id: 'e2e-drift', cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  const { code, stdout, verdict } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /run the full test suite|run required verification|next concrete tool action/i);
  assert.ok(verdict && verdict.injected === true, 'verdict.injected should be true');
});

check('complete → no inject, clean exit, no stdout', () => {
  const { dir, tp } = mkSession(completeTurns);
  const payload = { session_id: 'e2e-done', cwd: dir, transcript_path: tp,
    last_assistant_message: '4.' };
  const { code, stdout, verdict } = runHook(payload, fakeEnv('complete'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.ok(!verdict || verdict.injected === false);
});

check('stop_hook_active alone no longer suppresses supervision (per-turn counter is the gate)', () => {
  const { dir, tp } = mkSession(driftTurns);
  const payload = { session_id: 'e2e-loop', cwd: dir, transcript_path: tp,
    stop_hook_active: true, last_assistant_message: driftTurns[1].message.content[1].text };
  const { code, stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block', 'the second Stop of a blocked chain must still be supervised');
});

check('per-turn injection cap: attempts at cap for the same turn → no inject', () => {
  const { dir, tp } = mkSession(driftTurns);
  const stateDir = path.join(dir, '.supervisor');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'e2e-cap_attempts.json'),
    JSON.stringify({ count: 7, last_iso: new Date().toISOString(), turn_key: driftTurns[0].message.content }));
  const payload = { session_id: 'e2e-cap', cwd: dir, transcript_path: tp,
    stop_hook_active: true, last_assistant_message: driftTurns[1].message.content[1].text };
  const { code, stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  assert.equal(stdout, '', 'at the per-turn cap the hook must stand down');
});

check('new user turn resets the budget: stale turn_key at cap → still injects', () => {
  const { dir, tp } = mkSession(driftTurns);
  const stateDir = path.join(dir, '.supervisor');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'e2e-reset_attempts.json'),
    JSON.stringify({ count: 7, last_iso: new Date().toISOString(), turn_key: 'a previous, different user turn' }));
  const payload = { session_id: 'e2e-reset', cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  const { code, stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block', 'a new real user message must reset the per-turn budget');
});

check('parse failure (fail-open) → no inject, no verdict written', () => {
  const { dir, tp } = mkSession(driftTurns);
  const payload = { session_id: 'e2e-parse-fail', cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  const { code, stdout, verdict } = runHook(payload, LIVE ? {} : { SUPERVISOR_FAKE_JUDGE: 'PARSE_ERROR' });
  assert.equal(code, 0);
  assert.equal(stdout, '', 'a garbled judge response must never inject');
  assert.equal(verdict, null, 'fail-open exits before any verdict is written');
});

check('trailing question in final message → waiting_for_user guard, no inject, judge never invoked', () => {
  const questionTurns = [
    { type: 'user', message: { role: 'user', content: 'add a /health endpoint' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'text', text: 'I added the route. Want me to also wire up monitoring for it?' },
    ] } },
  ];
  const { dir, tp } = mkSession(questionTurns);
  const payload = { session_id: 'e2e-trailing-q', cwd: dir, transcript_path: tp,
    last_assistant_message: questionTurns[1].message.content[1].text };
  // Fake-judge env is set but must never be consulted — the guard exits first.
  const { code, stdout, verdict } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  assert.equal(stdout, '', 'a trailing question must never be pushed past');
  assert.equal(verdict, null, 'guard exits before the assessment pipeline runs');
});

// Vary the assistant's final text per iteration. A real budget exercise looks
// like this: the agent IS pushed and DOES say something new each time, it just
// never finishes. Replaying one byte-identical reply would instead exercise the
// no-progress gate (see below), which is a different mechanism and would cap
// this at NO_PROGRESS_REPEAT_THRESHOLD injections regardless of the budget.
function driftTurnsWithText(text) {
  return [
    driftTurns[0],
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'text', text },
    ] } },
  ];
}

// The counter is now a RUNAWAY CIRCUIT BREAKER (core/goal.mjs RUNAWAY_CEILING
// = 50), not the intended stop — the agent ends the loop with the loop-exit
// sentinel (covered below). So this case pins the breaker with an EXPLICIT
// budget instead of relying on the old default of 3.
check('attempt cap → stops injecting after max attempts', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-cap';
  goalStore.setRetry(dir, sid, 3);
  let blocks = 0;
  for (let i = 0; i < 5; i++) {
    const text = `I added the route to server.js (pass ${i}). Next step: run the tests to verify it.`;
    fs.writeFileSync(tp, driftTurnsWithText(text).map((t) => JSON.stringify(t)).join('\n'));
    const payload = { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text };
    const { stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
    if (stdout && JSON.parse(stdout).decision === 'block') blocks++;
  }
  assert.equal(blocks, 3, `expected 3 injects (max), got ${blocks}`);
});

check('no-progress gate → 8 identical replies stand down on the 3rd', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-no-progress';
  // Big budget so the ONLY thing that can stop this loop is the gate.
  goalStore.setRetry(dir, sid, 16);
  const text = 'Same. Standing by.';
  fs.writeFileSync(tp, driftTurnsWithText(text).map((t) => JSON.stringify(t)).join('\n'));
  const payload = { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text };
  const decisions = [];
  for (let i = 0; i < 8; i++) {
    const { stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
    decisions.push(!!(stdout && JSON.parse(stdout).decision === 'block'));
  }
  // reply 1: no prior hash → inject. reply 2: repeat 1 (< threshold) → inject.
  // reply 3 onward: repeat >= 2 → stand down, forever.
  assert.deepEqual(decisions.slice(0, 2), [true, true], 'first repeat must still be pushed');
  assert.deepEqual(decisions.slice(2), [false, false, false, false, false, false],
    'from the 3rd identical reply on, the gate must stand down every time');
});

// ── Goal loop (Claude Code side) ──────────────────────────────────────────

check('goal active + judge complete → goal achieved, no inject', () => {
  const { dir, tp } = mkSession(completeTurns);
  const sid = 'e2e-goal-done';
  goalStore.setGoal(dir, sid, 'the answer is given');
  const payload = { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: '4.' };
  const { code, stdout, verdict } = runHook(payload, fakeEnv('complete'));
  assert.equal(code, 0);
  assert.equal(stdout, '', 'no inject when goal achieved');
  assert.equal(verdict?.goal, 'achieved');
  // An achieved goal must DIE, not linger as status:'achieved'. Leaving it in
  // the session store kept mode/goal bookkeeping alive for a condition that
  // was already satisfied, and the project file resurrected it in the next
  // session. The session goal is therefore cleared outright.
  assert.equal(goalStore.load(dir, sid).goal, undefined, 'session goal must be cleared, not left as achieved');
  // Clearing it must never be silent: the achievement is recorded durably in
  // .supervisor/goal-achieved.log BEFORE anything is removed.
  const log = readGoalAchievedLog(dir);
  assert.ok(
    log.some((r) => r.condition === 'the answer is given'),
    `achievement must be recorded durably. goal-achieved.log was:\n${JSON.stringify(log)}`
  );
});

check('goal active + premature stop → goal-continue inject (mentions goal)', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-goal-cont';
  goalStore.setGoal(dir, sid, 'all tests pass');
  const payload = { session_id: sid, cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  const { stdout, verdict } = runHook(payload, fakeEnv('summary_drift_stop'));
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Goal not yet met: "all tests pass"/);
  assert.equal(verdict?.goal, 'continue');
});

check('default runaway limit allows a goal loop to inject well past 3 (a 4th time)', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-goal-budget';
  goalStore.setGoal(dir, sid, 'keep going');
  let blocks = 0;
  for (let i = 0; i < 4; i++) {
    // The agent must MOVE between pushes. One human message → one turn key, so
    // varying only the assistant text keeps this inside a single turn (what the
    // runaway limit is scoped to) while modelling an agent that answers each
    // injection. Replaying one frozen reply is the stuck-agent scenario the
    // no-progress gate exists to stop — covered by its own case above.
    const text = `I added the route to server.js. Next step ${i + 1}: run the tests to verify it.`;
    fs.writeFileSync(tp, [
      driftTurns[0],
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'text', text },
      ] } },
    ].map((t) => JSON.stringify(t)).join('\n'));
    const payload = { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text };
    const { stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
    if (stdout && JSON.parse(stdout).decision === 'block') blocks++;
  }
  // No per-mode default any more: every mode shares RUNAWAY_CEILING (clamped to
  // CC's HARD_CAP=7), so 4 injections are well within it — the old "goal raises
  // the budget to 16" special-case is gone but the loop still runs freely.
  assert.equal(blocks, 4, `default runaway limit should allow >3 injects, got ${blocks}`);
});

// ── Loop exit sentinel (the CC mirror of the supervisor_loop_exit tool) ────

/** driftTurns with a custom assistant text — the sentinel rides in the reply. */
function sentinelSession(text) {
  const { dir, tp } = mkSession(driftTurns);
  fs.writeFileSync(tp, driftTurnsWithText(text).map((t) => JSON.stringify(t)).join('\n'));
  return { dir, tp, text };
}

check('loop-exit sentinel (completed) → stands down, no block, verdict records loop_exit', () => {
  const { dir, tp, text } = sentinelSession('Done.\nSUPERVISOR_LOOP_EXIT: completed');
  const sid = 'e2e-loopexit-done';
  const { code, stdout, verdict } = runHook(
    { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text },
    fakeEnv('summary_drift_stop'),
  );
  assert.equal(code, 0);
  assert.equal(stdout, '', 'the sentinel must stand the supervisor down, not block');
  assert.equal(verdict?.loop_exit, 'completed');
  assert.equal(fs.existsSync(path.join(dir, '.supervisor', 'loop-exit.log')), false,
    'completed must NOT write the doom-loop log');
});

check('loop-exit sentinel works in plain reflection mode (not just autopilot)', () => {
  const { dir, tp, text } = sentinelSession('All set.\nSUPERVISOR_LOOP_EXIT: completed');
  const { code, stdout } = runHook(
    { session_id: 'e2e-loopexit-reflect', cwd: dir, transcript_path: tp, last_assistant_message: text },
    fakeEnv('summary_drift_stop'),
  );
  assert.equal(code, 0);
  assert.equal(stdout, '', 'reflection mode must honour the sentinel too');
});

check('loop-exit sentinel disarms autopilot', () => {
  const { dir, tp, text } = sentinelSession('Finished.\nSUPERVISOR_LOOP_EXIT: completed');
  const sid = 'e2e-loopexit-autopilot';
  goalStore.setAutopilot(dir, sid, true);
  const { code, stdout, verdict } = runHook(
    { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text },
    fakeEnv('summary_drift_stop'),
  );
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.equal(verdict?.autopilot, 'exited');
  assert.notEqual(goalStore.load(dir, sid).mode, 'autopilot', 'autopilot must be disarmed');
});

check('loop-exit sentinel (stuck) → pauses the goal, KEEPS it, writes .supervisor/loop-exit.log', () => {
  const { dir, tp, text } = sentinelSession('Blocked.\nSUPERVISOR_LOOP_EXIT: stuck — the supervisor keeps demanding a merged PR');
  const sid = 'e2e-loopexit-stuck';
  goalStore.setGoal(dir, sid, 'all tests pass');
  const { code, stdout, verdict } = runHook(
    { session_id: sid, cwd: dir, transcript_path: tp, last_assistant_message: text },
    fakeEnv('summary_drift_stop'),
  );
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.equal(verdict?.loop_exit, 'stuck');
  const goal = goalStore.load(dir, sid).goal;
  assert.ok(goal, 'the goal must NOT be deleted by a loop exit');
  assert.equal(goal.condition, 'all tests pass', 'the condition must be retained');
  assert.equal(goal.status, 'paused');
  const logPath = path.join(dir, '.supervisor', 'loop-exit.log');
  assert.ok(fs.existsSync(logPath), 'stuck must leave forensic evidence');
  const rec = JSON.parse(fs.readFileSync(logPath, 'utf8').trim().split('\n').pop());
  assert.equal(rec.session, sid);
  assert.equal(rec.reason, 'stuck');
  assert.match(rec.detail, /merged PR/);
});

check('loop-exit sentinel mentioned mid-sentence does NOT stand the supervisor down', () => {
  const text = 'I will output SUPERVISOR_LOOP_EXIT: completed once the tests pass. Next step: run them.';
  const { dir, tp } = sentinelSession(text);
  const { stdout } = runHook(
    { session_id: 'e2e-loopexit-inline', cwd: dir, transcript_path: tp, last_assistant_message: text },
    fakeEnv('summary_drift_stop'),
  );
  assert.equal(JSON.parse(stdout).decision, 'block', 'a passing mention must not end the loop');
});

check('CC-rendered feedback names the SENTINEL, never the tool', () => {
  const { dir, tp } = mkSession(driftTurns);
  const { stdout } = runHook(
    { session_id: 'e2e-hint', cwd: dir, transcript_path: tp,
      last_assistant_message: driftTurns[1].message.content[1].text },
    fakeEnv('summary_drift_stop'),
  );
  const reason = JSON.parse(stdout).reason;
  assert.match(reason, /SUPERVISOR_LOOP_EXIT: completed/);
  assert.doesNotMatch(reason, /supervisor_loop_exit tool/,
    'Claude Code has no tool registry — naming the tool is a dead instruction');
});

console.log(`\n${pass} passed, ${fail} failed${LIVE ? ' (LIVE judge)' : ' (fake judge)'}`);
process.exit(fail === 0 ? 0 : 1);
