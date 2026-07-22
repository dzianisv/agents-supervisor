import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripNonProse,
  lint,
  scoreVerbosity,
  buildStylePrompt,
  buildRewriteDirective,
  STYLE_RULES,
} from '../core/verbosity.mjs';

// ---------------------------------------------------------------------------
// Deterministic-rule detection (regex-catchable fluff, per rubric).
// ---------------------------------------------------------------------------

test('filler opener detected', () => {
  const text = `Honestly, the best approach here is to just rewrite the module from scratch instead of patching around the old interfaces because they were never designed for this use case and every fix so far has been a workaround on top of a workaround that adds more surface area for bugs.`;
  const { hits } = lint(text);
  const fillerHits = hits.filter((h) => h.rule === 'filler_opener');
  assert.equal(fillerHits.length, 1);
  assert.match(fillerHits[0].excerpt, /honestly/i);

  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'verbose');
  assert.equal(scored.needsLlm, false);
});

test('qualifier stack detected', () => {
  const text = `The fix is arguably somewhat risky. It seems like a bit of a hack, and it's kind of hard to test properly given the current mocking setup across the integration suite and the way the fixtures are wired together right now.`;
  const { hits, stats } = lint(text);
  const hedgeHits = hits.filter((h) => h.rule === 'hedge');
  assert.ok(hedgeHits.length >= 4, `expected several hedge hits, got ${hedgeHits.length}`);
  assert.equal(stats.hedgeCount, hedgeHits.length);

  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'verbose');
});

test('praise and apology detected', () => {
  const text = `You're right, that's a great point. I apologize for the earlier mistake — my apologies for the confusion. Sorry about that. Here is the corrected function that handles the edge case properly across all the input variations we discussed earlier today.`;
  const { hits } = lint(text);
  assert.ok(hits.some((h) => h.rule === 'praise'), 'expected a praise hit');
  assert.ok(hits.some((h) => h.rule === 'apology'), 'expected an apology hit');

  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'verbose');
});

test('self-narration detected', () => {
  const text = `On second thought, I'd walk that back. Let me reconsider the whole approach here because the earlier plan does not actually hold up once you consider the retry behavior under a network partition and the resulting duplicate side effects it can cause.`;
  const { hits } = lint(text);
  const narrationHits = hits.filter((h) => h.rule === 'self_narration');
  assert.ok(narrationHits.length >= 2, `expected multiple self_narration hits, got ${narrationHits.length}`);

  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'verbose');
});

// ---------------------------------------------------------------------------
// False-positive guards — the whole point of the two constraints below.
// ---------------------------------------------------------------------------

test('long code-heavy reply scores terse — density, not length', () => {
  const text = `Fixed the timeout bug in the retry loop.

\`\`\`js
async function retry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(2 ** i * 100);
    }
  }
}
\`\`\`

Also updated the caller in core/worker.mjs to pass a 5-attempt budget instead of 3, and added a unit test at test/retry.test.mjs covering the exhausted-retries path after three consecutive failures under simulated network partition conditions.

\`\`\`
$ npm test
retry: succeeds after 2 failures
retry: throws after exhausting attempts
2 passing
\`\`\`

Tests pass.`;

  // Sanity check: this fixture is deliberately NOT short — it must clear the
  // short-reply floor and still be judged on the merits, not short-circuited.
  const { stats } = lint(text);
  assert.ok(stats.proseWords >= STYLE_RULES.thresholds.shortReplyWords,
    `fixture must exceed the short-reply floor to actually exercise density scoring (got ${stats.proseWords} words)`);

  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'terse');
  assert.deepEqual(scored.hits, []);
  assert.equal(scored.needsLlm, false);
});

test('short reply exits terse immediately, no LLM call, even with a filler opener', () => {
  const text = `Honestly, looks fine.`;
  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'terse');
  assert.equal(scored.needsLlm, false);
  assert.equal(scored.score, 0);
});

test('genuinely verbose reply (rambling, multiple offenses stacked) scores verbose', () => {
  const text = `Honestly, you're right that this is tricky. Arguably the fix is somewhat risky and it seems kind of hard to validate given the current test setup, but on second thought I'd walk back my earlier suggestion — let me reconsider the whole plan given how the fixtures are wired together across the suite right now.`;
  const scored = scoreVerbosity(text);
  assert.equal(scored.verdict, 'verbose');
  assert.ok(scored.hits.length >= 3, 'expected multiple stacked offenses');
});

