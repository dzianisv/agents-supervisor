import { FEEDBACK_MARKER } from './evaluation.mjs'
import { DEFAULT_MAX_ATTEMPTS } from './goal.mjs'

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

  if (attemptCount < effectiveCap - 1) {
    const missing = missingItems.length
      ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join('\n')}`
      : ''
    const nextActions = nextActionItems.length
      ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join('\n')}`
      : ''
    return `${FEEDBACK_MARKER} Task Incomplete (${severity})
${feedbackStr}
${missing}
${nextActions}

Please address these issues and continue.`
  }

  const missingBrief = missingItems.length
    ? `Still missing: ${missingItems.slice(0, 3).join(', ')}.`
    : ''
  return `${FEEDBACK_MARKER} Final Attempt (${attemptCount}/${effectiveCap})

${missingBrief}

You have been asked ${attemptCount} times to complete this task. This is your LAST chance before supervisor stops.

If you cannot complete the remaining items:
- Explain clearly what is blocking you
- Set needs_user_action if you need user help
- Try a different approach instead of repeating the same steps

Do NOT re-read files or re-plan. Either implement the fix now or explain why you cannot.`
}
