#!/usr/bin/env node
/**
 * supervisor.mjs — canonical Claude CLI dispatcher for the full supervisor
 * command surface. Wires parseSupervisorCommand → goalStore actions.
 *
 * Usage:
 *   node bin/supervisor.mjs <command> [args…] [--session <id>]
 *
 * Commands: status, on, off, goal, retry, autopilot, mode, reflection
 *
 * SESSION IDENTITY (see core/session-store.mjs resolveSessionId):
 *   1. --session <id>            explicit, wins; a unique prefix is expanded
 *   2. SUPERVISOR_SESSION_ID     exported by the Stop hook from its stdin payload
 *   3. CLAUDE_SESSION_ID         Claude Code's own env
 *   4. .supervisor/current_session   LAST RESORT, interactive only — announced
 *
 * `current_session` is one shared file every session in the project
 * overwrites, so with two concurrent sessions it names whichever stopped
 * last. Relying on it silently disabled the wrong session (user-reported).
 * It is now a fallback that says so out loud, and an ambiguous id acts on
 * nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  goalStore,
  parseSupervisorCommand,
  resolveMaxAttempts,
  resolveSupervisorMode,
  resolveClaudeCodeHardCap,
  writeProjectGoal,
  readProjectGoalCondition,
} from '../core/goal.mjs';
import { resolveSessionId } from '../core/session-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// argv[2] = command name, rest = args string.
// `--session <id>` / `--session=<id>` / `-s <id>` is stripped out first so it
// can be passed anywhere and never leaks into a goal condition.
const rawArgv = process.argv.slice(2);
let explicitSession = '';
const argv = [];
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === '--session' || a === '-s') { explicitSession = rawArgv[++i] ?? ''; continue; }
  if (a.startsWith('--session=')) { explicitSession = a.slice('--session='.length); continue; }
  argv.push(a);
}

let name = argv[0] ?? '';
let args = argv.slice(1).join(' ');

/**
 * Resolve the session this invocation acts on, ONCE. Returns the full
 * resolution record so callers can report the source (never act silently).
 */
const resolution = resolveSessionId(cwd, { explicit: explicitSession });
const sid = resolution.sessionId;

/** Human-readable note about WHERE the session id came from. */
function sessionSourceNote() {
  if (!sid) return '';
  if (resolution.source === 'current_session') {
    const others = resolution.candidates.length
      ? `\n⚠  ${resolution.candidates.length} other session(s) were also active recently: ` +
        resolution.candidates.map((c) => c.slice(0, 8) + '…').join(', ') +
        `\n   If that is the one you meant, re-run with --session <id>.`
      : '';
    return `\n(session resolved from .supervisor/current_session — the last session to stop in this project: ${sid})${others}`;
  }
  if (resolution.source === 'sole-session') {
    return `\n(no session id was supplied; this is the only session known in this project: ${sid})`;
  }
  if (resolution.source === 'env') return `\n(session from $${resolution.envVar})`;
  if (resolution.source === 'explicit-prefix') return `\n(session id expanded from the prefix you gave: ${sid})`;
  return '';
}

/** Print the ambiguity report and exit WITHOUT acting. */
function bailAmbiguous() {
  console.log(
    `Ambiguous session — acting on NOTHING.\n` +
    `${resolution.reason ?? 'more than one session matches'}.\n` +
    `Candidates:\n` +
    resolution.candidates.map((c) => `  ${c}`).join('\n') +
    `\nRe-run with an explicit id: supervisor ${name} --session <id>`
  );
  process.exit(1);
}
if (resolution.ambiguous) bailAmbiguous();

const NO_SESSION_MSG =
  'No session id available. Pass one explicitly (--session <id>), or run something first so the Stop hook records the session, then retry.';

// Special-case: `mode <word>` → translate to `supervisor <word>` so the
// parser's `name==='supervisor'` branch handles mode-set correctly.
// `mode goal` needs its own path: `supervisor set-goal` means "goal status" to
// the parser, so set the mode directly instead (parity with the OpenCode surface,
// where `/supervisor set-goal` with no condition also reports status).
if (name === 'mode' && argv[1]?.toLowerCase() === 'goal') {
  if (!sid) {
    console.log(NO_SESSION_MSG);
    process.exit(0);
  }
  goalStore.setMode(cwd, sid, 'goal');
  console.log(`Supervisor mode set to goal for session ${sid.slice(0, 8)}… (requires an active goal condition to be set).${sessionSourceNote()}`);
  process.exit(0);
}
if (name === 'mode') {
  name = 'supervisor';
  // args is already the mode word (e.g. "reflection" or "autopilot")
}

