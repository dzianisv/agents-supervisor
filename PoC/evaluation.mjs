/**
 * PoC/evaluation.mjs — Sandbox copy of core/evaluation.mjs with the task-type-aware
 * gate fix applied.  DO NOT import from ../core; this file is self-contained.
 *
 * Changes vs production (core/evaluation.mjs):
 *   1. inferTaskType — added hasNonCodeOutput guard so research+create tasks whose
 *      primary deliverable is a document/report/Notion page are classified as
 *      'research', not 'coding'.  Addresses false-positive PR/CI gates on non-code tasks.
 *   2. buildTaskContextMock — PoC-only helper (replaces buildTaskContextFromTranscript
 *      from bin/on-stop.mjs) that accepts explicit repoSignals so tests are deterministic
 *      without filesystem access.  Contains the same requiresPR/requiresCI logic so the
 *      fix propagates correctly.
 */

export const PLANNING_LOOP_MIN_TOOL_CALLS = 8
export const PLANNING_LOOP_WRITE_RATIO_THRESHOLD = 0.1
export const ACTION_LOOP_MIN_COMMANDS = 4
export const ACTION_LOOP_REPETITION_THRESHOLD = 0.6
export const SELF_ASSESSMENT_MARKER = '## Supervisor Self-Assessment'
export const FEEDBACK_MARKER = '## Supervisor:'

export const HUMAN_ONLY_ACTION_PATTERNS = [
  /\b(auth|authentication|oauth|2fa|mfa|captcha|otp|one[- ]time)\b/i,
  /\b(log ?in|sign ?in|verification code|passcode)\b/i,
  /\b(api key|secret|token|credential|access key|session cookie)\b/i,
  /\b(permission|consent|approve|approval|access request|request access|grant access|invite)\b/i,
  /\bupload\b/i
]

export const AGENT_ACTION_PATTERNS = [
  /\b(run|re-?run|execute|test|build|compile|lint|format|commit|push|merge|pr|ci|check)\b/i,
  /\b(gh|npm|node|python|bash|curl|script)\b/i,
  /\b(edit|write|update|fix|implement|add|remove|change|create|open|verify|capture|screenshot|record)\b/i
]

export function normalizeCommand(command) {
  return command.replace(/\s+/g, ' ').trim()
}

export function isHumanOnlyAction(item) {
  const text = item.trim()
  if (!text) return false
  const hasHuman = HUMAN_ONLY_ACTION_PATTERNS.some(pattern => pattern.test(text))
  const hasAgent = AGENT_ACTION_PATTERNS.some(pattern => pattern.test(text))
  return hasHuman && !hasAgent
}

export function splitActionItems(items) {
  const humanOnly = []
  const agentActionable = []
  for (const raw of items) {
    if (typeof raw !== 'string') continue
    const item = raw.trim()
    if (!item) continue
    if (isHumanOnlyAction(item)) humanOnly.push(item)
    else agentActionable.push(item)
  }
  return { humanOnly, agentActionable }
}

/**
 * Classify the task type from the combined human+agent text.
 *
 * FIX (vs production):  added `hasNonCodeOutput` guard in the
 * `hasResearch && hasCodingAction` branch.  A task whose primary deliverable
 * is a non-code artifact (report, Notion page, market analysis, etc.) should
 * NOT be classified as 'coding' just because the user said "create a report"
 * or "analyze the market" — those verbs appear in research tasks too.
 *
 * The guard applies only when there is no explicit GitHub issue reference
 * (which is an unambiguous indicator of a code task regardless of output type).
 */
