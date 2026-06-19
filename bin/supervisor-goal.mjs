#!/usr/bin/env node
/**
 * supervisor-goal.mjs — thin shim that delegates to bin/supervisor.mjs.
 *
 * Kept for backwards-compatibility: /supervisor:goal and /supervisor:retry
 * skills call this script directly. All logic now lives in supervisor.mjs.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const supervisor = path.join(__dirname, 'supervisor.mjs');

// Re-dispatch with the same argv array (no shell quoting — args passed directly).
try {
  execFileSync('node', [supervisor, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
