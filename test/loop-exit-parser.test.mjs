/**
 * loop-exit-parser.test.mjs — the ONE shared sentinel parser.
 *
 * The OpenCode runtime ends the supervision loop with a tool call; the Claude
 * Code Stop hook has no tool registry and ends it with a text sentinel. Both
 * go through core/loop-exit.mjs, so this file pins the exact strictness: the
 * sentinel must own its line, or a passing mention in prose (or in the nudge
 * that documents it) would silently end supervision.
 *
 * Run: node --test test/loop-exit-parser.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLoopExitSentinel } from '../core/loop-exit.mjs'

describe('parseLoopExitSentinel — positive', () => {
  test('bare completed', () => {
    assert.deepEqual(parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT: completed'), { reason: 'completed', detail: '' })
  })
  test('on its own line inside a reply', () => {
    const t = 'Shipped the fix and CI is green.\nSUPERVISOR_LOOP_EXIT: completed\n'
    assert.equal(parseLoopExitSentinel(t).reason, 'completed')
  })
  test('stuck with em-dash detail', () => {
    const r = parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT: stuck — the supervisor keeps demanding a merged PR')
    assert.deepEqual(r, { reason: 'stuck', detail: 'the supervisor keeps demanding a merged PR' })
  })
  test('stuck with plain hyphen detail', () => {
    assert.deepEqual(parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT: stuck - no perms'), { reason: 'stuck', detail: 'no perms' })
  })
  test('reason is case-insensitive', () => {
    assert.equal(parseLoopExitSentinel('supervisor_loop_exit: STUCK').reason, 'stuck')
  })
  test('anything not "stuck" is treated as completed', () => {
    assert.equal(parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT: done').reason, 'completed')
    assert.equal(parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT:').reason, 'completed')
  })
  test('AUTOPILOT_EXIT stays a backwards-compatible alias for completed', () => {
    assert.deepEqual(parseLoopExitSentinel('All done!\nAUTOPILOT_EXIT\nbye'), { reason: 'completed', detail: 'AUTOPILOT_EXIT' })
  })
})

describe('parseLoopExitSentinel — negative', () => {
  test('null for non-strings and empty', () => {
    assert.equal(parseLoopExitSentinel(undefined), null)
    assert.equal(parseLoopExitSentinel(''), null)
  })
  test('mentioned mid-sentence does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('I will output SUPERVISOR_LOOP_EXIT: completed when the tests pass.'), null)
  })
  test('wrapped in inline backticks does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('`SUPERVISOR_LOOP_EXIT: completed`'), null)
  })
  test('inside a fenced code block does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('Example:\n```\nSUPERVISOR_LOOP_EXIT: completed\n```\nStill working.'), null)
  })
  test('wrong keyword does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('SUPERVISOR_EXIT: completed'), null)
    assert.equal(parseLoopExitSentinel('LOOP_EXIT: completed'), null)
  })
  test('missing colon does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('SUPERVISOR_LOOP_EXIT completed'), null)
  })
  test('trailing text on the AUTOPILOT_EXIT line does NOT trigger', () => {
    assert.equal(parseLoopExitSentinel('AUTOPILOT_EXIT soon'), null)
  })
})

describe('buildEscalatingFeedback loop-exit wording is runtime-aware', () => {
  test('opencode default names the TOOL, not the sentinel', async () => {
    const { buildEscalatingFeedback } = await import('../core/feedback.mjs')
    const t = buildEscalatingFeedback('moderate', { feedback: 'x', missing: ['y'] })
    assert.match(t, /supervisor_loop_exit tool \(reason: completed \| stuck\)/)
    assert.doesNotMatch(t, /ALONE on its own line to end supervision/)
  })
  test('sentinel style names the SENTINEL, not the tool', async () => {
    const { buildEscalatingFeedback } = await import('../core/feedback.mjs')
    const t = buildEscalatingFeedback('moderate', { feedback: 'x', missing: ['y'] }, { loopExitStyle: 'sentinel' })
    assert.match(t, /SUPERVISOR_LOOP_EXIT: completed/)
    assert.doesNotMatch(t, /supervisor_loop_exit tool/)
  })
  test('both hint variants stay out of the empty-body guard', async () => {
    const { buildEscalatingFeedback, hasFeedbackBody } = await import('../core/feedback.mjs')
    for (const loopExitStyle of ['tool', 'sentinel']) {
      const empty = buildEscalatingFeedback('moderate', { feedback: '', missing: [], next_actions: [] }, { loopExitStyle })
      assert.equal(hasFeedbackBody(empty), false, `${loopExitStyle} hint must not count as body`)
    }
  })
})
