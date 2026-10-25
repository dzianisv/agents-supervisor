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
  resumeGoal, goalResumeHintSuffix, withResumeHint, GOAL_RESUME_HINT,
  parseSupervisorCommand, DEFAULT_MAX_GOAL_DURATION_MS,
} from '../core/goal.mjs';
import { sessionStore } from '../core/session-store.mjs';
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
      /writeProjectGoal\(projectDir, persisted\.goal!\.condition, persisted\.goal\)/.test(src),
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
    const out = buildEscalatingFeedback('MEDIUM', {
      missing: ['Fix the build errors in src/app.ts'],
      next_actions: ['Run npm run build'],
      feedback: 'build is red',
      goal_condition: 'Reach $1,000 MRR for VibeBrowser',
    });

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
    const out = buildEscalatingFeedback('HIGH', {
      missing: ['Capture the CUA demo video', 'Fix build errors'],
      next_actions: [],
      feedback: 'still red',
      goal_items: ['Capture the CUA demo video'],
    });
    const missingBlock = out.split('### Missing')[1].split('###')[0];
    assert.match(missingBlock, /Fix build errors/);
    assert.doesNotMatch(missingBlock, /CUA demo video/);
    assert.match(out, /### Standing goal[\s\S]*CUA demo video/);
  });

  test('no goal -> no standing-goal section at all (unchanged output shape)', () => {
    const out = buildEscalatingFeedback('LOW', {
      missing: ['Add a test'], next_actions: [], feedback: 'x',
    });
    assert.doesNotMatch(out, /Standing goal/);
  });

  test('destructive rewriting still applies inside the standing-goal section', () => {
    const out = buildEscalatingFeedback('HIGH', {
      missing: ['Add a test'], next_actions: [], feedback: 'x',
      goal_items: ['Force-push the release branch'],
    });
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
    const empty = buildEscalatingFeedback('MEDIUM', { missing: [], next_actions: [], feedback: '' });
    assert.equal(hasFeedbackBody(empty), false, `rendered empty-bodied message was:\n${JSON.stringify(empty)}`);

    const goalOnly = buildEscalatingFeedback('MEDIUM', {
      missing: [], next_actions: [], feedback: '', goal_condition: 'Reach $1,000 MRR',
    });
    assert.equal(hasFeedbackBody(goalOnly), false, 'a standing goal is not a body');

    const real = buildEscalatingFeedback('MEDIUM', { missing: ['Run tests'], next_actions: [], feedback: '' });
    assert.equal(hasFeedbackBody(real), true);
  });

  test('opencode runtime stands down before injecting an actionless verdict', async () => {
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.ok(src.includes('isActionlessVerdict('), 'opencode must consult isActionlessVerdict before injecting');
    assert.ok(src.includes('hasFeedbackBody(renderedFeedback)'), 'opencode must guard against an empty rendered body');
    // The injection must be gated on shouldContinue, not merely on !complete.
    assert.ok(
      src.includes('if (!analysis.shouldContinue || actionlessVerdict)'),
      'opencode must stand down when the judge did not ask to continue'
    );
  });

  // Live-validation finding (test/live-validation.mjs scenario 8): a judge
  // verdict of {complete:false, missing:[], next_actions:[], feedback:""} —
  // the EXACT shape isActionlessVerdict exists for — was reported as
  // "judge did not ask to continue (shouldContinue=false)", never as
  // "verdict had no actionable content". Cause: analyzeSelfAssessmentWithLLM
  // substitutes `verdict.feedback || "Judge analysis completed"` into
  // `analysis.reason`, and the guard was fed `analysis.reason`. The
  // blank-feedback arm of isActionlessVerdict was therefore unreachable on
  // this runtime, and the operator-facing stand-down reason was wrong for the
  // one case it was written to name.
  test('opencode feeds isActionlessVerdict the RAW judge feedback, not the placeholder', async () => {
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

    assert.ok(
      /rawFeedback:\s*typeof verdict\.feedback === "string"/.test(src),
      'the LLM-judge path must carry the verdict feedback through verbatim as rawFeedback'
    );
    assert.ok(
      /feedback:\s*analysis\.rawFeedback \?\? analysis\.reason/.test(src),
      'isActionlessVerdict must be given analysis.rawFeedback, never the "Judge analysis completed" placeholder'
    );
    assert.ok(
      !/feedback:\s*analysis\.reason,\s*\}\)/.test(src),
      'analysis.reason must not be passed to isActionlessVerdict — it is never blank'
    );

    // And the guard itself must still classify that exact shape.
    assert.equal(
      isActionlessVerdict({ missing: [], next_actions: [], feedback: '' }),
      true,
      'the empty-verdict shape must be classified as actionless'
    );
    assert.equal(
      isActionlessVerdict({ missing: [], next_actions: [], feedback: 'Judge analysis completed' }),
      false,
      'the placeholder makes the verdict look non-actionless — which is exactly why it must not be passed in'
    );
  });

  // Live-validation finding (test/live-validation.mjs scenario 9): the
  // predecessor `autopilot_exit` tool was registered plugin-wide, so it was
  // in the tool catalog of EVERY session, including goal-mode ones. It used
  // to call setAutopilot(false) unconditionally, which routes through
  // setMode('reflection') -> `delete state.goal` — so one stray tool call
  // destroyed the user's active goal, silently. That tool is now DELETED
  // (opencode/supervisor-impl.ts) — `supervisor_loop_exit` is the one
  // remaining exit signal, and this pins that it inherited the same
  // protection: exiting a mode you are not in must be a no-op with respect
  // to autopilot/goal state.
  test('removed modes cannot bypass goal ownership or completion auditing', async () => {
    // 1. The destructive primitive is GONE: setMode away from the goal-bearing
    //    mode no longer drops the goal (a goal is an orthogonal attribute now,
    //    not a mode). This is the two-modes refactor's central invariant — the
    //    old `if (mode !== 'goal') delete state.goal` landmine is removed.
    const cwd = mkdtempSync(join(tmpdir(), 'sup-autopilot-exit-'));
    try {
      goalStore.setGoal(cwd, 'ses_autopilot_exit_probe', 'ship the thing');
      assert.equal(goalStore.load(cwd, 'ses_autopilot_exit_probe').goal?.condition, 'ship the thing');
      assert.equal(goalStore.setMode, undefined);
      assert.equal(goalStore.setAutopilot, undefined);
      assert.equal(goalStore.load(cwd, 'ses_autopilot_exit_probe').goal.source, 'user');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    // 2. The predecessor tool must be gone entirely — one signal, not two.
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    assert.ok(
      !/\bexecuteAutopilotExit\b/.test(src) && !/\bautopilot_exit\b/.test(src),
      'the predecessor autopilot_exit tool must be fully removed, not left dead alongside supervisor_loop_exit'
    );

    // 3. …so the surviving `supervisor_loop_exit` tool must check the mode
    // before touching autopilot state, and must never delete the goal.
    const exitFn = src.slice(src.indexOf('const executeSupervisorLoopExit'), src.indexOf('let setSupervisorTool'));
    assert.ok(exitFn.length > 0, 'could not locate executeSupervisorLoopExit');
    assert.doesNotMatch(exitFn, /setAutopilot|setMode/);
    assert.ok(exitFn.indexOf('Completion pending judge audit') < exitFn.indexOf('s.loopExit ='), 'active completion must return before persisting loopExit');
    assert.ok(
      !/delete\s+s(tate)?\.goal/.test(exitFn),
      'supervisor_loop_exit must never delete the goal outright — this is the exact footgun the deleted tool caused'
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

// ---------------------------------------------------------------------------
// RESUME: a paused/exhausted goal is not a dead end.
//
// Before this phase, nothing anywhere flipped a paused or exhausted goal back
// to active — the condition sat on disk forever, inert, with no indication
// the user needed to re-type it from scratch. resumeGoal() (core/goal.mjs) is
// the fix; these tests cover its full contract plus the parser/CLI wiring.
// ---------------------------------------------------------------------------

describe('resume: a paused goal is not a dead end', () => {
  test('stuck -> paused -> resume -> active round-trip preserves the condition verbatim', () => {
    const dir = tmp();
    try {
      const condition = 'all tests in test/auth pass and the PR is open with green CI';
      goalStore.setGoal(dir, 'ses_resume_1', condition, {});

      // Simulate the exact mutation both runtimes perform on supervisor_loop_exit
      // reason:'stuck' (opencode/supervisor-impl.ts, bin/supervisor-on-stop.mjs).
      sessionStore.mutate(dir, 'ses_resume_1', (s) => {
        s.goal = { ...s.goal, status: 'paused', lastReason: withResumeHint('agent reported stuck: circular dependency') };
      });
      const paused = goalStore.load(dir, 'ses_resume_1').goal;
      assert.equal(paused.status, 'paused');
      assert.equal(paused.condition, condition, 'precondition: condition unchanged by the pause');

      const outcome = resumeGoal(dir, 'ses_resume_1');
      assert.equal(outcome.resumed, true);
      assert.equal(outcome.previousStatus, 'paused');
      assert.equal(outcome.status, 'active');
      assert.equal(outcome.condition, condition);

      const resumed = goalStore.load(dir, 'ses_resume_1').goal;
      assert.equal(resumed.status, 'active');
      assert.equal(resumed.condition, condition, 'the condition must survive the pause/resume round-trip VERBATIM');
      assert.equal(resumed.lastReason, '', 'the stale pause reason must be cleared, not carried into the resumed goal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resume with no goal at all returns an honest "no-goal" message and changes nothing', () => {
    const dir = tmp();
    try {
      const outcome = resumeGoal(dir, 'ses_resume_none');
      assert.equal(outcome.resumed, false);
      assert.equal(outcome.reason, 'no-goal');
      assert.equal(goalStore.load(dir, 'ses_resume_none').goal, undefined, 'resume must never CREATE a goal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resume on an already-active goal is an honest no-op, not a fabricated success', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_active', 'ship it', {});
      const before = goalStore.load(dir, 'ses_resume_active');

      const outcome = resumeGoal(dir, 'ses_resume_active');
      assert.equal(outcome.resumed, false);
      assert.equal(outcome.reason, 'already-active');
      assert.equal(outcome.status, 'active');
      assert.equal(outcome.condition, 'ship it');

      const after = goalStore.load(dir, 'ses_resume_active');
      assert.deepEqual(after.goal, before.goal, 'nothing about an already-active goal may change');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resume on a terminal (achieved) goal reports the actual status and changes nothing', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_terminal', 'ship it', {});
      sessionStore.mutate(dir, 'ses_resume_terminal', (s) => { s.goal = { ...s.goal, status: 'achieved' }; });

      const outcome = resumeGoal(dir, 'ses_resume_terminal');
      assert.equal(outcome.resumed, false);
      assert.equal(outcome.reason, 'terminal');
      assert.equal(outcome.status, 'achieved', 'the honest message must name the ACTUAL status, not a generic refusal');

      const after = goalStore.load(dir, 'ses_resume_terminal').goal;
      assert.equal(after.status, 'achieved', 'resume must not touch a terminal goal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resume persists: a fresh read-back through goalStore.load shows the goal active', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_persist', 'ship it', {});
      sessionStore.mutate(dir, 'ses_resume_persist', (s) => { s.goal = { ...s.goal, status: 'paused', lastReason: 'stuck' }; });

      resumeGoal(dir, 'ses_resume_persist');

      // Simulate a completely separate reader (e.g. a different process/CLI
      // invocation) re-loading from disk — never trust the in-memory outcome
      // object alone.
      const reread = goalStore.load(dir, 'ses_resume_persist');
      assert.equal(reread.goal.status, 'active');
      assert.equal(reread.goal.condition, 'ship it');
      assert.equal(reread.mode, undefined);
      assert.equal(reread.autopilot, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resume resets the per-turn attempt counter — both goal.attempts and the shared state.attempts', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_attempts', 'ship it', {});
      sessionStore.mutate(dir, 'ses_resume_attempts', (s) => {
        s.goal = { ...s.goal, status: 'paused', attempts: 12, lastTurnKey: 'old-turn-key' };
        s.attempts = { count: 12, turnKey: 'old-turn-key', lastIso: new Date().toISOString() };
      });
      assert.equal(sessionStore.readAttempts(dir, 'ses_resume_attempts', 'old-turn-key'), 12, 'precondition: budget was spent');

      resumeGoal(dir, 'ses_resume_attempts');

      const state = goalStore.load(dir, 'ses_resume_attempts');
      assert.equal(state.goal.attempts, 0, 'goal.attempts mirror must reset to 0');
      assert.equal(state.goal.lastTurnKey, null, 'lastTurnKey must reset so the next stop treats this as a fresh turn');
      // A brand-new turn key must read 0 — not just the OLD turn key, which
      // would prove nothing (readAttempts already returns 0 for a stale key).
      assert.equal(sessionStore.readAttempts(dir, 'ses_resume_attempts', 'a-brand-new-turn-key'), 0);
      assert.equal(state.attempts, undefined, 'the shared per-turn counter object must be deleted entirely, not just zeroed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a deadline-exhausted goal resumes: deadline extended into the future, mode forced to reflection', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_deadline', 'ship it', {});
      // Mirror exactly what both runtimes persist when decideGoalTransition
      // reports action:'exhausted', reason:'deadline' (opencode additionally
      // sets mode:'reflection' — see the deadline sites in supervisor-impl.ts
      // and bin/supervisor-on-stop.mjs's finishExhaustedGoal).
      sessionStore.mutate(dir, 'ses_resume_deadline', (s) => {
        s.mode = 'reflection';
        s.autopilot = false;
        s.goal = { ...s.goal, status: 'exhausted', deadline: Date.now() - 1000, lastReason: withResumeHint('goal deadline reached') };
      });

      const before = Date.now();
      const outcome = resumeGoal(dir, 'ses_resume_deadline');
      assert.equal(outcome.resumed, true);
      assert.equal(outcome.previousStatus, 'exhausted');

      const state = goalStore.load(dir, 'ses_resume_deadline');
      assert.equal(state.goal.status, 'active');
      assert.equal(state.mode, undefined);
      assert.equal(state.autopilot, undefined);
      assert.ok(
        state.goal.deadline > before,
        `a deadline that already passed must be extended into the future on resume, got ${state.goal.deadline} vs now ${before}`
      );
      assert.ok(
        state.goal.deadline >= before + DEFAULT_MAX_GOAL_DURATION_MS - 5000,
        'the extension must be a fresh full-length window, not a token bump'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a future (not-yet-passed) deadline is left untouched by resume — only an OVERDUE deadline is extended', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_future_deadline', 'ship it', {});
      const originalDeadline = goalStore.load(dir, 'ses_resume_future_deadline').goal.deadline;
      sessionStore.mutate(dir, 'ses_resume_future_deadline', (s) => {
        s.goal = { ...s.goal, status: 'paused', lastReason: 'stuck' };
      });

      resumeGoal(dir, 'ses_resume_future_deadline');

      const state = goalStore.load(dir, 'ses_resume_future_deadline');
      assert.equal(state.goal.deadline, originalDeadline, 'an ordinary stuck-pause with a future deadline must not get a bonus extension');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('user-wait "pause" never persists a status change — resume correctly reports already-active, nothing to do', () => {
    // bin/supervisor-on-stop.mjs's goal_paused_user_wait branch (the third
    // "pause" site) writes ONLY a transient verdictRecord.goal='paused' log
    // entry — it never touches state.goal.status, which stays 'active' the
    // entire time. There is no real dead end here; resume must say so
    // honestly rather than inventing a resume that already happened.
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_userwait', 'ship it', {});
      // No status mutation — this IS the user-wait "pause": state.goal.status
      // is never anything but 'active'.
      const outcome = resumeGoal(dir, 'ses_resume_userwait');
      assert.equal(outcome.resumed, false);
      assert.equal(outcome.reason, 'already-active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('goalStore.resumeGoal is wired to the same function (facade parity with setGoal/clearGoal)', () => {
    const dir = tmp();
    try {
      goalStore.setGoal(dir, 'ses_resume_facade', 'ship it', {});
      sessionStore.mutate(dir, 'ses_resume_facade', (s) => { s.goal = { ...s.goal, status: 'paused' }; });
      const outcome = goalStore.resumeGoal(dir, 'ses_resume_facade');
      assert.equal(outcome.resumed, true);
      assert.equal(goalStore.load(dir, 'ses_resume_facade').goal.status, 'active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('goalResumeHintSuffix: only for paused/exhausted goals, empty otherwise', () => {
    assert.equal(goalResumeHintSuffix(null), '');
    assert.equal(goalResumeHintSuffix(undefined), '');
    assert.equal(goalResumeHintSuffix({ status: 'active' }), '');
    assert.equal(goalResumeHintSuffix({ status: 'achieved' }), '');
    assert.equal(goalResumeHintSuffix({ status: 'cleared' }), '');
    assert.match(goalResumeHintSuffix({ status: 'paused' }), /set-goal resume/);
    assert.match(goalResumeHintSuffix({ status: 'exhausted' }), /set-goal resume/);
  });

  test('withResumeHint appends the canonical hint without leaving a dangling separator on an empty reason', () => {
    assert.equal(withResumeHint(''), GOAL_RESUME_HINT);
    assert.equal(withResumeHint(undefined), GOAL_RESUME_HINT);
    assert.equal(withResumeHint('agent reported stuck'), `agent reported stuck ${GOAL_RESUME_HINT}`);
  });

  test('parseSupervisorCommand: "set-goal resume" and "unpause" parse to goal-resume — never /supervisor goal', () => {
    assert.deepEqual(parseSupervisorCommand('set-goal', 'resume'), { kind: 'goal-resume' });
    assert.deepEqual(parseSupervisorCommand('set-goal', 'RESUME'), { kind: 'goal-resume' });
    assert.deepEqual(parseSupervisorCommand('set-goal', 'unpause'), { kind: 'goal-resume' });
    assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal resume'), { kind: 'goal-resume' });
    // legacy bare-`goal` alias still resolves internally — it must simply
    // never be the string shown to a user (test/manifest.test.mjs pins that).
    assert.deepEqual(parseSupervisorCommand('goal', 'resume'), { kind: 'goal-resume' });
    // a condition that happens to start with the word "resume" must still be
    // treated as a real condition, not swallowed by the alias check.
    assert.deepEqual(
      parseSupervisorCommand('set-goal', 'resume shipping the v2 feature'),
      { kind: 'goal-set', condition: 'resume shipping the v2 feature' }
    );
  });
});
