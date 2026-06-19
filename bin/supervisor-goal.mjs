#!/usr/bin/env node
/**
 * supervisor-goal.mjs — thin shim that delegates to bin/supervisor.mjs.
 *
 * Kept for backwards-compatibility: /supervisor:goal and /supervisor:retry
 * skills call this script directly. All logic now lives in supervisor.mjs.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const supervisor = path.join(__dirname, 'supervisor.mjs');

// Re-dispatch with the same argv (argv[0]=node, argv[1]=this script → replaced).
const args = process.argv.slice(2).map((a) => JSON.stringify(a)).join(' ');
try {
  const out = execSync(`node ${JSON.stringify(supervisor)} ${args}`, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  process.stdout.write(out);
} catch (err) {
  if (err.stdout) process.stdout.write(err.stdout);
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(err.status ?? 1);
}
