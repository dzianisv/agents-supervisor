#!/usr/bin/env node
/** Opt-in Codex observer adapter. It records work and offers occasional advice. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordCodexObserverTool, finishCodexObserverReview, recordCodexObserverPrompt, recordCodexObserverAssistant, releaseCodexObserverReview } from '../core/codex-observer.mjs';
import { sessionStore } from '../core/session-store.mjs';

const MAX_STDIN = 1024 * 1024;
const MAX_REVIEW_CONTEXT = 64_000;
const MAX_REVIEW_OUTPUT = 64 * 1024;
const DEFAULT_REVIEW_TIMEOUT_MS = 45_000;
const BUNDLED_REVIEWER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-supervisor-review.mjs');

function readInput() {
  const chunks = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.alloc(16 * 1024);
    const n = fs.readSync(0, chunk, 0, chunk.length, null);
    if (!n) break;
    size += n;
    if (size > MAX_STDIN) throw new Error(`hook input exceeds ${MAX_STDIN} bytes`);
    chunks.push(chunk.subarray(0, n));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hook input must be a JSON object');
  return value;
}

function writeOutput(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function eventName(input) { return input.hook_event_name ?? input.event ?? ''; }
function cwdOf(input) { return path.resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd()); }
function inputArgs(input) { return input.tool_input ?? input.arguments ?? input.input ?? {}; }
function toolName(input) { return input.tool_name ?? input.tool ?? ''; }
function sessionId(input) { return input.session_id ?? input.sessionId; }
function turnId(input) { return input.turn_id ?? input.turnId; }

function loadConfig(cwd) {
  const file = path.join(cwd, '.supervisor', 'codex.json');
  if (!fs.existsSync(file)) return { present: false, enabled: false };
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid ${path.relative(cwd, file)}: ${error.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('.supervisor/codex.json must contain an object');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (config.observer !== undefined && (!config.observer || typeof config.observer !== 'object' || Array.isArray(config.observer))) throw new Error('observer must be an object');
  const observer = config.observer ?? {};
  if (observer.enabled !== undefined && typeof observer.enabled !== 'boolean') throw new Error('observer.enabled must be boolean');
  const everyToolCalls = observer.everyToolCalls ?? 10;
  if (!Number.isInteger(everyToolCalls) || everyToolCalls < 1 || everyToolCalls > 100) throw new Error('observer.everyToolCalls must be an integer from 1 to 100');
  if (config.reviewerCommand !== undefined && (!Array.isArray(config.reviewerCommand) || !config.reviewerCommand.length || config.reviewerCommand.some((x) => typeof x !== 'string') || !config.reviewerCommand[0].trim())) throw new Error('reviewerCommand must be a non-empty argv array of strings');
  if (config.reviewerTimeoutMs !== undefined && (!Number.isInteger(config.reviewerTimeoutMs) || config.reviewerTimeoutMs < 1_000 || config.reviewerTimeoutMs > 50_000)) throw new Error('reviewerTimeoutMs must be an integer from 1000 to 50000');
  return {
    present: true,
    plannerModel: config.plannerModel ?? 'gpt-6.1-sol',
    executorModel: config.executorModel ?? 'gpt-6-luna',
    observer: { ...observer, enabled: config.enabled !== false && observer.enabled === true, everyToolCalls },
    reviewerCommand: config.reviewerCommand ?? [process.execPath, BUNDLED_REVIEWER],
    reviewerTimeoutMs: config.reviewerTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
  };
}

function isDisabled(input, cwd) {
  if (/^(1|true)$/i.test(process.env.SUPERVISOR_DISABLED ?? '') || input.supervisor_disabled === true) return true;
  const sid = sessionId(input);
  if (!sid) return false;
  if (sessionStore.load(cwd, sid)?.disabled === true) return true;
  try { return fs.readFileSync(path.join(cwd, '.supervisor', 'disabled'), 'utf8').split(/\r?\n/).map((x) => x.trim()).includes(sid); }
  catch { return false; }
}

function targetFiles(value, base, out = new Set(), depth = 0) {
  if (depth > 8 || value == null) return [...out];
  if (typeof value === 'string') {
    if (/^(?:\.\.?\/|\/|[A-Za-z]:\\)/.test(value) && value.length < 2048) out.add(path.resolve(base, value));
  } else if (Array.isArray(value)) for (const item of value.slice(0, 100)) targetFiles(item, base, out, depth + 1);
  else if (typeof value === 'object') for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/^(path|file|filename|target|file_path|workdir|cwd)$/i.test(key) && typeof item === 'string') out.add(path.resolve(base, item));
    else if (typeof item === 'object') targetFiles(item, base, out, depth + 1);
  }
  return [...out];
}

function applicableInstructions(cwd, calls) {
  const dirs = new Set();
  const addParents = (dir) => {
    for (let current = dir, i = 0; i < 12; i++) {
      dirs.add(current);
      if (current === path.dirname(current)) break;
      current = path.dirname(current);
    }
  };
  addParents(cwd);
  for (const call of calls ?? []) for (const file of targetFiles(call?.tool_input, cwd)) addParents(path.dirname(file));
  const docs = [];
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
    const file = path.join(dir, 'AGENTS.md');
    try { docs.push(`<document path="${file}">\n${fs.readFileSync(file, 'utf8')}\n</document>`); }
    catch { /* no instruction file at this level */ }
  }
  return docs.join('\n');
}

