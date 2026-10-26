import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statePath } from '../core/session-store.mjs';
import { evaluateSelfAssessment } from '../core/evaluation.mjs';
import {
  goalStore, resolveRunawayLimit, describeRunawayLimit, readConfiguredMaxAttempts,
  resolveClaudeCodeHardCap, decideGoalTransition, RUNAWAY_CEILING,
  parseSupervisorCommand, buildGoalRequirementSection, buildGoalAssessmentContext,
  GOAL_OWNERSHIP_MARKER, appendGoalOwnershipDirectiveToSystem, sameGoalContract,
  extractGoalCondition, writeProjectGoal, readProjectGoalHistory, readProjectGoalContract, retireProjectGoal, readGoalAchievedLog,
} from '../core/goal.mjs';

const mkcwd = () => fs.mkdtempSync(path.join(tmpdir(), 'sup-goal-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_GOAL_BIN = path.join(HERE, '..', 'bin', 'supervisor-goal.mjs');

test('goal contracts, not coding heuristics, define the required workflow', () => {
  const context = buildGoalAssessmentContext({ taskType: 'coding', conversationChain: 'Requested a local patch only; no PR.', requiresTests: true, requiresBuild: true, requiresPR: true, requiresCI: true, requiresLocalTests: true, requiresLocalTestsEvidence: true, pushedToDefaultBranch: true });
  const assessment = { status: 'complete', confidence: 0.99, remaining_work: [], next_steps: [], needs_user_action: [], evidence: {} };
  assert.equal(evaluateSelfAssessment(assessment, context).shouldContinue, false);
  assert.equal(evaluateSelfAssessment({ ...assessment, remaining_work: ['Verify the acceptance criterion'] }, context).shouldContinue, true);
  assert.equal(context.conversationChain, 'Requested a local patch only; no PR.');
  assert.equal(buildGoalAssessmentContext(null), null);
});

test('agent declarations cannot shadow an effective user project contract', () => {
  const d = mkcwd();
  const project = mkcwd();
  const contract = { source: 'agent', acceptanceCriteria: 'Agent criteria', verification: 'Run agent checks', projectDir: project };
  writeProjectGoal(project, 'User project objective');
  assert.throws(() => goalStore.setGoal(d, 'project-protected', 'Easier objective', contract), /user-set project goal/);
  assert.equal(goalStore.load(d, 'project-protected').goal, undefined);
  goalStore.clearGoal(d, 'project-protected');
  assert.equal(goalStore.setGoal(d, 'project-protected', 'New requested task', contract).goal.source, 'agent');
  assert.equal(readProjectGoalContract(project).condition, 'User project objective');
});

test('goalStore: setGoal/load/clear round-trip, 0600 perms', () => {
  const d = mkcwd();
  assert.deepEqual(goalStore.load(d, 's1'), {});
  goalStore.setGoal(d, 's1', 'all tests pass');
  const st = goalStore.load(d, 's1');
  assert.equal(st.goal.condition, 'all tests pass');
  assert.equal(st.goal.status, 'active');
  assert.equal(st.goal.attempts, 0);
  const mode = fs.statSync(statePath(d, 's1')).mode & 0o777;
  assert.equal(mode, 0o600);
  goalStore.clearGoal(d, 's1');
  assert.equal(goalStore.load(d, 's1').goal, undefined);
});

test('goalStore.setRetry persists override; rejects path traversal', () => {
  const d = mkcwd();
  goalStore.setRetry(d, 's2', 24);
  assert.equal(goalStore.load(d, 's2').maxAttempts, 24);
  assert.throws(() => goalStore.save(d, '../evil', {}));
});

test('resolveRunawayLimit default is the runaway ceiling (50)', () => {
  assert.equal(resolveRunawayLimit({ env: {} }), RUNAWAY_CEILING);
  assert.equal(RUNAWAY_CEILING, 50);
});

test('decideGoalTransition order matches OpenCode impl', () => {
  const g = { condition: 'x', status: 'active', attempts: 0, tokenBaseline: 0, startedAt: 0, deadline: 9e9, lastReason: '' };
  assert.equal(decideGoalTransition({ goal: g, complete: true, now: 1, maxAttempts: 16 }).action, 'achieved');
  assert.equal(decideGoalTransition({ goal: g, complete: false, now: 1, maxAttempts: 16 }).action, 'continue');
  const exhausted = decideGoalTransition({ goal: { ...g, attempts: 16 }, complete: true, now: 1, maxAttempts: 16 });
  assert.equal(exhausted.action, 'exhausted');
  assert.equal(exhausted.reason, 'attempts');
  const past = decideGoalTransition({ goal: { ...g, deadline: 5 }, complete: true, now: 10, maxAttempts: 16 });
  assert.equal(past.action, 'exhausted');
  assert.equal(past.reason, 'deadline');
});

test('parseSupervisorCommand + buildGoalRequirementSection (shared logic)', () => {
  assert.deepEqual(parseSupervisorCommand('goal', 'ship it'), { kind: 'goal-set', condition: 'ship it' });
  assert.equal(parseSupervisorCommand('goal', 'off').kind, 'goal-clear');
  assert.match(buildGoalRequirementSection('ship it'), /MANDATORY/);
  assert.equal(buildGoalRequirementSection(''), '');
});

test('goal ownership directive is idempotent and teaches scoped, checkable goals', () => {
  const system = ['original system'];
  appendGoalOwnershipDirectiveToSystem(system);
  appendGoalOwnershipDirectiveToSystem(system);
  assert.equal(system.length, 2);
  assert.equal(system[0], 'original system');
  assert.ok(system[1].includes(GOAL_OWNERSHIP_MARKER));
  assert.match(system[1], /acceptanceCriteria/);
  assert.match(system[1], /verification/);
  assert.match(system[1], /Plain questions/);
  assert.match(system[1], /does not grant permission/);
});

test('goal requirement renders every criterion and verification without inventing deliverables', () => {
  const section = buildGoalRequirementSection('Fix login', {
    acceptanceCriteria: 'Invalid email is rejected; valid email signs in.',
    verification: 'Run node --test test/login.test.mjs and report pass/fail.',
  });
  assert.match(section, /Invalid email is rejected; valid email signs in/);
  assert.match(section, /node --test test\/login.test.mjs/);
  assert.match(section, /do not invent extra deliverables/i);
  assert.match(section, /You do not see tool calls/);
});

test('parseSupervisorCommand supports root /supervisor mode UX', () => {
  assert.deepEqual(parseSupervisorCommand('supervisor', ''), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'status'), { kind: 'supervisor-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'off'), { kind: 'supervisor-off' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'on'), { kind: 'supervisor-on' });
  for (const removed of ['autopilot', 'static', 'reflection', 'mode goal']) {
    assert.deepEqual(parseSupervisorCommand('supervisor', removed), { kind: 'mode-removed' });
    assert.deepEqual(parseSupervisorCommand(removed.split(' ')[0], ''), { kind: 'mode-removed' });
  }
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal'), { kind: 'goal-status' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal clear'), { kind: 'goal-clear' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal all tests pass'), { kind: 'goal-set', condition: 'all tests pass' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'retry 24'), { kind: 'retry-set', n: 24 });
});

test('goals persist contracts and provenance without selectable modes', () => {
  const d = mkcwd();
  goalStore.setGoal(d, 's3', 'ship it');
  const state = goalStore.load(d, 's3');
  assert.equal(state.goal.source, 'user');
  assert.equal(state.goal.acceptanceCriteria, 'ship it');
  assert.equal(state.mode, undefined);
  assert.equal(state.autopilot, undefined);
  assert.equal(goalStore.setMode, undefined);
  assert.equal(goalStore.setAutopilot, undefined);
});

test('agent contracts cannot overwrite user goals, including paused goals', () => {
  const d = mkcwd();
  goalStore.setGoal(d, 'user', 'user outcome');
  goalStore.mutate(d, 'user', (s) => { s.goal.status = 'paused'; s.maxAttempts = 12; });
  const before = goalStore.load(d, 'user');
  assert.throws(() => goalStore.setGoal(d, 'user', 'agent replacement', {
    source: 'agent', replace: true, acceptanceCriteria: 'tests pass', verification: 'npm test',
  }), /user-set goal/);
  assert.deepEqual(goalStore.load(d, 'user'), before);
});

test('agent replacement is explicit; contract fields survive resume and attempts are reset', () => {
  const d = mkcwd();
  const opts = { source: 'agent', acceptanceCriteria: 'valid inputs pass', verification: 'node --test test/login.mjs' };
  goalStore.setGoal(d, 'agent', 'Fix the login form', opts);
  assert.throws(() => goalStore.setGoal(d, 'agent', 'Fix the logout flow', opts), /already set/);
  goalStore.setGoal(d, 'agent', 'Fix the logout flow', { ...opts, replace: true });
  goalStore.mutate(d, 'agent', (s) => { s.goal.status = 'paused'; s.attempts = { count: 4, turnKey: 'old' }; });
  goalStore.resumeGoal(d, 'agent');
  const state = goalStore.load(d, 'agent');
  assert.equal(state.goal.condition, 'Fix the logout flow');
  assert.equal(state.goal.source, 'agent');
  assert.equal(state.goal.acceptanceCriteria, opts.acceptanceCriteria);
  assert.equal(state.goal.verification, opts.verification);
  assert.equal(state.attempts, undefined);
});

test('a fresh declaration has a fresh audit identity, even with identical text and time', () => {
  const d = mkcwd();
  const first = goalStore.setGoal(d, 'identity', 'Fix the login form', { now: 100 }).goal;
  const second = goalStore.setGoal(d, 'identity', 'Fix the login form', { now: 100 }).goal;
  assert.notEqual(first.id, second.id);
  assert.equal(sameGoalContract(first, second), false);
  assert.equal(sameGoalContract(second, { ...second, attempts: 7 }), true);
  assert.equal(sameGoalContract(second, { ...second, status: 'paused' }), false);
  assert.equal(sameGoalContract(second, { ...second, acceptanceCriteria: 'New stricter criterion' }), false);
});

test('audited agent completion logs evidence metadata but cannot retire an unrelated project contract', () => {
  const d = mkcwd();
  const condition = 'Fix the login form';
  const contract = { acceptanceCriteria: 'Invalid inputs are rejected', verification: 'node --test login.mjs' };
  writeProjectGoal(d, condition, contract);
  goalStore.clearGoal(d, 'agent-complete'); // Explicitly cancel this session's project fallback.
  const expectedGoal = goalStore.setGoal(d, 'agent-complete', condition, { ...contract, source: 'agent' }).goal;
  const result = goalStore.completeGoal(d, 'agent-complete', { expectedGoal, reason: 'Login tests pass' });
  assert.equal(result.achieved, true);
  assert.equal(result.state.goal, undefined);
  assert.equal(readProjectGoalContract(d).condition, condition, 'agent-only goals never delete project files, even when text matches');
  const log = readGoalAchievedLog(d);
  assert.equal(log.length, 1);
  assert.equal(log[0].goalId, expectedGoal.id);
  assert.equal(log[0].acceptanceCriteria, contract.acceptanceCriteria);
});

test('stale or unlogged completion cannot destroy an active declaration', () => {
  const d = mkcwd();
  const stale = goalStore.setGoal(d, 'audit-race', 'Fix the login form').goal;
  const fresh = goalStore.setGoal(d, 'audit-race', 'Fix the logout flow').goal;
  assert.equal(goalStore.completeGoal(d, 'audit-race', { expectedGoal: stale }).achieved, false);
  assert.deepEqual(goalStore.load(d, 'audit-race').goal, fresh);
  assert.equal(readGoalAchievedLog(d).length, 0);
  fs.mkdirSync(path.join(d, '.supervisor', 'goal-achieved.log'));
  assert.equal(goalStore.completeGoal(d, 'audit-race', { expectedGoal: fresh }).achieved, false);
  assert.deepEqual(goalStore.load(d, 'audit-race').goal, fresh, 'failed audit logging must preserve the goal');
});

test('stale stuck signals cannot pause or resurrect a replaced or cleared goal', () => {
  const d = mkcwd();
  const old = goalStore.setGoal(d, 'pause', 'Fix the login form').goal;
  const replacement = goalStore.setGoal(d, 'pause', 'Fix the logout flow').goal;
  assert.equal(goalStore.pauseGoal(d, 'pause', { expectedGoal: old }).paused, false);
  assert.deepEqual(goalStore.load(d, 'pause').goal, replacement);
  goalStore.clearGoal(d, 'pause');
  assert.equal(goalStore.pauseGoal(d, 'pause', { expectedGoal: replacement }).paused, false);
  assert.equal(goalStore.load(d, 'pause').goal, undefined);
  assert.equal(goalStore.load(d, 'pause').goalCleared, true);
});

test('project fallback pause is atomic, contract-preserving and respects clears and new goals', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'Fix the login form', { acceptanceCriteria: 'Login and logout tests pass', verification: 'node --test login.mjs' });
  const projectGoal = readProjectGoalContract(d);
  goalStore.setGoal(d, 'session-goal', 'A different user outcome');
  assert.equal(goalStore.pauseGoal(d, 'session-goal', { projectGoal }).paused, false);
  goalStore.clearGoal(d, 'cleared');
  assert.equal(goalStore.pauseGoal(d, 'cleared', { projectGoal }).paused, false);
  const paused = goalStore.pauseGoal(d, 'fallback', { projectGoal, reason: 'Missing authorization' });
  assert.equal(paused.paused, true);
  assert.equal(paused.state.goal.status, 'paused');
  assert.equal(paused.state.goal.acceptanceCriteria, projectGoal.acceptanceCriteria);
  assert.equal(paused.state.goal.verification, projectGoal.verification);
  writeProjectGoal(d, projectGoal.condition, { ...projectGoal, acceptanceCriteria: 'A stricter criterion' });
  assert.equal(goalStore.pauseGoal(d, 'stale-project', { projectGoal }).paused, false);
  assert.equal(goalStore.load(d, 'stale-project').goal, undefined);
});

test('invalid agent contracts fail loudly, without persisting a goal', () => {
  const d = mkcwd();
  assert.throws(() => goalStore.setGoal(d, 'bad', 'fix login', { source: 'agent' }), /acceptance criteria and verification/);
  assert.throws(() => goalStore.setGoal(d, 'bad', ''), /must not be empty/);
  assert.throws(() => goalStore.setGoal(d, 'bad', 'fix login', { source: 'invented' }), /source/);
  assert.deepEqual(goalStore.load(d, 'bad'), {});
});

test('clear suppresses stale project fallback until a new goal is set', () => {
  const d = mkcwd();
  goalStore.setGoal(d, 'clear', 'Fix the login form');
  goalStore.clearGoal(d, 'clear');
  assert.equal(goalStore.load(d, 'clear').goalCleared, true);
  goalStore.setGoal(d, 'clear', 'Fix the logout flow');
  assert.equal(goalStore.load(d, 'clear').goalCleared, undefined);
});

// ---------------------------------------------------------------------------
// extractGoalCondition — consolidated from 3 duplicate implementations
// (opencode/supervisor-impl.ts x2, bin/supervisor-on-stop.mjs). Behavior must be
// unchanged for all 3 former call sites.
// ---------------------------------------------------------------------------

test('extractGoalCondition: strips HTML comments', () => {
  const content = '<!-- generated file, do not edit -->\nship the feature';
  assert.equal(extractGoalCondition(content), 'ship the feature');
});

test('extractGoalCondition: prefers ## Goal Condition section when present', () => {
  const content = '# Project Goal\n\nsome preamble\n\n## Goal Condition\nall tests pass and PR is merged\n\n## Notes\nirrelevant';
  assert.equal(extractGoalCondition(content), 'all tests pass and PR is merged');
});

test('extractGoalCondition: falls back to whole trimmed text when no section header', () => {
  assert.equal(extractGoalCondition('  ship it already  \n'), 'ship it already');
});

test('extractGoalCondition: null/empty content returns "" (matches the tryRead(...) call site)', () => {
  assert.equal(extractGoalCondition(null), '');
  assert.equal(extractGoalCondition(''), '');
  assert.equal(extractGoalCondition(undefined), '');
});

// ---------------------------------------------------------------------------
// writeProjectGoal / readProjectGoalHistory — the concurrency fix.
// Bug: .agents/supervisor/Goal.md was a bare writeFile overwrite, no lock, no
// history — concurrent goal-set calls silently destroyed each other (proven:
// 30 concurrent calls in, 1 survivor, 29 gone with zero trace). These tests
// must fail against the old bare-writeFile behavior and pass against the fix.
// ---------------------------------------------------------------------------

test('writeProjectGoal: single write — Goal.md + history both contain the condition', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'ship the feature');
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.equal(goalMd, 'ship the feature');
  const history = readProjectGoalHistory(d);
  assert.equal(history.length, 1);
  assert.equal(history[0].condition, 'ship the feature');
  assert.ok(history[0].ts && history[0].pid, 'history entry must carry ts + pid');
});

