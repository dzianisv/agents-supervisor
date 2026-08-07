/**
 * reflection-prompt.mjs — shared reflection-prompt construction for BOTH
 * runtimes (Claude Code's Stop hook and OpenCode's session.idle plugin).
 *
 * Reads the project's .agents/supervisor/{SystemPrompt,Patterns,User,Goal}.md
 * files (falling back to the plugin's own shipped defaults when a project
 * hasn't customized them), interpolates the template, and returns the final
 * prompt string. Falls back to buildSelfAssessmentPrompt when no
 * SystemPrompt.md is found anywhere, so callers work without the file
 * structure on disk.
 *
 * Also loads a `.supervisor/rubric.md` project override (or the
 * `~/.config/agents-supervisor/rubric.md` global one) via
 * core/rubric-loader.mjs, which — when present — REPLACES Patterns.md
 * wholesale (never merges), matching opencode's loadRubric() semantics. This
 * is what wires the project rubric into BOTH runtimes' Stop/idle hooks, since
 * both call buildReflectionPrompt with the project directory.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractGoalCondition, buildGoalRequirementSection, DEFAULT_MAX_ATTEMPTS } from './goal.mjs'
import { DEFAULT_RUBRIC, parseRubric, buildSelfAssessmentPrompt } from './assessment.mjs'
import { loadParsedRubric, formatRubricMarkdown } from './rubric-loader.mjs'
import { PROMPT_TEXT_LIMIT, truncateForPrompt, formatConversationTurns } from './task-context.mjs'

/**
 * Interpolate a simple mustache-like template:
 * - {{variable}} → replaced with value
 * - {{#section}}...{{/section}} → included only if variable is truthy
 * @param {string} template
 * @param {Record<string, string|undefined>} vars
 * @returns {string}
 */
export function interpolateTemplate(template, vars) {
  // Handle conditional sections: {{#key}}...{{/key}}
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key, content) => {
      const value = vars[key]
      if (!value) return ''
      // Within the section, also interpolate variables
      return content.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? '')
    }
  )
  // Handle remaining simple variables
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? '')
  return result
}

// Legacy/mixed-case compatibility: this repo's established, tested
// convention is the capitalized filenames (SystemPrompt.md, Patterns.md,
// User.md, Goal.md — see test/reflection.test.mjs) and that remains the
// primary, preferred lookup. Some projects/tooling may instead write
// all-lowercase filenames (e.g. an auto-derived goal.md — see
// core/goal.mjs's writeDerivedProjectGoal). This alias map is purely
// ADDITIVE: the capitalized name is always tried first, at both the project
// and defaults location, before any alias is considered.
const FILENAME_ALIASES = {
  'SystemPrompt.md': 'system.md',
  'Patterns.md': 'patterns.md',
  'User.md': 'user.md',
  'Goal.md': 'goal.md',
}

// Files that describe HOW to judge (SystemPrompt/Patterns/User) are generic
// and may come from the plugin's shipped defaults. Goal.md describes WHAT a
// specific project must achieve — it is user intent, scoped to one project,
// and must NEVER be inherited from anywhere but the project itself.
//
// INCIDENT 2026-07-27: `defaultsDir` is the plugin's OWN
// .agents/supervisor (opencode/supervisor-impl.ts sets it relative to the
// plugin file). `opencode serve` was running from the plugin's repo, whose
// Goal.md held an OpenClawBot production-readiness checklist. Every session
// on that server — including one working in KineticAiCoach, which has no
// Goal.md at all — got that checklist injected as a "MANDATORY GOAL",
// causing cross-project scope creep and a 14-session fan-out that wedged the
// server. Do not re-add Goal.md to the defaults fallback. A "scope guard"
// paragraph inside Goal.md is prose the judge may ignore; this is the fix.
const PROJECT_ONLY_FILENAMES = new Set(['Goal.md'])

/**
 * Try `<directory>/.agents/supervisor/<filename>` first, falling back to
 * `<defaultsDir>/<filename>` (the plugin's shipped defaults). If the primary
 * (typically capitalized) filename isn't found at either location, also
 * tries its lower-case/legacy alias (see FILENAME_ALIASES) at both
 * locations before giving up. Returns null if nothing is found anywhere.
 *
 * Exception: filenames in PROJECT_ONLY_FILENAMES are read from `directory`
 * only — they never fall back to `defaultsDir`.
 * @param {string} directory
 * @param {string} defaultsDir
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function readSupervisorFile(directory, defaultsDir, filename) {
  const candidates = [filename, FILENAME_ALIASES[filename]].filter(Boolean)
  for (const name of candidates) {
    const projectPath = join(directory, '.agents', 'supervisor', name)
    try {
      return await readFile(projectPath, 'utf-8')
    } catch (e) {
      if (e.code !== 'ENOENT') return null
    }
  }
  if (!defaultsDir) return null
  if (PROJECT_ONLY_FILENAMES.has(filename)) return null
  for (const name of candidates) {
    try {
      return await readFile(join(defaultsDir, name), 'utf-8')
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Build the reflection prompt by reading the project's (or shipped default)
 * SystemPrompt.md / Patterns.md / User.md / Goal.md and interpolating.
 * Falls back to buildSelfAssessmentPrompt when no SystemPrompt.md is found.
 *
 * @param {object} opts
 * @param {string} opts.directory — project working directory
 * @param {string} [opts.defaultsDir] — plugin's shipped .agents/supervisor dir
 * @param {object} opts.context — TaskContext
 * @param {string} opts.agents — AGENTS.md / project instructions text
 * @param {string} [opts.lastAssistantText]
 * @param {number} [opts.attemptCount]
 * @param {number} [opts.maxAttempts]
 * @param {string} [opts.goalSection] — session-goal requirement section, if any
 * @returns {Promise<string>}
 */
