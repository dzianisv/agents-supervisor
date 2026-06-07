import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShipped } from '../core/patterns.mjs';
import { pct, derivePatterns, validatePatterns } from '../train/derive.mjs';

test('pct: rounds, guards zero total', () => {
  assert.equal(pct(1, 4), 25);
  assert.equal(pct(1, 3), 33);
  assert.equal(pct(5, 0), null);
});

test('derivePatterns: recomputes weights from antipattern stop_type distribution', () => {
  const base = loadShipped();
  const summary = {
    sessions_written: 10,
    total_examples: 400,
    antipattern_examples: 100,
    premature_pct: 25,
    antipattern_stop_type_counts: {
      asked_question: 30,
      verification_deferral: 10, // permission_seeking = 40 -> 40%
      stopped_with_todos: 45,
      stopped_with_todos_and_question: 5, // todos = 50 -> 50%
    },
  };
  const { patterns, changes, before } = derivePatterns(base, summary);
  const byName = Object.fromEntries(patterns.antipatterns.map((a) => [a.name, a.weight_pct]));
  assert.equal(byName.permission_seeking, 40);
  assert.equal(byName.stopped_with_todos, 50);
  assert.equal(patterns.meta.dataset_size, 400);
  assert.equal(patterns.meta.premature_pct, 25);
  assert.equal(before.dataset_size, 227); // shipped provenance preserved as "before"
  assert.ok(changes.some((c) => c.includes('stopped_with_todos'))); // 30% -> 50% recorded
});

test('derivePatterns: does not mutate the input patterns', () => {
  const base = loadShipped();
  const snapshot = JSON.stringify(base);
  derivePatterns(base, { antipattern_examples: 10, antipattern_stop_type_counts: { asked_question: 10 }, total_examples: 10, premature_pct: 100 });
  assert.equal(JSON.stringify(base), snapshot);
});

test('validatePatterns: accepts shipped, rejects malformed', () => {
  assert.equal(validatePatterns(loadShipped()), true);
  assert.equal(validatePatterns({ categories: [] }), false);
  assert.equal(validatePatterns({ categories: [1, 2, 3, 4] }), false); // no feedback.templates
});
