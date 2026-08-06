/**
 * task-context.mjs — the judge's INPUT CONTEXT: what the user asked, and what
 * the agent actually did about it.
 *
 * Why this module exists (forensics 2026-08-06, 962 real injections / 30 days):
 *
 *  - 169 injections (17.6%) were false "Task Incomplete" verdicts caused by the
 *    supervisor's OWN `slice(0, 4000)` on the agent's last message. The judge
 *    saw a message ending mid-word and correctly reported "the response is
 *    truncated" — but the cut was ours. Byte-exact proof: a 5877-char complete
 *    report was sliced at byte 4000 mid-identifier (`${VIBE_API_U`) and the
 *    judge quoted that fragment back as evidence the agent stopped early.
 *    => Truncation MUST be explicitly marked, and MUST keep the TAIL.
 *
 *  - The judge saw MAXIMAL demand and MINIMAL evidence: `taskSummary` joined
 *    EVERY user message ever sent in the session (unbounded, unweighted), while
 *    the evidence side was ONE assistant message's text with zero tool results.
 *    A user who changed topic still got judged against turn 1.
 *    => Split demand into `currentTask` (judge this) vs `priorContext`
 *    (already-addressed background), and widen evidence to the whole current
 *    turn including tool RESULTS.
 *
 * Everything here is pure and synchronous so both runtimes (the OpenCode plugin
 * and the Claude Code Stop hook) share one implementation and one test suite.
 */

import { SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER } from './evaluation.mjs'

/**
 * Single source of truth for how much of a free-text blob (the agent's last
 * response) reaches the judge.
 *
 * Why 12000 and not the old 4000: 4000 chars is ~1k tokens — under a third of a
 * routine engineering report, so ordinary complete work was being cut. Judge
 * models in the supported cascade all carry >=128k context; the rest of the
 * reflection prompt (rubric + patterns + tool summary + project instructions)
 * is ~8-10k chars, so a 12000-char response budget keeps the whole prompt
 * comfortably under ~6k tokens while covering the overwhelming majority of real
 * agent responses uncut (the largest observed in the forensic sample was 11763).
 *
 * EXPORTED AND SHARED ON PURPOSE: core/assessment.mjs and
 * core/reflection-prompt.mjs used to hard-code 4000 independently and could
 * silently drift apart. Both now import this constant.
 */
export const PROMPT_TEXT_LIMIT = 12000

/** How many earlier user turns may appear as prior context. */
export const PRIOR_CONTEXT_MAX_TURNS = 4
/** Total char budget for the prior-context block. */
export const PRIOR_CONTEXT_MAX_CHARS = 2000
/** Per-turn char budget inside the prior-context block. */
export const PRIOR_CONTEXT_TURN_MAX_CHARS = 500
/** Per-tool-result char budget inside the evidence block. */
export const TOOL_RESULT_MAX_CHARS = 300
/** Total char budget for the current-turn evidence block. */
export const TURN_EVIDENCE_MAX_CHARS = 8000

/**
 * The marker appended/prepended whenever WE cut text. Without this the judge
 * cannot distinguish "the supervisor cut this" from "the agent stopped here",
 * and it reliably chooses the latter (169 confirmed false verdicts).
 */
function truncationNotice(shown, total, keep, label) {
  const omitted = total - shown
  return keep === 'tail'
    ? `[…truncated by supervisor: the FIRST ${omitted} of ${total} chars of this ${label} were omitted; the text below is its verbatim ENDING. This cut was made by the supervisor, NOT by the agent — do NOT treat it as the agent stopping mid-sentence or producing an incomplete response.]`
    : `[…truncated by supervisor: showing the first ${shown} of ${total} chars of this ${label}; the remaining ${omitted} chars were omitted by the supervisor, NOT by the agent — do NOT treat this as the agent stopping mid-sentence or producing an incomplete response.]`
}

/**
 * Truncate text for a prompt, ALWAYS leaving an explicit machine-readable
 * marker so the judge knows the cut was ours.
 *
 * Default `keep: 'tail'` is deliberate: the completion evidence of an assistant
 * message lives in its conclusion ("tests pass", "PR #123 opened", "done"), not
 * in its preamble. Keeping the head is what produced the false-truncation
 * verdicts in the first place. Use `keep: 'head'` only for inputs whose meaning
 * is front-loaded (a user request, a tool's command line).
 *
 * @param {string} text
 * @param {number} [limit]
 * @param {{keep?: 'head'|'tail', label?: string}} [opts]
 * @returns {string}
 */
