#!/usr/bin/env node
/**
 * judge-eval.mjs — score the shared judge (core/judge-core.mjs) against a labeled
 * case set. Used for both runtimes (the judge is shared). Default cases are the
 * committed synthetic set (evals/cases.example.jsonl); point --cases at a private
 * gold file (e.g. a HuggingFace export) for a real measurement.
 *
 * Needs Claude Code OAuth or ANTHROPIC_API_KEY. With no creds it SKIPs (exit 0)
 * so CI without secrets stays green; set SUPERVISOR_EVAL_REQUIRE=1 to fail-on-skip.
 *
 * Usage: node evals/judge-eval.mjs [--cases <file.jsonl>] [--threshold 0.8]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyStop } from '../core/judge-core.mjs';
import { loadPatterns } from '../core/patterns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const casesFile = arg('cases', path.join(HERE, 'cases.example.jsonl'));
const threshold = parseFloat(arg('threshold', '0.8'));
const requireCreds = process.env.SUPERVISOR_EVAL_REQUIRE === '1';

function hasAuth() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const p = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    if (fs.existsSync(p)) return true;
  } catch { /* */ }
  // macOS keychain check is best-effort; let classifyStop throw if absent.
  return process.platform === 'darwin';
}

async function main() {
  if (!hasAuth()) {
    const msg = 'judge-eval: no Claude/Anthropic credentials — SKIP.';
    if (requireCreds) { console.error(msg + ' (SUPERVISOR_EVAL_REQUIRE=1 → fail)'); process.exit(1); }
    console.log(msg); process.exit(0);
  }

  const cases = fs.readFileSync(casesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const patterns = loadPatterns();
  let correct = 0;
  const rows = [];
  for (const c of cases) {
    let got;
    try {
      const v = await classifyStop(c.ctx, { patterns });
      got = v.category;
    } catch (e) {
      got = `ERROR(${String(e.message).slice(0, 40)})`;
    }
    const ok = got === c.expected;
    if (ok) correct++;
    rows.push({ name: c.name, expected: c.expected, got, ok });
  }

  console.log('# judge-eval\n');
  for (const r of rows) console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(22)} expected=${r.expected.padEnd(28)} got=${r.got}`);
  const acc = correct / cases.length;
  console.log(`\naccuracy: ${correct}/${cases.length} = ${(acc * 100).toFixed(1)}%  (threshold ${(threshold * 100).toFixed(0)}%)`);
  process.exit(acc >= threshold ? 0 : 1);
}

main();