test('project goal contracts survive reload and retirement checks the full contract', () => {
  const d = mkcwd();
  const condition = 'Fix the login form';
  const original = { acceptanceCriteria: 'Valid and invalid inputs are tested', verification: 'node --test test/login.mjs' };
  writeProjectGoal(d, condition, original);
  assert.deepEqual(readProjectGoalContract(d), { condition, ...original, source: 'user' });
  assert.equal(readProjectGoalHistory(d)[0].verification, original.verification);
  const revised = { ...original, acceptanceCriteria: original.acceptanceCriteria + '; keyboard submission works' };
  writeProjectGoal(d, condition, revised);
  const oldVerdict = retireProjectGoal(d, { condition, contract: original });
  assert.equal(oldVerdict.removed.length, 0, 'a stale verdict cannot retire stricter criteria with the same condition');
  assert.equal(readProjectGoalContract(d).acceptanceCriteria, revised.acceptanceCriteria);
  const currentVerdict = retireProjectGoal(d, { condition, contract: revised });
  assert.equal(currentVerdict.logged, true);
  assert.equal(currentVerdict.removed.length, 1);
  assert.equal(readProjectGoalContract(d), null);
});

test('writeProjectGoal: sequential double-write — current pointer is the last write, history has both', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  writeProjectGoal(d, 'condition B');
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.equal(goalMd, 'condition B', 'current pointer matches today\'s semantics: last write wins');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

test('writeProjectGoal: history survives even when the current-pointer file is deleted', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  fs.rmSync(path.join(d, '.agents', 'supervisor', 'Goal.md'));
  writeProjectGoal(d, 'condition B');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

test('readProjectGoalHistory: missing file returns [] (best effort, never throws)', () => {
  const d = mkcwd();
  assert.deepEqual(readProjectGoalHistory(d), []);
});

test('readProjectGoalHistory: skips a corrupt line instead of failing the whole read', () => {
  const d = mkcwd();
  writeProjectGoal(d, 'condition A');
  fs.appendFileSync(path.join(d, '.agents', 'supervisor', 'goal-history.jsonl'), 'not-json\n');
  writeProjectGoal(d, 'condition B');
  const history = readProjectGoalHistory(d);
  assert.deepEqual(history.map((h) => h.condition), ['condition A', 'condition B']);
});

// ---------------------------------------------------------------------------
// Real concurrent OS processes — ports the exact shell repro from
// .tasks/40/bug.md into the test runner. Sync fs calls within ONE process
// can never race each other (the JS event loop serializes them by
// construction) — the actual bug only reproduces across independent
// processes racing the same file, so this spawns real `node
// bin/supervisor-goal.mjs` child processes, not in-process calls.
// ---------------------------------------------------------------------------

function runGoalSet(cwd, condition) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR_GOAL_BIN, 'goal', condition], { cwd });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`supervisor-goal.mjs exited ${code}: ${stderr}`));
    });
  });
}

