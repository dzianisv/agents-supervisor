#!/usr/bin/env node
/**
 * plainspeak-on-stop.mjs — Claude Code Stop hook for the plainspeak plugin.
 *
 * Catches a fluffy/over-complicated final assistant reply and injects a
 * surgical rewrite directive via {decision:'block', reason}. Detection is
 * owned by core/verbosity.mjs (scoreVerbosity/buildStylePrompt/
 * buildRewriteDirective) — this file only wires that detector into the Stop
 * hook lifecycle and adds the safety rails below. It is deliberately
 * self-contained: it does not import bin/supervisor-on-stop.mjs, so it has no
 * runtime dependency on that file's shape and can be lifted into another repo
 * on its own. It DOES import core/goal.mjs — the same shared state module
 * supervisor uses — because detecting supervisor's state is this file's job.
 * It also imports core/transcript.mjs, which owns the Stop-hook primitives
 * both hooks need (sanitizeCwd, readTranscriptTail, endsWithTrailingQuestion,
 * the turn-key scan, readStdin, the debug logger) — shared through core/, not
 * through the other bin/ script, so the self-containment above still holds.
 *
 * Safety rails (see AGENTS.md task brief for the exact spec):
 *   - Coexistence with supervisor: never fight it. See supervisorGoalActive
 *     (deterministic) and supervisorRecentlyBlocked (best-effort, race-aware).
 *   - One rewrite per turn, hard cap, persisted under .plainspeak/.
 *   - Never fire mid-work: only a final delivered reply is judged.
 *   - Fail open: any error/timeout/missing-auth → exit 0 silently.
 *   - Kill switch: .plainspeak/disabled file or PLAINSPEAK_DISABLED=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callAnthropic } from '../core/llm-client.mjs';
import { scoreVerbosity, buildStylePrompt, buildRewriteDirective, STYLE_RULES } from '../core/verbosity.mjs';
import { parseSelfAssessmentJson } from '../core/assessment.mjs';
import { goalStore, readProjectGoalCondition } from '../core/goal.mjs';
// THE shared Stop-hook primitives — see core/transcript.mjs. These used to be
// private copies here and in bin/supervisor-on-stop.mjs; sanitizeCwd's two
// copies had already drifted apart on their failure mode.
import {
  sanitizeCwd, readTranscriptTail, endsWithTrailingQuestion, readStdin,
  createDebugLogger, computeTurnKeyFromTranscript,
} from '../core/transcript.mjs';

export const PLAINSPEAK_MARKER = '## Plainspeak:';

const STATE_DIR = '.plainspeak';
const SUPERVISOR_STATE_DIR = '.supervisor';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const LLM_TIMEOUT_MS = 15_000;
const LLM_MAX_TOKENS = 300;
const FLUSH_POLL_MS = 100;
const FLUSH_POLL_MAX = 5; // shorter than supervisor's own poll: plainspeak prefers payload.last_assistant_message and rarely needs this path
const SUPERVISOR_RACE_POLL_MS = 150;
const SUPERVISOR_RACE_POLL_MAX = 3; // ~450ms — only paid on suspect/verbose turns, right before an LLM call or a block
const SUPERVISOR_FRESH_EPSILON_MS = 2000; // clock/mtime-granularity slop

// Fail open unconditionally: a bug in this hook must never block a turn.
process.on('uncaughtException', () => { try { process.exit(0); } catch { /* */ } });
process.on('unhandledRejection', () => { try { process.exit(0); } catch { /* */ } });

// Silent on write failure by design: this hook must never add noise to a
// delivered reply. PLAINSPEAK_DEBUG is read per call, not at module load.
const debug = createDebugLogger({
  stateDir: STATE_DIR,
  isEnabled: () => process.env.PLAINSPEAK_DEBUG === '1',
});

// Re-exported so this file's public API is unchanged now that
// core/transcript.mjs owns the implementation.
export { sanitizeCwd, endsWithTrailingQuestion, readTranscriptTail };

