/**
 * loop-exit.test.mjs — the agent-declared end of the supervision loop.
 *
 * The per-turn attempt counter used to be THE stop condition, with a default
 * of 3 for plain reflection. A counter cannot observe whether the human's task
 * is finished, so the supervisor stood down mid-task. The stop is now an
 * explicit `supervisor_loop_exit` tool call; the counter is demoted to a
 * runaway circuit breaker (core/goal.mjs RUNAWAY_CEILING).
 *
 * What this pins:
 *   - the tool records a loopExit on the session state, keyed by THE turn key
 *   - the idle gate stands down (no injection) when it matches the turn
 *   - a STALE record (previous turn) must NOT suppress a new human turn
 *   - reason="stuck" leaves forensic evidence in .supervisor/loop-exit.log
 *   - the tool NEVER deletes an active goal (the autopilot_exit footgun)
 *   - the injected feedback text tells the agent the tool exists
 *
 * Run: node --experimental-strip-types --test test/loop-exit.test.mjs
 */

import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SupervisorPlugin } from "../opencode/supervisor-impl.ts"
import { sessionStore } from "../core/session-store.mjs"
import { goalStore } from "../core/goal.mjs"
import { buildEscalatingFeedback } from "../core/feedback.mjs"

const SESSION_ID = "ses_loopexit123"
const TURN_ONE = "msg_user_1"
const TURN_TWO = "msg_user_2"

function makeMessages(userMsgId = TURN_ONE) {
  return [
    {
      info: { role: "user", id: userMsgId, time: { created: Date.now() - 5000, completed: Date.now() - 4900 } },
      parts: [{ type: "text", text: "Fix the bug in auth.ts and run the tests" }],
    },
    {
      info: {
        role: "assistant",
        id: "msg_asst_1",
        providerID: "github-copilot",
        modelID: "claude-opus-4.6",
        time: { created: Date.now() - 4800, completed: Date.now() - 1000 },
      },
      parts: [{ type: "text", text: "I looked at auth.ts." }],
    },
  ]
}

function incompleteAssessment() {
  return JSON.stringify({
    complete: false,
    confidence: 0.3,
    summary: "Not done",
    evidence: { tests_passing: false, build_passing: false, pr_opened: false },
    missing: ["Apply fix to auth.ts"],
    next_actions: ["Edit auth.ts"],
  })
}

function createMockClient(messages) {
  const promptCalls = []
  const responseMap = new Map()
  let ephemeral = 0
  const client = {
    session: {
      create: async () => ({ data: { id: `ses_judge_${++ephemeral}` } }),
      messages: async ({ path }) => {
        if (path.id === SESSION_ID) return { data: messages() }
        const response = responseMap.get(path.id)
        if (response) {
          return {
            data: [
              { info: { role: "user", id: "j1" }, parts: [{ type: "text", text: "assess" }] },
              { info: { role: "assistant", id: "j2", time: { completed: Date.now() } }, parts: [{ type: "text", text: response }] },
            ],
          }
        }
        return { data: [] }
      },
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, body: { ...body } })
        if (path.id !== SESSION_ID) {
          const text = body?.parts?.[0]?.text || ""
          if (text.includes("CLASSIFY TASK ROUTING")) responseMap.set(path.id, JSON.stringify({ category: "backend" }))
          else responseMap.set(path.id, incompleteAssessment())
        }
        return {}
      },
      delete: async () => ({}),
    },
    toast: { create: async () => ({}) },
  }
  return { client, activePrompts: () => promptCalls.filter((c) => c.sessionId === SESSION_ID) }
}

