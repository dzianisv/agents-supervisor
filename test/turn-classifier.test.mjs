/**
 * turn-classifier.test.mjs — table-driven coverage of the non-actionable gate.
 *
 * The bias is deliberate and asymmetric: a false SKIP (missing real work) is a
 * supervision hole; a false RUN (one extra reflection) is merely noise. So the
 * NEGATIVE table below — turns that MUST still be supervised — is the important
 * half, and it includes the tricky near-misses ("why did you stop working on
 * the parser?", "stop the dev server and restart it").
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTurn, isNonActionableTurn, shouldSkipReflection, NON_ACTIONABLE_MAX_LEN, isSupervisorControlTurn } from '../core/turn-classifier.mjs';

// Turns the supervisor must NOT judge for completion.
const NON_ACTIONABLE = [
  ['thanks', 'acknowledgement'],
  ['thank you!', 'acknowledgement'],
  ['ok', 'acknowledgement'],
  ['lgtm', 'acknowledgement'],
  ['got it', 'acknowledgement'],
  ['tldr', 'summary'],
  ['tl;dr', 'summary'],
  ['recap please', 'summary'],
  ['give me a summary', 'summary'],
  ['summarize what we did', 'summary'],
  ['Stop.', 'stop'],
  // Real case: OpenClawBot ses_06cde9dddffeI2A11kMn5eiUCO — the supervisor
  // answered this with "run the prod canary and flip the feature flag".
  ['Stop. Reflect. What is wrong with you. Why feature is not delivered in 2 days?', 'stop'],
  // Real case: vibebrowser ses_06f9582cbffesLXyB1eOJWYwZ9 — answered with a
  // 6-item mandatory-GOAL missing list.
  ['why did you stop . answer short', 'meta_question'],
  ['why did you stop', 'meta_question'],
  ['what is wrong with you?', 'meta_question'],
  ['are you stuck?', 'meta_question'],
  ['I think this is opencode plugin?', 'meta_question'],
  ['should we use postgres or mysql?', 'question'],
  ['', 'empty'],
  ['   ', 'empty'],
];

// Turns that ARE work requests and must still be supervised.
const ACTIONABLE = [
  'fix the broken tests',
  // The tricky one: reads like the meta-question above, but names real work.
  'why did you stop working on the parser?',
  'stop the dev server and restart it on port 3001',
  'thanks — now add a test for the null case',
  'ok, ship it',
  'summarize the docs into README.md',
  'tldr the design doc into docs/DESIGN.md',
  'can you check why CI is red?',
  'recap and then open the PR',
  'status of the deploy? run gh pr checks',
  'why is the build failing?',
  'open the PR, run the full next build, and proceed to deploy. Report PR link + deploy status.',
  'implement the retry backoff',
  'for Max clients*',
  'deploy to staging',
  `please ${'do the following carefully: '.repeat(20)}`, // long spec — over the length escape
];

describe('classifyTurn: non-actionable turns', () => {
  for (const [text, expected] of NON_ACTIONABLE) {
    test(`skips: ${JSON.stringify(text)}`, () => {
      const result = classifyTurn(text);
      assert.equal(result.actionable, false, `expected non-actionable, got ${JSON.stringify(result)}`);
      assert.equal(result.category, expected);
      assert.equal(isNonActionableTurn(text), true);
    });
  }
});

describe('classifyTurn: actionable turns (false skips are the dangerous failure)', () => {
  for (const text of ACTIONABLE) {
    test(`supervises: ${JSON.stringify(text.slice(0, 60))}`, () => {
      const result = classifyTurn(text);
      assert.equal(result.actionable, true, `expected actionable, got ${JSON.stringify(result)}`);
      assert.equal(isNonActionableTurn(text), false);
    });
  }
});

describe('classifyTurn: escapes', () => {
  test('anything over the length ceiling is actionable regardless of wording', () => {
    const chatty = `thanks ${'and also some more context '.repeat(40)}`;
    assert.ok(chatty.length > NON_ACTIONABLE_MAX_LEN);
    assert.equal(classifyTurn(chatty).actionable, true);
  });

  test('naming a file makes an otherwise chatty turn actionable', () => {
    assert.equal(classifyTurn('tldr src/parser.ts').actionable, true);
  });

  test('naming an issue number makes it actionable', () => {
    assert.equal(classifyTurn('what about #42?').actionable, true);
  });

  test('a backticked identifier makes it actionable', () => {
    assert.equal(classifyTurn('why `parseRubric`?').actionable, true);
  });

  test('non-string input is treated as empty, not as work', () => {
    assert.equal(classifyTurn(undefined).category, 'empty');
    assert.equal(classifyTurn(null).category, 'empty');
    assert.equal(classifyTurn(42).category, 'empty');
  });
});

describe('shouldSkipReflection', () => {
  test('skips a non-actionable turn', () => {
    const r = shouldSkipReflection({ text: 'thanks' });
    assert.equal(r.skip, true);
    assert.match(r.reason, /non-actionable/);
  });

  test('never skips an actionable turn', () => {
    assert.equal(shouldSkipReflection({ text: 'fix the parser' }).skip, false);
  });

  test('ESCAPE HATCH: an active goal keeps supervising even on "thanks"', () => {
    const r = shouldSkipReflection({ text: 'thanks', hasActiveGoal: true });
    assert.equal(r.skip, false);
    assert.equal(r.reason, 'active-goal');
  });

  test('ESCAPE HATCH: autopilot mode is never skipped', () => {
    assert.equal(shouldSkipReflection({ text: 'tldr', mode: 'autopilot' }).skip, false);
  });

  test('ESCAPE HATCH: goal mode is never skipped', () => {
    assert.equal(shouldSkipReflection({ text: 'tldr', mode: 'goal' }).skip, false);
  });

  test('reflection mode with no goal follows the classifier', () => {
    assert.equal(shouldSkipReflection({ text: 'tldr', mode: 'reflection' }).skip, true);
  });

  test('missing args are safe', () => {
    assert.equal(shouldSkipReflection().skip, true); // empty text -> nothing to judge
    assert.equal(shouldSkipReflection({}).skip, true);
  });
});

// ---------------------------------------------------------------------------
// Supervisor CONTROL commands are never work — in ANY mode.
//
// This rule is checked BEFORE the goal/autopilot escape hatches, which is the
// opposite of every other rule in this file. Reason: with a real per-turn
// attempt budget, autopilot nudging its own `/supervisor autopilot` command
// turn burns the whole budget in seconds and the exhaustion path then disarms
// autopilot — i.e. the command turns itself off before the user types a task.
// ---------------------------------------------------------------------------

test('supervisor control commands are skipped even in autopilot/goal mode and with an active goal', () => {
  const commands = [
    '/supervisor autopilot',
    '/supervisor retry 5',
    '/supervisor set-goal all tests pass',
    '/supervisor:status off',
    '/supervisor off',
    'supervisor status',
    '/autopilot',
  ];
  for (const text of commands) {
    for (const opts of [
      { mode: 'autopilot' },
      { mode: 'goal' },
      { hasActiveGoal: true },
      { mode: 'reflection' },
    ]) {
      const r = shouldSkipReflection({ text, ...opts });
      assert.equal(r.skip, true, `"${text}" with ${JSON.stringify(opts)} must be skipped, got ${JSON.stringify(r)}`);
      assert.equal(r.reason, 'supervisor-control-command');
    }
  }
});

test('a control command EMBEDDED in a real request stays actionable', () => {
  // Deliberately narrow: only a whole-message command is a control turn.
  const embedded = [
    'run /supervisor retry 3 and then fix the failing build in src/app.ts',
    'why does /supervisor off not persist? investigate core/session-store.mjs',
  ];
  for (const text of embedded) {
    assert.equal(shouldSkipReflection({ text }).skip, false, `"${text}" must stay actionable`);
  }
});

test('isSupervisorControlTurn tolerates junk input', () => {
  for (const v of [undefined, null, 42, {}, '', '   ']) {
    assert.equal(isSupervisorControlTurn(v), false);
  }
});
