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

test('hooks/hooks.json registers the Stop hook → bin/on-stop.mjs', () => {
  const h = read('hooks/hooks.json');
  const cmd = h.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? '';
  assert.match(cmd, /on-stop\.mjs/);
  assert.match(cmd, /CLAUDE_PLUGIN_ROOT/);
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'on-stop.mjs')));
});

test('bundled skills exist with frontmatter names → /supervisor:train, /supervisor:status', () => {
  for (const name of ['train', 'status']) {
    const p = path.join(ROOT, 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(p), `skills/${name}/SKILL.md missing`);
    const fm = fs.readFileSync(p, 'utf8').slice(0, 400);
    assert.match(fm, new RegExp(`name:\\s*${name}`), `skills/${name} frontmatter name`);
  }
});

test('marketplace.json lists supervisor with source "."', () => {
  const mk = read('.claude-plugin/marketplace.json');
  assert.equal(mk.name, 'agents-supervisor');
  const sup = (mk.plugins ?? []).find((p) => p.name === 'supervisor');
  assert.ok(sup, 'supervisor plugin entry');
  assert.equal(sup.source, '.');
});