test('concurrent real processes: 0 conditions lost across N racing goal-set calls', { timeout: 60_000 }, async () => {
  const d = mkcwd();
  fs.mkdirSync(path.join(d, '.supervisor'), { recursive: true });
  fs.writeFileSync(path.join(d, '.supervisor', 'current_session'), 'concurrency-test-session', 'utf8');

  const PER_SIDE = 10; // matches the order of magnitude of the manual repro (15+15)
  const conditions = [];
  for (let i = 0; i < PER_SIDE; i++) {
    conditions.push(`condition-A-run${i}`, `condition-B-run${i}`);
  }

  await Promise.all(conditions.map((c) => runGoalSet(d, c)));

  const history = readProjectGoalHistory(d);
  const recovered = new Set(history.map((h) => h.condition));
  const missing = conditions.filter((c) => !recovered.has(c));
  assert.deepEqual(missing, [], `Lost ${missing.length}/${conditions.length} conditions to the race — history: ${JSON.stringify([...recovered])}`);
  assert.equal(recovered.size, conditions.length, 'every condition must be independently recoverable, no duplicates collapsing the count');

  // The current pointer must be exactly one of the raced conditions — never
  // corrupted/blank/partial (atomic rename guarantees this even though which
  // one wins is non-deterministic).
  const goalMd = fs.readFileSync(path.join(d, '.agents', 'supervisor', 'Goal.md'), 'utf8');
  assert.ok(conditions.includes(goalMd), `Goal.md current pointer must be one of the raced conditions, got: ${JSON.stringify(goalMd)}`);
});

