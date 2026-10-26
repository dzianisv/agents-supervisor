#!/usr/bin/env node
/**
 * classify-with-supervisor-v3.mjs — bulk-classify a JSONL stop-candidates file
 * using the agents-supervisor v3 judge (closing-delivery + capability-offer +
 * imperative-guidance discriminators + 20 few-shots).
 *
 * Reads from cc-stop-candidates-filtered.jsonl or oc-stop-candidates-raw.jsonl
 * style records: { user_messages, final_assistant_text, tools_available_inferred }
 * and emits the same records + { classification: { category, confidence, reason } }.
 *
 * Auth: OAuth Bearer from ~/.claude/.credentials.json (no API key needed).
 * Resume-safe: appends one line per record, skips ones already in --out.
 *
 * Usage:
 *   node classify-with-supervisor-v3.mjs --in evals/datasets/foo.jsonl \
 *     --out evals/datasets/foo-classified-v3.jsonl [--concurrency 4]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { argv, stderr } from 'node:process';
import { classifyStop } from '../core/judge-core.mjs';
import { loadPatterns } from '../core/patterns.mjs';

const args = parseArgs(argv.slice(2));
const IN = args.in;
const OUT = args.out;
const CONC = parseInt(args.concurrency ?? '4', 10);
if (!IN || !OUT) {
  stderr.write('ERROR: --in and --out required\n');
  process.exit(1);
}

const patterns = loadPatterns();
stderr.write(`patterns: ${patterns.categories?.length} categories, ${patterns.antipatterns?.length} antipatterns, ${patterns.few_shots?.length ?? 0} few-shots\n`);

// Resume support: skip records already classified
const doneKeys = new Set();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(l);
      doneKeys.add(`${r.project_slug ?? ''}/${r.session_id ?? ''}/${r.stop_index ?? ''}`);
    } catch { /* skip */ }
  }
  stderr.write(`resume: ${doneKeys.size} already done\n`);
}

const lines = readFileSync(IN, 'utf8').split('\n').filter(Boolean);
const records = lines.map((l) => JSON.parse(l)).filter(
  (r) => !doneKeys.has(`${r.project_slug ?? ''}/${r.session_id ?? ''}/${r.stop_index ?? ''}`),
);
stderr.write(`to classify: ${records.length}\n`);

let done = 0;
let errors = 0;

async function worker(start) {
  for (let i = start; i < records.length; i += CONC) {
    const r = records[i];
    const ctx = {
      user_messages: r.user_messages ?? [],
      final_assistant_text: r.final_assistant_text ?? '',
      tools_available_inferred: r.tools_available_inferred ?? [],
    };
    let cls;
    try {
      cls = await classifyStop(ctx, { patterns });
    } catch (err) {
      cls = { category: 'ERROR', reason: String(err.message ?? err).slice(0, 200), confidence: 0 };
      errors++;
    }
    const out = { ...r, classification: cls };
    // Strip raw_text if present to keep output compact
    if (out.classification?.raw_text) delete out.classification.raw_text;
    appendFileSync(OUT, JSON.stringify(out) + '\n');
    done++;
    if (done % 25 === 0) stderr.write(`  [${done}/${records.length}] errors=${errors}\n`);
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, records.length) }, (_, k) => worker(k)));
stderr.write(`\ndone: ${done} classified, ${errors} errors\n`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
