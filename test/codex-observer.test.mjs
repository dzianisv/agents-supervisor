import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionStore, statePath } from '../core/session-store.mjs';
import {
  CODEX_OBSERVER_LEASE_MS,
  recordCodexObserverAssistant,
  recordCodexObserverPrompt,
  recordCodexObserverTool,
  finishCodexObserverReview,
  releaseCodexObserverReview,
} from '../core/codex-observer.mjs';

function project() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-')); }
const sid = 'codex-session-a';

function tool(i, now = 1_000 + i) {
  return {
    tool_use_id: `call-${i}`,
    tool: 'shell',
    model: 'gpt-6-luna',
    input: { command: `cat file-${i}.txt` },
    result: { stdout: `result-${i}`, exitCode: 0 },
    startedAt: now - 5,
    completedAt: now,
  };
}

function record(cwd, i, options = {}) {
  return recordCodexObserverTool({
    cwd,
    sessionId: sid,
    turnId: options.turnId ?? 'turn-1',
    turnStartedAt: options.turnStartedAt ?? 100,
    userRequest: options.userRequest,
    toolCall: tool(i, options.now ?? 1_000 + i),
    interval: options.interval ?? 10,
    now: options.now ?? 1_000 + i,
  });
}

function runConcurrentRecorder(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`recorder exited ${code}`)));
  });
}

