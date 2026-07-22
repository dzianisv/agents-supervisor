import { DEFAULT_MAX_ATTEMPTS } from './goal.mjs'
import { loadShipped } from './patterns.mjs'

/**
 * Pull the "background subagents/tasks still in flight" exemption straight from
 * core/patterns.json — the same rule (antipattern `passive_watch_locally_pollable`)
 * and few-shots (K, M) already consumed by core/judge-core.mjs and
 * core/feedback-core.mjs — so the Claude Code Stop hook (bin/supervisor-on-stop.mjs) stops
 * flagging in-flight subagent dispatches as premature stops. Without this, a
 * legitimate pause to wait on background subagents gets blocked because the
 * hand-written DEFAULT_RUBRIC below has no equivalent rule.
 * @param {object} [patterns] defaults to the shipped core/patterns.json
 * @returns {string} a rubric-formatted bullet, or '' if the rule is unavailable
 */
export function buildSubagentExemptionRule(patterns) {
  const p = patterns ?? loadShipped()
  const rule = (p?.antipatterns ?? []).find((a) => a.name === 'passive_watch_locally_pollable')?.rule
  if (!rule) return ''
  const subagentShots = (p?.few_shots ?? []).filter((ex) => /subagent/i.test(ex?.note ?? ''))
  const examplesLine = subagentShots.length
    ? ` Examples: ${subagentShots.map((ex) => `"${ex.final}" -> ${ex.output?.category}`).join(' | ')}`
    : ''
  return `- BACKGROUND SUBAGENTS/TASKS STILL RUNNING (do NOT flag as premature; sourced from core/patterns.json): ${rule}${examplesLine}`
}

// Fallback only — canonical source is .agents/supervisor/Patterns.md; keep in sync.
const STATIC_RUBRIC = `## Patterns
- HEURISTICS, NOT REQUIREMENTS: the "Required checks"/detected-signals list in Task Context and the rules below are heuristics that inform your judgment — they never override what the transcript actually shows the user asked for or agreed to.
- DECLINED WORK ISN'T REMAINING WORK: if the user explicitly declined an action or said the task is fine as-is ("no", "don't bother", "skip that", "that's fine", "not now"), do not list that action in remaining_work, next_steps, or needs_user_action.
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- Tests cannot be skipped or marked as flaky/not important.
- Direct pushes to main/master are not allowed; require a PR instead.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials, access requests, uploads, approvals), list it in needs_user_action.
- PLANNING LOOP CHECK: If the task requires code changes (fix, implement, add, create, build, refactor, update) but the tool commands show ONLY read operations (read, glob, grep, git log, git status, git diff, webfetch, task/explore) and NO write operations (edit, write, bash with build/test/commit, github_create_pull_request, etc.), then the task is NOT complete. Set status to "in_progress", set stuck to true, and list "Implement the actual code changes" in remaining_work. Analyzing and recommending changes is not the same as making them.
- If you are repeating the same actions (deploy, test, build) without making progress, set "stuck": true.
- Do not retry the same failing approach more than twice — try something different or report stuck.

## Antipatterns
PREMATURE-STOP ANTIPATTERNS (mined from 284 real agent stops where the user replied; 78% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). If the agent's last response matches one of these AND executable work remains, the task is NOT complete — set status "in_progress", and put the concrete next action in remaining_work and next_steps:
- PERMISSION-SEEKING (most common, ~40%): the response ends by asking to do work it can already do — "Want me to...?", "Would you like me to...?", "Should I...?", "Shall I proceed?", or "Try running it now"/"Please run X and confirm" (deferring a check it could run itself). DECISIVE TEST: if the final turn is a yes/no or "want me to X?" question AND X is something the agent can do with its own tools AND X carries no irreversible risk, the stop is premature — it should have just done X. Asking is only legitimate before a destructive/irreversible action (delete prod data, force-push, send an irreversible external message).
- STOPPED-WITH-TODOS (~30%): the response lists "Remaining Tasks"/"Next steps"/"Still TODO"/"What I did NOT do"/"Outstanding Work" or names a verify/run/check/create-PR step as "next" — then stops without doing it. FIRST-OCCURRENCE IS SUFFICIENT: do NOT wait for a second signal; 98% of these are premature. TERMINAL-POSITION TEST: the list appears in the LAST ~40% of the response with NO subsequent tool calls or execution. A mid-response progress report followed by actual execution is complete, not drift. Set status "in_progress" with that work in remaining_work.
- VERIFICATION-DEFERRAL: agent wrote/edited code (write/edit tool calls in tool commands) but the response ends without running tests, build, or lint — and the task requires verification. Run verification before stopping. Set status "in_progress" with "run tests/build" in remaining_work.
- FALSE-COMPLETE: claims "done"/"complete"/"ready"/"all tasks complete" but the CORE requested action never happened, a required check was skipped, or there is no evidence. An empty/no-text response, or a response with no write/tool evidence on an action task, is NEVER complete. For an "add a feature/system" task, writing files is necessary but NOT sufficient — the new code must be WIRED IN (imported/registered/routed, not orphaned modules) AND verified (test/build/run); "ready to use" with no integration is incomplete (status "in_progress").
- LEGITIMATE STOP (do NOT flag): genuine human-only block (OAuth consent, 2FA code, credential/API-key retrieval, captcha) -> status "waiting_for_user" with the item in needs_user_action. Genuine completion WITH evidence (commands+output, tests passing, PR/CI verified) -> status "complete"; do not invent missing work.
- TRAILING QUESTION (do NOT flag as in_progress): if the agent's final message asks the user a question or presents options ("Want me to...?", "Should I...?", "Which approach do you prefer?"), the correct status is "waiting_for_user", not "in_progress" — an open question is not remaining work to push through.
- SEVERITY/STUCK: a single recoverable technical snag mid-task (knows the fix) is not "stuck". But a policy/process violation — pushing to main when a PR was required, skipping mandated tests — is a real failure: status "in_progress" with the corrective action in remaining_work, never "complete".`

