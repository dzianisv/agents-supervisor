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

### `test/supervisor-gates.test.mjs` — the two "should the supervisor run at all" gates

Covers the two highest-volume misfires found in a 30-day forensic sample of real sessions.

**Subagent gate.** The supervisor must not run inside delegated subagent sessions (633 of 962 injections, 66%). The gate reads `parentID` off the session object — **verified**, not guessed:
- SDK: `Session.parentID?: string` (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`)
- Live REST: `GET /session/{id}` returns `parentID` on a child and omits the key entirely on a root
- SQLite storage form is `session.parent_id`; the API/SDK form is `parentID`
- **Trap:** `message.info.parentID` is a *message* id (`msg_…`). Never derive subagent-ness from the transcript.

Override with `superviseSubagents: true` in `~/.config/opencode/supervisor.yaml` (default false). The gate fails **open** when `client.session.get` is missing or throws — a fail-closed gate would silently kill the whole feature on an SDK mismatch.

**`/supervisor off`.** `action: off/on` is handled BEFORE any `mode` branch, because `mode` used to early-return and swallow it (3 of 5 real off-attempts never persisted; one was converted to `mode: autopilot`). The executor also treats runtime filler (`""`, `"null"`, `"undefined"`, actual `null`) as absent — the tool schema reaching the model marks every param required even though zod says `.optional()`, so the model is forced to invent a `mode`. After writing, the disabled state is read back and an explicit `FAILED …` string is returned if it did not persist.

E2E coverage lives in `test/e2e-opencode.test.mjs` under `describe("subagent gate")`: it creates a real child session via `POST /session {parentID}` against a live server, asserts the `parentID` field contract, and asserts the plugin's own debug log shows the child skipped and a root session supervised. That E2E requires the spawned server to run with `SUPERVISOR_DEBUG=1`.

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
