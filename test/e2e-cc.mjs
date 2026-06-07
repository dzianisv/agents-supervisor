#!/usr/bin/env node
/**
 * e2e-cc.mjs — end-to-end test of the Claude Code Stop hook (bin/on-stop.mjs).
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'bin', 'on-stop.mjs');
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
    const vf = path.join(payload.cwd, '.supervisor', `verdict_${payload.session_id}.json`);
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
  assert.match(out.reason, /Execute it now|run the tests|tool call/i);
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

check('loop guard (stop_hook_active) → no-op, no stdout', () => {
  const { dir, tp } = mkSession(driftTurns);
  const payload = { session_id: 'e2e-loop', cwd: dir, transcript_path: tp,
    stop_hook_active: true, last_assistant_message: 'x' };
  const { code, stdout } = runHook(payload, fakeEnv('summary_drift_stop'));
  assert.equal(code, 0);
  assert.equal(stdout, '');
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

console.log(`\n${pass} passed, ${fail} failed${LIVE ? ' (LIVE judge)' : ' (fake judge)'}`);
process.exit(fail === 0 ? 0 : 1);
