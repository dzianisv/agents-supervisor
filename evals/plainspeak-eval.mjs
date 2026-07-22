#!/usr/bin/env node
/**
 * plainspeak-eval.mjs — score the plainspeak detector (core/verbosity.mjs +
 * the plainspeak Stop hook's own LLM-routing decision). Default cases are a
 * small committed synthetic set (evals/verbosity-cases.example.jsonl, 8 rows,
 * offline/deterministic, no LLM calls needed); point --cases at the private
 * mined corpus (evals/verbosity-cases.jsonl, gitignored, not shipped) to
 * reproduce the real 200-row/16-gold-row numbers documented in README.md.
 *
 * Reports precision/recall/F1 for the 'verbose' class two ways:
 *   - overall, across all rows in the cases file (200 in the private corpus)
 *   - on the gold `source:"human_complaint"` rows only (16 in the private
 *     corpus — the subset that matters, a real human style complaint
 *     followed that exact reply)
 *
 * Scores TWO routing modes side by side, because they trade recall for LLM
 * call volume and the brief's own literal hook spec and its own calibration
 * warning point in different directions on this corpus (see README.md
 * "Plainspeak" section and bin/plainspeak-on-stop.mjs's shouldCallLlm doc):
 *   - default: skip the LLM only below core/verbosity.mjs's hard short-reply
 *     floor (shortReplyWords prose words). Ships as the hook's default.
 *   - strict:  skip the LLM on ANY scoreVerbosity 'terse' verdict — the
 *     literal "on terse, exit 0, no LLM call" reading of the hook spec.
 *     Opt in via PLAINSPEAK_STRICT_TERSE_EXIT=1.
 *
 * Needs Claude Code OAuth or ANTHROPIC_API_KEY. With no creds it SKIPs
 * (exit 0) so CI without secrets stays green; set SUPERVISOR_EVAL_REQUIRE=1
 * to fail-on-skip instead.
 *
 * Usage: node evals/plainspeak-eval.mjs [--cases <file.jsonl>] [--threshold 0.5] [--concurrency 8]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAnthropic } from '../core/llm-client.mjs';
import { scoreVerbosity, buildStylePrompt, STYLE_RULES } from '../core/verbosity.mjs';
import { parseSelfAssessmentJson } from '../core/assessment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const casesFile = arg('cases', path.join(HERE, 'verbosity-cases.example.jsonl'));
const threshold = parseFloat(arg('threshold', '0.5')); // gold-recall floor, default mode
const concurrency = parseInt(arg('concurrency', '8'), 10);
const requireCreds = process.env.SUPERVISOR_EVAL_REQUIRE === '1';
const MODEL = process.env.PLAINSPEAK_MODEL || 'claude-haiku-4-5-20251001';

function hasAuth() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const p = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    if (fs.existsSync(p)) return true;
  } catch { /* */ }
  return process.platform === 'darwin';
}

// --- routing: mirrors bin/plainspeak-on-stop.mjs's shouldCallLlm exactly, ---
// --- for both modes at once (see file header for why both are measured). ---
const SHORT_REPLY_FLOOR = STYLE_RULES?.thresholds?.shortReplyWords ?? 40;

function needsLlmDefault(scored) {
  if (scored.verdict === 'verbose') return false;
  if (scored.verdict === 'suspect') return true;
  return scored.stats.proseWords >= SHORT_REPLY_FLOOR;
}

function needsLlmStrict(scored) {
  if (scored.verdict === 'verbose') return false;
  return scored.verdict === 'suspect';
}

function isConfirmedVerbose(scored, llmJudge) {
  if (scored.verdict === 'verbose') return true;
  if (scored.verdict === 'suspect' || llmJudge != null) return llmJudge?.verdict === 'verbose';
  return false;
}

// --- tiny concurrency-limited async pool ------------------------------------
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

