#!/usr/bin/env node
/**
 * supervisor.mjs — canonical Claude CLI dispatcher for the full supervisor
 * command surface. Wires parseSupervisorCommand → goalStore actions.
 *
 * Usage:
 *   node bin/supervisor.mjs <command> [args…]
 *
 * Commands: status, on, off, goal, retry, autopilot, mode, reflection
 *
 * Session id is read from <cwd>/.supervisor/current_session (written by the
 * Stop hook). State is stored per-session via core/goal.mjs.
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
  writeProjectGoal,
  writeSolofounderGoal,
  readProjectGoalCondition,
} from '../core/goal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// argv[2] = command name, rest = args string
let name = process.argv[2] ?? '';
let args = process.argv.slice(3).join(' ');

// Special-case: `mode <word>` → translate to `supervisor <word>` so the
// parser's `name==='supervisor'` branch handles mode-set correctly.
// `mode goal` needs its own path: `supervisor goal` means "goal status" to the
// parser, so set the mode directly instead (parity with the OpenCode surface,
// where `/supervisor goal` with no condition also reports status).
if (name === 'mode' && process.argv[3]?.toLowerCase() === 'goal') {
  const sidForMode = (() => {
    try { return fs.readFileSync(path.join(process.cwd(), '.supervisor', 'current_session'), 'utf8').trim(); }
    catch { return process.env.CLAUDE_SESSION_ID?.trim() || null; }
  })();
  if (!sidForMode) {
    console.log('No active session yet (.supervisor/current_session missing). Run something first so the Stop hook records the session, then retry.');
    process.exit(0);
  }
  goalStore.setMode(process.cwd(), sidForMode, 'goal');
  console.log(`Supervisor mode set to goal for session ${sidForMode.slice(0, 8)}… (requires an active goal condition to be set).`);
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

function currentSession() {
  try {
    return fs.readFileSync(path.join(cwd, '.supervisor', 'current_session'), 'utf8').trim();
  } catch {
    // Fall back to env var when .supervisor/current_session is absent (e.g. in skill invocations
    // where the Stop hook hasn't run yet but CLAUDE_SESSION_ID is available from the shell env).
    return process.env.CLAUDE_SESSION_ID?.trim() || null;
  }
}

const sid = currentSession();

const NO_SESSION_MSG =
  'No active session yet (.supervisor/current_session missing). Run something first so the Stop hook records the session, then retry.';

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
    console.log(
      `${GOAL_LABEL} set for session ${sid.slice(0, 8)}…: "${cmd.condition}".\n` +
      `The supervisor will keep pushing the agent until this is demonstrably met or the retry budget (${budget}) runs out.\n` +
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
        `Reflection mode already enforces it; run 'supervisor goal <condition>' to set an explicit session goal instead.`
      );
    } else {
      console.log(
        `No ${GOAL_LABEL.toLowerCase()} set for this session or the project. ` +
        `Automatic LLM-based goal derivation is only available via the OpenCode plugin's supervisor_goal tool; ` +
        `on this CLI, set one explicitly: supervisor goal <condition>`
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

  // ── solofounder-on ────────────────────────────────────────────────────────
  case 'solofounder-on': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const condition = cmd.condition || '';
    // Deliberately NOT calling clearGoalIfActive: solofounder-on sets a new
    // session goal itself (setSolofounder below), it never deletes one.
    writeSolofounderGoal(cwd, condition);
    goalStore.setSolofounder(cwd, sid, condition);
    const budget = resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts });
    console.log(
      `mode: solofounder\n` +
      `Solo-founder drive armed for session ${sid.slice(0, 8)}… — target: $1,000,000 ARR.\n` +
      `Condition: "${condition}"\n` +
      `Saved to .agents/supervisor/solofounder.md. The judge runs on every stop and keeps driving the CEO loop until the ARR bar is demonstrably met; the ${budget}-attempt budget resets every human turn instead of exhausting permanently, and the drive has no practical time limit.`
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
      console.log('No active session found (.supervisor/current_session missing). Supervisor is already active by default.');
      process.exit(0);
    }
    const list = readDisabled().filter((s) => s !== sid);
    writeDisabled(list);
    console.log(`Supervisor re-enabled for session: ${sid}`);
    break;
  }

  // ── supervisor-off ────────────────────────────────────────────────────────
  case 'supervisor-off': {
    if (!sid) {
      console.log('No active session found (.supervisor/current_session missing). Nothing to disable.');
      process.exit(0);
    }
    const dir = path.join(cwd, '.supervisor');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existing = readDisabled();
    if (!existing.includes(sid)) writeDisabled([...existing, sid]);
    console.log(`Supervisor disabled for session: ${sid}`);
    break;
  }

  // ── unknown ───────────────────────────────────────────────────────────────
  case 'unknown':
  default: {
    const given = process.argv[2] ?? '(none)';
    console.log(
      `Unknown supervisor command: ${given}.\n` +
      `Valid commands: status, on, off, goal, retry, autopilot, reflection, solofounder, mode.`
    );
    process.exit(1);
  }
}
