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
 *
 * WHAT THE JUDGE GETS NOW (owner decision, 2026-08-06):
 *
 *   The judge's context is the plain alternating conversation chain and
 *   NOTHING else:
 *
 *       user:      <text>
 *       assistant: <text>
 *       user:      <text>
 *       assistant: <text>
 *
 *   Deliberately dropped, with the tradeoff accepted: tool calls, tool inputs
 *   and tool results; the numbered `[1]..[n]` demand blob; and the separate
 *   currentTask / priorContext / turnEvidence split. The judge can no longer
 *   independently verify a claim ("tests pass") against a tool result — it
 *   judges the conversation the way a human reading the transcript would.
 *
 * Everything here is pure and synchronous so both runtimes (the OpenCode plugin
 * and the Claude Code Stop hook) share one implementation and one test suite.
 */

import {
  isNonHumanUserMessage, isNonHumanUserText,
} from './evaluation.mjs'

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

/**
 * Total char budget for the whole conversation chain handed to the judge.
 *
 * The MOST RECENT user+assistant pair is exempt: it is always included in full
 * (each message capped at PROMPT_TEXT_LIMIT) even when it alone blows this
 * budget, because that pair IS the thing being judged. This number only bounds
 * how much OLDER conversation rides along as context.
 */
export const CHAIN_MAX_CHARS = 10000

/**
 * Below this many remaining chars an older turn is dropped rather than trimmed
 * — a 40-char sliver of a request is noise, not context.
 */
export const CHAIN_MIN_TURN_CHARS = 200

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

/**
 * True when a user-role text part is a machine injection, not a human ask.
 *
 * Delegates to `isNonHumanUserText` (core/evaluation.mjs) — THE single
 * predicate. This name used to carry its own narrower copy that only knew
 * about THIS supervisor's markers, so a FOREIGN Stop hook's injection
 * (`Stop hook feedback: …`, `isMeta:true`) read as a fresh human message.
 * Kept as a named alias because it reads better at the call sites in this
 * module; it must never grow a second implementation.
 */
export function isSupervisorInjectedText(text) {
  return isNonHumanUserText(text)
}

/**
 * The human-authored text of a user message, or null when the message carries
 * none (supervisor injection, FOREIGN Stop-hook injection, `isMeta` insert,
 * async `<task-notification>` metadata, tool-only).
 *
 * Mirrors the filter buildTaskContext/buildTaskContextFromTranscript already
 * applied inline — extracted here so every caller agrees on what "a real user
 * turn" is. `computeTurnKey` (bin/supervisor-on-stop.mjs) and
 * `getLastRelevantUserMessageId` (opencode/supervisor-impl.ts) answer the same
 * question through the same two evaluation.mjs helpers.
 * @param {any} msg
 * @returns {string|null}
 */
export function userMessageText(msg) {
  // Message-level check first: CC flags a hook insert with a top-level
  // `isMeta`, which no per-part text inspection can see.
  if (isNonHumanUserMessage(msg)) return null
  for (const part of msg?.parts || []) {
    if (part?.type !== 'text' || !part.text) continue
    if (isNonHumanUserText(part.text)) continue
    if (part.text.trim().startsWith('<task-notification>')) continue
    return part.text
  }
  return null
}

/**
 * THE single assistant-text extractor, per message.
 *
 * Before this existed there were two, and they disagreed:
 * `extractLastAssistantText` returned the FIRST text part of the last assistant
 * message, while `buildTaskContext` kept the LAST text part. On a multi-part
 * assistant message (any turn where the model interleaves prose with tool
 * calls) each dropped content the other kept, and which one fed the judge
 * depended on which call site you were looking at.
 *
 * This joins ALL text parts of one assistant message — a superset of both old
 * behaviours, losing nothing. `extractLastAssistantText` and
 * `buildConversationChain` both go through here; there is still exactly one
 * extractor.
 *
 * @param {any} msg
 * @returns {string} '' when the message is not an assistant message with text
 */
export function assistantMessageText(msg) {
  if (msg?.info?.role !== 'assistant') return ''
  const texts = []
  for (const part of msg?.parts || []) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text)
    }
  }
  return texts.join('\n\n')
}

/**
 * The text of the last assistant message that has any.
 * @param {any[]} messages
 * @returns {string}
 */
