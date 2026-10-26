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
 * rubric file is found (or the file exists but is malformed — has neither a
 * ## Patterns nor a ## Antipatterns section). null causes callers to fall back
 * to their own default (DEFAULT_RUBRIC / .agents/supervisor/Patterns.md),
 * mirroring opencode's loadRubric(): an override REPLACES the default
 * wholesale when present and non-empty, it does not merge with it.
 */
export async function loadParsedRubric(cwd) {
  try {
    const md = await loadRubricMarkdown(cwd)
    if (md == null) return null
    const rubric = parseRubric(md)
    if (!rubric.patterns && !rubric.antipatterns) return null // malformed — fail open
    return rubric
  } catch {
    return null
  }
}

/**
 * Serialize a parsed Rubric back into the `## Patterns` / `## Antipatterns`
 * markdown shape that parseRubric() (core/assessment.mjs) expects, so a
 * rubric loaded from disk can be spliced into the same prompt-building path
 * as `.agents/supervisor/Patterns.md`.
 * @param {{patterns: string, antipatterns: string}} rubric
 * @returns {string}
 */
export function formatRubricMarkdown(rubric) {
  const parts = []
  if (rubric?.patterns) parts.push(`## Patterns\n${rubric.patterns}`)
  if (rubric?.antipatterns) parts.push(`## Antipatterns\n${rubric.antipatterns}`)
  return parts.join('\n\n')
}
