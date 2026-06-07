/**
 * derive.mjs — pure derivation of refreshed patterns from a mined summary.
 * No I/O; unit-testable. Used by update_patterns.mjs.
 */

export function pct(part, total) {
  if (!total) return null;
  return Math.round((100 * part) / total);
}

/**
 * @param {object} patterns - base (effective) patterns to refine (mutated copy returned)
 * @param {object} summary  - build_dataset.py summary.json
 * @returns {{ patterns: object, changes: string[], before: object }}
 */
export function derivePatterns(patterns, summary) {
  const p = JSON.parse(JSON.stringify(patterns)); // don't mutate caller's object
  const apCounts = summary.antipattern_stop_type_counts ?? {};
  const apTotal = summary.antipattern_examples ?? Object.values(apCounts).reduce((a, b) => a + b, 0);

  const permission = (apCounts.asked_question ?? 0) + (apCounts.verification_deferral ?? 0);
  const todos = (apCounts.stopped_with_todos ?? 0) + (apCounts.stopped_with_todos_and_question ?? 0);

  p.meta = p.meta ?? {};
  const before = { dataset_size: p.meta.dataset_size, premature_pct: p.meta.premature_pct };
  if (summary.total_examples != null) p.meta.dataset_size = summary.total_examples;
  if (summary.premature_pct != null) p.meta.premature_pct = summary.premature_pct;
  p.meta.source = 'mined from your local sessions (agent stop → user follow-up)';

  const newWeights = { permission_seeking: pct(permission, apTotal), stopped_with_todos: pct(todos, apTotal) };
  const changes = [];
  for (const apat of p.antipatterns ?? []) {
    const w = newWeights[apat.name];
    if (w != null && Number.isFinite(w)) {
      if (apat.weight_pct !== w) changes.push(`${apat.name}: ${apat.weight_pct ?? '—'}% → ${w}%`);
      apat.weight_pct = w;
    }
  }
  return { patterns: p, changes, before };
}

/** Structural sanity check before writing learned patterns. */
export function validatePatterns(p) {
  const cats = p?.categories;
  return Array.isArray(cats) && cats.length >= 4 && !!p?.feedback?.templates;
}
