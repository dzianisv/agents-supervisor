/**
 * Pure evaluation helpers shared by supervisor runtimes.
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

/**
 * @typedef {'coding' | 'docs' | 'research' | 'ops' | 'other'} TaskType
 * @typedef {'plan' | 'build' | 'unknown'} AgentMode
 * @typedef {{
 *   requiresTests: boolean,
 *   requiresBuild: boolean,
 *   requiresPR: boolean,
 *   requiresCI: boolean,
 *   requiresLocalTests: boolean,
 *   requiresLocalTestsEvidence: boolean,
 *   taskSummary: string,
 *   taskType: TaskType,
 *   agentMode: AgentMode,
 *   humanMessages: string[],
 *   toolsSummary: string,
 *   detectedSignals: string[],
 *   recentCommands: string[],
 *   pushedToDefaultBranch: boolean,
 *   toolActivityNote?: string
 * }} TaskContext
 * @typedef {{
 *   task_summary?: string,
 *   task_type?: string,
 *   status?: 'complete' | 'in_progress' | 'blocked' | 'stuck' | 'waiting_for_user',
 *   confidence?: number,
 *   evidence?: {
 *     tests?: {
 *       ran?: boolean,
 *       results?: 'pass' | 'fail' | 'unknown',
 *       ran_after_changes?: boolean,
 *       commands?: string[],
 *       skipped?: boolean,
 *       skip_reason?: string
 *     },
 *     build?: {
 *       ran?: boolean,
 *       results?: 'pass' | 'fail' | 'unknown'
 *     },
 *     pr?: {
 *       created?: boolean,
 *       url?: string,
 *       ci_status?: 'pass' | 'fail' | 'unknown',
 *       checked?: boolean
 *     }
 *   },
 *   remaining_work?: string[],
 *   next_steps?: string[],
 *   needs_user_action?: string[],
 *   stuck?: boolean,
 *   alternate_approach?: string
 * }} SelfAssessment
 * @typedef {{
 *   complete: boolean,
 *   shouldContinue: boolean,
 *   reason: string,
 *   missing: string[],
 *   nextActions: string[],
 *   requiresHumanAction: boolean,
 *   severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKER'
 * }} SupervisorAnalysis
 */

/**
 * @param {any[]} messages
 * @returns {{ detected: boolean, readCount: number, writeCount: number, totalTools: number }}
 */
export function detectPlanningLoop(messages) {
  if (!Array.isArray(messages)) {
    return { detected: false, readCount: 0, writeCount: 0, totalTools: 0 }
  }
  let readCount = 0
  let writeCount = 0
  let totalTools = 0

  for (const msg of messages) {
    if (msg.info?.role !== 'assistant') continue
    for (const part of msg.parts || []) {
      if (part.type !== 'tool') continue
      totalTools++

      const toolName = (part.tool || '').toString().toLowerCase()
      const input = part.state?.input || {}

      if (['edit', 'write', 'apply_patch', 'github_create_or_update_file', 'github_push_files', 'github_delete_file', 'github_create_pull_request', 'github_update_pull_request'].includes(toolName)) {
        writeCount++
        continue
      }

      if (toolName === 'bash') {
        const cmd = (input.command || input.cmd || '').toString()
        if (/^\s*(npm|yarn|pnpm)\s+(run\s+)?(build|test|lint|fmt|format)\b/i.test(cmd) || /^\s*git\s+(add|commit|push|checkout|switch|merge|rebase)\b/i.test(cmd) || /^\s*(mkdir|rm|mv|cp)\b/i.test(cmd)) {
          writeCount++
        } else if (/^\s*git\s+(status|log|diff|show|branch|remote|tag)\b/i.test(cmd) || /^\s*(ls|cat|head|tail|find|grep|rg|wc|file)\b/i.test(cmd)) {
          readCount++
        }
        continue
      }

      if (['read', 'glob', 'grep', 'todowrite', 'task', 'webfetch', 'knowledge-graph_search', 'knowledge-graph_read', 'knowledge-graph_open'].some((name) => toolName.startsWith(name)) || toolName.startsWith('context7_')) {
        readCount++
      }
    }
  }

  const detected =
    totalTools >= PLANNING_LOOP_MIN_TOOL_CALLS &&
    (writeCount === 0 || writeCount / totalTools < PLANNING_LOOP_WRITE_RATIO_THRESHOLD)

  return { detected, readCount, writeCount, totalTools }
}

