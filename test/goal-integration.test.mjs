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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SupervisorPlugin } from "../opencode/supervisor-impl.ts"
import { writeProjectGoal, readProjectGoalHistory, readProjectGoalCondition, RUNAWAY_CEILING } from "../core/goal.mjs"
import { statePath, ensureSessionDir, sessionStore } from "../core/session-store.mjs"

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_goaltest123"
// The turn key of makeMessages()'s last real user message — what
// getLastRelevantUserMessageId() returns for it: `info.id`.
//
// This used to be the string `user:0:Fix the bug in auth.`, because
// getMessageSignature only checked a TOP-LEVEL `msg.id` — which opencode's
// REST transcript never has — and fell through to a lossy
// `${role}:${time}:${first 20 chars}` composite for every message. That made
// two human turns sharing a 20-character prefix share one turn key, and
// therefore one attempt budget. See test/goal-per-turn.test.mjs.
//
// Goal state written by a test that wants the per-turn attempt reset NOT to
// fire must stamp this as goal.lastTurnKey (and as attempts.turnKey).
const LAST_USER_MSG_ID = "msg_user_1"
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

    const result = await goalTool.execute({ condition: "all tests pass", source: "agent", acceptanceCriteria: "All tests pass", verification: "Run npm test" })
    assert.ok(typeof result === "string")
    assert.ok(result.includes("Goal set"), `Expected 'Goal set' in result, got: ${result}`)

    // Read state file
    const state = sessionStore.load(tmpDir, SESSION_ID)

    assert.equal(state.mode, undefined)
    assert.equal(state.goal.source, "agent")
    assert.equal(state.goal.acceptanceCriteria, "All tests pass")
    assert.equal(state.goal.verification, "Run npm test")
    assert.equal(state.goal.condition, "all tests pass")
    assert.equal(state.goal.status, "active")
    assert.equal(state.goal.attempts, 0)
    assert.equal(state.autopilot, undefined)
  })

  test("agent contracts stay session-only, require explicit replacement, and cannot replace user goals", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    const declare = args => plugin.tool.supervisor_goal.execute(args, { sessionID: SESSION_ID })
    const agent = { condition: "Fix auth", source: "agent", acceptanceCriteria: "Auth tests pass", verification: "Run auth tests" }
    assert.match(await declare(agent), /Goal set/)
    assert.equal(existsSync(join(tmpDir, ".agents", "supervisor", "Goal.md")), false)
    assert.match(await declare({ ...agent, condition: "Redirect auth" }), /FAILED/)
    assert.match(await declare({ ...agent, condition: "Redirect auth", replace: true }), /Goal set/)
    assert.match(await declare({ condition: "User scope", source: "user" }), /Goal set/)
    assert.match(await declare({ ...agent, replace: true }), /FAILED/)
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).goal.condition, "User scope")
  })

  test("retired supervisor goal alias cannot manufacture user authority", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.tool.supervisor_goal.execute({ condition: "User objective", source: "user" }, { sessionID: SESSION_ID })
    const original = sessionStore.load(tmpDir, SESSION_ID).goal
    for (const args of [{ clear: true }, { condition: "Unqualified replacement" }]) {
      const result = await plugin.tool.supervisor.execute({ action: "goal", ...args }, { sessionID: SESSION_ID })
      assert.match(result, /retired/)
      assert.deepEqual(sessionStore.load(tmpDir, SESSION_ID).goal, original)
      assert.equal(readProjectGoalCondition(tmpDir), "User objective")
    }
  })

  test("agent declaration cannot shadow a project-only user goal", async () => {
    writeProjectGoal(tmpDir, "User project objective")
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    const result = await plugin.tool.supervisor_goal.execute({ condition: "Easier objective", source: "agent", acceptanceCriteria: "Easy check", verification: "Inspect easy check" }, { sessionID: SESSION_ID })
    assert.match(result, /FAILED.*user-set project goal/)
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).goal, undefined)
    assert.equal(readProjectGoalCondition(tmpDir), "User project objective")
  })

  test("a project goal introduced during inference is protected", async () => {
    const { client } = createMockClient(makeMessages())
    const originalMessages = client.session.messages
    client.session.messages = async args => args.path.id === SESSION_ID ? originalMessages(args) : {
      data: [{ info: { role: "assistant", time: { completed: Date.now() } }, parts: [{ type: "text", text: JSON.stringify({ goal: "Inferred objective", falsifiable: true, acceptance_criteria: "Inferred checks pass", verification: "Run inferred checks" }) }] }],
    }
    client.session.promptAsync = async () => { writeProjectGoal(tmpDir, "New user project objective"); return {} }
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    const result = await plugin.tool.supervisor_goal.execute({}, { sessionID: SESSION_ID })
    assert.match(result, /FAILED to set derived goal.*user-set project goal/)
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).goal, undefined)
    assert.equal(readProjectGoalCondition(tmpDir), "New user project objective")
  })

  for (const busyInitially of [false, true]) test(`idle for a new human turn is not lost while an older audit is in flight (busy=${busyInitially})`, { timeout: 45_000 }, async () => {
    const { client, getActiveSessionPrompts, getEphemeralPrompts } = createMockClient(makeMessages())
    let current = makeMessages()
    const originalMessages = client.session.messages
    client.session.messages = async args => args.path.id === SESSION_ID ? { data: current } : originalMessages(args)
    let busy = busyInitially
    client.session.status = async () => ({ data: busy ? { [SESSION_ID]: { type: "busy" } } : {} })
    let begin, release
    const started = new Promise(resolve => { begin = resolve })
    const held = new Promise(resolve => { release = resolve })
    const originalPrompt = client.session.promptAsync
    let heldOnce = false
    client.session.promptAsync = async args => {
      if (args.path.id !== SESSION_ID && !heldOnce) { heldOnce = true; begin(); await held }
      return originalPrompt(args)
    }
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.tool.supervisor_goal.execute({ condition: "Fix auth and verify it", source: "user" }, { sessionID: SESSION_ID })
    const oldIdle = plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await started
    current = makeMessages().map((m, i) => ({ ...m, info: { ...m.info, id: i === 0 ? "msg_new_human_turn" : "msg_new_reply" } }))
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    release()
    await oldIdle
    if (busyInitially) {
      const auditsBeforeReplay = getEphemeralPrompts().length
      await new Promise(resolve => setTimeout(resolve, 1750))
      assert.equal(getEphemeralPrompts().length, auditsBeforeReplay, "queued idle must not audit an agent that is now busy")
      busy = false
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    }
    const deadline = Date.now() + 20_000
    while (!getActiveSessionPrompts().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(getActiveSessionPrompts().length, 1, "the newer idle must be replayed after discarding the stale audit")
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).attempts?.turnKey, "msg_new_human_turn")
  })

  test("judge outage cannot achieve or retire a goal", async () => {
    const { client, getActiveSessionPrompts } = createMockClient(makeMessages())
    client.session.create = async () => { throw new Error("judge unavailable") }
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.tool.supervisor_goal.execute({ condition: "Verify auth", source: "agent", acceptanceCriteria: "Auth tests pass", verification: "Run auth tests" }, { sessionID: SESSION_ID })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).goal?.status, "active")
    assert.equal(getActiveSessionPrompts().length, 0)
  })

  test("a failed project write is not reported as persistent success", async () => {
    writeFileSync(join(tmpDir, ".agents"), "not a directory")
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    const result = await plugin.tool.supervisor_goal.execute({ condition: "User contract", source: "user" }, { sessionID: SESSION_ID })
    assert.match(result, /Session goal set, but FAILED/)
    assert.equal(sessionStore.load(tmpDir, SESSION_ID).goal?.status, "active")
  })

  test("paused and cleared session goals do not reactivate through stale project fallback", async () => {
    const { client, getEphemeralPrompts, getActiveSessionPrompts } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.tool.supervisor_goal.execute({ condition: "Stale project goal", source: "user" }, { sessionID: SESSION_ID })
    sessionStore.mutate(tmpDir, SESSION_ID, s => { s.goal.status = "paused" })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    assert.equal(getEphemeralPrompts().length, 0)
    await plugin.tool.supervisor_goal.execute({ clear: true, source: "user" }, { sessionID: SESSION_ID })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    assert.equal(getEphemeralPrompts().length, 0)
    assert.equal(getActiveSessionPrompts().length, 0)
  })

  test("goal clear leaves a tombstone and no execution mode", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Set currentSessionId
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    const goalTool = plugin.tool.supervisor_goal

    // Set a user goal first.
    await goalTool.execute({ condition: "all tests pass", source: "user" })

    // Clear the goal
    const result = await goalTool.execute({ clear: true, source: "user" })
    assert.ok(result.includes("cleared"), `Expected 'cleared' in result, got: ${result}`)

    // Read state file
    const state = sessionStore.load(tmpDir, SESSION_ID)

    assert.equal(state.mode, undefined)
    assert.equal(state.goal, undefined)
    assert.equal(state.goalCleared, true)
    assert.equal(state.autopilot, undefined)
  })

  test("goal status returns current condition when goal active", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Set currentSessionId
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    const goalTool = plugin.tool.supervisor_goal

    // Set a user goal.
    await goalTool.execute({ condition: "all tests pass", source: "user" })

    // Check status (no condition, no clear)
    const result = await goalTool.execute({})
    assert.ok(result.includes("all tests pass"), `Expected condition in status, got: ${result}`)
    assert.ok(result.includes("active"), `Expected 'active' in status, got: ${result}`)
  })

  test("obsolete mode:'goal' reports removal and keeps the goal", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })

    // Set a goal first.
    await plugin.tool.supervisor_goal.execute({ condition: "all tests pass", source: "user" })

    // 'goal' is no longer a mode — the supervisor tool must accept it as a
    // deprecated alias that maps to reflection and KEEPS the goal.
    const result = await plugin.tool.supervisor.execute({ mode: "goal" }, { sessionID: SESSION_ID })
    assert.match(result, /removed/i)

    const state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.mode, undefined)
    assert.equal(state.goal?.condition, "all tests pass", "the deprecated alias must KEEP the goal")
    assert.equal(state.goal?.status, "active")
  })

  test("legacy flags cannot bypass the judge; both judge and continuation contain the contract", async () => {
    const messages = makeMessages()
    const { client, getEphemeralPrompts, getActiveSessionPrompts } = createMockClient(messages)

    // autopilot + an active goal: the goal rides along as CONTEXT (never
    // verified — autopilot runs no judge; accepted reduction in guarantee).
    ensureSessionDir(tmpDir, SESSION_ID)
    writeFileSync(
      statePath(tmpDir, SESSION_ID),
      JSON.stringify({
        mode: "autopilot",
        autopilot: true,
        goal: {
          condition: "all integration tests are green",
          acceptanceCriteria: "Every integration test passes with exit code 0",
          verification: "Run the integration suite and inspect the results",
          status: "active",
          attempts: 0,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() + 3600000,
          lastReason: "",
          lastTurnKey: LAST_USER_MSG_ID
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise(r => setTimeout(r, 5000))

    assert.ok(getEphemeralPrompts().length > 0, "legacy flags must not bypass the judge")
    const activePrompts = getActiveSessionPrompts()
    assert.ok(activePrompts.length > 0)
    for (const prompt of [getEphemeralPrompts()[0], activePrompts.at(-1)]) {
      const text = prompt.body.parts[0].text
      assert.match(text, /all integration tests are green/)
      assert.match(text, /Every integration test passes with exit code 0/)
      assert.match(text, /Run the integration suite/)
    }
  })

  test("session.idle with active goal in reflection injects goal into judge prompt", async () => {
    const messages = makeMessages()
    const { client, getEphemeralPrompts } = createMockClient(messages)

    // Canonical two-modes state: reflection + an active goal (a goal is an
    // orthogonal attribute now, not a mode). The judge must grade against it.
    ensureSessionDir(tmpDir, SESSION_ID)
    writeFileSync(
      statePath(tmpDir, SESSION_ID),
      JSON.stringify({
        mode: "reflection",
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

  // The attempts cap is a PER-HUMAN-TURN stand-down, not the end of the goal.
  // (It used to permanently exhaust the goal and revert to reflection — which
  // silently killed goals mid-session with no verdict. That behavior now
  // belongs to the deadline alone; see the next test.)
  test("goal loop stands down for the turn at maxAttempts but stays active", async () => {
    const messages = makeMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages)

    // Write goal state with the per-turn attempt counter already at the
    // runaway ceiling (RUNAWAY_CEILING) for the CURRENT turn, so the breaker
    // is genuinely tripped.
    //
    // `state.attempts` is THE counter — `goal.attempts` is only a mirror of it
    // (see the mirroring block in opencode/supervisor-impl.ts and the identical
    // one in bin/supervisor-on-stop.mjs). Seeding `goal.attempts` alone would
    // no longer spend anything: two independently-incremented counts for one
    // budget was bug #57, and the file counter always tripped first, so
    // decideGoalTransition's `reason:'attempts'` branch could never fire.
    ensureSessionDir(tmpDir, SESSION_ID)
    writeFileSync(
      statePath(tmpDir, SESSION_ID),
      JSON.stringify({
        mode: "goal",
        autopilot: false,
        attempts: { count: RUNAWAY_CEILING, turnKey: LAST_USER_MSG_ID, lastIso: new Date().toISOString() },
        goal: {
          condition: "all tests pass",
          status: "active",
          attempts: RUNAWAY_CEILING,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() + 3600000,
          lastReason: "",
          lastTurnKey: LAST_USER_MSG_ID
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Fire session.idle
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })

    // Wait for async processing
    await new Promise(r => setTimeout(r, 5000))

    const state = sessionStore.load(tmpDir, SESSION_ID)

    assert.equal(state.goal.status, "active", `Goal must stay active at the per-turn cap, got: ${state.goal.status}`)
    assert.equal(state.mode, undefined, "legacy mode must be discarded")

    // No continuation should have been injected to the active session
    const activePrompts = getActiveSessionPrompts()
    assert.equal(activePrompts.length, 0, `No prompt should be sent to active session once the turn budget is spent, got ${activePrompts.length}`)
  })

  // -------------------------------------------------------------------------
  // Coverage for the per-turn attempts reset in opencode/supervisor-impl.ts.
  // The two tests above deliberately stamp lastTurnKey to the CURRENT turn so
  // the reset does NOT fire — which left the reset block itself untested. Here
  // the stored lastTurnKey belongs to an OLDER turn, so the reset must fire:
  // an over-cap goal is rescued instead of standing down, and a continuation
  // is injected. Reverting the reset block makes this test fail.
  // -------------------------------------------------------------------------
  test("stale lastTurnKey resets the spent attempt budget and the goal continues", async () => {
    const messages = makeMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages)

    ensureSessionDir(tmpDir, SESSION_ID)
    writeFileSync(
      statePath(tmpDir, SESSION_ID),
      JSON.stringify({
        mode: "goal",
        autopilot: false,
        goal: {
          condition: "all tests pass",
          status: "active",
          attempts: RUNAWAY_CEILING,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() + 3600000,
          lastReason: "",
          lastTurnKey: "stale-turn-key-from-a-previous-turn"
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise(r => setTimeout(r, 5000))

    const state = sessionStore.load(tmpDir, SESSION_ID)

    assert.equal(state.goal.status, "active", `Goal must stay active after the per-turn reset, got: ${state.goal.status}`)
    assert.equal(state.mode, undefined)
    assert.equal(
      state.goal.lastTurnKey,
      LAST_USER_MSG_ID,
      `lastTurnKey must be restamped to the current turn, got: ${state.goal.lastTurnKey}`
    )
    assert.equal(
      state.goal.attempts,
      1,
      `attempts must reset to 0 then increment for this attempt, got: ${state.goal.attempts}`
    )

    const activePrompts = getActiveSessionPrompts()
    assert.ok(
      activePrompts.length > 0,
      `A continuation must be injected once the budget resets, got ${activePrompts.length} prompts`
    )
  })

  test("goal loop exhausts for real once the deadline passes", async () => {
    const messages = makeMessages()
    const { client, getActiveSessionPrompts } = createMockClient(messages)

    ensureSessionDir(tmpDir, SESSION_ID)
    writeFileSync(
      statePath(tmpDir, SESSION_ID),
      JSON.stringify({
        mode: "goal",
        autopilot: false,
        goal: {
          condition: "all tests pass",
          status: "active",
          attempts: 0,
          tokenBaseline: 0,
          startedAt: Date.now() - 10000,
          deadline: Date.now() - 1,
          lastReason: "",
          lastTurnKey: LAST_USER_MSG_ID
        }
      })
    )

    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise(r => setTimeout(r, 5000))

    const state = sessionStore.load(tmpDir, SESSION_ID)

    assert.equal(state.goal.status, "exhausted", `Goal should be exhausted past its deadline, got: ${state.goal.status}`)
    assert.equal(state.mode, undefined)

    const activePrompts = getActiveSessionPrompts()
    assert.equal(activePrompts.length, 0, `No prompt should be sent to active session after exhaustion, got ${activePrompts.length}`)
  })

  // -------------------------------------------------------------------------
  // Concurrency regression (issue #40): executeSupervisorGoal used to persist
  // .agents/supervisor/Goal.md via a bare writeFileSync overwrite with no
  // history — two racing goal-set calls against the same project directory
  // would silently destroy one another. Both runtime surfaces (this OpenCode
  // tool AND bin/supervisor-goal.mjs for Claude Code) now delegate the write
  // to the shared, atomic-rename + append-only-history writeProjectGoal() in
  // core/goal.mjs.
  //
  // NOTE on what this test does and does NOT prove: writeProjectGoal is fully
  // synchronous and JS is single-threaded, so a Promise.all over two
  // in-process calls can never actually interleave inside writeProjectGoal
  // itself — this is a wiring/plumbing check ("the OpenCode tool really does
  // call the shared safe writer for both calls"), not an independent proof
  // that concurrent writes are safe. That proof — real racing OS processes,
  // the scenario that actually reproduced issue #40 (30 concurrent calls, 29
  // lost) — lives in goal-core.test.mjs's spawn-based test. Keep both: this
  // one guards against the OpenCode surface regressing back to an inline
  // writeFileSync; that one guards the safety mechanism itself.
  // -------------------------------------------------------------------------
  test("executeSupervisorGoal wiring: concurrent calls both delegate to the shared safe writer (not a cross-process concurrency proof — see goal-core.test.mjs for that)", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })
    const goalTool = plugin.tool.supervisor_goal

    const conditions = ["race-condition-A", "race-condition-B"]
    const results = await Promise.all(conditions.map((c) => goalTool.execute({ condition: c, source: "user" })))
    for (const [i, r] of results.entries()) {
      assert.ok(r.includes(conditions[i]), `Result ${i} should echo its own condition, got: ${r}`)
    }

    const goalMdPath = join(tmpDir, ".agents", "supervisor", "Goal.md")
    const goalMd = readProjectGoalCondition(tmpDir)
    assert.ok(conditions.includes(goalMd), `Goal.md current pointer must be one of the raced conditions, got: ${JSON.stringify(goalMd)}`)

    const history = readProjectGoalHistory(tmpDir)
    const recovered = new Set(history.map((h) => h.condition))
    for (const c of conditions) {
      assert.ok(recovered.has(c), `Condition "${c}" must be recoverable from goal-history.jsonl — lost it would reproduce issue #40`)
    }
  })

  // -------------------------------------------------------------------------
  // Behavior-divergence regression (found in code review of the fix above):
  // executeSupervisorGoal's condition had no length cap, while the CC CLI
  // path (parseSupervisorCommand) already truncates to GOAL_CONDITION_MAX_LEN
  // (4000). writeProjectGoal ALSO truncates internally (defense in depth) —
  // for a >4000-char condition on the OpenCode surface, that meant session
  // state (supervisorStore, via setGoal) and the tool's reply string kept the
  // FULL condition while Goal.md/goal-history.jsonl silently got the
  // truncated one: three "sources of truth" disagreeing. Fixed by truncating
  // once in executeSupervisorGoal, before the condition fans out to setGoal,
  // writeProjectGoal, and the reply. This test proves all three now agree.
  // -------------------------------------------------------------------------
  test("long condition: session state, Goal.md, history, and reply all agree on the same truncated value", async () => {
    const { client } = createMockClient(makeMessages())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin["tool.execute.before"]({ tool: "supervisor_goal", sessionID: SESSION_ID })
    const goalTool = plugin.tool.supervisor_goal

    const longCondition = "x".repeat(5000)
    const expected = longCondition.slice(0, 4000)
    const result = await goalTool.execute({ condition: longCondition, source: "user" })
    assert.ok(result.includes(expected), "Reply must echo the truncated condition")
    assert.ok(!result.includes(longCondition), "Reply must NOT echo the untruncated condition")

    const state = sessionStore.load(tmpDir, SESSION_ID)
    assert.equal(state.goal.condition, expected, "Session state must store the truncated condition, matching Goal.md/history")

    const goalMdPath = join(tmpDir, ".agents", "supervisor", "Goal.md")
    const goalMd = readProjectGoalCondition(tmpDir)
    assert.equal(goalMd, expected, "Goal.md must hold the truncated condition")

    const history = readProjectGoalHistory(tmpDir)
    assert.equal(history.at(-1).condition, expected, "goal-history.jsonl's latest entry must hold the truncated condition")
  })
})