async function judge(text, scored) {
  try {
    const prompt = buildStylePrompt(text, scored);
    const result = await callAnthropic({
      prompt,
      system: 'You are a strict, terse plain-English style judge. Output JSON only.',
      model: MODEL,
      maxTokens: 300,
      timeoutMs: 15_000,
    });
    const parsed = parseSelfAssessmentJson(result.text);
    if (!parsed || (parsed.verdict !== 'terse' && parsed.verdict !== 'verbose')) return null;
    return parsed;
  } catch {
    return null; // fail open, same as the hook — an unreachable judge is not evidence of anything
  }
}

function confusionMetrics(rows, predKey, label) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const pred = r[predKey] === 'verbose';
    const gold = r.expected === 'verbose';
    if (pred && gold) tp++;
    else if (pred && !gold) fp++;
    else if (!pred && gold) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { label, n: rows.length, tp, fp, fn, tn, precision, recall, f1 };
}

function printMetrics(m) {
  console.log(
    `${m.label.padEnd(28)} n=${String(m.n).padEnd(4)} tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn}  `
    + `precision=${(m.precision * 100).toFixed(1)}%  recall=${(m.recall * 100).toFixed(1)}%  f1=${(m.f1 * 100).toFixed(1)}%`,
  );
}

async function main() {
  if (!hasAuth()) {
    const msg = 'plainspeak-eval: no Claude/Anthropic credentials — SKIP.';
    if (requireCreds) { console.error(msg + ' (SUPERVISOR_EVAL_REQUIRE=1 -> fail)'); process.exit(1); }
    console.log(msg);
    process.exit(0);
  }

  let cases;
  try {
    cases = fs.readFileSync(casesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    console.error(`plainspeak-eval: cannot read cases file ${casesFile}: ${e.message}`);
    process.exit(1);
  }

  const rows = cases.map((c) => ({ ...c, scored: scoreVerbosity(c.text) }));

  // One LLM call per row that either mode needs — cache and reuse for both.
  const needsAny = rows.filter((r) => needsLlmDefault(r.scored) || needsLlmStrict(r.scored));
  console.log(`plainspeak-eval: ${cases.length} rows, ${needsAny.length} need an LLM call in at least one mode (model=${MODEL}, concurrency=${concurrency})...`);
  await runPool(needsAny, concurrency, async (r) => {
    r.llmJudge = await judge(r.text, r.scored);
  });

  for (const r of rows) {
    const llmDefault = needsLlmDefault(r.scored) ? r.llmJudge : null;
    const llmStrict = needsLlmStrict(r.scored) ? r.llmJudge : null;
    r.predDefault = isConfirmedVerbose(r.scored, llmDefault) ? 'verbose' : 'terse';
    r.predStrict = isConfirmedVerbose(r.scored, llmStrict) ? 'verbose' : 'terse';
  }

  const gold = rows.filter((r) => r.source === 'human_complaint');

  console.log('\n# plainspeak-eval\n');
  console.log('## default mode (shipped): LLM call skipped only below the hard short-reply word floor');
  printMetrics(confusionMetrics(rows, 'predDefault', 'overall'));
  printMetrics(confusionMetrics(gold, 'predDefault', 'gold human_complaint'));

  console.log('\n## strict mode (PLAINSPEAK_STRICT_TERSE_EXIT=1): LLM call skipped on any terse verdict');
  printMetrics(confusionMetrics(rows, 'predStrict', 'overall'));
  printMetrics(confusionMetrics(gold, 'predStrict', 'gold human_complaint'));

  const goldDefaultMetrics = confusionMetrics(gold, 'predDefault', 'gold');
  console.log(`\ngold recall (default mode): ${(goldDefaultMetrics.recall * 100).toFixed(1)}%  (threshold ${(threshold * 100).toFixed(0)}%)`);

  const misses = gold.filter((r) => r.predDefault !== 'verbose');
  if (misses.length) {
    console.log(`\nmissed gold rows (default mode): ${misses.map((r) => r.id).join(', ')}`);
  }

  process.exit(goldDefaultMetrics.recall >= threshold ? 0 : 1);
}

main();
