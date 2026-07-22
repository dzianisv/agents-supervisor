/**
 * no-loop-override.test.mjs — align-supervisor-modes binding architecture:
 * the deterministic planning/action-loop watchdog (core/evaluation.mjs's
 * detectPlanningLoop/detectActionLoop) must never author or substitute a
 * completion/progress verdict in either the autopilot fast-path or the
 * reflection judge path.
 *
 *   - autopilot: a STATIC nudge loop only — it never decides there is a
 *     "loop", never emits a scripted STOP verdict; only the agent's own
 *     autopilot_exit tool call and the attempt-budget check may stop it.
 *   - reflection: the judge's own verdict (severity/reason/missing/
 *     next_actions) is the ONLY completion/progress authority. Deterministic
 *     tool-call telemetry may appear in the judge's PROMPT as non-binding
 *     evidence, but the feedback text sent back to the agent must never be
 *     swapped for a scripted "STOP: Loop Detected" message, and a judge
 *     verdict of "complete" must win regardless of how loop-like the recent
 *     tool activity looks.
 *
 * Run: node --experimental-strip-types --test test/no-loop-override.test.mjs
 */

import { describe, test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SupervisorPlugin } from "../opencode/supervisor-impl.ts"

const ACTIVE_SESSION_ID = "ses_loopcheck123"
const EPHEMERAL_PREFIX = "ses_judge_loop_"
let ephemeralCounter = 0

/**
 * Synthesizes an assistant message with 9 IDENTICAL `bash: git status`
 * tool calls — a pattern that, before this fix, tripped BOTH
 * detectPlanningLoop (>=8 tool calls, 0 write-type) and detectActionLoop
 * (>=3 repeats of the same normalized command, >=60% of all commands).
 */
function makeLoopyMessages() {
  const toolParts = Array.from({ length: 9 }, (_, i) => ({
    type: "tool",
    tool: "bash",
    state: { input: { command: "git status" } },
  }))
  return [
    {
      info: { role: "user", id: "msg_user_1", time: { created: Date.now() - 5000, completed: Date.now() - 4900 } },
      parts: [{ type: "text", text: "Fix the bug in auth.ts and run tests" }]
    },
    {
      info: {
        role: "assistant", id: "msg_asst_1", providerID: "github-copilot", modelID: "claude-opus-4.6",
        time: { created: Date.now() - 4800, completed: Date.now() - 1000 }
      },
      parts: [...toolParts, { type: "text", text: "Still checking git status before making changes." }]
    }
  ]
}

// These match the actual self-assessment JSON contract consumed by
// core/evaluation.mjs's evaluateSelfAssessment (status/confidence/
// remaining_work/next_steps/needs_user_action/stuck/evidence) — NOT the
// judge-prompt shape used elsewhere. Only one ephemeral "assess" call
// happens per idle pass when this JSON parses cleanly (parseSelfAssessmentJson
// succeeds), so analyzeSelfAssessmentWithLLM's separate judge cascade is
// never reached in these tests.
function makeCompleteAssessment() {
  return JSON.stringify({
    status: "complete",
    confidence: 0.9,
    remaining_work: [],
    needs_user_action: [],
    next_steps: [],
    stuck: false,
    evidence: { tests: {}, build: {}, pr: {} }
  })
}

function makeIncompleteAssessment() {
  return JSON.stringify({
    status: "in_progress",
    confidence: 0.4,
    remaining_work: ["Apply the fix to auth.ts"],
    needs_user_action: [],
    next_steps: ["Edit auth.ts"],
    stuck: false,
    evidence: { tests: {}, build: {}, pr: {} }
  })
}

