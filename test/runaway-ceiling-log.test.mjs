/**
 * runaway-ceiling-log.test.mjs — DEFECT 2: hitting the per-turn attempt
 * ceiling must leave forensic evidence, on BOTH runtimes.
 *
 * `RUNAWAY_CEILING` (core/goal.mjs) is the circuit breaker for a pathological
 * loop. When the agent DECLARES `stuck` via `supervisor_loop_exit` (opencode
 * tool) / `SUPERVISOR_LOOP_EXIT: stuck` (Claude Code sentinel), the runtime
 * already appends a forensic record to `.supervisor/loop-exit.log`. Hitting
 * the ceiling is strictly WORSE — it means the loop never terminated on its
 * own, only the circuit breaker did — but it previously left only a debug()
 * line, invisible without SUPERVISOR_DEBUG=1.
 *
 * Both call sites now go through the ONE shared writer, `appendLoopExitLog`
 * (core/loop-exit.mjs), so the file never grows a second record shape. A
 * ceiling hit is tagged `reason: 'runaway_ceiling'` so it can never be
 * confused with a declared `stuck` exit.
 *
 * Run: node --experimental-strip-types --test test/runaway-ceiling-log.test.mjs
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { goalStore } from '../core/goal.mjs';
import { appendLoopExitLog } from '../core/loop-exit.mjs';
import { SupervisorPlugin } from '../opencode/supervisor-impl.ts';
import { sessionStore } from '../core/session-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ON_STOP = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');
const mkcwd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sup-ceiling-'));

function readLogRecords(dir) {
  const p = path.join(dir, '.supervisor', 'loop-exit.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// The shared writer itself
// ---------------------------------------------------------------------------

describe('appendLoopExitLog — the ONE writer for both runtimes', () => {
  test('writes a JSON line under .supervisor/, creating the dir', () => {
    const d = mkcwd();
    const ok = appendLoopExitLog(d, { session: 's1', reason: 'stuck', at: 123 });
    assert.equal(ok, true);
    const recs = readLogRecords(d);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].session, 's1');
    assert.equal(recs[0].reason, 'stuck');
  });

  test('appends, never overwrites', () => {
    const d = mkcwd();
    appendLoopExitLog(d, { session: 's1', reason: 'stuck', at: 1 });
    appendLoopExitLog(d, { session: 's1', reason: 'runaway_ceiling', at: 2 });
    const recs = readLogRecords(d);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].reason, 'stuck');
    assert.equal(recs[1].reason, 'runaway_ceiling');
  });

  test('best-effort: a write under an unwritable path fails closed, never throws', () => {
    const d = mkcwd();
    // `.supervisor` exists as a FILE, so mkdir underneath must fail.
    fs.writeFileSync(path.join(d, '.supervisor'), 'not a directory');
    let ok;
    assert.doesNotThrow(() => { ok = appendLoopExitLog(d, { session: 's1', reason: 'stuck', at: 1 }); });
    assert.equal(ok, false);
  });
});

// ---------------------------------------------------------------------------
// Claude Code: attempt-cap gate now also writes the log
// ---------------------------------------------------------------------------

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

describe('Claude Code: hitting the per-turn ceiling writes a runaway_ceiling record', () => {
  test('a goal capped at maxAttempts=1 logs on the SECOND stop of the same turn', () => {
    const d = mkcwd();
    const sid = 'ceiling-cc-goal';
    goalStore.setGoal(d, sid, 'ship the feature');
    goalStore.setRetry(d, sid, 1); // effectiveMax = 1 for this turn

    const turns = [
      { type: 'user', message: { role: 'user', content: 'ship the feature end to end' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] } },
    ];
    const tp = mkTranscript(d, turns, 'ceiling-cc');
    const payload = { session_id: sid, cwd: d, transcript_path: tp, last_assistant_message: 'Working on it.' };

    // 1st stop: attempts(0) < max(1) → injects, attempts becomes 1. No log yet.
    const first = runOnStop(payload);
    assert.equal(first.code, 0);
    assert.equal(JSON.parse(first.stdout).decision, 'block', 'first stop must still inject — budget not spent yet');
    assert.equal(readLogRecords(d).length, 0, 'no ceiling record before the budget is actually spent');

    // 2nd stop, SAME turn (identical transcript/human message): attempts(1) >= max(1) → ceiling hit.
    const second = runOnStop(payload);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', 'a capped turn must not inject');

    const recs = readLogRecords(d);
    assert.equal(recs.length, 1, 'the ceiling hit must be recorded exactly once');
    const rec = recs[0];
    assert.equal(rec.session, sid);
    assert.equal(rec.reason, 'runaway_ceiling');
    // Setting a goal now forces reflection (goal is an attribute, not a mode).
    assert.equal(rec.mode, 'reflection');
    assert.equal(rec.attempts, 1);
    assert.equal(rec.maxAttempts, 1);
    assert.ok(Number.isFinite(rec.at));
    assert.notEqual(rec.reason, 'stuck', 'a ceiling hit must never be recorded as a declared stuck exit');
  });

  test('a declared `stuck` exit and a ceiling hit are DISTINGUISHABLE in the same log', () => {
    const d = mkcwd();
    const sidStuck = 'ceiling-cc-stuck';
    const turnsStuck = [
      { type: 'user', message: { role: 'user', content: 'fix the flaky test' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPERVISOR_LOOP_EXIT: stuck — judge keeps repeating itself' }] } },
    ];
    const tpStuck = mkTranscript(d, turnsStuck, 'stuck-cc');
    const outStuck = runOnStop({ session_id: sidStuck, cwd: d, transcript_path: tpStuck, last_assistant_message: 'SUPERVISOR_LOOP_EXIT: stuck — judge keeps repeating itself' });
    assert.equal(outStuck.code, 0);

    const sidCeiling = 'ceiling-cc-ceiling';
    goalStore.setGoal(d, sidCeiling, 'ship it');
    goalStore.setRetry(d, sidCeiling, 1);
    const turnsCeiling = [
      { type: 'user', message: { role: 'user', content: 'ship it end to end' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] } },
    ];
    const tpCeiling = mkTranscript(d, turnsCeiling, 'ceiling-cc-2');
    const payloadCeiling = { session_id: sidCeiling, cwd: d, transcript_path: tpCeiling, last_assistant_message: 'Working.' };
    runOnStop(payloadCeiling); // 1st: injects, attempts -> 1
    runOnStop(payloadCeiling); // 2nd: ceiling hit

    const recs = readLogRecords(d);
    const stuckRec = recs.find((r) => r.session === sidStuck);
    const ceilingRec = recs.find((r) => r.session === sidCeiling);
    assert.ok(stuckRec, 'declared stuck exit must be logged');
    assert.ok(ceilingRec, 'ceiling hit must be logged');
    assert.equal(stuckRec.reason, 'stuck');
    assert.equal(ceilingRec.reason, 'runaway_ceiling');
    assert.notEqual(stuckRec.reason, ceilingRec.reason);
  });
});

// ---------------------------------------------------------------------------
// opencode: the runaway-ceiling circuit breaker now also writes the log
// ---------------------------------------------------------------------------

function makeMessages(userText, assistantText) {
  return [
    {
      info: { role: 'user', id: 'msg_user_ceiling', time: { created: Date.now() - 5000, completed: Date.now() - 4900 } },
      parts: [{ type: 'text', text: userText }],
    },
    {
      info: { role: 'assistant', id: 'msg_asst_ceiling', time: { created: Date.now() - 4800, completed: Date.now() - 1000 } },
      parts: [{ type: 'text', text: assistantText }],
    },
  ];
}

function createStubClient(sessionId, getMessages) {
  const promptCalls = [];
  const client = {
    session: {
      create: async () => ({ data: { id: `ses_judge_${sessionId}` } }),
      messages: async ({ path }) => ({ data: path.id === sessionId ? getMessages() : [] }),
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, body });
        return {};
      },
      delete: async () => ({}),
    },
    toast: { create: async () => ({}) },
  };
  return { client, activePrompts: () => promptCalls.filter((c) => c.sessionId === sessionId) };
}

describe('opencode: hitting the per-turn ceiling writes a runaway_ceiling record', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-ceiling-oc-')); });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  test('autopilot capped at maxAttempts=1 logs on the SECOND idle of the same turn', async () => {
    const SESSION_ID = 'ses_oc_ceiling';
    goalStore.setMode(tmpDir, SESSION_ID, 'autopilot');
    goalStore.setRetry(tmpDir, SESSION_ID, 1); // effectiveMaxAttempts = 1

    const { client, activePrompts } = createStubClient(SESSION_ID, () => makeMessages('do the thing', 'Working — pass 1.'));
    const plugin = await SupervisorPlugin({ client, directory: tmpDir });

    // 1st idle: attempts(0) < max(1) → nudges, attempts becomes 1.
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: SESSION_ID } } });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(activePrompts().length, 1, 'first idle must still nudge — budget not spent yet');
    assert.equal(readLogRecords(tmpDir).length, 0, 'no ceiling record before the budget is actually spent');

    // 2nd idle, SAME turn: attempts(1) >= max(1) → ceiling hit.
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: SESSION_ID } } });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(activePrompts().length, 1, 'a capped turn must not nudge again');

    const recs = readLogRecords(tmpDir);
    assert.equal(recs.length, 1, 'the ceiling hit must be recorded exactly once');
    const rec = recs[0];
    assert.equal(rec.session, SESSION_ID);
    assert.equal(rec.reason, 'runaway_ceiling');
    assert.equal(rec.mode, 'autopilot');
    assert.equal(rec.attempts, 1);
    assert.equal(rec.maxAttempts, 1);
    assert.ok(Number.isFinite(rec.at));
  });

  test('a declared `stuck` exit (tool) and a ceiling hit are DISTINGUISHABLE in the same log', async () => {
    const SESSION_STUCK = 'ses_oc_stuck_ceiling';
    const SESSION_CEILING = 'ses_oc_ceiling';

    // Declared stuck exit, via the real tool — unrelated session.
    const { client: clientStuck } = createStubClient(SESSION_STUCK, () => makeMessages('fix it', 'still broken'));
    const pluginStuck = await SupervisorPlugin({ client: clientStuck, directory: tmpDir })
    await pluginStuck.tool.supervisor_loop_exit.execute(
      { reason: 'stuck', detail: 'judge keeps repeating itself' },
      { sessionID: SESSION_STUCK },
    )

    // Ceiling hit, via the circuit breaker.
    goalStore.setMode(tmpDir, SESSION_CEILING, 'autopilot')
    goalStore.setRetry(tmpDir, SESSION_CEILING, 1)
    const { client: clientCeiling } = createStubClient(SESSION_CEILING, () => makeMessages('do it', 'Working — pass 1.'))
    const pluginCeiling = await SupervisorPlugin({ client: clientCeiling, directory: tmpDir })
    await pluginCeiling.event({ event: { type: 'session.idle', properties: { sessionID: SESSION_CEILING } } })
    await new Promise((r) => setTimeout(r, 800))
    await pluginCeiling.event({ event: { type: 'session.idle', properties: { sessionID: SESSION_CEILING } } })
    await new Promise((r) => setTimeout(r, 800))

    const recs = readLogRecords(tmpDir);
    const stuckRec = recs.find((r) => r.session === SESSION_STUCK);
    const ceilingRec = recs.find((r) => r.session === SESSION_CEILING);
    assert.ok(stuckRec, 'declared stuck exit must be logged');
    assert.ok(ceilingRec, 'ceiling hit must be logged');
    assert.equal(stuckRec.reason, 'stuck');
    assert.equal(ceilingRec.reason, 'runaway_ceiling');
    assert.notEqual(stuckRec.reason, ceilingRec.reason);
  });
});

// ---------------------------------------------------------------------------
// Source pins — one writer, both call sites, no second format
// ---------------------------------------------------------------------------

describe('source pins: one writer, both call sites', () => {
  const ccSrc = fs.readFileSync(new URL('../bin/supervisor-on-stop.mjs', import.meta.url), 'utf8');
  const ocSrc = fs.readFileSync(new URL('../opencode/supervisor-impl.ts', import.meta.url), 'utf8');

  test('Claude Code: both the ceiling gate and the stuck loop-exit handler call appendLoopExitLog', () => {
    assert.match(ccSrc, /import \{ parseLoopExitSentinel, appendLoopExitLog \} from '\.\.\/core\/loop-exit\.mjs';/);
    const capBlock = ccSrc.slice(ccSrc.indexOf('if (attempts >= effectiveMax) {'), ccSrc.indexOf("msg: 'attempt_cap_reached'"));
    assert.match(capBlock, /appendLoopExitLog\(cwd, \{/);
    assert.match(capBlock, /reason: 'runaway_ceiling'/);
    const stuckBlock = ccSrc.slice(ccSrc.indexOf('// 4a-0. LOOP EXIT'), ccSrc.indexOf('// 4a. Autopilot fast-path'));
    assert.match(stuckBlock, /appendLoopExitLog\(cwd, \{ session: session_id, turnKey, reason, detail, at \}\)/);
    // No hand-rolled fs.mkdirSync/appendFileSync for loop-exit.log left behind.
    assert.equal(/loop-exit\.log[\s\S]{0,120}fs\.appendFileSync/.test(ccSrc), false);
  });

  test('opencode: both the ceiling circuit breaker and executeSupervisorLoopExit call appendLoopExitLog', () => {
    assert.match(ocSrc, /import \{ appendLoopExitLog \} from "\.\.\/core\/loop-exit\.mjs"/);
    const capStart = ocSrc.indexOf('if (currentAttemptCount >= effectiveMaxAttempts) {');
    assert.ok(capStart > 0, 'ceiling gate not found');
    const capBlock = ocSrc.slice(capStart, ocSrc.indexOf('const context = await buildTaskContext', capStart));
    assert.match(capBlock, /appendLoopExitLog\(directory, \{/);
    assert.match(capBlock, /reason: "runaway_ceiling"/);
    const stuckBlock = ocSrc.slice(ocSrc.indexOf('const executeSupervisorLoopExit ='), ocSrc.indexOf('// autopilot_exit tool'));
    assert.match(stuckBlock, /appendLoopExitLog\(directory, \{ session: sid, turnKey, reason, detail, at \}\)/);
  });
});
