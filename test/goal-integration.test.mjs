/**
 * goal-integration.test.mjs — Behavioral integration tests for the supervisor
 * goal loop: setting/clearing/checking goals via the tool, and verifying the
 * session.idle event correctly injects goal conditions into the judge prompt
 * and respects budget exhaustion.
 *
 * Run: node --experimental-strip-types --test test/goal-integration.test.mjs
 */

import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SupervisorPlugin } from "../opencode/supervisor-impl.ts"

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_goaltest123"
const EPHEMERAL_PREFIX = "ses_judge_goal_"
let ephemeralCounter = 0

function makeMessages() {
  return [
    {
      info: {
        role: "user",
        id: "msg_user_1",
        time: { created: Date.now() - 5000, completed: Date.now() - 4900 }
      },
      parts: [{ type: "text", text: "Fix the bug in auth.ts and run tests" }]
    },
    {
      info: {
        role: "assistant",
        id: "msg_asst_1",
        providerID: "github-copilot",
        modelID: "claude-opus-4.6",
        time: { created: Date.now() - 4800, completed: Date.now() - 1000 }
      },
      parts: [{ type: "text", text: "I'll look into the auth.ts file and fix the bug." }]
    }
  ]
}

/**
 * Self-assessment JSON that signals "not complete" — triggers the goal loop
 * continuation path (or exhaustion if budget is spent).
 */
function makeIncompleteAssessment() {
  return JSON.stringify({
    complete: false,
    confidence: 0.3,
    summary: "Started investigating but haven't made changes yet",
    evidence: { tests_passing: false, build_passing: false, pr_opened: false },
    missing: ["Apply fix to auth.ts", "Run tests"],
    next_actions: ["Edit auth.ts", "Run npm test"]
  })
}

/**
 * Creates a mock opencode client that captures all promptAsync calls.
 */