// ---------------------------------------------------------------------------
// resolveRunawayLimit — THE runaway safety valve, shared by both runtimes.
//
// Why one function: the two runtimes had silently diverged. The Claude Code
// hook used 3 for plain reflection and 16 only for goal/autopilot; the OpenCode
// plugin used 16 for EVERYTHING. That was invisible only because OpenCode's
// boolean "already reflected this turn" gate made its budget unreachable — the
// moment the counter became the real stop condition, OpenCode would have run
// 16 unattended pushes per human message. It is now ONE function, no `mode`
// input, one high default.
// ---------------------------------------------------------------------------

// The counter is a RUNAWAY SAFETY VALVE now, not the intended stop — that is
// `supervisor_loop_exit`. So every mode shares one high default; the old
// per-mode defaults (3 for reflection, 16 for goal/autopilot) made the counter
// decide completion, which it cannot observe, and it stood down mid-task. There
// is deliberately no `mode` input — mode never changes the limit.
test('resolveRunawayLimit: defaults to the runaway ceiling regardless of mode context', () => {
  assert.equal(RUNAWAY_CEILING, 50);
  // No mode input at all — one value for every situation.
  assert.equal(resolveRunawayLimit({ env: {} }), RUNAWAY_CEILING);
  // Passing a stray `mode` (an ignored/unknown opt) must not change anything.
  for (const mode of ['reflection', 'goal', 'autopilot', undefined]) {
    assert.equal(resolveRunawayLimit({ mode, env: {} }), RUNAWAY_CEILING);
  }
});

