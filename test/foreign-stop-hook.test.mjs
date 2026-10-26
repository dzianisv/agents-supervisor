/**
 * FIX 1 — foreign Stop-hook injections must not count as a human turn.
 *
 * Claude Code prefixes ANY registered Stop hook's `reason` with
 * `Stop hook feedback:` and writes it back into the transcript as
 * `{"type":"user","message":{"role":"user","content":"Stop hook feedback:\n..."},"isMeta":true}`.
 * Verified against a real transcript (98473024-*.jsonl, 125 such records).
 *
 * Before this fix computeTurnKey returned THAT text, so the turn key flipped
 * on every foreign injection and readAttempts reset to 0 forever — the
 * per-turn cap was unreachable in any project with a second Stop hook.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNonHumanUserMessage,
  isNonHumanUserText,
  FOREIGN_STOP_HOOK_PREFIX,
  SELF_ASSESSMENT_MARKER,
  FEEDBACK_MARKER,
} from '../core/evaluation.mjs';
import { computeTurnKey, normalizeTranscriptToMessages } from '../bin/supervisor-on-stop.mjs';

const userMsg = (text, extra = {}) => ({
  info: { role: 'user', ...(extra.info ?? {}) },
  parts: [{ type: 'text', text }],
  ...(extra.top ?? {}),
});
const assistantMsg = (text) => ({ info: { role: 'assistant' }, parts: [{ type: 'text', text }] });

// The exact literal, straight from the real transcript record.
const REAL_FOREIGN =
  'Stop hook feedback:\nPost-merge CI / CD on main FAILED after your merge: failure https://github.com/VibeTechnologies/OpenClawBot/actions/runs/31144032219 — you broke main.';

describe('FOREIGN_STOP_HOOK_PREFIX', () => {
  test('is the literal CC emits', () => {
    assert.equal(FOREIGN_STOP_HOOK_PREFIX, 'Stop hook feedback:');
    assert.ok(REAL_FOREIGN.startsWith(FOREIGN_STOP_HOOK_PREFIX));
  });
});

describe('isNonHumanUserText', () => {
  test('flags a foreign Stop hook injection', () => {
    assert.equal(isNonHumanUserText(REAL_FOREIGN), true);
  });

  test('tolerates leading whitespace before the prefix', () => {
    assert.equal(isNonHumanUserText('\n  Stop hook feedback:\ndo the thing'), true);
  });

  test('still flags this supervisor own markers', () => {
    assert.equal(isNonHumanUserText(`${SELF_ASSESSMENT_MARKER}\nblah`), true);
    assert.equal(isNonHumanUserText(`${FEEDBACK_MARKER} Task Incomplete`), true);
  });

  test('does not flag a human message that merely mentions stop hooks', () => {
    assert.equal(isNonHumanUserText('can you look at the Stop hook feedback path?'), false);
  });

  test('does not flag ordinary human text', () => {
    assert.equal(isNonHumanUserText('please fix the auth middleware'), false);
  });

  test('non-strings are not flagged', () => {
    assert.equal(isNonHumanUserText(undefined), false);
    assert.equal(isNonHumanUserText(null), false);
    assert.equal(isNonHumanUserText(42), false);
  });
});

describe('isNonHumanUserMessage', () => {
  test('isMeta on info flags the message even with innocuous text', () => {
    assert.equal(isNonHumanUserMessage(userMsg('do the thing', { info: { isMeta: true } })), true);
  });

  test('isMeta at top level flags the message too', () => {
    assert.equal(isNonHumanUserMessage(userMsg('do the thing', { top: { isMeta: true } })), true);
  });

  test('isMeta:false with human text is a human message', () => {
    assert.equal(isNonHumanUserMessage(userMsg('do the thing', { info: { isMeta: false } })), false);
  });

  test('text-based detection works without isMeta', () => {
    assert.equal(isNonHumanUserMessage(userMsg(REAL_FOREIGN)), true);
  });

  test('a plain human message is not flagged', () => {
    assert.equal(isNonHumanUserMessage(userMsg('please fix the auth middleware')), false);
  });

  test('empty / malformed messages do not throw', () => {
    assert.equal(isNonHumanUserMessage(undefined), false);
    assert.equal(isNonHumanUserMessage({}), false);
    assert.equal(isNonHumanUserMessage({ info: { role: 'user' } }), false);
  });
});

describe('normalizeTranscriptToMessages carries isMeta', () => {
  // If it did not, isNonHumanUserMessage's isMeta branch would be dead code
  // for the ONLY caller that matters.
  test('top-level isMeta from the raw jsonl record survives onto info.isMeta', () => {
    const raw = [
      { type: 'user', message: { role: 'user', content: 'real task' } },
      { type: 'user', message: { role: 'user', content: 'Stop hook feedback:\nfoo' }, isMeta: true },
    ];
    const msgs = normalizeTranscriptToMessages(raw);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].info.isMeta, false);
    assert.equal(msgs[1].info.isMeta, true);
  });
});

describe('computeTurnKey', () => {
  test('a real human message becomes the turn key', () => {
    const key = computeTurnKey([userMsg('please fix the auth middleware'), assistantMsg('ok')]);
    assert.equal(key, 'please fix the auth middleware');
  });

  test('a foreign Stop hook injection does NOT become the turn key', () => {
    const key = computeTurnKey([
      userMsg('please fix the auth middleware'),
      assistantMsg('done'),
      userMsg(REAL_FOREIGN),
    ]);
    assert.equal(key, 'please fix the auth middleware');
  });

  test('an isMeta:true message does NOT become the turn key even with plain text', () => {
    const key = computeTurnKey([
      userMsg('please fix the auth middleware'),
      assistantMsg('done'),
      userMsg('continue working, do not stop', { info: { isMeta: true } }),
    ]);
    assert.equal(key, 'please fix the auth middleware');
  });

  test('this supervisor own injections are still skipped', () => {
    const key = computeTurnKey([
      userMsg('please fix the auth middleware'),
      assistantMsg('done'),
      userMsg(`${FEEDBACK_MARKER} Task Incomplete (high)\n\nkeep going`),
      userMsg(`${SELF_ASSESSMENT_MARKER}\n{"complete":false}`),
    ]);
    assert.equal(key, 'please fix the auth middleware');
  });

  test('the key does NOT flip across a burst of foreign injections', () => {
    // This is the actual bug: 8 foreign injections in a row used to yield 8
    // different turn keys, each resetting the attempt counter to 0.
    const base = [userMsg('please fix the auth middleware'), assistantMsg('Same. Standing by.')];
    const keys = [];
    for (let i = 0; i < 8; i++) {
      base.push(userMsg(`Stop hook feedback:\nattempt ${i} — keep going`, { top: { isMeta: true } }));
      base.push(assistantMsg('Same. Standing by.'));
      keys.push(computeTurnKey(base));
    }
    assert.deepEqual(new Set(keys).size, 1);
    assert.equal(keys[0], 'please fix the auth middleware');
  });

  test('a NEW genuine human message still flips the key', () => {
    const msgs = [
      userMsg('please fix the auth middleware'),
      assistantMsg('done'),
      userMsg(REAL_FOREIGN, { top: { isMeta: true } }),
      userMsg('now also fix the billing module'),
    ];
    assert.equal(computeTurnKey(msgs), 'now also fix the billing module');
  });

  test('null when nothing genuine is found (contract preserved)', () => {
    assert.equal(computeTurnKey([]), null);
    assert.equal(computeTurnKey(null), null);
    assert.equal(computeTurnKey([assistantMsg('hello')]), null);
    assert.equal(computeTurnKey([userMsg(REAL_FOREIGN, { top: { isMeta: true } })]), null);
    assert.equal(computeTurnKey([userMsg(`${FEEDBACK_MARKER} nope`)]), null);
  });

  test('blank human text is skipped, not returned', () => {
    assert.equal(computeTurnKey([userMsg('   \n  ')]), null);
  });
});
