#!/usr/bin/env node
/**
 * on-stop.mjs — Claude Code Stop hook entry-point for the supervisor plugin.
 *
 * Reads the CC Stop payload from stdin (JSON), applies safety rails, reads the
 * transcript tail, normalises it to the shared message format, builds a task
 * context, runs the self-assessment pipeline (buildSelfAssessmentPrompt →
 * callAnthropic → parseSelfAssessmentJson → evaluateSelfAssessment), and
 * injects a continuation prompt when the agent stopped prematurely.
 *
 * Artifacts under <cwd>/.supervisor/: verdict_<sid>.json, <sid>_attempts.json,
 * current_session, disabled, debug.log.
 *
 * Public API (re-exported for unit tests):
 *   readTranscriptTail, buildStopContext, loopGuard, readAttempts,
 *   writeAttemptCounter, writeVerdict, sanitizeCwd, debug,
 *   normalizeTranscriptToMessages, buildTaskContextFromTranscript
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAnthropic } from '../core/llm-client.mjs';
import {
  SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER,
  inferTaskType, extractToolCommands, detectSignals,
  getRecentCommands, hasLocalTestCommand, pushedToDefaultBranch,
  hasCodeChangeEvidence, isPlanMode, evaluateSelfAssessment,
} from '../core/evaluation.mjs';
import { buildSelfAssessmentPrompt, parseSelfAssessmentJson } from '../core/assessment.mjs'
import { loadParsedRubric } from '../core/rubric-loader.mjs';
import { buildEscalatingFeedback } from '../core/feedback.mjs';
import { goalStore, resolveMaxAttempts, decideGoalTransition, resolveSupervisorMode } from '../core/goal.mjs';

const STATE_DIR = '.supervisor';
const MAX_ATTEMPTS = parseInt(process.env.SUPERVISOR_MAX_ATTEMPTS ?? process.env.REFLECTION_CC_MAX_ATTEMPTS ?? '3', 10);
const DEBUG_ENABLED = (process.env.SUPERVISOR_DEBUG ?? process.env.REFLECTION_CC_DEBUG) === '1';
const TRANSCRIPT_MAX_BYTES = 200_000;
const TRANSCRIPT_MAX_ENTRIES = 50;
const ASSESSMENT_MODEL = process.env.SUPERVISOR_MODEL ?? process.env.REFLECTION_CC_MODEL ?? 'claude-haiku-4-5';
const ASSESSMENT_TIMEOUT_MS = 30_000;

process.on('uncaughtException', (err) => {
  _debugRaw({ msg: 'uncaught_exception', error: String(err), stack: err?.stack });
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  _debugRaw({ msg: 'unhandled_rejection', reason: String(reason) });
  process.exit(0);
});

function _debugRaw(obj) {
  if (!DEBUG_ENABLED) return;
  const dir = path.join(process.cwd(), STATE_DIR);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'cc-crash.log'), line);
  } catch {
    process.stderr.write(line);
  }
}

export function debug(obj, cwd) {
  if (!DEBUG_ENABLED) return;
  const dir = path.join(cwd ?? process.cwd(), STATE_DIR);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), line);
  } catch (err) {
    process.stderr.write(`[on-stop.mjs] debug write failed: ${err}\n`);
  }
}

export function sanitizeCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('supervisor: invalid cwd');
  }
  const resolved = path.resolve(cwd);
  if (resolved !== cwd) throw new Error('supervisor: invalid cwd');
  return resolved;
}

export function loopGuard(stopPayload) {
  return stopPayload?.stop_hook_active === true;
}

export function readAttempts(session_id, cwd) {
  const file = path.join(cwd, STATE_DIR, `${session_id}_attempts.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.count === 'number' ? parsed.count : 0;
  } catch {
    debug({ msg: 'attempts_file_corrupt', file }, cwd);
    return 0;
  }
}

export function writeAttemptCounter(session_id, n, cwd) {
  const dir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session_id}_attempts.json`);
  let existingCount = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed.count === 'number') existingCount = parsed.count;
  } catch {
    /* missing or corrupt — treat as 0 */
  }
  if (n <= existingCount) return;
  const tmp = path.join(dir, `${session_id}_attempts.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ count: n, last_iso: new Date().toISOString() }), 'utf8');
  fs.renameSync(tmp, file);
}

export function writeVerdict(session_id, verdictObj, cwd) {
  const dir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `verdict_${session_id}.json`), JSON.stringify(verdictObj, null, 2), 'utf8');
}

export function readTranscriptTail(filePath, maxBytes = TRANSCRIPT_MAX_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const fileSize = stat.size;
  const readSize = Math.min(maxBytes, fileSize);
  const offset = fileSize - readSize;
  let buffer;
  let fd;
  try {
    buffer = Buffer.alloc(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, offset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  const rawText = buffer.toString('utf8');
  const lines = rawText.split('\n');
  const startIdx = offset === 0 ? 0 : 1;
  const filtered = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = entry?.type;
    if (t === 'user' || t === 'assistant') {
      if (t === 'user') {
        const content = entry?.message?.content;
        if (Array.isArray(content) && content.every((c) => c?.type === 'tool_result')) continue;
      }
      filtered.push(entry);
    }
  }
  return filtered.slice(-TRANSCRIPT_MAX_ENTRIES);
}

export function buildStopContext(stopPayload, transcriptTail) {
  const session_id = stopPayload?.session_id ?? 'unknown';
  const cwd = stopPayload?.cwd ?? process.cwd();
  const attempt = readAttempts(session_id, cwd);

  const user_messages = [];
  for (const entry of transcriptTail) {
    if (entry.type !== 'user') continue;
    const content = entry?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      user_messages.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          user_messages.push(block.text.trim());
        }
      }
    }
  }

  let final_assistant_text = (stopPayload?.last_assistant_message ?? stopPayload?.response ?? '').trim();
  if (!final_assistant_text) {
    for (let i = transcriptTail.length - 1; i >= 0; i--) {
      const entry = transcriptTail[i];
      if (entry.type !== 'assistant') continue;
      const content = entry?.message?.content;
      if (!Array.isArray(content)) break;
      const textBlocks = content.filter((c) => c?.type === 'text');
      if (textBlocks.length > 0) {
        final_assistant_text = textBlocks.map((b) => b.text).join('\n').trim();
        break;
      }
    }
  }

  const toolNames = new Set();
  for (const entry of transcriptTail) {
    if (entry.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') toolNames.add(block.name);
    }
  }
  const tools_available_inferred = [...toolNames].sort();

  return { session_id, attempt, user_messages, final_assistant_text, tools_available_inferred, raw_tail: transcriptTail };
}

/**
 * Convert CC transcript entries (type/message.content format) to the shared
 * opencode-compatible message format used by evaluation.mjs helpers.
 * @param {Array} transcriptTail  — entries from readTranscriptTail
 * @returns {Array<{ info: { role: string }, parts: Array }>}
 */
export function normalizeTranscriptToMessages(transcriptTail) {
  const messages = [];
  for (const entry of transcriptTail) {
    const role = entry.type; // 'user' or 'assistant'
    if (role !== 'user' && role !== 'assistant') continue;
    const content = entry?.message?.content;
    const parts = [];
    if (typeof content === 'string') {
      if (content.trim()) parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          // Lowercase to match opencode's tool naming (CC uses TitleCase, evaluation.mjs expects lowercase)
          parts.push({ type: 'tool', tool: block.name.toLowerCase(), state: { input: block.input ?? {} } });
        }
      }
    }
    messages.push({ info: { role }, parts });
  }
  return messages;
}

/** Read repo signals synchronously — mirrors getRepoSignals in supervisor-impl.ts. */
function getRepoSignalsSync(cwd) {
  let hasTestScript = false;
  let hasBuildScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts ?? {};
    hasTestScript = Boolean(scripts.test || scripts['test:ci'] || scripts['test:e2e']);
    hasBuildScript = Boolean(scripts.build || scripts['build:prod']);
  } catch { /* no package.json or parse error */ }
  let hasTestsDir = false;
  for (const d of ['test', 'tests']) {
    try { fs.statSync(path.join(cwd, d)); hasTestsDir = true; break; } catch { /* */ }
  }
  return { hasTestScript, hasBuildScript, hasTestsDir };
}

/** Read AGENTS.md synchronously. */
function getAgentsSync(cwd) {
  for (const name of ['AGENTS.md', '.opencode/AGENTS.md', 'agents.md']) {
    try { return fs.readFileSync(path.join(cwd, name), 'utf8'); } catch { /* */ }
  }
  return '';
}

/**
 * Build a TaskContext from normalized messages — synchronous mirror of
 * buildTaskContext in opencode/supervisor-impl.ts.
 * Returns null when no human messages are found (nothing to assess).
 * Accepts normalized message objects, but tolerates raw transcript entries.
 * @param {Array} normalizedMessages
 * @param {string} [cwd]
 * @returns {object|null}
 */
export function buildTaskContextFromTranscript(normalizedMessages, cwd) {
  const messages =
    Array.isArray(normalizedMessages) &&
    normalizedMessages.every((msg) => msg?.info?.role && Array.isArray(msg?.parts))
      ? normalizedMessages
      : normalizeTranscriptToMessages(normalizedMessages ?? []);
  const humanMessages = [];
  let lastAssistantText = '';

  for (const msg of messages) {
    if (msg.info?.role === 'user') {
      for (const part of msg.parts ?? []) {
        if (part.type === 'text' && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) continue;
          humanMessages.push(part.text);
          break;
        }
      }
    }
    if (msg.info?.role === 'assistant') {
      for (const part of msg.parts ?? []) {
        if (part.type === 'text' && part.text) lastAssistantText = part.text;
      }
    }
  }

  if (humanMessages.length === 0) return null;

  const taskSummary = humanMessages.length === 1
    ? humanMessages[0]
    : humanMessages.map((m, i) => `[${i + 1}] ${m}`).join('\n\n');

  const combinedText = `${humanMessages.join(' ')} ${lastAssistantText}`;
  const taskType = inferTaskType(combinedText);
  const agentMode = isPlanMode(messages) ? 'plan' : 'build';

  const repoSignals = getRepoSignalsSync(cwd ?? process.cwd());
  const commands = extractToolCommands(messages);
  const detectedSignals = detectSignals(combinedText, commands);
  const recentCommands = getRecentCommands(commands);
  const hasLocalTests = hasLocalTestCommand(commands);
  const pushedDefault = pushedToDefaultBranch(commands);

  const requiresTests = taskType === 'coding' &&
    (repoSignals.hasTestScript || repoSignals.hasTestsDir || detectedSignals.includes('test-mention'));
  const requiresBuild = taskType === 'coding' &&
    (repoSignals.hasBuildScript || detectedSignals.includes('build-mention'));
  // PR/CI are only required when the task actually changed code — not merely
  // because it was classified "coding" from a verb like "create" (e.g. "create
  // GitHub epic issues" has no diff to PR, just gh/API calls).
  const requiresPR = taskType === 'coding' && hasCodeChangeEvidence(commands);
  const requiresCI = taskType === 'coding' && hasCodeChangeEvidence(commands);
  const requiresLocalTests = requiresTests;
  const requiresLocalTestsEvidence = requiresTests && !hasLocalTests;
  const toolsSummary = commands.slice(-6).join('\n') || '(none)';

  return {
    taskSummary, taskType, agentMode, humanMessages,
    toolsSummary, detectedSignals, recentCommands,
    pushedToDefaultBranch: pushedDefault,
    requiresTests, requiresBuild, requiresPR, requiresCI,
    requiresLocalTests, requiresLocalTestsEvidence,
  };
}

function buildFakeAssessment(taskContext, category) {
  const recentTestCommands = taskContext.recentCommands.filter((command) =>
    /\bnpm\s+test\b|\bnpm\s+run\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i.test(command)
  );

  if (category === 'complete') {
    return {
      task_summary: taskContext.taskSummary,
      task_type: taskContext.taskType,
      status: 'complete',
      confidence: 0.95,
      evidence: {
        tests: {
          ran: taskContext.requiresTests ? recentTestCommands.length > 0 : false,
          results: taskContext.requiresTests ? (recentTestCommands.length > 0 ? 'pass' : 'unknown') : 'unknown',
          ran_after_changes: taskContext.requiresTests ? recentTestCommands.length > 0 : false,
          commands: recentTestCommands,
        },
        build: {
          ran: false,
          results: 'unknown',
        },
        pr: {
          created: false,
          url: '',
          ci_status: 'unknown',
          checked: false,
        },
      },
      remaining_work: [],
      next_steps: [],
      needs_user_action: [],
      stuck: false,
      alternate_approach: '',
    };
  }

  if (category === 'waiting_for_user_legitimate') {
    return {
      task_summary: taskContext.taskSummary,
      task_type: taskContext.taskType,
      status: 'waiting_for_user',
      confidence: 0.95,
      evidence: {},
      remaining_work: [],
      next_steps: [],
      needs_user_action: ['User action required before continuing'],
      stuck: false,
      alternate_approach: '',
    };
  }

  return {
    task_summary: taskContext.taskSummary,
    task_type: taskContext.taskType,
    status: 'in_progress',
    confidence: 0.95,
    evidence: {
      tests: {
        ran: false,
        results: 'unknown',
        ran_after_changes: false,
        commands: [],
      },
      build: {
        ran: false,
        results: 'unknown',
      },
      pr: {
        created: false,
        url: '',
        ci_status: 'unknown',
        checked: false,
      },
    },
    remaining_work: ['Continue implementation', 'Run required verification before stopping'],
    next_steps: ['Take next concrete tool action', 'Run tests/build/PR checks required for completion'],
    needs_user_action: [],
    stuck: false,
    alternate_approach: '',
  };
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    debug({ msg: 'stdin_parse_error', error: String(err) }, process.cwd());
    process.exit(0);
  }

  // 1. Loop guard — must run first.
  if (loopGuard(payload)) {
    debug({ msg: 'loop_guard_triggered', session_id: payload.session_id }, payload.cwd);
    process.exit(0);
  }

  const { session_id, transcript_path } = payload;
  const cwd = sanitizeCwd(payload?.cwd ?? process.cwd());

  // 1.5. Session-scoped disable check + record current session.
  const stateDir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'current_session'), session_id, 'utf8');
  const disabledFlag = path.join(stateDir, 'disabled');
  try {
    const disabledIds = fs.readFileSync(disabledFlag, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (disabledIds.includes(session_id)) {
      debug({ msg: 'disabled_for_session', session_id }, cwd);
      process.exit(0);
    }
  } catch { /* not disabled */ }

  // 2. Attempt cap.
  // Goal loop: if a goal is active, raise the retry budget.
  // All goal logic is best-effort — any failure falls back to default.
  let goal = null;
  let goalState = {};
  let effectiveMax = MAX_ATTEMPTS;
  let mode = 'reflection';
  try {
    goalState = goalStore.load(cwd, session_id);
    mode = resolveSupervisorMode(goalState);
    if (goalState.goal && goalState.goal.status === 'active') {
      goal = goalState.goal;
      effectiveMax = resolveMaxAttempts({ sessionOverride: goalState.maxAttempts });
    } else if (mode === 'autopilot') {
      // Autopilot gets the higher budget (default 16), not the bare 3.
      effectiveMax = resolveMaxAttempts({ sessionOverride: goalState.maxAttempts });
    } else if (typeof goalState.maxAttempts === 'number') {
      effectiveMax = resolveMaxAttempts({ sessionOverride: goalState.maxAttempts });
    }
  } catch (e) {
    debug({ msg: 'goal_load_failed', err: String(e?.message ?? e) }, cwd);
    // Best-effort mode recovery: if load failed transiently, retry once so the
    // autopilot cleanup path below (setAutopilot false) can still fire correctly.
    try { mode = resolveSupervisorMode(goalStore.load(cwd, session_id)); } catch { /* */ }
  }

  const attempts = readAttempts(session_id, cwd);
  if (attempts >= effectiveMax) {
    if (goal) {
      try { goalStore.save(cwd, session_id, { ...goalState, goal: { ...goal, status: 'exhausted' } }); } catch { /* */ }
    }
    // Disable autopilot on budget exhaustion so the next stop is clean.
    if (mode === 'autopilot') {
      try { goalStore.setAutopilot(cwd, session_id, false); } catch { /* */ }
    }
    debug({ msg: 'attempt_cap_reached', session_id, attempts, max: effectiveMax, goal: !!goal }, cwd);
    process.exit(0);
  }

  // 3. Transcript tail (poll for flush).
  let tail = transcript_path ? readTranscriptTail(transcript_path) : [];
  let ctx = buildStopContext(payload, tail);
  const FLUSH_POLL_MS = 100;
  const FLUSH_POLL_MAX = 10;
  for (let i = 0; i < FLUSH_POLL_MAX && !ctx.final_assistant_text; i++) {
    await new Promise((r) => setTimeout(r, FLUSH_POLL_MS));
    tail = transcript_path ? readTranscriptTail(transcript_path) : [];
    ctx = buildStopContext(payload, tail);
  }
  if (!ctx.final_assistant_text) {
    debug({ msg: 'no_assistant_text_after_poll', session_id, tail_len: tail.length }, cwd);
    process.exit(0);
  }

  // 3a. Autopilot fast-path: skip the judge entirely; inject a "continue" nudge
  // until the agent emits AUTOPILOT_EXIT or the attempt budget runs out.
  if (mode === 'autopilot' && !goal) {
    const baseVerdict = { session_id, timestamp: new Date().toISOString() };
    if (/(^|\n)\s*AUTOPILOT_EXIT\s*(\n|$)/.test(ctx.final_assistant_text)) {
      try { goalStore.setAutopilot(cwd, session_id, false); } catch { /* */ }
      writeVerdict(session_id, { ...baseVerdict, autopilot: 'exited' }, cwd);
      debug({ msg: 'autopilot_exit', session_id }, cwd);
      process.exit(0);
    }
    const nextAttempt = attempts + 1;
    writeAttemptCounter(session_id, nextAttempt, cwd);
    const nudge = `${FEEDBACK_MARKER} Autopilot (${nextAttempt}/${effectiveMax})\n\nYou are in autopilot mode. Continue working on the current task. Do not stop to ask for permission or confirmation — proceed with implementation.\n\nWhen you have genuinely completed ALL work (not just one step), output \`AUTOPILOT_EXIT\` ALONE on its own line (nothing else on that line) to hand control back.\n\nContinue now.`;
    writeVerdict(session_id, { ...baseVerdict, injected: true, autopilot: 'continue', attempt: nextAttempt }, cwd);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: nudge }));
    debug({ msg: 'autopilot_continue', session_id, attempt: nextAttempt }, cwd);
    process.exit(0);
  }

  // 4. Build task context from transcript (shared assessment pipeline).
  const normalizedMessages = normalizeTranscriptToMessages(tail);
  const taskContext = buildTaskContextFromTranscript(normalizedMessages, cwd);
  if (!taskContext) {
    debug({ msg: 'no_task_context', session_id }, cwd);
    process.exit(0);
  }

  // 5. Self-assessment via shared pipeline.
  const agents = getAgentsSync(cwd);
  // Rubric seam: load per-project or global rubric.md if present; null falls back to DEFAULT_RUBRIC
  const injectedRubric = await loadParsedRubric(cwd);
  const prompt = buildSelfAssessmentPrompt(
    taskContext, agents, ctx.final_assistant_text, attempts, injectedRubric, effectiveMax,
  );

  const fakeJudge = process.env.SUPERVISOR_FAKE_JUDGE ?? process.env.REFLECTION_CC_FAKE_JUDGE;
  let assessmentText;
  if (fakeJudge) {
    const [category = 'summary_drift_stop'] = fakeJudge.split(':');
    assessmentText = JSON.stringify(buildFakeAssessment(taskContext, category));
  } else {
    try {
      const result = await callAnthropic({
        prompt,
        system: 'You are a precise workflow completion evaluator. Output JSON only.',
        model: ASSESSMENT_MODEL,
        maxTokens: 1000,
        timeoutMs: ASSESSMENT_TIMEOUT_MS,
      });
      assessmentText = result.text;
    } catch (e) {
      debug({ msg: 'assessment_threw', err: String(e?.message ?? e) }, cwd);
      process.exit(0);
    }
  }

  const assessment = parseSelfAssessmentJson(assessmentText);
  const analysis = assessment
    ? evaluateSelfAssessment(assessment, taskContext)
    : {
        complete: false,
        shouldContinue: true,
        reason: 'Failed to parse self-assessment',
        missing: [],
        nextActions: [],
        requiresHumanAction: false,
        severity: 'MEDIUM',
      };
  if (!assessment) {
    debug({ msg: 'assessment_parse_failed', session_id, raw: (assessmentText ?? '').slice(0, 200) }, cwd);
  }
  debug({ msg: 'assessment', complete: analysis.complete, severity: analysis.severity, status: assessment?.status }, cwd);

  const nextAttempt = attempts + 1;
  const verdictRecord = {
    session_id, attempt: nextAttempt, timestamp: new Date().toISOString(), injected: false,
    status: assessment?.status ?? 'in_progress', confidence: assessment?.confidence ?? 0.5,
    complete: analysis.complete, severity: analysis.severity, reason: analysis.reason,
  };

  // Helper: build escalating feedback message from analysis.
  function buildAnalysisFeedback() {
    return buildEscalatingFeedback(
      nextAttempt,
      analysis.severity,
      { missing: analysis.missing, next_actions: analysis.nextActions, feedback: analysis.reason },
      false,
      false,
      effectiveMax,
    );
  }

  // 6a. Goal loop: when a goal is active, keep pushing until the goal is met
  // (analysis says complete) or the budget exhausts.
  if (goal) {
    const t = decideGoalTransition({
      goal,
      complete: analysis.complete,
      now: Date.now(),
      maxAttempts: effectiveMax,
      reason: analysis.reason,
    });
    if (t.action === 'achieved') {
      try { goalStore.save(cwd, session_id, { ...goalState, goal: t.goal }); } catch { /* */ }
      verdictRecord.goal = 'achieved';
      writeVerdict(session_id, verdictRecord, cwd);
      debug({ msg: 'goal_achieved', session_id }, cwd);
      process.exit(0);
    }
    if (t.action === 'exhausted') {
      try { goalStore.save(cwd, session_id, { ...goalState, goal: t.goal }); } catch { /* */ }
      verdictRecord.goal = 'exhausted';
      writeVerdict(session_id, verdictRecord, cwd);
      debug({ msg: 'goal_exhausted', session_id }, cwd);
      process.exit(0);
    }
    // continue — but never override a genuine human-only block.
    if (!analysis.requiresHumanAction) {
      const feedbackMsg = buildAnalysisFeedback();
      const msg = `Goal not yet met: "${goal.condition}". ${feedbackMsg}`;
      writeAttemptCounter(session_id, nextAttempt, cwd);
      try { goalStore.save(cwd, session_id, { ...goalState, goal: t.goal }); } catch { /* */ }
      verdictRecord.injected = true;
      verdictRecord.goal = 'continue';
      verdictRecord.feedback_reason = 'goal_continue';
      writeVerdict(session_id, verdictRecord, cwd);
      process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
      debug({ msg: 'goal_continue_inject', session_id, attempt: nextAttempt, severity: analysis.severity }, cwd);
      process.exit(0);
    }
    // Human action required with active goal → legit pause, don't burn budget.
    verdictRecord.goal = 'paused';
    writeVerdict(session_id, verdictRecord, cwd);
    debug({ msg: 'goal_paused_user_wait', session_id }, cwd);
    process.exit(0);
  }

  // 6b. Normal (no goal) inject decision.
  if (!analysis.complete && analysis.shouldContinue && !analysis.requiresHumanAction) {
    const feedbackMsg = buildAnalysisFeedback();
    writeAttemptCounter(session_id, nextAttempt, cwd);
    verdictRecord.injected = true;
    verdictRecord.feedback_reason = 'assessment_continue';
    writeVerdict(session_id, verdictRecord, cwd);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: feedbackMsg }));
    debug({ msg: 'inject_sent', severity: analysis.severity, attempt: nextAttempt }, cwd);
    process.exit(0);
  }

  writeVerdict(session_id, verdictRecord, cwd);
  debug({ msg: 'no_inject', complete: analysis.complete, attempt: nextAttempt }, cwd);
  process.exit(0);
}

// Only run when executed directly (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