export function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantMessageText(messages[i])
    if (text) return text
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
 * The user's LATEST real ask. Used by the non-actionable-turn gate and as
 * `taskSummary`, NOT as judge context (the judge reads the chain).
 * @param {string[]} humanMessages chronological
 * @returns {string}
 */
export function currentUserTask(humanMessages) {
  const msgs = (Array.isArray(humanMessages) ? humanMessages : []).filter(
    (m) => typeof m === 'string' && m.trim()
  )
  return msgs.length ? msgs[msgs.length - 1] : ''
}

// ---------------------------------------------------------------------------
// The conversation chain — the judge's ONLY context.
// ---------------------------------------------------------------------------

const TURN_SEPARATOR = '\n\n---\n\n'

/**
 * Group the transcript into alternating human/assistant turns.
 *
 * A turn opens on a real HUMAN user message and absorbs every assistant
 * message until the next one. Supervisor injections (SELF_ASSESSMENT_MARKER /
 * FEEDBACK_MARKER) and `<task-notification>` metadata are not human turns —
 * they are filtered by `userMessageText`, so assistant work that follows them
 * stays attached to the human turn it actually belongs to.
 *
 * Assistant text that precedes the first human message has no turn to belong
 * to and is dropped: a chain must start with a user.
 *
 * @param {any[]} messages
 * @returns {{user: string, assistant: string}[]} oldest → newest
 */
export function collectConversationTurns(messages) {
  if (!Array.isArray(messages)) return []
  /** @type {{user: string, assistant: string[]}[]} */
  const turns = []
  // NOTE (checked, do not "fix"): a supervisor-injected user message is
  // excluded from the chain, but the agent's REPLY to it is deliberately
  // attached to the preceding HUMAN turn. It reads oddly in a prompt dump —
  // the reply to a status-checkpoint correction appears inside an earlier
  // turn's assistant block — but suppressing it would hide the agent's
  // corrective work from the judge, which would then keep seeing only the
  // first, incomplete attempt and re-inject forever. Pinned by
  // test/task-context.test.mjs, "supervisor-injected messages are NEVER a turn
  // in the chain" (it asserts `second attempt` IS present).
  for (const msg of messages) {
    const role = msg?.info?.role
    if (role === 'user') {
      const text = userMessageText(msg)
      if (text == null || !text.trim()) continue
      turns.push({ user: text, assistant: [] })
      continue
    }
    if (role !== 'assistant') continue
    const text = assistantMessageText(msg)
    if (!text || turns.length === 0) continue
    turns[turns.length - 1].assistant.push(text)
  }
  return turns.map((t) => ({ user: t.user, assistant: t.assistant.join('\n\n') }))
}

function renderTurn(turn) {
  const blocks = [`user:\n${turn.user}`]
  if (turn.assistant) blocks.push(`assistant:\n${turn.assistant}`)
  return blocks.join('\n\n')
}

/**
 * Same principle as `truncationNotice`: whenever WE shorten the conversation,
 * say so in the supervisor's own name. Without this the judge reads a missing
 * earlier turn as the agent never having been asked, or a shortened reply as
 * the agent stopping mid-sentence.
 */
function chainTrimNotice(droppedTurns, trimmedTurns) {
  const bits = []
  if (droppedTurns > 0) bits.push(`${droppedTurns} earlier turn(s) omitted entirely`)
  if (trimmedTurns > 0) bits.push(`${trimmedTurns} message(s) shortened`)
  const what = bits.join(' and ') || 'earlier conversation shortened'
  return `[…conversation trimmed by supervisor: ${what} to fit the prompt budget. This cut was made by the supervisor, NOT by the agent — do NOT treat missing or shortened text as the agent stopping mid-sentence, skipping work, or producing an incomplete response.]`
}

/**
 * Render already-selected turns as the readable chain. Exported so callers
 * that have a user/assistant pair but no transcript (legacy prompt builders)
 * emit the exact same shape.
 *
 * @param {{user: string, assistant?: string}[]} turns oldest → newest
 * @param {{droppedTurns?: number, trimmedTurns?: number}} [opts]
 * @returns {string}
 */
