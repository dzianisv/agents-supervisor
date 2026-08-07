import { FEEDBACK_MARKER } from './evaluation.mjs'

import { appendStatusDirective, stripStatusDirective } from './status-directive.mjs'

// Items matching any of these must never be presented as ordinary
// agent-actionable work. Force-pushes, hard resets, history rewrites, branch
// deletion, and rm -rf are all one-way doors — the agent should flag them to
// the user for approval rather than being nudged by escalating feedback to
// just go do them.
const DESTRUCTIVE_ACTION_PATTERNS = [
  /force[- ]?push/i,
  /git\s+push\b.*(-f\b|--force\b)/i,
  /reset\s+--hard\b/i,
  /rewrit(e|ing|ten)[\s\S]{0,30}\bhistory\b|\bhistory\b[\s\S]{0,30}rewrit(e|ing|ten)/i,
  /\bdelete\b.*\bbranch\b|\bbranch\b.*\bdelet(e|ion)\b/i,
  /rm\s+-rf\b|rm\s+-fr\b/i,
]

function isDestructiveAction(item) {
  return typeof item === 'string' && DESTRUCTIVE_ACTION_PATTERNS.some((re) => re.test(item))
}

function rewriteIfDestructive(item) {
  return isDestructiveAction(item) ? `Flag to the user for approval: ${item}` : item
}

const GOAL_SECTION_HEADING = '### Standing goal (not a gap in this turn)'

function nonBlankStrings(value) {
  return (Array.isArray(value) ? value : []).filter((v) => typeof v === 'string' && v.trim() !== '')
}

/**
 * True when the judge's verdict carries NOTHING actionable: no missing items,
 * no next actions, and no feedback text once whitespace is stripped.
 *
 * Rendering such a verdict produces a "Task Incomplete" headline with an empty
 * body — zero information for the agent, which then does nothing new, goes
 * idle, and gets the identical empty message again. Observed in production:
 * the same content-free injection repeated 15x at ~20s intervals until the
 * retry cap (38 cases in 30 days). Callers MUST stand down instead of
 * injecting when this returns true. Goal items are deliberately NOT counted
 * as actionable content here: a standing goal is not a gap produced by this
 * turn, so it can never on its own justify pushing the agent again.
 */
export function isActionlessVerdict(verdict) {
  const v = verdict ?? {}
  if (nonBlankStrings(v.missing).length > 0) return false
  if (nonBlankStrings(v.next_actions).length > 0) return false
  return typeof v.feedback !== 'string' || v.feedback.trim() === ''
}

/**
 * True when the rendered feedback message has no body at all below its
 * headline — a last-resort guard so no runtime can ever inject an empty
 * "Task Incomplete" message even if a future verdict shape slips past
 * isActionlessVerdict.
 */
export function hasFeedbackBody(text) {
  if (typeof text !== 'string') return false
  // The status/roadmap directive is appended to EVERY continuation message.
  // It is boilerplate, not verdict content, so it must be removed before the
  // body check — otherwise this guard can never return false and becomes
  // dead code (which is exactly what the status-directive merge did to it).
  const withoutDirective = stripStatusDirective(text)
  // The standing-goal section is context, never a per-turn gap, so it must
  // not by itself make a message look like it has something to say.
  const goalIdx = withoutDirective.indexOf(GOAL_SECTION_HEADING)
  const perTurn = goalIdx === -1 ? withoutDirective : withoutDirective.slice(0, goalIdx)
  const body = perTurn
    .split('\n')
    .slice(1) // line 0 is the headline
    .filter((l) => l.trim() !== '')
    .filter((l) => !/^(Please address these issues and continue\.|This assessment was not fully confident)/.test(l.trim()))
  return body.length > 0
}

