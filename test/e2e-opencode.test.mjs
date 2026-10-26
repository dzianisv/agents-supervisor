/**
 * e2e-opencode.test.mjs — End-to-end test of the supervisor plugin loaded by
 * a real `opencode serve` process.
 *
 * Proves the plugin registers its tools and commands correctly, and that
 * supervisor slash commands drive real tool execution through a real,
 * spawned opencode server.
 *
 * Isolation: the spawned server gets a throwaway $HOME (no
 * ~/.config/opencode/opencode.json, no ~/.local/share/opencode/auth.json) so
 * it never merges in the ambient user's global plugins/MCP servers/model
 * config (opencode merges — not replaces — global and project config; see
 * https://opencode.ai/docs/config/#locations and
 * https://opencode.ai/docs/plugins/#load-order). Without this, the spawned
 * server would ALSO load the user's other global opencode plugins and even
 * a second, stale copy of THIS plugin from the real (non-worktree) repo path
 * if one happens to be configured globally — silently testing a mix of old
 * and new plugin code instead of only the worktree under test.
 *
 * The model behind the server is a local, deterministic, OpenAI-compatible
 * fixture (test/helpers/opencode-fixture-llm.mjs) configured as a custom
 * `npm: "@ai-sdk/openai-compatible"` provider — the same mechanism
 * opencode's own docs use for local models. This replaces the previous
 * approach of discovering and calling a live, free, remote model from
 * whatever provider happened to be connected in the ambient environment,
 * which was both non-deterministic and prone to real "Streaming response
 * failed" failures from that third party — a dependency outside this test's
 * isolation boundary and unrelated to the code under test here. The real
 * opencode server, the real plugin, and the real tool implementations are
 * still exercised end to end over real HTTP.
 *
 * The spawn/teardown/health mechanics live in test/helpers/live-server.mjs so
 * this file and test/live-validation.mjs cannot drift apart on isolation.
 *
 * DO NOT add this file to a `test/*.test.mjs` glob. It spawns a real server;
 * `node --test` runs files concurrently, so the glob would start a second copy
 * of this suite alongside 30+ unit files on the same cores. `npm test` and
 * `npm run test:e2e` are separate for exactly that reason.
 *
 * Run: node --experimental-strip-types --test test/e2e-opencode.test.mjs
 */

import { describe, test, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { startLiveServer, hasOpencode } from "./helpers/live-server.mjs"
import { goalStore, writeProjectGoal, readProjectGoalContract, readGoalAchievedLog } from "../core/goal.mjs"
import { sessionStore } from "../core/session-store.mjs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to a session and wait for the full response.
 * Treats timeout as FAILURE (not a false-positive success).
 * @param {object} [opts] - Optional settings
 * @param {object} [opts.model] - Model override: {providerID, modelID}
 */
async function sendMessage(baseUrl, sessionId, text, timeoutMs = 60_000, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const payload = { parts: [{ type: "text", text }] }
    if (opts.model) payload.model = opts.model
    const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (res.status !== 200) assert.fail(`Expected 200 for "${text}", got ${res.status}: ${(await res.text()).slice(0, 2000)}`)
    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    throw new Error(`Message "${text}" failed: ${err.message}`)
  }
}

/** Every user-role text of one recorded chat-completions body, oldest first. */
function userTextsOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  return msgs
    .filter((m) => m?.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
          : ""
    )
}

/** Concatenated system-role content of one recorded chat-completions body. */
function systemTextOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  return msgs
    .filter((m) => m?.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
          : ""
    )
    .join("\n")
}

/**
 * The model calls that belong to ONE specific user turn, identified by a probe
 * string unique to that turn.
 *
 * WHY NOT `getSystemPrompts().slice(before)`: that slice is a GLOBAL,
 * server-wide list, and this server is concurrent. The supervisor's own
 * background work for an EARLIER session (most visibly its one-shot
 * "status checkpoint missing" correction, which is injected into that other
 * session and therefore legitimately carries the directive) lands in the
 * slice whenever it happens to finish inside the ~500ms window between
 * capturing `before` and asserting. That is the entire flake: measured 1
 * failure in 16 runs of this file, and reproduced deterministically by
 * waiting 20s after `before` — 2 offenders, both the status-correction turn
 * of the PREVIOUS test's session. Index arithmetic cannot express "this
 * session"; content can.
 *
 * `turnCalls` keeps only calls whose LAST user message is the probe turn —
 * i.e. the user's own turn and its tool-loop follow-ups — which excludes the
 * supervisor's ephemeral judge/self-assessment prompts (their last user
 * message is the judge prompt) even though those quote the probe text back
 * inside the conversation chain.
 */
function turnCalls(fixtureLlm, probe) {
  return fixtureLlm.getRequests().filter((b) => {
    const users = userTextsOf(b)
    return users.length > 0 && users[users.length - 1].includes(probe)
  })
}

