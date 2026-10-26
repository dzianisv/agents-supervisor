// Sequential, real pinned Pi host feasibility. Synthetic decisions prove WIRING ONLY.
// Run: node --experimental-strip-types test/e2e-pi-boundary.mjs [--keep]
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, controlledSession, helpers, records, requireHost, runProcess, sandbox, waitFor } from './helpers/pi-host.mjs';

process.umask(0o077);
const self = fileURLToPath(import.meta.url);
const call = (target, id) => ({ name: 'effect', arguments: { target }, ...(id ? { id } : {}) });
const requests = box => records(box, 'requests.jsonl').filter(x => x.kind === 'request');
const present = (box, name) => existsSync(join(box.root, name));
const userEntries = entries => entries.filter(e => e.type === 'message' && e.message.role === 'user');
const text = msg => typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text ?? '').join('');
const resultEvents = output => output.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const toolResults = events => events.filter(e => e.type === 'message_end' && e.message.role === 'toolResult').map(e => e.message);

async function sdkScenario(box, scenario) {
  const { session, manager, sdk, errors } = await controlledSession(box);
  try {
    if (scenario === 'settle') {
      const run = session.prompt('Original task');
      await waitFor(() => present(box, 'audit-start'), 'delayed audit');
      assert(present(box, 'project-goal'));
      assert(!present(box, 'achievement.jsonl'));
      await run;
      assert.equal(records(box, 'achievement.jsonl').length, 1);
      assert(!present(box, 'project-goal'));
      await session.waitForIdle();
      assert.equal(records(box, 'achievement.jsonl').length, 1);
      assert.equal(requests(box).length, 2);
    } else if (scenario === 'queued-audit') {
      const run = session.prompt('Original task');
      await waitFor(() => present(box, 'audit-start'), 'delayed audit');
      assert(!present(box, 'achievement.jsonl'));
      await session.prompt('New operator input', { streamingBehavior: 'followUp' });
      await run;
      assert(!present(box, 'achievement.jsonl'));
      assert(present(box, 'project-goal'));
      assert(userEntries(manager.getBranch()).some(e => text(e.message) === 'New operator input'));
      assert.equal(requests(box).length, 3);
      assert(records(box).some(e => e.kind === 'settled' && e.candidate && !e.valid));
    } else if (scenario === 'draft' || scenario === 'continuation') {
      await session.prompt('Original task');
      assert(!present(box, 'achievement.jsonl'));
      assert(present(box, 'project-goal'));
      const settled = records(box).find(e => e.kind === 'settled');
      assert(settled.candidate);
      assert.notEqual(settled.leaf, settled.candidate.leaf);
      assert.equal(settled.valid, false);
      assert(manager.getBranch().some(e => e.customType === 'other-boundary'));
      assert.equal(requests(box).length, scenario === 'continuation' ? 3 : 2);
    } else if (scenario === 'receipts') {
      await session.prompt('identical');
      await session.prompt('identical');
      await session.prompt('/generated');
      await session.waitForIdle();
      await session.prompt('transform-me');
      await session.prompt('consumed');
      const run = session.prompt('queued-start');
      await waitFor(() => requests(box).length === 5, 'slow request');
      await session.prompt('identical', { streamingBehavior: 'steer' });
      await session.prompt('identical', { streamingBehavior: 'followUp' });
      await run;
      const hooks = records(box);
      const inputs = hooks.filter(e => e.kind === 'input');
      assert.equal(inputs.length, 8);
      assert.deepEqual(inputs.map(e => e.event.source), ['interactive', 'interactive', 'extension', 'interactive', 'interactive', 'interactive', 'interactive', 'interactive']);
      assert.equal(inputs[6].event.streamingBehavior, 'steer');
      assert.equal(inputs[7].event.streamingBehavior, 'followUp');
      const entries = userEntries(manager.getBranch());
      assert.equal(entries.length, 7);
      assert.equal(new Set(entries.map(e => e.id)).size, 7);
      assert.deepEqual(entries.map(e => text(e.message)), ['identical', 'identical', 'identical', 'transformed', 'queued-start', 'identical', 'identical']);
      const starts = hooks.filter(e => e.kind === 'message_start' && e.event.message.role === 'user');
      const ends = hooks.filter(e => e.kind === 'message_end' && e.event.message.role === 'user');
      assert.equal(starts.length, 7);
      assert.equal(ends.length, 7);
      // Correlate by native event order and ancestry delta, never by repeated text alone.
      for (let i = 0; i < 7; i++) {
        assert.equal(userEntries(starts[i].entries).length, i);
        assert.equal(userEntries(ends[i].entries).length, i, 'message_end precedes persistence');
      }
      assert.equal(requests(box).length, 7);
      writeFileSync(join(box.root, 'receipt-correlation.json'), JSON.stringify(entries.map((e, i) => ({
        ordinal: i + 1, id: e.id, source: [ 'interactive', 'interactive', 'extension', 'interactive', 'interactive', 'interactive', 'interactive' ][i],
        original: i === 3 ? 'transform-me' : text(e.message), persisted: text(e.message) }))), { mode: 0o600 });
    } else if (scenario === 'identity') {
      await session.prompt('Original immutable request');
      const origin = userEntries(manager.getBranch())[0];
      const firstAssistant = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'assistant');
      await session.prompt('Second branch input');
      await session.prompt('Third branch input');
      const abandoned = userEntries(manager.getBranch()).at(-1).id;
      const sessionId = manager.getSessionId();
      const compact = await session.compact();
      assert(compact, 'Native compaction must actually execute');
      assert(manager.getBranch().some(e => e.type === 'compaction'));
      assert(manager.getBranch().some(e => e.id === origin.id && text(e.message) === 'Original immutable request'));
      assert(!session.messages.some(m => m.role === 'user' && text(m) === 'Original immutable request'), 'raw origin differs from compacted context');
      await session.navigateTree(firstAssistant.id, { summarize: false });
      assert.equal(manager.getSessionId(), sessionId);
      assert(!manager.getBranch().some(e => e.id === abandoned));
      assert(manager.getEntries().some(e => e.id === abandoned), 'Abandoned history remains, but is not active');
      await session.prompt('Alternative branch input');
      const path = manager.getSessionFile();
      const reopened = sdk.SessionManager.open(path, join(box.root, 'sessions'));
      assert.equal(reopened.getSessionId(), sessionId);
      assert(reopened.getBranch().some(e => e.id === origin.id));
      assert(!reopened.getBranch().some(e => e.id === abandoned));
      const fork = sdk.SessionManager.forkFrom(path, box.cwd, join(box.root, 'sessions'));
      assert.notEqual(fork.getSessionId(), sessionId);
      assert.equal(fork.getHeader().parentSession, path);
      assert(fork.getBranch().some(e => e.id === origin.id), 'Copied entry ID is NOT a session identity');
      writeFileSync(join(box.root, 'identity.json'), JSON.stringify({ sessionId, forkId: fork.getSessionId(), originId: origin.id,
        abandonedId: abandoned, active: manager.getBranch(), fork: fork.getBranch() }), { mode: 0o600 });
      assert(records(box).some(e => e.kind === 'session_before_tree'));
      assert(records(box).some(e => e.kind === 'session_before_compact'));
      const beforeOrigin = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'system');
      await session.navigateTree(beforeOrigin.id, { summarize: false });
      assert(!manager.getBranch().some(e => e.id === origin.id), 'Navigation before origin removes active anchor');
      assert(manager.getEntries().some(e => e.id === origin.id), 'All-history lookup would incorrectly find abandoned anchor');
    } else throw new Error(`Unknown SDK scenario ${scenario}`);
    assert.deepEqual(errors, [], 'Swallowed extension errors must fail the harness');
  } finally { session.dispose(); }
}