export function shouldApplyPlanningLoop(taskType, loopDetected) {
  if (!loopDetected) return false
  return taskType === 'coding'
}

/**
 * Neutral, factual description of recent tool-call activity — NEVER a
 * judgment or a verdict. This exists solely so autopilot's static nudge (and
 * the judge prompt, as non-binding evidence) can be enriched with bounded,
 * factual context such as "recent activity has been read-heavy" without
 * either surface deciding on its own that a "loop" occurred or forcing a
 * specific action. Deciding what (if anything) that activity MEANS is left
 * entirely to the judge LLM in reflection mode, or to the agent itself in
 * autopilot mode — this function only describes counts.
 * @param {{ readCount?: number, writeCount?: number, totalTools?: number }} stats
 * @returns {string} '' when there is nothing to report
 */
export function describeToolActivity(stats) {
  const readCount = stats?.readCount ?? 0
  const writeCount = stats?.writeCount ?? 0
  const totalTools = stats?.totalTools ?? 0
  if (totalTools === 0) return ''
  return `Recent tool activity (informational only, not a verdict): ${totalTools} tool call${totalTools === 1 ? '' : 's'} — ${writeCount} write-type, ${readCount} read-only.`
}

/**
 * @param {any[]} messages
 * @returns {{ detected: boolean, repeatedCommands: string[], totalCommands: number }}
 */
export function detectActionLoop(messages) {
  if (!Array.isArray(messages)) {
    return { detected: false, repeatedCommands: [], totalCommands: 0 }
  }

  const commands = []
  for (const msg of messages) {
    if (msg.info?.role !== 'assistant') continue
    for (const part of msg.parts || []) {
      if (part.type !== 'tool') continue
      const toolName = (part.tool || '').toString().toLowerCase()
      const input = part.state?.input || {}

      if (toolName === 'bash') {
        const cmd = (input.command || input.cmd || '').toString().trim()
        if (cmd) {
          const normalized = cmd.replace(/\s+/g, ' ').replace(/\d{10,}/g, 'TIMESTAMP').toLowerCase()
          commands.push(normalized)
        }
      } else if (toolName !== 'read' && toolName !== 'glob' && toolName !== 'grep' && toolName !== 'todowrite') {
        const key = `${toolName}:${JSON.stringify(input).slice(0, 100)}`
        commands.push(key)
      }
    }
  }

  if (commands.length < ACTION_LOOP_MIN_COMMANDS) {
    return { detected: false, repeatedCommands: [], totalCommands: commands.length }
  }

  const counts = new Map()
  for (const cmd of commands) {
    counts.set(cmd, (counts.get(cmd) || 0) + 1)
  }

  const repeatedCommands = []
  let repeatedCount = 0
  for (const [cmd, count] of counts) {
    if (count >= 3) {
      repeatedCommands.push(cmd)
      repeatedCount += count
    }
  }

  const detected = repeatedCommands.length > 0 && repeatedCount / commands.length >= ACTION_LOOP_REPETITION_THRESHOLD

  return { detected, repeatedCommands, totalCommands: commands.length }
}

export function inferTaskType(text) {
  const hasResearch = /research|investigate|analyze|compare|evaluate|study/i.test(text)
  const hasCodingAction = /\bfix\b|implement|add|create|build|feature|refactor|improve|update/i.test(text)
  const hasCodingSignal = /\bbug\b|\berror\b|\bregression\b/i.test(text)
  const hasGitHubIssue = /github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/i.test(text)

  if (hasResearch && (hasCodingAction || hasGitHubIssue)) return 'coding'

  if (hasResearch) return 'research'
  if (/docs?|readme|documentation/i.test(text)) return 'docs'
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return 'ops'
  if (/\bgmail\b|\bemail\b|\bfilter\b|\binbox\b|\bcalendar\b|\blinkedin\b|\brecruiter\b|\bbrowser\b/i.test(text)) return 'ops'
  if (/\bclean\s*up\b|\borganize\b|\bconfigure\b|\bsetup\b|\bset\s*up\b|\binstall\b/i.test(text)) return 'ops'
  if (hasCodingAction || hasCodingSignal) return 'coding'
  return 'other'
}

