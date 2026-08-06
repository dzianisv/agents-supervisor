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

### `test/task-context.test.mjs` — judge input

`extractLastAssistantText` is the SINGLE extractor (`core/task-context.mjs`); two copies previously disagreed on which text part of the last assistant message wins. It is now factored through `assistantMessageText`, which `buildConversationChain` also uses — still one extractor.

The judge's context is `buildConversationChain`: the plain alternating `user:` / `assistant:` conversation, oldest→newest, and nothing else. Tool calls, tool inputs, tool results, the `[1]..[n]` demand blob, and the old `currentTask`/`priorContext`/`turnEvidence` split are all gone (owner decision — the judge can no longer independently verify a claim against a tool result). Budget: `CHAIN_MAX_CHARS = 10000`, newest pair always in full up to `PROMPT_TEXT_LIMIT`, older pairs trimmed before dropped, any cut carries an explicit supervisor-attributed marker. `currentTask` survives as the non-actionable-turn-gate input and `taskSummary`, not as judge input. Also covers `truncateForPrompt` — tail-preserving by default (the verdict lives at the END of a long reply), explicit truncation marker, `PROMPT_TEXT_LIMIT = 12000` as the one limit.

### `test/turn-classifier.test.mjs` — non-actionable turn gate

`shouldSkipReflection` must skip "tldr" / "thanks" / "Stop. Reflect." and must NOT skip real work. False skips are the dangerous direction, so the actionable corpus is the larger half. Escape hatches (active goal, autopilot/goal mode, length ceiling, a named file/issue/identifier) are asserted individually.

### `test/goal-lifecycle.test.mjs` — achieved goals must die; empty verdicts must not loop

`retireProjectGoal` only deletes a file that still parses to the exact condition it judged, and writes `.supervisor/goal-achieved.log` BEFORE unlinking. `isActionlessVerdict` (empty missing + empty next_actions + blank feedback) and `hasFeedbackBody` stand the supervisor down instead of injecting — a content-free verdict was observed re-injecting byte-identically 15x at ~20s intervals. A standing goal alone never counts as actionable content. Source assertions pin both guards into `opencode/supervisor-impl.ts`.

### `test/status-directive.test.mjs` — status/roadmap directive

`STATUS_DIAGRAM_DIRECTIVE` leads with `STATUS_DIRECTIVE_MARKER` and `appendStatusDirectiveToSystem` is idempotent — `experimental.chat.system.transform` fires more than once per user turn on opencode 1.17.9, so a naive push duplicates the directive. `checkStatusCompliance` is deterministic and LLM-free (it runs on the complete path) and fails OPEN: unknown turn start lets any existing `status.md` count. `isStatusDiagramEnabled` is default-ON — absent/undefined mean on, only an explicit `false` disables.

E2E coverage in `test/e2e-opencode.test.mjs` under `describe("status directive system-prompt injection")` asserts at the fixture LLM, i.e. on the wire: opencode 1.17.9 never populates `AssistantMessage.system` in the REST transcript, so a transcript assertion would pass vacuously. Also pins the FLAT dotted hook key — opencode resolves hooks by literal `hooks[name]` lookup, and a nested `{experimental:{chat:{system:{transform}}}}` object is silently ignored.

### `test/status-goal-composition.test.mjs` — the semantic conflicts between the four fix branches

Every case here passes on each branch alone and fails on the naive union. No textual merge conflict marks any of them.

- **The directive must not smuggle a body into an empty message.** `buildEscalatingFeedback` appends the directive to EVERY message, so `hasFeedbackBody` run over the raw render can never return false — the last-resort empty-injection guard silently became dead code. `stripStatusDirective` removes it before the body check.
- **`/supervisor:status off` must silence BOTH continuation paths.** The status branch gated only the Claude Code autopilot nudge; the opencode nudge hard-coded the directive and both reflection paths ignored the toggle. `buildEscalatingFeedback` now takes `{ statusDirective }` (default true) and both runtimes pass `isStatusDiagramEnabled(state)`.
- **The system-prompt gate must work on a cold cache.** `shouldInjectStatusDirective` resolved the session's project from an in-memory `sessionDirCache`, which is empty after every server restart — a restarted server read the SERVER cwd's `.supervisor/disabled` for every pre-existing session. The mapping is now persisted as `SupervisorState.projectDir` and read from the `supervisorStore.load` the gate already performs (no extra I/O, no HTTP round-trip into a mid-request server).
- **Goal retirement must run BEFORE the status correction's early return.** The correction `return`s out of the completion path; a goal retired after it would survive into every future turn and every future session.
- **`action: off/on` must still be evaluated before `mode`,** and `status on|off` must toggle the directive only — never the enable axis.

### `test/e2e-cc.mjs` — Claude Code Stop hook

Real hook entry point: Stop payload on stdin, real transcript jsonl, stdout decision contract. `SUPERVISOR_FAKE_JUDGE` makes it deterministic; `SUPERVISOR_CC_LIVE=1` uses the real judge. The goal-achieved case asserts the session goal is CLEARED (not left as `status:'achieved'`) and that `.supervisor/goal-achieved.log` carries the record — clearing must never be silent.
