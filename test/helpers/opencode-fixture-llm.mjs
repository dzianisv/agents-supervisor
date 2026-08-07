/**
 * opencode-fixture-llm.mjs — a deterministic, local, OpenAI-compatible
 * chat-completions server used ONLY as "the model" behind a real, spawned
 * `opencode serve` process in test/e2e-opencode.test.mjs.
 *
 * Why this exists: the previous version of the E2E test discovered and
 * called a live, free, remote model from whatever providers happened to be
 * connected in the ambient environment (e.g. via GITHUB_TOKEN auto-detection
 * or the opencode Zen free tier). That is a real third-party network
 * dependency outside this test's isolation boundary — it is slow, it can
 * (and did) fail mid-stream ("Streaming response failed"), and it silently
 * depends on whatever credentials happen to be sitting in the environment.
 * None of that is under test here; the code under test is the supervisor
 * PLUGIN and the real opencode SERVER wiring (REST endpoints, tool
 * execution, command routing), not a third-party model's reliability.
 *
 * This fixture does NOT replace opencode, the plugin, or any tool
 * execution — every `/supervisor ...` command still round-trips through the
 * real opencode server, the real AI-SDK tool-calling contract, and the real,
 * unmodified tool implementations in opencode/supervisor-impl.ts. It only
 * stands in for "the model": it deterministically maps slash-command text to
 * the same `supervisor({...})` tool call a capable real model would make
 * (mirroring the routing table opencode/supervisor-impl.ts embeds in its own
 * `/supervisor` command template — see the `template:` string in the
 * `config` hook), and echoes the tool's own deterministic textual output
 * back as the final assistant turn — exactly like a real model summarizing a
 * tool result. It is configured into the isolated per-test opencode.json as
 * a custom `npm: "@ai-sdk/openai-compatible"` provider (the same mechanism
 * opencode's own docs use for local models — see
 * https://opencode.ai/docs/providers/#atomic-chat), NOT a mock of the
 * plugin or server themselves.
 */

import { createServer } from "node:http"

/**
 * Parse the routing rules embedded in the real `/supervisor` command
 * template (opencode/supervisor-impl.ts, the `config` plugin hook) so this
 * fixture reproduces exactly what a capable real model is instructed to do,
 * without hand-waving a different contract.
 * @param {string} rawText - the raw slash-command text, e.g. "/supervisor set-goal all tests pass"
 * @returns {{ tool: string, args: Record<string, unknown> }}
 */
export function parseSupervisorRouting(rawText) {
  const text = (rawText || "").trim()
  const withoutSlash = text.replace(/^\/?supervisor:?\s*/i, "").trim()
  const lower = withoutSlash.toLowerCase()

  if (lower === "" || lower === "status") return { tool: "supervisor", args: { action: "status" } }
  // Mirrors the "status on"/"status off" rows of the real routing table in
  // opencode/supervisor-impl.ts's `/supervisor` command template. Must be
  // tested BEFORE the bare "status" case above would otherwise swallow them —
  // it does not, since that case is an exact match, but keeping them adjacent
  // makes the precedence obvious.
  if (lower === "status on") return { tool: "supervisor", args: { action: "status on" } }
  if (lower === "status off") return { tool: "supervisor", args: { action: "status off" } }
  if (lower === "on") return { tool: "supervisor", args: { action: "on" } }
  if (lower === "off") return { tool: "supervisor", args: { action: "off" } }
  if (lower === "reflection") return { tool: "supervisor", args: { mode: "reflection" } }
  if (lower === "autopilot") return { tool: "supervisor", args: { mode: "autopilot" } }
  if (lower === "autoreview on") return { tool: "supervisor_autoreview", args: { enabled: true } }
  if (lower === "autoreview off") return { tool: "supervisor_autoreview", args: { enabled: false } }
  if (lower.startsWith("set-goal") || lower.startsWith("goal")) {
    const rest = withoutSlash.slice(lower.startsWith("set-goal") ? 8 : 4).trim()
    if (rest.toLowerCase() === "clear") return { tool: "supervisor", args: { action: "goal", clear: true } }
    if (rest === "") return { tool: "supervisor", args: { action: "goal" } }
    return { tool: "supervisor", args: { action: "goal", condition: rest } }
  }
  if (lower.startsWith("retry")) {
    const rest = withoutSlash.slice(5).trim()
    const n = parseInt(rest, 10)
    return { tool: "supervisor", args: { action: "retry", n: Number.isFinite(n) ? n : 1 } }
  }
  return { tool: "supervisor", args: { action: "status" } }
}

function lastTextContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      const part = content.find((p) => p && p.type === "text" && typeof p.text === "string")
      if (part) return part.text
    }
  }
  return ""
}

/** Concatenated `system`-role content of one request's messages. */
function collectSystemText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === "system")
    .map((m) =>
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
          : ""
    )
    .join("\n")
}

/**
 * Start the fixture server on an ephemeral local port.
 *
 * Every inbound chat-completions request is recorded (`getRequests()`) so a
 * test can inspect what ACTUALLY reached the model — most importantly the
 * resolved `system` messages. That is the only end-to-end observable for the
 * `experimental.chat.system.transform` hook on opencode 1.17.9: the runtime
 * does not persist `AssistantMessage.system` over the REST API (the SDK .d.ts
 * declares the field, the server does not populate it), so asserting on the
 * transcript would silently prove nothing.
 *
 * `opts.responder` is an OPTIONAL escape hatch used by the live-validation
 * harness (test/live-validation.mjs) to steer individual scenarios — e.g. to
 * force an incomplete judge verdict so a continuation is actually injected,
 * or an actionless one so the stand-down guard fires. It runs BEFORE all the
 * default branches below and only takes effect when it returns a non-null
 * value, so passing no options leaves this fixture byte-for-byte the same
 * deterministic thing test/e2e-opencode.test.mjs has always used.
 *
 * @param {object} [opts]
 * @param {(ctx: {body: object, messages: object[], fullText: string, systemText: string, lastText: string, hasTools: boolean, index: number}) => ({text: string}|{tool: string, args: object}|null|undefined)} [opts.responder]
 * @returns {Promise<{ port: number, baseURL: string, getRequests: () => object[], getSystemPrompts: () => string[], close: () => Promise<void> }>}
 */