export function truncateForPrompt(text, limit = PROMPT_TEXT_LIMIT, opts = {}) {
  const { keep = 'tail', label = 'message' } = opts
  if (typeof text !== 'string') return ''
  if (!Number.isFinite(limit) || limit <= 0) return text
  if (text.length <= limit) return text
  if (keep === 'head') {
    return `${text.slice(0, limit)}\n\n${truncationNotice(limit, text.length, 'head', label)}`
  }
  return `${truncationNotice(limit, text.length, 'tail', label)}\n\n${text.slice(text.length - limit)}`
}

/** True when a user-role text part is a supervisor injection, not a human ask. */
export function isSupervisorInjectedText(text) {
  if (typeof text !== 'string') return false
  return text.includes(SELF_ASSESSMENT_MARKER) || text.includes(FEEDBACK_MARKER)
}

/**
 * The human-authored text of a user message, or null when the message carries
 * none (supervisor injection, async `<task-notification>` metadata, tool-only).
 * Mirrors the filter buildTaskContext/buildTaskContextFromTranscript already
 * applied inline — extracted here so every caller agrees on what "a real user
 * turn" is.
 * @param {any} msg
 * @returns {string|null}
 */
export function userMessageText(msg) {
  for (const part of msg?.parts || []) {
    if (part?.type !== 'text' || !part.text) continue
    if (isSupervisorInjectedText(part.text)) continue
    if (part.text.trim().startsWith('<task-notification>')) continue
    return part.text
  }
  return null
}

/**
 * THE single assistant-text extractor.
 *
 * Before this existed there were two, and they disagreed:
 * `extractLastAssistantText` returned the FIRST text part of the last assistant
 * message, while `buildTaskContext` kept the LAST text part. On a multi-part
 * assistant message (any turn where the model interleaves prose with tool
 * calls) each dropped content the other kept, and which one fed the judge
 * depended on which call site you were looking at.
 *
 * This joins ALL text parts of the last assistant message that has any — a
 * superset of both old behaviours, losing nothing.
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.info?.role !== 'assistant') continue
    const texts = []
    for (const part of msg.parts || []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text)
      }
    }
    if (texts.length) return texts.join('\n\n')
  }
  return ''
}

/**
 * Index of the last user message that carries a real human ask.
 * Everything AFTER this index is the current turn's work.
 * @param {any[]} messages
 * @returns {number} -1 when there is none
 */
export function findLastRelevantUserIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.info?.role !== 'user') continue
    if (userMessageText(msg) != null) return i
  }
  return -1
}

/**
 * Split the session's human messages into what the judge must judge
 * (`currentTask` — the latest ask) and what it must NOT re-open
 * (`priorContext` — bounded, clearly-labelled, already-addressed background).
 *
 * The old behaviour concatenated all of them into one unweighted `[1]..[n]`
 * blob, which is what let a 20-turn session's judge demand turn 1's deliverables
 * on turn 20 ("open the PR and deploy" -> "commit PRD.md and TDD.md").
 *
 * @param {string[]} humanMessages in chronological order
 * @param {{maxTurns?: number, maxChars?: number, turnMaxChars?: number}} [opts]
 * @returns {{currentTask: string, priorContext: string}}
 */