describe("supervisor_loop_exit", () => {
  let tmpDir
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "sup-loopexit-")) })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  test("the tool records a loopExit keyed by the current turn key", async () => {
    let msgs = makeMessages(TURN_ONE)
    const { client } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    const tool = plugin.tool.supervisor_loop_exit
    assert.ok(tool, "supervisor_loop_exit must be registered on the plugin")

    const res = await tool.execute({}, { sessionID: SESSION_ID })
    assert.match(String(res.title), /Supervision loop ended/)

    const state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.loopExit.turnKey, TURN_ONE)
    assert.equal(state.loopExit.reason, "completed", "bare call must default to completed")
    assert.ok(Number.isFinite(state.loopExit.at))
  })

  test("idle stands down without injecting when the loopExit matches the turn", async () => {
    const msgs = makeMessages(TURN_ONE)
    const { client, activePrompts } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    await plugin.tool.supervisor_loop_exit.execute({ reason: "completed" }, { sessionID: SESSION_ID })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 1500))

    assert.equal(activePrompts().length, 0, "a declared loop exit must suppress every injection for that turn")
    // Plain return, NOT a counter saturation (AGENTS.md: eligibility gates must
    // not saturate). The gate is a pure function of persisted state, so it
    // re-derives for free on every idle of this turn.
    const state = sessionStore.load(tmpDir, SESSION_ID)
    assert.ok(!state.attempts || !state.attempts.count, "the loop-exit gate must not spend the attempt budget")
  })

  test("a STALE loopExit from a previous turn does not suppress the new turn", async () => {
    let msgs = makeMessages(TURN_ONE)
    const { client, activePrompts } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    await plugin.tool.supervisor_loop_exit.execute({ reason: "completed" }, { sessionID: SESSION_ID })
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).loopExit.turnKey, TURN_ONE)

    // The human speaks again → new turn key.
    msgs = makeMessages(TURN_TWO)
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 4000))

    assert.ok(activePrompts().length > 0, "a new human turn must be supervised again")
    assert.equal(
      sessionStore.load(tmpDir, SESSION_ID).loopExit,
      undefined,
      "the stale record must be cleared, not left to accumulate",
    )
  })

  test('reason="stuck" writes .supervisor/loop-exit.log', async () => {
    const msgs = makeMessages(TURN_ONE)
    const { client } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    await plugin.tool.supervisor_loop_exit.execute(
      { reason: "stuck", detail: "judge repeats the same demand" },
      { sessionID: SESSION_ID },
    )

    const logPath = join(tmpDir, ".supervisor", "loop-exit.log")
    assert.ok(existsSync(logPath), "a doom loop must leave forensic evidence")
    const lines = readFileSync(logPath, "utf-8").trim().split("\n")
    const rec = JSON.parse(lines[lines.length - 1])
    assert.equal(rec.session, SESSION_ID)
    assert.equal(rec.turnKey, TURN_ONE)
    assert.equal(rec.reason, "stuck")
    assert.equal(rec.detail, "judge repeats the same demand")
    assert.ok(Number.isFinite(rec.at))
  })

  test('reason="completed" does NOT write the log (it is not a pathology)', async () => {
    const msgs = makeMessages(TURN_ONE)
    const { client } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.tool.supervisor_loop_exit.execute({ reason: "completed" }, { sessionID: SESSION_ID })
    assert.equal(existsSync(join(tmpDir, ".supervisor", "loop-exit.log")), false)
  })

  test("the tool NEVER deletes an active goal (the autopilot_exit footgun)", async () => {
    const msgs = makeMessages(TURN_ONE)
    const { client } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    goalStore.setGoal(tmpDir, SESSION_ID, "ship the thing")

    await plugin.tool.supervisor_loop_exit.execute({ reason: "completed" }, { sessionID: SESSION_ID })
    let state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.goal?.condition, "ship the thing", "completed must leave the goal untouched")
    assert.equal(state.goal?.status, "active")

    await plugin.tool.supervisor_loop_exit.execute({ reason: "stuck", detail: "cannot proceed" }, { sessionID: SESSION_ID })
    state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.goal?.condition, "ship the thing", "stuck pauses the goal, it never destroys it")
    assert.equal(state.goal?.status, "paused")
  })

  test("supervisor_loop_exit does not touch autopilot state outside autopilot mode", async () => {
    // The predecessor `autopilot_exit` tool is gone (it was a second tool for
    // the same job and unconditionally called setAutopilot(false), which is
    // the footgun documented above). This pins that `supervisor_loop_exit`
    // itself only disarms autopilot when the session is actually in it.
    // setGoal() puts the session in 'goal' mode (autopilot: false) — NOT
    // autopilot mode — which is exactly the scenario the deleted tool got
    // wrong.
    const msgs = makeMessages(TURN_ONE)
    const { client } = createMockClient(() => msgs)
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    goalStore.setGoal(tmpDir, SESSION_ID, "ship the thing")
    assert.equal(plugin.tool.autopilot_exit, undefined, "the predecessor autopilot_exit tool must not be registered")

    const res = await plugin.tool.supervisor_loop_exit.execute({ reason: "completed" }, { sessionID: SESSION_ID })
    assert.match(String(res.title), /Supervision loop ended/)
    const state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.autopilot, false, "goal mode must never flip autopilot true from a loop-exit call")
    assert.equal(state.goal?.condition, "ship the thing", "the active goal must survive a loop-exit call outside autopilot")
  })
})

describe("the agent is told the tool exists", () => {
  test("every injected feedback message names supervisor_loop_exit", () => {
    const withDirective = buildEscalatingFeedback("high", { missing: ["do the thing"] })
    assert.match(withDirective, /supervisor_loop_exit/)
    const withoutDirective = buildEscalatingFeedback("high", { missing: ["do the thing"] }, { statusDirective: false })
    assert.match(withoutDirective, /supervisor_loop_exit/)
    assert.match(withoutDirective, /reason: completed \| stuck/)
  })
})
