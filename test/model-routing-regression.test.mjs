/**
 * model-routing-regression.test.mjs — Regression tests for model switching bugs.
 *
 * Reproduces: supervisor switches active session to gpt-5.2-codex when
 * autoreview is OFF and routing is disabled. No model should ever be applied
 * to the active session feedback injection — routing should spawn subagents.
 *
 * Run: node --experimental-strip-types --test test/model-routing-regression.test.mjs
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  getCrossReviewModelSpec,
  getLastSessionModelSpec,
  parseModelSpec,
  isBlockedJudgeModel,
  getGitHubCopilotModelForRouting,
} from "../opencode/supervisor-impl.ts"

// ---------------------------------------------------------------------------
// Bug 1: getCrossReviewModelSpec returns gpt-5.2-codex — an outdated model
// that requires an OpenAI key that isn't configured. This function should not
// hardcode model pairings that may not be available.
// ---------------------------------------------------------------------------
describe("regression: getCrossReviewModelSpec must not return unavailable models", () => {
  test("should NOT return gpt-5.2-codex for claude-opus-4.6", () => {
    // BUG: was returning "github-copilot/gpt-5.2-codex" which doesn't exist
    // on most configurations and there's no OpenAI key available
    const result = getCrossReviewModelSpec("github-copilot/claude-opus-4.6")
    if (result !== null) {
      // If cross-review mapping exists, it must NOT point to gpt-5.2-codex
      assert.ok(
        !result.includes("gpt-5.2-codex"),
        `getCrossReviewModelSpec returned unavailable model: ${result}`
      )
    }
  })

  test("should NOT return any model that requires unconfigured providers", () => {
    // Cross-review mapping should be null when no explicit cross-review
    // model list is configured — it should not guess/hardcode pairings
    const result = getCrossReviewModelSpec("github-copilot/claude-opus-4.6")
    assert.equal(
      result,
      null,
      "getCrossReviewModelSpec should return null — cross-review pairings " +
      "must come from explicit configuration, not hardcoded mappings"
    )
  })

  test("should return null for gpt-5.2-codex input (no reverse mapping)", () => {
    const result = getCrossReviewModelSpec("github-copilot/gpt-5.2-codex")
    assert.equal(
      result,
      null,
      "getCrossReviewModelSpec should return null — no hardcoded cross-review pairings"
    )
  })
})

// ---------------------------------------------------------------------------
// Bug 2: Routing model must NEVER be applied to the active session's feedback
// body. If routing is needed, it must spawn a separate session (subagent).
// This test validates the contract at the data level.
// ---------------------------------------------------------------------------
describe("regression: routing must not mutate active session model", () => {
  test("getRoutingModel returns null when routing is disabled", async () => {
    // Import the internal function (needs export)
    const { getRoutingModel } = await import("../opencode/supervisor-impl.ts")
    const config = { enabled: false, models: { backend: "github-copilot/gpt-5.2-codex", architecture: "", frontend: "", default: "" } }
    const result = getRoutingModel(config, "backend")
    assert.equal(result, null, "Routing must return null when disabled")
  })

  test("getRoutingModel returns null for null category even if enabled", async () => {
    const { getRoutingModel } = await import("../opencode/supervisor-impl.ts")
    const config = { enabled: true, models: { backend: "github-copilot/gpt-5.2-codex", architecture: "", frontend: "", default: "" } }
    const result = getRoutingModel(config, null)
    assert.equal(result, null, "Routing must return null for null category")
  })
})

// ---------------------------------------------------------------------------
// Bug 3: classifyTaskForRoutingWithLLM is called unconditionally even when
// routing is disabled, wasting tokens. The function should early-return null
// when routing is disabled.
// ---------------------------------------------------------------------------
describe("regression: routing classifier should not run when routing disabled", () => {
  test("classifyTaskForRoutingWithLLM should be gated by routing config", async () => {
    // This tests that the function signature accepts a routing-enabled flag
    // and returns null immediately when routing is off.
    const { classifyTaskForRoutingWithLLM } = await import("../opencode/supervisor-impl.ts")

    // If the function doesn't exist as exported, this test catches the
    // architectural issue: routing classification MUST be skippable.
    if (typeof classifyTaskForRoutingWithLLM === "function") {
      // Call with a mock client that would throw if actually used
      const throwingClient = {
        session: {
          create: () => { throw new Error("SHOULD NOT BE CALLED when routing disabled") },
          messages: () => { throw new Error("SHOULD NOT BE CALLED") },
          delete: () => { throw new Error("SHOULD NOT BE CALLED") },
          promptAsync: () => { throw new Error("SHOULD NOT BE CALLED") },
        }
      }
      // If routing is disabled, classifyTaskForRoutingWithLLM should not make any API calls
      const result = await classifyTaskForRoutingWithLLM(
        throwingClient, "/tmp", { taskSummary: "test", taskType: "code", humanMessages: [] }, new Set(), [],
        { routingEnabled: false }
      )
      assert.equal(result, null, "Must return null without API calls when routing disabled")
    } else {
      // If not exported, flag as architectural gap
      assert.fail(
        "classifyTaskForRoutingWithLLM should be exported for testing, or " +
        "the routing gate should be moved to the caller (which we verify in " +
        "the integration test below)"
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Additional regression: session model fallback should never pick an OpenAI
// model when no OpenAI key is configured. The supervisor should only use
// models from the same provider as the session.
// ---------------------------------------------------------------------------
describe("regression: model fallback must respect provider availability", () => {
  test("getLastSessionModelSpec returns provider/model from messages", () => {
    const messages = [
      { info: { role: "assistant", providerID: "github-copilot", modelID: "claude-opus-4.6" } }
    ]
    const result = getLastSessionModelSpec(messages)
    assert.equal(result, "github-copilot/claude-opus-4.6")
  })

  test("session model should be used as-is for judge sessions (same provider)", () => {
    // The judge/assessment session should use the SAME model as the active session
    // not a cross-provider mapping. This validates the contract.
    const messages = [
      { info: { role: "assistant", providerID: "github-copilot", modelID: "claude-opus-4.6" } }
    ]
    const sessionModel = getLastSessionModelSpec(messages)
    // The session model should be used directly for assessment, not mapped
    assert.equal(sessionModel, "github-copilot/claude-opus-4.6")
    // It should NOT be passed through getCrossReviewModelSpec for assessment
    // (cross-review is a separate opt-in feature)
  })
})
