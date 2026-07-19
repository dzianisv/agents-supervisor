import { FEEDBACK_MARKER } from './evaluation.mjs'
import { DEFAULT_MAX_ATTEMPTS } from './goal.mjs'

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

export function buildEscalatingFeedback(
  attemptCount,
  severity,
  verdict,
  isPlanningLoop,
  isActionLoop,
  maxAttempts
) {
  const safeVerdict = verdict ?? {}
  const missingItems = (Array.isArray(safeVerdict.missing) ? safeVerdict.missing : []).map(rewriteIfDestructive)
  const nextActionItems = (Array.isArray(safeVerdict.next_actions) ? safeVerdict.next_actions : []).map(rewriteIfDestructive)
  const feedbackStr = safeVerdict.feedback || ''
  const confidence = typeof safeVerdict.confidence === 'number' ? safeVerdict.confidence : undefined
  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (isPlanningLoop) {
    return `${FEEDBACK_MARKER} STOP: Planning Loop Detected

You have been reading files, checking git status, and creating todo lists without writing any code.

DO NOT:
- Run git status or git log again
- Create another todo list
- Read more files "for context"
- Say "let me get right to work" without actually working

DO NOW:
Pick the FIRST item from your existing todo list and implement it. Open a file with Edit or Write and make changes. If you don't know where to start, create the simplest possible file first.

Start coding NOW. No more planning.`
  }

  if (isActionLoop) {
    return `${FEEDBACK_MARKER} STOP: Action Loop Detected (attempt ${attemptCount}/${effectiveCap})

You are repeating the same commands without making progress. Running the same deploy/test/build cycle again will produce the same result.

STOP and do ONE of these:
1. If the same test/eval keeps failing, analyze the failure output and fix the root cause before re-running.
2. If you cannot fix the root cause, explain what is blocking you and ask the user for help.
3. Try a completely different approach (e.g., test locally instead of via deployment).

Do NOT re-run the same command hoping for a different result.`
  }

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

  return `${headline}
${feedbackStr}
${missing}
${nextActions}

${closing}`
}

/**
 * Solofounder-mode continuation message — same escalation SLOT as
 * buildEscalatingFeedback's calm template, but framed as a CEO directive
 * instead of generic "Missing/Next Actions" feedback: restate the $1M ARR
 * bar, then instruct the agent to run the CEO loop (pick the highest-leverage
 * workstream, spawn parallel doers, evaluate on a rubric, integrate) rather
 * than just "address these issues". MUST start with FEEDBACK_MARKER — the
 * Stop hook's computeTurnKey fingerprints the last user message NOT
 * containing that marker, so any injected text lacking the exact prefix
 * corrupts the per-turn attempt counter.
 * @param {object} opts
 * @param {string} opts.goalCondition — the $1M ARR condition text
 * @param {import('./evaluation.mjs').SupervisorAnalysis} [opts.analysis]
 * @param {number} [opts.attempt]
 * @param {number} [opts.effectiveMax]
 * @returns {string}
 */
export function buildCeoDirective({ goalCondition, analysis, attempt, effectiveMax }) {
  const safeAnalysis = analysis ?? {}
  const missingItems = (Array.isArray(safeAnalysis.missing) ? safeAnalysis.missing : []).map(rewriteIfDestructive)
  const nextActionItems = (Array.isArray(safeAnalysis.nextActions) ? safeAnalysis.nextActions : []).map(rewriteIfDestructive)
  const reason = safeAnalysis.reason || ''
  const missing = missingItems.length
    ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join('\n')}`
    : ''
  const nextActions = nextActionItems.length
    ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join('\n')}`
    : ''
  const attemptSuffix = attempt !== undefined && effectiveMax !== undefined ? ` (attempt ${attempt}/${effectiveMax})` : ''

  return `${FEEDBACK_MARKER} CEO Directive${attemptSuffix}

The $1M ARR bar is not yet met: "${goalCondition}"
${reason ? `\n${reason}` : ''}
${missing}${nextActions}

Run the CEO loop now — you are the operator, not an assistant waiting for a task:
1. Pick the ONE highest-leverage unblocked workstream (engineering / product / growth / content) toward the ARR bar.
2. Spawn parallel doer subagents on narrow, named scopes — never a vague "audit the repo".
3. Evaluate each doer's output against a rubric: did it ship real, verifiable work — not a stub, not narration.
4. Integrate what passes, record workstream state, and rotate to the next lever.

Never nudge a destructive or wasteful action (force-push, hard reset, history rewrite, branch deletion, rm -rf, unapproved spend) — flag those to the user instead of doing them.`
}
