import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShipped, deepMerge } from '../core/patterns.mjs';
import { buildPrompt, CATEGORY_NAMES } from '../core/judge-core.mjs';
import { buildFeedback, injectCategories } from '../core/feedback-core.mjs';

const shipped = loadShipped();

test('shipped patterns: 6 categories, correct inject set', () => {
  assert.deepEqual(CATEGORY_NAMES(shipped), [
    'complete', 'waiting_for_user_legitimate', 'tool_available_punt',
    'summary_drift_stop', 'genuinely_stuck', 'working',
  ]);
  assert.deepEqual([...injectCategories(shipped)].sort(),
    ['genuinely_stuck', 'summary_drift_stop', 'tool_available_punt', 'verification_deferral']);
});

test('deepMerge: objects merge, arrays/scalars replace', () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], n: 5 };
  const over = { a: { y: 9 }, list: [3], n: 7 };
  assert.deepEqual(deepMerge(base, over), { a: { x: 1, y: 9 }, list: [3], n: 7 });
});

test('user override deep-merges over shipped (e.g. raise max attempts)', () => {
  const merged = deepMerge(shipped, { feedback: { max_inject_attempt: 5 } });
  assert.equal(merged.feedback.max_inject_attempt, 5);
  // categories preserved
  assert.equal(merged.categories.length, shipped.categories.length);
});

test('buildPrompt includes categories, antipatterns, and the I/O contract', () => {
  const ctx = {
    user_messages: ['add dark mode'],
    final_assistant_text: 'I created the file. Next step: run the tests.',
    tools_available_inferred: ['Bash', 'Edit'],
  };
  const p = buildPrompt(ctx, shipped);
  assert.match(p, /PERMISSION-SEEKING/);
  assert.match(p, /STOPPED-WITH-TODOS/);
  assert.match(p, /summary_drift_stop/);
  assert.match(p, /add dark mode/);
  assert.match(p, /Bash, Edit/);
  assert.match(p, /JSON object on a single line/);
});

test('feedback: injecting categories produce a message, with placeholder fill', () => {
  const ctx = { final_assistant_text: 'Next step: run the tests.', tools_available_inferred: ['Bash'] };
  const drift = buildFeedback('summary_drift_stop', ctx, 1, shipped);
  assert.equal(drift.shouldInject, true);
  assert.match(drift.additionalContext, /run the tests/); // stepClause filled
  const punt = buildFeedback('tool_available_punt', ctx, 1, shipped);
  assert.match(punt.additionalContext, /Bash/); // toolList filled
});

test('feedback: escalation across attempts then cap', () => {
  const ctx = { final_assistant_text: '', tools_available_inferred: [] };
  const a1 = buildFeedback('genuinely_stuck', ctx, 1, shipped);
  const a2 = buildFeedback('genuinely_stuck', ctx, 2, shipped);
  const a3 = buildFeedback('genuinely_stuck', ctx, 3, shipped);
  assert.ok(a1.shouldInject && a2.shouldInject && a3.shouldInject);
  assert.notEqual(a1.additionalContext, a2.additionalContext);
  const a4 = buildFeedback('genuinely_stuck', ctx, 4, shipped);
  assert.equal(a4.shouldInject, false); // past max_inject_attempt
});

test('feedback: non-injecting categories never inject', () => {
  for (const cat of ['complete', 'waiting_for_user_legitimate', 'working', 'TIMEOUT', 'PARSE_ERROR', 'API_ERROR']) {
    assert.equal(buildFeedback(cat, {}, 1, shipped).shouldInject, false, cat);
  }
});
