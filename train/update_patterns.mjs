#!/usr/bin/env node
/**
 * update_patterns.mjs — derive refreshed patterns/anti-patterns from a mined
 * dataset summary and write them to the USER-LOCAL patterns file.
 *
 * Reads:  .dataset/_analysis/summary.json  (from build_dataset.py)
 * Writes: ~/.config/agents-supervisor/patterns.json  (or project scope)
 *         — never the shipped defaults, never git.
 *
 * Usage:
 *   node train/update_patterns.mjs [--summary <path>] [--scope user|project]
 *                                  [--dry-run] [--cwd <dir>]
 *
 * Derivation (data-driven, from heuristic stop_type distribution among the
 * antipattern examples — agent stopped AND user told it to continue/corrected):
 *   permission_seeking.weight_pct ← (asked_question + verification_deferral)
 *   stopped_with_todos.weight_pct ← (stopped_with_todos + *_and_question)
 *   meta.dataset_size  ← total_examples
 *   meta.premature_pct ← premature_pct
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadPatterns, writeUserPatterns } from '../core/patterns.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const cwd = arg('cwd', process.cwd());
const scope = arg('scope', 'user');
const dryRun = hasFlag('dry-run');
const summaryPath = arg('summary', path.join(cwd, '.dataset', '_analysis', 'summary.json'));

function pct(part, total) {
  if (!total) return null;
  return Math.round((100 * part) / total);
}

function main() {
  if (!fs.existsSync(summaryPath)) {
    console.error(`update_patterns: no summary at ${summaryPath} — run build_dataset.py first.`);
    process.exit(2);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const apCounts = summary.antipattern_stop_type_counts ?? {};
  const apTotal = summary.antipattern_examples ?? Object.values(apCounts).reduce((a, b) => a + b, 0);

  const permission = (apCounts.asked_question ?? 0) + (apCounts.verification_deferral ?? 0);
  const todos = (apCounts.stopped_with_todos ?? 0) + (apCounts.stopped_with_todos_and_question ?? 0);

  const patterns = loadPatterns({ cwd });

  // Update meta provenance from observed data.
  patterns.meta = patterns.meta ?? {};
  const before = { dataset_size: patterns.meta.dataset_size, premature_pct: patterns.meta.premature_pct };
  patterns.meta.dataset_size = summary.total_examples ?? patterns.meta.dataset_size;
  patterns.meta.premature_pct = summary.premature_pct ?? patterns.meta.premature_pct;
  patterns.meta.source = 'mined from your local sessions (agent stop → user follow-up)';
  patterns.meta.last_trained = new Date().toISOString().slice(0, 10);

  // Update tracked anti-pattern weights from observed distribution.
  const newWeights = {
    permission_seeking: pct(permission, apTotal),
    stopped_with_todos: pct(todos, apTotal),
  };
  const changes = [];
  for (const apat of patterns.antipatterns ?? []) {
    const w = newWeights[apat.name];
    if (w != null && Number.isFinite(w)) {
      if (apat.weight_pct !== w) changes.push(`${apat.name}: ${apat.weight_pct ?? '—'}% → ${w}%`);
      apat.weight_pct = w;
    }
  }

  console.log('# supervisor:train — pattern update');
  console.log(`sessions scanned : ${summary.sessions_written}`);
  console.log(`stop/follow-up pairs : ${summary.total_examples}`);
  console.log(`antipattern (premature) : ${apTotal} (${summary.premature_pct}%)`);
  console.log(`provenance : dataset_size ${before.dataset_size ?? '—'} → ${patterns.meta.dataset_size}, premature ${before.premature_pct ?? '—'}% → ${patterns.meta.premature_pct}%`);
  console.log('weight changes :');
  if (changes.length === 0) console.log('  (none — observed distribution matches current weights)');
  else changes.forEach((c) => console.log(`  ${c}`));

  // Structural validation before writing.
  const cats = patterns.categories ?? [];
  const ok = Array.isArray(cats) && cats.length >= 4 && (patterns.feedback?.templates);
  if (!ok) {
    console.error('update_patterns: derived patterns failed structural validation — NOT writing.');
    process.exit(3);
  }

  if (dryRun) {
    console.log('\n[dry-run] user-local patterns NOT written.');
    return;
  }

  const { path: outPath, backup } = writeUserPatterns(patterns, { scope, cwd });
  console.log(`\nwrote ${outPath}${backup ? ` (backup: ${backup})` : ''}`);
  console.log(`revert with: ${backup ? `mv "${backup}" "${outPath}"` : `rm "${outPath}"`}`);
}

main();
