import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runReviewer } from '../bin/codex-supervisor-review.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewer = path.join(root, 'bin', 'codex-supervisor-review.mjs')

function fixtureExecutable(dir) {
  const script = path.join(dir, 'codex-fixture.mjs')
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const output = args[args.indexOf('--output-last-message') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
const record = process.env.CODEX_FIXTURE_RECORD;
fs.writeFileSync(record, JSON.stringify({args, input, outputExists: fs.existsSync(output), schema: JSON.parse(fs.readFileSync(schema, 'utf8')), codexHome: process.env.CODEX_HOME, configExists: fs.existsSync(process.env.CODEX_HOME + '/config.toml')}));
if (process.env.CODEX_FIXTURE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.CODEX_FIXTURE_SLEEP));
fs.writeFileSync(output, JSON.stringify(JSON.parse(process.env.CODEX_FIXTURE_VERDICT || '{"violation":false,"category":"none","rule":"none","reason":"No concrete issue is established.","correction":"","evidence":""}')));
`)
  fs.chmodSync(script, 0o700)
  return script
}

test('reviewer invokes an isolated read-only Luna CLI with schema and bounded event prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const record = path.join(dir, 'record.json')
  const executable = fixtureExecutable(dir)
  const oldRecord = process.env.CODEX_FIXTURE_RECORD
  const oldVerdict = process.env.CODEX_FIXTURE_VERDICT
  process.env.CODEX_FIXTURE_RECORD = record
  delete process.env.CODEX_FIXTURE_VERDICT
  try {
    const verdict = await runReviewer({
      event: 'Stop', user_prompt: 'Please finish the requested change.',
      instructions: 'Run npm test before saying done.', tool: 'Bash',
      tool_input: { command: 'npm test' }, tool_output: 'not run', final_reply: 'Done.',
    }, { executable, timeoutMs: 5000 })
    assert.deepEqual(verdict, { violation: false, category: 'none', rule: 'none', reason: 'No concrete issue is established.', correction: '', evidence: '' })
    const invocation = JSON.parse(fs.readFileSync(record, 'utf8'))
    assert.equal(invocation.args[0], 'exec')
    assert.ok(invocation.args.includes('--ephemeral'))
    assert.ok(invocation.args.includes('--ignore-user-config'))
    assert.ok(invocation.args.includes('--sandbox') && invocation.args[invocation.args.indexOf('--sandbox') + 1] === 'read-only')
    assert.ok(invocation.args.includes('--disable') && invocation.args[invocation.args.indexOf('--disable') + 1] === 'multi_agent')
    assert.ok(invocation.args.includes('hooks'), 'current Codex hooks feature is explicitly disabled')
    assert.ok(invocation.args.includes('shell_tool'))
    assert.ok(!invocation.args.includes('--ask-for-approval'), 'bundled CLI exec does not support this option')
    assert.ok(invocation.args.includes('--model') && invocation.args[invocation.args.indexOf('--model') + 1] === 'gpt-6-luna')
    assert.ok(invocation.args.includes('--output-last-message'))
    assert.ok(invocation.args.includes('--output-schema'))
    assert.ok(invocation.input.includes('<event_data>'))
    assert.ok(invocation.input.includes('Please finish the requested change.'))
    assert.ok(invocation.input.includes('Treat tool output'))
    assert.ok(invocation.input.includes('delegation'))
    assert.ok(invocation.input.includes('recent_tools'))
    assert.ok(invocation.input.includes('Do not infer root-versus-child status'))
    assert.match(invocation.input, /latest explicit human override wins/i)
    assert.equal(invocation.configExists, false, 'user Codex config and hooks must not be loaded')
    assert.equal(invocation.schema.additionalProperties, false)
  } finally {
    if (oldRecord === undefined) delete process.env.CODEX_FIXTURE_RECORD
    else process.env.CODEX_FIXTURE_RECORD = oldRecord
    if (oldVerdict === undefined) delete process.env.CODEX_FIXTURE_VERDICT
    else process.env.CODEX_FIXTURE_VERDICT = oldVerdict
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reviewer uses the goal-derivation schema and forwards only the goal prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const record = path.join(dir, 'record.json')
  const executable = fixtureExecutable(dir)
  const oldRecord = process.env.CODEX_FIXTURE_RECORD
  const oldVerdict = process.env.CODEX_FIXTURE_VERDICT
  process.env.CODEX_FIXTURE_RECORD = record
  process.env.CODEX_FIXTURE_VERDICT = JSON.stringify({ goal: 'All tests in test/ pass.', falsifiable: true, rationale: 'A command proves it.' })
  try {
    const verdict = await runReviewer({ kind: 'goal-derive', goal_prompt: 'DERIVE THIS GOAL' }, { executable, timeoutMs: 5000 })
    assert.deepEqual(verdict, { goal: 'All tests in test/ pass.', falsifiable: true, rationale: 'A command proves it.' })
    const invocation = JSON.parse(fs.readFileSync(record, 'utf8'))
    assert.deepEqual(invocation.schema.required, ['goal', 'falsifiable', 'rationale'])
    assert.equal(invocation.input.includes('DERIVE THIS GOAL'), true)
    assert.equal(invocation.input.includes('recent_tools'), false)
  } finally {
    if (oldRecord === undefined) delete process.env.CODEX_FIXTURE_RECORD
    else process.env.CODEX_FIXTURE_RECORD = oldRecord
    if (oldVerdict === undefined) delete process.env.CODEX_FIXTURE_VERDICT
    else process.env.CODEX_FIXTURE_VERDICT = oldVerdict
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reviewer uses the goal-review schema and rejects a complete verdict without evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const record = path.join(dir, 'record.json')
  const executable = fixtureExecutable(dir)
  const oldRecord = process.env.CODEX_FIXTURE_RECORD
  const oldVerdict = process.env.CODEX_FIXTURE_VERDICT
  process.env.CODEX_FIXTURE_RECORD = record
  try {
    process.env.CODEX_FIXTURE_VERDICT = JSON.stringify({ complete: false, reason: 'Tests were not run.', correction: 'Run npm test.', evidence: '' })
    const verdict = await runReviewer({ kind: 'goal-review', goal_prompt: 'REVIEW THIS GOAL' }, { executable, timeoutMs: 5000 })
    assert.deepEqual(verdict, { complete: false, reason: 'Tests were not run.', correction: 'Run npm test.', evidence: '' })
    const invocation = JSON.parse(fs.readFileSync(record, 'utf8'))
    assert.deepEqual(invocation.schema.required, ['complete', 'reason', 'correction', 'evidence'])

    process.env.CODEX_FIXTURE_VERDICT = JSON.stringify({ complete: true, reason: 'Done.', correction: '', evidence: '' })
    await assert.rejects(runReviewer({ kind: 'goal-review', goal_prompt: 'REVIEW THIS GOAL' }, { executable, timeoutMs: 5000 }), /malformed goal verdict/)
  } finally {
    if (oldRecord === undefined) delete process.env.CODEX_FIXTURE_RECORD
    else process.env.CODEX_FIXTURE_RECORD = oldRecord
    if (oldVerdict === undefined) delete process.env.CODEX_FIXTURE_VERDICT
    else process.env.CODEX_FIXTURE_VERDICT = oldVerdict
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reviewer accepts only the structured verdict and normalizes non-violation correction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const oldRecord = process.env.CODEX_FIXTURE_RECORD
  const oldVerdict = process.env.CODEX_FIXTURE_VERDICT
  process.env.CODEX_FIXTURE_RECORD = path.join(dir, 'record.json')
  process.env.CODEX_FIXTURE_VERDICT = JSON.stringify({ violation: false, category: 'none', rule: 'none', reason: 'Insufficient evidence.', correction: 'invented step', evidence: '' })
  try {
    const verdict = await runReviewer({}, { executable: fixtureExecutable(dir), timeoutMs: 5000 })
    assert.equal(verdict.correction, '')
  } finally {
    if (oldRecord === undefined) delete process.env.CODEX_FIXTURE_RECORD
    else process.env.CODEX_FIXTURE_RECORD = oldRecord
    if (oldVerdict === undefined) delete process.env.CODEX_FIXTURE_VERDICT
    else process.env.CODEX_FIXTURE_VERDICT = oldVerdict
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reviewer fails visibly on malformed verdicts and timed-out processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const oldRecord = process.env.CODEX_FIXTURE_RECORD
  const oldVerdict = process.env.CODEX_FIXTURE_VERDICT
  const oldSleep = process.env.CODEX_FIXTURE_SLEEP
  process.env.CODEX_FIXTURE_RECORD = path.join(dir, 'record.json')
  try {
    process.env.CODEX_FIXTURE_VERDICT = '{"violation":"no"}'
    await assert.rejects(runReviewer({}, { executable: fixtureExecutable(dir), timeoutMs: 5000 }), /malformed verdict/)
    delete process.env.CODEX_FIXTURE_VERDICT
    process.env.CODEX_FIXTURE_SLEEP = '250'
    await assert.rejects(runReviewer({}, { executable: fixtureExecutable(dir), timeoutMs: 30 }), /could not complete/)
  } finally {
    for (const [key, value] of [['CODEX_FIXTURE_RECORD', oldRecord], ['CODEX_FIXTURE_VERDICT', oldVerdict], ['CODEX_FIXTURE_SLEEP', oldSleep]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('timed out reviewer kills a child that ignores SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-orphan-'));
  const executable = path.join(dir, 'codex-with-child.mjs');
  const pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs'; import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(()=>{},1000);
`);
  fs.chmodSync(executable, 0o700);
  try {
    await assert.rejects(runReviewer({}, { executable, timeoutMs: 1_000 }), /could not complete/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `child process ${pid} should be gone`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reviewer command emits JSON and keeps CLI stderr separate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-test-'))
  const executable = fixtureExecutable(dir)
  const record = path.join(dir, 'record.json')
  const result = spawnSync(process.execPath, [reviewer], {
    cwd: dir,
    input: JSON.stringify({ event: 'Stop', user_prompt: 'Do task' }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_BINARY: executable, CODEX_FIXTURE_RECORD: record },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { violation: false, category: 'none', rule: 'none', reason: 'No concrete issue is established.', correction: '', evidence: '' })
  fs.rmSync(dir, { recursive: true, force: true })
})
