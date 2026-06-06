#!/usr/bin/env node
/**
 * on-stop.mjs — Claude Code Stop hook entry-point for the supervisor plugin.
 *
 * Reads the CC Stop payload from stdin (JSON), applies safety rails, reads the
 * transcript tail, builds a stop-context, classifies it with the shared judge
 * (core/judge-core.mjs), and injects a continuation prompt when the agent
 * stopped prematurely. Patterns/anti-patterns come from core/patterns.json
 * (shipped ⊕ user-local), so /supervisor:train sharpens behavior without code
 * changes.
 *
 * Artifacts under <cwd>/.supervisor/: verdict_<sid>.json, <sid>_attempts.json,
 * current_session, disabled, debug.log.
 *
 * Public API (re-exported for unit tests):
 *   readTranscriptTail, buildStopContext, loopGuard, readAttempts,
 *   writeAttemptCounter, writeVerdict, sanitizeCwd, debug
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyStop } from '../core/judge-core.mjs';
import { buildFeedback, injectCategories } from '../core/feedback-core.mjs';
import { loadPatterns } from '../core/patterns.mjs';

const STATE_DIR = '.supervisor';
const MAX_ATTEMPTS = parseInt(process.env.SUPERVISOR_MAX_ATTEMPTS ?? process.env.REFLECTION_CC_MAX_ATTEMPTS ?? '3', 10);
const DEBUG_ENABLED = (process.env.SUPERVISOR_DEBUG ?? process.env.REFLECTION_CC_DEBUG) === '1';
const TRANSCRIPT_MAX_BYTES = 200_000;
const TRANSCRIPT_MAX_ENTRIES = 50;

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
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    fs.appendFileSync('/tmp/supervisor-cc-crash.log', line);
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
  const attempts = readAttempts(session_id, cwd);
  if (attempts >= MAX_ATTEMPTS) {
    debug({ msg: 'attempt_cap_reached', session_id, attempts, max: MAX_ATTEMPTS }, cwd);
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

  // 4. Load patterns once; share across judge + feedback.
  const patterns = loadPatterns({ cwd });

  // 5. Judge.
  let verdict;
  try {
    verdict = await classifyStop(ctx, { patterns, cwd });
  } catch (e) {
    debug({ msg: 'judge_threw', err: String(e?.message ?? e) }, cwd);
    verdict = { category: 'API_ERROR', reason: String(e?.message ?? e), confidence: 0 };
  }
  debug({ msg: 'verdict', category: verdict.category, confidence: verdict.confidence }, cwd);

  const nextAttempt = attempts + 1;
  const verdictRecord = { ...verdict, session_id, attempt: nextAttempt, timestamp: new Date().toISOString(), injected: false };

  // 6. Inject decision.
  if (injectCategories(patterns).has(verdict.category)) {
    const fb = buildFeedback(verdict.category, ctx, nextAttempt, patterns);
    if (fb.shouldInject) {
      writeAttemptCounter(session_id, nextAttempt, cwd);
      verdictRecord.injected = true;
      verdictRecord.feedback_reason = fb.reason;
      writeVerdict(session_id, verdictRecord, cwd);
      const out = { decision: 'block', reason: fb.additionalContext || fb.reason };
      process.stdout.write(JSON.stringify(out));
      debug({ msg: 'inject_sent', category: verdict.category, attempt: nextAttempt, reason: fb.reason }, cwd);
      process.exit(0);
    }
  }

  writeVerdict(session_id, verdictRecord, cwd);
  debug({ msg: 'no_inject', category: verdict.category, attempt: nextAttempt }, cwd);
  process.exit(0);
}

// Only run when executed directly (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
