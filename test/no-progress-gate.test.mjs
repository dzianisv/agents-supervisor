/**
 * FIX 3 — no-progress / repeat-reply gate.
 *
 * Observed degenerate steady state: the agent replied `Same. Standing by.`
 * eight times in a row, each in answer to a fresh injection. The supervisor
 * had no detection for "the reply has not changed, so pushing again is
 * pointless".
 *
 * Deliberately NOT a fuzzy similarity metric: normalize (trim, collapse
 * internal whitespace, lowercase) then compare a hash. Exact match on the
 * normalized form is deterministic and testable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeReplyText, hashReply, evaluateNoProgress, NO_PROGRESS_REPEAT_THRESHOLD } from '../core/evaluation.mjs';
import { goalStore } from '../core/goal.mjs';

describe('normalizeReplyText', () => {
  test('trims, collapses internal whitespace, lowercases', () => {
    assert.equal(normalizeReplyText('  Same.\n\n  Standing   BY. '), 'same. standing by.');
  });

  test('non-strings become empty', () => {
    assert.equal(normalizeReplyText(undefined), '');
    assert.equal(normalizeReplyText(null), '');
    assert.equal(normalizeReplyText(7), '');
  });
});

describe('hashReply', () => {
  test('null for blank/absent text so it can never collide with a real hash', () => {
    assert.equal(hashReply(''), null);
    assert.equal(hashReply('   \n\t '), null);
    assert.equal(hashReply(undefined), null);
  });

  test('stable and whitespace/case insensitive', () => {
    assert.equal(hashReply('Same. Standing by.'), hashReply('  same.   STANDING\nby.  '));
  });

  test('different content hashes differently', () => {
    assert.notEqual(hashReply('Same. Standing by.'), hashReply('Fixed the auth middleware.'));
  });
});

describe('evaluateNoProgress — consecutive-repeat counter', () => {
  const REPLY = 'Same. Standing by.';

  test('the threshold is a named exported constant, default 2', () => {
    assert.equal(NO_PROGRESS_REPEAT_THRESHOLD, 2);
  });

  test('first turn (no prior hash) → inject, counter 0', () => {
    const r = evaluateNoProgress(REPLY, null, 0);
    assert.equal(r.standDown, false);
    assert.equal(r.repeatCount, 0);
    assert.equal(r.hash, hashReply(REPLY));
    assert.equal(evaluateNoProgress(REPLY, undefined, undefined).standDown, false);
    assert.equal(evaluateNoProgress(REPLY, '', 0).standDown, false);
  });

  test('ONE repeat still injects — a stuck agent sometimes moves on the 2nd push', () => {
    const r = evaluateNoProgress(REPLY, hashReply(REPLY), 0);
    assert.equal(r.repeatCount, 1);
    assert.equal(r.standDown, false);
  });

  test('TWO consecutive repeats → stand down', () => {
    const r = evaluateNoProgress(REPLY, hashReply(REPLY), 1);
    assert.equal(r.repeatCount, 2);
    assert.equal(r.standDown, true);
  });

  test('whitespace/case-only differences still count as a repeat', () => {
    assert.equal(evaluateNoProgress('SAME.\n\nStanding    BY.', hashReply(REPLY), 1).standDown, true);
  });

  test('a different reply in between RESETS the counter', () => {
    const different = evaluateNoProgress('Opened PR #62, CI green.', hashReply(REPLY), 1);
    assert.equal(different.repeatCount, 0);
    assert.equal(different.standDown, false);
    assert.equal(different.hash, hashReply('Opened PR #62, CI green.'));
    // and the next identical-to-THAT reply is only repeat 1 again
    assert.equal(evaluateNoProgress('Opened PR #62, CI green.', different.hash, different.repeatCount).standDown, false);
  });

  test('blank current text → carry prior state, never stand down', () => {
    const r = evaluateNoProgress('', hashReply(REPLY), 1);
    assert.equal(r.standDown, false);
    assert.equal(r.hash, hashReply(REPLY));
    assert.equal(r.repeatCount, 1);
  });

  test('the observed 8-in-a-row loop stands down from the THIRD reply on', () => {
    let hash = null;
    let count = 0;
    const decisions = [];
    for (let i = 0; i < 8; i++) {
      const r = evaluateNoProgress(REPLY, hash, count);
      decisions.push(r.standDown);
      if (r.standDown) continue;   // hook exits; state is not advanced
      hash = r.hash;
      count = r.repeatCount;
    }
    assert.deepEqual(decisions, [false, false, true, true, true, true, true, true]);
    assert.equal(decisions.indexOf(true), 2, 'stand-down must begin at the 3rd identical reply');
  });
});

describe('goalStore.mutate — reply-hash persistence', () => {
  let cwd;
  test('setup', () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-noprogress-'));
  });

  test('stores lastReplyHash + replyRepeatCount in the existing per-session state file', () => {
    const sid = 'sess-abc';
    goalStore.mutate(cwd, sid, (s) => { s.lastReplyHash = hashReply('Same. Standing by.'); s.replyRepeatCount = 1; });
    const loaded = goalStore.load(cwd, sid);
    assert.equal(loaded.lastReplyHash, hashReply('Same. Standing by.'));
    assert.equal(loaded.replyRepeatCount, 1);
    // Same on-disk layout as every other per-session key — no new file.
    assert.ok(fs.existsSync(path.join(cwd, '.supervisor', 'goals', `${sid}.json`)));
  });

  test('does not collide with attempts/goal keys', () => {
    const sid = 'sess-def';
    goalStore.save(cwd, sid, { goal: { condition: 'ship it', status: 'active', attempts: 4 }, maxAttempts: 9 });
    goalStore.mutate(cwd, sid, (s) => { s.lastReplyHash = 'deadbeef'; });
    const loaded = goalStore.load(cwd, sid);
    assert.equal(loaded.lastReplyHash, 'deadbeef');
    assert.equal(loaded.goal.attempts, 4);
    assert.equal(loaded.goal.status, 'active');
    assert.equal(loaded.maxAttempts, 9);
  });

  test('mutate re-reads before writing (no lost update)', () => {
    const sid = 'sess-ghi';
    goalStore.save(cwd, sid, { maxAttempts: 3 });
    const staleView = goalStore.load(cwd, sid);   // read early in the turn
    goalStore.save(cwd, sid, { ...staleView, maxAttempts: 3, attemptsMirror: 7 }); // someone else writes
    goalStore.mutate(cwd, sid, (s) => { s.lastReplyHash = 'cafe'; });
    const loaded = goalStore.load(cwd, sid);
    assert.equal(loaded.attemptsMirror, 7, 'mutate must not clobber the interleaved write');
    assert.equal(loaded.lastReplyHash, 'cafe');
  });

  test('teardown', () => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('the gate is wired into the hook', () => {
  const src = fs.readFileSync(new URL('../bin/supervisor-on-stop.mjs', import.meta.url), 'utf8');

  test('emits an observable debug line', () => {
    assert.match(src, /msg:\s*'no_progress_gate'/);
  });

  test('does NOT burn an attempt (no writeAttemptCounter in the gate block)', () => {
    const block = src.slice(src.indexOf('NO-PROGRESS GATE'), src.indexOf('// 4a. Autopilot fast-path'));
    assert.ok(block.length > 0, 'gate block not found');
    assert.equal(/writeAttemptCounter\(/.test(block), false);
  });

  test('sits BEFORE the autopilot fast-path and the judge, so it covers goal/autopilot', () => {
    const gate = src.indexOf('NO-PROGRESS GATE');
    const autopilot = src.indexOf('// 4a. Autopilot fast-path');
    const judge = src.indexOf('await buildReflectionPrompt(');
    assert.ok(gate > 0 && autopilot > gate, 'gate must precede the autopilot fast-path');
    assert.ok(judge > gate, 'gate must precede the judge');
  });

  test('sits AFTER the attempt-cap gate (cheap eligibility gates run first)', () => {
    const cap = src.indexOf("msg: 'attempt_cap_reached'");
    const gate = src.indexOf('NO-PROGRESS GATE');
    assert.ok(cap > 0 && gate > cap, 'gate must follow the attempt cap check');
  });

  test('AUTOPILOT_EXIT is never swallowed by the gate', () => {
    assert.match(src, /autopilotExiting/);
    assert.match(src, /!autopilotExiting && noProgress\.standDown/);
  });
});
