/**
 * model-selection.test.mjs — Unit tests for model selection, blocking, routing,
 * and cross-review pairing logic in supervisor-impl.ts.
 *
 * Catches regressions like silently routing judge evaluation to weak or
 * unintended models (e.g. OpenAI gpt-3.5-turbo instead of github-copilot/gpt-4.1).
 *
 * Run: node --experimental-strip-types --test test/model-selection.test.mjs
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  isBlockedJudgeModel,
  parseModelSpec,
  getGitHubCopilotModelForRouting,
  getCrossReviewModelSpec,
} from "../opencode/supervisor-impl.ts"

// ---------------------------------------------------------------------------
// isBlockedJudgeModel
// ---------------------------------------------------------------------------
describe("isBlockedJudgeModel", () => {
  test("should block haiku models", () => {
    assert.ok(isBlockedJudgeModel("claude-haiku-3"))
  })

  test("should block mini models", () => {
    assert.ok(isBlockedJudgeModel("gpt-4o-mini"))
  })

  test("should block nano models", () => {
    assert.ok(isBlockedJudgeModel("gemini-nano"))
  })

  test("should block flash models", () => {
    assert.ok(isBlockedJudgeModel("gemini-flash"))
  })

  test("should block gpt-3.5-turbo", () => {
    assert.ok(isBlockedJudgeModel("gpt-3.5-turbo"))
  })

  test("should block llama-3.1-8b", () => {
    assert.ok(isBlockedJudgeModel("llama-3.1-8b"))
  })

  test("should block mixtral-8x7b", () => {
    assert.ok(isBlockedJudgeModel("mixtral-8x7b"))
  })

  test("should NOT block claude-sonnet-4", () => {
    assert.ok(!isBlockedJudgeModel("claude-sonnet-4"))
  })

  test("should NOT block claude-opus-4", () => {
    assert.ok(!isBlockedJudgeModel("claude-opus-4"))
  })

  test("should NOT block gpt-4o", () => {
    assert.ok(!isBlockedJudgeModel("gpt-4o"))
  })

  test("should NOT block gpt-4.1", () => {
    assert.ok(!isBlockedJudgeModel("gpt-4.1"))
  })

  test("should NOT block gpt-5.2-codex", () => {
    assert.ok(!isBlockedJudgeModel("gpt-5.2-codex"))
  })

  test("should NOT block gemini-pro", () => {
    assert.ok(!isBlockedJudgeModel("gemini-pro"))
  })

  test("case insensitive: Claude-HAIKU-3 should be blocked", () => {
    assert.ok(isBlockedJudgeModel("Claude-HAIKU-3"))
  })

  test("empty string should NOT be blocked", () => {
    assert.ok(!isBlockedJudgeModel(""))
  })
})

// ---------------------------------------------------------------------------
// parseModelSpec
// ---------------------------------------------------------------------------
describe("parseModelSpec", () => {
  test("valid: github-copilot/gpt-4.1", () => {
    const result = parseModelSpec("github-copilot/gpt-4.1")
    assert.deepEqual(result, { providerID: "github-copilot", modelID: "gpt-4.1" })
  })

  test("valid: anthropic/claude-sonnet-4", () => {
    const result = parseModelSpec("anthropic/claude-sonnet-4")
    assert.deepEqual(result, { providerID: "anthropic", modelID: "claude-sonnet-4" })
  })

  test("valid with nested slash: github-copilot/free/claude-opus-4.6", () => {
    const result = parseModelSpec("github-copilot/free/claude-opus-4.6")
    assert.deepEqual(result, { providerID: "github-copilot", modelID: "free/claude-opus-4.6" })
  })

  test("invalid: null returns null", () => {
    assert.equal(parseModelSpec(null), null)
  })

  test("invalid: undefined returns null", () => {
    assert.equal(parseModelSpec(undefined), null)
  })

  test("invalid: empty string returns null", () => {
    assert.equal(parseModelSpec(""), null)
  })

  test("invalid: no-slash returns null", () => {
    assert.equal(parseModelSpec("no-slash"), null)
  })

  test("invalid: bare slash returns null (empty parts)", () => {
    assert.equal(parseModelSpec("/"), null)
  })
})

// ---------------------------------------------------------------------------
// getGitHubCopilotModelForRouting
// ---------------------------------------------------------------------------
describe("getGitHubCopilotModelForRouting", () => {
  test("github-copilot/gpt-4o routes to github-copilot/gpt-4.1", () => {
    assert.equal(getGitHubCopilotModelForRouting("github-copilot/gpt-4o"), "github-copilot/gpt-4.1")
  })

  test("github-copilot/gpt-4.1 stays as github-copilot/gpt-4.1", () => {
    assert.equal(getGitHubCopilotModelForRouting("github-copilot/gpt-4.1"), "github-copilot/gpt-4.1")
  })

  test("github-copilot/gpt-4 routes to github-copilot/gpt-4.1", () => {
    assert.equal(getGitHubCopilotModelForRouting("github-copilot/gpt-4"), "github-copilot/gpt-4.1")
  })

  test("github-copilot/claude-sonnet-4 returns null (not a gpt-4 model)", () => {
    assert.equal(getGitHubCopilotModelForRouting("github-copilot/claude-sonnet-4"), null)
  })

  test("anthropic/gpt-4o returns null (not github-copilot provider)", () => {
    assert.equal(getGitHubCopilotModelForRouting("anthropic/gpt-4o"), null)
  })

  test("null returns null", () => {
    assert.equal(getGitHubCopilotModelForRouting(null), null)
  })

  test("empty string returns null", () => {
    assert.equal(getGitHubCopilotModelForRouting(""), null)
  })
})

// ---------------------------------------------------------------------------
// getCrossReviewModelSpec — hardcoded pairings removed (always returns null)
// ---------------------------------------------------------------------------
describe("getCrossReviewModelSpec", () => {
  test("claude-opus-4.6 returns null (hardcoded pairings removed)", () => {
    assert.equal(getCrossReviewModelSpec("github-copilot/claude-opus-4.6"), null)
  })

  test("gpt-5.2-codex returns null (hardcoded pairings removed)", () => {
    assert.equal(getCrossReviewModelSpec("github-copilot/gpt-5.2-codex"), null)
  })

  test("claude-sonnet-4 returns null", () => {
    assert.equal(getCrossReviewModelSpec("anthropic/claude-sonnet-4"), null)
  })

  test("gpt-4.1 returns null", () => {
    assert.equal(getCrossReviewModelSpec("github-copilot/gpt-4.1"), null)
  })

  test("null returns null", () => {
    assert.equal(getCrossReviewModelSpec(null), null)
  })

  test("empty string returns null", () => {
    assert.equal(getCrossReviewModelSpec(""), null)
  })
})

// ---------------------------------------------------------------------------
// Regression: judge model should not silently use OpenAI
// ---------------------------------------------------------------------------
describe("regression: judge model should not silently use OpenAI", () => {
  test("common OpenAI weak models are blocked by isBlockedJudgeModel", () => {
    // gpt-3.5-turbo was once used as a judge by accident — must be blocked
    assert.ok(isBlockedJudgeModel("gpt-3.5-turbo"), "gpt-3.5-turbo must be blocked as a judge model")
    // gpt-4o-mini is too weak for judge evaluation
    assert.ok(isBlockedJudgeModel("gpt-4o-mini"), "gpt-4o-mini must be blocked as a judge model")
  })

  test("parseModelSpec correctly splits provider from model (catches hardcoded openai/ prefix)", () => {
    // If someone hardcodes "openai/gpt-4" when they meant "github-copilot/gpt-4.1",
    // parseModelSpec should correctly show the provider as "openai" so routing rejects it
    const openaiSpec = parseModelSpec("openai/gpt-4")
    assert.equal(openaiSpec.providerID, "openai", "provider must be parsed as 'openai'")
    assert.equal(openaiSpec.modelID, "gpt-4", "model must be parsed as 'gpt-4'")

    // The correct github-copilot spec
    const ghSpec = parseModelSpec("github-copilot/gpt-4.1")
    assert.equal(ghSpec.providerID, "github-copilot", "provider must be 'github-copilot'")
    assert.equal(ghSpec.modelID, "gpt-4.1")
  })

  test("getGitHubCopilotModelForRouting normalizes gpt-4 variants to gpt-4.1", () => {
    // All gpt-4 variants under github-copilot should route to gpt-4.1
    const variants = ["github-copilot/gpt-4", "github-copilot/gpt-4o", "github-copilot/gpt-4.1"]
    for (const v of variants) {
      assert.equal(
        getGitHubCopilotModelForRouting(v),
        "github-copilot/gpt-4.1",
        `${v} must route to github-copilot/gpt-4.1`
      )
    }

    // Non-github-copilot providers must NOT be routed
    assert.equal(
      getGitHubCopilotModelForRouting("openai/gpt-4o"),
      null,
      "openai/gpt-4o must NOT be routed through github-copilot"
    )
  })
})