test('resolveRunawayLimit: /supervisor retry N wins for EVERY N', () => {
  // The user-visible bug this branch fixes: retry 1 and retry 5 used to be
  // indistinguishable on OpenCode.
  for (let n = 1; n <= 20; n++) {
    assert.equal(
      resolveRunawayLimit({ sessionOverride: n, env: {} }), n,
      `retry ${n} must resolve to exactly ${n}`,
    );
  }
});

test('resolveRunawayLimit: precedence is retry > config > env > ceiling', () => {
  assert.equal(resolveRunawayLimit({ config: 8, env: {} }), 8);
  assert.equal(resolveRunawayLimit({ config: 8, sessionOverride: 2, env: {} }), 2);
  assert.equal(resolveRunawayLimit({ env: { SUPERVISOR_MAX_ATTEMPTS: '9' } }), 9);
  // config outranks env; retry outranks both.
  assert.equal(resolveRunawayLimit({ config: 4, env: { SUPERVISOR_MAX_ATTEMPTS: '9' } }), 4);
  assert.equal(resolveRunawayLimit({ sessionOverride: 2, config: 4, env: { SUPERVISOR_MAX_ATTEMPTS: '9' } }), 2);
});

test('resolveRunawayLimit: honours any positive integer verbatim (no upper clamp) and opts out on 0/unlimited', () => {
  // 2a: a number the operator explicitly typed is NEVER silently rewritten.
  assert.equal(resolveRunawayLimit({ sessionOverride: 500, env: {} }), 500);
  assert.equal(resolveRunawayLimit({ sessionOverride: 10_000, env: {} }), 10_000);
  // 0 and the word spellings mean UNLIMITED (no cap), not "1 attempt".
  for (const off of [0, 'unlimited', 'off', 'none', 'infinite']) {
    assert.equal(resolveRunawayLimit({ sessionOverride: off, env: {} }), Infinity,
      `${off} must resolve to Infinity (no cap)`);
  }
  // Invalid values (negative, fractional, garbage) fall THROUGH to the next
  // tier, never disabling the loop and never becoming some other number.
  for (const bad of [-3, -1, 2.5]) {
    assert.equal(resolveRunawayLimit({ sessionOverride: bad, config: 12, env: {} }), 12,
      `${bad} at retry tier must fall through to config 12`);
    assert.equal(resolveRunawayLimit({ sessionOverride: bad, env: {} }), RUNAWAY_CEILING,
      `${bad} with no lower tier must fall through to the default`);
  }
});

