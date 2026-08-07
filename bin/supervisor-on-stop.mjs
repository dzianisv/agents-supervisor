#!/usr/bin/env node
/**
 * on-stop.mjs — Claude Code Stop hook entry-point for the supervisor plugin.
 *
 * Reads the CC Stop payload from stdin (JSON), applies safety rails, reads the
 * transcript tail, normalises it to the shared message format, builds a task
 * context, runs the self-assessment pipeline (buildReflectionPrompt →
 * callAnthropic → parseSelfAssessmentJson → evaluateSelfAssessment), and
 * injects a continuation prompt when the agent stopped prematurely.
 *
 * Artifacts under <cwd>/.supervisor/: sessions/<session_id>/{state.json,
 * verdicts.jsonl}, current_session, disabled, debug.log, health.json.
 * See core/session-store.mjs — the single accessor for per-session state.
 *
 * Public API (re-exported for unit tests):
 *   readTranscriptTail, buildStopContext, loopGuard, readAttempts,
 *   writeAttemptCounter, writeVerdict, writeHealthSignal, sanitizeCwd, debug,
 *   normalizeTranscriptToMessages, buildTaskContextFromTranscript,
 *   endsWithTrailingQuestion, computeTurnKey, buildFakeAssessment
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callAnthropic } from '../core/llm-client.mjs';
import {
  SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER,
  inferTaskType, extractToolCommands, detectSignals,
  getRecentCommands, hasLocalTestCommand, isTestRunnerCommand, pushedToDefaultBranch,
  hasCodeChangeEvidence, isPlanMode, evaluateSelfAssessment,
} from '../core/evaluation.mjs';
import { parseSelfAssessmentJson } from '../core/assessment.mjs';
import { buildEscalatingFeedback, isActionlessVerdict, hasFeedbackBody } from '../core/feedback.mjs';
import { goalStore, resolveMaxAttempts, decideGoalTransition, resolveClaudeCodeHardCap, resolveSupervisorMode, buildGoalRequirementSection, readProjectGoalCondition, retireProjectGoal, isStatusDiagramEnabled } from '../core/goal.mjs';
import { sessionStore, maybeGcSessions } from '../core/session-store.mjs';
import { appendStatusDirective } from '../core/status-directive.mjs';
import { buildReflectionPrompt } from '../core/reflection-prompt.mjs';
import {
  extractLastAssistantText, currentUserTask, buildConversationChain, userMessageText,
} from '../core/task-context.mjs';
import { shouldSkipReflection } from '../core/turn-classifier.mjs';

// Plugin's own shipped .agents/supervisor dir — fallback defaults when a
// project hasn't customized SystemPrompt.md/Patterns.md/User.md/Goal.md.
// on-stop.mjs lives in bin/, so '..' reaches the repo root.
const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'supervisor');

const STATE_DIR = '.supervisor';
const MAX_ATTEMPTS = parseInt(process.env.SUPERVISOR_MAX_ATTEMPTS ?? process.env.REFLECTION_CC_MAX_ATTEMPTS ?? '3', 10);
const DEBUG_ENABLED = (process.env.SUPERVISOR_DEBUG ?? process.env.REFLECTION_CC_DEBUG) === '1';
const TRANSCRIPT_MAX_BYTES = 200_000;
const TRANSCRIPT_MAX_ENTRIES = 50;
const ASSESSMENT_MODEL = process.env.SUPERVISOR_MODEL ?? process.env.REFLECTION_CC_MODEL ?? 'claude-opus-4-8';
const ASSESSMENT_TIMEOUT_MS = 20_000;
// CC allows only 8 consecutive Stop-hook {decision:'block'} responses within
// one unbroken turn before it overrides the hook and lets the turn end
// regardless — a 9th injection would be silently discarded. Cap one under
// that so our own exhaustion handling (goal-exhausted, attempt-cap-reached)
// fires deterministically instead of being pre-empted by CC. See loopGuard's
// call site in main() for the full rationale.
// CLAUDE_CODE_STOP_HOOK_BLOCK_CAP mirrors CC's own override threshold
// (default 8); the hook always stays ONE UNDER it so a raised harness cap
// keeps the same safety margin instead of colliding with it.
const HARD_CAP = resolveClaudeCodeHardCap();
// Stamped into every verdict record so session mining can attribute observed
// behavior to the plugin version that produced it.
const PLUGIN_VERSION = (() => {
  try {
    const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version ?? 'dev';
  } catch { return 'dev'; }
})();

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

/**
 * True when the agent's final message is a genuine question to the user
 * (its last non-empty line ends in '?'). Forcing a continuation over an open
 * question recreates the "ignore the human" pattern this supervisor exists
 * to catch — a trailing question means the correct status is
 * waiting_for_user, so callers should skip the judge entirely.
 */
export function endsWithTrailingQuestion(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines[lines.length - 1].endsWith('?');
}

