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

describe("opencode supervisor plugin E2E", { skip: SKIP && "opencode binary not in PATH", timeout: 300_000 }, () => {
  let serverProc
  let baseUrl
  let tmpDir

  before(async () => {
    // 1. Create an isolated temp directory with a minimal opencode.json config.
    //    Only the plugin field is needed — providers come from the global config
    //    at ~/.config/opencode/opencode.json (github-copilot is pre-authenticated).
    tmpDir = mkdtempSync(join(tmpdir(), "sup-e2e-oc-"))
    writeFileSync(
      join(tmpDir, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [PLUGIN_PATH],
        },
        null,
        2
      )
    )

    // 2. Pick a free port
    const port = await findFreePort()
    baseUrl = `http://127.0.0.1:${port}`

    // 3. Spawn `opencode serve` pointing at our temp config directory
    serverProc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: tmpDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        HOME: process.env.HOME,
      },
    })

    // Collect stderr for debugging if startup fails
    let stderrBuf = ""
    serverProc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString()
    })
    // Unref streams and process so node doesn't hang on open pipes after tests
    serverProc.stdout?.unref?.()
    serverProc.stderr?.unref?.()
    serverProc.unref()

    // If process exits before health check, fail fast
    const exitPromise = new Promise((_, reject) => {
      serverProc.on("exit", (code) => {
        reject(new Error(`opencode serve exited early (code ${code}). stderr:\n${stderrBuf}`))
      })
    })

    // 4. Wait for the health endpoint to respond
    try {
      await Promise.race([
        waitForHealth(`${baseUrl}/global/health`),
        exitPromise,
      ])
    } catch (err) {
      // Clean up if we can't start
      serverProc.kill("SIGTERM")
      throw err
    }
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

  test("supervisor goal set/status/clear works", { timeout: 300_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // The goal command triggers an LLM call (slash command → brainstormer agent).
    // Use a model confirmed available via github-copilot provider.
    const model = { providerID: "github-copilot", modelID: "gemini-3.5-flash" }

    // 1. Set a goal
    const setRes = await sendMessage(baseUrl, session.id, "/supervisor goal all tests pass", 90_000, { model })
    assert.ok(setRes, "Goal set response should not be null")
    const setContent = JSON.stringify(setRes).toLowerCase()
    assert.ok(
      setContent.includes("goal") || setContent.includes("all tests pass"),
      `Expected goal set response to mention "goal" or the condition. Got: ${JSON.stringify(setRes).slice(0, 500)}`
    )

    // 2. Check status — should reflect the active goal
    const statusRes = await sendMessage(baseUrl, session.id, "/supervisor goal", 90_000, { model })
    assert.ok(statusRes, "Goal status response should not be null")
    const statusContent = JSON.stringify(statusRes).toLowerCase()
    assert.ok(
      statusContent.includes("all tests pass") || statusContent.includes("goal"),
      `Expected goal status to mention the goal condition. Got: ${JSON.stringify(statusRes).slice(0, 500)}`
    )

    // 3. Clear the goal
    const clearRes = await sendMessage(baseUrl, session.id, "/supervisor goal clear", 90_000, { model })
    assert.ok(clearRes, "Goal clear response should not be null")
    const clearContent = JSON.stringify(clearRes).toLowerCase()
    assert.ok(
      clearContent.includes("clear") || clearContent.includes("no goal") || clearContent.includes("removed"),
      `Expected goal clear response to mention "clear" or "no goal". Got: ${JSON.stringify(clearRes).slice(0, 500)}`
    )
  })

  test("supervisor reflection mode works", { timeout: 120_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Send reflection command
    const res = await sendMessage(baseUrl, session.id, "/supervisor reflection", 60_000)
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
})
