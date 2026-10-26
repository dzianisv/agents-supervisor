// Production Pi native tool acceptance: deterministic ACTOR/JUDGE fixtures only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from '../core/session-store.mjs';
import { ORIGINAL, achievements, answer, assessment, assertAnchor, assertReport, completed, effect, effects, events, goalCall,
  humanOnly, productionCli, productionSession, records, routes, runCases, state, text, toolResults, unmet, waitFor } from './helpers/pi-production-host.mjs';

const cases = [];
const add = (name, config, run, options = {}) => cases.push({ name, config, run, ...options });
const script = (calls, focus, settlement = [humanOnly()], final = 'Awaiting the operator quota authorization.') => ({
  actor: [{ calls: [goalCall()] }, { calls }, answer(final)], focus, settlement });
const counts = (box, expected) => {
  for (const kind of ['actor', 'focus', 'settlement']) assert.equal(routes(box).filter(r => r.kind === kind).length, expected[kind] ?? 0, `${kind} request count`);
};
const cliState = box => {
  const registration = records(box, 'production-hooks.jsonl').find(r => r.kind === 'registration');
  assert(registration?.sessionId, 'Missing actual CLI session identity');
  return JSON.parse(readFileSync(statePath(box.cwd, registration.sessionId), 'utf8'));
};
const absent = (box, target) => {
  assert(!existsSync(join(box.root, `execute-${target}`)), `Forbidden execute marker: ${target}`);
  assert(!effects(box).some(e => e.target === target && e.operation !== 'read'), `Forbidden execute invocation: ${target}`);
};
async function sdk(box, run) {
  const host = await productionSession(box);
  try { await run(host); assert.deepEqual(host.errors, [], 'Extension errors cannot count as a pass'); }
  finally { host.session.dispose(); }
}
const held = (box, manager) => {
  const s = assertAnchor(box, manager);
  assert(s.focus.hold, 'Hold must be canonical, not merely a blocked result');
  assert(events(box).some(e => e.type === 'agent_settled' && e.aborted), 'Hold must actually return native control');
  assert(events(box).some(e => e.type === 'message_end' && e.message.role === 'custom' && e.message.display && /Focus hold:/.test(text(e.message))), 'Independent visible feedback survives abort');
  return s;
};

add('Production packaged CLI: off-goal ticket blocked, permitted recovery executes', {
  actor: [{ calls: [goalCall()] }, { calls: [effect('ticket', 'wrong')] }, { calls: [effect('tenant-current', 'recover')] }, answer('report.json covers alpha and beta; new-account provisioned; quota unknown.')],
  focus: [{ decision: 'redirect' }, { decision: 'allow' }], settlement: [completed()] }, async box => {
  await productionCli(box);
  const results = toolResults(box);
  const wrong = results.find(r => r.toolCallId === 'wrong');
  assert(wrong?.isError); assert.match(text(wrong), /tenant-current|original|report/i);
  assert.equal(results.find(r => r.toolCallId === 'recover')?.isError, false);
  absent(box, 'ticket'); assertReport(box);
  const canonical = cliState(box);
  assert.equal(canonical.goal, undefined); assert.equal(canonical.goalCleared, true);
  assert.equal(canonical.focus.origin.originalText, ORIGINAL);
  const authorities = routes(box).filter(r => r.kind === 'focus').map(r => JSON.parse(r.prompt.match(/<authority_data>([\s\S]*?)<\/authority_data>/)[1]));
  assert.equal(authorities[0].goal.id, authorities[1].goal.id, 'Recovery must retain the exact bound goal');
  assert.equal(canonical.focus.goalId, authorities[0].goal.id);
  const settledBranch = records(box, 'production-hooks.jsonl').find(r => r.kind === 'settled').branch;
  assert(settledBranch.some(e => e.customType === 'supervisor.focus-ref' && e.data.goalId === canonical.focus.goalId));
  assert.equal(achievements(box).length, 1);
  assert(!existsSync(join(box.cwd, '.agents/supervisor/Goal.md')), 'Agent goal is session-only');
  assert(routes(box).filter(r => r.kind === 'actor')[2].prompt.includes(text(wrong)), 'Actual blocked result reaches recovery actor');
  counts(box, { actor: 4, focus: 2, settlement: 1 });
}, { cli: true });