function createMockClient(messages, selfAssessmentResponse) {
  const promptCalls = []
  const responseMap = new Map()

  const client = {
    session: {
      create: async () => ({ data: { id: `${EPHEMERAL_PREFIX}${++ephemeralCounter}` } }),
      messages: async ({ path }) => {
        if (path.id === ACTIVE_SESSION_ID) return { data: messages }
        const response = responseMap.get(path.id)
        if (!response) return { data: [] }
        return {
          data: [
            { info: { role: "user", id: "j1" }, parts: [{ type: "text", text: "assess" }] },
            {
              info: { role: "assistant", id: "j2", time: { completed: Date.now() } },
              parts: [{ type: "text", text: response }]
            }
          ]
        }
      },
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, body: { ...body } })
        if (path.id !== ACTIVE_SESSION_ID) {
          const text = body?.parts?.[0]?.text || ""
          if (text.includes("CLASSIFY TASK ROUTING")) {
            responseMap.set(path.id, JSON.stringify({ category: "backend" }))
          } else if (text.includes("REVIEW SUPERVISOR COMPLETION")) {
            responseMap.set(path.id, "Looks good.")
          } else {
            responseMap.set(path.id, selfAssessmentResponse)
          }
        }
        return {}
      },
      delete: async () => ({})
    },
    toast: { create: async () => ({}) }
  }

  return {
    client,
    getPromptCalls: () => promptCalls,
    getActiveSessionPrompts: () => promptCalls.filter((c) => c.sessionId === ACTIVE_SESSION_ID),
    getEphemeralPrompts: () => promptCalls.filter((c) => c.sessionId !== ACTIVE_SESSION_ID),
  }
}

describe("autopilot: never emits a deterministic STOP/loop verdict", () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-noloop-autopilot-"))
    mkdirSync(join(tmpDir, ".supervisor", "goals"), { recursive: true })
    ephemeralCounter = 0
  })

  test("loop-like tool activity (9x identical git status) still produces the calm static nudge, never STOP text", async () => {
    const messages = makeLoopyMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages, makeIncompleteAssessment())

    writeFileSync(
      join(tmpDir, ".supervisor", "goals", `${ACTIVE_SESSION_ID}.json`),
      JSON.stringify({ mode: "autopilot", autopilot: true })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 300))

    const activePrompts = getActiveSessionPrompts()
    assert.ok(activePrompts.length > 0, "autopilot should have injected a nudge")

    const nudgeText = activePrompts[0]?.body?.parts?.[0]?.text || ""
    assert.doesNotMatch(nudgeText, /STOP: Planning Loop Detected/)
    assert.doesNotMatch(nudgeText, /STOP: Action Loop Detected/)
    assert.doesNotMatch(nudgeText, /\bSTOP\b/)
    assert.doesNotMatch(nudgeText, /DO NOT:/)
    assert.doesNotMatch(nudgeText, /Start coding NOW/)
    assert.match(nudgeText, /Autopilot/)
    assert.match(nudgeText, /autopilot_exit/)
  })
})

describe("reflection: judge verdict is the sole completion/progress authority", () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-noloop-reflection-"))
    mkdirSync(join(tmpDir, ".supervisor", "goals"), { recursive: true })
    ephemeralCounter = 0
  })

  test("loop-like tool activity + judge says incomplete → calm generic feedback, never a scripted STOP script", async () => {
    const messages = makeLoopyMessages()
    const { client, getActiveSessionPrompts, getEphemeralPrompts } = createMockClient(messages, makeIncompleteAssessment())

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 5000))

    const activePrompts = getActiveSessionPrompts()
    assert.ok(activePrompts.length > 0, "reflection should have injected feedback for an incomplete verdict")

    const feedbackText = activePrompts[0]?.body?.parts?.[0]?.text || ""
    assert.doesNotMatch(feedbackText, /STOP: Planning Loop Detected/)
    assert.doesNotMatch(feedbackText, /STOP: Action Loop Detected/)
    assert.doesNotMatch(feedbackText, /\bSTOP\b/)
    assert.match(feedbackText, /Task Incomplete|may be incomplete/)
    // The judge's own reason/missing/next_actions drive the text, not a canned script.
    assert.match(feedbackText, /Apply the fix/)

    // Non-binding telemetry MAY have reached the judge's own prompt as
    // factual context — but that's the judge's input, not the output sent
    // to the agent, and it must be clearly labeled non-binding.
    const judgePrompt = getEphemeralPrompts()[0]?.body?.parts?.[0]?.text || ""
    if (judgePrompt.includes("tool call")) {
      assert.match(judgePrompt, /informational only, not a verdict/)
    }
  })

  test("loop-like tool activity + judge says complete → task marked complete (judge wins over telemetry)", async () => {
    const messages = makeLoopyMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages, makeCompleteAssessment())

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 5000))

    // A "complete" verdict must never be overridden into a continuation/STOP
    // nudge just because the tool-call pattern looks loop-like.
    const activePrompts = getActiveSessionPrompts()
    assert.equal(activePrompts.length, 0, "no continuation should be injected when the judge says complete, regardless of tool-activity pattern")
  })
})