/**
 * Fingerprint of the last genuine (non-supervisor-injected) user message —
 * mirrors opencode's getLastRelevantUserMessageId/getMessageSignature. CC's
 * normalized messages carry no message IDs/timestamps, so the key is a
 * truncated text fingerprint of the real user turn. Used to scope the
 * per-attempt counter to the CURRENT human turn: a new real message means a
 * new turn_key, which resets the counter, while an autonomous
 * (goal/autopilot) loop that never sees new human input keeps the same
 * turn_key across many Stop events. Returns null when no genuine user
 * message is found (e.g. empty/unreadable transcript) — callers must treat
 * null as "unknown" and skip turn-key-based reset/dedup rather than forcing
 * a reset.
 * @param {Array} normalizedMessages
 * @returns {string|null}
 */
export function computeTurnKey(normalizedMessages) {
  const messages = Array.isArray(normalizedMessages) ? normalizedMessages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== 'user') continue;
    for (const part of msg.parts ?? []) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue;
      if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) continue;
      const trimmed = part.text.trim();
      if (trimmed) return trimmed.slice(0, 300);
    }
  }
  return null;
}

export function readAttempts(session_id, cwd, turnKey) {
  // Backed by .supervisor/sessions/<session_id>/state.json (core/session-store.mjs),
  // which transparently migrates the legacy `.supervisor/<sid>_attempts.json`
  // forward on first read. Same per-turn semantics as before: the count reads
  // as 0 the moment turnKey moves, because a new real user message means a new
  // turn and the persisted count belongs to a prior turn's escalation.
  try {
    return sessionStore.readAttempts(cwd, session_id, turnKey);
  } catch {
    debug({ msg: 'attempts_read_failed', session_id }, cwd);
    return 0;
  }
}

export function writeAttemptCounter(session_id, n, cwd, turnKey) {
  // Monotonic within a turn; a new turn resets the comparison. Serialised
  // read-modify-write + atomic temp+rename live in core/session-store.mjs.
  try {
    sessionStore.writeAttempts(cwd, session_id, n, turnKey);
  } catch {
    debug({ msg: 'attempts_write_failed', session_id }, cwd);
  }
}

export function writeVerdict(session_id, verdictObj, cwd) {
  // Append-only .supervisor/sessions/<session_id>/verdicts.jsonl, replacing
  // the overwrite-in-place `.supervisor/verdict_<sid>.json`.
  sessionStore.appendVerdict(cwd, session_id, verdictObj);
}

/**
 * Best-effort judge-reachability signal, surfaced by bin/status.mjs. Never
 * throws — a health-signal write failure must not crash the hook.
 */
export function writeHealthSignal(cwd, obj) {
  const dir = path.join(cwd, STATE_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `health.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, 'health.json'));
  } catch {
    /* best-effort observability only */
  }
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

// --- Delivered-media resolution -------------------------------------------
// The judge is a single-shot completion with no tools, so it cannot follow a
// file path it sees in the transcript. To let it verify visible-media goals we
// resolve delivered artifacts here and attach them as image content blocks
// (extracting one frame for video via ffmpeg). When a file can't be inlined we
// surface a text receipt (path + SendUserFile file_uuid + passing-test JSON)
// so the judge can still treat delivery + pass as proof.
const MEDIA_EXT_RE = /\.(?:png|jpe?g|gif|webp|mp4|mov)$/i;
const IMAGE_MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MEDIA_MAX_FILES = 4;
const MEDIA_MAX_BYTES = 4 * 1024 * 1024; // per file
const MEDIA_TOTAL_BUDGET = 12 * 1024 * 1024; // total inlined base64 source bytes

/**
 * Walk the transcript tail collecting media path references. A path is marked
 * `delivered: true` ONLY when it comes from a SendUserFile tool_use arg — i.e.
 * the agent actually handed that file to the user. Paths that merely appear as
 * strings in text/tool_result (e.g. an `ls` listing) are recorded but flagged
 * `delivered: false` and are NEVER read/inlined by collectDeliveredMedia — only
 * delivered files are sent to the judge, so unrelated on-disk files that happen
 * to be mentioned are not exfiltrated. Also captures nearby passing-test evidence.
 * @returns {{ paths: Array<{path:string,file_uuid?:string,delivered:boolean}>, receipts: Array<{path?:string,file_uuid?:string}>, testEvidence: string|null }}
 */
export function scanTranscriptForMedia(transcriptTail) {
  const paths = [];
  const seen = new Set();
  const receipts = [];
  let testEvidence = null;

  const addPath = (p, file_uuid, delivered = false) => {
    if (typeof p !== 'string') return;
    const m = p.match(/([^\s"'`)]+\.(?:png|jpe?g|gif|webp|mp4|mov))/i);
    const cand = m ? m[1] : (MEDIA_EXT_RE.test(p) ? p : null);
    if (!cand) return;
    if (!seen.has(cand)) { seen.add(cand); paths.push({ path: cand, file_uuid, delivered }); }
    else {
      const existing = paths.find((x) => x.path === cand);
      if (existing) {
        if (file_uuid && !existing.file_uuid) existing.file_uuid = file_uuid;
        if (delivered) existing.delivered = true; // upgrade: a later SendUserFile proves delivery
      }
    }
  };

  const scanString = (s) => {
    if (typeof s !== 'string' || !s) return;
    if (!testEvidence) {
      const em = s.match(/[^\n]*\bOVERALL\b[^\n]*\bpassed\b[^\n]*\bTrue\b[^\n]*/i)
        || s.match(/"?passed"?\s*[:=]\s*true/i);
      if (em) testEvidence = em[0].trim().slice(0, 200);
    }
    const re = /([^\s"'`)]+\.(?:png|jpe?g|gif|webp|mp4|mov))/gi;
    let mm;
    while ((mm = re.exec(s)) !== null) addPath(mm[1]);
  };

  for (const entry of Array.isArray(transcriptTail) ? transcriptTail : []) {
    const content = entry?.message?.content;
    if (typeof content === 'string') { scanString(content); continue; }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text') scanString(block.text);
      else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        const isSend = typeof block.name === 'string' && /senduserfile|send_user_file/i.test(block.name);
        const p = input.path ?? input.file_path ?? input.filepath ?? input.file ?? input.filename;
        const uuid = input.file_uuid ?? input.fileUuid ?? input.uuid;
        if (isSend) { if (p) addPath(p, uuid, true); receipts.push({ path: typeof p === 'string' ? p : undefined, file_uuid: uuid }); }
        for (const v of Object.values(input)) if (typeof v === 'string') scanString(v);
      } else if (block.type === 'tool_result') {
        const c = block.content;
        if (typeof c === 'string') scanString(c);
        else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') scanString(b.text);
      }
    }
  }
  return { paths, receipts, testEvidence };
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