add('Wrong-target mutation blocked; historical reads remain allowed', script([
  effect('tenant-old', 'history', { operation: 'read' }), effect('tenant-old', 'wrong-target'), effect('tenant-current', 'right-target')],
[{ decisions: ['allow', 'redirect', 'allow'] }]), box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL);
  absent(box, 'tenant-old'); assertReport(box); assertAnchor(box, manager);
  assert(effects(box).some(e => e.id === 'history' && e.operation === 'read'));
  assert.equal(toolResults(box).find(r => r.toolCallId === 'history')?.isError, false);
  assert(toolResults(box).find(r => r.toolCallId === 'wrong-target')?.isError);
  counts(box, { actor: 3, focus: 1, settlement: 1 });
}));

for (const [name, target] of [['Dependency prerequisites', 'docs'], ['Minimal authorized redaction', 'redact']])
  add(`${name} proceeds without replacing original contract`, script([effect(target), effect('tenant-current')], [{ decision: 'allow' }]), box => sdk(box, async ({ session, manager }) => {
    await session.prompt(ORIGINAL);
    assert(effects(box).some(e => e.target === target)); assertReport(box);
    const s = assertAnchor(box, manager); assert.equal(s.goal.condition, ORIGINAL);
    assert.equal(s.attempts?.count ?? 0, 0, 'Ordinary allow checks spend no correction attempts');
    counts(box, { actor: 3, focus: 1, settlement: 1 });
  }));

const temporary = `${ORIGINAL} First make a temporary local ticket, then return to the audit; ticket alone is not completion.`;
add('Explicit operator-authorized temporary detour retains unfinished mission', {
  actor: [{ calls: [goalCall({ condition: temporary })] }, { calls: [effect('ticket')] }, answer('Temporary ticket created; main report remains pending. Operator quota authorization needed.')],
  focus: [{ decision: 'allow' }], settlement: [humanOnly()] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(temporary);
  const s = assertAnchor(box, manager, temporary);
  assert.equal(s.goal.condition, temporary); assert(effects(box).some(e => e.target === 'ticket'));
  assert(!existsSync(join(box.cwd, 'report.json')));
  counts(box, { actor: 3, focus: 1, settlement: 1 });
}));

add('Mandated wrapper: direct operation blocks; wrapper progresses', {
  actor: [{ calls: [goalCall()] }, { calls: [effect('direct-ssh')] }, { calls: [effect('wrapper')] }, answer('Wrapper succeeded; quota authorization is still human-only.')],
  focus: [{ decision: 'redirect' }, { decision: 'allow' }], settlement: [humanOnly()] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'direct-ssh');
  assert(effects(box).some(e => e.target === 'wrapper')); assertAnchor(box, manager);
  assert(toolResults(box).find(r => r.toolCallId === 'direct-ssh')?.isError);
  counts(box, { actor: 4, focus: 2, settlement: 1 });
}));

add('Dynamically nested wrong action receives independent native gate', script([
  { name: 'production_nested', id: 'parent', arguments: { target: 'tenant-old' } }], [{ decision: 'allow' }, { decision: 'redirect' }]), box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'tenant-old'); assertAnchor(box, manager);
  const calls = records(box, 'production-hooks.jsonl').filter(r => r.kind === 'tool_call');
  assert(calls.some(r => r.event.toolCallId === 'parent/1' && r.event.parentToolCallId === 'parent'));
  assert.equal(records(box, 'production-hooks.jsonl').find(r => r.kind === 'nested-outcome').result.isError, true);
  assert.equal(toolResults(box).find(r => r.toolCallId === 'parent').nestedCalls.calls[0].status, 'error');
  counts(box, { actor: 3, focus: 2, settlement: 1 });
}));