test('describeRunawayLimit: tier attribution + unlimited + platform cap surfaced', () => {
  assert.equal(describeRunawayLimit({ env: {} }).tier, 'default');
  assert.equal(describeRunawayLimit({ sessionOverride: 5, env: {} }).tier, 'retry');
  assert.equal(describeRunawayLimit({ config: 9, env: {} }).tier, 'config');
  assert.equal(describeRunawayLimit({ env: { SUPERVISOR_MAX_ATTEMPTS: '9' } }).tier, 'env');
  const un = describeRunawayLimit({ sessionOverride: 'unlimited', env: {} });
  assert.equal(un.unlimited, true);
  assert.equal(un.limit, Infinity);
  assert.equal(un.cappedByPlatform, false);
  // Claude Code CANNOT honour unlimited: the platform cap always wins, and the
  // descriptor records that it did (requested unlimited, enforced 7).
  const cc = describeRunawayLimit({ sessionOverride: 'unlimited', hardCap: 7, env: {} });
  assert.equal(cc.limit, 7);
  assert.equal(cc.cappedByPlatform, true);
  assert.equal(cc.unlimited, true);
  assert.equal(cc.requested, Infinity);
  assert.equal(cc.hardCap, 7);
  // A finite requested value above the cap is likewise reduced and flagged.
  const cc2 = describeRunawayLimit({ sessionOverride: 100, hardCap: 7, env: {} });
  assert.equal(cc2.limit, 7);
  assert.equal(cc2.cappedByPlatform, true);
  assert.equal(cc2.requested, 100);
  // A finite requested value BELOW the cap is honoured and NOT flagged.
  const cc3 = describeRunawayLimit({ sessionOverride: 3, hardCap: 7, env: {} });
  assert.equal(cc3.limit, 3);
  assert.equal(cc3.cappedByPlatform, false);
});

