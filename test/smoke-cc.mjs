#!/usr/bin/env node
/**
 * smoke-cc.mjs — live smoke test for the CC Stop hook on the agents-supervisor repo.
 *
 * Calls the real judge (claude -p) via SUPERVISOR_CC_LIVE=1 to verify:
 *   1. Transcript WITHOUT E2E tests run → hook blocks (judge says not complete)
 *   2. Transcript WITH both CC+OpenCode E2E tests passing → hook allows stop
 *
 * Requires: claude CLI in PATH with valid OAuth / ANTHROPIC_API_KEY.
 * Run: node test/smoke-cc.mjs   (also `npm run test:smoke`)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'bin', 'supervisor-on-stop.mjs');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
    pass++;
  } catch (e) {
    console.error(`✖ ${name}\n  ${e.message}`);
    fail++;
  }
}

function mkSession(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-smoke-'));
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, turns.map((t) => JSON.stringify(t)).join('\n'));
  return { dir, tp };
}

function runHook(payload, extraEnv = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SUPERVISOR_CC_LIVE: '1', ...extraEnv },
  });
  let verdict = null;
  try {
    const vf = path.join(payload.cwd, '.supervisor', `verdict_${payload.session_id}.json`);
    if (fs.existsSync(vf)) verdict = JSON.parse(fs.readFileSync(vf, 'utf8'));
  } catch { /* none */ }
  return { code: r.status, stdout: (r.stdout || '').trim(), verdict };
}

// ---------------------------------------------------------------------------
// Scenario 1: asked to run E2E tests, agent stopped without running any
// ---------------------------------------------------------------------------
const noTestsTurns = [
  {
    type: 'user',
    message: {
      role: 'user',
      content: 'run the e2e tests locally for both cc and opencode and confirm they pass',
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'test/e2e-cc.mjs' } },
        {
          type: 'text',
          text: "I've looked at the E2E test files. The tests look correct. Let me know if you'd like me to run them.",
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Scenario 2: agent ran both E2E suites and they passed — must allow stop
// ---------------------------------------------------------------------------
const withTestsTurns = [
  {
    type: 'user',
    message: {
      role: 'user',
      content: 'run the e2e tests locally for both cc and opencode and confirm they pass',
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'node test/e2e-cc.mjs' } },
        {
          type: 'tool_result',
          content: '✔ summary_drift_stop → injects {decision:block} + writes verdict\n✔ complete → no inject, clean exit, no stdout\n✔ loop guard (stop_hook_active) → no-op, no stdout\n✔ attempt cap → stops injecting after max attempts\n✔ goal active + judge complete → goal achieved, no inject\n✔ goal active + premature stop → goal-continue inject (mentions goal)\n✔ goal raises retry budget past the default 3 (injects a 4th time)\n\n7 passed, 0 failed (fake judge)',
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'node --experimental-strip-types --test test/e2e-opencode.test.mjs' },
        },
        {
          type: 'tool_result',
          content: '✔ opencode supervisor plugin E2E (114984ms)\nℹ tests 8\nℹ pass 8\nℹ fail 0',
        },
        {
          type: 'text',
          text: 'Both E2E suites pass: CC hook 7/7, OpenCode 8/8.',
        },
      ],
    },
  },
];

check('no E2E tests in transcript → hook blocks (live judge)', () => {
  const { dir, tp } = mkSession(noTestsTurns);
  const payload = {
    session_id: 'smoke-no-tests',
    cwd: dir,
    transcript_path: tp,
    last_assistant_message: noTestsTurns[1].message.content[1].text,
  };
  const { code, stdout } = runHook(payload);
  assert.equal(code, 0);
  assert.ok(stdout.length > 0, 'hook should output a block decision');
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block',
    `Expected block when E2E tests not run. Got: ${JSON.stringify(out)}`);
});

check('both E2E suites pass in transcript → hook allows stop (live judge)', () => {
  const { dir, tp } = mkSession(withTestsTurns);
  const payload = {
    session_id: 'smoke-with-tests',
    cwd: dir,
    transcript_path: tp,
    last_assistant_message: withTestsTurns[1].message.content[4].text,
  };
  const { code, stdout } = runHook(payload);
  assert.equal(code, 0);
  assert.equal(stdout, '', `Expected no block when E2E tests passed. Got stdout: ${stdout}`);
});

console.log(`\n${pass} passed, ${fail} failed (LIVE judge)`);
process.exit(fail === 0 ? 0 : 1);