add('Earlier changed validated arguments cannot reuse prepared allow', {
  ...script([effect('tenant-current', 'mutated')], [{ decision: 'allow' }, { decision: 'redirect' }]), earlierMutation: true }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'tenant-old'); absent(box, 'tenant-current'); assertAnchor(box, manager);
  assert(toolResults(box).find(r => r.toolCallId === 'mutated')?.isError);
  const audits = routes(box).filter(r => r.kind === 'focus');
  assert.equal(audits.length, 2); assert.match(audits[1].prompt, /tenant-old/);
  const actions = audits.map(r => JSON.parse(r.prompt.match(/<untrusted_actions>([\s\S]*?)<\/untrusted_actions>/)[1]));
  assert.notEqual(actions[0][0].hash, actions[1][0].hash);
}));

add('Missing prepared cache after finalized batch change must recheck or hold', {
  ...script([effect('tenant-current', 'changed')], [{ decision: 'allow' }, { decision: 'redirect' }]), changedBatch: true }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'tenant-old'); assertAnchor(box, manager);
  assert(toolResults(box).find(r => r.toolCallId === 'unprepared')?.isError, 'Actual unprepared native call must not implicitly allow');
  assert.equal(routes(box).filter(r => r.kind === 'focus').length, 2, 'Cache absence must assess actual new arguments');
}));

add('Goal declaration and work in one parallel batch cannot run unarmed sibling', {
  actor: [{ calls: [goalCall(), effect('ticket', 'same-batch')] }, answer('Awaiting operator authorization.')], focus: [], settlement: [humanOnly()] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'ticket'); assertAnchor(box, manager);
  assert(toolResults(box).find(r => r.toolCallId === 'same-batch')?.isError);
  assert.equal(routes(box).filter(r => r.kind === 'focus').length, 0, 'Proposed goal is not an executed bound contract');
}));

add('Replacement proposal and work in one parallel batch defer sibling effects', {
  actor: [{ calls: [goalCall()] }, answer('Awaiting operator quota authorization.'),
    { calls: [goalCall({ condition: 'Replace the audit with a local ticket.', replace: true }), effect('ticket', 'replacement-sibling')] }, answer('Awaiting clarification.')],
  focus: [], settlement: [humanOnly(), humanOnly()] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL);
  const first = assertAnchor(box, manager);
  await session.prompt('Explicitly replace the audit with a local ticket.');
  absent(box, 'ticket');
  assert(toolResults(box).find(r => r.toolCallId === 'replacement-sibling')?.isError);
  assert.notEqual(state(box, manager).goal.id, first.goal.id, 'Real operator redirection permits a new contract');
}));

for (const mode of ['json', 'print']) add(`Production ${mode} mixed unknown hold: visible feedback, no automatic actor retry`, {
  actor: [{ calls: [goalCall()] }, { calls: [effect('tenant-current'), effect('unknown'), effect('ticket')] }],
  focus: [{ decisions: ['allow', 'hold', 'redirect'] }], settlement: [] }, async box => {
  const output = await productionCli(box, { mode, expectedCode: mode === 'print' ? 1 : 0 });
  absent(box, 'unknown'); absent(box, 'ticket');
  const canonical = cliState(box); assert(canonical.focus.hold); assert.equal(canonical.goal.status, 'active');
  assert.equal(canonical.focus.origin.originalText, ORIGINAL); assert.equal(achievements(box).length, 0);
  // Already-running authorized siblings are not rolled back by a later nested hold.
  counts(box, { actor: 2, focus: 1, settlement: 0 });
  if (mode === 'print') assert.match(output.stderr, /Focus hold: [\s\S]*Work is paused, not completed\./, 'Print abort exit 1 is not success and still needs the actual hold diagnostic');
  else {
    assert(events(box).some(e => e.type === 'agent_settled' && e.aborted));
    assert(events(box).some(e => e.type === 'message_end' && e.message.role === 'custom' && e.message.display && /Focus hold:/.test(text(e.message))));
  }
}, { cli: true });

