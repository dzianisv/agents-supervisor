/**
 * Plainspeak on the opencode runtime.
 *
 * The deterministic style detector (core/verbosity.mjs) already shipped for
 * Claude Code via bin/plainspeak-on-stop.mjs. This file covers wiring it into
 * the opencode plugin:
 *
 *   - the default-ON, off-only `plainspeak` flag (mirrors `statusDiagram`),
 *   - `goalStore.setPlainspeak` round-tripping through the ONE session store
 *     without clobbering a neighbouring key,
 *   - the injected message shape (marker first, empty result = no injection),
 *   - and SOURCE-LEVEL pins on the three suppressions that make the feature
 *     safe: autopilot, an active goal, and the one-rewrite-per-turn guard.
 *
 * The source pins exist because those three lines have no unit-testable seam
 * (they live inside the session.idle closure) and deleting any one of them is
 * silent: autopilot would get nagged mid-work, a goal turn would get a style
 * chore instead of progress, and the turn guard is the ONLY termination proof
 * plainspeak has.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { goalStore, isPlainspeakEnabled, isStatusDiagramEnabled } from '../core/goal.mjs';
import { sessionStore } from '../core/session-store.mjs';
import { buildRewriteDirective, scoreVerbosity } from '../core/verbosity.mjs';
import { PLAINSPEAK_MARKER } from '../opencode/supervisor-impl.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPL = readFileSync(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf8');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'plainspeak-oc-'));
}

// ---------------------------------------------------------------------------
// 1. Default-ON, off-only flag.
// ---------------------------------------------------------------------------

describe('isPlainspeakEnabled — absent means ON', () => {
  test('undefined state is ON', () => {
    assert.equal(isPlainspeakEnabled(undefined), true);
    assert.equal(isPlainspeakEnabled(null), true);
  });

  test('a state that never touched the key is ON', () => {
    assert.equal(isPlainspeakEnabled({}), true);
    assert.equal(isPlainspeakEnabled({ plainspeak: undefined }), true);
  });

  test('explicit true is ON', () => {
    assert.equal(isPlainspeakEnabled({ plainspeak: true }), true);
  });

  test('ONLY an explicit false disables it', () => {
    assert.equal(isPlainspeakEnabled({ plainspeak: false }), false);
  });

  test('falsy-but-not-false values do NOT disable it (no bare truthiness)', () => {
    // A bare `if (state.plainspeak)` would read every one of these as OFF.
    assert.equal(isPlainspeakEnabled({ plainspeak: 0 }), true);
    assert.equal(isPlainspeakEnabled({ plainspeak: '' }), true);
  });
});

// ---------------------------------------------------------------------------
// 2. setPlainspeak round-trips and does not clobber neighbours.
// ---------------------------------------------------------------------------

describe('goalStore.setPlainspeak', () => {
  test('round-trips through sessionStore', () => {
    const dir = tmp();
    try {
      const sid = 'ses_plainspeak_roundtrip_0001';
      assert.equal(isPlainspeakEnabled(sessionStore.load(dir, sid)), true, 'default ON before any write');

      goalStore.setPlainspeak(dir, sid, false);
      assert.equal(isPlainspeakEnabled(sessionStore.load(dir, sid)), false);

      goalStore.setPlainspeak(dir, sid, true);
      assert.equal(isPlainspeakEnabled(sessionStore.load(dir, sid)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not clobber goal / attempts / statusDiagram', () => {
    const dir = tmp();
    try {
      const sid = 'ses_plainspeak_neighbours_0001';
      goalStore.setGoal(dir, sid, 'ship the PR');
      goalStore.setStatusDiagram(dir, sid, false);
      goalStore.setRetry(dir, sid, 7);
      sessionStore.mutate(dir, sid, (s) => { s.attempts = { turnKey: 'msg_abc', count: 4 }; });

      goalStore.setPlainspeak(dir, sid, false);

      const after = sessionStore.load(dir, sid);
      assert.equal(isPlainspeakEnabled(after), false, 'the write we made');
      assert.equal(after.goal?.condition, 'ship the PR', 'goal survived');
      assert.equal(isStatusDiagramEnabled(after), false, 'statusDiagram survived');
      assert.equal(after.maxAttempts, 7, 'retry override survived');
      assert.deepEqual(after.attempts, { turnKey: 'msg_abc', count: 4 }, 'attempts survived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lastPlainTurnKey persists alongside the flag', () => {
    const dir = tmp();
    try {
      const sid = 'ses_plainspeak_turnkey_0001';
      sessionStore.mutate(dir, sid, (s) => { s.lastPlainTurnKey = 'msg_turn_one'; });
      goalStore.setPlainspeak(dir, sid, true);
      assert.equal(sessionStore.load(dir, sid).lastPlainTurnKey, 'msg_turn_one');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The injected message.
// ---------------------------------------------------------------------------

describe('injected directive shape', () => {
  const VERBOSE = [
    'Great question! Honestly, I think the issue you are seeing here is, to be fair,',
    'somewhat arguably related to a number of different factors that could plausibly',
    'be contributing to the behaviour that you have described in your message above.',
    '',
    'On reflection, I would probably walk back my earlier statement a little bit,',
    'because it seems like the situation is actually kind of more nuanced than I had',
    'originally suggested when I first started looking into this particular problem.',
    '',
    'I apologise for the confusion that this may have caused you, and I really do',
    'appreciate your patience while I worked through all of the various details that',
    'were involved in getting to the bottom of what was going on with the system.',
  ].join('\n');

  test('the corpus above actually scores verbose (guards the fixture)', () => {
    assert.equal(scoreVerbosity(VERBOSE).verdict, 'verbose');
  });

  test('marker leads the injected text, on its own first line', () => {
    const directive = buildRewriteDirective(scoreVerbosity(VERBOSE));
    assert.ok(directive.length > 0, 'a verbose reply must produce a directive');

    // Exactly the composition the plugin performs.
    const text = `${PLAINSPEAK_MARKER}\n${directive}`;
    assert.ok(text.startsWith(PLAINSPEAK_MARKER), 'marker must lead');
    assert.equal(text.split('\n')[0], PLAINSPEAK_MARKER, 'marker owns the first line');
    assert.ok(text.includes(directive), 'directive carried verbatim');
  });

  test('the marker is stable and machine-greppable', () => {
    assert.equal(PLAINSPEAK_MARKER, '<!-- supervisor:plainspeak -->');
    assert.ok(IMPL.includes(PLAINSPEAK_MARKER), 'the plugin references its own marker');
  });

  test('an empty result injects nothing', () => {
    // No hits => no offenses => empty directive => the plugin must not prompt.
    assert.equal(buildRewriteDirective({ hits: [] }), '');
    assert.equal(buildRewriteDirective({}), '');
    assert.equal(buildRewriteDirective(undefined), '');
    // A terse reply is the real-world source of that empty result.
    const terse = scoreVerbosity('Fixed. Token expiry used `<` not `<=`.');
    assert.equal(terse.verdict, 'terse');
    assert.equal(buildRewriteDirective(terse), '');
  });

  test('the status directive is NOT appended to a rewrite request', () => {
    const directive = buildRewriteDirective(scoreVerbosity(VERBOSE));
    assert.ok(!directive.includes('supervisor:status-directive'));
    assert.ok(!directive.includes('ROADMAP'));
  });
});

// ---------------------------------------------------------------------------
// 4. Source-level pins — a refactor must not silently delete these.
// ---------------------------------------------------------------------------

describe('supervisor-impl.ts source pins', () => {
  test('the helper exists and is reachable from the idle path', () => {
    assert.match(IMPL, /async function maybeInjectPlainspeak\(/);
    assert.ok(
      IMPL.split('await maybeInjectPlainspeak(').length - 1 >= 1,
      'maybeInjectPlainspeak must actually be called'
    );
  });

  test('AUTOPILOT suppression is present', () => {
    // Autopilot is mid-work by definition — never nag style.
    assert.match(IMPL, /if \(mode === "autopilot" \|\| sup\.autopilot === true\) return false/);
  });

  test('ACTIVE-GOAL suppression is present', () => {
    // A goal is an attribute now (not a mode), so the guard keys off `goal`
    // alone — the retired `mode === "goal"` disjunct is gone.
    assert.match(IMPL, /if \(goal\) return false/);
    assert.match(IMPL, /if \(args\.projectGoalCondition\) return false/);
  });

  test('the one-rewrite-per-turn guard is present (termination proof)', () => {
    assert.match(IMPL, /if \(sup\.lastPlainTurnKey === turnKey\) return false/);
    // And the turn must be CLAIMED before the prompt, so a failed prompt still
    // burns the single rewrite — failing toward silence, never toward a loop.
    assert.match(IMPL, /s\.lastPlainTurnKey = turnKey/);
    const guardAt = IMPL.indexOf('s.lastPlainTurnKey = turnKey');
    const promptAt = IMPL.indexOf('debug("plainspeak: injected rewrite directive');
    assert.ok(guardAt > 0 && promptAt > guardAt, 'the claim must precede the injection');
  });

  test('the enabled flag is honoured', () => {
    assert.match(IMPL, /if \(!isPlainspeakEnabled\(sup\)\) return false/);
  });

  test('deterministic-only: verbose only, and buildStylePrompt stays unused', () => {
    assert.match(IMPL, /scored\?\.verdict !== "verbose"/);
    assert.ok(!/buildStylePrompt\s*\(/.test(IMPL), 'no LLM tiebreak on the opencode path');
    assert.ok(!/import\s*\{[^}]*buildStylePrompt/.test(IMPL), 'buildStylePrompt is not even imported');
    assert.match(IMPL, /INTENTIONALLY UNUSED/);
  });

  test('an empty directive injects nothing', () => {
    assert.match(IMPL, /if \(!directive \|\| !directive\.trim\(\)\) return false/);
  });

  test('plainspeak runs AFTER the status correction, never alongside it', () => {
    const correctionReturn = IMPL.indexOf('Supervisor injected status checkpoint correction for');
    const firstPlain = IMPL.indexOf('await maybeInjectPlainspeak(');
    assert.ok(correctionReturn > 0 && firstPlain > correctionReturn,
      'the status correction early-return must precede every plainspeak call site');
  });

  test('the toggle is wired', () => {
    assert.match(IMPL, /action === "plain on"/);
    assert.match(IMPL, /action === "plain off"/);
    assert.match(IMPL, /setPlainspeak\(directory, sid, true\)/);
    assert.match(IMPL, /setPlainspeak\(directory, sid, false\)/);
    assert.match(IMPL, /plainspeak: \$\{isPlainspeakEnabled\(st\) \? "on" : "off"\}/);
  });

  test('the /supervisor:plain command file exists and does not delegate', () => {
    const cmd = readFileSync(join(ROOT, 'opencode', 'commands', 'supervisor:plain.md'), 'utf8');
    assert.match(cmd, /Do not use the `task` tool or delegate to a subagent/);
    assert.match(cmd, /action: "plain on"/);
    assert.match(cmd, /action: "plain off"/);
  });
});
