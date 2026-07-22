import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scoreVerbosity } from '../core/verbosity.mjs';
import {
  selectRowsNeedingLlm,
  shouldSkipForMissingAuth,
} from '../evals/plainspeak-eval.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_SCRIPT = path.join(ROOT, 'evals', 'plainspeak-eval.mjs');
const EXAMPLE_CASES = path.join(ROOT, 'evals', 'verbosity-cases.example.jsonl');

function loadExampleRows() {
  const lines = fs.readFileSync(EXAMPLE_CASES, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l)).map((c) => ({ ...c, scored: scoreVerbosity(c.text) }));
}

test('committed default example corpus is fully deterministic: selectRowsNeedingLlm returns none', () => {
  const rows = loadExampleRows();
  assert.equal(rows.length, 8, 'expected the committed 8-row example fixture');
  const needsLlm = selectRowsNeedingLlm(rows);
  assert.deepEqual(needsLlm, [], 'no row in the shipped example corpus should require an LLM call');
});

test('a structurally-suspect row (no regex hits, long ambiguous prose) DOES require an LLM', () => {
  // Same fixture as test/verbosity.test.mjs's "routes structurally ambiguous
  // long prose to the LLM (needsLlm true) without regex hits" — already
  // verified there to score verdict:'suspect' with zero regex hits.
  const suspectText = `There are a few different ways to think about this problem, and it is worth walking through each of them before settling on a recommendation, since the tradeoffs are not obvious at first glance and depend heavily on how the system evolves over the next several releases.

The first option is to keep the current monolithic service and simply add more caching layers in front of the expensive queries, which would reduce load in the short term but does not really address the underlying architectural coupling that keeps causing incidents whenever a downstream schema changes unexpectedly.

The second option is to split the service into smaller pieces along the existing domain boundaries, which is more work up front and would require coordinating migrations across several teams, but would probably pay for itself within a couple of quarters given how often the coupling issue keeps resurfacing in postmortems.

Given all that, my inclination is toward a middle path, though a final decision really depends on team bandwidth over the next quarter and how leadership wants to prioritize reliability work against new feature commitments.`;
  const scored = scoreVerbosity(suspectText);
  assert.equal(scored.verdict, 'suspect', 'fixture text must score suspect for this test to be meaningful');
  const rows = [{ id: 'x', expected: 'verbose', source: 'synthetic', text: suspectText, scored }];
  const needsLlm = selectRowsNeedingLlm(rows);
  assert.equal(needsLlm.length, 1, 'a suspect-verdict row must require an LLM call in at least one mode');
});

test('shouldSkipForMissingAuth: only skips when rows need an LLM AND there is no auth', () => {
  assert.equal(shouldSkipForMissingAuth(0, false), false, 'deterministic corpus (0 rows need LLM) never skips, even with no auth available');
  assert.equal(shouldSkipForMissingAuth(0, true), false, 'deterministic corpus never skips, auth or not');
  assert.equal(shouldSkipForMissingAuth(2, false), true, 'rows needing an LLM with no auth available must skip safely');
  assert.equal(shouldSkipForMissingAuth(2, true), false, 'rows needing an LLM WITH auth available must proceed');
});

test('node evals/plainspeak-eval.mjs (npm run eval:plainspeak) runs the default corpus to completion without SKIPping', () => {
  const result = spawnSync('node', ['--experimental-strip-types', EVAL_SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /SKIP/, 'the fully deterministic default corpus must never SKIP for missing credentials, on any platform');
  assert.match(result.stdout, /gold recall \(default mode\): 100\.0%/);
});
