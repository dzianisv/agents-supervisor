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

check('attempt cap → stops injecting after max attempts', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-cap';
  const payload = { session_id: sid, cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  let blocks = 0;
  for (let i = 0; i < 5; i++) {
    const { stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
    if (stdout && JSON.parse(stdout).decision === 'block') blocks++;
  }
  assert.equal(blocks, 3, `expected 3 injects (max), got ${blocks}`);
});

// ── Goal loop (Claude Code side) ──────────────────────────────────────────
import { goalStore, readGoalAchievedLog } from '../core/goal.mjs';

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

check('goal raises retry budget past the default 3 (injects a 4th time)', () => {
  const { dir, tp } = mkSession(driftTurns);
  const sid = 'e2e-goal-budget';
  goalStore.setGoal(dir, sid, 'keep going');
  const payload = { session_id: sid, cwd: dir, transcript_path: tp,
    last_assistant_message: driftTurns[1].message.content[1].text };
  let blocks = 0;
  for (let i = 0; i < 4; i++) {
    const { stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
    if (stdout && JSON.parse(stdout).decision === 'block') blocks++;
  }
  assert.equal(blocks, 4, `goal budget should allow >3 injects, got ${blocks}`);
});

console.log(`\n${pass} passed, ${fail} failed${LIVE ? ' (LIVE judge)' : ' (fake judge)'}`);
process.exit(fail === 0 ? 0 : 1);
