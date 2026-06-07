import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  loopGuard, sanitizeCwd, readAttempts, writeAttemptCounter,
  writeVerdict, readTranscriptTail, buildStopContext,
} from '../bin/on-stop.mjs';

function mkcwd() {
  const d = fs.mkdtempSync(path.join(tmpdir(), 'sup-test-'));
  return d;
}

test('loopGuard fires only when stop_hook_active', () => {
  assert.equal(loopGuard({ stop_hook_active: true }), true);
  assert.equal(loopGuard({ stop_hook_active: false }), false);
  assert.equal(loopGuard({}), false);
});

test('sanitizeCwd rejects relative / traversal paths', () => {
  const d = mkcwd();
  assert.equal(sanitizeCwd(d), d);
  assert.throws(() => sanitizeCwd('rel/path'));
  assert.throws(() => sanitizeCwd(`${d}/../foo`));
});

test('attempt counter: round-trips and is monotonic', () => {
  const d = mkcwd();
  assert.equal(readAttempts('s1', d), 0);
  writeAttemptCounter('s1', 2, d);
  assert.equal(readAttempts('s1', d), 2);
  writeAttemptCounter('s1', 1, d); // lower ignored
  assert.equal(readAttempts('s1', d), 2);
  writeAttemptCounter('s1', 3, d);
  assert.equal(readAttempts('s1', d), 3);
});

test('writeVerdict writes parseable json under .supervisor/', () => {
  const d = mkcwd();
  writeVerdict('s2', { category: 'summary_drift_stop', injected: true }, d);
  const v = JSON.parse(fs.readFileSync(path.join(d, '.supervisor', 'verdict_s2.json'), 'utf8'));
  assert.equal(v.category, 'summary_drift_stop');
  assert.equal(v.injected, true);
});

test('readTranscriptTail parses jsonl, drops pure tool_result user turns', () => {
  const d = mkcwd();
  const f = path.join(d, 't.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Next step: run tests.' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    'not json — skip me',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  fs.writeFileSync(f, lines);
  const tail = readTranscriptTail(f);
  assert.equal(tail.length, 2); // tool_result-only user turn excluded, bad line skipped
  assert.equal(tail[0].type, 'user');
  assert.equal(tail[1].type, 'assistant');
});

test('buildStopContext extracts final assistant text, user msgs, tools', () => {
  const d = mkcwd();
  const tail = [
    { type: 'user', message: { role: 'user', content: 'add feature X' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'text', text: 'I created the file. Next step: run the tests.' },
    ] } },
  ];
  const ctx = buildStopContext({ session_id: 's3', cwd: d }, tail);
  assert.equal(ctx.session_id, 's3');
  assert.match(ctx.final_assistant_text, /run the tests/);
  assert.deepEqual(ctx.user_messages, ['add feature X']);
  assert.deepEqual(ctx.tools_available_inferred, ['Bash']);
});

test('buildStopContext prefers payload.last_assistant_message', () => {
  const ctx = buildStopContext(
    { session_id: 's4', last_assistant_message: 'direct final text' },
    [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tail text' }] } }],
  );
  assert.equal(ctx.final_assistant_text, 'direct final text');
});