test('readConfiguredMaxAttempts: parses maxAttempts:, accepts unlimited, warns on invalid', () => {
  const d = mkcwd();
  const p = path.join(d, 'supervisor.yaml');
  fs.writeFileSync(p, 'model: anthropic/claude\nmaxAttempts: 128\n');
  assert.equal(readConfiguredMaxAttempts(() => {}, p), 128);
  fs.writeFileSync(p, 'maxAttempts: unlimited\n');
  assert.equal(readConfiguredMaxAttempts(() => {}, p), Infinity);
  fs.writeFileSync(p, 'maxAttempts: 0\n');
  assert.equal(readConfiguredMaxAttempts(() => {}, p), Infinity);
  // Invalid value: warn AND fall through (return undefined so the next tier wins).
  fs.writeFileSync(p, 'maxAttempts: -4\n');
  let warned = '';
  assert.equal(readConfiguredMaxAttempts((m) => { warned = m; }, p), undefined);
  assert.match(warned, /invalid maxAttempts/i);
  // Absent key / missing file → undefined, no throw.
  fs.writeFileSync(p, 'model: x\n');
  assert.equal(readConfiguredMaxAttempts(() => {}, p), undefined);
  assert.equal(readConfiguredMaxAttempts(() => {}, path.join(d, 'nope.yaml')), undefined);
});

test('resolveRunawayLimit: hardCap applies last and only where a runtime has one', () => {
  const cc = resolveClaudeCodeHardCap({});
  assert.equal(cc, 7);
  // Claude Code clamps; OpenCode (no hardCap) does not.
  assert.equal(resolveRunawayLimit({ hardCap: cc, env: {} }), 7);
  assert.equal(resolveRunawayLimit({ env: {} }), RUNAWAY_CEILING);
  // A hardCap must never raise a smaller value.
  assert.equal(resolveRunawayLimit({ sessionOverride: 2, hardCap: cc, env: {} }), 2);
  // ...and never drop below 1.
  assert.equal(resolveRunawayLimit({ hardCap: 0, env: {} }), 1);
});

test('resolveRunawayLimit honours the env knobs BOTH runtimes have always read', () => {
  assert.equal(resolveRunawayLimit({ env: {} }), RUNAWAY_CEILING);
  assert.equal(resolveRunawayLimit({ env: { SUPERVISOR_MAX_ATTEMPTS: '6' } }), 6);
  assert.equal(resolveRunawayLimit({ env: { REFLECTION_CC_MAX_ATTEMPTS: '5' } }), 5);
  // Garbage env value falls back to the ceiling, never disables the loop.
  assert.equal(resolveRunawayLimit({ env: { SUPERVISOR_MAX_ATTEMPTS: 'garbage' } }), RUNAWAY_CEILING);
  // SUPERVISOR_MAX_ATTEMPTS wins over REFLECTION_CC_MAX_ATTEMPTS when both set.
  assert.equal(resolveRunawayLimit({ env: { SUPERVISOR_MAX_ATTEMPTS: '6', REFLECTION_CC_MAX_ATTEMPTS: '5' } }), 6);
});
