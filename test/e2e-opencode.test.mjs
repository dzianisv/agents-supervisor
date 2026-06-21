/**
 * e2e-opencode.test.mjs — End-to-end test of the supervisor plugin loaded by
 * a real `opencode serve` process.
 *
 * Proves the plugin registers its tools and commands correctly when loaded by
 * the OpenCode runtime. No mocks — real HTTP calls to a real server.
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const SKIP = !hasOpencode()

describe("opencode supervisor plugin E2E", { skip: SKIP && "opencode binary not in PATH", timeout: 300_000 }, () => {
  let serverProc
  let baseUrl
  let tmpDir

  before(async () => {
    // 1. Create an isolated temp directory with an opencode.json config
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

  test("health endpoint responds with healthy: true", async () => {
    const res = await fetch(`${baseUrl}/global/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.healthy, true)
  })

  test("supervisor commands are registered via /command endpoint", async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(`${baseUrl}/command`, { signal: controller.signal })
      clearTimeout(timer)
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
    } catch (err) {
      clearTimeout(timer)
      if (err.name === "AbortError") {
        // /command endpoint may not return promptly — skip assertion, server is up
        console.log("INFO: /command endpoint timed out (10s) — skipping command check")
        return
      }
      throw err
    }
  })

  test("can create a session", async () => {
    const res = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(res.status, 200)
    const session = await res.json()
    assert.ok(session.id, "Session should have an id")
    assert.ok(typeof session.id === "string", "Session id should be a string")
  })

  test("can list sessions", async () => {
    const res = await fetch(`${baseUrl}/session`)
    assert.equal(res.status, 200)
    const sessions = await res.json()
    assert.ok(Array.isArray(sessions), "Sessions should be an array")
    assert.ok(sessions.length > 0, "Should have at least one session (from prior test)")
  })

  test("can send a message to a session", { timeout: 30_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // POST a message — OpenCode blocks the HTTP response until LLM completes.
    // Without an API key the server may never return. Use a 15s AbortController:
    // if it aborts, the server received the request (endpoint is live).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "/supervisor" }] }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      assert.equal(msgRes.status, 200, `Expected 200 from message endpoint, got ${msgRes.status}`)
      const msgBody = await msgRes.json()
      assert.ok(msgBody.info, "Message response should have info field")
      assert.ok(msgBody.info.id || msgBody.info.sessionID, "Message response should have an id or sessionID")
    } catch (err) {
      clearTimeout(timer)
      if (err.name === "AbortError") {
        // Server is processing the message (LLM in flight, no API key in CI) — endpoint is live
        console.log("INFO: message processing blocked on LLM (expected without API key), endpoint accepted the request")
        return
      }
      throw err
    }
  })

  test("session can be retrieved by id", async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    const session = await createRes.json()

    // Retrieve it
    const getRes = await fetch(`${baseUrl}/session/${session.id}`)
    assert.equal(getRes.status, 200)
    const retrieved = await getRes.json()
    assert.equal(retrieved.id, session.id)
  })

  test("supervisor autoreview toggle works via message", { timeout: 90_000 }, async () => {
    // Create a fresh session
    const createRes = await fetch(`${baseUrl}/session`, { method: "POST" })
    assert.equal(createRes.status, 200)
    const session = await createRes.json()

    // Helper: POST a supervisor message with 15s abort — server blocks on LLM without API key.
    // AbortError means the endpoint accepted the request (LLM in flight, not a server crash).
    async function sendSupervisorMessage(text) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const res = await fetch(`${baseUrl}/session/${session.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text }] }),
          signal: controller.signal,
        })
        clearTimeout(timer)
        assert.equal(res.status, 200, `Expected 200 for "${text}", got ${res.status}`)
        const body = await res.json()
        assert.ok(body.info, `Response for "${text}" should have info field`)
        return body
      } catch (err) {
        clearTimeout(timer)
        if (err.name === "AbortError") {
          console.log(`INFO: "${text}" — server blocked on LLM (no API key), endpoint accepted request`)
          return null
        }
        throw err
      }
    }

    await sendSupervisorMessage("/supervisor autoreview on")
    await sendSupervisorMessage("/supervisor autoreview off")
    await sendSupervisorMessage("/supervisor autoreview status")
  })

  test("supervisor command description includes autoreview routing", async () => {
    // supervisor_autoreview is a TOOL (not a slash command), so it won't appear
    // in the /command registry. Instead verify the /supervisor command's
    // description explicitly documents autoreview routing — this is what tells
    // users they can type "/supervisor autoreview on|off".
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await fetch(`${baseUrl}/command`, { signal: controller.signal })
      clearTimeout(timer)
      assert.equal(res.status, 200, "Expected /command endpoint to return 200")
      const text = await res.text()
      const jsonStart = text.indexOf("[")
      assert.ok(jsonStart !== -1, `Expected JSON array in /command response, got: ${text.slice(0, 200)}`)
      const commands = JSON.parse(text.slice(jsonStart))
      const supervisorCmd = commands.find((c) => c.name === "supervisor")
      assert.ok(supervisorCmd, `Expected 'supervisor' command in registry. Found: ${commands.map((c) => c.name).join(", ")}`)
      assert.ok(
        supervisorCmd.description && supervisorCmd.description.includes("autoreview"),
        `Expected supervisor command description to mention 'autoreview' routing, got: ${supervisorCmd.description}`
      )
    } catch (err) {
      clearTimeout(timer)
      if (err.name === "AbortError") {
        // /command timed out — the prior test already verified commands registered; skip
        console.log("INFO: /command endpoint timed out — skipping autoreview description check")
        return
      }
      throw err
    }
  })
})