if (process.argv[2] === '--sdk') {
  requireHost();
  const root = process.env.PI_BOUNDARY_ROOT;
  const box = { root, cwd: join(root, 'cwd'), config: JSON.parse(readFileSync(process.env.PI_BOUNDARY_CONFIG, 'utf8')) };
  await sdkScenario(box, process.argv[3]);
} else {
  const { test } = await import('node:test');
  console.log(`# Native host: ${JSON.stringify(requireHost())}; deterministic LOCAL fixtures only`);
  let cases = 0;
  async function native(name, config, run) {
    await test(name, { timeout: 30000 }, async () => {
      cases++;
      const box = sandbox(config);
      try {
        await run(box);
        assert(requests(box).length > 0, 'Missing provider execution is not a native pass');
        assert(!records(box, 'requests.jsonl').some(r => r.kind === 'response' && ['error', 'aborted'].includes(r.message.stopReason)), 'Unexpected provider failure');
        checkPermissions(box.root);
      }
      finally {
        if (process.argv.includes('--keep')) console.log(`# Evidence ${name}: ${box.root}`);
        else box.cleanup();
      }
    });
  }
  const cliRun = async (box, mode = 'json') => {
    const output = await runProcess(process.execPath, [...cliArgs(box, mode), 'Original task'], box,
      { expectedCode: mode === 'print' && box.config.holdAbort ? 1 : 0 });
    assert(!/Extension error|error: Provider/.test(output.stderr), 'Native extension error must not be swallowed');
    return output;
  };
  const sdkRun = (box, scenario) => runProcess(process.execPath, ['--experimental-strip-types', self, '--sdk', scenario], box);

  await native('CLI block-before-execute and legitimate follow-up', { responses: [
    { calls: [call('forbidden', 'wrong')] }, { calls: [call('allowed', 'right')] }, { text: 'Synthetic recovery finished' } ] }, async box => {
    const output = await cliRun(box);
    const results = toolResults(resultEvents(output));
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, true);
    assert.match(text(results[0]), /BOUNDARY BLOCK/);
    assert.equal(results[1].isError, false);
    assert(!present(box, 'effect-forbidden'));
    assert(present(box, 'effect-allowed'));
    assert(!records(box).some(e => e.kind === 'execute' && e.id === 'wrong'));
    assert(!records(box).some(e => e.kind === 'tool_result' && e.event.toolCallId === 'wrong'));
    assert.equal(requests(box).length, 3);
    assert(requests(box)[1].messages.some(m => m.role === 'toolResult' && m.isError));
  });
  await native('Nested ctx.executeTool traverses native gating', { responses: [
    { calls: [{ name: 'nested', arguments: {}, id: 'parent' }] }, { text: 'Done' } ] }, async box => {
    const output = await cliRun(box);
    assert(!present(box, 'effect-forbidden'));
    const nested = records(box).find(e => e.kind === 'gate' && e.event.parentToolCallId === 'parent');
    assert(nested);
    assert.equal(nested.event.toolCallId, 'parent/1');
    assert.equal(records(box).find(e => e.kind === 'nested-outcome').result.isError, true);
    assert.equal(toolResults(resultEvents(output))[0].nestedCalls.calls[0].status, 'error');
  });
  await native('Parallel preparation precedes goal declaration execution', { declarationRace: true, responses: [
    { calls: [{ name: 'declare', arguments: {}, id: 'goal' }, call('sibling', 'work')] }, { text: 'Done' } ] }, async box => {
    const output = await cliRun(box);
    const hooks = records(box);
    const gate = hooks.findIndex(e => e.kind === 'gate' && e.event.toolCallId === 'work');
    const execute = hooks.findIndex(e => e.kind === 'execute' && e.id === 'goal');
    assert(gate >= 0 && execute > gate);
    assert.equal(hooks[gate].declared, false);
    assert(present(box, 'declared'));
    assert(!present(box, 'effect-sibling'));
    assert.match(text(toolResults(resultEvents(output))[1]), /NOT executed/);
  });
  await native('Earlier mutation is visible to the authoritative gate', { earlierMutation: true, responses: [
    { calls: [call('allowed')] }, { text: 'Done' } ] }, async box => {
    const output = await cliRun(box);
    assert.equal(records(box).find(e => e.kind === 'gate').event.input.target, 'forbidden');
    assert(toolResults(resultEvents(output))[0].isError);
    assert(!present(box, 'effect-forbidden'));
    assert(!present(box, 'effect-allowed'));
  });
  await native('LIMITATION: later hook can mutate approved arguments', { laterMutation: true, responses: [
    { calls: [call('allowed')] }, { text: 'Done' } ] }, async box => {
    await cliRun(box);
    assert.equal(records(box).find(e => e.kind === 'gate').event.input.target, 'allowed');
    assert.equal(records(box).find(e => e.kind === 'execute').args.target, 'mutated');
    assert(present(box, 'effect-mutated'), 'This expected limitation is NOT a security-fence pass');
  });
  await native('NEGATIVE CONTROL: terminate alone fails mixed-batch hold', { responses: [
    { calls: [call('allowed'), call('unknown')] }, { text: 'Automatic follow-up occurred' } ] }, async box => {
    await cliRun(box);
    assert.equal(requests(box).length, 2, 'terminate alone cannot suppress mixed successful siblings');
    assert(present(box, 'effect-allowed'));
    assert(!present(box, 'effect-unknown'));
  });
  await native('Hold plus non-awaited abort: JSON feedback, no automatic request', { holdAbort: true, responses: [
    { calls: [call('allowed'), call('unknown'), call('sibling')] } ] }, async box => {
    const output = await cliRun(box);
    const events = resultEvents(output);
    assert.equal(requests(box).length, 1);
    for (const target of ['allowed', 'unknown', 'sibling']) assert(!present(box, `effect-${target}`));
    assert(events.some(e => e.type === 'message_end' && e.message.role === 'custom' && e.message.display && /BOUNDARY HOLD/.test(text(e.message))));
    assert(events.some(e => e.type === 'agent_settled' && e.aborted));
    assert(toolResults(events).some(m => m.isError && /Operation aborted/.test(text(m))));
  });
  await native('Dynamic nested hold after a successful sibling returns control without retry', { holdAbort: true, responses: [
    { calls: [call('allowed', 'good'), { name: 'nested', id: 'parent-hold', arguments: { target: 'unknown' } }, call('sibling')] } ] }, async box => {
    const output = await cliRun(box);
    const events = resultEvents(output);
    assert.equal(requests(box).length, 1);
    assert(present(box, 'effect-allowed'), 'Already-executed authorized sibling is not rolled back');
    assert(!present(box, 'effect-unknown'));
    assert(records(box).some(e => e.kind === 'gate' && e.event.parentToolCallId === 'parent-hold'));
    assert(toolResults(events).some(m => m.toolCallId === 'good' && !m.isError), 'The batch really contains a successful sibling');
    assert(events.some(e => e.type === 'message_end' && e.message.role === 'custom' && /BOUNDARY HOLD/.test(text(e.message))));
    assert(events.some(e => e.type === 'agent_settled' && e.aborted));
  });
  await native('NEGATIVE CONTROL: sendMessage display is NOT print visibility', { holdAbort: true, responses: [
    { calls: [call('unknown')] } ] }, async box => {
    const output = await cliRun(box, 'print');
    assert.equal(requests(box).length, 1);
    assert(records(box).some(e => e.kind === 'settled' && e.entries.some(e => e.customType === 'boundary-hold')));
    assert(!/BOUNDARY HOLD/.test(output.stdout + output.stderr), 'Native print ignores custom messages');
  });
  await native('Print hold diagnostic visibly returns control without retry', { holdAbort: true, printDiagnostic: true, responses: [
    { calls: [call('allowed'), call('unknown'), call('sibling')] } ] }, async box => {
    const output = await cliRun(box, 'print');
    assert.match(output.stderr, /BOUNDARY HOLD: clarify/);
    assert.equal(requests(box).length, 1);
    for (const target of ['allowed', 'unknown', 'sibling']) assert(!present(box, `effect-${target}`));
    assert(records(box).some(e => e.kind === 'settled' && e.event.aborted));
  });
  await native('Native TUI displays held feedback and returns control', { holdAbort: true, shutdownOnSettle: true, responses: [
    { calls: [call('allowed'), call('unknown'), call('sibling')] } ] }, async box => {
    const specPath = join(box.root, 'pty-spec.json');
    writeFileSync(specPath, JSON.stringify({ root: box.root, cwd: box.cwd, env: box.env, expectEscape: false,
      command: process.execPath, args: [...cliArgs(box, 'tui'), 'Original task'] }), { mode: 0o600 });
    await runProcess('/usr/bin/python3', [join(helpers, 'pi-pty.py'), specPath], box, { timeoutMs: 24000 });
    assert.match(readFileSync(join(box.root, 'pty.raw'), 'utf8'), /BOUNDARY HOLD: clarify/);
    assert.equal(requests(box).length, 1);
    for (const target of ['allowed', 'unknown', 'sibling']) assert(!present(box, `effect-${target}`));
    assert(records(box).some(e => e.kind === 'settled' && e.event.aborted));
  });
  await native('Successful delayed native settlement commits once, never during audit', { audit: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed', delayMs: 300 } ] }, box => sdkRun(box, 'settle'));
  await native('REAL native TUI Escape during delayed settlement discards candidate', { audit: true, shutdownOnSettle: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed', delayMs: 1500 } ] }, async box => {
    const specPath = join(box.root, 'pty-spec.json');
    writeFileSync(specPath, JSON.stringify({ root: box.root, cwd: box.cwd, env: box.env,
      command: process.execPath, args: [...cliArgs(box, 'tui'), 'Original task'] }), { mode: 0o600 });
    await runProcess('/usr/bin/python3', [join(helpers, 'pi-pty.py'), specPath], box, { timeoutMs: 24000 });
    assert.equal(JSON.parse(readFileSync(join(box.root, 'pty-input.json'), 'utf8')).byte, 27);
    const settled = records(box).find(e => e.kind === 'settled');
    assert(settled.candidate, 'Audit result arrived; cancellation must discard even a completed candidate');
    assert.equal(settled.event.aborted, true);
    assert.equal(settled.valid, false);
    assert(!present(box, 'achievement.jsonl'));
    assert(present(box, 'project-goal'));
    assert.equal(requests(box).length, 2);
    assert.equal(records(box).find(e => e.kind === 'before-settle').signalPresent, false);
  });
  await native('REAL Escape persists other boundary drafts but suppresses continuation', { audit: true, otherDraft: true, otherContinue: true, shutdownOnSettle: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed', delayMs: 1500 } ] }, async box => {
    const specPath = join(box.root, 'pty-spec.json');
    writeFileSync(specPath, JSON.stringify({ root: box.root, cwd: box.cwd, env: box.env,
      command: process.execPath, args: [...cliArgs(box, 'tui'), 'Original task'] }), { mode: 0o600 });
    await runProcess('/usr/bin/python3', [join(helpers, 'pi-pty.py'), specPath], box, { timeoutMs: 24000 });
    const settled = records(box).find(e => e.kind === 'settled');
    assert.equal(settled.event.aborted, true);
    assert(settled.entries.some(e => e.customType === 'other-boundary'), 'Boundary drafts can persist even after Escape');
    assert(!present(box, 'achievement.jsonl'));
    assert(present(box, 'project-goal'));
    assert.equal(requests(box).length, 2, 'Escape suppresses the requested boundary continuation');
  });
  await native('Queued input during audit cannot stale-commit; input is preserved', { audit: true, auditFirstOnly: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed', delayMs: 300 }, { text: 'Responded to new input' } ] }, box => sdkRun(box, 'queued-audit'));
  await native('Another settlement handler draft invalidates audited leaf', { audit: true, otherDraft: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed' } ] }, box => sdkRun(box, 'draft'));
  await native('Other boundary continuation cannot stale-commit', { audit: true, auditFirstOnly: true, otherDraft: true, otherContinue: true, responses: [
    { text: 'Worker done' }, { text: 'Audit completed' }, { text: 'Other extension continuation' } ] }, box => sdkRun(box, 'continuation'));
  await native('Input receipt order vs persistence: identical/generated/transformed/queued/consumed', { responses: [
    { text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5', delayMs: 200 }, { text: '6' }, { text: '7' } ] }, box => sdkRun(box, 'receipts'));
  await native('Active branch, native compaction, reopen and fork identity', { customCompaction: true, responses: [
    { text: '1' }, { text: '2' }, { text: '3' }, { text: 'Alternative' } ] }, box => sdkRun(box, 'identity'));
  assert.equal(cases, 19, 'Missing/zero native cases is never a pass');
}

function checkPermissions(root) {
  assert.equal(statSync(root).mode & 0o777, 0o700);
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    const stat = statSync(path);
    assert.equal(stat.mode & 0o077, 0, `Private fixture artifact permissions: ${path}`);
    if (item.isDirectory()) checkPermissions(path);
  }
}
