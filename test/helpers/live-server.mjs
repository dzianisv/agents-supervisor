/**
 * live-server.mjs — spawn a REAL `opencode serve` with this repo's supervisor
 * plugin loaded, backed by a local recording fixture model, in a fully
 * isolated $HOME + project directory.
 *
 * Extracted from test/e2e-opencode.test.mjs so the E2E suite and the
 * live-validation harness (test/live-validation.mjs) share ONE spawn/teardown
 * path instead of drifting apart. The isolation rationale, the ambient-env
 * strip lists and the fixture-provider config all live here now; see
 * test/e2e-opencode.test.mjs's module docstring for why each of them matters.
 */

import { spawn, execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { startFixtureLlmServer } from "./opencode-fixture-llm.mjs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
export const REPO_ROOT = join(__dirname, "..", "..")
export const PLUGIN_PATH = join(REPO_ROOT, "opencode", "supervisor.ts")

/**
 * Ambient credential env vars known to auto-enable real remote providers in
 * this environment (GitHub Copilot/Models via gh CLI token, Cloudflare AI
 * Gateway, etc). Stripped from the spawned server's env as defense in depth on
 * top of the isolated $HOME. Does NOT touch the user's actual credentials —
 * only this child process's environment.
 */
export const AMBIENT_PROVIDER_ENV_VARS = [
  "GITHUB_TOKEN", "GH_TOKEN", "CLOUDFLARE_API_TOKEN",
  "AZURE_DEV_AI_API_KEY", "AZURE_DEV_AI_BASE_URL",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY",
]

/**
 * Ambient env that reconfigures the *server itself* rather than a provider.
 * OPENCODE_SERVER_PASSWORD makes `opencode serve` demand HTTP basic auth, so
 * every unauthenticated request (including the health poll) gets a 401. The
 * opencode desktop app exports it into the user's shell.
 */
export const AMBIENT_SERVER_ENV_VARS = [
  "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
  "OPENCODE_URL", "OPENCODE_CLIENT",
]

/** Check if the `opencode` binary is available in PATH. */
export function hasOpencode() {
  try {
    execSync("which opencode", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Bind an ephemeral port and HOLD it until the caller is ready to hand it to
 * the server.
 *
 * `findFreePort`-then-`spawn` is a TOCTOU race: between closing the probe
 * socket and `opencode serve` binding, anything else on the machine (another
 * copy of this same suite, running concurrently under `node --test`) can take
 * the port. Keeping the listener open until the last possible moment and
 * releasing it synchronously right before spawn shrinks that window to
 * effectively nothing, and — more importantly — guarantees two concurrent
 * callers in the SAME process can never be handed the same number.
 *
 * @returns {Promise<{port: number, release: () => Promise<void>}>}
 */
export function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      resolve({
        port,
        release: () => new Promise((r) => srv.close(() => r())),
      })
    })
  })
}

/** Back-compat alias used by older call sites. */
export async function findFreePort() {
  const { port, release } = await reserveFreePort()
  await release()
  return port
}

/**
 * Poll a URL until it responds 200, or the deadline expires.
 *
 * TWO defects this fixes, both observed against a real `opencode serve`:
 *
 *  1. A hung request used to defeat the deadline entirely. `await fetch(url)`
 *     with no signal blocks until the OS gives up (measured: >300s on a
 *     server that accepted the socket but never answered), so the
 *     `while (Date.now() < deadline)` guard never got a chance to re-run and
 *     the whole suite sat there until node:test cancelled it — 14 tests
 *     "cancelled", zero useful output. Every attempt now carries its own
 *     short AbortSignal.
 *  2. A flat 15s budget is too tight when this suite is run alongside 30+
 *     other test files on 8 cores. The budget is now generous and the poll
 *     backs off from 100ms to a 1s ceiling, so a fast boot is still detected
 *     in ~100ms and a slow one is waited out instead of failed.
 */