for (const [name, fixture] of [
  ['malformed JSON', { raw: '{invalid' }], ['missing hash coverage', { raw: '{"decisions":[]}' }],
  ['terminal output truncation', { decision: 'allow', stopReason: 'length' }], ['provider error', { decision: 'allow', error: 'FIXTURE provider unavailable' }],
  ['30-second production timeout', { decision: 'allow', delayMs: 32000 }],
]) add(`Focus ${name}: hold, no implicit permission or retry loop`, {
  actor: [{ calls: [goalCall()] }, { calls: [effect('tenant-current')] }], focus: [{ decision: 'allow', ...fixture }], settlement: [] }, box => sdk(box, async ({ session, manager }) => {
  const start = Date.now(); await session.prompt(ORIGINAL);
  absent(box, 'tenant-current'); held(box, manager);
  counts(box, { actor: 2, focus: 1, settlement: 0 });
  const journalPath = join(box.cwd, '.supervisor/sessions', manager.getSessionId(), 'verdicts.jsonl');
  const focusUsage = () => readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.kind.startsWith('pi:focus') && r.usage);
  await waitFor(() => focusUsage().length > 0, 'reported faulted-audit usage');
  assert.equal(focusUsage().length, 1, 'Even failed/late usage is attributed exactly once');
  assert.equal(focusUsage()[0].usage.totalTokens, 2);
  assert(focusUsage()[0].model); assert(Number.isFinite(focusUsage()[0].latencyMs));
  if (fixture.delayMs) {
    assert(Date.now() - start >= 29000, 'Must use real production timeout, not a test-only short deadline');
    assert(Date.now() - start < 38000, 'Deadline must actually bound waiting');
  }
}), { allowAuditFailure: !!fixture.error || !!fixture.delayMs, ...(fixture.delayMs ? { timeoutMs: 43000 } : {}) });

add('Duplicate sibling redirects coalesce one correction and share settlement budget', {
  actor: [{ calls: [goalCall()] }, { calls: [effect('ticket', 'bad-1'), effect('tenant-old', 'bad-2')] }, answer('Still need to produce report.json.'), answer('Operator quota authorization is now the only blocker.')],
  focus: [{ decision: 'redirect' }], settlement: [unmet(), humanOnly()] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'ticket'); absent(box, 'tenant-old');
  const s = assertAnchor(box, manager);
  assert.equal(s.attempts.count, 2, 'One batch correction + one settlement continuation, not three independent counters');
  assert.equal(s.goal.attempts, 2);
  assert.equal(toolResults(box).filter(r => ['bad-1', 'bad-2'].includes(r.toolCallId) && r.isError).length, 2);
  counts(box, { actor: 4, focus: 1, settlement: 2 });
}));

add('Usage separately observable, existing tool usage preserved without double counting', {
  ...script([effect('docs', 'usage', { operation: 'read' })], [{ decision: 'allow' }]), toolUsage: true }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); assertAnchor(box, manager);
  const path = join(box.cwd, '.supervisor/sessions', manager.getSessionId(), 'verdicts.jsonl');
  assert(existsSync(path), 'Missing separately observable audit usage');
  const journal = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  const usageRecords = journal.filter(r => r.usage);
  assert.equal(usageRecords.length, 3, 'One declaration + one focus + one settlement usage record, no duplicate billing');
  assert.equal(usageRecords.reduce((n, r) => n + r.usage.totalTokens, 0), 6);
  for (const r of usageRecords) { assert(r.model); assert(Number.isFinite(r.latencyMs)); }
  const tool = toolResults(box).find(r => r.toolCallId === 'usage');
  assert(tool.usage.totalTokens >= 7, 'Pre-existing own tool usage must survive');
  assert.equal(tool.usage.totalTokens, 9, 'Own seven tokens plus exactly one two-token focus audit');
  assert.equal(session.getSessionStats().tokens.total, 17, 'Six actor + two declaration + nine tool tokens; settlement remains separately journaled');
  assert(!manager.getBranch().some(e => e.type === 'custom' && /usage/i.test(e.customType)), 'Custom appendEntry must not masquerade as a native usage entry');
  counts(box, { actor: 3, focus: 1, settlement: 1 });
}));