// Special-case: bare `reflection` shorthand → mode-set reflection
if (name === 'reflection') {
  name = 'supervisor';
  args = 'reflection';
}

// Top-level aliases: `status`, `on`, `off` are supervisor-namespaced in the
// parser (name==='supervisor' branch). Translate them so the parser sees them.
if (name === 'status' || name === 'on' || name === 'off') {
  args = name + (args ? ' ' + args : '');
  name = 'supervisor';
}

// User-facing label for goal-related CLI output.
const GOAL_LABEL = 'Goal';

/**
 * Disabled-list helpers (supervisor on/off).
 * File: <cwd>/.supervisor/disabled — newline-delimited session IDs.
 */
function readDisabled() {
  try {
    return fs.readFileSync(path.join(cwd, '.supervisor', 'disabled'), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function writeDisabled(list) {
  const dir = path.join(cwd, '.supervisor');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content = list.length ? list.join('\n') + '\n' : '';
  fs.writeFileSync(path.join(dir, 'disabled'), content, 'utf8');
}

const cmd = parseSupervisorCommand(name, args);

// Migration notice: solofounder mode used to keep its own condition in
// .agents/supervisor/solofounder.md. That mode is gone and nothing reads the
// file any more, so a leftover copy would silently do nothing. Tell the user
// once, on any supervisor invocation. Best-effort: must never throw.
try {
  if (fs.existsSync(path.join(cwd, '.agents', 'supervisor', 'solofounder.md'))) {
    console.log(
      '⚠  .agents/supervisor/solofounder.md is no longer read — solofounder is not a mode any more. ' +
      'Move its condition into .agents/supervisor/Goal.md via `set-goal "<condition>"`, then delete the file.'
    );
  }
} catch { /* best effort */ }

/** Warn and clear an active goal before a mode switch that would delete it. */
function clearGoalIfActive(cwd, sid) {
  const st = goalStore.load(cwd, sid);
  if (st.goal?.status === 'active') {
    console.log(`⚠  Clearing active goal: "${st.goal.condition}"`);
    goalStore.clearGoal(cwd, sid);
  }
}

switch (cmd.kind) {
  // ── goal ──────────────────────────────────────────────────────────────────
  case 'goal-set': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setGoal(cwd, sid, cmd.condition);
    // Also persist to .agents/supervisor/Goal.md so reflection mode picks it up
    // across sessions. Safe under concurrent writers — see writeProjectGoal.
    writeProjectGoal(cwd, cmd.condition);
    const budget = resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts });
    // The Stop hook clamps the per-turn budget to one under Claude Code's own
    // block-override threshold, so the requested number is not what actually
    // runs here. Quote both rather than the misleading raw budget.
    const ccCap = Math.min(budget, resolveClaudeCodeHardCap());
    console.log(
      `${GOAL_LABEL} set for session ${sid.slice(0, 8)}…: "${cmd.condition}".\n` +
      `The judge sees this as a mandatory completion requirement on every stop and keeps pushing until it is demonstrably met.\n` +
      `Budget: ${budget} attempts per human turn (clamped to ${ccCap} here on Claude Code by CLAUDE_CODE_STOP_HOOK_BLOCK_CAP) — it resets each time you speak, so the goal is never permanently exhausted mid-session.\n` +
      `Also saved to .agents/supervisor/Goal.md for reflection mode.`
    );
    break;
  }
  case 'goal-clear': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.clearGoal(cwd, sid);
    console.log(`${GOAL_LABEL} cleared for session ${sid.slice(0, 8)}….`);
    break;
  }
  case 'goal-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    if (st.goal) {
      console.log(
        `${GOAL_LABEL} (${st.goal.status}): ${st.goal.condition}\n` +
        `attempts: ${st.goal.attempts}` +
        (st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : '')
      );
      break;
    }
    // No session goal. Binding contract (align-supervisor-modes): goal mode
    // with no condition and nothing set MUST attempt an LLM derivation
    // rather than silently no-op-ing — but this CLI has no LLM call wired
    // in (see the OpenCode plugin's supervisor_goal tool for the actual
    // derivation flow). Never fabricate a default here either way: report
    // a project-level goal if one exists, otherwise say so explicitly and
    // point at how to set one.
    const projectCondition = readProjectGoalCondition(cwd);
    if (projectCondition) {
      console.log(
        `No ${GOAL_LABEL.toLowerCase()} set for this session, but a project-level goal exists ` +
        `(.agents/supervisor/Goal.md or goal.md): "${projectCondition}". ` +
        `Reflection mode already enforces it; run 'supervisor set-goal <condition>' to set an explicit session goal instead.`
      );
    } else {
      console.log(
        `No ${GOAL_LABEL.toLowerCase()} set for this session or the project. ` +
        `Automatic LLM-based goal derivation is only available via the OpenCode plugin's supervisor_goal tool; ` +
        `on this CLI, set one explicitly: supervisor set-goal <condition>`
      );
    }
    break;
  }

  // ── retry ─────────────────────────────────────────────────────────────────
  case 'retry-set': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setRetry(cwd, sid, cmd.n);
    console.log(`Retry budget set to ${resolveMaxAttempts({ sessionOverride: cmd.n })} for session ${sid.slice(0, 8)}….`);
    break;
  }
  case 'retry-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    console.log(`Retry budget (session override): ${st.maxAttempts ?? '(default 16 when a goal is active; 3 otherwise)'}.`);
    break;
  }

  // ── mode-set ──────────────────────────────────────────────────────────────
  case 'mode-set': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    // Warn if switching modes with an active goal (setMode will delete it).
    clearGoalIfActive(cwd, sid);
    goalStore.setMode(cwd, sid, cmd.mode);
    const budget = resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts });
    console.log(`mode: ${cmd.mode}`);
    if (cmd.mode === 'autopilot') {
      console.log(
        `Autopilot on — supervisor will auto-continue without judge until you output AUTOPILOT_EXIT or budget runs out.\n` +
        `Budget: ${budget} attempts.`
      );
    } else if (cmd.mode === 'reflection') {
      console.log('Supervisor back to reflection mode (judge runs on each stop).');
    }
    break;
  }

  // ── autopilot-on ──────────────────────────────────────────────────────────
  case 'autopilot-on': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    // Warn if there is an active goal (setAutopilot → setMode will delete it).
    clearGoalIfActive(cwd, sid);
    goalStore.setAutopilot(cwd, sid, true);
    const budget = resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts });
    console.log('mode: autopilot');
    console.log(
      `Autopilot on — supervisor will auto-continue without judge until you output AUTOPILOT_EXIT or budget runs out.\n` +
      `Budget: ${budget} attempts.`
    );
    break;
  }

  // ── autopilot-off ─────────────────────────────────────────────────────────
  case 'autopilot-off': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setAutopilot(cwd, sid, false);
    console.log('mode: reflection');
    console.log('Supervisor back to reflection mode (judge runs on each stop).');
    break;
  }

  // ── autopilot-status ──────────────────────────────────────────────────────
  case 'autopilot-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    const effective = resolveSupervisorMode(st);
    const isAuto = effective === 'autopilot';
    console.log(`mode: ${effective}`);
    console.log(`autopilot active: ${isAuto ? 'yes' : 'no'}`);
    break;
  }

  // ── supervisor-status ─────────────────────────────────────────────────────
  case 'supervisor-status': {
    // Delegate entirely to bin/status.mjs — it owns the effective-mode line.
    const statusScript = path.join(__dirname, 'status.mjs');
    try {
      execFileSync('node', [statusScript], { cwd, stdio: 'inherit' });
    } catch (err) {
      // stdio:'inherit' means err.stdout/err.stderr are always null; just propagate exit code.
      process.exit(err.status ?? 1);
    }
    break;
  }

  // ── autoreview-on/off/status ──────────────────────────────────────────────
  case 'autoreview-on':
  case 'autoreview-off':
  case 'autoreview-status': {
    console.log('Use /supervisor:autoreview on|off — not yet wired to this CLI.');
    process.exit(0);
  }

  // ── supervisor-on ─────────────────────────────────────────────────────────
  case 'supervisor-on': {
    if (!sid) {
      console.log(`${NO_SESSION_MSG} Supervisor is already active by default.`);
      process.exit(0);
    }
    const list = readDisabled().filter((s) => s !== sid);
    writeDisabled(list);
    console.log(`Supervisor re-enabled for session: ${sid}${sessionSourceNote()}`);
    break;
  }

  // ── supervisor-off ────────────────────────────────────────────────────────
  case 'supervisor-off': {
    if (!sid) {
      console.log(`${NO_SESSION_MSG} Nothing to disable.`);
      process.exit(0);
    }
    const dir = path.join(cwd, '.supervisor');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existing = readDisabled();
    if (!existing.includes(sid)) writeDisabled([...existing, sid]);
    console.log(`Supervisor disabled for session: ${sid}${sessionSourceNote()}`);
    break;
  }

  // ── unknown ───────────────────────────────────────────────────────────────
  case 'unknown':
  default: {
    const given = process.argv[2] ?? '(none)';
    console.log(
      `Unknown supervisor command: ${given}.\n` +
      `Valid commands: status, on, off, set-goal, retry, autopilot, reflection, mode, solofounder (alias for set-goal).`
    );
    process.exit(1);
  }
}
