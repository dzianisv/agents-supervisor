/**
 * Shared status/roadmap directive appended to EVERY supervisor continuation
 * prompt (both the autopilot nudge and the reflection feedback message), and
 * injected into the system prompt of every ordinary session turn.
 *
 * Why: long sessions get context-compacted, and the agent loses the roadmap it
 * built earlier. `status.md` on disk is the durable store; the ASCII roadmap
 * block is the cheap, always-visible reminder of where the work stands.
 *
 * The continuation-prompt path only covers turns the supervisor itself
 * injects — i.e. never the FIRST turn of a session, which is exactly the turn
 * that establishes the roadmap. The system-prompt path (opencode's
 * `experimental.chat.system.transform` hook) closes that gap.
 *
 * Built by joining plain lines (not a template literal) because the directive
 * itself contains backticks and a fenced code block — no interpolation, no
 * escaping.
 */

import { statSync } from 'node:fs'

/**
 * Stable, machine-greppable first line of the directive.
 *
 * Two jobs:
 *  1. Idempotency — `experimental.chat.system.transform` fires more than once
 *     per user turn (observed twice for a single prompt on opencode 1.17.9),
 *     and opencode itself may reuse/carry system arrays. Callers test for this
 *     marker before pushing so the directive can never land twice.
 *  2. Provenance — makes it obvious in a transcript dump that this text came
 *     from the supervisor plugin and not from the user or the model.
 *
 * It is an HTML comment so every markdown renderer swallows it.
 */
export const STATUS_DIRECTIVE_MARKER = '<!-- supervisor:status-directive -->'

export const STATUS_DIAGRAM_DIRECTIVE = [
  STATUS_DIRECTIVE_MARKER,
  '### Status checkpoint (required, every iteration)',
  '',
  '`status.md` in the project root is your durable memory across context compaction. Before you continue:',
  '',
  '1. Read `status.md` (create it if missing).',
  '2. Update the checklist — `[x]` done, `[~]` in progress, `[ ]` pending. Never delete finished items.',
  '3. Write the ASCII roadmap block below into `status.md` AND print it at the end of your reply.',
  '',
  '```',
  'ROADMAP  ██████░░░░░░░░░░░░░░  3/10 done',
  ' [x] 1. <shipped thing>',
  ' [x] 2. <shipped thing>',
  ' [~] 3. <current thing>   <-- YOU ARE HERE',
  ' [ ] 4. <next thing>',
  ' [ ] 5. <later thing>',
  '',
  'WHY SLOW',
  ' - <concrete cause: e.g. "4 retries on flaky E2E", "waiting on CI", "scope grew">',
  '',
  'NEXT',
  ' - <the single next action>',
  '```',
  '',
  'Keep it under 25 lines. Facts only, no filler. If nothing changed since last iteration, say so and name the blocker.',
].join('\n')

/**
 * Append the status directive to a continuation message so it is always the
 * LAST thing the agent reads.
 */
export function appendStatusDirective(text) {
  const base = typeof text === 'string' ? text : String(text ?? '')
  return `${base.replace(/\s+$/, '')}\n\n${STATUS_DIAGRAM_DIRECTIVE}`
}

/**
 * True when `systemArray` already carries the directive.
 * Tolerates non-array input and non-string entries — this runs against a live
 * value handed over by the opencode runtime, not a value we constructed.
 * @param {unknown} systemArray
 * @returns {boolean}
 */
export function hasStatusDirective(systemArray) {
  if (!Array.isArray(systemArray)) return false
  return systemArray.some((s) => typeof s === 'string' && s.includes(STATUS_DIRECTIVE_MARKER))
}

/**
 * Idempotently push the directive onto an opencode system-prompt array
 * (`output.system` of `experimental.chat.system.transform`).
 *
 * Returns true when it actually appended, false when it was already present or
 * the input was not a usable array. Mutates in place — the runtime hands us
 * the live array and reads it back after the hook resolves.
 *
 * @param {unknown} systemArray
 * @returns {boolean} whether the directive was appended by this call
 */
export function appendStatusDirectiveToSystem(systemArray) {
  if (!Array.isArray(systemArray)) return false
  if (hasStatusDirective(systemArray)) return false
  systemArray.push(STATUS_DIAGRAM_DIRECTIVE)
  return true
}

/**
 * Did the agent actually perform the status checkpoint this turn?
 *
 * Deterministic and LLM-free on purpose: this gate runs on the "task is
 * complete" path, where an LLM round-trip would both cost money and be able
 * to hallucinate compliance. Two independent pieces of evidence are accepted,
 * because the directive asks for BOTH and either one alone proves the agent
 * engaged with it:
 *
 *   1. The reply printed the roadmap block — detected by requiring BOTH the
 *      `ROADMAP` header and the `YOU ARE HERE` cursor, case-insensitively.
 *      Requiring both avoids matching an incidental mention of the word
 *      "roadmap" in ordinary prose.
 *   2. `status.md` was written during this turn — mtime at or after the
 *      turn's start.
 *
 * Fail-open by construction: a missing/unreadable `statusFilePath`, a blank
 * `lastAssistantText`, or a `turnStartedAtMs` we could not determine must
 * never be able to manufacture a *stricter* verdict than the evidence
 * supports. In particular callers pass `turnStartedAtMs = 0` when the turn
 * start is unknown, which makes any existing `status.md` count as fresh —
 * deliberately choosing "don't nag" over "nag on a guess".
 *
 * @param {object} opts
 * @param {string} [opts.lastAssistantText] final assistant text of the turn
 * @param {string} [opts.statusFilePath] absolute path to the session project's status.md
 * @param {number} [opts.turnStartedAtMs] epoch ms the human turn began; 0/undefined = unknown
 * @returns {{compliant: boolean, reason: string}}
 */
export function checkStatusCompliance({ lastAssistantText, statusFilePath, turnStartedAtMs } = {}) {
  const text = typeof lastAssistantText === 'string' ? lastAssistantText : ''
  if (/ROADMAP/i.test(text) && /YOU ARE HERE/i.test(text)) {
    return { compliant: true, reason: 'roadmap block present in reply' }
  }

  if (typeof statusFilePath === 'string' && statusFilePath) {
    let mtimeMs = null
    try {
      mtimeMs = statSync(statusFilePath).mtimeMs
    } catch {
      return { compliant: false, reason: 'no roadmap in reply and status.md missing' }
    }
    const startedAt = Number.isFinite(turnStartedAtMs) ? Number(turnStartedAtMs) : 0
    if (mtimeMs >= startedAt) {
      return { compliant: true, reason: 'status.md written during this turn' }
    }
    return { compliant: false, reason: 'no roadmap in reply and status.md not updated this turn' }
  }

  return { compliant: false, reason: 'no roadmap in reply and no status.md path to check' }
}

/**
 * The one-shot correction injected when the agent declared the work complete
 * without doing the status checkpoint. Deliberately short: the agent is one
 * step from stopping, so this must read as a small final chore, not a new
 * task. The directive itself is appended last (see appendStatusDirective).
 */
export function buildStatusCorrectionMessage() {
  return appendStatusDirective(
    [
      'The work looks complete, but the required status checkpoint is missing —',
      'you did not update `status.md` or print the roadmap block this turn.',
      '',
      'Do only that now: update `status.md` and print the roadmap block. Do not',
      'start new work, and do not re-do work that is already finished.',
    ].join('\n')
  )
}