export function startFixtureLlmServer(opts = {}) {
  let counter = 0
  /** @type {object[]} every parsed chat-completions body, in arrival order. */
  const requests = []

  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      counter++

      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }))
        return
      }

      let data
      try {
        data = JSON.parse(body || "{}")
      } catch {
        data = {}
      }
      requests.push(data)
      const messages = Array.isArray(data.messages) ? data.messages : []
      const last = messages[messages.length - 1]
      const hasTools = Array.isArray(data.tools) && data.tools.length > 0
      const fullText = messages
        .map((m) => (typeof m?.content === "string" ? m.content : ""))
        .join("\n")

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      const id = `chatcmpl-fixture-${counter}`
      const created = Math.floor(Date.now() / 1000)
      const sseChunk = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: "fixture-model",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`

      const finishWithText = (text, finishReason = "stop") => {
        res.write(sseChunk({ role: "assistant", content: "" }))
        res.write(sseChunk({ content: text }))
        res.write(sseChunk({}, finishReason))
        res.write("data: [DONE]\n\n")
        res.end()
      }

      const callTool = (name, args) => {
        res.write(sseChunk({ role: "assistant", content: null }))
        res.write(sseChunk({
          tool_calls: [{ index: 0, id: `call_fixture_${counter}`, type: "function", function: { name, arguments: "" } }],
        }))
        res.write(sseChunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }],
        }))
        res.write(sseChunk({}, "tool_calls"))
        res.write("data: [DONE]\n\n")
        res.end()
      }

      // 0. Optional per-scenario override (live-validation harness only).
      //    Returns null/undefined to fall through to the default branches.
      if (typeof opts.responder === "function") {
        let decision = null
        try {
          decision = opts.responder({
            body: data,
            messages,
            fullText,
            systemText: collectSystemText(messages),
            lastText: lastTextContent(messages),
            hasTools,
            index: counter,
          })
        } catch {
          decision = null
        }
        if (decision && typeof decision.tool === "string") {
          callTool(decision.tool, decision.args || {})
          return
        }
        if (decision && typeof decision.text === "string") {
          finishWithText(decision.text)
          return
        }
      }

      // 1. Finalize turn after a tool has executed — echo the tool's own
      //    deterministic textual output as the final assistant message, the
      //    same way a real model summarizes a tool result back to the user.
      //    This is what test/e2e-opencode.test.mjs assertions inspect.
      if (last && last.role === "tool") {
        const toolText = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")
        finishWithText(toolText || "Done.")
        return
      }

      // 2. Ephemeral judge / self-assessment / goal-derivation / routing
      //    calls fired by the supervisor plugin's own background loops
      //    (core/assessment.mjs, core/goal.mjs). These arrive as plain-text
      //    prompts, but — because tools are registered plugin-wide by the
      //    opencode `tool` hook rather than per-session — the ephemeral
      //    judge/derivation session still gets the FULL tool catalog
      //    attached to the request (`hasTools` is true here too). So these
      //    markers must be checked BEFORE any tool-availability branching,
      //    not gated behind `!hasTools`, or a real model (and this fixture)
      //    would be tempted to call an unrelated tool instead of directly
      //    answering the judge/derivation prompt with JSON — which is
      //    exactly what a real capable model does when a prompt asks a
      //    direct analytical question, tools or not.
      if (fullText.includes("DERIVE SUPERVISOR GOAL")) {
        finishWithText(JSON.stringify({
          goal: "All tests in test/ pass and npm test exits with status 0",
          falsifiable: true,
          rationale: "Checkable by running the test suite and inspecting its exit code.",
        }))
        return
      }
      if (fullText.includes("SELF-ASSESS SUPERVISOR")) {
        finishWithText(JSON.stringify({
          task_summary: "Fixture-driven E2E exercise",
          task_type: "other",
          status: "complete",
          confidence: 0.95,
          evidence: {
            tests: { ran: true, results: "pass", ran_after_changes: true, commands: [] },
            build: { ran: true, results: "pass" },
            pr: { created: false, url: "", ci_status: "unknown", checked: false },
          },
          remaining_work: [],
          next_steps: [],
          needs_user_action: [],
          stuck: false,
        }))
        return
      }
      if (fullText.includes("ANALYZE SUPERVISOR")) {
        finishWithText(JSON.stringify({
          complete: true,
          severity: "NONE",
          feedback: "Fixture: no gaps found.",
          missing: [],
          next_actions: [],
          requires_human_action: false,
        }))
        return
      }
      if (fullText.includes("CLASSIFY TASK ROUTING")) {
        finishWithText(JSON.stringify({ category: "backend" }))
        return
      }
      if (fullText.includes("REVIEW SUPERVISOR COMPLETION")) {
        finishWithText("Review looks good. No gaps found.")
        return
      }

      if (!hasTools) {
        // Title generation or any other plain, tool-free prompt.
        finishWithText("Fixture session")
        return
      }

      // 3. Agentic turn with tools available. A real `/supervisor ...`
      //    slash-command turn: route to the "supervisor" tool exactly as the
      //    real command template instructs a real model to.
      const lastText = lastTextContent(messages)
      if (/^\/?supervisor\b/i.test(lastText.trim())) {
        const { tool, args } = parseSupervisorRouting(lastText)
        callTool(tool, args)
        return
      }

      // Any other tool-enabled turn (e.g. an autopilot continuation nudge
      // injected into the active session by the supervisor's own
      // session.idle handler) — never fabricate an unrelated tool call.
      // Prefer a graceful, deterministic exit: call autopilot_exit if it's
      // offered (ends the autopilot loop immediately); otherwise just stop.
      const hasExitTool = (data.tools || []).some((t) => t?.function?.name === "autopilot_exit")
      if (hasExitTool) {
        callTool("autopilot_exit", {})
        return
      }
      finishWithText("Acknowledged.")
    })
  })

  return new Promise((resolve, reject) => {
    server.on("error", reject)
    // node:http closes an IDLE keep-alive socket after 5s by default. undici
    // (which opencode's provider uses) keeps that socket in its pool and will
    // happily send the next request onto it, racing the close — the request
    // fails with a socket error and the AI SDK retries with exponential
    // backoff. Observed as a ~60s stall in the middle of a supervisor pass
    // with no error surfaced anywhere. Disable the idle timeout: this server
    // lives for the duration of one test and is closed explicitly.
    server.keepAliveTimeout = 0
    server.headersTimeout = 0
    server.requestTimeout = 0
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        port,
        baseURL: `http://127.0.0.1:${port}/v1`,
        /** Every chat-completions body received, in arrival order. */
        getRequests: () => requests.slice(),
        /**
         * The concatenated `system`-role content of every request received.
         * One entry per request, so a test can assert per-turn.
         */
        getSystemPrompts: () =>
          requests.map((r) =>
            (Array.isArray(r?.messages) ? r.messages : [])
              .filter((m) => m?.role === "system")
              .map((m) => (typeof m?.content === "string"
                ? m.content
                : Array.isArray(m?.content)
                  ? m.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
                  : ""))
              .join("\n")
          ),
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
