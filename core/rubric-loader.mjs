import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRubric } from './assessment.mjs'

/**
 * Return raw markdown text of the active rubric, or null if none found.
 * Precedence: <cwd>/.supervisor/rubric.md → ~/.config/agents-supervisor/rubric.md
 */
export async function loadRubricMarkdown(cwd) {
  const candidates = [
    join(cwd, '.supervisor', 'rubric.md'),
    join(homedir(), '.config', 'agents-supervisor', 'rubric.md'),
  ]
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf-8')
    } catch (e) {
      if (e.code !== 'ENOENT') return null // unexpected error — fail safe
    }
  }
  return null
}

/**
 * Return a parsed Rubric object for the given working directory, or null if no
 * rubric file is found. null causes buildSelfAssessmentPrompt to use DEFAULT_RUBRIC.
 */
export async function loadParsedRubric(cwd) {
  try {
    const md = await loadRubricMarkdown(cwd)
    return md != null ? parseRubric(md) : null
  } catch {
    return null
  }
}
