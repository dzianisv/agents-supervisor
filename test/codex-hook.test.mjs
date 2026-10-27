import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionStore } from '../core/session-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'bin', 'codex-supervisor-hook.mjs');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-hook-'));
  fs.mkdirSync(path.join(cwd, '.supervisor'), { recursive: true });
  return cwd;
}
function run(cwd, input) {
  return spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify(input), encoding: 'utf8' });
}
function config(cwd, value) { fs.writeFileSync(path.join(cwd, '.supervisor', 'codex.json'), JSON.stringify(value)); }
function prompt(cwd, sessionId = 's1', turnId = 't1', text = 'Implement the requested change.') {
  const result = run(cwd, { hook_event_name: 'UserPromptSubmit', session_id: sessionId, turn_id: turnId, prompt: text });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
}
function post(cwd, i, extra = {}) {
  return run(cwd, {
    hook_event_name: 'PostToolUse', session_id: 's1', turn_id: 't1',
    tool_use_id: `call-${i}`, tool_name: i % 4 === 0 ? 'spawn_agent' : 'exec_command', model: 'gpt-6-luna',
    tool_input: { command: `inspect step ${i}`, path: 'src/example.mjs' },
    tool_response: `result ${i}`, ...extra,
  });
}

test('CLI is inert without explicit observer opt-in', () => {
  const cwd = fixture();
  config(cwd, { enabled: true });
  const result = run(cwd, { hook_event_name: 'UserPromptSubmit', session_id: 's1', turn_id: 't1', prompt: 'Do the task.' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('top-level enabled:false disables the observer even when observer.enabled is true', () => {
  const cwd = fixture();
  config(cwd, { enabled: false, observer: { enabled: true, everyToolCalls: 1 } });
  prompt(cwd);
  const result = post(cwd, 1);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('UserPromptSubmit stores the human request without a universal role or delegation nudge', () => {
  const cwd = fixture();
  config(cwd, { observer: { enabled: true } });
  prompt(cwd);
  assert.equal(sessionStore.load(cwd, 's1').codexObserver.requestHistory.at(-1).text, 'Implement the requested change.');
});

test('observer invokes a local reviewer once per configured interval with tool evidence and full applicable AGENTS text', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'reviewer.mjs');
  const seen = path.join(cwd, 'seen.json');
  fs.mkdirSync(path.join(cwd, 'src', 'other'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'other', 'AGENTS.md'), 'Nested instruction for the file_path target.');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), `Follow the request and report the result of npm test.\n${'Long but applicable project context. '.repeat(900)}\nSpecific instruction at the end: preserve the user's requested behavior.`);
  fs.writeFileSync(reviewer, `import fs from 'node:fs'; let s=''; for await (const c of process.stdin) s += c; const p=JSON.parse(s); fs.writeFileSync(${JSON.stringify(seen)}, s); console.log(JSON.stringify({violation:true,category:'focus',rule:'task focus',reason:'The supplied evidence shows a detour.',correction:'Return to the requested implementation.',evidence:'Recent command: inspect step 10'}));`);
  config(cwd, { observer: { enabled: true, everyToolCalls: 10 }, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd);

  for (let i = 1; i < 10; i++) {
    const result = post(cwd, i);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(fs.existsSync(seen), false);
  }
  const tenth = post(cwd, 10, { tool_input: { command: 'inspect step 10', path: 'src/example.mjs', file_path: 'src/other/nested.mjs' } });
  assert.equal(tenth.status, 0, tenth.stderr);
  const output = JSON.parse(tenth.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /Return to the requested implementation/);
  assert.match(output.hookSpecificOutput.additionalContext, /Observer review for turn t1/);
  assert.match(output.hookSpecificOutput.additionalContext, /Human request: Implement the requested change/);
  assert.equal('decision' in output, false);
  assert.equal('permissionDecision' in output, false);
  assert.equal('updatedInput' in output.hookSpecificOutput, false);

  const payload = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.match(payload.user_prompt, /Implement the requested change/);
  assert.equal(payload.observed_turn_id, 't1');
  assert.equal(payload.user_requests[0].turnId, 't1');
  assert.equal(payload.caller_model, 'gpt-6-luna');
  assert.equal(payload.delegation_policy.preferredPlannerModel, 'gpt-6.1-sol');
  assert.equal(payload.delegation_policy.preferredExecutionModel, 'gpt-6-luna');
  assert.equal(payload.delegation_policy.allowNestedDelegation, true);
  assert.match(payload.delegation_policy.guidance, /Never require every task to be delegated/);
  assert.match(payload.instructions, /Follow the request and report the result of npm test/);
  assert.match(payload.instructions, /Specific instruction at the end: preserve the user's requested behavior/);
  assert.match(payload.instructions, /Nested instruction for the file_path target/);
  assert.ok(payload.instructions.length > 1_200, 'AGENTS context is not reduced to a short generic excerpt');
  assert.match(payload.instructions, /<document path=/);
  assert.equal(payload.recent_tools.length, 10);
  assert.equal(payload.recent_tools.at(-1).tool_input.command, 'inspect step 10');
  assert.equal(payload.recent_tools.at(-1).tool_output, 'result 10');
  assert.equal(payload.recent_tools.at(-1).model, 'gpt-6-luna');
  assert.ok(payload.delegation.length > 0);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(seen, 'utf8')));
  const audit = sessionStore.readVerdicts(cwd, 's1');
  assert.deepEqual(audit.map((row) => row.decision), ['observer-finding']);
});

test('review context preserves the newest human request before older request history', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'reviewer.mjs');
  const seen = path.join(cwd, 'seen.json');
  fs.writeFileSync(reviewer, `import fs from 'node:fs'; let s=''; for await (const c of process.stdin) s += c; fs.writeFileSync(${JSON.stringify(seen)}, s); console.log(JSON.stringify({violation:false,category:'none',rule:'none',reason:'No issue.',correction:'',evidence:''}));`);
  config(cwd, { observer: { enabled: true, everyToolCalls: 1 }, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd, 's1', 't1', 'OLD REQUEST ONE '.repeat(200));
  prompt(cwd, 's1', 't2', 'OLD REQUEST TWO '.repeat(200));
  prompt(cwd, 's1', 't3', `CURRENT CRITICAL INSTRUCTION: Only inspect issue #999. ${'new filler '.repeat(280)}`);
  const result = run(cwd, { hook_event_name: 'PostToolUse', session_id: 's1', turn_id: 't3', tool_use_id: 'call-1', tool_name: 'read_file', tool_input: { path: 'src/a.mjs' }, tool_response: 'read' });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.match(payload.user_prompt, /CURRENT CRITICAL INSTRUCTION: Only inspect issue #999/);
  assert.equal(payload.user_requests[0].turnId, 't3');
});

test('bounded feedback retains its actionable correction after long evidence fields', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'reviewer.mjs');
  fs.writeFileSync(reviewer, `let s=''; for await (const c of process.stdin) s += c; JSON.parse(s); console.log(JSON.stringify({violation:true,category:'rules',rule:'test-rule',reason:'r'.repeat(2000),correction:'CORRECTION_BEGIN '+'c'.repeat(1900)+' CORRECTION_END',evidence:'e'.repeat(2000)}));`);
  config(cwd, { observer: { enabled: true, everyToolCalls: 1 }, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd);
  const result = post(cwd, 1);
  assert.equal(result.status, 0, result.stderr);
  const feedback = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(feedback, /Next step: CORRECTION_BEGIN/);
  assert.match(feedback, /CORRECTION_END/);
});

test('on-track reviewer result stays quiet and Stop stores the latest answer without blocking', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'reviewer.mjs');
  fs.writeFileSync(reviewer, `let s=''; for await (const c of process.stdin) s += c; JSON.parse(s); console.log(JSON.stringify({violation:false,category:'none',rule:'none',reason:'No concrete issue is established.',correction:'',evidence:''}));`);
  config(cwd, { observer: { enabled: true, everyToolCalls: 1 }, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd);
  const reviewed = post(cwd, 1);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.deepEqual(JSON.parse(reviewed.stdout), {});
  const stop = run(cwd, { hook_event_name: 'Stop', session_id: 's1', turn_id: 't1', last_assistant_message: 'Completed the implementation.' });
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), {});
  assert.equal(sessionStore.load(cwd, 's1').codexObserver.latestAssistant.text, 'Completed the implementation.');
});

