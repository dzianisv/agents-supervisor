import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

test('plugin.json does NOT declare hooks when hooks/hooks.json exists (duplicate-load guard)', () => {
  // Regression: Claude Code auto-loads hooks/hooks.json. Also declaring
  // manifest.hooks pointing at the same file makes the plugin FAIL TO LOAD
  // ("Duplicate hooks file detected"). `claude plugin validate` does NOT catch it.
  const manifest = read('.claude-plugin/plugin.json');
  const autoLoaded = fs.existsSync(path.join(ROOT, 'hooks', 'hooks.json'));
  if (autoLoaded) {
    assert.equal(manifest.hooks, undefined,
      'hooks/hooks.json is auto-loaded; remove the "hooks" field from plugin.json');
  }
  assert.equal(manifest.name, 'supervisor');
});

test('hooks/hooks.json registers the Stop hook → bin/supervisor-on-stop.mjs', () => {
  const h = read('hooks/hooks.json');
  const cmd = h.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? '';
  assert.match(cmd, /supervisor-on-stop\.mjs/);
  assert.match(cmd, /CLAUDE_PLUGIN_ROOT/);
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'supervisor-on-stop.mjs')));
});

test('bundled skills exist with frontmatter names → /supervisor:{train,status,set-goal,retry,on,off,autopilot,reflection}', () => {
  for (const name of ['train', 'status', 'set-goal', 'retry', 'on', 'off', 'autopilot', 'reflection']) {
    const p = path.join(ROOT, 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(p), `skills/${name}/SKILL.md missing`);
    const fm = fs.readFileSync(p, 'utf8').slice(0, 400);
    assert.match(fm, new RegExp(`name:\\s*${name}`), `skills/${name} frontmatter name`);
  }
});

test('OpenCode command files mirror the Claude Code skill names', () => {
  const dir = path.join(ROOT, 'opencode', 'commands');
  const found = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(found, [
    'supervisor.md',
    'supervisor:autopilot.md',
    'supervisor:off.md',
    'supervisor:on.md',
    // OpenCode-ONLY, deliberately with no skills/plain counterpart: plainspeak
    // on Claude Code is a separate Stop hook toggled by `.plainspeak/disabled`
    // / PLAINSPEAK_DISABLED, not by a /supervisor:* command. Adding a Claude
    // Code skill here would advertise a toggle that runtime does not read.
    'supervisor:plain.md',
    'supervisor:reflection.md',
    'supervisor:retry.md',
    'supervisor:set-goal.md',
    'supervisor:status.md',
    'supervisor:train.md',
  ].sort());
});

test('no user-facing surface tells anyone to type the retired goal command', () => {
  // Regression guard. The command was renamed goal -> objective (PR #41, b2a28a4),
  // then goal -> set-goal on the Claude Code side only (#43, 0d8ead8). Merge
  // 27d873e reconciled those by keeping set-goal, but never touched OpenCode, so
  // /supervisor:goal survived there for weeks. Pin it so a merge can't resurrect it.
  //
  // Both spellings are banned: `/supervisor:goal` (colon, OpenCode command file)
  // and `/supervisor goal` (space, bare dispatcher) — the second is what the
  // Claude Code skill's own description and H1 still advertised after the
  // colon-only sweep, which is the exact hole that let this stay visible.
  const banned = [/\/supervisor:goal\b/, /\/supervisor goal\b/];
  const surfaces = [
    ...fs.readdirSync(path.join(ROOT, 'skills'))
      .map((d) => path.join('skills', d, 'SKILL.md')),
    ...fs.readdirSync(path.join(ROOT, 'opencode', 'commands'))
      .map((f) => path.join('opencode', 'commands', f)),
    'opencode/supervisor-impl.ts',
    'core/goal.mjs',
    'bin/supervisor.mjs',
    'bin/supervisor-goal.mjs',
  ];
  for (const rel of surfaces) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const re of banned) {
      assert.ok(!re.test(src),
        `${rel} still references ${re.source.replace(/\\/g, '')} — use /supervisor:set-goal`);
    }
  }
});

test('every documented command name actually parses (docs cannot drift from the parser)', async () => {
  // The colon-only sweep documented `/supervisor set-goal` in the README and the
  // OpenCode routing template while the parser still only knew `goal` — so the
  // documented command silently fell through to "status". Pin both directions.
  const { parseSupervisorCommand } = await import('../core/goal.mjs');
  assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal tests pass'),
    { kind: 'goal-set', condition: 'tests pass' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal clear'), { kind: 'goal-clear' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal'), { kind: 'goal-status' });
  assert.deepEqual(parseSupervisorCommand('set-goal', 'tests pass'),
    { kind: 'goal-set', condition: 'tests pass' });
  // legacy alias must keep working for anyone with muscle memory
  assert.deepEqual(parseSupervisorCommand('supervisor', 'goal tests pass'),
    { kind: 'goal-set', condition: 'tests pass' });
  assert.deepEqual(parseSupervisorCommand('goal', 'tests pass'),
    { kind: 'goal-set', condition: 'tests pass' });
  // resume: a paused/exhausted goal is not a dead end — see goal-lifecycle.test.mjs
  assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal resume'), { kind: 'goal-resume' });
  assert.deepEqual(parseSupervisorCommand('set-goal', 'resume'), { kind: 'goal-resume' });
  assert.deepEqual(parseSupervisorCommand('supervisor', 'set-goal unpause'), { kind: 'goal-resume' });
});

test('marketplace.json lists supervisor with source "."', () => {
  const mk = read('.claude-plugin/marketplace.json');
  assert.equal(mk.name, 'agents-supervisor');
  const sup = (mk.plugins ?? []).find((p) => p.name === 'supervisor');
  assert.ok(sup, 'supervisor plugin entry');
  assert.equal(sup.source, '.');
});
