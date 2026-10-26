/**
 * rubric-prose-evidence.test.mjs — the judge reads prose, not a tool log.
 *
 * PR #61 made `buildConversationChain` the judge's ONLY context: the plain
 * alternating user/assistant conversation. Tool calls, tool inputs and tool
 * results are gone permanently. That left rubric rules asserting things the
 * judge can no longer observe ("the tool commands show ONLY read operations",
 * "write/edit tool calls in tool commands", "no write/tool evidence"). Dead
 * rubric text is worse than no text — the judge can only hallucinate
 * compliance against a field it never receives.
 *
 * These tests are the regression guard that stops the dead text coming back.
 * They run over the SHIPPED rubric — both copies, which must stay identical:
 *   1. .agents/supervisor/Patterns.md  → read by core/reflection-prompt.mjs
 *      (both runtimes' reflection path, project override or shipped default)
 *   2. STATIC_RUBRIC in core/assessment.mjs → DEFAULT_RUBRIC, read by
 *      opencode's loadRubric() fallback and buildSelfAssessmentPrompt/
 *      buildJudgePrompt when no .supervisor/rubric.md override exists.
 *
 * NOT in scope: core/patterns.json. That is a DIFFERENT judge
 * (core/judge-core.mjs, the Stop classifier) with a DIFFERENT input contract —
 * it still receives `tools_available_inferred` (the list of tool NAMES the
 * assistant used). Its tool-referencing rules are not dead.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RUBRIC, parseRubric, buildSelfAssessmentPrompt, buildJudgePrompt } from '../core/assessment.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATTERNS_MD = readFileSync(join(ROOT, '.agents', 'supervisor', 'Patterns.md'), 'utf-8')
const SYSTEM_PROMPT_MD = readFileSync(join(ROOT, '.agents', 'supervisor', 'SystemPrompt.md'), 'utf-8')

/**
 * Phrases that only mean something to a judge holding a tool log. Each one was
 * present in the rubric before this change and named a field the judge does
 * not receive.
 */
const BANNED_IN_RUBRIC = [
  'tool commands',
  'tool calls',
  'read operations',
  'write operations',
  'write/edit',
  'write/tool evidence',
  'tool evidence',
  'Required checks',
  'detected-signals',
  'Detected signals',
  'toolsSummary',
  'Tool Signals',
  'tool_use',
]

function assertNoBannedPhrases(text, label) {
  for (const phrase of BANNED_IN_RUBRIC) {
    assert.ok(
      !new RegExp(phrase.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'i').test(text),
      `${label} still references tool-log-only evidence: "${phrase}" — the judge never receives it (PR #61)`
    )
  }
}

