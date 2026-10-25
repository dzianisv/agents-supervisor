/**
 * no-progress-gate-opencode.test.mjs — DEFECT 1 (runtime-parity gap): the
 * no-progress / repeat-reply gate existed ONLY on the Claude Code runtime
 * (bin/supervisor-on-stop.mjs's "NO-PROGRESS GATE", pinned by
 * test/no-progress-gate.test.mjs). opencode had ZERO detection for "the
 * agent's final reply hasn't changed, so pushing again is pointless" — grep
 * for `evaluateNoProgress` / `lastReplyHash` in opencode/supervisor-impl.ts
 * returned no matches before this fix.
 *
 * This file drives the REAL SupervisorPlugin (real session.idle handler,
 * real supervisor_loop_exit tool) with only the opencode HTTP client
 * stubbed — the same pattern as test/supervisor-gates.test.mjs and
 * test/loop-exit.test.mjs. It pins:
 *
 *   1. Repeated identical final replies stand the supervisor down after
 *      NO_PROGRESS_REPEAT_THRESHOLD consecutive repeats (shared helper,
 *      shared threshold, shared on-disk keys with the Claude Code runtime).
 *   2. The gate is an ELIGIBILITY gate: it must NOT burn the per-turn
 *      attempt counter (asserted against the persisted counter, not just
 *      "no injection happened").
 *   3. A declared `supervisor_loop_exit` is never swallowed by the gate —
 *      the pre-existing loop-exit gate (over `sup.loopExit`) sits BEFORE the
 *      no-progress code in the handler, pinned here at the source level so a
 *      future edit cannot silently reorder them.
 *
 * Run: node --experimental-strip-types --test test/no-progress-gate-opencode.test.mjs
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SupervisorPlugin } from '../opencode/supervisor-impl.ts';
import { sessionStore } from '../core/session-store.mjs';
import { goalStore } from '../core/goal.mjs';
import { hashReply, NO_PROGRESS_REPEAT_THRESHOLD } from '../core/evaluation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPL_SRC = readFileSync(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf8');

const SESSION_ID = 'ses_noprogress_oc_1';
const TURN_ONE = 'msg_user_1';

function makeMessages(assistantText) {
  return [
    {
      info: { role: 'user', id: TURN_ONE, time: { created: Date.now() - 5000, completed: Date.now() - 4900 } },
      parts: [{ type: 'text', text: 'Fix the bug in auth.ts and run the tests' }],
    },
    {
      info: { role: 'assistant', id: 'msg_asst_1', time: { created: Date.now() - 4800, completed: Date.now() - 1000 } },
      parts: [{ type: 'text', text: assistantText }],
    },
  ];
}

function createStubClient(getMessages) {
  const promptCalls = [];
  const client = {
    session: {
      create: async () => ({ data: { id: 'ses_judge_noprogress' } }),
      messages: async ({ path }) => ({ data: path.id === SESSION_ID ? getMessages() : [
        { info: { role: 'assistant', id: 'judge_reply', time: { completed: Date.now() } }, parts: [{ type: 'text', text: JSON.stringify({
          complete: false, severity: 'MEDIUM', feedback: 'The auth fix is still unverified',
          missing: ['Auth test evidence'], next_actions: ['Run the auth tests'], requires_human_action: false,
        }) }] },
      ] }),
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, body: { ...body } });
        return {};
      },
      delete: async () => ({}),
    },
    toast: { create: async () => ({}) },
  };
  return { client, activePrompts: () => promptCalls.filter((c) => c.sessionId === SESSION_ID) };
}

async function idle(plugin) {
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: SESSION_ID } } });
  await new Promise((r) => setTimeout(r, 900));
}

describe('opencode no-progress gate — repeated identical replies', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sup-noprogress-oc-'));
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('threshold is shared with the Claude Code runtime (2)', () => {
    assert.equal(NO_PROGRESS_REPEAT_THRESHOLD, 2);
  });

  test('two identical replies still nudge; the THIRD stands the supervisor down', async () => {
    goalStore.setGoal(tmpDir, SESSION_ID, 'Auth fix passes tests');
    const REPLY = 'Same. Standing by.';
    const { client, activePrompts } = createStubClient(() => makeMessages(REPLY));
    const plugin = await SupervisorPlugin({ client, directory: tmpDir });

    // 1st idle: no prior hash → must inject.
    await idle(plugin);
    assert.equal(activePrompts().length, 1, '1st idle (no prior hash) must inject');

    // 2nd idle: ONE repeat is tolerated — a stuck agent sometimes moves on
    // the 2nd push (see NO_PROGRESS_REPEAT_THRESHOLD's rationale).
    await idle(plugin);
    assert.equal(activePrompts().length, 2, '2nd identical reply must still inject once more');

    const attemptsBeforeStandDown = sessionStore.readAttempts(tmpDir, SESSION_ID, TURN_ONE);
    assert.equal(attemptsBeforeStandDown, 2);

    // 3rd idle: TWO consecutive repeats → stand down, no injection.
    await idle(plugin);
    assert.equal(activePrompts().length, 2, 'the 3rd identical reply must stand down, not inject a 3rd time');

    // The gate is an ELIGIBILITY gate — it must NOT have burned the
    // per-turn attempt counter. Assert the PERSISTED value, not just "no
    // injection happened" (a saturated counter would also show no injection,
    // but for the wrong reason, and would misfire the budget-exhausted
    // branch's side effects on a later idle).
    const attemptsAfterStandDown = sessionStore.readAttempts(tmpDir, SESSION_ID, TURN_ONE);
    assert.equal(
      attemptsAfterStandDown, attemptsBeforeStandDown,
      'the no-progress gate must not advance the per-turn attempt counter',
    );

    assert.equal(goalStore.load(tmpDir, SESSION_ID).goal?.status, 'active');
  });

  test('a different reply in between resets the counter — no false stand-down', async () => {
    goalStore.setGoal(tmpDir, SESSION_ID, 'Auth fix passes tests');
    let reply = 'Working on the auth fix.';
    const { client, activePrompts } = createStubClient(() => makeMessages(reply));
    const plugin = await SupervisorPlugin({ client, directory: tmpDir });

    await idle(plugin);
    reply = 'Same. Standing by.';
    await idle(plugin); // repeat count would-be 1 against a DIFFERENT prior hash → resets to 0
    reply = 'Same. Standing by.';
    await idle(plugin); // repeat 1 → still injects
    assert.equal(activePrompts().length, 3, 'no false stand-down: only 2 CONSECUTIVE identical replies preceded this');
  });

  test('lastReplyHash / replyRepeatCount persist through the SAME per-session state file as Claude Code', async () => {
    goalStore.setGoal(tmpDir, SESSION_ID, 'Auth fix passes tests');
    const REPLY = 'Same. Standing by.';
    const { client } = createStubClient(() => makeMessages(REPLY));
    const plugin = await SupervisorPlugin({ client, directory: tmpDir });

    await idle(plugin);
    const state = sessionStore.load(tmpDir, SESSION_ID);
    assert.equal(state.lastReplyHash, hashReply(REPLY));
    assert.equal(state.replyRepeatCount, 0);
  });
});

describe('opencode no-progress gate — a declared loop exit is never swallowed', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sup-noprogress-oc-loopexit-'));
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('stuck still suppresses injection even with a repeated final reply on record', async () => {
    goalStore.setGoal(tmpDir, SESSION_ID, 'Auth fix passes tests');
    const REPLY = 'Same. Standing by.';
    const { client, activePrompts } = createStubClient(() => makeMessages(REPLY));
    const plugin = await SupervisorPlugin({ client, directory: tmpDir });

    // Build up ONE repeat (below threshold) so no-progress state is live but
    // has not yet fired on its own.
    await idle(plugin);
    await idle(plugin);
    assert.equal(activePrompts().length, 2);

    // The agent now declares the loop over for this turn.
    const res = await plugin.tool.supervisor_loop_exit.execute({ reason: 'stuck' }, { sessionID: SESSION_ID });
    assert.match(String(res.title), /Supervision loop ended/);

    // A THIRD idle (which would ALSO independently satisfy the no-progress
    // threshold) must be intercepted by the loop-exit gate, not by chance
    // land on the no-progress gate reaching the same "stand down" verdict.
    await idle(plugin);
    assert.equal(activePrompts().length, 2, 'no injection after a declared exit');

    const state = sessionStore.load(tmpDir, SESSION_ID);
    assert.equal(state.loopExit.reason, 'stuck');
    assert.equal(state.loopExit.turnKey, TURN_ONE);
  });

  test('source pin: the pre-existing loop-exit gate (over sup.loopExit) sits BEFORE the no-progress gate', () => {
    const loopExitGateIdx = IMPL_SRC.indexOf('if (sup.loopExit) {');
    const ceilingGateIdx = IMPL_SRC.indexOf('if (Number.isFinite(runawayLimit) && currentAttemptCount >= runawayLimit) {');
    const noProgressIdx = IMPL_SRC.indexOf('No-progress gate (deterministic, no LLM)');
    assert.ok(loopExitGateIdx > 0, 'loop-exit gate not found');
    assert.ok(ceilingGateIdx > loopExitGateIdx, 'ceiling gate not found after loop-exit gate');
    assert.ok(noProgressIdx > ceilingGateIdx, 'no-progress gate must come after both the loop-exit gate and the ceiling breaker');
  });

  test('source pin: the no-progress gate does not call writeTurnAttempts (eligibility gate, not a spent attempt)', () => {
    const start = IMPL_SRC.indexOf('No-progress gate (deterministic, no LLM)');
    const end = IMPL_SRC.indexOf('Non-actionable turn gate', start);
    assert.ok(start > 0 && end > start, 'no-progress gate block not found');
    const block = IMPL_SRC.slice(start, end);
    assert.equal(/writeTurnAttempts\(/.test(block), false);
    assert.match(block, /evaluateNoProgress\(/);
    assert.match(block, /supervisorStore\.mutate\(/, 'must persist through the locked mutate(), not a bare save()');
  });
});
