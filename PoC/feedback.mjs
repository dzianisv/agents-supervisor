/**
 * PoC/feedback.mjs — Sandbox copy of core/feedback.mjs.
 * Imports from local PoC evaluation.mjs only; does not touch core/.
 * DEFAULT_MAX_ATTEMPTS inlined to avoid goal.mjs dependency.
 */

import { FEEDBACK_MARKER } from './evaluation.mjs'

const DEFAULT_MAX_ATTEMPTS = 16

export function buildEscalatingFeedback(
  attemptCount,
  severity,
  verdict,
  isPlanningLoop,
  isActionLoop,
  maxAttempts
) {
  const safeVerdict = verdict ?? {}
  const missingItems = Array.isArray(safeVerdict.missing) ? safeVerdict.missing : []
  const nextActionItems = Array.isArray(safeVerdict.next_actions) ? safeVerdict.next_actions : []
  const feedbackStr = safeVerdict.feedback || ''
  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  if (isPlanningLoop) {
    return `${FEEDBACK_MARKER} STOP: Planning Loop Detected\n\nStart coding NOW. No more planning.`
  }

  if (isActionLoop) {
    return `${FEEDBACK_MARKER} STOP: Action Loop Detected (attempt ${attemptCount}/${effectiveCap})\n\nDo NOT re-run the same command hoping for a different result.`
  }

  if (attemptCount < effectiveCap - 1) {
    const missing = missingItems.length
      ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join('\n')}`
      : ''
    const nextActions = nextActionItems.length
      ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join('\n')}`
      : ''
    return `${FEEDBACK_MARKER} Task Incomplete (${severity})\n${feedbackStr}${missing}${nextActions}\n\nPlease address these issues and continue.`
  }

  const missingBrief = missingItems.length
    ? `Still missing: ${missingItems.slice(0, 3).join(', ')}.`
    : ''
  return `${FEEDBACK_MARKER} Final Attempt (${attemptCount}/${effectiveCap})\n\n${missingBrief}\n\nThis is your LAST chance.`
}
