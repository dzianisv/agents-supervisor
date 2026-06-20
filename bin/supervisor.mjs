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
} from '../core/goal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();

// argv[2] = command name, rest = args string
let name = process.argv[2] ?? '';
let args = process.argv.slice(3).join(' ');

// Special-case: `mode <word>` → translate to `supervisor <word>` so the
// parser's `name==='supervisor'` branch handles mode-set correctly.
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
    const budget = resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts });
    console.log(
      `Goal set for session ${sid.slice(0, 8)}…: "${cmd.condition}".\n` +
      `The supervisor will keep pushing the agent until this is demonstrably met or the retry budget (${budget}) runs out.`
    );
    break;
  }
  case 'goal-clear': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.clearGoal(cwd, sid);
    console.log(`Goal cleared for session ${sid.slice(0, 8)}….`);
    break;
  }
  case 'goal-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    if (!st.goal) console.log('No goal set for this session.');
    else console.log(
      `Goal (${st.goal.status}): ${st.goal.condition}\n` +
      `attempts: ${st.goal.attempts}` +
      (st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : '')
    );
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
      `Valid commands: status, on, off, goal, retry, autopilot, reflection, mode.`
    );
    process.exit(1);
  }
}