test('reviewer failure is quiet and non-blocking', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'broken.mjs');
  fs.writeFileSync(reviewer, 'process.exit(3)');
  config(cwd, { observer: { enabled: true, everyToolCalls: 1 }, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd);
  const result = post(cwd, 1);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(sessionStore.lastVerdict(cwd, 's1').decision, 'observer-review-warning');
});

test('a custom reviewer ignoring SIGTERM and its child are killed at the outer deadline', () => {
  const cwd = fixture();
  const reviewer = path.join(cwd, 'stuck-reviewer.mjs');
  const pids = path.join(cwd, 'pids.json');
  fs.writeFileSync(reviewer, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(()=>{},1000);
`);
  config(cwd, { observer: { enabled: true, everyToolCalls: 1 }, reviewerTimeoutMs: 1_000, reviewerCommand: [process.execPath, reviewer] });
  prompt(cwd);
  const result = post(cwd, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const { parent, child } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  for (const pid of [parent, child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `reviewer process ${pid} should be gone`);
});

test('malformed config remains visible but never blocks a hook', () => {
  const cwd = fixture();
  fs.writeFileSync(path.join(cwd, '.supervisor', 'codex.json'), '{');
  const result = run(cwd, { hook_event_name: 'UserPromptSubmit' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.match(result.stderr, /invalid \.supervisor\/codex\.json/);
});
