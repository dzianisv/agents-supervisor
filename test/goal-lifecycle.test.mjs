/**
 * Goal lifecycle + content-free-verdict regression coverage.
 *
 * BUG A — goals never died. `.agents/supervisor/Goal.md` / `goal.md` was
 * injected as a MANDATORY completion requirement into EVERY reflection,
 * forever, with no expiry: achieving a goal persisted `status:'achieved'` but
 * left the file on disk, so the next session re-read it and the goal
 * resurrected. Real damage: a "$1,000 MRR" condition — unsatisfiable by any
 * single turn — was injected into 95 unrelated turns.
 *
 * BUG B — a judge verdict with nothing actionable (empty missing, empty
 * next_actions, blank feedback) still rendered a "Task Incomplete" headline
 * with an empty body and was injected, so the agent had nothing to act on,
 * went idle, and got the byte-identical message again ~20s later until the
 * retry cap (observed: 15 consecutive identical injections).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  goalStore, writeProjectGoal, writeDerivedProjectGoal, readProjectGoalCondition,
  retireProjectGoal, readGoalAchievedLog, decideGoalTransition,
} from '../core/goal.mjs';
import { buildEscalatingFeedback, isActionlessVerdict, hasFeedbackBody } from '../core/feedback.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function tmp() {
  return mkdtempSync(join(tmpdir(), 'goal-lifecycle-'));
}

// ---------------------------------------------------------------------------
// A1. Achievement retires the project goal file, durably and recoverably.
// ---------------------------------------------------------------------------

describe('BUG A: an achieved goal is retired from disk', () => {
  test('goal achieved -> project goal file is gone, achievement recorded, session goal cleared', () => {
    const dir = tmp();
    try {
      const condition = 'All tests in test/ pass and a PR is open with green CI';
      writeProjectGoal(dir, condition);
      assert.equal(readProjectGoalCondition(dir), condition, 'precondition: goal is on disk');

      goalStore.setGoal(dir, 'ses_abc', condition, {});
      const goal = goalStore.load(dir, 'ses_abc').goal;
      const t = decideGoalTransition({ goal, complete: true, now: Date.now(), maxAttempts: 16 });
      assert.equal(t.action, 'achieved');

      const retired = retireProjectGoal(dir, {
        condition,
        sessionId: 'ses_abc',
        source: 'test',
        reason: 'tests pass, PR green',
      });
      goalStore.clearGoal(dir, 'ses_abc');

      // 1. the file is gone
      assert.equal(retired.removed.length, 1);
      assert.ok(!existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      assert.equal(readProjectGoalCondition(dir), '', 'goal must not resurrect on the next read');

      // 2. the achievement is durably recorded BEFORE the unlink
      const log = readGoalAchievedLog(dir);
      assert.equal(log.length, 1);
      assert.equal(log[0].condition, condition);
      assert.equal(log[0].sessionId, 'ses_abc');
      assert.equal(log[0].source, 'test');
      assert.match(log[0].reason, /tests pass/);
      assert.ok(log[0].ts, 'record carries a timestamp');

      // 3. the session goal is cleared
      assert.equal(goalStore.load(dir, 'ses_abc').goal, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retires BOTH casings (Goal.md and goal.md) when both hold the judged condition', () => {
    const dir = tmp();
    try {
      const condition = 'The build is green on main';
      writeProjectGoal(dir, condition);
      writeDerivedProjectGoal(dir, condition);
      assert.ok(existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      assert.ok(existsSync(join(dir, '.agents', 'supervisor', 'goal.md')));

      const retired = retireProjectGoal(dir, { condition, source: 'test' });
      // On a case-insensitive filesystem the two names are one inode, so the
      // count varies by platform — what must hold everywhere is that nothing
      // readable is left behind.
      assert.ok(retired.removed.length >= 1);
      assert.ok(!existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      assert.ok(!existsSync(join(dir, '.agents', 'supervisor', 'goal.md')));
      assert.equal(readProjectGoalCondition(dir), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The deletion safety rule: never delete a goal we did not judge.
  test('SAFETY: does not delete a goal file whose on-disk condition differs from the judged one', () => {
    const dir = tmp();
    try {
      writeProjectGoal(dir, 'A brand new goal the human just wrote by hand');
      const retired = retireProjectGoal(dir, { condition: 'a stale condition we judged', source: 'test' });
      assert.equal(retired.removed.length, 0);
      assert.equal(retired.skipped.length, 1);
      assert.ok(existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      // ...and the attempt still leaves a trace.
      const log = readGoalAchievedLog(dir);
      assert.equal(log.length, 1);
      assert.equal(log[0].removed.length, 0);
      assert.equal(log[0].skipped.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SAFETY: never deletes on a blank/absent condition (no delete-on-a-guess)', () => {
    const dir = tmp();
    try {
      writeProjectGoal(dir, 'ship the thing');
      assert.deepEqual(retireProjectGoal(dir, { condition: '' }).removed, []);
      assert.deepEqual(retireProjectGoal(dir, {}).removed, []);
      assert.ok(existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      assert.equal(readGoalAchievedLog(dir).length, 0, 'no log entry for a no-op');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retireProjectGoal is best-effort: no throw on a missing directory', () => {
    const dir = join(tmp(), 'does-not-exist');
    const r = retireProjectGoal(dir, { condition: 'x' });
    assert.deepEqual(r.removed, []);
  });

  test('next reflection after achievement injects NO goal section', () => {
    const dir = tmp();
    try {
      const condition = 'All tests pass';
      writeProjectGoal(dir, condition);
      // Before: reflection would read a condition and inject a GOAL section.
      assert.equal(readProjectGoalCondition(dir), condition);
      retireProjectGoal(dir, { condition, source: 'test' });
      // After: nothing to inject. This IS the "no goal section" assertion —
      // both runtimes build the section from readProjectGoalCondition()'s
      // return value and skip it entirely when it is falsy.
      assert.equal(readProjectGoalCondition(dir), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A3. Auto-derived goals are session-scoped only.
// ---------------------------------------------------------------------------

describe('BUG A: auto-derived goals never create the durable project file', () => {
  test('deriveAndSetGoal does not write a project goal file; only explicit set-goal does', async () => {
    // Source-level assertion: the derivation path in the plugin runs inside
    // runSupervisor's closure and cannot be observed from outside without a
    // live server (the E2E harness covers the runtime side). What we can
    // assert deterministically is that the write call is gone from the
    // derivation path and still present on the explicit set-goal path.
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.ok(
      !src.includes('writeDerivedProjectGoal('),
      'an auto-derived goal must NOT be persisted to .agents/supervisor/goal.md — a turn-1 guess became a MANDATORY requirement for turn 50 and every future session'
    );
    assert.ok(
      src.includes('writeProjectGoal(await resolveSessionDirectoryFor(sid), condition)'),
      'an EXPLICIT /supervisor:set-goal <condition> must still create the durable project file'
    );
  });

  test('explicit writeProjectGoal still creates Goal.md (durable path unchanged)', () => {
    const dir = tmp();
    try {
      writeProjectGoal(dir, 'ship v2');
      assert.ok(existsSync(join(dir, '.agents', 'supervisor', 'Goal.md')));
      assert.equal(readProjectGoalCondition(dir), 'ship v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A2. Goals are not presented as gaps in the current turn.
// ---------------------------------------------------------------------------

describe('BUG A: standing goal renders separately from per-turn gaps', () => {
  test('goal condition gets its own labelled section, not a ### Missing bullet', () => {
    const out = buildEscalatingFeedback(1, 'MEDIUM', {
      missing: ['Fix the build errors in src/app.ts'],
      next_actions: ['Run npm run build'],
      feedback: 'build is red',
      goal_condition: 'Reach $1,000 MRR for VibeBrowser',
    }, 16);

    assert.match(out, /### Standing goal \(not a gap in this turn\)/);
    assert.match(out, /### Standing goal[\s\S]*Reach \$1,000 MRR/);
    // The per-turn gap list must NOT contain the goal.
    const missingBlock = out.split('### Missing')[1].split('###')[0];
    assert.match(missingBlock, /Fix the build errors/);
    assert.doesNotMatch(missingBlock, /MRR/);
    // ...and the standing-goal section says it is not this turn's fault.
    assert.match(out, /standing condition carried across turns/);
  });

  test('explicit goal_items are pulled out of ### Missing into the goal section', () => {
    const out = buildEscalatingFeedback(1, 'HIGH', {
      missing: ['Capture the CUA demo video', 'Fix build errors'],
      next_actions: [],
      feedback: 'still red',
      goal_items: ['Capture the CUA demo video'],
    }, 16);
    const missingBlock = out.split('### Missing')[1].split('###')[0];
    assert.match(missingBlock, /Fix build errors/);
    assert.doesNotMatch(missingBlock, /CUA demo video/);
    assert.match(out, /### Standing goal[\s\S]*CUA demo video/);
  });

  test('no goal -> no standing-goal section at all (unchanged output shape)', () => {
    const out = buildEscalatingFeedback(1, 'LOW', {
      missing: ['Add a test'], next_actions: [], feedback: 'x',
    }, 16);
    assert.doesNotMatch(out, /Standing goal/);
  });

  test('destructive rewriting still applies inside the standing-goal section', () => {
    const out = buildEscalatingFeedback(1, 'HIGH', {
      missing: ['Add a test'], next_actions: [], feedback: 'x',
      goal_items: ['Force-push the release branch'],
    }, 16);
    assert.match(out, /Flag to the user for approval: Force-push the release branch/);
  });
});

// ---------------------------------------------------------------------------
// B. Content-free verdicts must not loop.
// ---------------------------------------------------------------------------

describe('BUG B: content-free verdicts stand down instead of looping', () => {
  test('empty verdict (all three fields empty) is actionless -> no injection', () => {
    assert.equal(isActionlessVerdict({ missing: [], next_actions: [], feedback: '' }), true);
    assert.equal(isActionlessVerdict({}), true);
    assert.equal(isActionlessVerdict(null), true);
    assert.equal(isActionlessVerdict(undefined), true);
  });

  test('verdict with only whitespace feedback is actionless -> no injection', () => {
    assert.equal(isActionlessVerdict({ missing: [], next_actions: [], feedback: '   \n\t ' }), true);
    // blank-string items do not count as content either
    assert.equal(isActionlessVerdict({ missing: ['', '  '], next_actions: ['\n'], feedback: '' }), true);
  });

  test('any real content makes the verdict actionable', () => {
    assert.equal(isActionlessVerdict({ missing: ['Run the tests'], next_actions: [], feedback: '' }), false);
    assert.equal(isActionlessVerdict({ missing: [], next_actions: ['Open the PR'], feedback: '' }), false);
    assert.equal(isActionlessVerdict({ missing: [], next_actions: [], feedback: 'the build is red' }), false);
  });

  test('a standing goal alone never makes a verdict actionable (that is the stale-goal loop)', () => {
    assert.equal(
      isActionlessVerdict({ missing: [], next_actions: [], feedback: '', goal_condition: 'Reach $1,000 MRR' }),
      true
    );
  });

  test('hasFeedbackBody rejects a rendered message with an empty body', () => {
    const empty = buildEscalatingFeedback(1, 'MEDIUM', { missing: [], next_actions: [], feedback: '' }, 16);
    assert.equal(hasFeedbackBody(empty), false, `rendered empty-bodied message was:\n${JSON.stringify(empty)}`);

    const goalOnly = buildEscalatingFeedback(1, 'MEDIUM', {
      missing: [], next_actions: [], feedback: '', goal_condition: 'Reach $1,000 MRR',
    }, 16);
    assert.equal(hasFeedbackBody(goalOnly), false, 'a standing goal is not a body');

    const real = buildEscalatingFeedback(1, 'MEDIUM', { missing: ['Run tests'], next_actions: [], feedback: '' }, 16);
    assert.equal(hasFeedbackBody(real), true);
  });

  test('opencode runtime stands down before injecting an actionless verdict', async () => {
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.ok(src.includes('isActionlessVerdict('), 'opencode must consult isActionlessVerdict before injecting');
    assert.ok(src.includes('hasFeedbackBody(feedbackText)'), 'opencode must guard against an empty rendered body');
    // The injection must be gated on shouldContinue, not merely on !complete.
    assert.ok(
      src.includes('if (!analysis.shouldContinue || actionlessVerdict)'),
      'opencode must stand down when the judge did not ask to continue'
    );
  });

  test('claude-code stop hook stands down before injecting an actionless verdict', async () => {
    const raw = await readFile(join(ROOT, 'bin', 'supervisor-on-stop.mjs'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.ok(src.includes('actionlessVerdict'), 'hook must compute an actionless-verdict guard');
    assert.ok(src.includes('!actionlessVerdict'), 'hook must gate the normal inject on it');
    assert.ok(src.includes('no_inject_actionless_verdict'), 'hook must log the stand-down reason');
    assert.ok(src.includes('retireProjectGoal('), 'hook must retire an achieved project goal');
  });
});