export function inferTaskType(text) {
  const hasResearch = /research|investigate|analyze|compare|evaluate|study/i.test(text)
  const hasCodingAction = /\bfix\b|implement|add|create|build|feature|refactor|improve|update/i.test(text)
  const hasCodingSignal = /\bbug\b|\berror\b|\bregression\b/i.test(text)
  const hasGitHubIssue = /github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/i.test(text)

  // Non-code deliverable markers: when the primary output is a document,
  // report, Notion page, or similar non-code artifact, action words like
  // "create" or "analyze" do NOT indicate a CODE task.
  // Note: "market[\s-]+analysis" catches "market analysis" and "market-analysis".
  const hasNonCodeOutput = /\b(report|notion|spreadsheet|dashboard|slide\s*deck|wiki\s*page|blog\s*post|market[\s-]+analysis|write[\s-]+up)\b/i.test(text)

  if (hasResearch && (hasCodingAction || hasGitHubIssue)) {
    // GitHub issue reference is always a code task, regardless of output type.
    if (hasGitHubIssue) return 'coding'
    // If the deliverable is a non-code artifact, classify as research, not coding.
    // Without this guard the old code returned 'coding' for "analyze + create a report".
    if (hasNonCodeOutput) { /* fall through to research below */ }
    else return 'coding'
  }

  if (hasResearch) return 'research'
  if (/docs?|readme|documentation/i.test(text)) return 'docs'
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return 'ops'
  if (/\bgmail\b|\bemail\b|\bfilter\b|\binbox\b|\bcalendar\b|\blinkedin\b|\brecruiter\b|\bbrowser\b/i.test(text)) return 'ops'
  if (/\bclean\s*up\b|\borganize\b|\bconfigure\b|\bsetup\b|\bset\s*up\b|\binstall\b/i.test(text)) return 'ops'
  if (hasCodingAction || hasCodingSignal) return 'coding'
  return 'other'
}

export function detectSignals(humanText, commands) {
  const signals = []
  if (/test|tests|pytest|jest|unit|e2e|integration/i.test(humanText)) signals.push('test-mention')
  if (/build|compile|bundle|release/i.test(humanText)) signals.push('build-mention')
  if (/pull request|\bPR\b|merge request/i.test(humanText)) signals.push('pr-mention')
  if (/ci|checks|github actions/i.test(humanText)) signals.push('ci-mention')

  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+test\b|pytest\b|go\s+test\b|cargo\s+test\b/i.test(cmd))) {
    signals.push('test-command')
  }
  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+run\s+build\b|cargo\s+build\b|go\s+build\b/i.test(cmd))) {
    signals.push('build-command')
  }
  if (commands.some(cmd => /\bgh\s+pr\b/i.test(cmd))) signals.push('gh-pr')
  if (commands.some(cmd => /\bgh\s+pr\s+create\b/i.test(cmd))) signals.push('gh-pr-create')
  if (commands.some(cmd => /\bgh\s+pr\s+view\b/i.test(cmd))) signals.push('gh-pr-view')
  if (commands.some(cmd => /\bgh\s+pr\s+status\b/i.test(cmd))) signals.push('gh-pr-status')
  if (commands.some(cmd => /\bgh\s+pr\s+checks\b/i.test(cmd))) signals.push('gh-pr-checks')
  if (commands.some(cmd => /\bgit\s+push\b/i.test(cmd))) signals.push('git-push')
  if (commands.some(cmd => /\bgh\s+issue\b/i.test(cmd))) signals.push('gh-issue')
  return signals
}

/**
 * PoC-only replacement for buildTaskContextFromTranscript (production version is in
 * bin/on-stop.mjs lines 290-350).  Accepts explicit repoSignals to avoid filesystem reads.
 *
 * The requiresPR/requiresCI logic is IDENTICAL to production — the fix is solely in
 * inferTaskType above.  After the fix, a research task yields taskType='research', so
 * requiresPR and requiresCI evaluate to false without any additional changes here.
 *
 * @param {{
 *   humanText: string,
 *   agentText: string,
 *   commands?: string[],
 *   repoSignals?: { hasTestScript: boolean, hasBuildScript: boolean, hasTestsDir: boolean }
 * }} opts
 * @returns {object} taskContext compatible with evaluateSelfAssessment
 */
