/**
 * supervisor-gates.test.mjs — the two "should the supervisor run at all" gates.
 *
 * Both bugs covered here are the highest-volume misfires in a 30-day forensic
 * sample of real sessions (see .scratch/supervisor-misfires.md):
 *
 *   BUG A — the supervisor fired inside delegated subagent sessions:
 *           633 of 962 injections (66%). Read-only audit subagents were pushed
 *           to open PRs and pull credentials; every observed injection loop
 *           lived in one.
 *   BUG B — `/supervisor off` was a silent no-op: 3 of 5 real off-attempts
 *           never persisted because the `mode` branch was evaluated before the
 *           `action` branch and early-returned. One off-request was converted
 *           into `mode: autopilot`.
 *
 * Nothing in the plugin itself is mocked — the real SupervisorPlugin is
 * instantiated and its real tools/event handler are driven. Only the opencode
 * client (an external HTTP dependency) is stubbed, matching the pattern in
 * test/goal-integration.test.mjs.
 *
 * Run: node --experimental-strip-types --test test/supervisor-gates.test.mjs
 */

import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  SupervisorPlugin,
  isSubagentSession,
  normalizeOptionalArg,
  loadConfiguredSuperviseSubagents,
} from "../opencode/supervisor-impl.ts"

const SESSION_ID = "ses_gatetest123456"
const PARENT_SESSION_ID = "ses_gateparent7890"

// ---------------------------------------------------------------------------
// Client stub
// ---------------------------------------------------------------------------

function makeMessages() {
  return [
    {
      info: { role: "user", id: "msg_user_1", time: { created: Date.now() - 5000, completed: Date.now() - 4900 } },
      parts: [{ type: "text", text: "Fix the bug in auth." }],
    },
    {
      info: {
        role: "assistant",
        id: "msg_asst_1",
        time: { created: Date.now() - 3000, completed: Date.now() - 2000 },
        path: { cwd: null },
      },
      parts: [{ type: "text", text: "I looked at the file." }],
    },
  ]
}

/**
 * @param {object} opts
 * @param {string|undefined} opts.parentID - parentID returned by session.get for SESSION_ID.
 *   Undefined = root session (the live API omits the key entirely for roots).
 * @param {boolean} opts.withSessionGet - false simulates an SDK with no session.get.
 */
function createStubClient({ parentID, withSessionGet = true, messages = makeMessages() } = {}) {
  const promptCalls = []
  const sessionGetCalls = []
  const responseMap = new Map()
  let ephemeralCounter = 0

  // A "task complete" verdict, so runSupervisor terminates promptly instead of
  // sitting in its 120s judge poll and holding the test process open.
  const COMPLETE_VERDICT = JSON.stringify({
    complete: true,
    confidence: 0.95,
    summary: "Done.",
    evidence: { tests_passing: true, build_passing: true, pr_opened: false },
    missing: [],
    next_actions: [],
  })

  const session = {
    create: async () => ({ data: { id: `ses_judge_gate_${++ephemeralCounter}` } }),
    messages: async ({ path }) => {
      if (path.id === SESSION_ID) return { data: messages }
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
      promptCalls.push({ sessionId: path.id, body: { ...body } })
      if (path.id !== SESSION_ID) {
        const text = body?.parts?.[0]?.text || ""
        if (text.includes("CLASSIFY TASK ROUTING")) responseMap.set(path.id, JSON.stringify({ category: "backend" }))
        else if (text.includes("REVIEW SUPERVISOR COMPLETION")) responseMap.set(path.id, "Looks complete.")
        else responseMap.set(path.id, COMPLETE_VERDICT)
      }
      return {}
    },
    delete: async () => ({}),
  }
  if (withSessionGet) {
    session.get = async ({ path }) => {
      sessionGetCalls.push(path.id)
      // The live API omits `parentID` entirely on a root session.
      return { data: parentID ? { id: path.id, parentID } : { id: path.id } }
    }
  }

  return {
    client: { session, toast: { create: async () => ({}) }, tui: { publish: async () => ({}) } },
    getPromptCalls: () => promptCalls,
    getSessionGetCalls: () => sessionGetCalls,
  }
}

