import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const CODEX = process.env.CODEX_BINARY || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(CODEX)) {
  throw new Error(`Required embedded Codex CLI not found: ${CODEX}`);
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function startCodex(args, options) {
  const child = spawn(CODEX, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('embedded Codex observes every ten completed tools asynchronously and injects only evidence-based findings', { timeout: 60_000 }, async (t) => {
  const version = await new Promise((resolve, reject) => {
    const child = spawn(CODEX, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`codex --version exited ${code}`)));
  });
  assert.match(version, /^codex-cli \d+\./, 'the E2E must run an actual Codex CLI');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-codex-e2e-'));
  const home = path.join(root, 'codex-home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const userPrompt = 'Run 22 harmless numbered shell commands in .codex-e2e. Use only that directory for created files, then report the count.';
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'All files created for this task must stay inside .codex-e2e. If a file is misplaced, move it into that directory before continuing.');
  const marker = path.join(root, 'hook-events.jsonl');
  const decisions = path.join(root, 'hook-results.jsonl');
  const reviewerStarts = path.join(root, 'reviewer-starts.jsonl');
  const reviewerLog = path.join(root, 'reviewer-inputs.jsonl');
  const hookScript = path.join(root, 'hook.mjs');
  const reviewerScript = path.join(root, 'reviewer.mjs');
  fs.writeFileSync(reviewerScript, `
import fs from 'node:fs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
const reviews = fs.existsSync(${JSON.stringify(reviewerStarts)})
  ? fs.readFileSync(${JSON.stringify(reviewerStarts)}, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
const number = reviews + 1;
const startedAt = Date.now();
fs.appendFileSync(${JSON.stringify(reviewerStarts)}, JSON.stringify({number,startedAt}) + '\\n');
const delayMs = number === 1 ? 1200 : 500;
await new Promise(resolve => setTimeout(resolve, delayMs));
const verdict = number === 1
  ? {violation:true,category:'rules',rule:'workspace-boundary',reason:'A completed shell call created wrong-location.txt outside the required .codex-e2e directory.',correction:'Move wrong-location.txt into .codex-e2e before continuing, and keep later outputs there.',evidence:'The observed Bash input wrote wrong-location.txt at the project root.'}
  : {violation:false,category:'none',rule:'none',reason:'The recent numbered commands follow the user request and project instruction.',correction:'',evidence:'Recent Bash inputs and outputs stay within .codex-e2e.'};
fs.appendFileSync(${JSON.stringify(reviewerLog)}, JSON.stringify({number,startedAt,finishedAt:Date.now(),input}) + '\\n');
process.stdout.write(JSON.stringify(verdict));
`);
  fs.writeFileSync(hookScript, `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(JSON.parse(raw || '{}')) + '\\n');
const result = spawnSync(process.execPath, [${JSON.stringify(path.join(REPO, 'bin/codex-supervisor-hook.mjs'))}], { input: raw, encoding: 'utf8' });
fs.appendFileSync(${JSON.stringify(decisions)}, JSON.stringify({ event: JSON.parse(raw || '{}').hook_event_name, tool: JSON.parse(raw || '{}').tool_name, model: JSON.parse(raw || '{}').model, tool_use_id: JSON.parse(raw || '{}').tool_use_id ?? JSON.parse(raw || '{}').tool_call_id ?? JSON.parse(raw || '{}').call_id, output: result.stdout || '', status: result.status }) + '\\n');
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
  fs.mkdirSync(path.join(project, '.supervisor'), { recursive: true });
  fs.writeFileSync(path.join(project, '.supervisor', 'codex.json'), JSON.stringify({
    observer: { enabled: true, everyToolCalls: 10 },
    reviewerCommand: [process.execPath, reviewerScript],
    reviewerTimeoutMs: 10_000,
  }));

  let requestCount = 0;
  const requests = [];
  let request11ArrivedAt = null;
  let request21ArrivedAt = null;
  let request11ReleasedAt = null;
  let request21ReleasedAt = null;
  let reviewerCountAtRequest10 = null;
  const fixture = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (req.url !== '/v1/responses') {
        res.writeHead(404).end('not found');
        return;
      }
      requestCount += 1;
      requests.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (requestCount === 10) {
        reviewerCountAtRequest10 = fs.existsSync(reviewerLog) ? fs.readFileSync(reviewerLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      }
      if (requestCount === 11) {
        request11ArrivedAt = Date.now();
        // Release the pending fixture response as soon as the reviewer has started,
        // while it is still sleeping. This deterministically exposes async behavior.
        await waitFor(() => fs.existsSync(reviewerStarts) && fs.readFileSync(reviewerStarts, 'utf8').includes('"number":1'), 5_000, 'first background reviewer start');
        request11ReleasedAt = Date.now();
      }
      if (requestCount === 21) {
        request21ArrivedAt = Date.now();
        await waitFor(() => fs.existsSync(reviewerStarts) && fs.readFileSync(reviewerStarts, 'utf8').includes('"number":2'), 5_000, 'second background reviewer start');
        request21ReleasedAt = Date.now();
      }
      if (requestCount === 23) {
        await waitFor(() => fs.existsSync(decisions)
          && fs.readFileSync(decisions, 'utf8').trim().split('\n').filter((line) => line.includes('"event":"PostToolUse"')).length === 22,
        5_000, 'final asynchronous PostToolUse hook');
      }

      const toolNumber = requestCount;
      const command = toolNumber <= 22
        ? toolNumber === 9
          ? `printf misplaced > wrong-location.txt`
          : toolNumber === 11
            ? `sleep 2; mkdir -p .codex-e2e; mv wrong-location.txt .codex-e2e/call-9.txt; printf call-11 > .codex-e2e/call-11.txt`
            : toolNumber === 21
              ? `sleep 1.5; printf call-21 > .codex-e2e/call-21.txt`
              : `mkdir -p .codex-e2e; printf call-${toolNumber} > .codex-e2e/call-${toolNumber}.txt`
        : null;
      const response = command
        ? {
            id: `resp-e2e-tool-${toolNumber}`, object: 'response', status: 'completed', model: 'gpt-6.1-sol',
            output: [{ id: `fc-e2e-${toolNumber}`, type: 'function_call', call_id: `call-e2e-${toolNumber}`, name: 'exec_command', arguments: JSON.stringify({cmd: command, yield_time_ms: 3000}) }],
          }
        : {
            id: `resp-e2e-final-${requestCount}`, object: 'response', status: 'completed', model: 'gpt-6.1-sol',
            output: [{ id: `msg-e2e-${requestCount}`, type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Completed 22 numbered shell commands in the scratch directory.'}] }],
          };
      if (command) {
        const call = response.output[0];
        res.end([
          { type: 'response.created', response: { id: response.id, object: 'response', status: 'in_progress', model: response.model, output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { id: call.id, type: call.type, call_id: call.call_id, name: call.name, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
          { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments },
          { type: 'response.output_item.done', output_index: 0, item: call },
          { type: 'response.completed', response },
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      } else {
        res.end(`data: ${JSON.stringify({type: 'response.completed', response})}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  await new Promise((resolve, reject) => fixture.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = fixture.address().port;
  t.after(async () => {
    fixture.closeAllConnections?.();
    await new Promise((resolve) => fixture.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(home, 'config.toml'), [
    'model = "gpt-6.1-sol"',
    'model_provider = "fixture"',
    'suppress_unstable_features_warning = true',
    'approval_policy = "never"',
    'features.responses_websockets = false',
    '',
    '[model_providers.fixture]',
    'name = "Local E2E fixture"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${process.execPath} ${hookScript}`, timeout: 10 }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${process.execPath} ${hookScript}`, timeout: 30, async: true }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${process.execPath} ${hookScript}`, timeout: 10 }] }],
  } }, null, 2));

  const child = startCodex([
    'exec', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-hook-trust',
    '--sandbox', 'workspace-write', '--cd', project, '--json',
    userPrompt,
  ], {
    cwd: project,
    env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', OPENAI_BASE_URL: '', CODEX_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    try {
      await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('UserPromptSubmit'), 8_000, 'native prompt hook');
    } catch (error) {
      throw new Error(`${error.message}; codex stdout=${child.stdout}\ncodex stderr=${child.stderr}`);
    }
    // Allow the local Responses fixture to drive the actual Codex tool runner through 22 calls.
    try {
      await waitFor(() => requestCount >= 23 && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').includes('"hook_event_name":"Stop"'), 45_000, '22 calls, final response, and Stop hook');
    } catch (error) {
      const observed = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '<no marker>';
      throw new Error(`${error.message}; hooks=${observed}\nfixture requests=${requestCount}; reviewerStarts=${fs.existsSync(reviewerStarts) ? fs.readFileSync(reviewerStarts, 'utf8') : '<none>'}; reviewer=${fs.existsSync(reviewerLog) ? fs.readFileSync(reviewerLog, 'utf8') : '<none>'}\ncodex stdout=${child.stdout}\ncodex stderr=${child.stderr}`);
    }
  } finally {
    child.child.kill('SIGTERM');
    await Promise.race([child.done, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    if (child.child.exitCode === null) {
      child.child.kill('SIGKILL');
      await Promise.race([child.done, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }

  const events = fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.hook_event_name === 'UserPromptSubmit'), `no UserPromptSubmit hook fired; stderr=${child.stderr}`);
  assert.equal(reviewerCountAtRequest10, 0, 'no reviewer may run before the tenth completed tool');
  assert.ok(request11ArrivedAt && request21ArrivedAt, 'model requests 11 and 21 must proceed while reviewers are running');
  const reviewRecords = fs.readFileSync(reviewerLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(reviewRecords.length, 2, 'reviews start once at ten and once at twenty completed tools');
  const startRecords = fs.readFileSync(reviewerStarts, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(startRecords[0].startedAt <= request11ReleasedAt && request11ReleasedAt < reviewRecords[0].finishedAt,
    'request 11 must resume through the local model while the first review is still running');
  assert.ok(startRecords[1].startedAt <= request21ReleasedAt && request21ReleasedAt < reviewRecords[1].finishedAt,
    'request 21 must resume through the local model while the compliant review is still running');
  assert.equal(reviewRecords[0].input.user_prompt, userPrompt);
  assert.match(reviewRecords[0].input.instructions, /All files created for this task must stay inside \.codex-e2e/);
  assert.equal(reviewRecords[0].input.recent_tools.length, 10);
  assert.equal(reviewRecords[0].input.recent_tools[8].tool, 'Bash');
  assert.match(JSON.stringify(reviewRecords[0].input.recent_tools[8].tool_input), /wrong-location\.txt/);
  assert.ok(Object.hasOwn(reviewRecords[0].input.recent_tools[8], 'tool_output'), 'review receives the actual tool result field');
  assert.ok(Object.hasOwn(reviewRecords[0].input, 'delegation'));
  assert.ok(Object.hasOwn(reviewRecords[0].input, 'focus'));

  const hookResults = fs.readFileSync(decisions, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const postTool = hookResults.filter((record) => record.event === 'PostToolUse');
  assert.equal(postTool.length, 22, 'all 22 completed tool calls must reach the observer hook');
  assert.ok(postTool.every((record) => {
    const output = JSON.parse(record.output).hookSpecificOutput ?? {};
    return record.status === 0 && record.tool === 'Bash' && record.model === 'gpt-6.1-sol'
      && !('permissionDecision' in output) && !('updatedInput' in output);
  }), 'main Sol Bash calls must continue without observer blocking or rewrite');
  assert.equal(reviewRecords[0].input.recent_tools.length, 10, 'review window uses exactly ten completed tool calls');
  assert.match(JSON.stringify(requests[11]?.input), /Move wrong-location\.txt into \.codex-e2e/,
    'first review correction must reach the next safe model request');
  assert.equal(reviewRecords[1].input.recent_tools.length, 10);
  assert.equal(reviewRecords[1].input.recent_tools[0].tool_use_id, postTool[10].tool_use_id);
  assert.doesNotMatch(JSON.stringify(requests[21]?.input), /Observer review \(rules\): A completed shell call/,
    'the compliant second review must not inject another correction');
  assert.ok(fs.existsSync(path.join(project, '.codex-e2e', 'call-9.txt')));
  assert.equal(fs.existsSync(path.join(project, 'wrong-location.txt')), false, 'the corrective tool call must move the misplaced file');
  assert.ok(fs.readdirSync(path.join(project, '.codex-e2e')).length >= 22, 'numbered shell tool calls completed in the scratch workspace');
  assert.ok(requests.length >= 23, 'the full tool sequence returned to the local fixture');
  assert.equal(requests[0].model, 'gpt-6.1-sol');
  assert.equal(requests[9].model, 'gpt-6.1-sol');
});