export function buildTaskContextMock(opts) {
  const humanText = opts.humanText || ''
  const agentText = opts.agentText || ''
  const commands = opts.commands || []
  const repoSignals = opts.repoSignals || { hasTestScript: false, hasBuildScript: false, hasTestsDir: false }

  const combinedText = `${humanText} ${agentText}`
  const taskType = inferTaskType(combinedText)
  const detectedSignals = detectSignals(combinedText, commands)

  // --- unchanged from production (on-stop.mjs lines 333-341) ---
  const requiresTests = taskType === 'coding' &&
    (repoSignals.hasTestScript || repoSignals.hasTestsDir || detectedSignals.includes('test-mention'))
  const requiresBuild = taskType === 'coding' &&
    (repoSignals.hasBuildScript || detectedSignals.includes('build-mention'))
  const requiresPR = taskType === 'coding'
  const requiresCI = taskType === 'coding'
  const requiresLocalTests = requiresTests
  const toolsSummary = commands.slice(-6).join('\n') || '(none)'
  // -------------------------------------------------------------

  return {
    taskSummary: humanText.slice(0, 200),
    taskType,
    agentMode: 'build',
    humanMessages: [humanText],
    toolsSummary,
    detectedSignals,
    recentCommands: commands.map(c => c.replace(/\s+/g, ' ').trim()),
    pushedToDefaultBranch: commands.some(cmd => /\bgit\s+push\b.*\b(main|master)\b/i.test(cmd)),
    requiresTests,
    requiresBuild,
    requiresPR,
    requiresCI,
    requiresLocalTests,
    requiresLocalTestsEvidence: requiresTests && !commands.some(cmd =>
      /\bnpm\s+test\b|\bpnpm\s+test\b|\byarn\s+test\b|\bpytest\b|\bgo\s+test\b/i.test(cmd))
  }
}

/**
 * Evaluate a self-assessment JSON against the task context.
 * Unchanged from core/evaluation.mjs — reproduced here verbatim so the PoC is standalone.
 *
 * @param {object} assessment
 * @param {object} context
 * @returns {object} SupervisorAnalysis
 */