export function isDisabled(cwd) {
  if (process.env.PLAINSPEAK_DISABLED === '1') return true;
  try {
    fs.accessSync(path.join(cwd, STATE_DIR, 'disabled'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fingerprint of the last genuine (non-injected) user message, truncated to
 * 300 chars — used to scope the one-rewrite-per-turn cap to the current human
 * turn. Skips both supervisor's own injected markers AND plainspeak's own
 * PLAINSPEAK_MARKER, so a prior rewrite directive is never mistaken for a new
 * human turn. Returns null when no genuine user message is found; callers
 * must treat null as "unknown" and never fire (see main()).
 */
export function computeTurnKey(transcriptTail) {
  return computeTurnKeyFromTranscript(transcriptTail, { extraMarkers: [PLAINSPEAK_MARKER] });
}

export function extractFinalAssistantText(payload, transcriptTail) {
  const fromPayload = (payload?.last_assistant_message ?? '').trim();
  if (fromPayload) return fromPayload;
  const entries = Array.isArray(transcriptTail) ? transcriptTail : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) break;
    const textBlocks = content.filter((c) => c?.type === 'text');
    if (textBlocks.length > 0) return textBlocks.map((b) => b.text).join('\n').trim();
    break;
  }
  return '';
}

// --- One-rewrite-per-turn hard cap ------------------------------------------

export function readTurnRecord(sessionId, cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, STATE_DIR, `${sessionId}_turn.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeTurnRecord(sessionId, turnKey, cwd) {
  const dir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${sessionId}_turn.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ turn_key: turnKey, fired_at: new Date().toISOString() }), 'utf8');
  fs.renameSync(tmp, path.join(dir, `${sessionId}_turn.json`));
}

/** turnKey === null is treated as "unknown turn" — conservative: never fire. */
export function alreadyFiredThisTurn(sessionId, turnKey, cwd) {
  if (turnKey == null) return true;
  const rec = readTurnRecord(sessionId, cwd);
  if (!rec) return false;
  return rec.turn_key === turnKey;
}

// --- Supervisor coexistence guard -------------------------------------------

/**
 * Deterministic, non-racy half of the guard: an active supervisor goal
 * was armed on a PRIOR turn (persisted state, no timing
 * dependency) — always defer while one is running. High confidence: this
 * reads state that was committed before the current Stop event even fired.
 */
export function supervisorGoalActive(cwd, sessionId) {
  try {
    const state = goalStore.load(cwd, sessionId);
    if (state?.goal?.status === 'active') return true;
    if (!state?.goal && state.goalCleared !== true && readProjectGoalCondition(cwd)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Best-effort half of the guard: supervisor-on-stop.mjs writes
 * .supervisor/verdict_<session_id>.json exactly once per Stop invocation it
 * processes, with injected:true iff it chose to block (re-prompt) this turn.
 * Both hooks are registered on the same Stop event and Claude Code runs
 * multiple Stop hooks for one event IN PARALLEL, so there is no ordering
 * guarantee — this is a mitigation, not a proof. The test used is:
 * "was this file written at or after MY OWN process's start time?" rather
 * than an arbitrary freshness window — a write from a stale, unrelated prior
 * turn necessarily happened before this Stop event fired (and thus before
 * this process started), so mtime >= sinceMs (with a small epsilon for
 * mtime/clock granularity) can only be a write about the CURRENT turn.
 * Confidence: medium for suspect/verbose turns (this hook calls the LLM
 * judge and/or polls for up to ~450ms before committing to a block, giving
 * supervisor's own — typically slower, opus-based — assessment call a real
 * window to finish and land first); it is not a hard guarantee, since a
 * supervisor call that materially outlasts that window can still race past.
 */
export function supervisorRecentlyBlocked(cwd, sessionId, sinceMs) {
  // Reads the NEW per-session layout first
  // (.supervisor/sessions/<id>/verdicts.jsonl, append-only, full session id),
  // falling back to the legacy overwrite-in-place
  // .supervisor/verdict_<session_id>.json so a session mid-migration — or a
  // downgraded plugin — is still covered.
  const candidates = [
    path.join(cwd, SUPERVISOR_STATE_DIR, 'sessions', sessionId, 'verdicts.jsonl'),
    path.join(cwd, SUPERVISOR_STATE_DIR, `verdict_${sessionId}.json`),
  ];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < sinceMs - SUPERVISOR_FRESH_EPSILON_MS) continue;
      const raw = fs.readFileSync(p, 'utf8');
      // jsonl: the LAST line is the newest verdict. A single JSON object
      // (legacy) parses as-is.
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const v = JSON.parse(lines[i]);
          if (v?.injected === true) return true;
          break; // newest parseable record decides
        } catch { /* skip corrupt line, try the one before it */ }
      }
    } catch { /* missing/unreadable — try the next candidate */ }
  }
  return false;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure decision function, given the deterministic score and (if it was
 * called) the parsed LLM judge response. Exported for direct unit testing.
 */
export function isConfirmedVerbose(scored, llmJudge) {
  if (scored?.verdict === 'verbose') return true;
  if (scored?.verdict === 'suspect') return llmJudge?.verdict === 'verbose';
  return false;
}

/**
 * Whether the LLM judge should be called for a non-'verbose' verdict.
 *
 * Calibration finding (evals/verbosity-cases.jsonl, see plainspeak-eval.mjs
 * output): on the 200-row corpus, scoreVerbosity's OWN 'terse' vs 'suspect'
 * split (structurallySuspect: low bullet ratio + long sentences) is not a
 * reliable recall gate beyond the hard short-reply floor (proseWords < 40,
 * which core/verbosity.mjs enforces unconditionally and is out of scope to
 * change here). 12 of 16 gold human_complaint rows are 120-480 prose words,
 * genuinely bullet-heavy (0.22-0.50 bullet ratio) replies that land 'terse'
 * ONLY because bullets trip the "well organized" structural proxy — not
 * because they are short. Under the literal spec ("on terse, exit 0, no LLM
 * call"), at most 3 of 16 gold rows ever reach the judge. Default behavior
 * here therefore treats the hard word floor — not scoreVerbosity's verdict —
 * as the only free pass; set PLAINSPEAK_STRICT_TERSE_EXIT=1 to restore the
 * literal "skip LLM on any terse verdict" behavior (cheaper, blinder).
 */
export function shouldCallLlm(scored) {
  if (scored?.verdict === 'verbose') return false; // already confirmed, no need to re-ask
  if (scored?.verdict === 'suspect') return true;
  // verdict === 'terse'
  if (process.env.PLAINSPEAK_STRICT_TERSE_EXIT === '1') return false;
  const floor = STYLE_RULES?.thresholds?.shortReplyWords ?? 40;
  return (scored?.stats?.proseWords ?? 0) >= floor;
}

async function main() {
  const startedAt = Date.now();
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const cwd = sanitizeCwd(payload?.cwd ?? process.cwd());
  if (!cwd) process.exit(0);
  if (isDisabled(cwd)) process.exit(0);

  const session_id = payload?.session_id;
  if (typeof session_id !== 'string' || !session_id) process.exit(0);

  // Deterministic, non-racy coexistence guard — see supervisorGoalActive doc.
  if (supervisorGoalActive(cwd, session_id)) {
    debug({ msg: 'defer_supervisor_goal_active', session_id }, cwd);
    process.exit(0);
  }

  const transcript_path = payload?.transcript_path;
  const tail = transcript_path ? readTranscriptTail(transcript_path) : [];
  const turnKey = computeTurnKey(tail);
  if (turnKey == null) process.exit(0);

  // One-rewrite-per-turn hard cap.
  if (alreadyFiredThisTurn(session_id, turnKey, cwd)) {
    debug({ msg: 'already_fired_this_turn', session_id }, cwd);
    process.exit(0);
  }

  let finalText = extractFinalAssistantText(payload, tail);
  let pollTail = tail;
  for (let i = 0; i < FLUSH_POLL_MAX && !finalText; i++) {
    await sleep(FLUSH_POLL_MS);
    pollTail = transcript_path ? readTranscriptTail(transcript_path) : [];
    finalText = extractFinalAssistantText(payload, pollTail);
  }
  if (!finalText) process.exit(0);

  // Never fire mid-work: a trailing question means status is waiting_for_user.
  if (endsWithTrailingQuestion(finalText)) process.exit(0);

  let scored;
  try {
    scored = scoreVerbosity(finalText);
  } catch {
    process.exit(0);
  }
  if (scored.verdict === 'terse' && !shouldCallLlm(scored)) process.exit(0);

  let llmJudge = null;
  if (shouldCallLlm(scored)) {
    // Best-effort race mitigation before spending an LLM call: give
    // supervisor's own (typically slower) assessment a short window to land.
    for (let i = 0; i < SUPERVISOR_RACE_POLL_MAX; i++) {
      if (supervisorRecentlyBlocked(cwd, session_id, startedAt)) {
        debug({ msg: 'defer_supervisor_recently_blocked_pre_llm', session_id }, cwd);
        process.exit(0);
      }
      if (i < SUPERVISOR_RACE_POLL_MAX - 1) await sleep(SUPERVISOR_RACE_POLL_MS);
    }

    try {
      const prompt = buildStylePrompt(finalText, scored);
      const result = await callAnthropic({
        prompt,
        system: 'You are a strict, terse plain-English style judge. Output JSON only.',
        model: process.env.PLAINSPEAK_MODEL || DEFAULT_MODEL,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
      });
      llmJudge = parseSelfAssessmentJson(result.text);
    } catch (e) {
      debug({ msg: 'llm_judge_failed', err: String(e?.message ?? e) }, cwd);
      process.exit(0); // fail open — cannot confirm suspicion without the judge
    }
    if (!llmJudge || (llmJudge.verdict !== 'terse' && llmJudge.verdict !== 'verbose')) {
      debug({ msg: 'llm_judge_unparseable', session_id }, cwd);
      process.exit(0);
    }
  }

  if (!isConfirmedVerbose(scored, llmJudge)) process.exit(0);

  // Final coexistence check right before committing — catches a supervisor
  // verdict written while this hook's own LLM call was in flight.
  if (supervisorRecentlyBlocked(cwd, session_id, startedAt)) {
    debug({ msg: 'defer_supervisor_recently_blocked_pre_commit', session_id }, cwd);
    process.exit(0);
  }

  const directive = buildRewriteDirective({ ...scored, llmJudge: llmJudge ?? undefined });
  if (!directive) process.exit(0);

  writeTurnRecord(session_id, turnKey, cwd);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `${PLAINSPEAK_MARKER} ${directive}` }));
  debug({ msg: 'rewrite_injected', session_id, verdict: scored.verdict }, cwd);
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => { try { process.exit(0); } catch { /* */ } });
}
