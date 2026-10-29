#!/usr/bin/env node
/** Install the Codex supervisor hooks (observer and optional goal mode) for one project. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILES = [
  ['bin/codex-supervisor-hook.mjs', 'bin/codex-supervisor-hook.mjs'],
  ['bin/codex-supervisor-review.mjs', 'bin/codex-supervisor-review.mjs'],
  ['bin/supervisor.mjs', 'bin/supervisor.mjs'],
  ['core/codex-observer.mjs', 'core/codex-observer.mjs'],
  ['core/codex-goal.mjs', 'core/codex-goal.mjs'],
  ['core/goal.mjs', 'core/goal.mjs'],
  ['core/session-store.mjs', 'core/session-store.mjs'],
  ['core/loop-exit.mjs', 'core/loop-exit.mjs'],
  ['core/feedback.mjs', 'core/feedback.mjs'],
  ['core/evaluation.mjs', 'core/evaluation.mjs'],
  ['core/status-directive.mjs', 'core/status-directive.mjs'],
];

function usage() {
  return 'Usage: node bin/install-codex.mjs --project /absolute/project/path';
}

function parseArgs(argv) {
  let project;
  let uninstall = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) project = argv[++i];
    else if (argv[i] === '--uninstall') uninstall = true;
    else throw new Error(usage());
  }
  if (!project || !path.isAbsolute(project)) throw new Error(`${usage()}\n--project must be an absolute path`);
  return { project: path.resolve(project), uninstall };
}

function readJson(file, label) {
  if (!fs.existsSync(file)) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot install: ${label} is invalid JSON (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Cannot install: ${label} must contain a JSON object`);
  return value;
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replaceAll(':', '-');
  let target = `${file}.bak-${stamp}`;
  for (let i = 1; fs.existsSync(target); i++) target = `${file}.bak-${stamp}-${i}`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.closeSync(fd);
    fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    try { fs.unlinkSync(target); } catch { /* best effort cleanup */ }
    throw error;
  }
  return target;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = '';
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) { word += character; escaped = false; started = true; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped) word += '\\';
  if (started) words.push(word);
  return words;
}

function hookDefinitions(pluginRoot) {
  const script = path.join(pluginRoot, 'bin', 'codex-supervisor-hook.mjs');
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  const entry = (timeout, async = false) => ({ hooks: [{ type: 'command', command, timeout, ...(async ? { async: true } : {}) }] });
  return {
    UserPromptSubmit: [entry(10)],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 120, async: true }] }],
    Stop: [entry(120)],
  };
}

function isOwnedHook(hook, script) {
  if (typeof hook?.command !== 'string') return false;
  // Older registrations can spell the same home through a symlink alias,
  // such as /var/... versus /private/var/... on macOS. Tokenize without
  // evaluating shell syntax, then compare canonical script paths.
  const args = shellWords(hook.command);
  if (args.length < 2) return false;
  try { return canonicalPath(args[1]) === canonicalPath(script); }
  catch { return false; }
}

function mergeOwnedGroups(existingGroups, desiredGroup, script) {
  const output = [];
  for (const group of existingGroups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some((hook) => isOwnedHook(hook, script))) {
      output.push(group);
      continue;
    }
    const retained = group.hooks.filter((hook) => !isOwnedHook(hook, script));
    if (retained.length) output.push({ ...group, hooks: retained });
  }
  // Keep the observer's canonical matcher/timeout while retaining any
  // unrelated hooks that shared its older group.
  output.push(desiredGroup);
  return output;
}