export function extractToolCommands(messages) {
  const commands = []
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type !== 'tool') continue
      const toolName = (part.tool || '').toString().toLowerCase()
      const input = part.state?.input || {}

      if (toolName === 'bash') {
        const command = input.command
        if (typeof command === 'string' && command.trim()) {
          commands.push(command)
        }
      } else if (toolName === 'edit' || toolName === 'write') {
        // hasCodeChangeEvidence() below keys off this "edited "/"wrote " prefix to
        // distinguish tasks with real file edits from tasks merely classified 'coding'.
        const filePath = input.file_path || input.filePath || ''
        const verb = toolName === 'edit' ? 'edited' : 'wrote'
        commands.push(`${verb} ${filePath}`.trim())
      } else if (toolName === 'task' || toolName === 'agent') {
        // Subagent dispatch (Claude Code's Task tool / opencode's task tool). Without
        // this, the judge sees zero evidence that background subagents were launched
        // and flags an in-progress fan-out as a premature stop.
        const description = input.description
        const prompt = input.prompt
        const summary = (typeof description === 'string' && description.trim())
          ? description.trim()
          : (typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 150) : '')
        if (summary) {
          commands.push(`Task: ${summary}`)
        }
      }
    }
  }
  return commands
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
  if (commands.some(cmd => /\bgh\s+issue\b/i.test(cmd))) signals.push('gh-issue')
  if (commands.some(cmd => /\bgh\s+pr\s+create\b/i.test(cmd))) signals.push('gh-pr-create')
  if (commands.some(cmd => /\bgh\s+pr\s+view\b/i.test(cmd))) signals.push('gh-pr-view')
  if (commands.some(cmd => /\bgh\s+pr\s+status\b/i.test(cmd))) signals.push('gh-pr-status')
  if (commands.some(cmd => /\bgh\s+pr\s+checks\b/i.test(cmd))) signals.push('gh-pr-checks')
  if (commands.some(cmd => /\bgit\s+push\b/i.test(cmd))) signals.push('git-push')
  return signals
}

export function normalizeCommand(command) {
  return command.replace(/\s+/g, ' ').trim()
}

export function getRecentCommands(commands, limit = 20) {
  return commands.map(normalizeCommand).slice(-limit)
}

export function hasLocalTestCommand(commands) {
  return commands.some(cmd =>
    /\bnpm\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+typecheck\b/i.test(cmd) ||
    /\bpnpm\s+test\b/i.test(cmd) ||
    /\byarn\s+test\b/i.test(cmd) ||
    /\bpytest\b/i.test(cmd) ||
    /\bgo\s+test\b/i.test(cmd) ||
    /\bcargo\s+test\b/i.test(cmd)
  )
}

/**
 * Whether the tool commands include evidence of an actual source-code change
 * (Edit/Write tool calls, formatted by extractToolCommands as "edited "/"wrote ").
 * Used to avoid demanding a PR/CI check for tasks classified as "coding" purely
 * because the request used a verb like "create" (e.g. "create GitHub epic issues"),
 * when no file was actually touched.
 */
export function hasCodeChangeEvidence(commands) {
  return commands.some(cmd => /^(edited|wrote)\s/i.test(cmd))
}

export function pushedToDefaultBranch(commands) {
  return commands.some(cmd =>
    /\bgit\s+push\b.*\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\borigin\b\s+\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\bHEAD:(main|master)\b/i.test(cmd)
  )
}