/** Every model call that mentions the probe anywhere (superset of turnCalls). */
function callsMentioning(fixtureLlm, probe) {
  return fixtureLlm.getRequests().filter((b) => userTextsOf(b).some((t) => t.includes(probe)))
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const SKIP = !hasOpencode()

// A missing `opencode` binary used to make every test in this file report
// "skip" — `node --test` still exits 0 for an all-skipped run, so "0 tests,
// 0 fail" looked identical to a real pass. AGENTS.md documents this suite as
// a MANDATORY pre-commit gate; a gate that reports green without running is
// worse than no gate (it was hit for real: the opencode binary lives at
// ~/.opencode/bin/opencode, not on the default PATH, on this machine). Make
// the vacuous case LOUD by default: throwing here fails the whole test file
// with a non-zero exit and a clear message, instead of a silent, structurally
// identical-to-passing skip. `SUPERVISOR_E2E_ALLOW_SKIP=1` is the explicit,
// opt-in escape hatch for a machine that genuinely has no opencode installed.
if (SKIP && process.env.SUPERVISOR_E2E_ALLOW_SKIP !== "1") {
  throw new Error(
    "opencode binary not found on PATH — refusing to silently skip test/e2e-opencode.test.mjs " +
    "(a skipped E2E run exits 0, indistinguishable from a real pass, and this suite is a mandatory " +
    "pre-commit gate per AGENTS.md).\n" +
    "Fix: put the opencode binary on PATH before running, e.g.:\n" +
    '  export PATH="$HOME/.opencode/bin:$PATH" && npm run test:e2e\n' +
    "(binary commonly lives at ~/.opencode/bin/opencode).\n" +
    "To intentionally run without opencode installed and accept that these tests are skipped, " +
    "set SUPERVISOR_E2E_ALLOW_SKIP=1."
  )
}

describe("opencode supervisor plugin E2E", { skip: SKIP && "opencode binary not in PATH", timeout: 1_800_000 }, () => {
  let server
  let baseUrl
  let tmpDir
  let fixtureLlm
  const model = { providerID: "test-fixture", modelID: "fixture-model" }

  before(async () => {
    server = await startLiveServer({ label: "e2e", seedProject(dir) {
      const commands = join(dir, ".opencode", "commands")
      mkdirSync(commands, { recursive: true })
      for (const name of ["supervisor:autopilot", "supervisor:reflection", "custom-user-command"]) {
        writeFileSync(join(commands, `${name}.md`), `---\ndescription: Previously installed command\n---\nLegacy ${name} command.\n`)
      }
    } })
    baseUrl = server.baseUrl
    tmpDir = server.projectDir
    fixtureLlm = server.fixture
    process.stdout.write(`[e2e] fixture model: ${model.providerID}/${model.modelID} @ ${fixtureLlm.baseURL}\n`)
  })

  after(async () => {
    if (server) await server.stop()
    // NOTE: no process.exit() here. This used to force-exit 500ms after this
    // suite's teardown, which silently KILLED every describe declared after it
    // in this file — the per-turn budget suites below reported nothing at all
    // and the run still exited 0. The watchdog now lives in a single top-level
    // `after` at the very END of the file.
  })

  test("health endpoint responds with healthy: true", { timeout: 30_000 }, async () => {
    const res = await fetch(`${baseUrl}/global/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.healthy, true)
  })

  test("supervisor commands are registered via /command endpoint", { timeout: 30_000 }, async () => {
    const res = await fetch(`${baseUrl}/command`)
    assert.equal(res.status, 200)
    const text = await res.text()
    // The /command endpoint may emit log lines before the JSON array on first
    // call (plugin init messages). Extract the JSON portion.
    const jsonStart = text.indexOf("[")
    assert.ok(jsonStart !== -1, `Expected JSON array in /command response, got: ${text.slice(0, 200)}`)
    const commands = JSON.parse(text.slice(jsonStart))
    assert.ok(Array.isArray(commands), "Commands should be an array")
    assert.ok(commands.length > 0, "Should have at least one command registered")

    const commandNames = commands.map((c) => c.name)
    assert.ok(commandNames.includes("custom-user-command"), "upgrade must preserve unrelated installed commands")
    for (const retired of ["supervisor:autopilot", "supervisor:reflection"]) assert.ok(existsSync(join(tmpDir, ".opencode", "commands", `${retired}.md`)), "fixture must actually contain stale installed command files")
    // The supervisor plugin must register a /supervisor command
    const hasSupervisorRelated = commandNames.includes("supervisor")
    for (const removed of ["autopilot", "supervisor:autopilot", "supervisor:reflection"]) {
      assert.ok(!commandNames.includes(removed), `${removed} must not be registered`)
    }
    assert.ok(
      hasSupervisorRelated,
      `Expected a supervisor command in the registry — plugin config hook did not register it. Commands found: ${commandNames.join(", ")}`
    )
  })

  test("can create a session", { timeout: 30_000 }, async () => {
    const res = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(res.status, 200)
    const session = await res.json()
    assert.ok(session.id, "Session should have an id")
    assert.ok(typeof session.id === "string", "Session id should be a string")
  })

  test("can list sessions", { timeout: 30_000 }, async () => {
    const res = await fetch(`${baseUrl}/session`)
    assert.equal(res.status, 200)
    const sessions = await res.json()
    assert.ok(Array.isArray(sessions), "Sessions should be an array")
    assert.ok(sessions.length > 0, "Should have at least one session (from prior test)")
  })

  // Runs BEFORE any test that sets a goal (below), so the project has no
  // .agents/supervisor/Goal.md or goal.md yet — required for the "no
  // existing goal" branch of deriveAndSetGoal (opencode/supervisor-impl.ts)
  // to actually trigger instead of short-circuiting on a pre-existing goal.
  test("supervisor set-goal command with no condition derives a SESSION-scoped goal and writes no project file", { timeout: 300_000 }, async () => {
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Give the session a task to derive a goal FROM (deriveAndSetGoal reads
    // the session transcript via buildTaskContext).
    await sendMessage(baseUrl, session.id, "Add input validation to the login form. E2E_DERIVE_ONLY", 120_000, { model })

    // No condition, no existing session/project goal — must attempt LLM
    // derivation (align-supervisor-modes binding contract) rather than
    // silently no-op or fabricate a default.
    const goalRes = await sendMessage(baseUrl, session.id, "/supervisor set-goal", 120_000, { model })
    assert.ok(goalRes, "Goal derivation response should not be null")
    const goalContent = JSON.stringify(goalRes)

    // An auto-derived goal is SESSION-SCOPED. This test used to assert the
    // opposite — that the derived condition was persisted to
    // .agents/supervisor/goal.md — which encoded the stale-goal bug: a goal
    // inferred from turn 1 kept firing on turn 50 and in every future session
    // in the project, with no expiry and no relevance check. Only an explicit
    // /supervisor:set-goal <condition> may create the durable project file.
    const goalMdPath = join(tmpDir, ".agents", "supervisor", "goal.md")
    assert.ok(
      !existsSync(goalMdPath),
      `An auto-derived goal must NOT be persisted to ${goalMdPath} — it is session-scoped`
    )
    assert.match(goalContent, /derived/i)
    const derivedState = sessionStore.load(tmpDir, session.id)
    assert.equal(derivedState.goal?.source, "agent")
    assert.ok(derivedState.goal?.acceptanceCriteria)
    assert.ok(derivedState.goal?.verification)
    assert.ok(!existsSync(join(tmpDir, ".agents", "supervisor", "Goal.md")))
  })

  test("supervisor set-goal set/status/clear works", { timeout: 900_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // 1. Set a goal
    const setRes = await sendMessage(baseUrl, session.id, "/supervisor set-goal all tests pass", 300_000, { model })
    assert.ok(setRes, "Goal set response should not be null")
    assert.match(JSON.stringify(setRes), /Goal set for session/)
    assert.doesNotMatch(JSON.stringify(setRes), /FAILED/)
    const declared = sessionStore.load(tmpDir, session.id).goal
    assert.equal(declared?.condition, "all tests pass")
    assert.equal(declared?.source, "user")
    assert.equal(declared?.status, "active")
    assert.equal(readProjectGoalContract(tmpDir)?.condition, declared.condition)
    assert.equal(readProjectGoalContract(tmpDir)?.acceptanceCriteria, declared.acceptanceCriteria)
    assert.equal(readProjectGoalContract(tmpDir)?.verification, declared.verification)

    // 2. Check status — should reflect the active goal
    const statusRes = await sendMessage(baseUrl, session.id, "/supervisor set-goal", 300_000, { model })
    assert.ok(statusRes, "Goal status response should not be null")
    assert.match(JSON.stringify(statusRes), /Goal \(active, source: user\)/)
    assert.match(JSON.stringify(statusRes), /all tests pass/)
    assert.deepEqual(sessionStore.load(tmpDir, session.id).goal, declared)

    // 3. Clear the goal
    const clearRes = await sendMessage(baseUrl, session.id, "/supervisor set-goal clear", 300_000, { model })
    assert.ok(clearRes, "Goal clear response should not be null")
    assert.match(JSON.stringify(clearRes), /Goal cleared/)
    const cleared = sessionStore.load(tmpDir, session.id)
    assert.equal(cleared.goal, undefined)
    assert.equal(cleared.goalCleared, true)
  })

  test("obsolete mode requests explicitly report removal", { timeout: 600_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Send reflection command
    const res = await sendMessage(baseUrl, session.id, "/supervisor reflection", 300_000, { model })
    assert.ok(res, "Reflection response should not be null")
    const content = JSON.stringify(res).toLowerCase()
    assert.ok(
      content.includes("removed"),
      `Expected reflection response to mention "reflection" or "mode". Got: ${JSON.stringify(res).slice(0, 500)}`
    )
  })

  test("session can be retrieved by id", { timeout: 30_000 }, async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    const session = await createRes.json()

    // Retrieve it
    const getRes = await fetch(`${baseUrl}/session/${session.id}`)
    assert.equal(getRes.status, 200)
    const retrieved = await getRes.json()
    assert.equal(retrieved.id, session.id)
  })

  // -------------------------------------------------------------------------
  // Subagent gate (BUG A). 633 of 962 supervisor injections in a 30-day sample
  // (66%) landed in delegated subagent sessions — sessions whose "user" is a
  // scoped delegation prompt, not a human. This proves, against a real server,
  // (a) the field name the gate depends on, and (b) that the gate actually
  // fires for a child session and does NOT fire for a root session.
  // The spawned server runs with SUPERVISOR_DEBUG=1 so the plugin's own
  // decision is observable in <serverCwd>/.supervisor/debug.log.
  // -------------------------------------------------------------------------
  describe("subagent gate", () => {
    /** Poll the plugin's debug log until `needle` appears (or timeout). */
    async function waitForDebugLine(needle, timeoutMs = 60_000) {
      const logPath = join(tmpDir, ".supervisor", "debug.log")
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (existsSync(logPath) && readFileSync(logPath, "utf-8").includes(needle)) return true
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    }

    function debugLog() {
      const logPath = join(tmpDir, ".supervisor", "debug.log")
      return existsSync(logPath) ? readFileSync(logPath, "utf-8") : ""
    }

    // The gate reads `parentID` off the session object. This is the empirical
    // half of that claim: the live server, not just the SDK .d.ts, returns
    // `parentID` on a child and omits it entirely on a root.
    test("live server exposes `parentID` on child sessions and omits it on roots", { timeout: 60_000 }, async () => {
      const parent = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      const childRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentID: parent.id, title: "e2e subagent gate child" }),
      })
      assert.equal(childRes.status, 200)
      const child = await childRes.json()

      assert.equal(
        child.parentID,
        parent.id,
        `Child session must carry parentID. If this fails the SDK field was renamed and isSubagentSession must be updated. Got: ${JSON.stringify(child).slice(0, 300)}`
      )
      const fetchedRoot = await (await fetch(`${baseUrl}/session/${parent.id}`)).json()
      assert.equal(
        fetchedRoot.parentID,
        undefined,
        `Root sessions must omit parentID. Got: ${JSON.stringify(fetchedRoot).slice(0, 300)}`
      )
      const fetchedChild = await (await fetch(`${baseUrl}/session/${child.id}`)).json()
      assert.equal(fetchedChild.parentID, parent.id, "GET /session/{id} must also carry parentID")
    })

    test("supervisor skips a real child session but runs for a real root session", { timeout: 300_000 }, async () => {
      const parent = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      const child = await (
        await fetch(`${baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentID: parent.id, title: "e2e subagent gate run" }),
        })
      ).json()

      // Drive the CHILD to idle. The plugin's session.idle handler must bail
      // out at the subagent gate before doing any supervisor work.
      // Full session ids throughout: ids minted seconds apart share an 8-char
      // prefix, so a truncated id cannot distinguish these sessions.
      await sendMessage(baseUrl, child.id, "Say hello.", 120_000, { model })
      const skipped = await waitForDebugLine(`subagent-gate: skipping delegated subagent session ${child.id}`)
      assert.ok(
        skipped,
        `Expected the supervisor to skip child session ${child.id}. debug.log tail:\n${debugLog().slice(-3000)}`
      )

      // Drive a ROOT session to idle. It must NOT be skipped — the gate must
      // not be a blanket kill switch.
      const root = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      await sendMessage(baseUrl, root.id, "Say hello.", 120_000, { model })
      const rootRan = await waitForDebugLine(`subagent-gate: supervising root session ${root.id}`)
      assert.ok(
        rootRan,
        `Expected the root session ${root.id} to pass the subagent gate. debug.log tail:\n${debugLog().slice(-3000)}`
      )
      assert.ok(
        !debugLog().includes(`subagent-gate: skipping delegated subagent session ${root.id}`),
        `Root session ${root.id} must never be treated as a subagent. debug.log tail:\n${debugLog().slice(-3000)}`
      )
      assert.ok(
        !debugLog().includes(`subagent-gate: supervising root session ${child.id}`),
        `Child session ${child.id} must never pass the subagent gate. debug.log tail:\n${debugLog().slice(-3000)}`
      )
    })
  })

  // Proves the always-on status-directive injection works against the REAL
  // opencode runtime, not just against our own idea of the hook contract.
  //
  // This is the one thing that could not be established by reading types:
  // `@opencode-ai/plugin`'s shipped .d.ts (0.5.29) does not declare
  // `experimental.chat.system.transform` at all, and opencode 1.17.9 resolves
  // plugin hooks by a literal `hooks[name]` lookup — so the hook must be
  // registered under the FLAT dotted key, and a nested
  // `{experimental:{chat:{system:{transform}}}}` object is silently ignored.
  // Verified empirically before it was written; this test keeps it verified.
  //
  // Observed at the fixture LLM, i.e. on the wire, because opencode 1.17.9
  // does NOT expose the resolved system prompt over the REST API (it never
  // populates `AssistantMessage.system` in the transcript response). Asserting
  // on the transcript would therefore pass vacuously; asserting on what the
  // model actually received cannot.
  describe("status directive system-prompt injection", () => {
    const MARKER = "<!-- supervisor:status-directive -->"

    test("directive reaches the model on the FIRST turn, exactly once", { timeout: 300_000 }, async () => {
      const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
      assert.equal(createRes.status, 200)
      const session = await createRes.json()

      // The very first turn of the session — the one the supervisor's
      // continuation-prompt path can never reach, which is the whole reason
      // this hook exists. The probe makes the calls for THIS turn
      // identifiable in a server-wide, concurrently-written request log; see
      // turnCalls() for why an index slice cannot do that job.
      goalStore.setStatusDiagram(tmpDir, session.id, true)
      const PROBE = "E2E_STATUS_FIRSTTURN_PROBE"
      await sendMessage(baseUrl, session.id, `Say hello. ${PROBE}`, 120_000, { model })

      const calls = turnCalls(fixtureLlm, PROBE)
      assert.ok(calls.length > 0, "expected at least one model call for this turn")

      const systems = calls.map(systemTextOf)
      const withMarker = systems.filter((s) => s.includes(MARKER))
      assert.ok(
        withMarker.length > 0,
        `status directive never reached the model — the hook did not fire. System prompts seen:\n${systems.map((s) => s.slice(0, 300)).join("\n---\n")}`
      )

      // Idempotency, for real: opencode fires this hook more than once per
      // user turn, so a naive push would duplicate the directive.
      for (const s of withMarker) {
        const copies = s.split(MARKER).length - 1
        assert.equal(copies, 1, `status directive appears ${copies}x in one system prompt; must appear exactly once`)
      }

      // The directive's payload must actually be there, not just the marker.
      assert.ok(withMarker[0].includes("ROADMAP"), "directive body (ROADMAP block) missing")
      assert.ok(withMarker[0].includes("status.md"), "directive body (status.md instruction) missing")
    })

    test("/supervisor status off suppresses the directive for that session", { timeout: 300_000 }, async () => {
      const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
      assert.equal(createRes.status, 200)
      const session = await createRes.json()

      const offRes = await sendMessage(baseUrl, session.id, "/supervisor status off", 120_000, { model })
      const offContent = JSON.stringify(offRes).toLowerCase()
      assert.ok(
        offContent.includes("disabled") || offContent.includes("status"),
        `Expected the toggle to acknowledge. Got: ${JSON.stringify(offRes).slice(0, 500)}`
      )

      // Attribute calls by CONTENT, not by index. `getSystemPrompts().slice(before)`
      // used to be the check here and it is the source of this file's only
      // measured flake (1 in 16): the slice is server-wide, and the
      // supervisor's own status-checkpoint correction for the PREVIOUS test's
      // session legitimately carries the directive, so whenever that
      // background turn landed inside the slice this assertion failed on a
      // completely unrelated session.
      const PROBE = "E2E_STATUS_OFF_PROBE"
      await sendMessage(baseUrl, session.id, `Say hello again. ${PROBE}`, 120_000, { model })

      // Superset on purpose: EVERY call that mentions this session's probe at
      // all, including the supervisor's own judge prompts (which quote the
      // conversation back). None of them may carry the directive.
      const calls = callsMentioning(fixtureLlm, PROBE)
      assert.ok(calls.length > 0, "expected at least one model call after the toggle")
      for (const body of calls) {
        const s = systemTextOf(body)
        assert.ok(
          !s.includes(MARKER),
          `status directive was injected even though /supervisor status off was set for this session. Offending call's last user text: ${(userTextsOf(body).pop() || "").slice(0, 200)}`
        )
      }
    })
  })

})

