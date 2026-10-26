#!/usr/bin/env node
/**
 * run-train.mjs — orchestrator for /supervisor:train.
 *
 * Pipeline (all local; nothing committed to git):
 *   1. mine    — build_dataset.py mines recent sessions (OpenCode DBs + Claude
 *                transcripts) into .dataset/ + _analysis/summary.json
 *   2. learn   — update_patterns.mjs derives refreshed weights/provenance and
 *                writes the USER-LOCAL patterns file (backup + structural validate)
 *   3. archive — (opt) hf_dataset.py pushes the private dataset to HuggingFace
 *
 * Flags:
 *   --since=<N>d   mining window (default 14d)
 *   --dry-run      preview the pattern diff; do not write user-local patterns
 *   --scope=user|project   where to write learned patterns (default user)
 *   --push-hf      also push the private dataset to HuggingFace
 *   --cwd=<dir>    project dir (default process.cwd())
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const since = getOpt('since', '14d');
const scope = getOpt('scope', 'user');
const cwd = getOpt('cwd', process.cwd());
const dryRun = hasFlag('dry-run');
const pushHf = hasFlag('push-hf');

const python = process.env.PYTHON || 'python3';

function run(label, cmd, args, opts = {}) {
  console.log(`\n=== ${label} ===\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, ...opts });
  if (r.error) {
    console.error(`${label}: failed to spawn — ${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`${label}: exited with code ${r.status}`);
    return false;
  }
  return true;
}

// 1. mine (incremental: --no-clean keeps prior corpus, refreshes touched sessions)
const mined = run('mine sessions', python, [
  path.join(HERE, 'build_dataset.py'),
  `--since=${since}`,
  '--no-clean',
]);
if (!mined) {
  console.error('\nsupervisor:train aborted — mining failed.');
  process.exit(1);
}

// 2. learn → user-local patterns
const learnArgs = [path.join(HERE, 'update_patterns.mjs'), '--scope', scope, '--cwd', cwd];
if (dryRun) learnArgs.push('--dry-run');
const learned = run('update patterns', 'node', learnArgs);
if (!learned) {
  console.error('\nsupervisor:train: pattern update failed (corpus kept).');
  process.exit(1);
}

// 3. archive to private HuggingFace (opt-in)
if (pushHf) {
  const pushed = run('push dataset → HuggingFace (private)', python, [path.join(HERE, 'hf_dataset.py'), 'push']);
  if (!pushed) console.error('supervisor:train: HF push failed (patterns already updated locally). Run `hf auth login` and retry --push-hf.');
}

console.log('\nsupervisor:train done.');
