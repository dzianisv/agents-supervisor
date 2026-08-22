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
  describeRunawayLimit,
  formatRunawayLimit,
  readConfiguredMaxAttempts,
  resolveSupervisorMode,
  resolveClaudeCodeHardCap,
  writeProjectGoal,
  readProjectGoalCondition,
  goalResumeHintSuffix,
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
// DEPRECATED `mode goal`: 'goal' is no longer a mode — a goal is an orthogonal
// session ATTRIBUTE. Accept it as a deprecated alias that sets reflection (the
// mode that VERIFIES a goal) and keeps any existing goal, so users, skills and
// stale installed command files that still say `mode goal` do not hard-error.
if (name === 'mode' && argv[1]?.toLowerCase() === 'goal') {
  if (!sid) {
    console.log(NO_SESSION_MSG);
    process.exit(0);
  }
  goalStore.setMode(cwd, sid, 'reflection');
  const st = goalStore.load(cwd, sid);
  const hasGoal = st.goal?.status === 'active';
  console.log(
    `'goal' is no longer a mode — a goal is a session attribute. Mode set to reflection for session ${sid.slice(0, 8)}…` +
    (hasGoal ? ` (existing goal kept: "${st.goal.condition}").` : `. Set a goal with 'supervisor set-goal <condition>'.`) +
    sessionSourceNote()
  );
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

/** Report an active goal that a mode switch will now KEEP (not clear). A mode
 * switch never drops a goal any more — a goal is an orthogonal attribute. */
function noteGoalKeptOnModeSwitch(cwd, sid, mode) {
  const st = goalStore.load(cwd, sid);
  if (st.goal?.status === 'active') {
    if (mode === 'autopilot') {
      console.log(`ℹ  Goal kept as CONTEXT (autopilot does not run the judge, so it is not verified): "${st.goal.condition}"`);
    } else {
      console.log(`ℹ  Goal kept (reflection verifies it on each stop): "${st.goal.condition}"`);
    }
  }
}

// This CLI is the Claude Code control surface, so the runaway valve it reports
// is resolved through the SAME shared resolver as the Stop hook (retry > config
// (supervisor.yaml) > env > default), then reduced to CC's platform ceiling.
// Returns the descriptor so callers can render `unlimited` and the platform-cap
// note honestly instead of printing a number CC cannot actually honour.
function ccRunaway(sid) {
  const override = sid ? goalStore.load(cwd, sid).maxAttempts : undefined;
  return describeRunawayLimit({
    sessionOverride: override,
    config: readConfiguredMaxAttempts(() => {}),
    hardCap: resolveClaudeCodeHardCap(),
  });
}

// One-line human summary of a runaway descriptor for CLI output — Infinity-safe,
// and it says out loud when Claude Code's platform cap forced the number down
// below what was requested (including a requested `unlimited`, which CC cannot
// honour).
function runawayLine(desc) {
  const capNote = desc.cappedByPlatform
    ? ` (requested ${desc.unlimited ? 'unlimited' : desc.requested}, but Claude Code caps its Stop hook at ${desc.hardCap} = CLAUDE_CODE_STOP_HOOK_BLOCK_CAP - 1, so unlimited cannot be honoured on this runtime)`
    : '';
  return `Runaway safety valve: ${formatRunawayLimit(desc.limit)} injections per human turn${capNote} (tune with 'supervisor retry <N|unlimited>').`;
}

switch (cmd.kind) {
  // ── goal ──────────────────────────────────────────────────────────────────
  case 'goal-set': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setGoal(cwd, sid, cmd.condition);
    // Also persist to .agents/supervisor/Goal.md so reflection mode picks it up
    // across sessions. Safe under concurrent writers — see writeProjectGoal.
    writeProjectGoal(cwd, cmd.condition);
    const override = goalStore.load(cwd, sid).maxAttempts;
    // The Stop hook clamps the runaway safety valve to one under Claude Code's
    // own block-override threshold, so the effective valve here on CC is the
    // clamped number.
    const desc = describeRunawayLimit({ sessionOverride: override, config: readConfiguredMaxAttempts(() => {}), hardCap: resolveClaudeCodeHardCap() });
    console.log(
      `${GOAL_LABEL} set for session ${sid.slice(0, 8)}…: "${cmd.condition}".\n` +
      `The judge sees this as a mandatory completion requirement on every stop and keeps pushing until it is demonstrably met, or until you output SUPERVISOR_LOOP_EXIT: completed (alone on its own line).\n` +
      `${runawayLine(desc)} It resets each time you speak, so the goal is never permanently exhausted mid-session.\n` +
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
  case 'goal-resume': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const outcome = goalStore.resumeGoal(cwd, sid);
    if (!outcome.resumed) {
      // Honest, never a silent no-op — names the goal's ACTUAL current
      // status rather than pretending the resume happened.
      if (outcome.reason === 'no-goal') {
        console.log(`No ${GOAL_LABEL.toLowerCase()} set for session ${sid.slice(0, 8)}… — nothing to resume. Set one with 'supervisor set-goal <condition>'.`);
      } else if (outcome.reason === 'already-active') {
        console.log(`${GOAL_LABEL} for session ${sid.slice(0, 8)}… is already active (not paused): "${outcome.condition}". Nothing to resume.`);
      } else {
        console.log(`${GOAL_LABEL} for session ${sid.slice(0, 8)}… is ${outcome.status}, not paused — it cannot be resumed. Set a new one with 'supervisor set-goal <condition>'.`);
      }
      break;
    }
    // Never report success for a write that did not persist — read the
    // state back through the same load() path a fresh reader would use,
    // matching the FAILED-verification pattern used by supervisor off/on.
    const after = goalStore.load(cwd, sid);
    if (after.goal?.status !== 'active' || after.goal?.condition !== outcome.condition) {
      console.log(
        `FAILED to resume ${GOAL_LABEL.toLowerCase()} for session ${sid.slice(0, 8)}… — the change did not persist ` +
        `(status now: ${after.goal?.status ?? '(no goal)'}). Do not assume the goal is active.`
      );
      process.exit(1);
    }
    console.log(
      `${GOAL_LABEL} resumed for session ${sid.slice(0, 8)}… (was ${outcome.previousStatus}): "${outcome.condition}".\n` +
      `Attempt budget reset for this turn; the supervisor will keep pushing until it's met (or the retry budget runs out).`
    );
    break;
  }
  case 'goal-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    if (st.goal) {
      console.log(
        `${GOAL_LABEL} (${st.goal.status}): ${st.goal.condition}\n` +
        `attempts: ${st.goal.attempts}` +
        (st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : '') +
        goalResumeHintSuffix(st.goal)
      );
      break;
    }
    // No session goal. Binding contract (align-supervisor-modes): set-goal
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
    // cmd.n is a positive integer or the string 'unlimited' (0/off/none →
    // 'unlimited' upstream). Persist as-is; the store/resolver understand both.
    goalStore.setRetry(cwd, sid, cmd.n);
    const desc = ccRunaway(sid);
    if (desc.unlimited && !desc.cappedByPlatform) {
      console.log(
        `Runaway safety valve set to UNLIMITED for session ${sid.slice(0, 8)}… — no attempt cap. ` +
        `The loop now stops only on SUPERVISOR_LOOP_EXIT, the no-progress gate, a goal deadline, or 'supervisor off'.`
      );
    } else if (desc.cappedByPlatform) {
      console.log(
        `Runaway safety valve set to ${cmd.n} for session ${sid.slice(0, 8)}…, but Claude Code caps its Stop hook at ` +
        `${desc.hardCap} (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP - 1), so the effective valve on this runtime is ${desc.limit} injections per human turn. ` +
        `${desc.unlimited ? 'Unlimited cannot be honoured on Claude Code.' : ''}`.trim()
      );
    } else {
      console.log(`Runaway safety valve set to ${desc.limit} injections per human turn for session ${sid.slice(0, 8)}….`);
    }
    break;
  }
  case 'retry-invalid': {
    // A number the operator explicitly typed is never silently rewritten (2a):
    // reject loudly and name the accepted range instead of clamping.
    console.log(
      `✗ Invalid retry value "${cmd.raw}". Use a positive integer (honoured verbatim, no upper clamp), ` +
      `or one of unlimited/off/none/0 to remove the cap entirely. The runaway valve was NOT changed.`
    );
    process.exit(1);
    break;
  }
  case 'retry-status': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    const st = goalStore.load(cwd, sid);
    const desc = ccRunaway(sid);
    console.log(
      `Runaway safety valve (session override): ${st.maxAttempts != null ? formatRunawayLimit(st.maxAttempts) : '(none — using default/config/env)'}; ` +
      `in effect: ${formatRunawayLimit(desc.limit)} injections per human turn (tier: ${desc.tier})` +
      `${desc.cappedByPlatform ? ` — reduced from ${desc.unlimited ? 'unlimited' : desc.requested} by Claude Code's Stop-hook cap of ${desc.hardCap}` : ''}.\n` +
      `The loop's real stop is SUPERVISOR_LOOP_EXIT, not this number.`
    );
    break;
  }

  // ── mode-set ──────────────────────────────────────────────────────────────
  case 'mode-set': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setMode(cwd, sid, cmd.mode);
    // A mode switch KEEPS any active goal now (a goal is an attribute, not a
    // mode) — announce that instead of silently clearing it.
    noteGoalKeptOnModeSwitch(cwd, sid, cmd.mode);
    const desc = ccRunaway(sid);
    console.log(`mode: ${cmd.mode}`);
    if (cmd.mode === 'autopilot') {
      console.log(
        `Autopilot on — supervisor will auto-continue without judge until you output SUPERVISOR_LOOP_EXIT: completed (alone on its own line).\n` +
        `${runawayLine(desc)}`
      );
    } else if (cmd.mode === 'reflection') {
      console.log('Supervisor back to reflection mode (judge runs on each stop).');
    }
    break;
  }

  // ── autopilot-on ──────────────────────────────────────────────────────────
  case 'autopilot-on': {
    if (!sid) { console.log(NO_SESSION_MSG); process.exit(0); }
    goalStore.setAutopilot(cwd, sid, true);
    // Autopilot KEEPS any active goal as context now (it is not verified).
    noteGoalKeptOnModeSwitch(cwd, sid, 'autopilot');
    const desc = ccRunaway(sid);
    console.log('mode: autopilot');
    console.log(
      `Autopilot on — supervisor will auto-continue without judge until you output SUPERVISOR_LOOP_EXIT: completed (alone on its own line).\n` +
      `${runawayLine(desc)}`
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
