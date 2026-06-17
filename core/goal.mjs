/**
 * goal.mjs — shared goal-loop primitives (canonical JS port of the logic in
 * opencode/supervisor.ts). Used by the Claude Code Stop hook (bin/on-stop.mjs)
 * and the CC goal/retry CLI (bin/supervisor-goal.mjs).
 *
 * A "goal" is a user-set condition the agent must demonstrably meet before the
 * supervisor lets it stop. While a goal is active the retry budget rises
 * (default 16) and the goal is injected into the judge prompt as a mandatory
 * completion requirement.
 *
 * State: <cwd>/.supervisor/goals/<sessionId>.json (mode 0600).
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_ATTEMPTS = 16;
export const DEFAULT_MAX_GOAL_DURATION_MS = 30 * 60 * 1000;

const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/** Priority: sessionOverride > config > 16. Clamped [1,100]; non-finite ignored. */
export function resolveMaxAttempts(opts = {}) {
  for (const c of [opts.sessionOverride, opts.config, DEFAULT_MAX_ATTEMPTS]) {
    if (c !== undefined && Number.isFinite(c)) return Math.min(100, Math.max(1, Math.floor(c)));
  }
  return DEFAULT_MAX_ATTEMPTS;
}

/** Parse `/supervisor:goal`/`/supervisor:retry`/`/supervisor:autopilot` args into a typed action. */
export function parseSupervisorCommand(name, args) {
  const trimmed = (args ?? '').trim();
  if (name === 'goal') {
    if (trimmed === '') return { kind: 'goal-status' };
    if (GOAL_CLEAR_ALIASES.has(trimmed.toLowerCase())) return { kind: 'goal-clear' };
    return { kind: 'goal-set', condition: trimmed.slice(0, 4000) };
  }
  if (name === 'retry') {
    if (trimmed === '') return { kind: 'retry-status' };
    if (/^\d+$/.test(trimmed)) return { kind: 'retry-set', n: parseInt(trimmed, 10) };
    return { kind: 'retry-status' };
  }
  if (name === 'autopilot') {
    const lower = trimmed.toLowerCase();
    if (lower === '' || lower === 'on' || lower === 'true' || lower === 'start') return { kind: 'autopilot-on' };
    if (lower === 'off' || lower === 'false' || lower === 'stop' || lower === 'exit') return { kind: 'autopilot-off' };
    if (lower === 'status') return { kind: 'autopilot-status' };
    return { kind: 'autopilot-on' };
  }
  return { kind: 'unknown', name };
}

/** Prompt fragment marking the goal a MANDATORY completion requirement (or '' if blank). */
export function buildGoalRequirementSection(condition) {
  const trimmed = (condition ?? '').trim();
  if (!trimmed) return '';
  return `## GOAL (mandatory completion requirement)

MANDATORY: The following user-set goal condition MUST be demonstrably met before the task can be considered complete:

  "${trimmed}"

This is an ADDITIONAL requirement on top of the existing workflow gates (tests, build, PR, CI checks) — it does not replace them. The task is NOT complete until this condition is satisfied AND all normal completion criteria are met.

Evidence rule: a claim that this goal condition is met must be backed by evidence already surfaced in the transcript — commands run and their output, tests actually executed, artefacts produced. A bare assertion that the condition is satisfied does NOT count as evidence.`;
}

/**
 * Decide the next goal state. Strict order: exhausted (attempts cap OR deadline)
 * → achieved (complete) → continue (attempts+1). Returns a NEW goal; never mutates.
 */
export function decideGoalTransition({ goal, complete, now, maxAttempts, reason }) {
  const lastReason = reason ?? goal.lastReason;
  if (goal.attempts >= maxAttempts || now >= goal.deadline) {
    return { action: 'exhausted', goal: { ...goal, status: 'exhausted', lastReason } };
  }
  if (complete) {
    return { action: 'achieved', goal: { ...goal, status: 'achieved', lastReason } };
  }
  return { action: 'continue', goal: { ...goal, status: 'active', attempts: goal.attempts + 1, lastReason } };
}

// --- per-session store (sync) ---------------------------------------------

function assertSafeSessionId(sessionId) {
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    throw new Error(`Invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
}
function goalsDir(cwd) {
  return path.join(cwd, '.supervisor', 'goals');
}
function goalPath(cwd, sessionId) {
  return path.join(goalsDir(cwd), `${sessionId}.json`);
}

export const goalStore = {
  load(cwd, sessionId) {
    try {
      return JSON.parse(fs.readFileSync(goalPath(cwd, sessionId), 'utf8'));
    } catch {
      return {};
    }
  },
  save(cwd, sessionId, state) {
    assertSafeSessionId(sessionId);
    fs.mkdirSync(goalsDir(cwd), { recursive: true });
    const p = goalPath(cwd, sessionId);
    fs.writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  },
  setGoal(cwd, sessionId, condition, opts = {}) {
    const state = goalStore.load(cwd, sessionId);
    const now = opts.now ?? Date.now();
    const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_GOAL_DURATION_MS;
    state.goal = {
      condition, status: 'active', attempts: 0,
      tokenBaseline: opts.tokenBaseline ?? 0, startedAt: now,
      deadline: now + maxDurationMs, lastReason: '',
    };
    goalStore.save(cwd, sessionId, state);
    return state;
  },
  clearGoal(cwd, sessionId) {
    const state = goalStore.load(cwd, sessionId);
    delete state.goal;
    goalStore.save(cwd, sessionId, state);
    return state;
  },
  setRetry(cwd, sessionId, n) {
    const state = goalStore.load(cwd, sessionId);
    state.maxAttempts = n;
    goalStore.save(cwd, sessionId, state);
    return state;
  },
};