export async function waitForHealth(url, timeoutMs = 90_000, attemptTimeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  let interval = 100
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) })
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, interval))
    interval = Math.min(1000, Math.round(interval * 1.5))
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms at ${url}: ${lastErr?.message || "no response"}`)
}

/**
 * Spawn a real `opencode serve` with the supervisor plugin and a local fixture
 * model.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] parent dir for the isolated project/$HOME (default: os tmpdir)
 * @param {string} [opts.label] short label used in the temp dir names
 * @param {string} [opts.projectDir] REUSE an existing project dir instead of minting one.
 *   Pair with `isolatedHome` to restart a server over the same state — opencode
 *   persists sessions under $HOME, and the supervisor persists per-session
 *   machine state under <projectDir>/.supervisor. opencode.json is rewritten
 *   either way, so the restarted server picks up the NEW fixture port.
 * @param {string} [opts.isolatedHome] REUSE an existing $HOME (see `projectDir`)
 * @param {(ctx: object) => object|null} [opts.responder] fixture LLM steering hook
 * @param {(projectDir: string) => void} [opts.seedProject] runs after the project dir exists, BEFORE the server starts
 * @param {Record<string,unknown>} [opts.configPatch] merged into the generated opencode.json
 * @param {boolean} [opts.captureOutput] keep server stdout/stderr in memory
 * @returns {Promise<object>} server handle
 */
export async function startLiveServer(opts = {}) {
  const root = opts.root || tmpdir()
  const label = opts.label || "live"
  mkdirSync(root, { recursive: true })

  const projectDir = opts.projectDir || mkdtempSync(join(root, `proj-${label}-`))
  const isolatedHome = opts.isolatedHome || mkdtempSync(join(root, `home-${label}-`))
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(isolatedHome, { recursive: true })
  const fixture = await startFixtureLlmServer({ responder: opts.responder })
  const model = { providerID: "test-fixture", modelID: "fixture-model" }

  const cfg = {
    $schema: "https://opencode.ai/config.json",
    plugin: [PLUGIN_PATH],
    model: `${model.providerID}/${model.modelID}`,
    provider: {
      [model.providerID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Test Fixture (local, deterministic)",
        options: { baseURL: fixture.baseURL, apiKey: "fixture-key" },
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
    ...(opts.configPatch || {}),
  }
  writeFileSync(join(projectDir, "opencode.json"), JSON.stringify(cfg, null, 2))

  if (typeof opts.seedProject === "function") opts.seedProject(projectDir)

  const { port, release } = await reserveFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const childEnv = { ...process.env, HOME: isolatedHome, SUPERVISOR_DEBUG: "1" }
  // The server's bash tool must be able to run REAL node:test commands. This
  // runner-private flag otherwise makes nested `node --test` skip all files
  // with exit 0 (a dangerously false-green validation result).
  delete childEnv.NODE_TEST_CONTEXT
  for (const key of AMBIENT_PROVIDER_ENV_VARS) delete childEnv[key]
  for (const key of AMBIENT_SERVER_ENV_VARS) delete childEnv[key]

  await release()
  const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: childEnv,
  })

  let stderrBuf = ""
  let stdoutBuf = ""
  proc.stdout.on("data", (chunk) => {
    const s = chunk.toString()
    if (opts.captureOutput) stdoutBuf += s
    else process.stdout.write("[opencode.stdout] " + s)
  })
  proc.stderr.on("data", (chunk) => {
    const s = chunk.toString()
    stderrBuf += s
    if (!opts.captureOutput) process.stderr.write("[opencode.stderr] " + s)
  })
  proc.stdout?.unref?.()
  proc.stderr?.unref?.()
  proc.unref()

  let exited = false
  proc.on("exit", () => { exited = true })

  const handle = {
    proc,
    baseUrl,
    port,
    projectDir,
    isolatedHome,
    fixture,
    model,
    get stderr() { return stderrBuf },
    get stdout() { return stdoutBuf },
    debugLogPath: join(projectDir, ".supervisor", "debug.log"),
    debugLog() {
      return existsSync(this.debugLogPath) ? readFileSync(this.debugLogPath, "utf-8") : ""
    },
    async stop({ keepDirs = false } = {}) {
      if (!exited) {
        // detached spawn => the child leads its own process group; kill the
        // whole group so opencode's own children (LSP/MCP/bun workers) die
        // with it instead of leaking and holding the port.
        try { process.kill(-proc.pid, "SIGKILL") } catch {
          try { proc.kill("SIGKILL") } catch { /* ignore */ }
        }
      }
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      try { await fixture.close() } catch { /* ignore */ }
      if (!keepDirs) {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(isolatedHome, { recursive: true, force: true })
      }
    },
  }

  try {
    await Promise.race([
      waitForHealth(`${baseUrl}/global/health`),
      new Promise((_, reject) => {
        proc.on("exit", (code) => {
          reject(new Error(`opencode serve exited early (code ${code}). stderr:\n${stderrBuf}`))
        })
      }),
    ])
  } catch (err) {
    await handle.stop({ keepDirs: true })
    throw err
  }

  return handle
}

/** POST /session — create a root session (or a child when parentID is given). */
export async function createSession(baseUrl, body) {
  const res = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`POST /session failed: ${res.status}`)
  return await res.json()
}

/** POST /session/{id}/message — send a turn and wait for the full response. */
export async function sendMessage(baseUrl, sessionId, text, timeoutMs = 120_000, opts = {}) {
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
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    throw new Error(`Message "${text.slice(0, 60)}" failed: ${err.message}`)
  }
}

/** GET /session/{id}/message — the full transcript. */
export async function getMessages(baseUrl, sessionId) {
  const res = await fetch(`${baseUrl}/session/${sessionId}/message`)
  if (!res.ok) return []
  const body = await res.json()
  return Array.isArray(body) ? body : []
}

/** Poll a predicate over the plugin's debug log until it holds (or timeout). */
export async function waitForDebug(handle, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  const test = typeof predicate === "function" ? predicate : (log) => log.includes(predicate)
  while (Date.now() < deadline) {
    if (test(handle.debugLog())) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** Poll a predicate over the fixture's recorded requests. */
export async function waitForFixture(handle, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(handle.fixture.getRequests())) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/**
 * Every debug line that ends one supervisor pass. Used to know when it is safe
 * to send the NEXT user turn.
 *
 * This is not cosmetic. `session.idle` → `runSupervisor` is deliberately
 * delayed (~600ms, to let a `session.error`/abort arrive first) and then reads
 * the transcript. If the next user turn lands inside that window, the pass
 * that was triggered by turn N reads a transcript whose last user message is
 * already turn N+1 — and judges turn N+1 with no assistant reply for it.
 * Observed directly while writing test/live-validation.mjs scenario 1 with
 * back-to-back turns.
 */
const SUPERVISOR_TERMINAL_LINES = [
  "Supervisor complete",
  "Supervisor standing down",
  "Supervisor pushed continuation",
  "Supervisor requires human action",
  // The status-checkpoint correction RETURNS out of the completion path, so it
  // ends the pass just as much as "Supervisor complete" does. Leaving it out
  // made settleSupervisor wait for the NEXT pass's terminal line instead —
  // which looked exactly like a ~60s runtime stall and inflated scenario 3
  // from ~30s to ~556s. Measure the predicate before blaming the system.
  "Supervisor injected status checkpoint correction",
  "Max attempts reached",
  "Skipping reflection —",
  "Supervisor disabled for session",
  "Supervisor disabled by explicit user command",
  "subagent-gate: skipping delegated subagent session",
  "Supervisor analysis failed",
  "Goal deadline reached",
  "Goal turn budget spent",
  "User sent new message during analysis",
  "Session aborted during analysis",
  "Session deleted during supervisor",
  "Session deleted before feedback injection",
  "Session not found (likely deleted)",
]

function terminalCount(log) {
  let n = 0
  for (const needle of SUPERVISOR_TERMINAL_LINES) {
    n += log.split(needle).length - 1
  }
  return n
}

/**
 * Wait until the supervisor finishes one more pass than it had finished when
 * this was called (or the budget expires). Returns true when a new pass
 * completed.
 */
export async function settleSupervisor(handle, timeoutMs = 60_000) {
  const start = terminalCount(handle.debugLog())
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (terminalCount(handle.debugLog()) > start) {
      // Let the trailing writes (toast, state mutate) land.
      await new Promise((r) => setTimeout(r, 400))
      return true
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}