/** Extract a single frame from a video via ffmpeg → base64 png, or null. */
export function tryExtractVideoFrame(absPath, runner) {
  const run = runner || ((input, out) => {
    try {
      execFileSync('ffmpeg', ['-i', input, '-frames:v', '1', '-y', out], { stdio: 'ignore', timeout: 15_000 });
      return true;
    } catch { return false; }
  });
  const tmp = path.join(os.tmpdir(), `supervisor-frame-${process.pid}-${Date.now()}.png`);
  try {
    if (!run(absPath, tmp)) { safeUnlink(tmp); return null; }
    const stat = fs.statSync(tmp);
    if (!stat.isFile() || stat.size === 0 || stat.size > MEDIA_MAX_BYTES) { safeUnlink(tmp); return null; }
    const data = fs.readFileSync(tmp).toString('base64');
    safeUnlink(tmp);
    return data;
  } catch { safeUnlink(tmp); return null; }
}

/**
 * Resolve delivered media to base64 image blocks (+ a text note for anything
 * that couldn't be inlined). Pure fallback: on any error or when nothing is
 * found, returns empty images and no note. opts.runFfmpeg injectable for tests.
 * @returns {{ images: Array<{media_type:string,data:string}>, note: string|undefined }}
 */
export function collectDeliveredMedia(transcriptTail, cwd, opts = {}) {
  let scan;
  try { scan = scanTranscriptForMedia(transcriptTail); } catch { return { images: [], note: undefined }; }
  const { paths, receipts, testEvidence } = scan;
  const images = [];
  const noteLines = [];
  const inlinedAbs = new Set(); // resolved paths successfully attached as images
  const processedAbs = new Set(); // resolved paths already handled (dedup)
  let totalBytes = 0;

  for (const { path: rel, file_uuid, delivered } of paths) {
    if (images.length >= MEDIA_MAX_FILES) break;
    // Only inline files the agent actually DELIVERED (SendUserFile). A path that
    // merely appears in transcript text is never read — prevents shipping
    // unrelated on-disk files (e.g. a `confidential.png` caught by an `ls`).
    if (!delivered) continue;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    if (processedAbs.has(abs)) continue; // same file referenced twice (e.g. bare + absolute)
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; } // not on disk — skip
    if (!stat.isFile()) continue;
    processedAbs.add(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (stat.size > MEDIA_MAX_BYTES && mediaType) {
      noteLines.push(`- delivered image (too large to inline): ${rel}${file_uuid ? ` (receipt file_uuid=${file_uuid})` : ''}`);
      continue;
    }
    if (mediaType) {
      if (totalBytes + stat.size > MEDIA_TOTAL_BUDGET) break;
      try {
        images.push({ media_type: mediaType, data: fs.readFileSync(abs).toString('base64') });
        totalBytes += stat.size;
        inlinedAbs.add(abs);
      } catch { /* unreadable — skip */ }
    } else if (ext === 'mp4' || ext === 'mov') {
      const frame = tryExtractVideoFrame(abs, opts.runFfmpeg);
      if (frame) {
        const frameBytes = Math.floor((frame.length * 3) / 4); // base64 → source bytes
        if (totalBytes + frameBytes > MEDIA_TOTAL_BUDGET) break;
        images.push({ media_type: 'image/png', data: frame });
        totalBytes += frameBytes;
        inlinedAbs.add(abs);
      } else {
        noteLines.push(`- delivered video (frame extraction unavailable): ${rel}${file_uuid ? ` (receipt file_uuid=${file_uuid})` : ''}`);
      }
    }
  }

  // SendUserFile receipts whose file was NOT inlined as an image still prove
  // delivery — surface them so the judge sees delivery + pass as proof.
  for (const r of receipts) {
    if (!r.file_uuid && !r.path) continue;
    const abs = r.path ? (path.isAbsolute(r.path) ? r.path : path.resolve(cwd, r.path)) : null;
    if (abs && inlinedAbs.has(abs)) continue; // already visible to the judge as an image
    noteLines.push(`- SendUserFile delivery receipt${r.path ? `: ${r.path}` : ''}${r.file_uuid ? ` (file_uuid=${r.file_uuid})` : ''}`);
  }

  let note;
  if (noteLines.length || testEvidence) {
    const parts = [];
    if (noteLines.length) parts.push('The agent DELIVERED media the supervisor could not inline as an image:', ...noteLines);
    if (testEvidence) parts.push(`Passing-test evidence found in transcript: ${testEvidence}`);
    parts.push('A delivered media artifact (SendUserFile receipt / on-disk path) plus passing test results is VALID proof of a visible-media goal. Do NOT ask the agent to base64 or inline the media.');
    note = parts.join('\n');
  }
  return { images, note };
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

  for (const msg of messages) {
    if (msg.info?.role === 'user') {
      const text = userMessageText(msg);
      if (text != null) humanMessages.push(text);
    }
  }
  // ONE shared extractor (core/task-context.mjs) — joins every text part of the
  // last assistant message instead of arbitrarily keeping the first or the last.
  const lastAssistantText = extractLastAssistantText(messages);

  if (humanMessages.length === 0) return null;

  // `currentTask` is NOT judge context — it feeds the non-actionable turn gate
  // and `taskSummary`. The judge reads `conversationChain` only: the plain
  // alternating conversation, no tool calls / inputs / results. Must stay
  // identical to buildTaskContext in opencode/supervisor-impl.ts.
  const currentTask = currentUserTask(humanMessages);
  const taskSummary = currentTask;
  const conversationChain = buildConversationChain(messages);

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
    taskSummary, currentTask,
    conversationChain: conversationChain || undefined,
    taskType, agentMode, humanMessages,
    toolsSummary, detectedSignals, recentCommands,
    pushedToDefaultBranch: pushedDefault,
    requiresTests, requiresBuild, requiresPR, requiresCI,
    requiresLocalTests, requiresLocalTestsEvidence,
  };
}