describe("goal contract workflow", { skip: SKIP && "opencode binary not in PATH", timeout: 600_000 }, () => {
  // Other sessions may legitimately retire THEIR project goal. Isolate this
  // server/project so their background audits cannot pollute this proof.
  let server, baseUrl, tmpDir, fixtureLlm
  let auditStarted, heldAudit = false
  const firstAudit = new Promise(resolve => { auditStarted = resolve })
  const model = { providerID: "test-fixture", modelID: "fixture-model" }
  before(async () => {
    server = await startLiveServer({ label: "goal-contract", responder: async ({ fullText, lastText }) => {
      if (!heldAudit && fullText.includes("E2E_CONTRACT_WORKFLOW") && lastText.trimStart().startsWith(REFLECTION_MARKER)) {
        heldAudit = true
        auditStarted()
        // Force the newer human turn's idle to arrive during this old audit.
        await sleep(4000)
      }
      return null
    } })
    baseUrl = server.baseUrl
    tmpDir = server.projectDir
    fixtureLlm = server.fixture
  })
  after(async () => { await server?.stop() })

  test("fixture audit rejects a bare completion claim, continues through real failing checks, and retires after passing evidence", { timeout: 600_000 }, async () => {
    writeFileSync(join(tmpDir, "validation.test.mjs"), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isValid } from './validation.mjs';\ntest('accepts nonempty input', () => assert.equal(isValid('ok'), true));\ntest('rejects empty input', () => assert.equal(isValid(''), false));\n`)
    const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
    goalStore.setRetry(tmpDir, session.id, 3)
    await sendMessage(baseUrl, session.id, "Implement input validation in validation.mjs and run validation.test.mjs. E2E_CONTRACT_WORKFLOW", 120_000, { model })
    const state = sessionStore.load(tmpDir, session.id)
    assert.equal(state.goal?.source, "agent")
    assert.match(state.goal?.acceptanceCriteria, /validation.test.mjs passes/)
    assert.match(state.goal?.verification, /node --test validation.test.mjs/)
    assert.equal(state.goal.status, "active")
    const projectPath = join(tmpDir, ".agents", "supervisor", "Goal.md")
    assert.equal(existsSync(projectPath), false)
    await Promise.race([firstAudit, sleep(30_000).then(() => { throw new Error("Initial goal audit never started") })])
    const complete = await sendMessage(baseUrl, session.id, "Report completion now.", 120_000, { model })
    assert.match(JSON.stringify(complete), /must be judged|pending judge/i)
    assert.equal(sessionStore.load(tmpDir, session.id).loopExit, undefined)
    try { assert.ok(await waitForInjectionCount(baseUrl, session.id, 1)) }
    catch (error) { throw new Error(`${error.message}\nState: ${JSON.stringify(sessionStore.load(tmpDir, session.id))}\n${server.debugLog().slice(-16000)}`) }
    assert.equal(sessionStore.load(tmpDir, session.id).goal?.status, "active")
    assert.equal(existsSync(projectPath), false, "agent contract must not write a project goal")

    // No further human prompt. First run real failing tests; the next
    // continuation implements the helper and reruns those same tests.
    await settleInjections(baseUrl, session.id)
    const transcript = await (await fetch(`${baseUrl}/session/${session.id}/message`)).json()
    const prose = transcript.flatMap(m => m.parts || []).filter(p => p.type === "text").map(p => p.text).join("\n")
    assert.match(prose, /VALIDATION_EXIT=1/)
    assert.match(prose, /VALIDATION_EXIT=0/)
    const feedback = transcript.flatMap(m => m.parts || []).filter(p => p.type === "text" && p.text.includes(FEEDBACK_MARKER)).map(p => p.text).join("\n")
    assert.ok(feedback.includes(state.goal.acceptanceCriteria))
    assert.ok(feedback.includes(state.goal.verification))
    const calls = callsMentioning(fixtureLlm, "E2E_CONTRACT_WORKFLOW")
    assert.ok(calls.some(b => systemTextOf(b).includes("<!-- supervisor:goal-ownership -->")))
    const audits = calls.filter(b => userTextsOf(b).some(t => t.includes(REFLECTION_MARKER) || t.includes(JUDGE_MARKER)))
    assert.ok(audits.length > 0, "a real completion assessment must occur")
    for (const call of audits) {
      const input = userTextsOf(call).join("\n")
      for (const field of [state.goal.condition, state.goal.acceptanceCriteria, state.goal.verification]) assert.ok(input.includes(field), `assessment lost contract field: ${field}`)
    }
    const tools = calls.flatMap(b => b.tools || []).map(t => t.function?.name)
    assert.ok(tools.includes("supervisor_goal"))
    assert.ok(!tools.includes("supervisor_autopilot"))
    assert.equal(await countInjections(baseUrl, session.id), 2, "failed evidence must get a second continuation")
    assert.equal(sessionStore.load(tmpDir, session.id).goal, undefined, "fixture passing-evidence verdict retires the contract")
    assert.ok(readGoalAchievedLog(tmpDir).some(r => r.sessionId === session.id && r.acceptanceCriteria === state.goal.acceptanceCriteria))
    assert.ok(server.debugLog().includes(`Coalescing idle while audit in flight: ${session.id}`), "new-turn idle must actually overlap the old audit")
    const cleanEnv = { ...process.env }
    delete cleanEnv.NODE_TEST_CONTEXT
    const independent = execFileSync(process.execPath, ["--test", "validation.test.mjs"], { cwd: tmpDir, encoding: "utf8", env: cleanEnv })
    assert.match(independent, /pass 2/)
    assert.equal(existsSync(projectPath), false)
  })

    test("agent cannot replace a user goal, even with replace=true", { timeout: 300_000 }, async () => {
      const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      await sendMessage(baseUrl, session.id, "/supervisor set-goal Preserve this user contract", 120_000, { model })
      const result = await sendMessage(baseUrl, session.id, "E2E_REPLACE_USER", 120_000, { model })
      assert.match(JSON.stringify(result), /FAILED to set goal/)
      const state = sessionStore.load(tmpDir, session.id)
      assert.equal(state.goal?.condition, "Preserve this user contract")
      assert.equal(state.goal?.source, "user")
      await sendMessage(baseUrl, session.id, "/supervisor off", 120_000, { model })
    })

    test("agent cannot shadow a project-only user contract", { timeout: 300_000 }, async () => {
      writeProjectGoal(tmpDir, "User project contract", { acceptanceCriteria: "User acceptance", verification: "User verification" })
      const expected = readProjectGoalContract(tmpDir)
      const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      const result = await sendMessage(baseUrl, session.id, "E2E_REPLACE_USER project-only", 120_000, { model })
      assert.match(JSON.stringify(result), /FAILED to set goal.*user-set project goal/)
      assert.equal(sessionStore.load(tmpDir, session.id).goal, undefined)
      assert.deepEqual(readProjectGoalContract(tmpDir), expected)
      await sendMessage(baseUrl, session.id, "/supervisor off", 120_000, { model })
    })

    test("no-goal idle does not create a completion judge or continuation", { timeout: 300_000 }, async () => {
      const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()
      // Explicitly cleared sessions must not inherit a stale project goal.
      goalStore.clearGoal(tmpDir, session.id)
      await sendMessage(baseUrl, session.id, "Implement the local change without declaring a goal. E2E_NO_GOAL", 120_000, { model })
      await sleep(3000)
      const calls = callsMentioning(fixtureLlm, "E2E_NO_GOAL")
      assert.ok(calls.length > 0)
      assert.ok(!calls.some(b => userTextsOf(b).some(t => t.startsWith(JUDGE_MARKER) || t.startsWith(REFLECTION_MARKER))))
      assert.equal(await countInjections(baseUrl, session.id), 0)
      assert.equal(sessionStore.load(tmpDir, session.id).goal, undefined)
      assert.ok(!calls.some(b => systemTextOf(b).includes("<!-- supervisor:status-directive -->")), "status defaults off")
      await sendMessage(baseUrl, session.id, "What is two plus two? E2E_QUESTION_ONLY", 120_000, { model })
      const questionCalls = turnCalls(fixtureLlm, "E2E_QUESTION_ONLY")
      assert.ok(questionCalls.length > 0)
      assert.ok(!questionCalls.some(b => systemTextOf(b).includes("<!-- supervisor:goal-ownership -->")), "plain questions do not need goal declaration")
    })
})

// ===========================================================================
// Per-turn attempt budget — the supervisor must be able to push MORE THAN
// ONCE per human turn, and must provably stop at the budget.
//
// This suite exists because there was NO opencode-path coverage of a second
// injection on the same human turn. `test/e2e-cc.mjs` covers the counter, but
// it spawns bin/supervisor-on-stop.mjs — Claude Code only. That passing test
// gave false confidence while the opencode runtime shipped a boolean
// "already reflected this turn" gate that capped every turn at ONE injection
// and left `/supervisor retry N` with no observable effect for any N.
//
// Each test drives a REAL `opencode serve` over REST and counts the
// supervisor's own injected user messages in the real transcript.
// ===========================================================================

const FEEDBACK_MARKER = "## Supervisor:"
const JUDGE_MARKER = "ANALYZE SUPERVISOR"
const REFLECTION_MARKER = "# Reflection Prompt"

/** A task the non-actionable-turn gate will NOT skip (names a real file). */
function actionableTask(probe) {
  return `Implement retry-with-backoff in src/net/client.ts and add a unit test for it. [${probe}]`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Sentinel for `completeAfter`: always answer with an ACTIONLESS verdict. */
const ACTIONLESS = -1

/**
 * Fixture steering for this suite.
 *
 * `judgeFor(ctx)` returns the JSON verdict string for one "ANALYZE SUPERVISOR"
 * call. Everything else answers the supervisor's own background prompts
 * deterministically.
 *
 * The final `text` branch is deliberately NOT the shipped fixture's fallback,
 * which calls `supervisor_loop_exit` whenever that tool is offered — and it is
 * offered plugin-wide, on every session, so the shipped fallback would end an
 * autopilot loop on nudge 1 and silently defeat the autopilot cap test.
 *
 * `opts.staticReply` (default false): when false (every budget test below),
 * the fallback reply is suffixed with the fixture's own monotonic request
 * index, so consecutive replies are never byte-identical. A real agent does
 * not repeat itself verbatim forever; a fixture that does collides with the
 * no-progress gate (core/evaluation.mjs's `evaluateNoProgress`, wired into
 * opencode by the `no-progress-parity` fix) and silently caps EVERY one of
 * these budget tests at `NO_PROGRESS_REPEAT_THRESHOLD` (2) regardless of the
 * configured budget — the exact false failure this comment is pinning down.
 * `staticReply: true` opts back into the old fixed text and is used ONLY by
 * the dedicated "no-progress gate" test below, which needs a genuinely
 * repeating agent to prove the gate really caps one.
 */
function budgetResponder(judgeFor, { staticReply = false } = {}) {
  return (ctx) => {
    const { fullText, lastText, hasTools, messages, index } = ctx
    const prompt = (lastText || "").trimStart()
    if (prompt.startsWith(JUDGE_MARKER)) return { text: judgeFor(ctx) }
    if (prompt.startsWith(REFLECTION_MARKER) || fullText.includes("SELF-ASSESS SUPERVISOR")) {
      // Deliberately PROSE, not the JSON the prompt asks for: a parseable
      // self-assessment short-circuits into the deterministic
      // evaluateSelfAssessment and the steerable second-stage judge never
      // runs. Answering in prose is a real code path (it is what the LLM
      // fallback exists for) and it is the only way to force a verdict here.
      return { text: "I made the change and handed back for judgement." }
    }
    if (fullText.includes("DERIVE SUPERVISOR GOAL")) {
      return { text: JSON.stringify({ goal: "all tests pass", falsifiable: true, acceptance_criteria: "All requested tests pass", verification: "Run npm test and inspect exit code 0", rationale: "runnable" }) }
    }
    if (fullText.includes("CLASSIFY TASK ROUTING")) return { text: JSON.stringify({ category: "backend" }) }
    if (fullText.includes("REVIEW SUPERVISOR COMPLETION")) return { text: "Review looks good." }
    if (!hasTools) return { text: "Fixture session" }
    const lastRole = messages[messages.length - 1]?.role
    if (lastRole === "tool") return null
    if (/^\/?supervisor\b/i.test(prompt)) return null
    return {
      text: staticReply
        ? "Made some progress. Stopping here for now."
        : `Made some progress on attempt ${index}. Stopping here for now.`
    }
  }
}

/** Verdict JSON with the "keep going, here is what is missing" defaults. */
function verdict(v = {}) {
  return JSON.stringify({
    complete: false,
    severity: "MEDIUM",
    feedback: "The retry helper is written but no test was added.",
    missing: ["Unit test for the backoff schedule"],
    next_actions: ["Add test/net-client.test.mjs covering the retry path"],
    requires_human_action: false,
    ...v,
  })
}

/**
 * Supervisor-injected user messages in a session's transcript, counted from
 * `fromIndex`.
 *
 * `fromIndex` is not cosmetic. A `/supervisor autopilot` slash command is
 * itself a human turn with its OWN turn key and its own budget, so the
 * autopilot loop legitimately nudges it. Counting a delta across a snapshot
 * lets the tail of that loop leak into the next turn's count; slicing at the
 * task message cannot.
 */
async function countInjections(baseUrl, sessionId, fromIndex = 0) {
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`)
  if (!res.ok) return 0
  const all = await res.json()
  if (!Array.isArray(all)) return 0
  const msgs = all.slice(fromIndex)
  return msgs.filter(
    (m) =>
      m?.info?.role === "user" &&
      (m.parts || []).some((p) => p?.type === "text" && typeof p.text === "string" && p.text.includes(FEEDBACK_MARKER))
  ).length
}

/**
 * Wait until the injection count stops growing for `quietMs`, then return it.
 *
 * The quiet window is the TERMINATION proof: it is a bounded wait for an
 * injection N+1 that must never arrive. Returning early on "count === expected"
 * would prove only that the supervisor reached the budget, not that it stopped
 * there — so this always burns the full quiet window after the last change.
 */
async function settleInjections(baseUrl, sessionId, { quietMs = 15_000, timeoutMs = 240_000, fromIndex = 0 } = {}) {
  let last = await countInjections(baseUrl, sessionId, fromIndex)
  let lastChange = Date.now()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    const n = await countInjections(baseUrl, sessionId, fromIndex)
    if (n !== last) {
      last = n
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return last
    }
  }
  throw new Error(`injections never settled (last=${last}) within ${timeoutMs}ms`)
}

/**
 * Wait until the injection count REACHES `target`, then return it.
 *
 * Used only by the `unlimited` test, where the stop is the JUDGE (at a known
 * injection number), not a finite runaway cap. `settleInjections`' fixed quiet
 * window cannot prove "reached N": a single inter-injection gap wider than the
 * window makes it declare "settled" mid-loop and undercount — harmless for a
 * finite budget (the loop has already stopped), fatal here where the loop is
 * still running. This instead polls until the count climbs to `target`, and a
 * `stallMs` guard throws if it plateaus below it — which is EXACTLY the failure
 * a finite cap (e.g. the reverted `unlimited → 1`) produces, so the test stays
 * sensitive: a capped loop stalls under target and this throws.
 */
async function waitForInjectionCount(baseUrl, sessionId, target, { fromIndex = 0, timeoutMs = 480_000, stallMs = 60_000 } = {}) {
  let count = await countInjections(baseUrl, sessionId, fromIndex)
  let lastChange = Date.now()
  const deadline = Date.now() + timeoutMs
  while (count < target && Date.now() < deadline) {
    await sleep(500)
    const n = await countInjections(baseUrl, sessionId, fromIndex)
    if (n !== count) {
      count = n
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= stallMs) {
      throw new Error(
        `injections stalled at ${count} (< target ${target}) for ${stallMs}ms — ` +
        `the loop was capped below the unlimited target instead of running to the judge's completion`
      )
    }
  }
  if (count < target) throw new Error(`injections reached only ${count} of target ${target} within ${timeoutMs}ms`)
  return count
}

describe("per-turn attempt budget", { skip: SKIP && "opencode binary not in PATH", timeout: 1_800_000 }, () => {
  let server
  let baseUrl
  const model = { providerID: "test-fixture", modelID: "fixture-model" }
  /** probe -> number of judge calls seen for that session so far. */
  let judgeCalls
  const lastJudgedReply = new Map()
  /** probe -> how many distinct agent replies to answer "incomplete" before "complete". */
  const completeAfter = new Map()

  before(async () => {
    judgeCalls = new Map()
    server = await startLiveServer({
      label: "budget",
      responder: budgetResponder((ctx) => {
        // Attribute the judge call to a session by its unique probe string —
        // the judge prompt carries the conversation chain, which contains the
        // human task text. Index arithmetic over a server-wide call list
        // cannot express "this session"; content can.
        const probe = [...completeAfter.keys()].find((p) => ctx.fullText.includes(p))
        if (!probe) return verdict()
        // Duplicate idle events may rejudge one reply; only new evidence is
        // another agent iteration, not another HTTP call to the judge.
        const reply = ctx.fullText.match(/Made some progress on attempt \d+\. Stopping here for now\./g)?.at(-1)
        const changed = reply !== lastJudgedReply.get(probe)
        const n = (judgeCalls.get(probe) || 0) + (changed ? 1 : 0)
        if (changed) lastJudgedReply.set(probe, reply)
        judgeCalls.set(probe, n)
        const limit = completeAfter.get(probe)
        // ACTIONLESS sentinel first: `-1` must not fall into the `n > limit`
        // rule below, which is true for every n when limit is negative.
        if (limit === ACTIONLESS) {
          // No missing, no next actions, blank feedback.
          return verdict({ feedback: "", missing: [], next_actions: [] })
        }
        if (limit !== Infinity && n > limit) {
          return verdict({ complete: true, severity: "NONE", feedback: "All done.", missing: [], next_actions: [] })
        }
        return verdict()
      }),
    })
    baseUrl = server.baseUrl
  })

  after(async () => {
    if (server) await server.stop()
  })

  /**
   * Drive one human turn on a fresh session with a given retry budget and
   * return how many times the supervisor injected.
   */
  async function runTurn({ budget, probe, complete = Infinity, waitTarget = null, stopAfterTarget = false, waitStallMs = 60_000 }) {
    completeAfter.set(probe, complete)
    const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()

    await sendMessage(baseUrl, session.id, `/supervisor retry ${budget}`, 120_000, { model })
    goalStore.setGoal(server.projectDir, session.id, actionableTask(probe), {
      acceptanceCriteria: "Retry helper and unit tests are implemented and passing",
      verification: "Run the retry unit tests and inspect passing evidence",
    })
    // Let any supervision of the COMMAND turns finish before the real turn.
    await sleep(3000)
    // Everything already in the transcript belongs to the COMMAND turns, which
    // are separate human turns with their own turn key and their own budget.
    const startIndex = (await (await fetch(`${baseUrl}/session/${session.id}/message`)).json()).length

    await sendMessage(baseUrl, session.id, actionableTask(probe), 180_000, { model })
    // `waitTarget` proves the loop CLIMBS to a target injection count before we
    // judge it stopped — a finite cap would stall below it. `stopAfterTarget`
    // is for the UNLIMITED case: the loop never stops on its own (no ceiling,
    // judge never completes), so once it has proven it ran past `waitTarget` we
    // end the turn ourselves with `/supervisor off` (the disabled gate, which
    // plain-returns on every subsequent idle) rather than waiting forever.
    if (waitTarget != null) await waitForInjectionCount(baseUrl, session.id, waitTarget, { fromIndex: startIndex, stallMs: waitStallMs })
    if (stopAfterTarget) await sendMessage(baseUrl, session.id, "/supervisor off", 120_000, { model })
    const injections = await settleInjections(baseUrl, session.id, {
      fromIndex: startIndex,
      quietMs: waitTarget != null ? 25_000 : 15_000,
    })
    return { sessionId: session.id, injections, startIndex }
  }

  test("injects N times in ONE human turn, where N is the configured budget, and then STOPS", { timeout: 600_000 }, async () => {
    const { sessionId, injections } = await runTurn({ budget: 3, probe: "PROBE-BUDGET-3" })

    // The headline regression: this was 1 for every budget before the fix.
    assert.equal(
      injections, 3,
      `Expected exactly 3 supervisor injections in one human turn (the configured budget), got ${injections}. ` +
      `1 means the boolean "already reflected this turn" gate is back.`
    )

    // Termination was already proven by settleInjections' quiet window (it
    // waited 15s for a 4th injection that never came). Also assert the plugin
    // says WHY it stopped, so a silent crash cannot masquerade as termination.
    const log = server.debugLog()
    assert.match(
      log, /attempt-cap reached/,
      "plugin debug log must record the attempt-cap stop, not just fall silent"
    )

    // The counter is PERSISTED, not in-memory-only.
    const statePath = join(server.projectDir, ".supervisor", "sessions", sessionId, "state.json")
    assert.ok(existsSync(statePath), `expected persisted session state at ${statePath}`)
    const state = JSON.parse(readFileSync(statePath, "utf-8"))
    assert.equal(state.attempts?.count, 3, `persisted attempt counter should be 3, got ${JSON.stringify(state.attempts)}`)
    assert.ok(state.attempts?.turnKey, "persisted counter must be scoped to a turn key")
  })

  test("/supervisor retry 1 and /supervisor retry 5 produce DIFFERENT injection counts", { timeout: 900_000 }, async () => {
    const one = await runTurn({ budget: 1, probe: "PROBE-RETRY-1" })
    const five = await runTurn({ budget: 5, probe: "PROBE-RETRY-5" })

    assert.equal(one.injections, 1, `retry 1 must inject exactly once, got ${one.injections}`)
    assert.equal(five.injections, 5, `retry 5 must inject exactly 5 times, got ${five.injections}`)
    assert.notEqual(
      one.injections, five.injections,
      "retry 1 and retry 5 were identical — this is the user-visible bug: the budget had no effect"
    )
  })

  test("/supervisor retry unlimited never stands down on COUNT — no finite ceiling caps the loop", { timeout: 900_000 }, async () => {
    // The opt-out: with `unlimited` the runaway ceiling must NEVER fire. Here
    // the judge NEVER returns complete (complete: Infinity), so the ONLY thing
    // that could stop the loop on a count is a finite cap — exactly what
    // `unlimited` must not impose. We prove the injection count climbs to a
    // TARGET (8) that is far past every finite value a regression would clamp
    // to: the reverted `0 → 1`, the retired reflection cap 3, the retired goal
    // cap 16 is higher but a bug clamping there would still be caught by the
    // `maxAttempts` assertion below. Since the loop would otherwise run
    // forever, once it has proven it ran past the target we end the turn with
    // `/supervisor off` rather than waiting for a stop that never comes.
    //
    // SENSITIVITY: revert parseAttemptsValue's `0/unlimited → Infinity` and the
    // opt-out collapses to the old `0 → 1` clamp, so this turn stands down after
    // ONE injection; `waitForInjectionCount` then stalls at 1 (< target 8) and
    // throws, failing the test.
    const TARGET = 8
    const { sessionId, injections } = await runTurn({
      budget: "unlimited", probe: "PROBE-UNLIMITED", complete: Infinity,
      waitTarget: TARGET, stopAfterTarget: true, waitStallMs: 120_000,
    })
    assert.ok(
      injections >= TARGET,
      `unlimited must not cap the loop below ${TARGET}: got only ${injections}. ` +
      `A small finite value means the unlimited opt-out was silently clamped.`
    )
    // The override persists as the unlimited sentinel — proof it was not
    // silently rewritten to a finite number (e.g. the default 50).
    const state = JSON.parse(
      readFileSync(join(server.projectDir, ".supervisor", "sessions", sessionId, "state.json"), "utf-8")
    )
    assert.equal(state.maxAttempts, "unlimited", "the session override must persist as the unlimited sentinel")
    assert.ok(
      (state.attempts?.count ?? 0) >= TARGET,
      `persisted counter should reflect the ${TARGET}+ injections, got ${JSON.stringify(state.attempts)}`
    )
    // Under unlimited the runaway CEILING must never fire — a runaway_ceiling
    // record here would mean a finite cap was applied after all.
    const loopLog = join(server.projectDir, ".supervisor", "loop-exit.log")
    if (existsSync(loopLog)) {
      const ceilingForSession = readFileSync(loopLog, "utf-8").trim().split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return {} } })
        .some((r) => r.reason === "runaway_ceiling" && r.session === sessionId)
      assert.equal(ceilingForSession, false, "unlimited must never write a runaway_ceiling record")
    }
  })

  test("a complete verdict ends the turn early, without consuming the budget", { timeout: 600_000 }, async () => {
    // Budget 5, but the judge returns complete on its 3rd call — so injections
    // 1 and 2 happen and the loop stops at 2, well short of 5.
    const { injections } = await runTurn({ budget: 5, probe: "PROBE-COMPLETE-AT-3", complete: 2 })
    assert.equal(injections, 2, `expected the loop to stop at 2 injections when the judge says complete, got ${injections}`)
    assert.ok(injections < 5, "a complete verdict must dominate the budget")
  })

  test("an actionless verdict stands down immediately instead of burning the budget in a loop", { timeout: 600_000 }, async () => {
    const { injections } = await runTurn({ budget: 5, probe: "PROBE-ACTIONLESS", complete: ACTIONLESS })
    assert.equal(
      injections, 0,
      `a verdict with empty missing + empty next_actions + blank feedback must not be injected at all, got ${injections}`
    )
    assert.match(
      server.debugLog(), /no actionable content/,
      "plugin must record the actionless stand-down reason"
    )
  })

  test("unmet goal feedback carries the full contract and keeps the goal active at the runaway cap", { timeout: 600_000 }, async () => {
    const { sessionId, injections, startIndex } = await runTurn({ budget: 3, probe: "PROBE-UNMET-CONTRACT" })
    assert.equal(injections, 3)
    const feedback = (await (await fetch(`${baseUrl}/session/${sessionId}/message`)).json())
      .slice(startIndex).filter(m => m.info?.role === "user")
      .flatMap(m => m.parts || []).filter(p => p.type === "text" && p.text.includes(FEEDBACK_MARKER))
    assert.equal(feedback.length, 3)
    for (const part of feedback) {
      assert.match(part.text, /Retry helper and unit tests are implemented and passing/)
      assert.match(part.text, /Run the retry unit tests/)
      assert.doesNotMatch(part.text, /\(\s*\d+\s*\/\s*\d+\s*\)/)
    }
    const state = sessionStore.load(server.projectDir, sessionId)
    assert.equal(state.goal?.status, "active")
    assert.equal(state.mode, undefined)
    assert.equal(state.autopilot, undefined)
  })
})

