/**
 * loop-exit-single-signal.test.mjs — the predecessor exit signal must not be
 * TAUGHT anywhere, in either runtime's shipped text.
 *
 * The supervision loop now ends when the agent DECLARES an exit:
 *   - opencode:     the `supervisor_loop_exit` tool, `{reason, detail}`
 *   - Claude Code:  the text sentinel `SUPERVISOR_LOOP_EXIT: completed` /
 *                   `: stuck — why`, alone on its own line
 *
 * `AUTOPILOT_EXIT` predates both. `core/loop-exit.mjs` keeps it as a
 * PARSE-ONLY alias for `reason: 'completed'` — stale installed skill copies
 * (users' ~/.config) may still emit it, and the 0.3.1 manifest-bump incident
 * showed installed copies can lag shipped fixes for a long time. But nothing
 * shipped from THIS repo may TEACH it anymore: two tokens for one signal is
 * exactly the drift shape this repo keeps re-creating (see AGENTS.md's
 * stop-mechanism section).
 *
 * This is the regression guard: a banned-phrase grep over every shipped
 * surface an agent or user actually reads — README, skills, opencode slash
 * commands, and the nudge/toast strings baked into bin/*.mjs and
 * opencode/supervisor-impl.ts. Modeled on the banned-phrase grep in
 * test/rubric-prose-evidence.test.mjs.
 *
 * Explicitly OUT of scope (must keep the alias, on purpose):
 *   - core/loop-exit.mjs (the parser itself — PARSE-ONLY, documented inline)
 *   - test/loop-exit-parser.test.mjs, test/no-progress-gate.test.mjs,
 *     test/supervisor-cli.test.mjs (tests that the alias still PARSES)
 *   - historical/forensic prose (status.md, thoughts/ledgers/*.md,
 *     .scratch/live-validation.md) — session logs of past work, not
 *     instructions read by a live agent or user today
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every phrase that would TEACH the predecessor signal (as opposed to merely
 * parsing it). Case-sensitive: `AUTOPILOT_EXIT` (the sentinel token) and
 * `autopilot_exit` (the deleted tool name) are the two shapes it took.
 */
const BANNED_PHRASES = ['AUTOPILOT_EXIT', 'autopilot_exit']

/** Read a file relative to repo root; returns null if it does not exist. */
function readIfExists(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), 'utf-8')
  } catch {
    return null
  }
}

function assertNoBannedPhrase(text, label) {
  for (const phrase of BANNED_PHRASES) {
    assert.ok(
      !text.includes(phrase),
      `${label} still teaches the retired "${phrase}" signal — supervisor_loop_exit / SUPERVISOR_LOOP_EXIT is the one signal shipped text may name`
    )
  }
}

describe('shipped text teaches exactly one loop-exit signal', () => {
  test('README.md', () => {
    assertNoBannedPhrase(readIfExists('README.md'), 'README.md')
  })

  test('skills/**/SKILL.md', () => {
    const files = globSync('skills/**/SKILL.md', { cwd: ROOT })
    assert.ok(files.length > 0, 'expected to find at least one skills/**/SKILL.md')
    for (const f of files) {
      assertNoBannedPhrase(readIfExists(f), f)
    }
  })

  test('opencode/commands/*.md', () => {
    const files = globSync('opencode/commands/*.md', { cwd: ROOT })
    assert.ok(files.length > 0, 'expected to find at least one opencode/commands/*.md')
    for (const f of files) {
      assertNoBannedPhrase(readIfExists(f), f)
    }
  })

  test('.agents/knowledgebase/*.md', () => {
    const files = globSync('.agents/knowledgebase/*.md', { cwd: ROOT })
    assert.ok(files.length > 0, 'expected to find at least one .agents/knowledgebase/*.md')
    for (const f of files) {
      assertNoBannedPhrase(readIfExists(f), f)
    }
  })

  test('docs/tdd.md', () => {
    assertNoBannedPhrase(readIfExists('docs/tdd.md'), 'docs/tdd.md')
  })

  test('bin/supervisor.mjs (autopilot toast/CLI text)', () => {
    assertNoBannedPhrase(readIfExists('bin/supervisor.mjs'), 'bin/supervisor.mjs')
  })

  test('bin/supervisor-on-stop.mjs (the autopilot nudge string)', () => {
    const text = readIfExists('bin/supervisor-on-stop.mjs')
    // AUTOPILOT_EXIT may appear in a code COMMENT describing the retired
    // signal, but must never appear inside the actual nudge STRING sent to
    // the agent. Isolate the nudge literal and check it in isolation.
    const nudgeMatch = /const baseNudge = `[\s\S]*?`;/.exec(text)
    assert.ok(nudgeMatch, 'could not locate the autopilot baseNudge template literal')
    assertNoBannedPhrase(nudgeMatch[0], 'bin/supervisor-on-stop.mjs baseNudge')
  })

  test('opencode/supervisor-impl.ts (tool descriptions and toggle-response strings)', () => {
    const text = readIfExists('opencode/supervisor-impl.ts')
    assert.ok(text, 'opencode/supervisor-impl.ts must exist')
    // The autopilot_exit TOOL must be gone entirely — not just its teaching
    // text. A stray reference here means the tool (or its wiring) survived.
    assert.ok(
      !/\bautopilot_exit\b/.test(text) && !/\bexecuteAutopilotExit\b/.test(text) && !/\bautopilotExitTool\b/.test(text),
      'opencode/supervisor-impl.ts must not reference the deleted autopilot_exit tool anywhere (definition, registration, or export)'
    )
    // AUTOPILOT_EXIT (the CC sentinel spelling) has no reason to appear at
    // all in an OpenCode-only file — OpenCode always had the real tool.
    assert.ok(
      !/AUTOPILOT_EXIT/.test(text),
      'opencode/supervisor-impl.ts must not mention the Claude-Code-only AUTOPILOT_EXIT sentinel'
    )
  })
})