export function buildFakeAssessment(taskContext, category) {
  const recentTestCommands = taskContext.recentCommands.filter(isTestRunnerCommand);

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

  // 1. Stop-hook re-invocation marker — logged only, never an exit gate. CC
  // sets stop_hook_active=true on every Stop event that follows a prior
  // {decision:'block'} in the same chain, i.e. on essentially every injected
  // round-trip. Treating it as an unconditional early-exit (the old
  // behavior) meant the escalation budget below was unreachable past
  // attempt 1 in real usage — the second Stop event of any blocked chain
  // always sees stop_hook_active=true and stood down before ever checking
  // the attempt counter. The turn-scoped attempt counter (below), hard
  // capped at min(effectiveMax, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP), is now the
  // sole continuation gate.
  if (loopGuard(payload)) {
    debug({ msg: 'stop_hook_active_seen', session_id: payload.session_id }, payload.cwd);
  }

  const { session_id, transcript_path } = payload;
  const cwd = sanitizeCwd(payload?.cwd ?? process.cwd());

  // 1.5. Session-scoped disable check + record current session.
  //
  // `current_session` is still written, but it is now only a LAST-RESORT hint
  // for interactive CLI use. It is a single shared file every session in the
  // project overwrites, so with two concurrent sessions it names whichever
  // stopped last — `/supervisor off` used to disable the wrong one. The
  // authority is the `session_id` on this hook's stdin payload, which is
  // exported below so any child process (including bin/supervisor.mjs) reads
  // the CALLER's session, not the last writer's.
  const stateDir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'current_session'), session_id, 'utf8');
  process.env.SUPERVISOR_SESSION_ID = session_id;
  // Retention sweep for per-session dirs. Throttled to once a day per project
  // and fully best-effort — it must never block or fail a turn, and it never
  // touches the live session.
  try { maybeGcSessions(cwd, { protect: session_id }); } catch { /* best effort */ }
  const disabledFlag = path.join(stateDir, 'disabled');
  try {
    const disabledIds = fs.readFileSync(disabledFlag, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (disabledIds.includes(session_id)) {
      debug({ msg: 'disabled_for_session', session_id }, cwd);
      process.exit(0);
    }
  } catch { /* not disabled */ }

  // 2. Cheap, non-polling transcript read — just enough to compute the
  // per-turn key (fingerprint of the last real, non-supervisor-injected user
  // message) before the attempt-cap check below. Deliberately kept separate
  // from the flush-poll read (step 4): a session that's already at its cap
  // still fast-exits here without paying the poll's up-to-1s latency.
  const earlyTail = transcript_path ? readTranscriptTail(transcript_path) : [];
  const turnKey = computeTurnKey(normalizeTranscriptToMessages(earlyTail));

  // THE per-turn attempt counter. There is exactly one on this runtime: this
  // turn-scoped file counter. It covers every path that pushes the agent
  // (plain reflection injections, autopilot nudges, goal continuations) and
  // resets by itself when turnKey moves. `goal.attempts` is NOT a second
  // counter — it is mirrored from this value below purely so the persisted
  // goal record and `/supervisor:set-goal` status stay truthful.
  const attempts = readAttempts(session_id, cwd, turnKey);

  // 3. Attempt cap.
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
      // A goal's attempt budget is per-human-turn, not cumulative for the
      // whole session, and it is not tracked separately: goal.attempts is
      // mirrored from the single turn-scoped file counter read above, which
      // already resets itself when turnKey moves (a new real user message
      // arrived). Keeping a second, independently-incremented count here was
      // the bug in #57 — the file counter also advances on plain reflection
      // injections, so arming a goal mid-turn silently shrank the goal's real
      // budget, and the file gate below (same cap) always tripped first, so
      // decideGoalTransition's `reason:'attempts'` branch could never fire.
      // lastTurnKey is still stamped so the persisted record says which human
      // turn the count belongs to.
      if (turnKey != null && (goal.lastTurnKey !== turnKey || goal.attempts !== attempts)) {
        goal = { ...goal, lastTurnKey: turnKey, attempts };
        goalState = { ...goalState, goal };
        // mutate(), never save(): `goalState` was read before the attempt
        // counter was touched, and attempts now live in the SAME state.json.
        // A blind overwrite here would silently clobber the counter written
        // by writeAttemptCounter — a lost update inside one process.
        try { sessionStore.mutate(cwd, session_id, (s) => { s.goal = goal; }); } catch { /* best effort */ }
      }
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

  // Universal per-turn ceiling — see HARD_CAP's definition for the full
  // rationale. This intentionally tightens autopilot/goal's higher session
  // budget (default 16) during any single unbroken turn: by design, since
  // CC's own override already made anything beyond ~8 unreachable in
  // practice, so this just makes our own exhaustion bookkeeping fire
  // deterministically instead of being silently pre-empted by CC.
  effectiveMax = Math.min(effectiveMax, HARD_CAP);

  // Project-level goal: in reflection mode, read the project goal
  // (.agents/supervisor/Goal.md, or the lower-case goal.md written by the
  // OpenCode-side LLM auto-derivation feature — see core/goal.mjs's
  // readProjectGoalCondition for the shared precedence rule).
  let projectGoalSection = '';
  // The exact project condition injected into THIS judgement. Load-bearing
  // for goal retirement: only a file that still holds the condition we
  // actually judged may be deleted (see retireProjectGoal in core/goal.mjs).
  let injectedProjectGoalCondition = '';
  const effectiveMode = resolveSupervisorMode(goalState);
  if (effectiveMode !== 'goal' && !goal) {
    const cond = readProjectGoalCondition(cwd);
    if (cond) {
      injectedProjectGoalCondition = cond;
      projectGoalSection = buildGoalRequirementSection(cond);
    }
  }

  // The judge must actually SEE the goal condition + evidence rule as a
  // MANDATORY completion requirement. It previously only reached the
  // continuation feedback text, never the judge prompt — so the judge decided
  // "complete" against generic workflow gates while the goal loop then used
  // that verdict to decide the goal was met. (OpenCode always injected it —
  // see supervisor-impl.ts's goalSection — so this was a CC-only gap.)
  const sessionGoalSection = goal ? buildGoalRequirementSection(goal.condition) : '';

  // Shared handler for BOTH goal-exhaust sites (the per-turn cap gate below
  // and the post-judge goal loop). decideGoalTransition reports WHICH
  // condition fired; never re-derive it from the clock, or a future third
  // exhaust reason silently becomes the recoverable per-turn case and the
  // loop gains no terminal state.
  //   - 'deadline' — terminal. The goal outlived the window it was set for:
  //     persist status 'exhausted' and stand it down for good.
  //   - 'attempts' — NOT terminal. The single per-turn counter is spent;
  //     it resets on the next human turn, so leave status 'active' and stand
  //     down for the rest of THIS turn only. Persisting 'exhausted' here
  //     would kill a goal the human is still driving, because the goal-active
  //     branch above (which re-syncs attempts/lastTurnKey) never re-fires
  //     once status leaves 'active'.
  function finishExhaustedGoal(t, baseRecord) {
    const deadlineHit = t.reason === 'deadline';
    if (deadlineHit) {
      try { sessionStore.mutate(cwd, session_id, (s) => { s.goal = t.goal; }); } catch { /* */ }
    }
    writeVerdict(session_id, { ...baseRecord, goal: deadlineHit ? 'exhausted' : 'turn_budget_spent' }, cwd);
    debug({ msg: deadlineHit ? 'goal_exhausted' : 'goal_turn_budget_spent', session_id, reason: t.reason }, cwd);
  }

  if (attempts >= effectiveMax) {
    // Disable autopilot on budget exhaustion so the next stop is clean.
    if (mode === 'autopilot') {
      try { goalStore.setAutopilot(cwd, session_id, false); } catch { /* */ }
    }
    // An active goal must not die silently here. Because goal.attempts is the
    // same number as `attempts`, decideGoalTransition is guaranteed to report
    // 'exhausted' — with reason 'deadline' if the goal also outlived its
    // window, else 'attempts'. `complete` is irrelevant: exhaustion is checked
    // strictly before achievement, so the judge never has to run to get here.
    if (goal) {
      const t = decideGoalTransition({ goal, complete: false, now: Date.now(), maxAttempts: effectiveMax });
      finishExhaustedGoal(t, {
        session_id, attempt: attempts, timestamp: new Date().toISOString(),
        plugin_version: PLUGIN_VERSION, injected: false,
      });
    }
    debug({ msg: 'attempt_cap_reached', session_id, attempts, max: effectiveMax, goal: !!goal, mode }, cwd);
    process.exit(0);
  }

  // 4. Transcript tail (poll for flush).
  let tail = earlyTail;
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

  // 4a. Autopilot fast-path: skip the judge entirely; inject a "continue" nudge
  // until the agent emits AUTOPILOT_EXIT or the attempt budget runs out.
  if (mode === 'autopilot' && !goal) {
    const baseVerdict = { session_id, timestamp: new Date().toISOString(), plugin_version: PLUGIN_VERSION };
    if (/(^|\n)\s*AUTOPILOT_EXIT\s*(\n|$)/.test(ctx.final_assistant_text)) {
      try { goalStore.setAutopilot(cwd, session_id, false); } catch { /* */ }
      writeVerdict(session_id, { ...baseVerdict, autopilot: 'exited' }, cwd);
      debug({ msg: 'autopilot_exit', session_id }, cwd);
      process.exit(0);
    }
    const nextAttempt = attempts + 1;
    writeAttemptCounter(session_id, nextAttempt, cwd, turnKey);
    // Parity with the OpenCode autopilot nudge (opencode/supervisor-impl.ts):
    // the status/roadmap directive rides along with EVERY continuation, on
    // both runtimes. Gated by the same default-on `statusDiagram` flag, so
    // `/supervisor:status off` silences it here too.
    const baseNudge = `${FEEDBACK_MARKER} Autopilot (${nextAttempt}/${effectiveMax})\n\nYou are in autopilot mode. Continue working on the current task. Do not stop to ask for permission or confirmation — proceed with implementation.\n\nWhen you have genuinely completed ALL work (not just one step), output \`AUTOPILOT_EXIT\` ALONE on its own line (nothing else on that line) to hand control back.\n\nContinue now.`;
    const nudge = isStatusDiagramEnabled(goalState) ? appendStatusDirective(baseNudge) : baseNudge;
    writeVerdict(session_id, { ...baseVerdict, injected: true, autopilot: 'continue', attempt: nextAttempt }, cwd);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: nudge }));
    debug({ msg: 'autopilot_continue', session_id, attempt: nextAttempt }, cwd);
    process.exit(0);
  }

  // 4b. Pre-judge guard: a trailing question to the user is a strong signal
  // the correct status is waiting_for_user — forcing a continuation over an
  // open question would recreate the exact "ignore the human" pattern this
  // supervisor exists to prevent, so skip the judge entirely rather than
  // risk a heuristic gate overriding it downstream.
  if (endsWithTrailingQuestion(ctx.final_assistant_text)) {
    debug({ msg: 'trailing_question_guard', session_id }, cwd);
    process.exit(0);
  }

  // 5. Build task context from transcript (shared assessment pipeline).
  const normalizedMessages = normalizeTranscriptToMessages(tail);
  const taskContext = buildTaskContextFromTranscript(normalizedMessages, cwd);
  if (!taskContext) {
    debug({ msg: 'no_task_context', session_id }, cwd);
    process.exit(0);
  }

  // 5.5. Non-actionable turn gate — a completion judge only makes sense when
  // the human asked for work. "Stop. Reflect.", "tldr", "thanks", "why did you
  // stop" previously all ran the full judge as work orders (see
  // core/turn-classifier.mjs). Bypassed entirely while a goal is active.
  const turnGate = shouldSkipReflection({
    text: taskContext.currentTask,
    hasActiveGoal: !!goal,
    mode: effectiveMode,
  });
  if (turnGate.skip) {
    debug({ msg: 'non_actionable_turn', session_id, reason: turnGate.reason }, cwd);
    process.exit(0);
  }

  // 6. Self-assessment via shared pipeline (same builder OpenCode uses):
  // reads .agents/supervisor/{SystemPrompt,Patterns,User,Goal}.md (falling
  // back to this plugin's shipped defaults), and — if a project-level goal
  // is active and no session goal overrides it — folds the goal requirement
  // in as a mandatory completion criterion.
  const agents = getAgentsSync(cwd);
  let prompt = await buildReflectionPrompt({
    directory: cwd,
    defaultsDir,
    context: taskContext,
    agents,
    lastAssistantText: ctx.final_assistant_text,
    attemptCount: attempts,
    maxAttempts: effectiveMax,
    goalSection: sessionGoalSection || projectGoalSection || undefined,
  });

  // 6.5. Resolve delivered media so the tool-less judge can SEE it. Images are
  // attached as content blocks; anything that can't be inlined (video without
  // ffmpeg, oversize, off-disk SendUserFile receipts) is surfaced as a text
  // note listing the artifact + passing-test evidence. Pure fallback — any
  // failure leaves the text-only call exactly as before.
  let mediaImages;
  try {
    const media = collectDeliveredMedia(tail, cwd);
    if (media.images.length) mediaImages = media.images;
    if (media.note) prompt = `${prompt}\n\n## Delivered Media (supervisor-resolved)\n${media.note}`;
    if (media.images.length || media.note) {
      debug({ msg: 'media_resolved', images: media.images.length, hasNote: !!media.note }, cwd);
    }
  } catch (e) {
    debug({ msg: 'media_collect_failed', err: String(e?.message ?? e) }, cwd);
  }

  // Test-only escape hatch (same family as SUPERVISOR_FAKE_JUDGE): dump the
  // fully-built judge prompt to a file so a test can assert what the judge
  // actually sees — e.g. that an active goal reaches it as a mandatory
  // requirement. Never set in normal operation; best-effort, never throws.
  //
  // The prompt embeds transcript text, so the destination is confined to the
  // project's own .supervisor/ directory: an env var alone must not be able to
  // exfiltrate a transcript to an arbitrary path from shipped production code.
  // Anything resolving outside that directory is ignored.
  if (process.env.SUPERVISOR_DUMP_PROMPT) {
    try {
      const dumpRoot = path.resolve(cwd, '.supervisor');
      const dest = path.resolve(cwd, process.env.SUPERVISOR_DUMP_PROMPT);
      if (dest === dumpRoot || dest.startsWith(dumpRoot + path.sep)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, prompt, { encoding: 'utf8', mode: 0o600 });
      } else {
        debug({ msg: 'dump_prompt_rejected', reason: 'outside .supervisor/' }, cwd);
      }
    } catch { /* best effort */ }
  }

  const fakeJudge = process.env.SUPERVISOR_FAKE_JUDGE ?? process.env.REFLECTION_CC_FAKE_JUDGE;
  let assessmentText;
  try {
    if (fakeJudge) {
      const [category = 'summary_drift_stop'] = fakeJudge.split(':');
      // Test-only escape hatch: exercises the judge_unreachable health-signal
      // path (Fix C.4) without needing a live judge call to actually fail.
      if (category === 'JUDGE_UNREACHABLE') {
        throw new Error('simulated judge-unreachable failure (test-only)');
      }
      // Test-only escape hatch: exercises the parse-failure fail-open path
      // (Fix A.2) without needing a live judge call to actually return garbage.
      assessmentText = category === 'PARSE_ERROR'
        ? 'not valid json at all'
        : JSON.stringify(buildFakeAssessment(taskContext, category));
    } else {
      const result = await callAnthropic({
        prompt,
        system: 'You are a precise workflow completion evaluator. Output JSON only.',
        model: ASSESSMENT_MODEL,
        maxTokens: 1000,
        timeoutMs: ASSESSMENT_TIMEOUT_MS,
        images: mediaImages,
      });
      assessmentText = result.text;
    }
    writeHealthSignal(cwd, { status: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    debug({ msg: 'assessment_threw', err: String(e?.message ?? e) }, cwd);
    writeHealthSignal(cwd, { status: 'judge_unreachable', error: String(e?.message ?? e), ts: new Date().toISOString() });
    process.exit(0);
  }

  const assessment = parseSelfAssessmentJson(assessmentText);
  if (!assessment) {
    // Fail-open: a garbage/unparseable judge response is not evidence the
    // task is incomplete. Do not inject — just record why and stop.
    debug({ msg: 'assessment_parse_failed', session_id, raw: (assessmentText ?? '').slice(0, 200) }, cwd);
    process.exit(0);
  }
  const analysis = evaluateSelfAssessment(assessment, taskContext);
  debug({ msg: 'assessment', complete: analysis.complete, severity: analysis.severity, status: assessment.status }, cwd);

  const nextAttempt = attempts + 1;
  const verdictRecord = {
    session_id, attempt: nextAttempt, timestamp: new Date().toISOString(), injected: false,
    plugin_version: PLUGIN_VERSION,
    status: assessment?.status ?? 'in_progress', confidence: assessment?.confidence ?? 0.5,
    complete: analysis.complete, severity: analysis.severity, reason: analysis.reason,
  };

  // Helper: build escalating feedback message from analysis. The judge's own
  // verdict (missing/next_actions/feedback/confidence) is the only authority
  // here — buildEscalatingFeedback no longer accepts a deterministic
  // planning/action-loop override.
  function buildAnalysisFeedback() {
    return buildEscalatingFeedback(
      nextAttempt,
      analysis.severity,
      {
        missing: analysis.missing,
        next_actions: analysis.nextActions,
        feedback: analysis.reason,
        confidence: assessment?.confidence,
        // Standing goal renders in its own labelled section, never merged
        // into `### Missing` alongside real per-turn gaps.
        goal_condition: goal?.condition || injectedProjectGoalCondition || '',
      },
      effectiveMax,
      // Same default-on flag the autopilot nudge above honours, so
      // `/supervisor:status off` silences BOTH continuation paths, not just
      // one of them.
      { statusDirective: isStatusDiagramEnabled(goalState) },
    );
  }

  // A verdict with nothing actionable (empty missing, empty next_actions,
  // blank feedback) must never be injected: the agent has nothing to act on,
  // stops again immediately, and receives the identical empty message until
  // the retry cap burns out.
  const actionlessVerdict = isActionlessVerdict({
    missing: analysis.missing,
    next_actions: analysis.nextActions,
    feedback: analysis.reason,
  });

  // Project-level goal judged met (reflection mode: no session goal object,
  // so the goal loop below never runs for it). The condition WAS injected as
  // a MANDATORY completion requirement, so `complete` means it was met —
  // retire it, or it re-fires on every future turn and every future session.
  if (analysis.complete && injectedProjectGoalCondition) {
    try {
      const retired = retireProjectGoal(cwd, {
        condition: injectedProjectGoalCondition,
        sessionId: session_id,
        source: 'claude-code:project-goal-achieved',
        reason: analysis.reason || '',
      });
      debug({ msg: 'project_goal_retired', session_id, removed: retired.removed, skipped: retired.skipped }, cwd);
    } catch (e) {
      debug({ msg: 'project_goal_retire_failed', err: String(e?.message ?? e) }, cwd);
    }
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
      try { sessionStore.mutate(cwd, session_id, (s) => { s.goal = t.goal; }); } catch { /* */ }
      // An achieved goal must DIE: persisting status:'achieved' alone left
      // .agents/supervisor/Goal.md (or goal.md) on disk, so the next session
      // re-read it and the goal resurrected forever.
      try {
        const retired = retireProjectGoal(cwd, {
          condition: goal.condition,
          sessionId: session_id,
          source: 'claude-code:session-goal-achieved',
          reason: analysis.reason || '',
        });
        debug({ msg: 'goal_project_file_retired', session_id, removed: retired.removed, skipped: retired.skipped }, cwd);
      } catch (e) {
        debug({ msg: 'goal_project_file_retire_failed', err: String(e?.message ?? e) }, cwd);
      }
      try { goalStore.clearGoal(cwd, session_id); } catch { /* */ }
      verdictRecord.goal = 'achieved';
      verdictRecord.message = `Goal condition met: "${goal.condition}". ${analysis.reason || ''}`.trim();
      writeVerdict(session_id, verdictRecord, cwd);
      debug({ msg: 'goal_achieved', session_id, message: verdictRecord.message }, cwd);
      process.exit(0);
    }
    if (t.action === 'exhausted') {
      // Reachable here only via the deadline: the per-turn cap gate above
      // already stood down for any turn where `attempts >= effectiveMax`.
      // Both reasons still flow through one handler so the two sites can
      // never drift on what a spent budget means.
      finishExhaustedGoal(t, verdictRecord);
      process.exit(0);
    }
    // continue — but never override a genuine human-only block, and never
    // push on a content-free verdict (that is the loop, not progress).
    if (actionlessVerdict) {
      verdictRecord.goal = 'paused';
      verdictRecord.feedback_reason = 'actionless_verdict';
      writeVerdict(session_id, verdictRecord, cwd);
      debug({ msg: 'no_inject_actionless_verdict', session_id, goal: true }, cwd);
      process.exit(0);
    }
    if (!analysis.requiresHumanAction) {
      const msg = `Goal not yet met: "${goal.condition}". ${buildAnalysisFeedback()}`;
      writeAttemptCounter(session_id, nextAttempt, cwd, turnKey);
      try { sessionStore.mutate(cwd, session_id, (s) => { s.goal = t.goal; }); } catch { /* */ }
      verdictRecord.injected = true;
      verdictRecord.goal = 'continue';
      verdictRecord.feedback_reason = 'goal_continue';
      writeVerdict(session_id, verdictRecord, cwd);
      process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
      debug({ msg: 'goal_continue_inject', session_id, attempt: nextAttempt, severity: analysis.severity, mode }, cwd);
      process.exit(0);
    }
    // Human action required with active goal → legit pause, don't burn budget.
    verdictRecord.goal = 'paused';
    writeVerdict(session_id, verdictRecord, cwd);
    debug({ msg: 'goal_paused_user_wait', session_id }, cwd);
    process.exit(0);
  }

  // 6b. Normal (no goal) inject decision.
  if (!analysis.complete && analysis.shouldContinue && !analysis.requiresHumanAction && !actionlessVerdict) {
    const feedbackMsg = buildAnalysisFeedback();
    // Last-resort guard: never inject an empty-bodied message.
    if (!hasFeedbackBody(feedbackMsg)) {
      verdictRecord.feedback_reason = 'empty_feedback_body';
      writeVerdict(session_id, verdictRecord, cwd);
      debug({ msg: 'no_inject_empty_body', session_id }, cwd);
      process.exit(0);
    }
    writeAttemptCounter(session_id, nextAttempt, cwd, turnKey);
    verdictRecord.injected = true;
    verdictRecord.feedback_reason = 'assessment_continue';
    writeVerdict(session_id, verdictRecord, cwd);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: feedbackMsg }));
    debug({ msg: 'inject_sent', severity: analysis.severity, attempt: nextAttempt }, cwd);
    process.exit(0);
  }

  writeVerdict(session_id, verdictRecord, cwd);
  debug({ msg: 'no_inject', complete: analysis.complete, attempt: nextAttempt, actionless: actionlessVerdict, reason: actionlessVerdict ? 'verdict had no actionable content' : analysis.reason }, cwd);
  process.exit(0);
}

// Only run when executed directly (not when imported by tests).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
