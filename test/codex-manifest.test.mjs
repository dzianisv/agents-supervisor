import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'))
const codexHooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/codex-hooks.json'), 'utf8'))
const claudeHooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'))

test('Codex manifest selects its own hook file and plugin-root command', () => {
  assert.equal(manifest.hooks, './hooks/codex-hooks.json')
  assert.notEqual(manifest.hooks, './hooks/hooks.json')
  assert.equal(manifest.skills, './codex-skills/')

  const events = codexHooks.hooks
  assert.deepEqual(Object.keys(events).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit'].sort())
  assert.equal(events.PostToolUse[0].matcher, '*')
  assert.equal(events.PostToolUse[0].hooks[0].async, true)
  assert.equal(events.PostToolUse[0].hooks[0].timeout, 120)
  assert.equal(events.UserPromptSubmit.length, 1)
  assert.equal(events.Stop.length, 1)
  assert.equal('PreToolUse' in events, false)

  for (const groups of Object.values(events)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.match(hook.command, /\$\{PLUGIN_ROOT\}\/bin\/codex-supervisor-hook\.mjs/)
        assert.ok(hook.timeout >= 10)
      }
    }
  }
})

test('Codex and Claude Code hook files remain separate', () => {
  assert.deepEqual(Object.keys(claudeHooks.hooks), ['Stop'])
  assert.ok(codexHooks.hooks.UserPromptSubmit)
  assert.ok(codexHooks.hooks.PostToolUse)
})
