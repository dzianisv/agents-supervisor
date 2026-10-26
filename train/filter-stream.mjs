#!/usr/bin/env node
/**
 * filter-cc-stops-stream.mjs — streaming variant of filter-cc-stops.mjs.
 * Required when the raw mining output exceeds Node's 0x1fffffe8 max-string
 * limit (~536MB). Uses readline so memory stays bounded.
 *
 * Same heuristic rules as filter-cc-stops.mjs:
 *   - keep records that LOOK like one of the failure modes (punt / drift / stuck / question)
 *   - drop the rest
 */

import { createReadStream, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { argv, stderr, exit } from 'node:process';

const args = parseArgs(argv.slice(2));
const IN  = args.in  ?? 'evals/datasets/cc-stop-candidates-raw.jsonl';
const OUT = args.out ?? 'evals/datasets/cc-stop-candidates-filtered.jsonl';

const NEXT_STEP_PATTERNS = [
  /\bnext step\b/i,
  /\bnext\s+i('?ll|\s+will)\b/i,
  /\bnow\s+i('?ll|\s+will)\b/i,
  /\bonce\s+(you|that's?)\b.*\bi('?ll|\s+will)\b/is,
  /\bthen\s+i('?ll|\s+will)\b/i,
  /\bafter\s+that\b.*\bi('?ll|\s+will)\b/is,
  /\bwhen\s+you('?re|\s+are)\s+ready\b/i,
  /\b(let me know|tell me|just say)\b.*\b(when|once|if)\b/is,
];

const PUNT_PATTERNS = [
  /\bwould you like (me )?to\b/i,
  /\bshould i\b.*\?/i,
  /\bdo you want (me )?to\b/i,
  /\bshall i\b.*\?/i,
  /\bcan you (tell|let|share|provide|confirm|clarify|give|show)\b.*\?/is,
  /\bplease (provide|share|let me know|tell|confirm)\b/i,
  /\bwhich\s+(one|option|approach|version)\s+do you/i,
  /\bwhat('?s| is)\s+your (preference|choice)\b/i,
];

const SUMMARY_PATTERNS = [
  /\b(i've?|i have)\s+(created|written|added|implemented|built|set up|configured|installed|finished)\b/i,
  /\bhere('?s| is)\s+(a |the |what )/i,
  /\bsummary\s*:/i,
  /\b(done|complete)\s*[.!]?\s*(now|next)\b/i,
  /\bthe (function|file|test|component|module)\s+(is|now)\b/i,
];

function looksLikeStuck(text, sessionTurns) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 500) return false;
  if (sessionTurns < 5) return false;
  if (/\?\s*$/.test(trimmed)) return false;
  return trimmed.length < 300 && sessionTurns >= 8;
}
function looksLikePunt(text, tools) {
  if (!text) return false;
  if (!PUNT_PATTERNS.some((p) => p.test(text))) return false;
  return tools.length >= 3;
}
function looksLikeSummaryDrift(text) {
  if (!text) return false;
  return SUMMARY_PATTERNS.some((p) => p.test(text)) && NEXT_STEP_PATTERNS.some((p) => p.test(text));
}
function looksLikeEndsWithQuestion(text) {
  return !!text && /\?\s*$/.test(text.trim());
}
function classify(rec) {
  const text = rec.final_assistant_text ?? '';
  const tools = rec.tools_available_inferred ?? [];
  const turns = rec.session_total_turns ?? 0;
  const tags = [];
  if (looksLikePunt(text, tools)) tags.push('hint:punt');
  if (looksLikeSummaryDrift(text)) tags.push('hint:summary_drift');
  if (looksLikeStuck(text, turns)) tags.push('hint:stuck');
  if (looksLikeEndsWithQuestion(text)) tags.push('hint:question');
  return tags;
}

const outFd = openSync(OUT, 'w');
const stats = { total: 0, kept: 0, by_tag: {} };

const rl = createInterface({
  input: createReadStream(IN, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line) continue;
  stats.total++;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const tags = classify(rec);
  if (tags.length === 0) continue;
  rec.heuristic_tags = tags;
  writeSync(outFd, JSON.stringify(rec) + '\n');
  stats.kept++;
  for (const t of tags) stats.by_tag[t] = (stats.by_tag[t] ?? 0) + 1;
  if (stats.total % 100 === 0) stderr.write(`  scanned=${stats.total} kept=${stats.kept}\n`);
}
closeSync(outFd);

stderr.write(`\n=== FILTER SUMMARY ===\n`);
stderr.write(`Input  : ${stats.total}\n`);
stderr.write(`Kept   : ${stats.kept}\n`);
stderr.write(`Output : ${OUT}\n\nBy tag:\n`);
for (const [t, n] of Object.entries(stats.by_tag).sort((a, b) => b[1] - a[1])) {
  stderr.write(`  ${t.padEnd(22)} ${n}\n`);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return o;
}
