/**
 * status-goal-composition.test.mjs — the invariants that only break when the
 * status-directive feature and the goal-lifecycle / stand-down fixes are
 * merged TOGETHER.
 *
 * Every case here passes on each branch in isolation and fails on the naive
 * union of the two. They are semantic conflicts, so no textual merge conflict
 * marks them and nothing else in the suite covers them.
 *
 * Run: node --experimental-strip-types --test test/status-goal-composition.test.mjs
 */

import { describe, test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

import { buildEscalatingFeedback, hasFeedbackBody, isActionlessVerdict } from "../core/feedback.mjs"
import {
  STATUS_DIRECTIVE_MARKER,
  STATUS_DIAGRAM_DIRECTIVE,
  stripStatusDirective,
} from "../core/status-directive.mjs"
import { SupervisorPlugin } from "../opencode/supervisor-impl.ts"
import { sessionStore } from "../core/session-store.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const ACTIVE_SESSION_ID = "ses_composition123"

// ---------------------------------------------------------------------------
// 1. The directive must not smuggle a body into an empty message.
// ---------------------------------------------------------------------------

describe("empty-body guard survives the always-appended directive", () => {
  test("stripStatusDirective removes the directive and everything after it", () => {
    assert.equal(stripStatusDirective(`body\n\n${STATUS_DIAGRAM_DIRECTIVE}`), "body\n\n")
    assert.equal(stripStatusDirective("no directive here"), "no directive here")
    assert.equal(stripStatusDirective(undefined), "")
    assert.equal(stripStatusDirective(null), "")
    assert.equal(stripStatusDirective(12), "")
  })

  test("REGRESSION: an actionless verdict still renders an empty body once the directive is appended", () => {
    const rendered = buildEscalatingFeedback("MEDIUM", { missing: [], next_actions: [], feedback: "" })
    // The directive IS there — this is not a test that it was removed.
    assert.ok(rendered.includes(STATUS_DIRECTIVE_MARKER), "directive must still be appended by default")
    // ...and the guard must still see through it. Without stripStatusDirective
    // the directive's own lines count as content, hasFeedbackBody can never
    // return false, and the last-resort empty-injection guard is dead code.
    assert.equal(hasFeedbackBody(rendered), false)
  })

  test("REGRESSION: a standing-goal-only verdict is still bodyless with the directive appended", () => {
    const rendered = buildEscalatingFeedback("MEDIUM",
      { missing: [], next_actions: [], feedback: "", goal_condition: "Reach $1,000 MRR" })
    assert.ok(rendered.includes(STATUS_DIRECTIVE_MARKER))
    assert.equal(hasFeedbackBody(rendered), false, "a standing goal is context, not a body")
  })

  test("a real verdict still has a body", () => {
    const rendered = buildEscalatingFeedback("MEDIUM", { missing: ["Run tests"], next_actions: [], feedback: "" })
    assert.equal(hasFeedbackBody(rendered), true)
  })

  test("the two guards agree: actionless verdict <-> bodyless render", () => {
    const verdict = { missing: [], next_actions: [], feedback: "" }
    assert.equal(isActionlessVerdict(verdict), true)
    assert.equal(hasFeedbackBody(buildEscalatingFeedback("LOW", verdict)), false)
  })
})

// ---------------------------------------------------------------------------
// 2. /supervisor:status off must silence BOTH continuation paths, not one.
// ---------------------------------------------------------------------------

describe("statusDirective opt-out reaches the reflection path", () => {
  const verdict = { missing: ["Run tests"], next_actions: [], feedback: "build is red" }

  test("default is ON (absent option) — the directive is appended", () => {
    assert.ok(buildEscalatingFeedback("HIGH", verdict).includes(STATUS_DIRECTIVE_MARKER))
    assert.ok(buildEscalatingFeedback("HIGH", verdict, {}).includes(STATUS_DIRECTIVE_MARKER))
    assert.ok(
      buildEscalatingFeedback("HIGH", verdict, { statusDirective: true }).includes(STATUS_DIRECTIVE_MARKER)
    )
  })

  test("statusDirective:false omits it but keeps the whole verdict intact", () => {
    const out = buildEscalatingFeedback("HIGH", verdict, { statusDirective: false })
    assert.ok(!out.includes(STATUS_DIRECTIVE_MARKER), "directive must be absent")
    assert.match(out, /Task Incomplete/)
    assert.match(out, /build is red/)
    assert.match(out, /Run tests/)
    assert.equal(hasFeedbackBody(out), true)
  })

  test("only an explicit false disables it — undefined/null keep it on (default-ON flag)", () => {
    assert.ok(buildEscalatingFeedback("HIGH", verdict, { statusDirective: undefined }).includes(STATUS_DIRECTIVE_MARKER))
    assert.ok(buildEscalatingFeedback("HIGH", verdict, { statusDirective: null }).includes(STATUS_DIRECTIVE_MARKER))
  })

  test("both runtimes pass the gate through, rather than hard-coding it on", async () => {
    const cc = await readFile(join(ROOT, "bin", "supervisor-on-stop.mjs"), "utf-8")
    assert.ok(
      /statusDirective:\s*isStatusDiagramEnabled\(/.test(cc),
      "Claude Code hook must pass isStatusDiagramEnabled into buildEscalatingFeedback"
    )
    const oc = await readFile(join(ROOT, "opencode", "supervisor-impl.ts"), "utf-8")
    assert.ok(
      /statusDirective:\s*isStatusDiagramEnabled\(/.test(oc),
      "opencode runtime must pass isStatusDiagramEnabled into buildEscalatingFeedback"
    )
    assert.ok(
      /isStatusDiagramEnabled\(sup\)\s*\?\s*appendStatusDirective\(baseNudgeWithGoal\)/.test(oc),
      "opencode autopilot nudge must honour the same toggle the CC nudge does"
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Plugin-level composition, driven through the real runtime.
// ---------------------------------------------------------------------------

function makeMessages(userText = "Fix the bug in auth.ts and run tests", cwd) {
  return [
    {
      info: { role: "user", id: "msg_user_1", time: { created: Date.now() - 5000 } },
      parts: [{ type: "text", text: userText }],
    },
    {
      info: {
        role: "assistant",
        id: "msg_asst_1",
        providerID: "anthropic",
        modelID: "claude-opus-4.6",
        time: { created: Date.now() - 4800, completed: Date.now() - 1000 },
        ...(cwd ? { path: { cwd, root: cwd } } : {}),
      },
      parts: [{ type: "text", text: "Done." }],
    },
  ]
}

function completeAssessment() {
  return JSON.stringify({
    status: "complete",
    confidence: 0.95,
    remaining_work: [],
    needs_user_action: [],
    next_steps: [],
    stuck: false,
    evidence: { tests: {}, build: {}, pr: {} },
  })
}

function incompleteAssessment() {
  return JSON.stringify({
    status: "in_progress",
    confidence: 0.4,
    remaining_work: ["Apply the fix to auth.ts"],
    needs_user_action: [],
    next_steps: ["Edit auth.ts"],
    stuck: false,
    evidence: { tests: {}, build: {}, pr: {} },
  })
}

function createMockClient(messages, assessmentResponse) {
  const promptCalls = []
  const responseMap = new Map()
  let ephemeral = 0
  const client = {
    session: {
      create: async () => ({ data: { id: `ses_judge_comp_${++ephemeral}` } }),
      get: async ({ path }) => ({ data: { id: path.id } }), // root session, no parentID
      messages: async ({ path }) => {
        if (path.id === ACTIVE_SESSION_ID) return { data: messages }
        const response = responseMap.get(path.id)
        if (!response) return { data: [] }
        return {
          data: [
            { info: { role: "user", id: "j1" }, parts: [{ type: "text", text: "assess" }] },
            {
              info: { role: "assistant", id: "j2", time: { completed: Date.now() } },
              parts: [{ type: "text", text: response }],
            },
          ],
        }
      },
      promptAsync: async ({ path, body }) => {
        promptCalls.push({ sessionId: path.id, text: body?.parts?.[0]?.text || "" })
        if (path.id !== ACTIVE_SESSION_ID) {
          const text = body?.parts?.[0]?.text || ""
          if (text.includes("CLASSIFY TASK ROUTING")) responseMap.set(path.id, JSON.stringify({ category: "backend" }))
          else if (text.includes("REVIEW SUPERVISOR COMPLETION")) responseMap.set(path.id, "Looks good.")
          else responseMap.set(path.id, assessmentResponse)
        }
        return {}
      },
      delete: async () => ({}),
    },
    toast: { create: async () => ({}) },
  }
  return { client, activePrompts: () => promptCalls.filter((c) => c.sessionId === ACTIVE_SESSION_ID) }
}

function writeState(dir, sessionId, state) {
  mkdirSync(join(dir, ".supervisor", "goals"), { recursive: true })
  writeFileSync(join(dir, ".supervisor", "goals", `${sessionId}.json`), JSON.stringify(state))
}

function readState(dir, sessionId) {
  return sessionStore.load(dir, sessionId)
}

describe("autopilot nudge honours /supervisor:status off (opencode runtime)", () => {
  let tmpDir
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-comp-autopilot-"))
  })

  test("default-on: the nudge carries the directive", async () => {
    writeState(tmpDir, ACTIVE_SESSION_ID, { mode: "autopilot", autopilot: true })
    const { client, activePrompts } = createMockClient(makeMessages(), incompleteAssessment())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 400))
    const nudge = activePrompts()[0]?.text || ""
    assert.match(nudge, /Autopilot/)
    assert.ok(nudge.includes(STATUS_DIRECTIVE_MARKER), "default-on nudge must carry the directive")
  })

  test("statusDiagram:false: the nudge is still sent, without the directive", async () => {
    writeState(tmpDir, ACTIVE_SESSION_ID, { mode: "autopilot", autopilot: true, statusDiagram: false })
    const { client, activePrompts } = createMockClient(makeMessages(), incompleteAssessment())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 400))
    const nudge = activePrompts()[0]?.text || ""
    assert.match(nudge, /Autopilot/, "the nudge itself must still be sent — only the directive is suppressed")
    assert.match(nudge, /supervisor_loop_exit/)
    assert.ok(!nudge.includes(STATUS_DIRECTIVE_MARKER), "toggle off must suppress the directive")
  })
})

describe("system-prompt gate resolves the session directory without a warm cache", () => {
  let serverDir
  let projectDir

  beforeEach(() => {
    serverDir = mkdtempSync(join(tmpdir(), "sup-comp-server-"))
    projectDir = mkdtempSync(join(tmpdir(), "sup-comp-project-"))
  })

  async function transform(plugin, sessionID) {
    const output = { system: ["base prompt"] }
    await plugin["experimental.chat.system.transform"]({ sessionID }, output)
    return output.system
  }

  test("REGRESSION: a session disabled in ITS OWN project is honoured by a cold (restarted) plugin", async () => {
    // Session state lives under the SERVER dir; the disabled flag lives under
    // the session's own PROJECT dir. Persisted projectDir is the only link
    // between them once the in-memory cache is gone.
    writeState(serverDir, ACTIVE_SESSION_ID, { projectDir })
    mkdirSync(join(projectDir, ".supervisor"), { recursive: true })
    writeFileSync(join(projectDir, ".supervisor", "disabled"), `${ACTIVE_SESSION_ID}\n`)

    const { client } = createMockClient(makeMessages("hi", projectDir), completeAssessment())
    // Fresh plugin instance == cold sessionDirCache == the state after a
    // server restart. Before the fix this read serverDir/.supervisor/disabled,
    // found nothing, and injected into a session the user had disabled.
    const plugin = await SupervisorPlugin({ client, directory: serverDir })
    const system = await transform(plugin, ACTIVE_SESSION_ID)
    assert.ok(!system.some((s) => s.includes(STATUS_DIRECTIVE_MARKER)), "disabled session must not receive the directive")
  })

  test("control: the same cold plugin DOES inject for an enabled session", async () => {
    writeState(serverDir, ACTIVE_SESSION_ID, { projectDir })
    const { client } = createMockClient(makeMessages("hi", projectDir), completeAssessment())
    const plugin = await SupervisorPlugin({ client, directory: serverDir })
    const system = await transform(plugin, ACTIVE_SESSION_ID)
    assert.ok(system.some((s) => s.includes(STATUS_DIRECTIVE_MARKER)), "enabled session must receive the directive")
  })

  test("statusDiagram:false suppresses it regardless of directory resolution", async () => {
    writeState(serverDir, ACTIVE_SESSION_ID, { projectDir, statusDiagram: false })
    const { client } = createMockClient(makeMessages("hi", projectDir), completeAssessment())
    const plugin = await SupervisorPlugin({ client, directory: serverDir })
    const system = await transform(plugin, ACTIVE_SESSION_ID)
    assert.ok(!system.some((s) => s.includes(STATUS_DIRECTIVE_MARKER)))
  })

  test("no sessionID (opencode's internal agent-config calls) never injects", async () => {
    const { client } = createMockClient(makeMessages(), completeAssessment())
    const plugin = await SupervisorPlugin({ client, directory: serverDir })
    assert.deepEqual(await transform(plugin, undefined), ["base prompt"])
    assert.deepEqual(await transform(plugin, ""), ["base prompt"])
  })

  test("runSupervisor persists projectDir so the NEXT process can resolve it", async () => {
    const { client } = createMockClient(makeMessages("Fix auth.ts and run tests", projectDir), completeAssessment())
    const plugin = await SupervisorPlugin({ client, directory: serverDir })
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: ACTIVE_SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(
      readState(serverDir, ACTIVE_SESSION_ID).projectDir,
      projectDir,
      "the session -> project mapping must be durable, not cache-only"
    )
  })
})

describe("completion path: goal retirement and status correction do not step on each other", () => {
  test("retirement runs BEFORE the status correction's early return (source order)", async () => {
    const src = await readFile(join(ROOT, "opencode", "supervisor-impl.ts"), "utf-8")
    const completeIdx = src.indexOf("if (analysis.complete) {")
    assert.ok(completeIdx > -1, "completion branch not found")
    const tail = src.slice(completeIdx)
    const retireIdx = tail.indexOf("opencode:project-goal-achieved")
    const correctionIdx = tail.indexOf("statusCorrectionSent.get(sessionId)")
    const earlyReturnIdx = tail.indexOf("if (correctionInjected) {")
    assert.ok(retireIdx > -1, "project-goal retirement missing from the completion path")
    assert.ok(correctionIdx > -1, "status-compliance correction missing from the completion path")
    assert.ok(earlyReturnIdx > -1, "status-correction early return missing")
    assert.ok(
      retireIdx < correctionIdx && retireIdx < earlyReturnIdx,
      "goal retirement must run before the status correction can early-return, or an achieved goal survives forever"
    )
  })

  test("both runtimes still reach retireProjectGoal on the complete path", async () => {
    const oc = await readFile(join(ROOT, "opencode", "supervisor-impl.ts"), "utf-8")
    assert.ok(oc.includes("opencode:project-goal-achieved"))
    assert.ok(oc.includes("opencode:session-goal-achieved"))
    const cc = await readFile(join(ROOT, "bin", "supervisor-on-stop.mjs"), "utf-8")
    assert.ok(cc.includes("claude-code:project-goal-achieved"))
    assert.ok(cc.includes("claude-code:session-goal-achieved"))
  })
})

describe("supervisor toggle: off/on still wins over mode after the status branch merge", () => {
  let tmpDir
  let toggle

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-comp-toggle-"))
    const { client } = createMockClient(makeMessages("hi", tmpDir), completeAssessment())
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })
    toggle = plugin.tool.supervisor.execute
  })

  test('action:"off" with filler mode still disables (mode must not swallow it)', async () => {
    const out = await toggle({ action: "off", mode: "" }, { sessionID: ACTIVE_SESSION_ID })
    assert.match(out, /disabled/i)
    assert.ok(!/FAILED/.test(out), out)
    assert.match(readFileSync(join(tmpDir, ".supervisor", "disabled"), "utf-8"), new RegExp(ACTIVE_SESSION_ID))
  })

  test('action:"off" alongside a REAL mode applies both axes, and off still wins', async () => {
    const out = await toggle({ action: "off", mode: "autopilot" }, { sessionID: ACTIVE_SESSION_ID })
    assert.match(out, /disabled/i)
    assert.match(out, /Mode also set to autopilot/)
    assert.match(readFileSync(join(tmpDir, ".supervisor", "disabled"), "utf-8"), new RegExp(ACTIVE_SESSION_ID))
  })

  test('"status off" toggles the DIRECTIVE only — it must never disable the supervisor', async () => {
    const out = await toggle({ action: "status off" }, { sessionID: ACTIVE_SESSION_ID })
    assert.match(out, /DISABLED/)
    assert.match(out, /Status checkpoint/)
    assert.equal(readState(tmpDir, ACTIVE_SESSION_ID).statusDiagram, false)
    assert.ok(
      !existsSync(join(tmpDir, ".supervisor", "disabled")),
      "`status off` must not add the session to .supervisor/disabled"
    )
  })

  test('"status on" re-enables the directive without touching the enable axis', async () => {
    await toggle({ action: "status off" }, { sessionID: ACTIVE_SESSION_ID })
    const out = await toggle({ action: "status on" }, { sessionID: ACTIVE_SESSION_ID })
    assert.match(out, /ENABLED/)
    assert.equal(readState(tmpDir, ACTIVE_SESSION_ID).statusDiagram, true)
    assert.ok(!existsSync(join(tmpDir, ".supervisor", "disabled")))
  })

  test("status report renders the directive state and does not mutate anything", async () => {
    const out = await toggle({ action: "status" }, { sessionID: ACTIVE_SESSION_ID })
    assert.match(out, /status directive: on/)
    assert.match(out, /enabled: yes/)
  })
})