function buildDefaultRubric() {
  let addendum = ''
  try {
    addendum = buildSubagentExemptionRule()
  } catch {
    /* core/patterns.json unavailable — fall back to the static rubric only */
  }
  return addendum ? `${STATIC_RUBRIC}\n${addendum}` : STATIC_RUBRIC
}

export const DEFAULT_RUBRIC = buildDefaultRubric()

/**
 * @typedef {{ patterns: string, antipatterns: string }} Rubric
 */

/**
 * @param {string} md
 * @returns {Rubric}
 */
export function parseRubric(md) {
  const section = (name) => {
    const re = new RegExp(`##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i')
    return (md.match(re)?.[1] ?? '').trim()
  }
  return { patterns: section('Patterns'), antipatterns: section('Antipatterns') }
}

function buildToolSupervisorGuidanceSection(toolSupervisorPrompt) {
  if (!toolSupervisorPrompt) return ''
  return `\n## Tool Supervisor Guidance\n${toolSupervisorPrompt.slice(0, 4000)}\n`
}

export function buildSelfAssessmentPrompt(
  context,
  agents,
  lastAssistantText,
  attemptCount,
  rubric,
  maxAttempts
) {
  const safeContext = {
    ...context,
    detectedSignals: Array.isArray(context.detectedSignals) ? context.detectedSignals : []
  }
  const requirements = []
  if (safeContext.requiresTests) requirements.push('Tests required (run after latest changes)')
  if (safeContext.requiresBuild) requirements.push('Build/compile required')
  if (safeContext.requiresPR) requirements.push('PR required (include link)')
  if (safeContext.requiresCI) requirements.push('CI checks required (verify status)')
  if (safeContext.requiresLocalTests) requirements.push('Local tests required (must run in this session)')
  if (safeContext.pushedToDefaultBranch) requirements.push('Detected direct push to default branch (must be avoided)')
  if (requirements.length === 0) requirements.push('No explicit workflow gates detected')

  const signalSummary = safeContext.detectedSignals.length ? safeContext.detectedSignals.join(', ') : 'none'

  const assistantSection = lastAssistantText
    ? `\n## Agent's Last Response\n${lastAssistantText.slice(0, 4000)}\n`
    : ''

  const rb = rubric ?? parseRubric(DEFAULT_RUBRIC)
  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const currentAttempt = attemptCount || 0
  const attemptSection = currentAttempt > 0
    ? `\n## Supervisor History\n- This is supervisor attempt ${currentAttempt + 1}/${effectiveCap} for this task.\n- Previous supervisors found the task incomplete.\n- If you are repeating the same actions without progress, set "stuck": true and explain what is blocking you.\n`
    : ''
  return `SELF-ASSESS SUPERVISOR

You are evaluating an agent's work against workflow requirements.
Analyze the task context, the agent's last response, and the tool signals to determine whether the task is complete.

## Task Context
- Summary: ${safeContext.taskSummary}
- Type: ${safeContext.taskType}
- Mode: ${safeContext.agentMode}
- Heuristic signals (repo checks; informative, not binding): ${requirements.join('; ')}
- Detected signals: ${signalSummary}
${safeContext.toolActivityNote ? `- ${safeContext.toolActivityNote}\n` : ''}
## Tool Commands Run
${safeContext.toolsSummary}
${assistantSection}${attemptSection}
${agents ? `## Project Instructions\n${agents.slice(0, 800)}\n\n` : ''}Return JSON only:
{
  "task_summary": "brief description of what was done",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.95,
  "evidence": {
    "tests": {
      "ran": true,
      "results": "pass|fail|unknown",
      "ran_after_changes": true,
      "commands": ["npm test", "pytest"]
    },
    "build": {
      "ran": true,
      "results": "pass|fail|unknown"
    },
    "pr": {
      "created": true,
      "url": "https://github.com/...",
      "ci_status": "pass|fail|unknown",
      "checked": true
    }
  },
  "remaining_work": ["list any incomplete items"],
  "next_steps": ["list next actions needed"],
  "needs_user_action": ["list any actions requiring user input"],
  "stuck": false,
  "alternate_approach": "describe if needed"
}

Rules:
${rb.patterns}

${rb.antipatterns}`
}

export function buildJudgePrompt(
  context,
  selfAssessment,
  toolSupervisorPrompt,
  rubric
) {
  const rb = rubric ?? parseRubric(DEFAULT_RUBRIC)
  return `ANALYZE SUPERVISOR

You are validating an agent's self-assessment against workflow requirements.

## Task Summary
${context.taskSummary}

## Task Type
${context.taskType}

## Workflow Requirements
- Tests required: ${context.requiresTests}
- Build required: ${context.requiresBuild}
- PR required: ${context.requiresPR}
- CI checks required: ${context.requiresCI}
- Local test commands required: ${context.requiresLocalTests}

## Tool Signals
${context.toolsSummary}

## Agent Self-Assessment
${selfAssessment.slice(0, 4000)}
${buildToolSupervisorGuidanceSection(toolSupervisorPrompt || null)}

Rules:
${rb.patterns}

${rb.antipatterns}

Return JSON only:
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation",
  "missing": ["missing steps"],
  "next_actions": ["actions to take"],
  "requires_human_action": true/false
}`
}

export function parseSelfAssessmentJson(text) {
  if (typeof text !== 'string') return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return null
  }
}