describe('shipped rubric contains no tool-log-only evidence', () => {
  test('.agents/supervisor/Patterns.md', () => {
    assertNoBannedPhrases(PATTERNS_MD, '.agents/supervisor/Patterns.md')
  })

  test('DEFAULT_RUBRIC (core/assessment.mjs STATIC_RUBRIC)', () => {
    assertNoBannedPhrases(DEFAULT_RUBRIC, 'DEFAULT_RUBRIC')
  })

  test('the two shipped copies are identical', () => {
    // STATIC_RUBRIC is Patterns.md minus its markdown title; DEFAULT_RUBRIC
    // appends the core/patterns.json subagent-exemption rule at build time.
    const fromFile = PATTERNS_MD.replace(/^#[^\n]*\n+/, '').trimEnd()
    const fromCode = DEFAULT_RUBRIC.replace(/\n- BACKGROUND SUBAGENTS[\s\S]*$/, '').trimEnd()
    assert.equal(fromCode, fromFile, 'Patterns.md and STATIC_RUBRIC have drifted — both ship, both must match')
  })

  test('the rendered judge prompts carry no banned phrase either', () => {
    const ctx = {
      taskSummary: 'fix the parser',
      currentTask: 'fix the parser',
      taskType: 'coding',
      agentMode: 'build',
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      pushedToDefaultBranch: false,
      detectedSignals: ['test-command', 'gh-pr-create', 'git-push'],
      toolsSummary: 'bash: npm test\nedited src/parse.ts',
    }
    const self = buildSelfAssessmentPrompt(ctx, null, 'Done.', 0, null, 3)
    const judge = buildJudgePrompt(ctx, '{"status":"complete"}', null, null)
    for (const [label, prompt] of [['self-assessment prompt', self], ['judge prompt', judge]]) {
      assertNoBannedPhrases(prompt, label)
      // detectedSignals is half-derived from the tool command log
      // (test-command / gh-pr-* / git-push in core/evaluation.mjs
      // detectSignals) — it is the same evidence class PR #61 removed and
      // must not leak back in through the Task Context block.
      assert.ok(!prompt.includes('gh-pr-create'), `${label} leaked tool-derived signals`)
      assert.ok(!prompt.includes('git-push'), `${label} leaked tool-derived signals`)
    }
  })

  test('SystemPrompt.md Task Context no longer renders {{signals}}', () => {
    assert.ok(!SYSTEM_PROMPT_MD.includes('{{signals}}'), 'tool-derived signals still rendered into the judge prompt')
    // The one legitimate mention of tool calls: telling the judge it has none.
    assert.ok(
      SYSTEM_PROMPT_MD.includes("You do not see the agent's tool calls or their results"),
      'the judge must still be told it has no tool visibility'
    )
  })
})

describe('the prose-evidence rules are present', () => {
  const rubric = parseRubric(DEFAULT_RUBRIC)

  test('SPECIFICITY TEST: checkable specifics, not reassurances', () => {
    assert.match(rubric.patterns, /SPECIFICITY TEST/)
    assert.match(rubric.patterns, /"tests pass" is not evidence/)
    assert.match(rubric.patterns, /12\/12 passing/)
    assert.match(rubric.patterns, /"Opened a PR" is not/)
    assert.match(rubric.patterns, /PR #88, CI green/)
    assert.match(rubric.patterns, /file path, a PR\/issue number, a command AND what it returned, a count/)
  })

  test('DO NOT INVENT EVIDENCE: no assumed steps in either direction', () => {
    assert.match(rubric.patterns, /DO NOT INVENT EVIDENCE/)
    assert.match(rubric.patterns, /never assume a step happened because it is standard practice/)
    assert.match(rubric.patterns, /EARLIER turn did not mention it/)
    assert.match(rubric.patterns, /Do not demand proof you were not given/)
  })

  test('REPORT REVIEW framing: manager reading a report, not an auditor reading logs', () => {
    assert.match(rubric.patterns, /REPORT REVIEW, NOT AUDIT/)
    assert.match(rubric.patterns, /No tool log, no terminal, no files/)
  })

  test('PLANNING LOOP CHECK tests tense, not the tool log', () => {
    assert.match(rubric.patterns, /PLANNING LOOP CHECK/)
    assert.match(rubric.patterns, /only describes what SHOULD be done/)
    assert.match(rubric.patterns, /never states in the past tense that it did it/)
  })

  test('VERIFICATION-DEFERRAL tests the stated result, not edit calls', () => {
    assert.match(rubric.antipatterns, /VERIFICATION-DEFERRAL: the reply claims a code change/)
    assert.match(rubric.antipatterns, /says nothing about the result of tests, build, or lint/)
    assert.match(rubric.antipatterns, /Naming a test file it created is not a test result/)
  })

  test('FALSE-COMPLETE tests named artifacts, not write evidence', () => {
    assert.match(rubric.antipatterns, /FALSE-COMPLETE/)
    assert.match(rubric.antipatterns, /names no concrete artifact/)
    assert.match(rubric.antipatterns, /no file path, no PR\/issue number, no command with what it returned, no counts/)
  })

  test('the exact-commands rule asks the AGENT to quote command and result', () => {
    assert.match(rubric.patterns, /quote the command it ran AND what that command returned/)
  })
})

describe('rules that never depended on tool evidence are untouched', () => {
  const rubric = parseRubric(DEFAULT_RUBRIC)
  const KEEP = [
    ['PERMISSION-SEEKING', /PERMISSION-SEEKING \(most common, ~40%\)/],
    ['STOPPED-WITH-TODOS', /STOPPED-WITH-TODOS \(~30%\)/],
    ['DECLINED WORK', /DECLINED WORK ISN'T REMAINING WORK/],
    ['SINGLE-BLOCKER', /SINGLE-BLOCKER TOTAL-STOP/],
    ['LEGITIMATE STOP', /LEGITIMATE STOP \(do NOT flag\)/],
    ['TRAILING QUESTION', /TRAILING QUESTION: distinguish two cases/],
    ['SEVERITY/STUCK', /SEVERITY\/STUCK/],
  ]
  for (const [name, re] of KEEP) {
    test(`${name} survives`, () => {
      assert.match(`${rubric.patterns}\n${rubric.antipatterns}`, re)
    })
  }

  test('the mined-statistics annotation survives', () => {
    assert.match(rubric.antipatterns, /mined from 284 real agent stops/)
    assert.match(rubric.antipatterns, /78% were premature/)
  })
})
