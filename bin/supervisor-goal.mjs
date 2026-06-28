#!/usr/bin/env node
/**
 * supervisor-goal.mjs — CLI for the Claude Code goal loop, invoked by the
 * /supervisor:goal and /supervisor:retry skills.
 *
 * Usage:
 *   node supervisor-goal.mjs goal [<condition> | clear | (empty=status)]
 *   node supervisor-goal.mjs retry [<n> | (empty=status)]
 *
 * Session id is read from <cwd>/.supervisor/current_session (written by the Stop
 * hook). State is stored per session via core/goal.mjs (.supervisor/goals/<sid>.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { goalStore, parseSupervisorCommand, resolveMaxAttempts } from '../core/goal.mjs';

const cwd = process.cwd();
const name = process.argv[2];
const args = process.argv.slice(3).join(' ');

function currentSession() {
  try {
    return fs.readFileSync(path.join(cwd, '.supervisor', 'current_session'), 'utf8').trim();
  } catch {
    return null;
  }
}

const sid = currentSession();
if (!sid) {
  console.log('No active session yet (.supervisor/current_session missing). Run something first so the Stop hook records the session, then retry.');
  process.exit(0);
}

// Handle 'mode' subcommand directly (e.g. node supervisor-goal.mjs mode reflection)
if (name === 'mode') {
  const validModes = ['reflection', 'autopilot', 'goal'];
  const requestedMode = args.trim().toLowerCase();
  if (!validModes.includes(requestedMode)) {
    console.log(`Unknown mode: "${requestedMode}". Valid modes: ${validModes.join(', ')}.`);
    process.exit(0);
  }
  goalStore.setMode(cwd, sid, requestedMode);
  const modeDesc = {
    reflection: 'judge runs patterns/antipatterns on each stop',
    autopilot: 'skips judge, always continues (call autopilot_exit when done)',
    goal: 'requires an active goal condition to be set',
  };
  console.log(`Supervisor mode set to ${requestedMode} for session ${sid.slice(0, 8)}… (${modeDesc[requestedMode]}).`);
  process.exit(0);
}

const cmd = parseSupervisorCommand(name, args);
switch (cmd.kind) {
  case 'goal-set': {
    goalStore.setGoal(cwd, sid, cmd.condition);
    // Also persist to .agents/supervisor/Goal.md so reflection mode picks it up across sessions.
    try {
      const goalDir = path.join(cwd, '.agents', 'supervisor');
      fs.mkdirSync(goalDir, { recursive: true });
      fs.writeFileSync(path.join(goalDir, 'Goal.md'), cmd.condition, 'utf8');
    } catch { /* best effort */ }
    console.log(`Goal set for session ${sid.slice(0, 8)}…: "${cmd.condition}".\nThe supervisor will keep pushing the agent until this is demonstrably met or the retry budget (${resolveMaxAttempts({ sessionOverride: goalStore.load(cwd, sid).maxAttempts })}) runs out.`);
    break;
  }
  case 'goal-clear': {
    goalStore.clearGoal(cwd, sid);
    console.log(`Goal cleared for session ${sid.slice(0, 8)}….`);
    break;
  }
  case 'goal-status': {
    const st = goalStore.load(cwd, sid);
    if (!st.goal) console.log('No goal set for this session.');
    else console.log(`Goal (${st.goal.status}): ${st.goal.condition}\nattempts: ${st.goal.attempts}${st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : ''}`);
    break;
  }
  case 'retry-set': {
    goalStore.setRetry(cwd, sid, cmd.n);
    console.log(`Retry budget set to ${resolveMaxAttempts({ sessionOverride: cmd.n })} for session ${sid.slice(0, 8)}….`);
    break;
  }
  case 'retry-status': {
    const st = goalStore.load(cwd, sid);
    console.log(`Retry budget (session override): ${st.maxAttempts ?? '(default 16 when a goal is active; 3 otherwise)'}.`);
    break;
  }
  default:
    console.log(`Unknown supervisor command: ${name}. Use "goal" or "retry".`);
}