export function isPlanMode(messages) {
  if (!Array.isArray(messages)) return false
  const hasSystemPlanMode = messages.some((m) =>
    (m.info?.role === 'system' || m.info?.role === 'developer') &&
    m.parts?.some((p) =>
      p.type === 'text' &&
      p.text &&
      (p.text.includes('Plan Mode') ||
        p.text.includes('plan mode ACTIVE') ||
        p.text.includes('plan mode is active') ||
        p.text.includes('read-only mode') ||
        p.text.includes('READ-ONLY phase'))
    )
  )
  if (hasSystemPlanMode) return true

  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === 'text' && part.text) {
        const text = part.text
        if (
          text.includes('<system-reminder>') &&
          (/plan mode/i.test(text) || /READ-ONLY phase/i.test(text))
        ) {
          return true
        }
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === 'user') {
      let isSupervisor = false
      const texts = []
      for (const part of msg.parts || []) {
        if (part.type === 'text' && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER)) {
            isSupervisor = true
            break
          }
          texts.push(part.text)
        }
      }
      if (!isSupervisor && texts.length > 0) {
        for (const text of texts) {
          if (/plan mode/i.test(text)) return true
          if (/\b(create|make|draft|generate|propose|write|update)\b.{1,30}\bplan\b/i.test(text)) return true
          if (/^plan\b/i.test(text.trim())) return true
        }
        return false
      }
    }
  }
  return false
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
 * @param {SelfAssessment} assessment
 * @param {TaskContext} context
 * @returns {SupervisorAnalysis}
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
  const requiresHumanActionSignal = humanNeeds.length > 0 || humanOnlyNextSteps.length > 0 || missing.some(isHumanOnlyAction) || nextActions.some(isHumanOnlyAction)

  let severity = 'NONE'
  const severityItems = missing.length > 0 ? missing : nextActions
  if (severityItems.some(item => /test|build/i.test(item))) severity = 'HIGH'
  else if (severityItems.some(item => /CI|check/i.test(item))) severity = 'MEDIUM'
  else if (severityItems.length > 0) severity = 'LOW'

  if (requiresHumanActionSignal && missing.length === 0 && nextActions.length === 0) severity = 'LOW'

  if (assessment.next_steps?.length) {
    for (const step of assessment.next_steps) {
      if (!nextActions.includes(step)) nextActions.push(step)
    }
  }

  const actionableMissing = missing.filter(item => !isHumanOnlyAction(item))
  const actionableNextActions = nextActions.filter(item => !isHumanOnlyAction(item))

  // --- The judge's reported status decides; deterministic repo-signal gates
  // (requires* above) only INFORM the outcome by populating missing/nextActions
  // for visibility — they must never override a judge verdict of
  // waiting_for_user, nor flip a confident complete back to "continue". Only
  // in_progress/blocked/stuck (or low-confidence complete) may produce
  // shouldContinue=true, and only when a concrete actionable item remains.

  // 1. waiting_for_user: NEVER continue. No exceptions — a judge that
  //    explicitly says it is blocked on the user wins unconditionally, even
  //    if isHumanOnlyAction's keyword heuristic would suggest otherwise.
  if (status === 'waiting_for_user') {
    return {
      complete: false,
      shouldContinue: false,
      reason: needsUserAction[0] || humanOnlyNextSteps[0] || 'Waiting for user input before continuing',
      missing,
      nextActions,
      requiresHumanAction: true,
      severity: 'NONE'
    }
  }

  // 2. complete at reasonable confidence: trust the judge. Unmet requires*
  //    gates are surfaced as an informational note only — they cannot flip
  //    the decision back to "continue".
  if (status === 'complete' && confidence >= 0.6) {
    const unmetNote = actionableMissing.length
      ? ` (heuristic note: ${actionableMissing.slice(0, 3).join('; ')} — not detected, but judge confirmed completion)`
      : ''
    return {
      complete: true,
      shouldContinue: false,
      reason: `Self-assessment confirms completion${unmetNote}`,
      missing,
      nextActions,
      requiresHumanAction: false,
      severity: 'NONE'
    }
  }

  // 3. Everything else (in_progress / blocked / stuck / low-confidence
  //    "complete" / unrecognized status).
  const finalShouldContinue = actionableMissing.length > 0 || actionableNextActions.length > 0

  if (!finalShouldContinue) {
    if (requiresHumanActionSignal) {
      return {
        complete: false,
        shouldContinue: false,
        reason: humanNeeds[0] || humanOnlyNextSteps[0] || 'User action required before continuing',
        missing,
        nextActions,
        requiresHumanAction: true,
        severity: 'LOW'
      }
    }
    return {
      complete: false,
      shouldContinue: false,
      reason: status === 'complete'
        ? 'Completion claimed at low confidence — not confirmed'
        : 'Task not confirmed complete',
      missing,
      nextActions,
      requiresHumanAction: false,
      severity
    }
  }

  // Specific — never the generic "Missing required workflow steps": name the
  // actual unmet item (from remaining_work/next_steps, or a deterministic
  // gate) so it is clear exactly what is outstanding.
  //
  // requiresHumanAction reflects the raw human-only signal independently of
  // shouldContinue (matching the pre-Fix-A contract): a mixed case — some
  // actionable work AND a human-only item both present — still reports
  // requiresHumanAction:true here. Callers (bin/supervisor-on-stop.mjs's
  // `!analysis.requiresHumanAction` inject-gate; opencode's
  // `requiresHumanAction && !shouldContinue` early-return) combine the two
  // flags themselves; only a "pure" human block (no actionable work at all,
  // handled above) short-circuits shouldContinue to false.
  return {
    complete: false,
    shouldContinue: true,
    reason: actionableMissing[0] || actionableNextActions[0],
    missing,
    nextActions,
    requiresHumanAction: requiresHumanActionSignal,
    severity
  }
}