function install(project, codexHome) {
  codexHome = canonicalPath(codexHome);
  project = canonicalPath(project);
  if (!fs.statSync(project).isDirectory()) throw new Error(`Project path is not a directory: ${project}`);
  for (const [source] of RUNTIME_FILES) {
    if (!fs.statSync(path.join(ROOT, source)).isFile()) throw new Error(`Runtime source is missing: ${source}`);
  }
  const pluginRoot = canonicalPath(path.join(codexHome, 'local-plugins', 'agents-supervisor'));
  const hooksFile = path.join(codexHome, 'hooks.json');
  const projectConfigFile = path.join(project, '.supervisor', 'codex.json');
  const hooksDoc = readJson(hooksFile, hooksFile);
  const projectConfig = readJson(projectConfigFile, projectConfigFile);
  if (hooksDoc.hooks !== undefined && (!hooksDoc.hooks || typeof hooksDoc.hooks !== 'object' || Array.isArray(hooksDoc.hooks))) {
    throw new Error(`Cannot install: ${hooksFile} hooks must be an object`);
  }
  if (projectConfig.observer !== undefined && (!projectConfig.observer || typeof projectConfig.observer !== 'object' || Array.isArray(projectConfig.observer))) {
    throw new Error(`Cannot install: ${projectConfigFile} observer must be an object`);
  }

  const nextHooks = { ...hooksDoc, hooks: { ...(hooksDoc.hooks ?? {}) } };
  const additions = hookDefinitions(pluginRoot);
  const ownedScript = path.join(pluginRoot, 'bin', 'codex-supervisor-hook.mjs');
  for (const [event, groups] of Object.entries(additions)) {
    const existing = nextHooks.hooks[event] ?? [];
    if (!Array.isArray(existing)) throw new Error(`Cannot install: ${hooksFile} hooks.${event} must be an array`);
    nextHooks.hooks[event] = mergeOwnedGroups(existing, groups[0], ownedScript);
  }
  const nextProjectConfig = {
    ...projectConfig,
    enabled: true,
    observer: { ...(projectConfig.observer ?? {}), enabled: true, everyToolCalls: projectConfig.observer?.everyToolCalls ?? 10 },
  };

  // Validate all source inputs before changing either destination.
  const copiedFiles = RUNTIME_FILES.map(([source, target]) => [path.join(ROOT, source), path.join(pluginRoot, target)]);
  const hookText = `${JSON.stringify(nextHooks, null, 2)}\n`;
  const projectText = `${JSON.stringify(nextProjectConfig, null, 2)}\n`;

  fs.mkdirSync(path.join(codexHome, 'local-plugins'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
  for (const [source, target] of copiedFiles) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(source, temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
  }

  const hookBackup = backup(hooksFile);
  const projectBackup = backup(projectConfigFile);
  atomicWrite(hooksFile, hookText);
  atomicWrite(projectConfigFile, projectText);
  return { pluginRoot, hooksFile, projectConfigFile, hookBackup, projectBackup };
}

function uninstall(project, codexHome) {
  codexHome = canonicalPath(codexHome);
  project = canonicalPath(project);
  const pluginRoot = canonicalPath(path.join(codexHome, 'local-plugins', 'agents-supervisor'));
  const hooksFile = path.join(codexHome, 'hooks.json');
  const projectConfigFile = path.join(project, '.supervisor', 'codex.json');
  const hooksDoc = readJson(hooksFile, hooksFile);
  const projectConfig = readJson(projectConfigFile, projectConfigFile);
  const nextHooks = { ...hooksDoc, hooks: { ...(hooksDoc.hooks ?? {}) } };
  for (const [event, groups] of Object.entries(nextHooks.hooks)) {
    if (!Array.isArray(groups)) continue;
    nextHooks.hooks[event] = groups.map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      return { ...group, hooks: group.hooks.filter((hook) => !isOwnedHook(hook, path.join(pluginRoot, 'bin', 'codex-supervisor-hook.mjs'))) };
    }).filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (!nextHooks.hooks[event].length) delete nextHooks.hooks[event];
  }
  const nextProjectConfig = { ...projectConfig };
  if (nextProjectConfig.observer && typeof nextProjectConfig.observer === 'object' && !Array.isArray(nextProjectConfig.observer)) {
    nextProjectConfig.observer = { ...nextProjectConfig.observer, enabled: false };
  }
  const hookBackup = backup(hooksFile);
  const projectBackup = backup(projectConfigFile);
  if (fs.existsSync(hooksFile)) atomicWrite(hooksFile, `${JSON.stringify(nextHooks, null, 2)}\n`);
  if (fs.existsSync(projectConfigFile)) atomicWrite(projectConfigFile, `${JSON.stringify(nextProjectConfig, null, 2)}\n`);
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  return { pluginRoot, hooksFile, projectConfigFile, hookBackup, projectBackup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const result = args.uninstall ? uninstall(args.project, codexHome) : install(args.project, codexHome);
    process.stdout.write(`${args.uninstall ? 'Removed' : 'Installed'} Codex supervisor runtime at ${result.pluginRoot}\nUpdated hooks in ${result.hooksFile}\nUpdated project setting in ${result.projectConfigFile}\n`);
    if (result.hookBackup) process.stdout.write(`Backup: ${result.hookBackup}\n`);
    if (result.projectBackup) process.stdout.write(`Backup: ${result.projectBackup}\n`);
    process.stdout.write('Review and trust the hook definitions in Codex with /hooks.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { install, parseArgs, uninstall };