function bounded(value, depth = 0, budget = { chars: 3_000, nodes: 180 }) {
  if (--budget.nodes < 0) return '[TRUNCATED: item limit]';
  if (typeof value === 'string') {
    const length = Math.max(0, Math.min(value.length, budget.chars));
    budget.chars -= length;
    if (length >= value.length) return value;
    const first = Math.ceil(length * 0.65);
    const last = Math.max(0, length - first);
    return `${value.slice(0, first)}\n[TRUNCATED: middle omitted]\n${last ? value.slice(-last) : ''}`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 8) return '[TRUNCATED: nesting limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((x) => bounded(x, depth + 1, budget));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k.slice(0, 120), bounded(v, depth + 1, budget)]));
  return undefined;
}

function runReviewer(command, event, cwd, timeoutMs) {
  const recentTools = (event.recent_tools ?? []).slice(-10).map((call) => ({
    ...call,
    tool_input: bounded(call.tool_input, 0, { chars: 1_350, nodes: 120 }),
    tool_output: bounded(call.tool_output, 0, { chars: 1_350, nodes: 120 }),
  }));
  const safeEvent = {
    event: event.event,
    observed_turn_id: event.observed_turn_id,
    user_requests: bounded(event.user_requests, 0, { chars: 5_000, nodes: 120 }),
    user_prompt: bounded(event.user_prompt, 0, { chars: 4_000, nodes: 10 }),
    delegation_policy: bounded(event.delegation_policy, 0, { chars: 3_000, nodes: 40 }),
    caller_model: bounded(event.caller_model, 0, { chars: 500, nodes: 10 }),
    instructions: bounded(event.instructions, 0, { chars: 16_000, nodes: 20 }),
    focus: bounded(event.focus, 0, { chars: 2_000, nodes: 20 }),
    delegation: bounded(event.delegation, 0, { chars: 4_000, nodes: 140 }),
    recent_tools: recentTools,
  };
  let serialized = JSON.stringify(safeEvent);
  // Keep valid JSON and newest evidence if unusually large Unicode or key names
  // expand the serialized byte count beyond the character budgets above.
  while (Buffer.byteLength(serialized) > MAX_REVIEW_CONTEXT && safeEvent.recent_tools.length > 1) {
    safeEvent.recent_tools.shift();
    serialized = JSON.stringify(safeEvent);
  }
  if (Buffer.byteLength(serialized) > MAX_REVIEW_CONTEXT) throw new Error(`review context exceeds ${MAX_REVIEW_CONTEXT} bytes`);
  const innerTimeoutMs = Math.max(1_000, Math.min(30_000, timeoutMs - 10_000));
  const env = { ...process.env, CODEX_REVIEW_TIMEOUT_MS: String(innerTimeoutMs) };
    // Leave time for the isolated reviewer to stop its own process group when
    // the configured reviewer deadline expires. The outer hook is the final
    // bound; its SIGTERM handler performs bounded descendant cleanup.
    const result = spawnSync(command[0], command.slice(1), {
      cwd, env, input: serialized, encoding: 'utf8', timeout: timeoutMs + 5_000,
      killSignal: 'SIGKILL', detached: process.platform !== 'win32',
      maxBuffer: MAX_REVIEW_OUTPUT, windowsHide: true,
    });
    if (result.error?.code === 'ETIMEDOUT' && result.pid && process.platform !== 'win32') {
      try { process.kill(-result.pid, 'SIGKILL'); } catch { /* process group already exited */ }
    }
  if (result.error || result.status !== 0) throw new Error(`reviewer unavailable: ${result.error?.message ?? `exit ${result.status}`}`);
  let verdict;
  try { verdict = JSON.parse(result.stdout); } catch { throw new Error('reviewer returned malformed JSON'); }
  if (!verdict || typeof verdict.violation !== 'boolean' || !['rules', 'delegation', 'focus', 'none'].includes(verdict.category) || typeof verdict.rule !== 'string' || typeof verdict.reason !== 'string' || typeof verdict.correction !== 'string' || typeof verdict.evidence !== 'string') throw new Error('reviewer returned malformed verdict');
  if (verdict.violation && (!verdict.correction.trim() || verdict.category === 'none' || !verdict.evidence.trim())) throw new Error('reviewer finding requires a category, evidence, and correction');
  return verdict;
}

function recordAudit(cwd, input, record) {
  const sid = sessionId(input);
  if (!sid) return;
  try { sessionStore.appendVerdict(cwd, sid, { runtime: 'codex', event: eventName(input), turnId: turnId(input), tool_name: toolName(input) || undefined, ...record }); }
  catch { /* audit logging must not disrupt a user turn */ }
}