export function formatConversationTurns(turns, opts = {}) {
  const list = (Array.isArray(turns) ? turns : []).filter(
    (t) => t && typeof t.user === 'string' && t.user.trim()
  )
  if (list.length === 0) return ''
  const body = list.map((t) => renderTurn({ user: t.user, assistant: t.assistant || '' })).join(TURN_SEPARATOR)
  const dropped = opts.droppedTurns || 0
  const trimmed = opts.trimmedTurns || 0
  if (dropped <= 0 && trimmed <= 0) return body
  return `${chainTrimNotice(dropped, trimmed)}\n\n${body}`
}

/** Cap each side of a turn at `limit`, reporting whether anything was cut. */
function capTurn(turn, limit) {
  const user = truncateForPrompt(turn.user, limit, { keep: 'head', label: 'user message' })
  const assistant = turn.assistant
    ? truncateForPrompt(turn.assistant, limit, { keep: 'tail', label: 'agent response' })
    : ''
  const cut = user !== turn.user || assistant !== turn.assistant
  return { turn: { user, assistant }, cut }
}

/** Squeeze a turn into `budget` chars rather than dropping it outright. */
function fitTurn(turn, budget) {
  const LABEL_OVERHEAD = 24 // "user:\n" + "\n\nassistant:\n"
  const room = Math.max(budget - LABEL_OVERHEAD, 2 * 60)
  const userLimit = Math.max(60, Math.floor(room * 0.4))
  const assistantLimit = Math.max(60, room - userLimit)
  return {
    user: truncateForPrompt(turn.user, userLimit, { keep: 'head', label: 'earlier user message' }),
    assistant: turn.assistant
      ? truncateForPrompt(turn.assistant, assistantLimit, { keep: 'tail', label: 'earlier agent response' })
      : '',
  }
}

/**
 * Build the judge's context: the plain alternating conversation.
 *
 * Budgeting walks BACKWARDS from the newest turn so the char cap sacrifices
 * the stalest conversation first, never the ask being judged:
 *
 *   1. The newest user+assistant pair is ALWAYS included, in full up to
 *      `messageMaxChars`, even if it alone exceeds `maxChars`.
 *   2. Older pairs are added while budget remains.
 *   3. The first older pair that does not fit is TRIMMED into whatever budget
 *      is left (if at least `minTurnChars` remain) rather than dropped.
 *   4. Anything older than that is dropped.
 *
 * Any drop or trim prepends an explicit supervisor-attributed marker. Output
 * is oldest → newest even though selection ran newest → oldest.
 *
 * @param {any[]} messages
 * @param {{maxChars?: number, messageMaxChars?: number, minTurnChars?: number}} [opts]
 * @returns {string} '' when there is no human turn at all
 */
export function buildConversationChain(messages, opts = {}) {
  const {
    maxChars = CHAIN_MAX_CHARS,
    messageMaxChars = PROMPT_TEXT_LIMIT,
    minTurnChars = CHAIN_MIN_TURN_CHARS,
  } = opts
  const turns = collectConversationTurns(messages)
  if (turns.length === 0) return ''

  const selected = []
  let used = 0
  let droppedTurns = 0
  let trimmedTurns = 0

  for (let i = turns.length - 1; i >= 0; i--) {
    // 1. The newest pair is exempt from the chain budget.
    if (i === turns.length - 1) {
      const { turn, cut } = capTurn(turns[i], messageMaxChars)
      if (cut) trimmedTurns++
      selected.push(turn)
      used += renderTurn(turn).length
      continue
    }
    const { turn, cut } = capTurn(turns[i], messageMaxChars)
    const cost = renderTurn(turn).length + TURN_SEPARATOR.length
    const remaining = maxChars - used
    // 2. Fits whole.
    if (cost <= remaining) {
      if (cut) trimmedTurns++
      selected.push(turn)
      used += cost
      continue
    }
    // 3. Doesn't fit but there is meaningful room: trim, don't drop.
    if (remaining >= minTurnChars) {
      const fitted = fitTurn(turns[i], remaining - TURN_SEPARATOR.length)
      trimmedTurns++
      selected.push(fitted)
      droppedTurns = i
      break
    }
    // 4. No meaningful room: everything from here down is dropped.
    droppedTurns = i + 1
    break
  }

  selected.reverse()
  return formatConversationTurns(selected, { droppedTurns, trimmedTurns })
}
