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
 * Run: node --experimental-strip-types --test test/e2e-opencode.test.mjs
 */

import { describe, test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { startFixtureLlmServer } from "./helpers/opencode-fixture-llm.mjs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = join(__dirname, "..")
const PLUGIN_PATH = join(REPO_ROOT, "opencode", "supervisor.ts")

// Ambient credential env vars known to auto-enable real remote providers in
// this environment (GitHub Copilot/Models via gh CLI token, Cloudflare AI
// Gateway, etc). Stripped from the spawned server's env as defense in depth
// on top of the isolated $HOME — belt and suspenders so the isolated server
// can never reach a real provider even by accident. This does NOT touch the
// user's actual global config/credentials; it only affects this child
// process's environment.
const AMBIENT_PROVIDER_ENV_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "CLOUDFLARE_API_TOKEN",
  "AZURE_DEV_AI_API_KEY", "AZURE_DEV_AI_BASE_URL",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if `opencode` binary is available in PATH. */
function hasOpencode() {
  try {
    execSync("which opencode", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/** Find a free TCP port by briefly binding to port 0. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

/** Poll a URL until it responds with status 200 or timeout expires. */
async function waitForHealth(url, timeoutMs = 15_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms at ${url}`)
}

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
    assert.equal(res.status, 200, `Expected 200 for "${text}", got ${res.status}`)
    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    throw new Error(`Message "${text}" failed: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const SKIP = !hasOpencode()

describe("opencode supervisor plugin E2E", { skip: SKIP && "opencode binary not in PATH", timeout: 1_800_000 }, () => {
  let serverProc
  let baseUrl
  let tmpDir
  let isolatedHome
  let fixtureLlm
  const model = { providerID: "test-fixture", modelID: "fixture-model" }

  before(async () => {
    // 1. Isolated project directory (server cwd / project config root).
    tmpDir = mkdtempSync(join(tmpdir(), "sup-e2e-oc-"))

    // 2. Isolated $HOME — no global opencode.json, no auth.json, no global
    //    plugins. See the module docstring above for why this matters.
    isolatedHome = mkdtempSync(join(tmpdir(), "sup-e2e-home-"))

    // 3. Local deterministic fixture LLM (see test/helpers/opencode-fixture-llm.mjs).
    fixtureLlm = await startFixtureLlmServer()

    // 4. Project config: only this worktree's plugin, and a custom
    //    OpenAI-compatible provider pointing at the fixture (same mechanism
    //    documented at https://opencode.ai/docs/providers/#atomic-chat).
    const cfg = {
      $schema: "https://opencode.ai/config.json",
      plugin: [PLUGIN_PATH],
      model: `${model.providerID}/${model.modelID}`,
      provider: {
        [model.providerID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Test Fixture (local, deterministic)",
          options: {
            baseURL: fixtureLlm.baseURL,
            apiKey: "fixture-key",
          },
          models: {
            [model.modelID]: {
              name: "Fixture Model",
              tool_call: true,
              cost: { input: 0, output: 0 },
              limit: { context: 32_000, output: 4096 },
            },
          },
        },
      },
    }
    writeFileSync(join(tmpDir, "opencode.json"), JSON.stringify(cfg, null, 2))

    // 5. Spawn the real server with the isolated $HOME and without ambient
    //    provider credentials.
    const port = await findFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    const childEnv = { ...process.env, HOME: isolatedHome }
    for (const key of AMBIENT_PROVIDER_ENV_VARS) delete childEnv[key]

    serverProc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: childEnv,
    })

    let stderrBuf = ""
    serverProc.stdout.on("data", (chunk) => {
      process.stdout.write("[opencode.stdout] " + chunk.toString())
    })
    serverProc.stderr.on("data", (chunk) => {
      const s = chunk.toString()
      stderrBuf += s
      process.stderr.write("[opencode.stderr] " + s)
    })
    serverProc.stdout?.unref?.()
    serverProc.stderr?.unref?.()
    serverProc.unref()

    // 6. Wait for health.
    try {
      await Promise.race([
        waitForHealth(`${baseUrl}/global/health`),
        new Promise((_, reject) => {
          serverProc.on("exit", (code) => {
            reject(new Error(`opencode serve exited early (code ${code}). stderr:\n${stderrBuf}`))
          })
        }),
      ])
    } catch (err) {
      serverProc.kill("SIGTERM")
      throw err
    }

    process.stdout.write(`[e2e] fixture model: ${model.providerID}/${model.modelID} @ ${fixtureLlm.baseURL}\n`)
  })

  after(async () => {
    // Kill the process group (detached spawn uses its own group)
    if (serverProc && !serverProc.killed) {
      try {
        process.kill(-serverProc.pid, "SIGKILL")
      } catch {
        try { serverProc.kill("SIGKILL") } catch { /* ignore */ }
      }
    }
    // Destroy remaining pipe streams to prevent hanging
    serverProc?.stdout?.destroy()
    serverProc?.stderr?.destroy()
    // Close the fixture LLM server.
    if (fixtureLlm) {
      try { await fixtureLlm.close() } catch { /* ignore */ }
    }
    // Clean up temp directories.
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true })
    // Force exit after a brief delay if node won't quit
    setTimeout(() => process.exit(0), 500).unref()
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
    // The supervisor plugin must register a /supervisor command
    const hasSupervisorRelated = commandNames.some(
      (name) => name === "autopilot" || name.includes("supervisor")
    )
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
  test("supervisor goal command with no condition derives and persists .agents/supervisor/goal.md", { timeout: 300_000 }, async () => {
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Give the session a task to derive a goal FROM (deriveAndSetGoal reads
    // the session transcript via buildTaskContext).
    await sendMessage(baseUrl, session.id, "Add input validation to the login form.", 120_000, { model })

    // No condition, no existing session/project goal — must attempt LLM
    // derivation (align-supervisor-modes binding contract) rather than
    // silently no-op or fabricate a default.
    const goalRes = await sendMessage(baseUrl, session.id, "/supervisor goal", 120_000, { model })
    assert.ok(goalRes, "Goal derivation response should not be null")
    const goalContent = JSON.stringify(goalRes)

    const goalMdPath = join(tmpDir, ".agents", "supervisor", "goal.md")
    assert.ok(existsSync(goalMdPath), `Expected derived goal to be persisted at ${goalMdPath}`)
    const persisted = readFileSync(goalMdPath, "utf8").trim()
    assert.ok(persisted.length > 0, "Derived goal.md should not be empty")
    assert.ok(
      goalContent.toLowerCase().includes("derived") || goalContent.includes(persisted),
      `Expected goal response to acknowledge derivation or echo the persisted condition. Got: ${goalContent.slice(0, 500)}`
    )
  })

  test("supervisor goal set/status/clear works", { timeout: 900_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // 1. Set a goal
    const setRes = await sendMessage(baseUrl, session.id, "/supervisor goal all tests pass", 300_000, { model })
    assert.ok(setRes, "Goal set response should not be null")
    const setContent = JSON.stringify(setRes).toLowerCase()
    assert.ok(
      setContent.includes("goal") || setContent.includes("all tests pass"),
      `Expected goal set response to mention "goal" or the condition. Got: ${JSON.stringify(setRes).slice(0, 500)}`
    )

    // 2. Check status — should reflect the active goal
    const statusRes = await sendMessage(baseUrl, session.id, "/supervisor goal", 300_000, { model })
    assert.ok(statusRes, "Goal status response should not be null")
    const statusContent = JSON.stringify(statusRes).toLowerCase()
    assert.ok(
      statusContent.includes("all tests pass") || statusContent.includes("goal"),
      `Expected goal status to mention the goal condition. Got: ${JSON.stringify(statusRes).slice(0, 500)}`
    )

    // 3. Clear the goal
    const clearRes = await sendMessage(baseUrl, session.id, "/supervisor goal clear", 300_000, { model })
    assert.ok(clearRes, "Goal clear response should not be null")
    const clearContent = JSON.stringify(clearRes).toLowerCase()
    assert.ok(
      clearContent.includes("clear") || clearContent.includes("no goal") || clearContent.includes("removed"),
      `Expected goal clear response to mention "clear" or "no goal". Got: ${JSON.stringify(clearRes).slice(0, 500)}`
    )
  })

  test("supervisor reflection mode works", { timeout: 600_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Send reflection command
    const res = await sendMessage(baseUrl, session.id, "/supervisor reflection", 300_000, { model })
    assert.ok(res, "Reflection response should not be null")
    const content = JSON.stringify(res).toLowerCase()
    assert.ok(
      content.includes("reflection") || content.includes("mode") || content.includes("supervisor"),
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

  describe("autopilot mode", () => {
    // Uses the suite-level fixture `model` — no cooldown needed since the
    // fixture is local and instantaneous (no remote rate limiting to avoid).

    // Proves the real `autopilot_exit` tool (opencode/supervisor-impl.ts,
    // executeAutopilotExit) round-trips end to end: enabling autopilot makes
    // the tool available to the model; a plain, non-"/supervisor"
    // continuation-style message (standing in for the nudge the plugin's own
    // session.idle handler injects) causes the fixture to call it, the real
    // server executes it, and supervisorStore records autopilot as disabled
    // for the session — the concrete mechanism by which "the agent must call
    // autopilot_exit to stop" (see the tool's own description string) works.
    test("autopilot_exit tool ends autopilot mode for the session", { timeout: 300_000 }, async () => {
      const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
      assert.equal(createRes.status, 200)
      const session = await createRes.json()

      const enableRes = await sendMessage(baseUrl, session.id, "/supervisor autopilot", 120_000, { model })
      assert.ok(JSON.stringify(enableRes).toLowerCase().includes("autopilot"))

      // Plain continuation nudge — no "/supervisor" prefix, tools available.
      // The fixture routes this to autopilot_exit (see
      // test/helpers/opencode-fixture-llm.mjs), exactly as a real model is
      // instructed to once "genuinely completed ALL work" (see the
      // autopilotExitDescription / continuation-nudge prompt text in
      // opencode/supervisor-impl.ts).
      const exitRes = await sendMessage(baseUrl, session.id, "Continue with the next step.", 120_000, { model })
      const exitContent = JSON.stringify(exitRes).toLowerCase()
      assert.ok(
        exitContent.includes("exit") || exitContent.includes("autopilot completed"),
        `Expected autopilot_exit tool round-trip to be reflected in the response. Got: ${JSON.stringify(exitRes).slice(0, 500)}`
      )

      // Confirm the mode was actually flipped off server-side (not merely
      // that the tool call text was echoed) by checking status afterward.
      // executeAutopilotExit -> supervisorStore.setAutopilot(..., false) ->
      // setMode(..., DEFAULT_SUPERVISOR_MODE) i.e. "reflection"
      // (core/goal.mjs), so the status report's "mode:" line must read
      // "reflection", never "autopilot".
      const statusRes = await sendMessage(baseUrl, session.id, "/supervisor", 120_000, { model })
      const statusContent = JSON.stringify(statusRes).toLowerCase()
      assert.ok(
        statusContent.includes("mode: reflection"),
        `Expected mode: reflection after autopilot_exit. Got: ${JSON.stringify(statusRes).slice(0, 500)}`
      )
      assert.ok(
        !statusContent.includes("mode: autopilot"),
        `Expected autopilot to be disabled after autopilot_exit. Got: ${JSON.stringify(statusRes).slice(0, 500)}`
      )
    })

    test("autopilot lifecycle: enable, status, switch to reflection, switch to goal", { timeout: 900_000 }, async () => {
      const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
      assert.equal(createRes.status, 200)
      const session = await createRes.json()

      // 1. Enable autopilot via slash command
      const enableRes = await sendMessage(baseUrl, session.id, "/supervisor autopilot", 300_000, { model })
      assert.ok(enableRes, "Autopilot enable response should not be null")
      const enableContent = JSON.stringify(enableRes).toLowerCase()
      assert.ok(
        enableContent.includes("autopilot") && (enableContent.includes("enabled") || enableContent.includes("mode")),
        `Expected autopilot response to mention "autopilot" and "enabled" or "mode". Got: ${JSON.stringify(enableRes).slice(0, 500)}`
      )

      // 2. Check status — should reflect autopilot mode
      const statusRes = await sendMessage(baseUrl, session.id, "/supervisor", 300_000, { model })
      assert.ok(statusRes, "Status response should not be null")
      const statusContent = JSON.stringify(statusRes).toLowerCase()
      assert.ok(
        statusContent.includes("autopilot") || statusContent.includes("supervisor") || statusContent.includes("mode") || statusContent.includes("enabled"),
        `Expected status response to mention supervisor state. Got: ${JSON.stringify(statusRes).slice(0, 500)}`
      )

      // 3. Switch to reflection mode
      const reflectionRes = await sendMessage(baseUrl, session.id, "/supervisor reflection", 300_000, { model })
      assert.ok(reflectionRes, "Reflection switch response should not be null")
      const reflectionContent = JSON.stringify(reflectionRes).toLowerCase()
      assert.ok(
        reflectionContent.includes("reflection") || reflectionContent.includes("mode"),
        `Expected reflection response to mention "reflection" or "mode". Got: ${JSON.stringify(reflectionRes).slice(0, 500)}`
      )

      // 4. Switch to goal mode (from reflection, proving full mode cycle works)
      const goalRes = await sendMessage(baseUrl, session.id, "/supervisor goal tests pass", 300_000, { model })
      assert.ok(goalRes, "Goal switch response should not be null")
      const goalContent = JSON.stringify(goalRes).toLowerCase()
      assert.ok(
        goalContent.includes("goal") || goalContent.includes("supervisor") || goalContent.includes("tests pass"),
        `Expected goal response to acknowledge the command. Got: ${JSON.stringify(goalRes).slice(0, 500)}`
      )
    })
  })
})