function noOutput() { return { output: {} }; }

export function handleHook(input, cwd = cwdOf(input)) {
  const event = eventName(input);
  let config;
  try { config = loadConfig(cwd); }
  catch (error) { return { warning: `Supervisor configuration error: ${error.message}`, output: {} }; }
  if (!config.present || !config.observer.enabled || isDisabled(input, cwd)) return noOutput();

  const sid = sessionId(input);
  const tid = turnId(input);
  if (event === 'UserPromptSubmit') {
    if (sid && tid) {
      try { recordCodexObserverPrompt({ cwd, sessionId: sid, turnId: tid, turnStartedAt: input.turn_started_at, userRequest: input.prompt ?? input.user_prompt ?? '' }); }
      catch (error) { recordAudit(cwd, input, { decision: 'observer-save-warning', reason: error.message }); }
    }
    return noOutput();
  }

  if (event === 'Stop') {
    if (sid && tid) {
      try { recordCodexObserverAssistant({ cwd, sessionId: sid, turnId: tid, assistantReply: input.last_assistant_message ?? input.final_reply ?? input.response ?? '' }); }
      catch (error) { recordAudit(cwd, input, { decision: 'observer-save-warning', reason: error.message }); }
    }
    return noOutput();
  }

  if (event !== 'PostToolUse' || !sid || !tid) return noOutput();
  let observed;
  try {
    observed = recordCodexObserverTool({
      cwd, sessionId: sid, turnId: tid,
      turnStartedAt: input.turn_started_at,
      userRequest: input.prompt ?? input.user_prompt,
      toolCall: {
        tool_use_id: input.tool_use_id ?? input.tool_call_id ?? input.call_id,
        tool: toolName(input), input: inputArgs(input),
        result: input.tool_response ?? input.tool_output ?? input.output,
        model: input.model, completedAt: input.timestamp,
      },
      interval: config.observer.everyToolCalls,
    });
  } catch (error) {
    recordAudit(cwd, input, { decision: 'observer-record-warning', reason: error.message });
    return noOutput();
  }
  if (!observed?.due) return noOutput();

  try {
    const snapshot = observed.snapshot ?? {};
    const calls = (snapshot.events ?? []).map((entry) => ({ tool: entry.tool, model: entry.model, tool_input: entry.input, tool_output: entry.result, tool_use_id: entry.tool_use_id }));
    const requests = snapshot.userRequests ?? [];
    const reviewerInput = {
      // Keep the current goal in its own field, ahead of older request history.
      event: 'PostToolUse', user_prompt: requests.at(-1)?.text ?? '',
      instructions: applicableInstructions(cwd, calls),
      delegation_policy: {
        preferredPlannerModel: config.plannerModel,
        preferredExecutionModel: config.executorModel,
        allowNestedDelegation: true,
        latestExplicitUserOverrideWins: true,
        guidance: 'Delegate implementation to the execution model when useful; choose direct work or further nested delegation according to the assigned scope. Never require every task to be delegated. These are review guidelines only, never tool-call restrictions.',
      },
      caller_model: input.model ?? '',
      observed_turn_id: tid,
      user_requests: [...requests].reverse(),
      focus: snapshot.latestAssistant?.text ?? '',
      delegation: calls.filter((x) => /spawn_agent|agent/i.test(x.tool ?? '')).map((x) => ({ tool: x.tool, model: x.model, input: x.tool_input, result: x.tool_output })),
      recent_tools: calls,
    };
    const verdict = runReviewer(config.reviewerCommand, reviewerInput, cwd, config.reviewerTimeoutMs);
    const activeRequest = String(requests.at(-1)?.text ?? '').slice(0, 200);
    const feedback = verdict.violation
      ? `Observer review for turn ${tid} (${verdict.category})\nNext step: ${verdict.correction.slice(0, 2_000)}\nHuman request: ${activeRequest}\nReason: ${verdict.reason.slice(0, 600)}\nEvidence: ${verdict.evidence.slice(0, 600)}`
      : null;
    const finished = finishCodexObserverReview({ cwd, sessionId: sid, turnId: tid, token: observed.token, feedback });
    if (!finished?.inject || !verdict.violation) return noOutput();
    recordAudit(cwd, input, { decision: 'observer-finding', ruleId: verdict.category, reason: verdict.reason, evidence: verdict.evidence });
    return { output: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: finished.feedback } } };
  } catch (error) {
    try { releaseCodexObserverReview({ cwd, sessionId: sid, turnId: tid, token: observed.token }); } catch { /* best effort */ }
    recordAudit(cwd, input, { decision: 'observer-review-warning', reason: error.message });
    return noOutput();
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = handleHook(readInput());
    if (result.warning) process.stderr.write(`[codex-supervisor-hook] ${result.warning}\n`);
    writeOutput(result.output);
  } catch (error) {
    process.stderr.write(`[codex-supervisor-hook] ${error.message}\n`);
    writeOutput({});
  }
}
