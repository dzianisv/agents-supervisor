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

import { normalizeReplyText, hashReply, isNoProgressRepeat } from '../core/evaluation.mjs';
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

describe('isNoProgressRepeat', () => {
  test('identical normalized reply -> stand down', () => {
    const prior = hashReply('Same. Standing by.');
    assert.equal(isNoProgressRepeat('Same. Standing by.', prior), true);
  });

  test('whitespace-only difference -> stand down', () => {
    const prior = hashReply('Same. Standing by.');
    assert.equal(isNoProgressRepeat('Same.\n\nStanding    by.', prior), true);
  });

  test('case-only difference -> stand down', () => {
    const prior = hashReply('Same. Standing by.');
    assert.equal(isNoProgressRepeat('SAME. STANDING BY.', prior), true);
  });

  test('genuinely different reply -> proceed', () => {
    const prior = hashReply('Same. Standing by.');
    assert.equal(isNoProgressRepeat('Opened PR #62, CI green.', prior), false);
  });

  test('a one-word difference is enough to proceed (no fuzzy threshold)', () => {
    const prior = hashReply('Same. Standing by.');
    assert.equal(isNoProgressRepeat('Same. Standing by, again.', prior), false);
  });

  test('no prior hash (first turn) -> proceed', () => {
    assert.equal(isNoProgressRepeat('Same. Standing by.', null), false);
    assert.equal(isNoProgressRepeat('Same. Standing by.', undefined), false);
    assert.equal(isNoProgressRepeat('Same. Standing by.', ''), false);
  });

  test('blank current text -> proceed (nothing to compare)', () => {
    assert.equal(isNoProgressRepeat('', hashReply('Same. Standing by.')), false);
  });

  test('the observed 8-in-a-row loop stands down from the second reply on', () => {
    let prior = null;
    const decisions = [];
    for (let i = 0; i < 8; i++) {
      const reply = 'Same. Standing by.';
      decisions.push(isNoProgressRepeat(reply, prior));
      prior = hashReply(reply);
    }
    assert.deepEqual(decisions, [false, true, true, true, true, true, true, true]);
  });
});

describe('goalStore.mutate — reply-hash persistence', () => {
  let cwd;
  test('setup', () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-noprogress-'));
  });

  test('stores lastReplyHash in the existing per-session state file', () => {
    const sid = 'sess-abc';
    goalStore.mutate(cwd, sid, (s) => { s.lastReplyHash = hashReply('Same. Standing by.'); });
    const loaded = goalStore.load(cwd, sid);
    assert.equal(loaded.lastReplyHash, hashReply('Same. Standing by.'));
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
    assert.match(src, /!autopilotExiting && isNoProgressRepeat/);
  });
});