export function splitUserTurns(humanMessages, opts = {}) {
  const {
    maxTurns = PRIOR_CONTEXT_MAX_TURNS,
    maxChars = PRIOR_CONTEXT_MAX_CHARS,
    turnMaxChars = PRIOR_CONTEXT_TURN_MAX_CHARS,
  } = opts
  const msgs = (Array.isArray(humanMessages) ? humanMessages : []).filter(
    (m) => typeof m === 'string' && m.trim()
  )
  if (msgs.length === 0) return { currentTask: '', priorContext: '' }

  const currentTask = msgs[msgs.length - 1]
  const earlier = msgs.slice(0, -1)
  if (earlier.length === 0) return { currentTask, priorContext: '' }

  const windowed = earlier.slice(-maxTurns)
  const offset = earlier.length - windowed.length

  // Fill from the most recent backwards so the char cap drops the STALEST
  // turns first, never the ones nearest the current ask.
  const lines = []
  let used = 0
  for (let i = windowed.length - 1; i >= 0; i--) {
    const line = `[turn ${offset + i + 1}] ${truncateForPrompt(windowed[i], turnMaxChars, { keep: 'head', label: 'earlier user message' })}`
    if (used + line.length > maxChars && lines.length > 0) break
    lines.unshift(line)
    used += line.length
  }
  return { currentTask, priorContext: lines.join('\n\n') }
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  if (toolName === 'bash' && typeof input.command === 'string') return input.command
  const filePath = input.file_path || input.filePath || input.path
  if (typeof filePath === 'string' && filePath) return filePath
  if (typeof input.description === 'string' && input.description) return input.description
  if (typeof input.pattern === 'string' && input.pattern) return input.pattern
  if (typeof input.prompt === 'string' && input.prompt) return input.prompt.slice(0, 150)
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * Everything the agent actually DID since the user's latest ask: all assistant
 * text plus every tool call WITH ITS RESULT.
 *
 * Tool results were previously invisible to the judge — `state.output` was
 * referenced nowhere in the codebase, so the judge saw that `npm test` was
 * *invoked* but never that it *passed*, and then demanded the agent "run the
 * tests" it had already run.
 *
 * SDK shape (verified against @opencode-ai/sdk `ToolPart`/`ToolState` and
 * against real rows in ~/.local/share/opencode/opencode.db):
 *   part.type === 'tool'
 *   part.tool   -> string  (tool name)
 *   part.state.status -> 'pending' | 'running' | 'completed' | 'error'
 *   part.state.input  -> object
 *   part.state.output -> STRING, present only when status === 'completed'
 *   part.state.error  -> STRING, present only when status === 'error'
 *
 * @param {any[]} messages
 * @param {{resultMaxChars?: number, totalMaxChars?: number, fromIndex?: number}} [opts]
 * @returns {string} '' when there is no evidence
 */
export function buildTurnEvidence(messages, opts = {}) {
  const {
    resultMaxChars = TOOL_RESULT_MAX_CHARS,
    totalMaxChars = TURN_EVIDENCE_MAX_CHARS,
  } = opts
  if (!Array.isArray(messages)) return ''
  const start = opts.fromIndex ?? findLastRelevantUserIndex(messages)
  const entries = []

  for (let i = start + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.info?.role !== 'assistant') continue
    for (const part of msg.parts || []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        entries.push(`[agent said]\n${part.text.trim()}`)
        continue
      }
      if (part?.type !== 'tool') continue
      const toolName = (part.tool || 'tool').toString()
      const state = part.state || {}
      const inputSummary = summarizeToolInput(toolName.toLowerCase(), state.input)
      const header = `[tool] ${toolName}${inputSummary ? ` — ${inputSummary.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
      if (state.status === 'completed' && typeof state.output === 'string' && state.output.trim()) {
        entries.push(
          `${header}\n  result: ${truncateForPrompt(state.output.trim(), resultMaxChars, { keep: 'head', label: 'tool result' }).replace(/\n/g, '\n  ')}`
        )
      } else if (state.status === 'error' && typeof state.error === 'string' && state.error.trim()) {
        entries.push(
          `${header}\n  ERROR: ${truncateForPrompt(state.error.trim(), resultMaxChars, { keep: 'head', label: 'tool error' }).replace(/\n/g, '\n  ')}`
        )
      } else {
        entries.push(`${header}\n  (still running or no result recorded)`)
      }
    }
  }

  if (entries.length === 0) return ''

  // Keep the TAIL: the most recent work is the evidence of completion.
  const kept = []
  let used = 0
  let dropped = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (used + entries[i].length > totalMaxChars && kept.length > 0) {
      dropped = i + 1
      break
    }
    kept.unshift(entries[i])
    used += entries[i].length
  }
  const prefix = dropped > 0
    ? `[…truncated by supervisor: ${dropped} earlier step(s) of this turn omitted for length; the most recent steps are shown below. This cut was made by the supervisor, NOT by the agent.]\n\n`
    : ''
  return prefix + kept.join('\n\n')
}
