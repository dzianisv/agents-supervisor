/**
 * e2e-opencode.test.mjs — End-to-end test of the supervisor plugin loaded by
 * a real `opencode serve` process using the globally-configured providers.
 *
 * Proves the plugin registers its tools and commands correctly, and that
 * supervisor slash commands produce real LLM-backed responses.
 *
 * Run: node --experimental-strip-types --test test/e2e-opencode.test.mjs
 */

import { describe, test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = join(__dirname, "..")
const PLUGIN_PATH = join(REPO_ROOT, "opencode", "supervisor.ts")

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

/**
 * Query the running opencode server for a free, text-capable model from a
 * connected provider. Probes each candidate with a brief test message to
 * verify actual API access (being listed as free does not guarantee access).
 *
 * Returns { providerID, modelID } or throws if no working model is found.
 * Priority: opencode → github-models → others.
 */
async function pickFreeModel(baseUrl) {
  const res = await fetch(`${baseUrl}/provider`)
  if (!res.ok) throw new Error(`/provider returned ${res.status}`)
  const { all = [], connected = [] } = await res.json()
  const connectedSet = new Set(connected)

  const PRIORITY = ["opencode", "github-models"]
  const candidates = []
  for (const provider of all) {
    if (!connectedSet.has(provider.id)) continue
    for (const [modelId, model] of Object.entries(provider.models || {})) {
      const { input: inputCost = 999, output: outputCost = 999 } = model.cost || {}
      if (inputCost !== 0 || outputCost !== 0) continue
      if (model.status !== "active") continue
      const inputCaps = (model.capabilities || {}).input || {}
      const outputCaps = (model.capabilities || {}).output || {}
      if (inputCaps.text === false || outputCaps.text === false) continue
      candidates.push({ providerID: provider.id, modelID: modelId })
    }
  }

  candidates.sort((a, b) => {
    const ai = PRIORITY.indexOf(a.providerID)
    const bi = PRIORITY.indexOf(b.providerID)
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
  })

  if (candidates.length === 0) {
    throw new Error(
      "No free text-capable model found in connected providers. " +
      "Configure a provider in ~/.config/opencode/opencode.json"
    )
  }

  // Probe each candidate — a model listed as free may still deny access.
  // Use a 30s timeout per probe; fast API errors (< 2s) let us scan quickly.
  for (const candidate of candidates) {
    try {
      const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
      if (!createRes.ok) continue
      const { id: sessionId } = await createRes.json()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      let probeOk = false
      try {
        const probeRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parts: [{ type: "text", text: "hi" }],
            model: { providerID: candidate.providerID, modelID: candidate.modelID },
          }),
          signal: controller.signal,
        })
        if (probeRes.ok) {
          const data = await probeRes.json()
          // APIError in the info.error field means no access — skip this model
          const hasApiError = JSON.stringify(data).includes('"name":"APIError"')
          probeOk = !hasApiError
        }
      } catch {
        // timeout or network error — model too slow or unreachable, skip
      } finally {
        clearTimeout(timer)
      }

      if (probeOk) {
        process.stdout.write(`[e2e] model: ${candidate.providerID}/${candidate.modelID}\n`)
        return candidate
      }
      process.stdout.write(`[e2e] skip ${candidate.providerID}/${candidate.modelID} (no access or timeout)\n`)
    } catch {
      // skip
    }
  }

  throw new Error(
    "No working free text-capable model found in connected providers. " +
    "Configure a provider in ~/.config/opencode/opencode.json"
  )
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
 * Send a message to a session and wait for the full LLM response.
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
  let model   // auto-discovered free model, set in before()

  before(async () => {
    // 1. Create an isolated temp directory.
    tmpDir = mkdtempSync(join(tmpdir(), "sup-e2e-oc-"))

    function writeConfig(modelSpec) {
      const cfg = { $schema: "https://opencode.ai/config.json", plugin: [PLUGIN_PATH] }
      if (modelSpec) {
        cfg.model = modelSpec
      }
      writeFileSync(join(tmpDir, "opencode.json"), JSON.stringify(cfg, null, 2))
    }

    // Phase 1: start a throwaway server in a SEPARATE temp directory to query
    // /provider and probe for an accessible free model. A separate dir avoids
    // leaving stale probe-session DB rows that would confuse the real server.
    // Writing the free model into the real server's config BEFORE starting it
    // ensures supervisor continuations (no model in body) use it too.
    const discoverDir = mkdtempSync(join(tmpdir(), "sup-e2e-discover-"))
    const discoverCfg = { $schema: "https://opencode.ai/config.json", plugin: [PLUGIN_PATH] }
    writeFileSync(join(discoverDir, "opencode.json"), JSON.stringify(discoverCfg, null, 2))
    const discoverPort = await findFreePort()
    const discoverProc = spawn("opencode", ["serve", "--port", String(discoverPort), "--hostname", "127.0.0.1"], {
      cwd: discoverDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, HOME: process.env.HOME },
    })
    discoverProc.stdout.on("data", (c) => process.stdout.write("[opencode.discover] " + c.toString()))
    discoverProc.stderr.on("data", (c) => process.stderr.write("[opencode.discover] " + c.toString()))
    discoverProc.stdout?.unref?.()
    discoverProc.stderr?.unref?.()
    discoverProc.unref()

    try {
      await Promise.race([
        waitForHealth(`http://127.0.0.1:${discoverPort}/global/health`),
        new Promise((_, rej) => discoverProc.on("exit", (code) => rej(new Error(`discover server exited (code ${code})`)))),
      ])
      model = await pickFreeModel(`http://127.0.0.1:${discoverPort}`)
    } finally {
      try { process.kill(-discoverProc.pid, "SIGKILL") } catch { try { discoverProc.kill("SIGKILL") } catch { /* ignore */ } }
      discoverProc.stdout?.destroy()
      discoverProc.stderr?.destroy()
      try { rmSync(discoverDir, { recursive: true, force: true }) } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400)) // let OS reclaim the port
    }

    // 2. Write final config with the discovered free model as the session default.
    writeConfig(`${model.providerID}/${model.modelID}`)

    // 3. Spawn the real server.
    const port = await findFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    serverProc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, HOME: process.env.HOME },
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

    // 4. Wait for health.
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

    process.stdout.write(`[e2e] LLM model: ${model.providerID}/${model.modelID}\n`)
  })

  after(() => {
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
    // Clean up temp directory
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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

  test("supervisor goal set/status/clear works", { timeout: 900_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // The goal command triggers an LLM call (slash command → brainstormer agent).
    // `model` is auto-discovered from connected providers in before().

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
    // Uses the suite-level `model` auto-discovered in before().

    // Cool down after prior LLM-heavy tests to avoid provider rate limiting.
    // The goal test makes 3 LLM calls and reflection makes 1 — spacing them
    // out prevents hitting the opencode provider rate window.
    before(async () => {
      await new Promise(r => setTimeout(r, 30_000))
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
