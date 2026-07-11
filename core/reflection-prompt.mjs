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
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractGoalCondition, buildGoalRequirementSection, DEFAULT_MAX_ATTEMPTS } from './goal.mjs'
import { DEFAULT_RUBRIC, parseRubric, buildSelfAssessmentPrompt } from './assessment.mjs'

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

/**
 * Try `<directory>/.agents/supervisor/<filename>` first, falling back to
 * `<defaultsDir>/<filename>` (the plugin's shipped defaults). Returns null
 * if neither exists.
 * @param {string} directory
 * @param {string} defaultsDir
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function readSupervisorFile(directory, defaultsDir, filename) {
  const projectPath = join(directory, '.agents', 'supervisor', filename)
  try {
    return await readFile(projectPath, 'utf-8')
  } catch (e) {
    if (e.code !== 'ENOENT') return null
  }
  if (!defaultsDir) return null
  try {
    return await readFile(join(defaultsDir, filename), 'utf-8')
  } catch {
    return null
  }
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

  const templateVars = {
    taskSummary: safeContext.taskSummary,
    taskType: safeContext.taskType,
    agentMode: safeContext.agentMode,
    requirements: requirements.join('; '),
    signals: safeContext.detectedSignals.length ? safeContext.detectedSignals.join(', ') : 'none',
    toolsSummary: safeContext.toolsSummary,
    lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, 4000) : undefined,
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
    if (patternsFile) {
      parts.push(patternsFile)
    }
    if (userFile && userFile.trim() !== '') {
      parts.push(userFile)
    }
    return parts.join('\n\n')
  }

  // Fallback: build prompt using the same logic as buildSelfAssessmentPrompt
  // (for projects that don't have the 3-file structure yet)
  const rubric = parseRubric(DEFAULT_RUBRIC)
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
