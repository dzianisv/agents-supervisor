/**
 * patterns.mjs — single source of truth for supervisor patterns/anti-patterns.
 *
 * Resolution order (later overrides earlier, deep-merged):
 *   1. shipped defaults: ./patterns.json (read-only, in the repo)
 *   2. user config:      ~/.config/agents-supervisor/patterns.json
 *   3. project:          <cwd>/.supervisor/patterns.json
 *
 * /supervisor:train writes ONLY the user-local file (default: the user-config
 * path, or the project path when --project is passed). The shipped defaults are
 * never mutated, so a repo update never clobbers learned patterns and learned
 * patterns are never committed upstream.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, 'patterns.json');

export function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'agents-supervisor', 'patterns.json');
}

export function projectPath(cwd = process.cwd()) {
  return join(cwd, '.supervisor', 'patterns.json');
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Deep-merge: objects merge recursively; arrays and scalars REPLACE wholesale. */
export function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base !== 'object' || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

/**
 * Load the effective pattern set (shipped ⊕ user-config ⊕ project).
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {object} merged patterns
 */
export function loadPatterns(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  let p = readJsonSafe(SHIPPED) ?? {};
  const userCfg = readJsonSafe(userConfigPath());
  if (userCfg) p = deepMerge(p, userCfg);
  const proj = readJsonSafe(projectPath(cwd));
  if (proj) p = deepMerge(p, proj);
  return p;
}

export function loadShipped() {
  return readJsonSafe(SHIPPED) ?? {};
}

/**
 * Write user-local patterns (backing up the prior file). Never touches shipped.
 * @param {object} patterns
 * @param {object} [opts] { scope: 'user'|'project', cwd }
 * @returns {{ path: string, backup: string|null }}
 */
export function writeUserPatterns(patterns, opts = {}) {
  const scope = opts.scope ?? 'user';
  const target = scope === 'project' ? projectPath(opts.cwd ?? process.cwd()) : userConfigPath();
  mkdirSync(dirname(target), { recursive: true });
  let backup = null;
  if (existsSync(target)) {
    backup = `${target}.bak`;
    copyFileSync(target, backup);
  }
  writeFileSync(target, JSON.stringify(patterns, null, 2) + '\n', 'utf8');
  return { path: target, backup };
}