// ---------------------------------------------------------------------------
// No-progress gate parity (opencode side). Own describe/server: every test
// above this line deliberately uses a VARYING fixture reply (budgetResponder's
// default) so the gate never fires and the budget itself is what's under
// test. This block does the opposite on purpose: a byte-identical agent
// reply, every attempt, to prove `evaluateNoProgress` (core/evaluation.mjs)
// really does cap a genuinely-repeating agent on the opencode runtime — the
// parity gap `no-progress-parity` (1b49b72) closed. Without this test, the
// only coverage of the no-progress gate was the CC-only hook path.
// ---------------------------------------------------------------------------
describe("no-progress gate caps a genuinely-repeating agent (opencode)", { skip: SKIP && "opencode binary not in PATH", timeout: 600_000 }, () => {
  let server
  let baseUrl
  const model = { providerID: "test-fixture", modelID: "fixture-model" }

  before(async () => {
    server = await startLiveServer({
      label: "no-progress",
      responder: budgetResponder(() => verdict(), { staticReply: true }),
    })
    baseUrl = server.baseUrl
  })

  after(async () => {
    if (server) await server.stop()
  })

  test("a byte-identical agent reply stands down after NO_PROGRESS_REPEAT_THRESHOLD repeats, even with budget left", { timeout: 600_000 }, async () => {
    const probe = "PROBE-NO-PROGRESS"
    const session = await (await fetch(`${baseUrl}/session`, { method: "POST" })).json()

    // A generous budget (5) — if this capped at 2 only because the budget
    // was small, it would prove nothing about the no-progress gate itself.
    await sendMessage(baseUrl, session.id, "/supervisor retry 5", 120_000, { model })
    goalStore.setGoal(server.projectDir, session.id, actionableTask(probe), {
      acceptanceCriteria: "Retry tests pass", verification: "Run retry tests",
    })
    await sleep(3000)
    const startIndex = (await (await fetch(`${baseUrl}/session/${session.id}/message`)).json()).length

    await sendMessage(baseUrl, session.id, actionableTask(probe), 180_000, { model })
    const injections = await settleInjections(baseUrl, session.id, { fromIndex: startIndex })

    // NO_PROGRESS_REPEAT_THRESHOLD = 2 (core/evaluation.mjs): the first
    // repeat is tolerated (injection 1), the SECOND consecutive repeat stands
    // the supervisor down before a 3rd injection — so exactly 2, not 5.
    assert.equal(
      injections, 2,
      `a genuinely repeating agent (byte-identical reply every attempt) must be capped at ` +
      `NO_PROGRESS_REPEAT_THRESHOLD (2) injections regardless of the configured budget (5), got ${injections}`
    )
    assert.match(
      server.debugLog(), /no-progress gate: standing down/,
      "plugin debug log must record the no-progress stand-down reason, not just fall silent"
    )
  })
})

