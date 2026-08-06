import { FEEDBACK_MARKER } from './evaluation.mjs'
import { DEFAULT_MAX_ATTEMPTS } from './goal.mjs'
import { appendStatusDirective } from './status-directive.mjs'

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
 */
export function buildEscalatingFeedback(
  attemptCount,
  severity,
  verdict,
  maxAttempts
) {
  const safeVerdict = verdict ?? {}
  const missingItems = (Array.isArray(safeVerdict.missing) ? safeVerdict.missing : []).map(rewriteIfDestructive)
  const nextActionItems = (Array.isArray(safeVerdict.next_actions) ? safeVerdict.next_actions : []).map(rewriteIfDestructive)
  const feedbackStr = safeVerdict.feedback || ''
  const confidence = typeof safeVerdict.confidence === 'number' ? safeVerdict.confidence : undefined
  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS

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
  const headline = lowConfidence
    ? `${FEEDBACK_MARKER} Task may be incomplete (${severity})`
    : `${FEEDBACK_MARKER} Task Incomplete (${severity})`
  const closing = lowConfidence
    ? 'This assessment was not fully confident — if these are already handled, say so; otherwise please continue.'
    : 'Please address these issues and continue.'

  // The status/roadmap directive is appended LAST so it survives as the final
  // instruction the agent reads — it is orthogonal to the judge's verdict and
  // never replaces or reorders it.
  return appendStatusDirective(`${headline}
${feedbackStr}
${missing}
${nextActions}

${closing}`)
}
