import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install, uninstall } from '../bin/install-codex.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-test-'));
  const home = path.join(root, 'codex-home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}

test('installer safely merges, copies only runtime files, backs up, and is idempotent', () => {
  const { root, home, project } = setup();
  try {
    const hooksFile = path.join(home, 'hooks.json');
    fs.writeFileSync(hooksFile, JSON.stringify({ keep: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing hook' }] }] } }));
    fs.mkdirSync(path.join(project, '.supervisor'), { recursive: true });
    fs.writeFileSync(path.join(project, '.supervisor', 'codex.json'), JSON.stringify({ enabled: false, reviewerTimeoutMs: 12000, observer: { everyToolCalls: 7, custom: 'keep' } }));
    const result = install(project, home);
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.equal(hooks.keep, true);
    assert.equal(hooks.hooks.Stop.length, 2);
    assert.equal(hooks.hooks.PostToolUse[0].matcher, '*');
    assert.equal(hooks.hooks.PostToolUse[0].hooks[0].async, true);
    assert.ok(hooks.hooks.Stop[1].hooks[0].command.includes(path.join(home, 'local-plugins', 'agents-supervisor')));
    assert.equal(hooks.hooks.Stop[1].hooks[0].command.includes('${PLUGIN_ROOT}'), false);
    const config = JSON.parse(fs.readFileSync(path.join(project, '.supervisor', 'codex.json'), 'utf8'));
    assert.equal(config.enabled, true, 'explicit install enables this project');
    assert.equal(config.reviewerTimeoutMs, 12000);
    assert.equal(config.observer.enabled, true);
    assert.equal(config.observer.everyToolCalls, 7);
    assert.equal(config.observer.custom, 'keep');
    assert.equal(fs.statSync(result.hookBackup).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, 'local-plugins/agents-supervisor/bin/install-codex.mjs')), false);
    assert.equal(fs.existsSync(path.join(home, 'local-plugins/agents-supervisor/bin/codex-supervisor-hook.mjs')), true);
    install(project, home);
    assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer rejects malformed settings before any mutation', () => {
  const { root, home, project } = setup();
  try {
    fs.writeFileSync(path.join(home, 'hooks.json'), '{');
    assert.throws(() => install(project, home), /invalid JSON/);
    assert.equal(fs.existsSync(path.join(home, 'local-plugins')), false);
    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    fs.mkdirSync(path.join(project, '.supervisor'), { recursive: true });
    fs.writeFileSync(path.join(project, '.supervisor/codex.json'), '{');
    assert.throws(() => install(project, home), /invalid JSON/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8')), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uninstaller removes only its exact hooks and disables observer for the selected project', () => {
  const { root, home, project } = setup();
  try {
    install(project, home);
    const hooksFile = path.join(home, 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    hooks.hooks.Stop[0].hooks.push({ type: 'command', command: 'keep me' });
    fs.writeFileSync(hooksFile, JSON.stringify(hooks));
    const result = uninstall(project, home);
    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'keep me' }] }] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.supervisor/codex.json'), 'utf8')).observer.enabled, false);
    assert.equal(fs.existsSync(result.pluginRoot), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer shell-quotes special local paths and command does not evaluate path text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-quote-'));
  const marker = path.join(root, 'shell-ran');
  const home = path.join(root, `codex home $(touch ${marker}) \`echo unsafe\``);
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  try {
    install(project, home);
    const hooks = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
    const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(command.startsWith(`'${process.execPath}' '`));
    const installedRoot = fs.realpathSync(path.join(home, 'local-plugins', 'agents-supervisor'));
    assert.ok(command.includes(`'${installedRoot.replaceAll("'", "'\\''")}/bin/codex-supervisor-hook.mjs'`));
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', turn_id: 't1', prompt: 'hello' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(fs.existsSync(marker), false, 'shell syntax inside the literal path must not execute');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer migrates old unquoted own commands without duplicating hooks or dropping siblings', () => {
  const { root, home, project } = setup();
  try {
    const pluginRoot = path.join(home, 'local-plugins', 'agents-supervisor');
    const script = path.join(pluginRoot, 'bin', 'codex-supervisor-hook.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(path.join(project, '.supervisor'), { recursive: true });
    fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: {
      Stop: [{ matcher: 'legacy', hooks: [
        { type: 'command', command: `${process.execPath} ${script}` },
        { type: 'command', command: 'unrelated sibling' },
      ] }],
    } }));
    install(project, home);
    const hooksFile = path.join(home, 'hooks.json');
    let stop = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop;
    assert.equal(stop.length, 2);
    assert.equal(stop[0].matcher, 'legacy');
    assert.deepEqual(stop[0].hooks, [{ type: 'command', command: 'unrelated sibling' }]);
    assert.ok(stop[1].hooks[0].command.includes(script));
    install(project, home);
    stop = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks.Stop;
    assert.equal(stop.filter((group) => group.hooks.some((hook) => hook.command.includes(script))).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
