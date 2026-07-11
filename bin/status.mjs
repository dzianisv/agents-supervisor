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
import { goalStore, resolveSupervisorMode } from '../core/goal.mjs';

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
const cur = (() => { try { return readFileSync(path.join(stateDir, 'current_session'), 'utf8').trim(); } catch { return null; } })();
line('current session', cur ?? '(none recorded)');

// Effective supervisor mode (from goal state for current session)
if (cur) {
  try {
    const goalState = goalStore.load(cwd, cur);
    const effectiveMode = resolveSupervisorMode(goalState);
    line('effective mode', effectiveMode);
  } catch {
    line('effective mode', '(unknown)');
  }
} else {
  line('effective mode', 'reflection (default — no session)');
}

let disabled = [];
try { disabled = readFileSync(path.join(stateDir, 'disabled'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { /* none */ }
line('session disabled?', cur && disabled.includes(cur) ? 'YES (supervisor off for this session)' : 'no');
console.log();

console.log('## recent verdicts');
try {
  const files = fs.readdirSync(stateDir).filter((f) => f.startsWith('verdict_') && f.endsWith('.json'));
  const recent = files
    .map((f) => ({ f, m: fs.statSync(path.join(stateDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 5);
  if (recent.length === 0) console.log('  (none yet)');
  for (const { f } of recent) {
    try {
      const v = JSON.parse(readFileSync(path.join(stateDir, f), 'utf8'));
      console.log(`  ${v.timestamp ?? '?'}  ${v.category}  inject=${v.injected}  ${v.reason ?? ''}`.slice(0, 160));
    } catch { /* skip */ }
  }
} catch {
  console.log('  (.supervisor/ not present — no sessions supervised here yet)');
}