function writeActiveGoal(dir, sessionId) {
  mkdirSync(join(dir, ".supervisor", "goals"), { recursive: true })
  writeFileSync(
    join(dir, ".supervisor", "goals", `${sessionId}.json`),
    JSON.stringify({
      mode: "goal",
      autopilot: false,
      goal: {
        condition: "all tests pass",
        status: "active",
        attempts: 0,
        tokenBaseline: 0,
        startedAt: Date.now() - 10_000,
        deadline: Date.now() + 3_600_000,
        lastReason: "",
      },
    })
  )
}

function readDisabled(dir) {
  const p = join(dir, ".supervisor", "disabled")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean)
}

function readMode(dir, sessionId) {
  const p = join(dir, ".supervisor", "goals", `${sessionId}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")).mode ?? null
}

/**
 * Poll until the supervisor has issued at least one prompt (i.e. supervision
 * actually started). Used for the POSITIVE cases so the test does not have to
 * sit through runSupervisor's 120s judge poll, which never completes against a
 * stub that returns no verdict.
 */
async function waitForPrompts(getPromptCalls, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (getPromptCalls().length > 0) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

// ---------------------------------------------------------------------------
// BUG A — subagent gate
// ---------------------------------------------------------------------------

describe("BUG A: supervisor must not run inside delegated subagent sessions", () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-gate-sub-"))
    mkdirSync(join(tmpDir, ".supervisor", "goals"), { recursive: true })
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // ---- pure predicate -----------------------------------------------------
  // `parentID` is the VERIFIED field name: SDK type
  // node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts `Session.parentID?: string`,
  // and `GET /session/{id}` on a real subagent session returns it while a root
  // session omits the key entirely.
  test("isSubagentSession reads the verified `parentID` field", () => {
    assert.equal(isSubagentSession({ id: "ses_a", parentID: "ses_root" }), true)
    assert.equal(isSubagentSession({ id: "ses_a" }), false, "root sessions omit parentID entirely")
    assert.equal(isSubagentSession({ id: "ses_a", parentID: undefined }), false)
    assert.equal(isSubagentSession({ id: "ses_a", parentID: null }), false)
    assert.equal(isSubagentSession({ id: "ses_a", parentID: "" }), false)
    assert.equal(isSubagentSession({ id: "ses_a", parentID: "   " }), false)
    assert.equal(isSubagentSession(null), false)
    assert.equal(isSubagentSession(undefined), false)
    assert.equal(isSubagentSession("ses_a"), false)
  })

  test("isSubagentSession also tolerates snake_case/lowercase-d SDK variants", () => {
    assert.equal(isSubagentSession({ parent_id: "ses_root" }), true)
    assert.equal(isSubagentSession({ parentId: "ses_root" }), true)
  })

  // ---- plugin-level behaviour --------------------------------------------
  // Real plugin, real session.idle handler. The judge pipeline's very first
  // action is to create + prompt an ephemeral session, so zero prompt calls
  // proves the gate short-circuited before any supervisor work happened.
  test("child session produces NO supervisor activity", async () => {
    writeActiveGoal(tmpDir, SESSION_ID)
    const { client, getPromptCalls } = createStubClient({ parentID: PARENT_SESSION_ID })
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 5000))

    assert.equal(
      getPromptCalls().length,
      0,
      `A delegated subagent session must never be supervised. Got prompts: ${JSON.stringify(getPromptCalls()).slice(0, 400)}`
    )
  })

  test("root session (no parentID) IS supervised — the gate is not a blanket kill switch", async () => {
    writeActiveGoal(tmpDir, SESSION_ID)
    const { client, getPromptCalls } = createStubClient({ parentID: undefined })
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    // Not awaited: the stub never answers the judge, so runSupervisor would sit
    // in its 120s poll. We only need to observe that supervision STARTED.
    plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } }).catch(() => {})
    const started = await waitForPrompts(getPromptCalls)

    assert.ok(
      started,
      "A root (human) session must still be supervised — otherwise the gate broke the whole feature"
    )
  })

  test("SDK without session.get fails OPEN (still supervises) rather than killing the feature", async () => {
    writeActiveGoal(tmpDir, SESSION_ID)
    const { client, getPromptCalls } = createStubClient({ parentID: PARENT_SESSION_ID, withSessionGet: false })
    const plugin = await SupervisorPlugin({ client, directory: tmpDir })

    plugin.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } }).catch(() => {})
    const started = await waitForPrompts(getPromptCalls)

    assert.ok(
      started,
      "When parentage is undeterminable the supervisor must keep working, not silently disable itself"
    )
  })

  // ---- config override ----------------------------------------------------
  test("loadConfiguredSuperviseSubagents defaults to false and parses the yaml key", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "sup-gate-cfg-"))
    try {
      assert.equal(await loadConfiguredSuperviseSubagents(join(cfgDir, "missing.yaml")), false)

      const p = join(cfgDir, "supervisor.yaml")
      writeFileSync(p, "maxAttempts: 4\n")
      assert.equal(await loadConfiguredSuperviseSubagents(p), false, "absent key => default false")

      writeFileSync(p, "superviseSubagents: true\n")
      assert.equal(await loadConfiguredSuperviseSubagents(p), true)

      writeFileSync(p, "superviseSubagents: false\n")
      assert.equal(await loadConfiguredSuperviseSubagents(p), false)

      writeFileSync(p, "# superviseSubagents: true\n")
      assert.equal(await loadConfiguredSuperviseSubagents(p), false, "commented-out key must not count")
    } finally {
      rmSync(cfgDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// BUG B — /supervisor off
// ---------------------------------------------------------------------------

describe("BUG B: /supervisor off must never be swallowed by a filler `mode`", () => {
  let tmpDir
  let plugin
  let toggle

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sup-gate-off-"))
    mkdirSync(join(tmpDir, ".supervisor", "goals"), { recursive: true })
    const { client } = createStubClient({ parentID: undefined })
    plugin = await SupervisorPlugin({ client, directory: tmpDir })
    toggle = (args) => plugin.tool.supervisor.execute(args, { sessionID: SESSION_ID })
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  test("normalizeOptionalArg treats runtime filler as absent", () => {
    for (const filler of ["", "   ", "null", "NULL", "undefined", "Undefined", null, undefined, 42, {}]) {
      assert.equal(normalizeOptionalArg(filler), undefined, `filler ${JSON.stringify(filler)} must read as absent`)
    }
    assert.equal(normalizeOptionalArg("off"), "off")
    assert.equal(normalizeOptionalArg("  Off  "), "Off")
    assert.equal(normalizeOptionalArg("reflection"), "reflection")
  })

  // THE exact real-world failure. 3 of 5 real off-attempts arrived shaped like
  // this and none of them persisted.
  test("{mode:'reflection', action:'off'} disables the session", async () => {
    const out = await toggle({ mode: "reflection", action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `Session must be in .supervisor/disabled. Tool said: ${out}`)
    assert.match(out, /disabled/i)
    assert.doesNotMatch(out, /^Supervisor mode set to/, "must not report a bare mode change for an off request")
  })

  test("{mode:'reflection', action:'off'} still applies the mode and says so", async () => {
    const out = await toggle({ mode: "reflection", action: "off" })
    assert.equal(readMode(tmpDir, SESSION_ID), "reflection", "an explicit mode must still be stored")
    assert.match(out, /mode also set to reflection/i, `Tool must report both axes. Got: ${out}`)
  })

  // The single worst observed case: the user asked OFF and the supervisor was
  // turned UP to autopilot.
  test("{mode:'autopilot', action:'off'} disables the session (does not just enable autopilot)", async () => {
    const out = await toggle({ mode: "autopilot", action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `Session must be disabled. Tool said: ${out}`)
    assert.match(out, /disabled/i)
  })

  test("{action:'off'} with mode absent disables the session", async () => {
    const out = await toggle({ action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `Tool said: ${out}`)
    assert.match(out, /disabled/i)
  })

  test("sentinel modes are treated as absent: mode:'null' and mode:null", async () => {
    const out1 = await toggle({ mode: "null", action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `mode:"null" case. Tool said: ${out1}`)
    assert.doesNotMatch(out1, /mode also set/i, 'a sentinel "null" mode must not be stored as a mode')

    await toggle({ action: "on" })
    const out2 = await toggle({ mode: null, action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `mode:null case. Tool said: ${out2}`)
    assert.doesNotMatch(out2, /mode also set/i)

    await toggle({ action: "on" })
    const out3 = await toggle({ mode: "", action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `mode:"" case. Tool said: ${out3}`)

    await toggle({ action: "on" })
    const out4 = await toggle({ mode: "undefined", action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID), `mode:"undefined" case. Tool said: ${out4}`)
  })

  test("action:'on' after off re-enables the session", async () => {
    await toggle({ action: "off" })
    assert.ok(readDisabled(tmpDir).includes(SESSION_ID))

    const out = await toggle({ mode: "null", action: "on" })
    assert.ok(!readDisabled(tmpDir).includes(SESSION_ID), `Session must be removed from disabled. Tool said: ${out}`)
    assert.match(out, /enabled/i)
  })

  test("a disabled session really stops the supervisor running (end-to-end through the gate)", async () => {
    writeActiveGoal(tmpDir, SESSION_ID)
    const { client, getPromptCalls } = createStubClient({ parentID: undefined })
    const p = await SupervisorPlugin({ client, directory: tmpDir })

    await p.tool.supervisor.execute({ mode: "reflection", action: "off" }, { sessionID: SESSION_ID })
    await p.event({ event: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
    await new Promise((r) => setTimeout(r, 5000))

    assert.equal(
      getPromptCalls().length,
      0,
      `After /supervisor off the supervisor must not inject. Got: ${JSON.stringify(getPromptCalls()).slice(0, 400)}`
    )
  })

  // The worst symptom: the tool returned a success string ("Supervisor is off")
  // for a write that never happened, and the agent repeated that lie to the user.
  test("returns an explicit FAILURE string when the disable cannot persist", async () => {
    const brokenDir = mkdtempSync(join(tmpdir(), "sup-gate-broken-"))
    try {
      // .supervisor exists as a FILE, so mkdir/writeFile underneath must fail.
      // Robust regardless of process uid (unlike a chmod-based approach).
      writeFileSync(join(brokenDir, ".supervisor"), "not a directory")

      const { client } = createStubClient({ parentID: undefined })
      const p = await SupervisorPlugin({ client, directory: brokenDir })
      const out = await p.tool.supervisor.execute({ action: "off" }, { sessionID: SESSION_ID })

      assert.match(out, /FAILED/, `Must not claim success for a write that did not persist. Got: ${out}`)
      assert.doesNotMatch(
        out,
        /^Supervisor disabled for session/,
        `Must not emit the success string when nothing persisted. Got: ${out}`
      )
    } finally {
      rmSync(brokenDir, { recursive: true, force: true })
    }
  })

  test("status still works and reflects the disabled state", async () => {
    const before = await toggle({ action: "status" })
    assert.match(before, /enabled: yes/)

    await toggle({ mode: "reflection", action: "off" })
    const after = await toggle({ action: "status" })
    assert.match(after, /enabled: no/, `Status must show the session is off. Got: ${after}`)
  })

  test("a bare mode change (no action) still works", async () => {
    const out = await toggle({ mode: "autopilot" })
    assert.match(out, /mode set to autopilot/i)
    assert.equal(readMode(tmpDir, SESSION_ID), "autopilot")
    assert.ok(!readDisabled(tmpDir).includes(SESSION_ID), "a mode change must not disable the session")
  })

  test("legacy action:'reflection' / action:'autopilot' still work", async () => {
    assert.match(await toggle({ action: "autopilot" }), /mode set to autopilot/i)
    assert.equal(readMode(tmpDir, SESSION_ID), "autopilot")
    assert.match(await toggle({ action: "reflection" }), /mode set to reflection/i)
    assert.equal(readMode(tmpDir, SESSION_ID), "reflection")
  })

  test("filler action ('null') falls through to status, not to off", async () => {
    const out = await toggle({ action: "null", mode: "null" })
    assert.match(out, /Supervisor status/i, `Got: ${out}`)
    assert.ok(!readDisabled(tmpDir).includes(SESSION_ID))
  })
})