describe('Codex progress observer state', () => {
  test('claims one review per interval, dedupes tool ids, and retains calls arriving during review', () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Finish the parser', now: 100 });
    let claim;
    for (let i = 1; i <= 9; i++) assert.equal(record(cwd, i).due, false);
    claim = record(cwd, 10);
    assert.equal(claim.due, true);
    assert.equal(claim.snapshot.events.length, 10);
    assert.deepEqual(claim.snapshot.events[9].input, { command: 'cat file-10.txt' });
    assert.deepEqual(claim.snapshot.events[9].result, { stdout: 'result-10', exitCode: 0 });
    assert.deepEqual(claim.snapshot.userRequests.map((r) => r.text), ['Finish the parser']);

    // A duplicate completion hook is idempotent and cannot increment cadence.
    const duplicate = record(cwd, 10);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.due, false);
    // While the reviewer is working, only one lease is active, but events keep accumulating.
    assert.equal(record(cwd, 11).due, false);
    assert.equal(record(cwd, 12).due, false);
    assert.equal(record(cwd, 13).due, false);
    assert.equal(record(cwd, 14).due, false);
    assert.equal(record(cwd, 15).due, false);
    const state = sessionStore.load(cwd, sid);
    assert.equal(state.codexObserver.events.at(-1).tool_use_id, 'call-15');

    const finished = finishCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: claim.token, feedback: 'Check the failing parser fixture.', now: 2_000 });
    assert.equal(finished.inject, true);
    // The five events beyond the captured throughSeq have not been consumed.
    const next = record(cwd, 16);
    assert.equal(next.due, false);
    for (let i = 16; i <= 19; i++) assert.equal(record(cwd, i).due, false);
    const nextClaim = record(cwd, 20);
    assert.equal(nextClaim.due, true);
    assert.equal(nextClaim.snapshot.completedSinceReview, 10);
    assert.ok(fs.existsSync(statePath(cwd, sid)));
  });

  test('turn boundary preserves request history but isolates tool evidence and rejects out-of-order hooks', () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Build the importer', now: 100 });
    record(cwd, 1);
    recordCodexObserverAssistant({ cwd, sessionId: sid, turnId: 'turn-1', assistantReply: 'Importer added.', now: 2_000 });
    assert.equal(recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-2', turnStartedAt: 300, userRequest: 'Resume; also handle CSV quoting', now: 300 }).recorded, true);

    const fresh = record(cwd, 2, { turnId: 'turn-2', turnStartedAt: 300, now: 2_100 });
    assert.equal(fresh.due, false);
    assert.deepEqual(fresh, { due: false });
    const state = sessionStore.load(cwd, sid).codexObserver;
    assert.deepEqual(state.events.map((e) => e.tool_use_id), ['call-2']);
    assert.deepEqual(state.requestHistory.map((r) => r.text), ['Build the importer', 'Resume; also handle CSV quoting']);
    assert.equal(state.latestAssistant, null, 'a prior-turn answer must not be presented as current focus context');

    const stale = record(cwd, 3, { turnId: 'turn-old-delayed', turnStartedAt: 200, now: 2_200 });
    assert.equal(stale.staleTurn, true);
    assert.equal(record(cwd, 4, { turnId: 'turn-1', now: 2_300 }).staleTurn, true, 'old PostToolUse without a start timestamp cannot roll back the prompt-owned turn');
    assert.equal(sessionStore.load(cwd, sid).codexObserver.turnId, 'turn-2');
  });

  test('old leases cannot finish after expiry or after a newer human turn', () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Finish the task', now: 100 });
    for (let i = 1; i <= 10; i++) record(cwd, i, { now: 1_000 + i });
    const firstLease = sessionStore.load(cwd, sid).codexObserver.lease;
    assert.ok(firstLease.token);
    assert.equal(record(cwd, 11, { now: 1_011 }).due, false); // first interval already has an active lease
    const second = record(cwd, 12, { now: 1_000 + CODEX_OBSERVER_LEASE_MS + 20 });
    assert.equal(second.due, true); // stale lease can be reclaimed
    assert.notEqual(second.token, undefined);
    assert.equal(finishCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: firstLease.token, feedback: 'old result' }).stale, true);
    assert.equal(releaseCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: firstLease.token }), false);

    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-2', turnStartedAt: 50_000, userRequest: 'Next task', now: 50_000 });
    const late = finishCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: second.token, feedback: 'late result' });
    assert.equal(late.stale, true);
    assert.equal(sessionStore.load(cwd, sid).codexObserver.turnId, 'turn-2');
  });

  test('a failed review consumes its sampled window and waits for a full new interval', () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Complete the task', now: 100 });
    let claim;
    for (let i = 1; i <= 10; i++) {
      const result = record(cwd, i);
      if (result.due) claim = result;
    }
    assert.ok(claim?.token);
    assert.equal(releaseCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: claim.token }), true);
    assert.equal(sessionStore.load(cwd, sid).codexObserver.reviewedThroughSeq, 10);
    for (let i = 11; i <= 19; i++) assert.equal(record(cwd, i).due, false);
    const next = record(cwd, 20);
    assert.equal(next.due, true);
    assert.equal(next.snapshot.completedSinceReview, 10);
  });

  test('matching lease releases, duplicate feedback is not injected twice, and unrelated state survives concurrent-style mutations', () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Keep working', now: 100 });
    sessionStore.mutate(cwd, sid, (state) => { state.goal = { condition: 'Keep this goal' }; });
    for (let i = 1; i <= 10; i++) record(cwd, i);
    const claim = sessionStore.load(cwd, sid).codexObserver.lease;
    const one = finishCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: claim.token, feedback: 'Inspect foo.mjs:42.', now: 2_000 });
    assert.equal(one.inject, true);
    for (let i = 11; i <= 20; i++) record(cwd, i);
    const nextClaim = sessionStore.load(cwd, sid).codexObserver.lease;
    const two = finishCodexObserverReview({ cwd, sessionId: sid, turnId: 'turn-1', token: nextClaim.token, feedback: 'Inspect foo.mjs:42.', now: 3_000 });
    assert.equal(two.accepted, true);
    assert.equal(two.duplicate, true);
    assert.equal(two.inject, false);
    assert.deepEqual(sessionStore.load(cwd, sid).goal, { condition: 'Keep this goal' });
  });

  test('parallel hook processes serialize updates through the session-store lock', async () => {
    const cwd = project();
    recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: 'turn-1', turnStartedAt: 100, userRequest: 'Inspect all files', now: 100 });
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/codex-observer.mjs');
    const workers = Array.from({ length: 12 }, (_, i) => {
      const eventId = `parallel-${i}`;
      const eventTime = 2_000 + i;
      const script = `
        import { recordCodexObserverTool } from ${JSON.stringify(modulePath)};
        recordCodexObserverTool({
          cwd: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(sid)}, turnId: 'turn-1',
          toolCall: { tool_use_id: ${JSON.stringify(eventId)}, tool: 'shell', input: { i: ${i} }, result: { ok: true } },
          now: ${eventTime}
        });
      `;
      return runConcurrentRecorder(script);
    });
    await Promise.all(workers);
    const observer = sessionStore.load(cwd, sid).codexObserver;
    assert.equal(observer.nextSeq, 12, 'all twelve unique concurrent updates must survive');
    assert.equal(observer.seenToolUseIds.length, 12);
    assert.equal(new Set(observer.events.map((event) => event.tool_use_id)).size, 10, 'rolling review buffer remains bounded to ten events');
    assert.equal(observer.lease.throughSeq, 10, 'only one threshold crossing claims the review lease');
  });
});