export async function buildReflectionPrompt({
  directory,
  defaultsDir,
  context,
  agents,
  lastAssistantText,
  attemptCount,
  maxAttempts,
  goalSection,
}) {
  const [systemPromptFile, patternsFile, userFile, goalFile] = await Promise.all([
    readSupervisorFile(directory, defaultsDir, 'SystemPrompt.md'),
    readSupervisorFile(directory, defaultsDir, 'Patterns.md'),
    readSupervisorFile(directory, defaultsDir, 'User.md'),
    readSupervisorFile(directory, defaultsDir, 'Goal.md'),
  ])

  // rubric.md override (core/rubric-loader.mjs): <cwd>/.supervisor/rubric.md,
  // falling back to ~/.config/agents-supervisor/rubric.md, takes precedence
  // over Patterns.md when present — same file both runtimes' rubric override
  // docs point users at (see .supervisor/rubric.md's own header). This is a
  // REPLACE, not a merge: a valid override with either section fully
  // supersedes patternsFile, matching opencode's loadRubric() semantics.
  // Fails open to patternsFile on any missing/unreadable/malformed file.
  const projectRubric = directory ? await loadParsedRubric(directory) : null
  const effectivePatternsFile = projectRubric ? formatRubricMarkdown(projectRubric) : patternsFile

  // Build context variables for interpolation
  const safeContext = {
    ...context,
    detectedSignals: Array.isArray(context.detectedSignals) ? context.detectedSignals : [],
  }

  const requirements = []
  if (safeContext.requiresTests) requirements.push('Tests required (run after latest changes)')
  if (safeContext.requiresBuild) requirements.push('Build/compile required')
  if (safeContext.requiresPR) requirements.push('PR required (include link)')
  if (safeContext.requiresCI) requirements.push('CI checks required (verify status)')
  if (safeContext.requiresLocalTests) requirements.push('Local tests required (must run in this session)')
  if (safeContext.pushedToDefaultBranch) requirements.push('Detected direct push to default branch (must be avoided)')
  if (requirements.length === 0) requirements.push('No explicit workflow gates detected')

  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const currentAttempt = attemptCount || 0

  // If no session goal was passed, check Goal.md for a project-level goal
  const projectGoalCondition = !goalSection ? extractGoalCondition(goalFile) : ''
  const effectiveGoalSection = goalSection || (projectGoalCondition ? buildGoalRequirementSection(projectGoalCondition) : undefined)

  // Judge context. Both runtimes supply a real `conversationChain`; the
  // fallback synthesizes a one-turn chain so a legacy context (bare
  // taskSummary + last response) still renders the same shape instead of an
  // empty judge prompt.
  const currentTaskText = safeContext.currentTask || safeContext.taskSummary || ''
  const conversationChain =
    safeContext.conversationChain ||
    formatConversationTurns([
      {
        user: currentTaskText,
        assistant: lastAssistantText
          ? truncateForPrompt(lastAssistantText, PROMPT_TEXT_LIMIT, { keep: 'tail', label: 'agent response' })
          : '',
      },
    ]) ||
    undefined

  const templateVars = {
    // Legacy vars, kept so pre-existing custom SystemPrompt.md files keep
    // rendering something sensible. Both are the CURRENT ask only — never the
    // whole "[1]..[n]" session history that let a 20-turn session's judge demand
    // turn 1's deliverables on turn 20.
    taskSummary: safeContext.currentTask || safeContext.taskSummary,
    currentTask: safeContext.currentTask || safeContext.taskSummary,
    // THE judge's context: the plain alternating conversation, and nothing
    // else. Tool calls / tool results / the prior-context split were removed
    // deliberately (see core/task-context.mjs).
    conversationChain,
    taskType: safeContext.taskType,
    agentMode: safeContext.agentMode,
    requirements: requirements.join('; '),
    signals: safeContext.detectedSignals.length ? safeContext.detectedSignals.join(', ') : 'none',
    // Explicitly-marked, tail-preserving truncation — a bare slice(0, 4000)
    // here made the judge blame the agent for the supervisor's own cut. The
    // shipped template no longer renders this (the chain's final assistant turn
    // IS the last response); it stays for custom templates that still use it.
    lastAssistantText: lastAssistantText
      ? truncateForPrompt(lastAssistantText, PROMPT_TEXT_LIMIT, { keep: 'tail', label: 'agent response' })
      : undefined,
    attemptSection: currentAttempt > 0 ? 'true' : undefined,
    attemptNumber: String(currentAttempt + 1),
    maxAttempts: String(effectiveCap),
    projectInstructions: agents ? agents.slice(0, 800) : undefined,
    goalSection: effectiveGoalSection || undefined,
  }

  // If the system prompt file exists, use the file-based approach
  if (systemPromptFile) {
    const interpolated = interpolateTemplate(systemPromptFile, templateVars)
    const parts = [interpolated]
    if (effectivePatternsFile) {
      parts.push(effectivePatternsFile)
    }
    if (userFile && userFile.trim() !== '') {
      parts.push(userFile)
    }
    return parts.join('\n\n')
  }

  // Fallback: build prompt using the same logic as buildSelfAssessmentPrompt
  // (for projects that don't have the 3-file structure yet). Still honors the
  // rubric.md override ahead of the shipped DEFAULT_RUBRIC.
  const rubric = projectRubric ?? parseRubric(DEFAULT_RUBRIC)
  const effRubric = effectiveGoalSection
    ? { ...rubric, antipatterns: `${rubric.antipatterns}\n\n${effectiveGoalSection}` }
    : rubric
  return buildSelfAssessmentPrompt(
    context,
    agents,
    lastAssistantText,
    currentAttempt,
    effRubric,
    effectiveCap
  )
}