function createMockClient(messages) {
  const promptCalls = []
  const responseMap = new Map()

  const client = {
    session: {
      create: async () => {
        const id = `${EPHEMERAL_PREFIX}${++ephemeralCounter}`
        return { data: { id } }
      },
      messages: async ({ path }) => {
        if (path.id === SESSION_ID) {
          return { data: messages }
        }
        const response = responseMap.get(path.id)
        if (response) {
          return {
            data: [
              { info: { role: "user", id: "j1" }, parts: [{ type: "text", text: "assess" }] },
              {
                info: { role: "assistant", id: "j2", time: { completed: Date.now() } },
                parts: [{ type: "text", text: response }]
              }
            ]
          }
        }
        return { data: [] }
      },
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, body: { ...body } })
        if (path.id !== SESSION_ID) {
          // Determine response based on prompt content (mirrors no-model-switch pattern)
          const text = body?.parts?.[0]?.text || ""
          if (text.includes("CLASSIFY TASK ROUTING")) {
            responseMap.set(path.id, JSON.stringify({ category: "backend" }))
          } else if (text.includes("REVIEW SUPERVISOR COMPLETION")) {
            responseMap.set(path.id, "Review looks good. No gaps found.")
          } else {
            // Self-assessment / judge — return "not complete"
            responseMap.set(path.id, makeIncompleteAssessment())
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
    getActiveSessionPrompts: () => promptCalls.filter(c => c.sessionId === SESSION_ID),
    getEphemeralPrompts: () => promptCalls.filter(c => c.sessionId !== SESSION_ID),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: supervisor goal loop", () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-goal-test-"))
    mkdirSync(join(tmpDir, ".supervisor", "goals"), { recursive: true })
    ephemeralCounter = 0
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  test("goal set via executeSupervisorGoal writes correct state file", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Set currentSessionId by firing tool.execute.before
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    // Call the supervisor_goal tool's execute
    const goalTool = plugin.tool.supervisor_goal
    assert.ok(goalTool, "supervisor_goal tool must exist on plugin")

    const result = await goalTool.execute({ condition: "all tests pass" })
    assert.ok(typeof result === "string")
    assert.ok(result.includes("Goal set"), `Expected 'Goal set' in result, got: ${result}`)

    // Read state file
    const statePath = join(tmpDir, ".supervisor", "goals", `${SESSION_ID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))

    assert.equal(state.mode, "goal")
    assert.equal(state.goal.condition, "all tests pass")
    assert.equal(state.goal.status, "active")
    assert.equal(state.goal.attempts, 0)
    assert.equal(state.autopilot, false)
  })

  test("goal clear reverts to reflection mode", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Set currentSessionId
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    const goalTool = plugin.tool.supervisor_goal

    // Set a goal first
    await goalTool.execute({ condition: "all tests pass" })

    // Clear the goal
    const result = await goalTool.execute({ clear: true })
    assert.ok(result.includes("cleared"), `Expected 'cleared' in result, got: ${result}`)

    // Read state file
    const statePath = join(tmpDir, ".supervisor", "goals", `${SESSION_ID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))

    assert.equal(state.mode, "reflection")
    assert.equal(state.goal, undefined)
    assert.equal(state.autopilot, false)
  })

  test("goal status returns current condition when goal active", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Set currentSessionId
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    const goalTool = plugin.tool.supervisor_goal

    // Set a goal
    await goalTool.execute({ condition: "all tests pass" })

    // Check status (no condition, no clear)
    const result = await goalTool.execute({})
    assert.ok(result.includes("all tests pass"), `Expected condition in status, got: ${result}`)
    assert.ok(result.includes("active"), `Expected 'active' in status, got: ${result}`)
  })

  test("session.idle with active goal injects goal into judge prompt", async () => {
    const messages = makeMessages()
    const { client, getEphemeralPrompts } = createMockClient(messages)

    // Write goal state directly (same pattern as no-model-switch test)
    writeFileSync(
      join(tmpDir, ".supervisor", "goals", `${SESSION_ID}.json`),
      JSON.stringify({
        mode: "goal",
        autopilot: false,
        goal: {
          condition: "all tests pass",
          status: "active",
          attempts: 0,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() + 3600000,
          lastReason: ""
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Fire session.idle
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })

    // Wait for async processing (abort race delay + assessment polling)
    await new Promise(r => setTimeout(r, 5000))

    // Check that the ephemeral session (judge) prompt contains the goal
    const ephemeralPrompts = getEphemeralPrompts()
    assert.ok(ephemeralPrompts.length > 0, "At least one ephemeral session should have been prompted")

    // Find the self-assessment prompt (first ephemeral prompt)
    const assessmentPrompt = ephemeralPrompts[0]?.body?.parts?.[0]?.text || ""
    assert.ok(
      assessmentPrompt.includes("all tests pass"),
      `Judge prompt must contain goal condition "all tests pass", got (first 200): ${assessmentPrompt.slice(0, 200)}`
    )
    assert.ok(
      assessmentPrompt.includes("MANDATORY"),
      `Judge prompt must contain "MANDATORY" from buildGoalRequirementSection, got (first 200): ${assessmentPrompt.slice(0, 200)}`
    )
  })

  test("goal loop exhausts after maxAttempts", async () => {
    const messages = makeMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages)

    // Write goal state with attempts already at the default max (16)
    writeFileSync(
      join(tmpDir, ".supervisor", "goals", `${SESSION_ID}.json`),
      JSON.stringify({
        mode: "goal",
        autopilot: false,
        goal: {
          condition: "all tests pass",
          status: "active",
          attempts: 16,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() + 3600000,
          lastReason: ""
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Fire session.idle
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })

    // Wait for async processing
    await new Promise(r => setTimeout(r, 5000))

    // Read state file — should be exhausted
    const statePath = join(tmpDir, ".supervisor", "goals", `${SESSION_ID}.json`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))

    assert.equal(state.goal.status, "exhausted", `Goal should be exhausted, got: ${state.goal.status}`)
    assert.equal(state.mode, "reflection", `Mode should revert to reflection, got: ${state.mode}`)

    // No continuation should have been injected to the active session
    const activePrompts = getActiveSessionPrompts()
    assert.equal(activePrompts.length, 0, `No prompt should be sent to active session after exhaustion, got ${activePrompts.length}`)
  })
})
