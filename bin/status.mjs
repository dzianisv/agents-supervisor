#!/usr/bin/env node
/**
 * status.mjs — print supervisor status for the current project.
 * Used by /supervisor:status. Read-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadPatterns, userConfigPath, projectPath } from '../core/patterns.mjs';
import { CATEGORY_NAMES } from '../core/judge-core.mjs';
import { injectCategories } from '../core/feedback-core.mjs';
import { goalStore, resolveSupervisorMode, isStatusDiagramEnabled, goalResumeHintSuffix } from '../core/goal.mjs';
import { resolveSessionId, listSessions, sessionStore } from '../core/session-store.mjs';

const cwd = process.cwd();
const patterns = loadPatterns({ cwd });

function line(label, val) {
  console.log(`${label.padEnd(22)} ${val}`);
}

console.log('# supervisor status\n');

line('shipped defaults', 'core/patterns.json (in plugin)');
line('user-config layer', existsSync(userConfigPath()) ? `PRESENT  ${userConfigPath()}` : `absent   (${userConfigPath()})`);
line('project layer', existsSync(projectPath(cwd)) ? `PRESENT  ${projectPath(cwd)}` : `absent   (${projectPath(cwd)})`);
console.log();

line('categories', CATEGORY_NAMES(patterns).join(', '));
line('inject categories', [...injectCategories(patterns)].join(', '));
line('max inject attempts', patterns?.feedback?.max_inject_attempt ?? 3);
const meta = patterns?.meta ?? {};
line('provenance', meta.dataset_size ? `${meta.dataset_size} stops, ${meta.premature_pct}% premature` : '(none)');
console.log();

// Recent verdicts
const stateDir = path.join(cwd, '.supervisor');
// `current_session` is a shared, last-writer-wins hint. Resolve through the
// same precedence the on/off path uses so `status` and `off` never disagree
// about which session they are talking about.
const resolution = resolveSessionId(cwd);
const cur = resolution.sessionId;
line('current session', cur ?? '(none recorded)');
if (cur) {
  const srcLabel = {
    explicit: 'explicit --session',
    'explicit-prefix': 'explicit prefix',
    env: `$${resolution.envVar ?? 'ENV'}`,
    current_session: '.supervisor/current_session (last session to stop here)',
    'sole-session': 'the only session known in this project',
  }[resolution.source] ?? resolution.source;
  line('session id source', srcLabel);
}

const allSessions = listSessions(cwd);
if (allSessions.length > 1) {
  line('sessions in project', `${allSessions.length} (use --session <id> to target one)`);
}

// Effective supervisor mode (from goal state for current session)
if (cur) {
  try {
    const goalState = goalStore.load(cwd, cur);
    const effectiveMode = resolveSupervisorMode(goalState);
    line('effective mode', effectiveMode);
    // Default-on: absent key reads as 'on'. Toggle with /supervisor:status off.
    line('status directive', isStatusDiagramEnabled(goalState) ? 'on' : 'off');
    // Goal detail — reported HONESTLY as a fact SEPARATE from the mode. A goal
    // is an orthogonal attribute now (not a mode), so 'effective mode' is only
    // ever 'autopilot' or 'reflection' and never reveals goal state on its own.
    // resolveSupervisorMode() ignores goal.status, so a paused or exhausted
    // goal must be surfaced explicitly here or it becomes a dead end nobody is
    // told about — see AGENTS.md's goal-resume section.
    if (goalState.goal) {
      const g = goalState.goal;
      line('goal status', g.status);
      line('goal condition', g.condition);
      line('goal attempts', String(g.attempts));
      if (g.lastReason) line('goal last reason', g.lastReason);
      const hint = goalResumeHintSuffix(g);
      if (hint) console.log(hint.trim());
    } else {
      line('goal status', '(none)');
    }
  } catch {
    line('effective mode', '(unknown)');
    line('status directive', 'on (default)');
  }
} else {
  line('effective mode', 'reflection (default — no session)');
  line('status directive', 'on (default — no session)');
}

let disabled = [];
try { disabled = readFileSync(path.join(stateDir, 'disabled'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { /* none */ }
line('session disabled?', cur && disabled.includes(cur) ? 'YES (supervisor off for this session)' : 'no');

// Judge reachability — written by bin/supervisor-on-stop.mjs on every
// assessment attempt: 'ok' after a successful judge call (real or fake),
// 'judge_unreachable' when callAnthropic threw (network/API failure).
try {
  const health = JSON.parse(readFileSync(path.join(stateDir, 'health.json'), 'utf8'));
  const detail = health.status === 'judge_unreachable' && health.error ? `  (${health.error})` : '';
  line('judge health', `${health.status ?? 'unknown'}${detail}  @ ${health.ts ?? '?'}`);
} catch {
  line('judge health', '(no signal yet)');
}
console.log();

console.log('## recent verdicts');
// New layout: .supervisor/sessions/<id>/verdicts.jsonl (append-only, full
// session id). readVerdicts falls back to the legacy verdict_<sid>.json for a
// session that has not been migrated yet.
try {
  const rows = [];
  const sessions = allSessions.length ? allSessions : (cur ? [{ id: cur }] : []);
  for (const s of sessions) {
    for (const v of sessionStore.readVerdicts(cwd, s.id, 5)) {
      rows.push({ sid: s.id, v, ts: Date.parse(v.ts ?? v.timestamp ?? 0) || 0 });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  if (rows.length === 0) console.log('  (none yet)');
  for (const { sid, v } of rows.slice(0, 5)) {
    // CC verdicts carry `status` (e.g. 'complete'/'in_progress'); older/
    // opencode-shaped records may carry neither — falls back to '?'.
    console.log(
      `  ${v.ts ?? v.timestamp ?? '?'}  [${sid.slice(0, 8)}]  ${v.status ?? v.category ?? v.kind ?? '?'}  inject=${v.injected}  ${v.reason ?? ''}`.slice(0, 180)
    );
  }
} catch {
  console.log('  (.supervisor/ not present — no sessions supervised here yet)');
}