/**
 * Build the single continuation message the reflection judge's verdict is
 * rendered into. IMPORTANT: this function has exactly ONE authority over
 * completion feedback — the judge's own verdict (missing/next_actions/
 * feedback/confidence). It must never substitute a deterministic,
 * judge-independent "STOP" script (e.g. a planning-loop or action-loop
 * watchdog) for that verdict — doing so previously let a heuristic tool-call
 * ratio override genuine judge output. Deterministic tool-call telemetry may
 * still inform the judge as non-binding evidence upstream (see
 * core/evaluation.mjs's describeToolActivity, threaded into the judge prompt
 * via TaskContext.toolActivityNote) — it just never bypasses this function's
 * output.
 *
 * NO ATTEMPT-COUNT ESCALATION. This function used to take `attemptCount` and
 * `maxAttempts`; both were dead (`attemptCount` was never read, and the
 * `maxAttempts`-derived `effectiveCap` was computed and then never used). They
 * are gone rather than "wired up", deliberately:
 *   - "One calm template, always" is a standing decision here. Escalating tone
 *     ("FINAL ATTEMPT", "attempt 3 of 3") is pressure to declare victory, which
 *     is the exact failure this supervisor exists to catch.
 *   - A parameter a function ignores is worse than no parameter: every reader
 *     assumes the escalation exists, and the "(n/N)" it implies was a number
 *     the code could not honour.
 * The judge's own prompt still receives the attempt number
 * (core/reflection-prompt.mjs, core/assessment.mjs render
 * `{{attemptNumber}}/{{maxAttempts}}`) — that is where it is genuinely used.
 * The autopilot nudge still shows "(n/N)" because that counter is now real
 * and persisted; this message never showed one.
 *
 * @param {string} severity
 * @param {object} verdict judge verdict fields
 * @param {object} [opts]
 * @param {boolean} [opts.statusDirective=true] append the status/roadmap
 *   directive. Defaults ON (the directive is default-on); callers pass
 *   `isStatusDiagramEnabled(state)` so `/supervisor:status off` silences the
 *   reflection path too, not just the autopilot nudge.
 */
export function buildEscalatingFeedback(
  severity,
  verdict,
  opts = {}
) {
  const safeVerdict = verdict ?? {}
  // A standing goal is a long-lived project/session condition, NOT something
  // this turn failed to do. Merging goal-derived items into `### Missing`
  // (what this used to do) is why a user reading the message saw
  // "Missing: reach $1,000 MRR" sitting next to "Missing: fix build errors"
  // as if both were gaps the agent just created. They render separately now.
  const goalCondition = typeof safeVerdict.goal_condition === 'string' ? safeVerdict.goal_condition.trim() : ''
  const goalItems = nonBlankStrings(safeVerdict.goal_items).map(rewriteIfDestructive)
  const goalItemSet = new Set(nonBlankStrings(safeVerdict.goal_items))
  const missingItems = nonBlankStrings(safeVerdict.missing)
    .filter((m) => !goalItemSet.has(m))
    .map(rewriteIfDestructive)
  const nextActionItems = nonBlankStrings(safeVerdict.next_actions)
    .filter((a) => !goalItemSet.has(a))
    .map(rewriteIfDestructive)
  const feedbackStr = safeVerdict.feedback || ''
  const confidence = typeof safeVerdict.confidence === 'number' ? safeVerdict.confidence : undefined

  // One calm template, always — no attempt-count escalation tiers. Nothing
  // here ever claims this is a "final" or "last" chance; only the reason
  // detail and (when the judge itself was unsure) the framing below vary.
  const lowConfidence = confidence !== undefined && confidence < 0.7
  const missing = missingItems.length
    ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join('\n')}`
    : ''
  const nextActions = nextActionItems.length
    ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join('\n')}`
    : ''
  const goalLines = goalItems.length
    ? goalItems.map((g) => `- ${g}`).join('\n')
    : goalCondition
      ? `- ${rewriteIfDestructive(goalCondition)}`
      : ''
  const goalSection = goalLines
    ? `\n${GOAL_SECTION_HEADING}\n${goalLines}\nThis is a standing condition carried across turns — it is context, not a gap introduced by this turn. Do not treat it as the reason this turn is incomplete.`
    : ''
  const headline = lowConfidence
    ? `${FEEDBACK_MARKER} Task may be incomplete (${severity})`
    : `${FEEDBACK_MARKER} Task Incomplete (${severity})`
  const closing = lowConfidence
    ? 'This assessment was not fully confident — if these are already handled, say so; otherwise please continue.'
    : 'Please address these issues and continue.'

  // The status/roadmap directive is appended LAST so it survives as the final
  // instruction the agent reads — it is orthogonal to the judge's verdict and
  // never replaces or reorders it.
  const rendered = `${headline}
${feedbackStr}
${missing}
${nextActions}
${goalSection}

${closing}`
  return opts?.statusDirective === false ? rendered : appendStatusDirective(rendered)
}
