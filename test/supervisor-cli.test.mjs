/**
 * supervisor-cli.test.mjs — integration tests for bin/supervisor.mjs dispatcher
 * and the autopilot fast-path in bin/on-stop.mjs.
 *
 * Tests run the real scripts via execFileSync with temp dirs so they exercise
 * the full file-system state contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(HERE, '..', 'bin', 'supervisor.mjs');
const SUPERVISOR_GOAL = path.join(HERE, '..', 'bin', 'supervisor-goal.mjs');
const ON_STOP = path.join(HERE, '..', 'bin', 'on-stop.mjs');

/** Create an isolated temp dir for one test. */
function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'));
}

/** Write a session id so supervisor.mjs can read it. */
function writeSession(tmp, sid) {
  const dir = path.join(tmp, '.supervisor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'current_session'), sid, 'utf8');
}

/** Run supervisor.mjs with args in cwd=tmp; returns stdout string. */
function runSupervisor(tmp, args, opts = {}) {
  const result = spawnSync('node', [SUPERVISOR, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  return { stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), status: result.status };
}

/** Run the on-stop hook with a CC Stop payload on stdin. */
function runOnStop(payload, env = {}) {
  const r = spawnSync('node', [ON_STOP], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/** Build a minimal transcript jsonl file and return its path. */
function mkTranscript(tmp, turns) {
  const tp = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(tp, turns.map((t) => JSON.stringify(t)).join('\n'), 'utf8');
  return tp;
}

/** Read the goals/<sid>.json state file. */
function loadGoalState(tmp, sid) {
  const p = path.join(tmp, '.supervisor', 'goals', `${sid}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ── Shared transcript fixtures ────────────────────────────────────────────────

const driftTurns = [
  { type: 'user', message: { role: 'user', content: 'add a /health endpoint and verify it' } },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'text', text: 'I added the route to server.js. Next step: run the tests to verify it.' },
      ],
    },
  },
];

// ── 1. mode reflection ────────────────────────────────────────────────────────

test('reflection shorthand → stdout contains "mode: reflection"', () => {
  const tmp = mktmp();
  const sid = 'cli-test-reflect-1';
  writeSession(tmp, sid);
  const { stdout } = runSupervisor(tmp, ['reflection']);
  assert.match(stdout, /mode:\s*reflection/);
});

// ── 2. autopilot on ───────────────────────────────────────────────────────────

test('autopilot on → stdout contains "mode: autopilot"; state file records autopilot', () => {
  const tmp = mktmp();
  const sid = 'cli-test-auto-on';
  writeSession(tmp, sid);
  const { stdout } = runSupervisor(tmp, ['autopilot', 'on']);
  assert.match(stdout, /mode:\s*autopilot/i);
  const state = loadGoalState(tmp, sid);
  assert.ok(state, 'state file should exist');
  assert.equal(state.autopilot, true);
  assert.equal(state.mode, 'autopilot');
});

// ── 3. autopilot off → back to reflection ─────────────────────────────────────

test('autopilot off → stdout contains reflection; state reflects change', () => {
  const tmp = mktmp();
  const sid = 'cli-test-auto-off';
  writeSession(tmp, sid);
  // First enable autopilot
  runSupervisor(tmp, ['autopilot', 'on']);
  // Then disable
  const { stdout } = runSupervisor(tmp, ['autopilot', 'off']);
  assert.match(stdout, /mode:\s*reflection/i);
  const state = loadGoalState(tmp, sid);
  assert.equal(state?.mode, 'reflection');
  assert.equal(state?.autopilot, false);
});

// ── 4. autopilot status ───────────────────────────────────────────────────────

test('autopilot status → reports current mode', () => {
  const tmp = mktmp();
  const sid = 'cli-test-auto-status';
  writeSession(tmp, sid);
  runSupervisor(tmp, ['autopilot', 'on']);
  const { stdout } = runSupervisor(tmp, ['autopilot', 'status']);
  assert.match(stdout, /mode:\s*autopilot/i);
  assert.match(stdout, /autopilot active:\s*yes/i);
});

// ── 5. goal set / status / clear ─────────────────────────────────────────────

test('goal "all tests pass" → status shows goal; goal clear removes it', () => {
  const tmp = mktmp();
  const sid = 'cli-test-goal-lifecycle';
  writeSession(tmp, sid);

  // Set the goal
  const setOut = runSupervisor(tmp, ['goal', 'all tests pass']);
  assert.match(setOut.stdout, /all tests pass/);

  // Status shows the goal
  const statusOut = runSupervisor(tmp, ['goal']);
  assert.match(statusOut.stdout, /all tests pass/);

  // Clear the goal
  const clearOut = runSupervisor(tmp, ['goal', 'clear']);
  assert.match(clearOut.stdout, /cleared/i);

  // Status shows no goal
  const afterClear = runSupervisor(tmp, ['goal']);
  assert.match(afterClear.stdout, /no goal/i);
});

// ── 6. retry 7 → budget stored ───────────────────────────────────────────────

test('retry 7 → sets budget; state.maxAttempts === 7', () => {
  const tmp = mktmp();
  const sid = 'cli-test-retry';
  writeSession(tmp, sid);
  const { stdout } = runSupervisor(tmp, ['retry', '7']);
  assert.match(stdout, /7/);
  const state = loadGoalState(tmp, sid);
  assert.equal(state?.maxAttempts, 7);
});

// ── 7. off / on — disabled file ───────────────────────────────────────────────

test('off adds session to .supervisor/disabled; on removes it', () => {
  const tmp = mktmp();
  const sid = 'cli-test-onoff';
  writeSession(tmp, sid);

  runSupervisor(tmp, ['off']);
  const disabledPath = path.join(tmp, '.supervisor', 'disabled');
  const afterOff = fs.readFileSync(disabledPath, 'utf8');
  assert.ok(afterOff.includes(sid), 'session should appear in disabled file');

  runSupervisor(tmp, ['on']);
  const afterOn = fs.readFileSync(disabledPath, 'utf8');
  assert.ok(!afterOn.includes(sid), 'session should be removed from disabled file after on');
});

// ── 8. unknown command ────────────────────────────────────────────────────────

test('unknown command → stdout mentions valid commands', () => {
  const tmp = mktmp();
  const sid = 'cli-test-unknown';
  writeSession(tmp, sid);
  const { stdout, status } = runSupervisor(tmp, ['frobnicate']);
  assert.equal(status, 1);
  assert.match(stdout, /autopilot/i);
  assert.match(stdout, /reflection/i);
});

// ── 9. supervisor-goal.mjs shim back-compat ───────────────────────────────────

test('supervisor-goal.mjs shim: node bin/supervisor-goal.mjs goal "x" sets a goal', () => {
  const tmp = mktmp();
  const sid = 'cli-shim-goal';
  writeSession(tmp, sid);
  const r = spawnSync('node', [SUPERVISOR_GOAL, 'goal', 'ship it via shim'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  const stdout = (r.stdout || '').trim();
  assert.match(stdout, /ship it via shim/);
  const state = loadGoalState(tmp, sid);
  assert.ok(state?.goal?.condition?.includes('ship it via shim'), 'goal condition should be persisted');
});

// ── 12. autopilot-on with active goal → warning printed, mode becomes autopilot ──

test('autopilot on with active goal → prints goal-clear warning; mode becomes autopilot', () => {
  const tmp = mktmp();
  const sid = 'cli-test-ap-goal-warn';
  writeSession(tmp, sid);

  // Set an active goal first
  runSupervisor(tmp, ['goal', 'ship it']);

  // Now switch to autopilot — should warn about goal being cleared
  const { stdout } = runSupervisor(tmp, ['autopilot', 'on']);
  assert.match(stdout, /⚠.*Clearing active goal.*ship it/i);
  assert.match(stdout, /mode:\s*autopilot/i);

  // State should be autopilot, no goal
  const state = loadGoalState(tmp, sid);
  assert.equal(state?.mode, 'autopilot');
  assert.equal(state?.goal, undefined);
});

// ── Autopilot hook tests (via on-stop.mjs) ───────────────────────────────────

test('autopilot mode + text WITHOUT AUTOPILOT_EXIT → on-stop blocks with Autopilot reason', () => {
  const tmp = mktmp();
  const sid = 'cli-test-ap-block';
  // Set up autopilot state
  writeSession(tmp, sid);
  runSupervisor(tmp, ['autopilot', 'on']);

  const turns = [
    { type: 'user', message: { role: 'user', content: 'keep going' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am still working on this.' }] } },
  ];
  const tp = mkTranscript(tmp, turns);

  const payload = {
    session_id: sid,
    cwd: tmp,
    transcript_path: tp,
    last_assistant_message: 'I am still working on this.',
  };

  const { code, stdout } = runOnStop(payload);
  assert.equal(code, 0);
  assert.ok(stdout.length > 0, 'should have stdout (block decision)');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /autopilot/i);
});

test('autopilot mode + text containing AUTOPILOT_EXIT → on-stop does not block; disables autopilot', () => {
  const tmp = mktmp();
  const sid = 'cli-test-ap-exit';
  writeSession(tmp, sid);
  runSupervisor(tmp, ['autopilot', 'on']);

  const exitText = 'All done!\nAUTOPILOT_EXIT\nTask complete.';
  const turns = [
    { type: 'user', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: exitText }] } },
  ];
  const tp = mkTranscript(tmp, turns);

  const payload = {
    session_id: sid,
    cwd: tmp,
    transcript_path: tp,
    last_assistant_message: exitText,
  };

  const { code, stdout } = runOnStop(payload);
  assert.equal(code, 0);
  assert.equal(stdout, '', 'should produce no stdout (no block) when AUTOPILOT_EXIT seen');

  // Autopilot should be disabled in state
  const state = loadGoalState(tmp, sid);
  assert.ok(state !== null, 'state file should exist');
  // After exit, mode should no longer be autopilot
  const mode = state?.mode ?? (state?.autopilot ? 'autopilot' : 'reflection');
  assert.notEqual(mode, 'autopilot', 'autopilot should be disabled after AUTOPILOT_EXIT');
});