export function evaluateSelfAssessment(assessment, context) {
  const safeContext = {
    taskSummary: context?.taskSummary || '',
    taskType: context?.taskType || 'other',
    agentMode: context?.agentMode || 'unknown',
    humanMessages: Array.isArray(context?.humanMessages) ? context.humanMessages : [],
    toolsSummary: context?.toolsSummary || '(none)',
    detectedSignals: Array.isArray(context?.detectedSignals) ? context.detectedSignals : [],
    recentCommands: Array.isArray(context?.recentCommands) ? context.recentCommands : [],
    pushedToDefaultBranch: !!context?.pushedToDefaultBranch,
    requiresTests: !!context?.requiresTests,
    requiresBuild: !!context?.requiresBuild,
    requiresPR: !!context?.requiresPR,
    requiresCI: !!context?.requiresCI,
    requiresLocalTests: !!context?.requiresLocalTests,
    requiresLocalTestsEvidence: !!context?.requiresLocalTestsEvidence
  }
  const missing = []
  const nextActions = []
  const remaining = assessment.remaining_work || []
  const needsUserAction = assessment.needs_user_action || []
  const status = assessment.status || 'in_progress'
  const confidence = assessment.confidence ?? 0.5
  const stuck = assessment.stuck === true

  const tests = assessment.evidence?.tests || {}
  const build = assessment.evidence?.build || {}
  const pr = assessment.evidence?.pr || {}
  const hasPrSignal = safeContext.detectedSignals.includes('gh-pr-create') || safeContext.detectedSignals.includes('gh-pr')
  const hasCiSignal = safeContext.detectedSignals.includes('gh-pr-checks') || safeContext.detectedSignals.includes('gh-pr-view') || safeContext.detectedSignals.includes('gh-pr-status')

  const addMissing = (item, action) => {
    if (!missing.includes(item)) missing.push(item)
    if (action && !nextActions.includes(action)) nextActions.push(action)
  }

  if (remaining.length) {
    for (const item of remaining) addMissing(item)
  }

  const { humanOnly: humanNeeds, agentActionable: agentNeeds } = splitActionItems(needsUserAction)
  if (agentNeeds.length) {
    for (const item of agentNeeds) {
      addMissing(item)
      if (!nextActions.includes(item)) nextActions.push(item)
    }
  }

  if (safeContext.requiresTests) {
    if (tests.ran !== true) {
      addMissing('Run tests', 'Run the full test suite and capture output')
    } else {
      if (tests.skipped === true || typeof tests.skip_reason === 'string') {
        addMissing('Do not skip required tests', 'Run required tests and document passing results')
      }
      if (tests.results !== 'pass') {
        addMissing('Fix failing tests', 'Fix failing tests and re-run')
      }
      if (tests.ran_after_changes !== true) {
        addMissing('Re-run tests after latest changes', 'Re-run tests after latest changes')
      }
    }
  }

  if (safeContext.requiresLocalTests) {
    const ranCommands = tests.commands || []
    if (ranCommands.length === 0) {
      addMissing('Provide local test commands', 'Run local tests and include commands in self-assessment')
    } else {
      const normalizedRecent = safeContext.recentCommands.map(normalizeCommand)
      const normalizedEvidence = ranCommands.map(normalizeCommand)
      const hasMatch = normalizedEvidence.some(cmd => normalizedRecent.includes(cmd))
      if (!hasMatch) {
        addMissing('Provide local test commands from this session', 'Run local tests in this session and include exact commands')
      }
    }
  }

  if (safeContext.requiresBuild) {
    if (build.ran !== true) {
      addMissing('Run build/compile', 'Run the build/compile step and confirm success')
    } else if (build.results !== 'pass') {
      addMissing('Fix build failures', 'Fix build errors and re-run')
    }
  }

  if (safeContext.requiresPR) {
    if (pr.created !== true) {
      addMissing('Create PR', 'Create a pull request with summary and checklist')
    } else if (safeContext.requiresCI) {
      if (!pr.url) {
        addMissing('Provide PR link', 'Include the PR URL in the self-assessment')
      }
      if (!hasPrSignal) {
        addMissing('Provide PR creation evidence', 'Create the PR using gh or include evidence of PR creation')
      }
      if (pr.checked !== true) {
        addMissing('Verify CI checks', 'Run `gh pr checks` or `gh pr view` and report results')
      } else if (pr.ci_status !== 'pass') {
        addMissing('Fix failing CI', 'Fix CI failures and re-run checks')
      }
      if (!hasCiSignal) {
        addMissing('Provide CI check evidence', 'Use `gh pr checks` or `gh pr view` and include results')
      }
    }
  }

  if (safeContext.pushedToDefaultBranch) {
    addMissing('Avoid direct push to default branch', 'Revert direct push and open a PR instead')
  }

  if (stuck) {
    addMissing('Rethink approach', 'Propose an alternate approach and continue')
  }

  const humanOnlyNextSteps = (assessment.next_steps || []).filter(item => isHumanOnlyAction(item))
  const requiresHumanAction = humanNeeds.length > 0 || humanOnlyNextSteps.length > 0 || missing.some(isHumanOnlyAction) || nextActions.some(isHumanOnlyAction)
  const complete = status === 'complete' && missing.length === 0 && confidence >= 0.8 && !requiresHumanAction

  let severity = 'NONE'
  const severityItems = missing.length > 0 ? missing : nextActions
  if (severityItems.some(item => /test|build/i.test(item))) severity = 'HIGH'
  else if (severityItems.some(item => /CI|check/i.test(item))) severity = 'MEDIUM'
  else if (severityItems.length > 0) severity = 'LOW'

  if (requiresHumanAction && missing.length === 0 && nextActions.length === 0) severity = 'LOW'

  if (assessment.next_steps?.length) {
    for (const step of assessment.next_steps) {
      if (!nextActions.includes(step)) nextActions.push(step)
    }
  }

  const actionableMissing = missing.filter(item => !isHumanOnlyAction(item))
  const finalActionableNextActions = nextActions.filter(item => !isHumanOnlyAction(item))
  const finalShouldContinue = actionableMissing.length > 0 || finalActionableNextActions.length > 0
  const finalReason = complete
    ? 'Self-assessment confirms completion with required evidence'
    : requiresHumanAction && !finalShouldContinue
      ? 'User action required before continuing'
      : missing.length || finalActionableNextActions.length
        ? 'Missing required workflow steps'
        : 'Task not confirmed complete'

  return {
    complete,
    shouldContinue: finalShouldContinue,
    reason: finalReason,
    missing,
    nextActions,
    requiresHumanAction,
    severity
  }
}