// ---------------------------------------------------------------------------
// Persistence across a real server restart. Its own describe block because it
// stops and re-spawns the server over the SAME project dir and $HOME.
// ---------------------------------------------------------------------------
describe("per-turn budget survives a server restart", { skip: SKIP && "opencode binary not in PATH", timeout: 1_800_000 }, () => {
  test("a restarted server resumes the spent budget instead of starting the turn over", { timeout: 900_000 }, async () => {
    const model = { providerID: "test-fixture", modelID: "fixture-model" }
    const probe = "PROBE-RESTART"
    let serverA = await startLiveServer({ label: "restart-a", responder: budgetResponder(() => verdict()) })
    let sessionId
    let projectDir = serverA.projectDir
    let isolatedHome = serverA.isolatedHome

    try {
      const session = await (await fetch(`${serverA.baseUrl}/session`, { method: "POST" })).json()
      sessionId = session.id
      await sendMessage(serverA.baseUrl, sessionId, "/supervisor retry 2", 120_000, { model })
      goalStore.setGoal(serverA.projectDir, sessionId, actionableTask(probe), {
        acceptanceCriteria: "Retry tests pass", verification: "Run retry tests",
      })
      await sleep(3000)
      const startIndex = (await (await fetch(`${serverA.baseUrl}/session/${sessionId}/message`)).json()).length
      await sendMessage(serverA.baseUrl, sessionId, actionableTask(probe), 180_000, { model })
      const spent = await settleInjections(serverA.baseUrl, sessionId, { fromIndex: startIndex })
      assert.equal(spent, 2, `expected the budget of 2 to be spent before the restart, got ${spent}`)
    } finally {
      await serverA.stop({ keepDirs: true })
    }

    // Restart over the same state. opencode persists sessions under $HOME; the
    // supervisor persists its counter under <projectDir>/.supervisor.
    const serverB = await startLiveServer({
      label: "restart-b",
      projectDir,
      isolatedHome,
      responder: budgetResponder(() => verdict()),
    })
    try {
      const countBefore = await countInjections(serverB.baseUrl, sessionId)
      assert.ok(countBefore >= 2, `restarted server must still see the pre-restart transcript, saw ${countBefore} injections`)

      // Resume the SAME human turn. A message carrying FEEDBACK_MARKER is
      // skipped by getLastRelevantUserMessageId, so the turn key does not
      // move — this is exactly a mid-turn resume, not a new turn. A plain
      // message would legitimately reset the budget and prove nothing.
      await sendMessage(
        serverB.baseUrl, sessionId,
        `${FEEDBACK_MARKER} Continue\n\nKeep going on the same task.`,
        180_000, { model },
      )
      const after = await settleInjections(serverB.baseUrl, sessionId)

      assert.equal(
        after, countBefore + 1,
        `the restarted server must not inject again on an already-spent turn — ` +
        `expected only the test's own probe message (${countBefore + 1}), got ${after}. ` +
        `An in-memory-only counter resets to 0 on restart and would inject 2 more times.`
      )
      assert.match(
        serverB.debugLog(), /attempt-cap reached/,
        "restarted server must report the cap, proving it READ the persisted counter"
      )
    } finally {
      await serverB.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Last-resort watchdog for a stuck event loop, AFTER every suite in this file.
//
// Must be top-level and last: as a per-describe hook it force-exits the whole
// process before later describes have run, which is exactly how the per-turn
// budget suites above were silently skipped while the run still reported PASS.
// ---------------------------------------------------------------------------
after(() => {
  setTimeout(() => process.exit(0), 2000).unref()
})