// ---------------------------------------------------------------------------
// stripNonProse
// ---------------------------------------------------------------------------

test('stripNonProse removes fenced code blocks and markdown tables', () => {
  const text = `Summary of results:

| name | value |
| --- | --- |
| a | 1 |
| b | 2 |

\`\`\`js
const secretPhraseInCode = "honestly arguably somewhat";
\`\`\`

That is the full breakdown.`;
  const stripped = stripNonProse(text);
  assert.doesNotMatch(stripped, /\|/);
  assert.doesNotMatch(stripped, /secretPhraseInCode/);
  assert.match(stripped, /Summary of results/);
  assert.match(stripped, /That is the full breakdown/);
});

test('stripNonProse removes urls and file paths', () => {
  const text = `See https://example.com/docs and core/judge-core.mjs for details, plus /etc/hosts on the box.`;
  const stripped = stripNonProse(text);
  assert.doesNotMatch(stripped, /https?:\/\//);
  assert.doesNotMatch(stripped, /judge-core\.mjs/);
  assert.doesNotMatch(stripped, /\/etc\/hosts/);
  assert.match(stripped, /See/);
  assert.match(stripped, /for details/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('scoreVerbosity is deterministic: same input produces the same output', () => {
  const text = `Honestly, arguably this whole approach is somewhat flawed and it seems kind of risky given everything discussed so far in this thread about the retry budget and the downstream consumers.`;
  const a = scoreVerbosity(text);
  const b = scoreVerbosity(text);
  assert.deepEqual(a, b);
});

test('scoreVerbosity routes structurally ambiguous long prose to the LLM (needsLlm true) without regex hits', () => {
  const text = `There are a few different ways to think about this problem, and it is worth walking through each of them before settling on a recommendation, since the tradeoffs are not obvious at first glance and depend heavily on how the system evolves over the next several releases.

The first option is to keep the current monolithic service and simply add more caching layers in front of the expensive queries, which would reduce load in the short term but does not really address the underlying architectural coupling that keeps causing incidents whenever a downstream schema changes unexpectedly.

The second option is to split the service into smaller pieces along the existing domain boundaries, which is more work up front and would require coordinating migrations across several teams, but would probably pay for itself within a couple of quarters given how often the coupling issue keeps resurfacing in postmortems.

Given all that, my inclination is toward a middle path, though a final decision really depends on team bandwidth over the next quarter and how leadership wants to prioritize reliability work against new feature commitments.`;
  const scored = scoreVerbosity(text);
  assert.equal(scored.hits.length, 0, 'this fixture must have zero regex hits — the point is regex cannot see the problem');
  assert.equal(scored.verdict, 'suspect');
  assert.equal(scored.needsLlm, true);
});

// ---------------------------------------------------------------------------
// Prompt / directive builders
// ---------------------------------------------------------------------------

test('buildStylePrompt embeds the JSON output contract and known linter findings', () => {
  const text = `Honestly, this seems somewhat fine to me given the earlier discussion.`;
  const lintResult = lint(text);
  const prompt = buildStylePrompt(text, lintResult);
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /"worst_offense"/);
  assert.match(prompt, /"rewrite_directive"/);
  assert.match(prompt, /filler_opener/);
});

test('buildRewriteDirective is surgical: names offenses with excerpts, one instruction, under ~120 words', () => {
  const text = `Honestly, arguably this fix is somewhat risky and it seems kind of untested given how the integration suite is currently wired up across the fixtures and the mocked network layer that the retry logic depends on for its timing assumptions during the failure-injection tests.`;
  const scored = scoreVerbosity(text);
  const directive = buildRewriteDirective(scored);
  assert.match(directive, /^Rewrite\. Offenses:/);
  assert.match(directive, /filler opener/);
  assert.match(directive, /hedges/);
  const wordCount = directive.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount <= 120, `directive too long: ${wordCount} words`);
});

test('buildRewriteDirective returns empty string when there is nothing to fix', () => {
  const scored = { hits: [] };
  assert.equal(buildRewriteDirective(scored), '');
});

test('STYLE_RULES is loaded from core/style-rules.json with a thresholds object and rule corpus', () => {
  assert.ok(STYLE_RULES.thresholds);
  assert.ok(Array.isArray(STYLE_RULES.rules) && STYLE_RULES.rules.length > 0);
  for (const rule of STYLE_RULES.rules) {
    assert.ok(rule.id && rule.severity && Array.isArray(rule.patterns) && rule.corrective);
  }
});