add('Actual package-bin builtin write/read smoke runs production guard, not only fixture tools', {
  actor: [{ calls: [goalCall()] }, { calls: [{ name: 'write', id: 'builtin-write', arguments: { path: 'builtin-smoke.txt', content: 'LOCAL deterministic builtin smoke\n' } }] },
    { calls: [{ name: 'read', id: 'builtin-read', arguments: { path: 'builtin-smoke.txt' } }] }, answer('builtin-smoke.txt read back successfully. Operator quota authorization remains.')],
  focus: [{ decision: 'allow' }, { decision: 'allow' }], settlement: [humanOnly()] }, async box => {
  await productionCli(box, { builtins: true });
  assert.equal(readFileSync(join(box.cwd, 'builtin-smoke.txt'), 'utf8'), 'LOCAL deterministic builtin smoke\n');
  for (const id of ['builtin-write', 'builtin-read']) assert.equal(toolResults(box).find(r => r.toolCallId === id)?.isError, false);
  assert.match(text(toolResults(box).find(r => r.toolCallId === 'builtin-read')), /deterministic builtin smoke/);
  counts(box, { actor: 4, focus: 2, settlement: 1 });
}, { cli: true });

add('Finite correction ceiling never permits the rejected action or starts a retry loop', {
  actor: [{ calls: [goalCall()] }, { calls: [effect('ticket', 'first-drift')] }, { calls: [effect('tenant-old', 'second-drift')] }],
  focus: [{ decision: 'redirect' }, { decision: 'redirect' }], settlement: [] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt('/supervisor retry 1');
  await session.prompt(ORIGINAL); absent(box, 'ticket'); absent(box, 'tenant-old');
  const s = held(box, manager); assert.equal(s.attempts.count, 1); assert.equal(s.goal.attempts, 1);
  counts(box, { actor: 3, focus: 2, settlement: 0 });
  assert.match(readFileSync(join(box.cwd, '.supervisor/loop-exit.log'), 'utf8'), /runaway_ceiling/);
}));

add('Nested blocked-action usage is journaled once and attaches only to the parent result', script([
  { name: 'production_nested', id: 'usage-parent', arguments: { target: 'tenant-old' } }], [{ decision: 'allow' }, { decision: 'redirect' }]), box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); absent(box, 'tenant-old'); assertAnchor(box, manager);
  const journal = readFileSync(join(box.cwd, '.supervisor/sessions', manager.getSessionId(), 'verdicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const checks = journal.filter(r => r.usage);
  assert.equal(checks.length, 4, 'declaration + parent + nested + settlement; never duplicate records');
  assert.equal(checks.reduce((n, r) => n + r.usage.totalTokens, 0), 8);
  const parent = toolResults(box).find(r => r.toolCallId === 'usage-parent');
  assert.equal(parent.usage.totalTokens, 4, 'Two focus calls attach exactly once, not twice via nested aggregation');
  assert.equal(parent.nestedCalls.calls[0].status, 'error');
  assert.equal(session.getSessionStats().tokens.total, 12, 'Nested focus usage rolls up once; separately journaled settlement is not faked into native totals');
  counts(box, { actor: 3, focus: 2, settlement: 1 });
}));

add('Dynamic nested hold with a genuinely successful sibling aborts without automatic follow-up', {
  actor: [{ calls: [goalCall()] }, { calls: [effect('docs', 'successful-sibling', { operation: 'read' }),
    { name: 'production_nested', id: 'hold-parent', arguments: { target: 'unknown' } }] }],
  focus: [{ decision: 'allow' }, { decision: 'hold' }], settlement: [] }, box => sdk(box, async ({ session, manager }) => {
  await session.prompt(ORIGINAL); held(box, manager); absent(box, 'unknown');
  assert(effects(box).some(e => e.id === 'successful-sibling'), 'Authorized effects already executed are not rolled back');
  assert.equal(toolResults(box).find(r => r.toolCallId === 'successful-sibling')?.isError, false, 'Actual successful native tool result, not just a preparation event');
  assert(records(box, 'production-hooks.jsonl').some(r => r.kind === 'tool_call' && r.event.parentToolCallId === 'hold-parent'));
  counts(box, { actor: 2, focus: 2, settlement: 0 });
}));

await runCases(cases, import.meta.url, 24);
