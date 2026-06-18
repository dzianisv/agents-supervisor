# agents-supervisor — Agent Instructions

opencode supervisor plugin — reflection, goal-tracking, autopilot for opencode sessions

## Constraints

- **INVARIANT: NEVER commit or push plugin changes without passing `node --experimental-strip-types --test test/e2e-opencode.test.mjs`.** Run and confirm PASS before any commit that touches `opencode/` files.
- All tests use `node:test` (Node native test runner). No Vitest, no Jest.
- Before declaring any plugin change "done": start `opencode serve` with isolated config, verify supervisor commands register via REST API.
- No mock-only testing of plugin behavior — real `opencode serve` process required.

## Commands

```bash
# Unit/integration tests
node --experimental-strip-types --test test/*.test.mjs

# opencode server E2E test (MUST pass before commit)
node --experimental-strip-types --test test/e2e-opencode.test.mjs

# Claude Code E2E test
node test/e2e-cc.mjs

# Eval suite
node evals/judge-eval.mjs
```

## Structure

- Plugin: `opencode/supervisor.ts` → `opencode/supervisor-impl.ts`
- Core logic: `core/*.mjs` (shared between opencode plugin and other consumers)
- Tests: `test/*.test.mjs`
- Module system: ESM (`"type": "module"`)

## Test Coverage

### `test/model-fallback.test.mjs` — Judge session model fallback

Tests `getLastSessionModelSpec()` — the helper that extracts `providerID/modelID` from the active session's messages so judge sessions reuse the session model when no model is configured in `opencode.json` or `supervisor.yaml`.

**Why it exists:** Without this fix, `assessmentAttempts` fell back to `[""]`, letting opencode pick its default provider. On machines with OpenAI credentials, judge sessions silently routed to `gpt-*` even when the user's active session ran `claude-*`.

**What it covers:**
- Returns `providerID/modelID` from the last assistant message with model info
- Returns the most recent message (not first) when multiple have model info
- Returns `null` for empty arrays, messages missing `providerID`/`modelID`, or blank values
- Handles messages without `info` field (no crash)

**NOT covered (E2E gap):** A real `opencode run` → idle → supervisor fires → judge session model verified. That requires a live `opencode serve` and a real task execution. Run manually to verify:
```bash
# 1. Confirm no model in global config
opencode --version  # should show no default model
# 2. Run a task and let it go idle
opencode run "print hello" --model anthropic/claude-opus-4.6
# 3. Check supervisor debug logs for judge session model
```
