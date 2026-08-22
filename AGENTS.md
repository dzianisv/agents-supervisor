# agents-supervisor — Agent Instructions

opencode supervisor plugin — reflection, goal-tracking, autopilot for opencode sessions

## Constraints

- **INVARIANT: NEVER commit or push plugin changes without passing `node --experimental-strip-types --test test/e2e-opencode.test.mjs`.** Run and confirm PASS before any commit that touches `opencode/` files.
- All tests use `node:test` (Node native test runner). No Vitest, no Jest.
- Before declaring any plugin change "done": start `opencode serve` with isolated config, verify supervisor commands register via REST API.
- No mock-only testing of plugin behavior — real `opencode serve` process required.

## Commands

```bash
# Unit/integration tests (E2E is deliberately EXCLUDED — see below)
npm test

# opencode server E2E test (MUST pass before commit)
npm run test:e2e

# Both, sequentially — never concurrently
npm run test:all

# Live validation against a real `opencode serve` (evidence, not assertions)
node --experimental-strip-types test/live-validation.mjs

# Claude Code E2E test
node test/e2e-cc.mjs

# Eval suite
node evals/judge-eval.mjs
```

**Never run `node --test test/*.test.mjs`.** That glob matches
`e2e-opencode.test.mjs`, and `node --test` runs files CONCURRENTLY
(`availableParallelism`, 8 here) — so the documented "unit test" command used to
start a real `opencode serve` alongside 30+ unit files on the same cores, and
running the documented E2E command straight afterwards started a second one.
`npm test` now globs `test/!(e2e-*).test.mjs`; the E2E has its own script.

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

### `test/goal-lifecycle.test.mjs` → `describe("resume: ...")` — a paused goal is not a dead end

A goal that gets `paused` (the agent declaring `supervisor_loop_exit` with reason
`stuck`) or `exhausted` (the 30-day deadline backstop) used to be permanently
inert: nothing anywhere flipped it back to `active`, and the user's only recovery
was re-typing the whole condition from scratch — with no indication that was
necessary. `resumeGoal()` (`core/goal.mjs`) is the explicit fix, wired through
`bin/supervisor.mjs set-goal resume` (CLI) and the `supervisor_goal` /
`supervisor` tools' `resume: true` arg (`opencode/supervisor-impl.ts`).

**The command is `set-goal resume`, never `goal resume`.** `test/manifest.test.mjs`
bans the literal `/supervisor goal` and `/supervisor:goal` substrings across every
user-facing surface (see its "no user-facing surface tells anyone to type the
retired goal command" test) — `set-goal` is the one canonical name, `goal` survives
only as an internal parser alias. `resume`/`unpause` are recognised the same way
`clear`/`stop`/`off`/`reset`/`none`/`cancel` already were, via a sibling
`GOAL_RESUME_ALIASES` set next to `GOAL_CLEAR_ALIASES`.

**Resumable statuses are `paused` and `exhausted`, and nothing else.** `active` is
already running (an honest `already-active` outcome, not a fabricated success);
`achieved`/`cleared` are terminal and immediately deleted by
`clearGoal`/`retireProjectGoal`, so a persisted goal object in either state
essentially never exists, but the check stays honest either way rather than
assuming. Every non-resume outcome returns `{resumed:false, reason, status,
condition}` so the caller can print the goal's ACTUAL current status instead of a
silent no-op — the same discipline `/supervisor off` failing to persist taught
this codebase (see the session-store section below).

**Resume forces `mode:'goal'` back on.** `resolveSupervisorMode()` trusts an
explicit `state.mode` over `goal.status`, and the OpenCode deadline-exhaustion
path sets `mode:'reflection'` (`decideGoalTransition`'s `'deadline'` branch) — so
without this, a resumed deadline-exhausted goal would stay invisible to the
`mode==='goal'` filter both runtimes use before even looking at `state.goal`.

**Resume extends a deadline that has already passed** (to `now +
DEFAULT_MAX_GOAL_DURATION_MS`) but leaves a still-future deadline (the ordinary
stuck-pause case) untouched. Without the extension, the very next stop-hook pass
re-triggers `decideGoalTransition`'s `now >= goal.deadline` branch and
re-exhausts the goal instantly — turning "resume" into a trap that looks like it
worked and dies on the next turn.

**Resume resets the attempt counter fully, not just `goal.attempts`.** It
`delete`s the shared `state.attempts` object (not just zeroes `goal.attempts`),
so `sessionStore.readAttempts()` reads 0 for whatever turn key comes next —
consistent with issue #57's fix that `goal.attempts` is a MIRROR of the one
turn-scoped counter, never a second independently-incremented tally. `lastReason`
is cleared and `lastTurnKey` is reset to `null` (the same initial value
`setGoal()` uses), so the very next stop treats it as a brand-new turn.

**Discoverability: every pause site names the recovery command.** `lastReason` —
the ONE field the Claude Code Stop hook can carry forward, since it has no
passive user-visible output channel at the exact instant a goal pauses (a
`{decision:'block'}` reply would force another continuation, defeating the
pause) — gets `core/goal.mjs`'s `withResumeHint()` appended at both stuck-pause
sites (`bin/supervisor-on-stop.mjs`, `opencode/supervisor-impl.ts`'s
`executeSupervisorLoopExit`) and both deadline sites. OpenCode's deadline toasts
and the `supervisor_loop_exit` tool's own return string get the same hint
inline. `/supervisor status`, `bin/supervisor.mjs`'s `goal-status` case, and the
OpenCode `supervisor`/`supervisor_goal` status text all append
`goalResumeHintSuffix()` whenever the goal is `paused`/`exhausted` — `bin/status.mjs`
previously printed NO goal detail at all (only `resolveSupervisorMode()`'s
"effective mode", which reads `'goal'` identically whether the goal is actively
pushing or dead-in-the-water paused), so that alone was a second, independent
instance of "shown as if active" this phase fixed.

**One inaccuracy in how this feature was originally described:** the third
"pause" site named at the start of this work — an active goal standing down
because the judge says the human must act next (`goal_paused_user_wait` in
`bin/supervisor-on-stop.mjs`) — never actually persists any status change.
`goal.status` stays `'active'` on disk; only a transient `verdictRecord.goal =
'paused'` (a per-turn log line, not state) is written. There is no dead end to
resume there — the existing "just send another message" flow already reactivates
it, so `resumeGoal()` correctly reports `already-active` for it and changes
nothing.

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

### `test/rubric-prose-evidence.test.mjs` — the judge reads prose, not a tool log

PR #61 made the conversation chain the judge's only input, which left rubric rules asserting things the judge can no longer observe ("the tool commands show ONLY read operations", "write/edit tool calls in tool commands", "no write/tool evidence"). Dead rubric text is worse than none — the judge can only hallucinate compliance against a field it never receives.

The regression guard is a banned-phrase grep over the SHIPPED rubric, plus an equality assertion that its two copies have not drifted: `.agents/supervisor/Patterns.md` (read by `core/reflection-prompt.mjs`, both runtimes' reflection path) and `STATIC_RUBRIC` in `core/assessment.mjs` (→ `DEFAULT_RUBRIC`, read by opencode's `loadRubric()` fallback and the `buildSelfAssessmentPrompt`/`buildJudgePrompt` default). Eight rules were rewritten to test the agent's PROSE instead: the report must name a checkable specific (file path, PR/issue number, command AND what it returned, a count), and vagueness — not a missing tool call — is what makes a claim unverified. Two rules were added: SPECIFICITY TEST and DO NOT INVENT EVIDENCE (never assume a step happened because it is standard practice; never assume it did NOT because an earlier turn omitted it).

`{{signals}}` was also removed from the judge prompt: `detectSignals` derives `test-command`/`gh-pr-*`/`git-push` from the tool command log, so rendering it contradicted `SystemPrompt.md`'s own "You do not see the agent's tool calls or their results".

**NOT in scope:** `core/patterns.json`. That feeds a DIFFERENT judge (`core/judge-core.mjs`, the Stop classifier) with a DIFFERENT input contract — it still receives `tools_available_inferred` (the tool NAMES used), so its tool-referencing rules are not dead.

### `test/session-store.test.mjs` — per-session state layout, session identity, GC

`core/session-store.mjs` is THE single accessor for per-session machine state. `goalStore` (core/goal.mjs) and `supervisorStore` (opencode/supervisor-impl.ts) are now a behavioural facade and an async-signature adapter over it — not two implementations of one on-disk contract, which is the shape that produced every prior drift bug in this repo.

Layout: `.supervisor/sessions/<full session id>/{state.json,verdicts.jsonl}`. Project CONFIG (`.agents/supervisor/*`) is untouched and is NOT sharded per session. Precedence is unchanged — session > project > shipped.

**The bug.** `.supervisor/current_session` is ONE shared file every Stop hook in the project overwrites, so with two sessions in one repo `/supervisor off` disabled whichever stopped LAST, not the caller's. `bin/supervisor.mjs` now resolves the id as `--session <id>` (unique prefix expanded) → `$SUPERVISOR_SESSION_ID` (exported by the Stop hook from its own stdin `session_id`) → `$CLAUDE_SESSION_ID` → `current_session`, and the fallback is ANNOUNCED with the full id plus a warning naming any other recently-active session. An ambiguous id lists candidates and acts on nothing (exit 1).

**Truncation.** The old `verdict_<sid8>.json` / `<sid8>_<ts>.json` keyed on the session id cut to 8 chars — two sessions sharing a prefix shared one verdict file. The new layout uses the full id; the test asserts two same-prefix ids do not collide.

**Migration.** A legacy-only session (`goals/<sid>.json` + `<sid>_attempts.json` + `verdict_<sid>.json` + `disabled`) is read AND migrated forward on first load. The legacy files are deliberately LEFT IN PLACE — deleting them makes a downgrade silently drop an active goal — and GC reclaims them. Tests assert no goal, retry override, flag or disabled entry is lost.

**Attempts moved into `state.json`, which created a new lost-update path:** the hook read `goalState` before `writeAttemptCounter` ran, then `goalStore.save(…{...goalState, goal})` clobbered the counter written in between. Every whole-state `save()` on a hot path in BOTH runtimes is now `sessionStore.mutate()` / `supervisorStore.mutate()` (locked read-modify-write). `test/goal-per-turn.test.mjs` is the regression guard — it drove `goal.attempts` to 1 instead of 7 on the naive version.

**Concurrency.** Atomic write is temp+rename in the same dir, created 0600 so there is no world-readable window. Atomic write alone is NOT sufficient — it prevents a corrupt file, not a lost update — so `mutate()` serialises read-modify-write behind an O_EXCL lockfile with a 10s stale breaker, and degrades to last-writer-wins rather than blocking a turn.

**GC.** `gcSessions()` drops dirs untouched >30 days, then caps at 200 (oldest first); `maybeGcSessions()` runs it from the Stop hook at most once/day per project, best-effort, never blocking, never touching the live session.

### `test/live-validation.mjs` — evidence, not assertions

Nine scenarios, each against its own real `opencode serve` (isolated `$HOME` +
scratch project under the OS temp dir, `SUPERVISOR_DEBUG=1`), driven over REST.
It asserts on what the plugin itself produced: its debug log, the files it
wrote, and the exact bytes it sent to the model. Writes forensic artefacts
(captured prompts, transcripts, per-request model-call log) next to a
`report.md`. Latest full-run write-up: `.scratch/live-validation.md` (9/9,
98 checks). Not a pre-commit gate — a ~9 minute evidence run.

Two things it found that unit tests could not:

- **`isActionlessVerdict` was unreachable on the opencode runtime.**
  `analyzeSelfAssessmentWithLLM` substitutes
  `verdict.feedback || "Judge analysis completed"` into `analysis.reason`, and
  the guard was fed `analysis.reason` — so the blank-feedback arm could never be
  true, and an empty verdict stood down with the wrong reason. The judge's
  feedback is now carried through verbatim as `SupervisorAnalysis.rawFeedback`
  and that is what the guard reads.
- **`autopilot_exit` silently deleted an active goal.** It is registered
  plugin-wide, so it is in every session's tool catalog; it called
  `setAutopilot(false)` unconditionally, which routes through
  `setMode("reflection")` → `delete state.goal`. It is now a no-op outside
  autopilot mode.

Both are pinned in `test/goal-lifecycle.test.mjs`.

`test/helpers/live-server.mjs` owns spawn/teardown/health for BOTH this harness
and the E2E, so they cannot drift on isolation. `waitForHealth` gives every
attempt its own `AbortSignal` — without one, a single stalled `fetch` blocks
past the deadline the loop is supposed to enforce (measured: a 302s hang that
cancelled all 14 E2E tests). `reserveFreePort` holds the port until the moment
before spawn instead of racing between probe and bind.

### `test/e2e-opencode.test.mjs` — attribute model calls by CONTENT

The status-directive tests used to slice a server-wide list of model calls
(`getSystemPrompts().slice(before)`) and treat every entry as belonging to the
session under test. It does not: the supervisor's background status-checkpoint
correction for an EARLIER session is injected into that other session and
legitimately carries the directive, so whenever it finished inside the ~500ms
assertion window the test failed on an unrelated session. Measured 1 failure in
16 runs; reproduced deterministically by widening the window to 20s (2
offenders, both the previous session's correction turn). Calls are now matched
by a per-turn probe string. 20/20 after the fix.

### `test/e2e-cc.mjs` — Claude Code Stop hook

Real hook entry point: Stop payload on stdin, real transcript jsonl, stdout decision contract. `SUPERVISOR_FAKE_JUDGE` makes it deterministic; `SUPERVISOR_CC_LIVE=1` uses the real judge. The goal-achieved case asserts the session goal is CLEARED (not left as `status:'achieved'`) and that `.supervisor/goal-achieved.log` carries the record — clearing must never be silent.

### `test/loop-exit.test.mjs` + `test/loop-exit-parser.test.mjs` — THE stop mechanism

**The agent ends the loop, not the counter.** A fixed per-turn budget (3 for
reflection, 16 for goal/autopilot) stood the supervisor down mid-task: the cap
was reached while the work was still half-finished, and the human saw an
abandoned turn with no explanation. A number chosen in advance cannot know
whether a task is done.

The stop is now an explicit declaration by the agent, with a reason:

| runtime | signal | why it differs |
|---|---|---|
| opencode | `supervisor_loop_exit` tool, `{reason, detail}` | plugin registers tools |
| Claude Code | `SUPERVISOR_LOOP_EXIT: completed` / `: stuck — why`, alone on its own line | Stop hook has NO tool registry — text sentinel is the only channel |

`reason` is `completed` (task genuinely finished) or `stuck` (the supervisor is
looping, demanding the impossible, or asking for something already done).
`stuck` is deliberately available to the agent: the model is the only party
that can see the loop from inside it.

**One parser, both runtimes** — `parseLoopExitSentinel` (`core/loop-exit.mjs`).
Line-anchored and fence-stripped, so the sentinel quoted inside the nudge that
teaches it does not trigger it. `AUTOPILOT_EXIT` remains an alias for
`completed`. Two regexes for one sentinel is the drift shape this repo keeps
reproducing; there is exactly one.

**The hint must be runtime-correct or it is dead text.** `buildEscalatingFeedback`
is shared, so telling a Claude Code agent to "call the supervisor_loop_exit
tool" names a tool absent from its catalog — the loop then has no reachable
stop at all. `opts.loopExitStyle` (`'tool'` default | `'sentinel'`) picks the
wording; CC passes `'sentinel'`. Both variants are filtered out of
`hasFeedbackBody`'s body check, or appending a line to every message silently
kills the empty-injection guard — the exact status-directive footgun documented
above. Arity is unchanged (AGENTS.md pins it; `test/feedback.test.mjs` asserts).

**Side effects are asymmetric on purpose.** `completed` leaves an active goal
untouched. `stuck` pauses it (status `paused`, condition retained) and appends
to `.supervisor/loop-exit.log` so a doom loop leaves forensic evidence. Neither
ever `delete state.goal` — that footgun is documented at the `autopilot_exit`
call site and was hit for real in live validation.

**The gate is a plain `return`,** not a counter saturation: it is a cheap
idempotent read of persisted state, so saturating would make it
indistinguishable from a spent budget and fire the cap branch's side effects
(`setAutopilot(false)`, goal transitions) on a later idle. See "Eligibility
gates must NOT saturate the counter" below. A `loopExit` record is keyed to its
turn, so a stale one from a previous turn never suppresses a new human turn.

### `test/e2e-opencode.test.mjs` → `describe("per-turn attempt budget")` — the runaway circuit breaker

The opencode runtime could inject **at most once per human turn**. Claude Code
could not — the two had silently diverged, and there was no opencode-path test
covering a second injection on one turn (`test/e2e-cc.mjs`'s "goal raises retry
budget past the default 3" spawns `bin/supervisor-on-stop.mjs`, CC only, and
that passing test is what gave the false confidence).

**The mechanism.** `getLastRelevantUserMessageId` skips supervisor-injected
messages, so the turn key stays pinned to the last HUMAN message — that is what
makes a per-turn counter possible, and it stays. What changed is the STOP
condition. `if (lastUserMsgId === lastReflectedId) return` (a boolean set at 22
sites, deleted at none, including immediately after a *successful* injection)
is gone. The remaining counter check is `attempts >= effectiveMaxAttempts`,
checked **pre-increment** exactly as `bin/supervisor-on-stop.mjs:875` does —
the old opencode check was post-increment, so the real budget was N−1 and
`/supervisor retry 1` yielded ZERO injections. It is no longer the INTENDED
stop (see `supervisor_loop_exit` above); it is the runaway circuit breaker that
bounds the loop when the agent never declares an exit.

**Termination** is proved, not asserted: `settleInjections` always burns a full
15s quiet window after the last change, i.e. it is a bounded wait for an
injection N+1 that must never arrive. The counter is monotonic within a turn,
every injection path writes count+1 *before* prompting (a failed `promptAsync`
still costs an attempt — fail toward termination), and the turn ends after at
most `effectiveMaxAttempts` injections. That bound still holds with the breaker
set to `RUNAWAY_CEILING`; `supervisor_loop_exit` terminates far earlier in
practice. The suite is also proven SENSITIVE: re-adding the one deleted
stand-down line after a successful injection turns "3 injections" into 1.

**Two tiers, one counter.** `attempts` is persisted via `sessionStore`
(`.supervisor/sessions/<id>/state.json`, locked `mutate()` — the lost-update
path `test/goal-per-turn.test.mjs` guards) with an in-memory monotonic floor.
That is not a second stop mechanism: reads take `max(memory, disk)`. Disk gives
cross-restart and cross-process safety (32 accidental double-injections in the
forensic sample came from the old in-memory-only map); memory keeps the loop
bounded if the best-effort disk write fails.

**Eligibility gates must NOT saturate the counter.** Only paths that already
committed to supervising this turn stand down by writing the budget. The
subagent gate, `.supervisor/disabled`, and the non-actionable/control-command
turn gate plain-return — they re-derive the same answer for free on every idle.
Saturating there made them indistinguishable from a spent budget, and opencode
raises several `session.idle` events per turn, so a later pass took the
budget-exhausted branch and fired its SIDE EFFECTS. Measured: `/supervisor
autopilot` skipped itself as a control command, saturated the counter, and the
next idle 34ms later called `setAutopilot(false)` — the command disarmed itself
before the user typed a task.

**`/supervisor …` is never work, in any mode.**
`shouldSkipReflection` checks `isSupervisorControlTurn` BEFORE the
goal/autopilot escape hatches — the only rule that does. Autopilot bypasses the
turn gate by design, so with a real budget it burned the whole thing on its own
command turn.

**Budgets are now ONE rule** (`resolveTurnMaxAttempts`, core/goal.mjs), applied
by both runtimes: `/supervisor retry N` > config > env
(`SUPERVISOR_MAX_ATTEMPTS` / `REFLECTION_CC_MAX_ATTEMPTS`) > `RUNAWAY_CEILING`
(50) for every mode, then clamped to the runtime's platform ceiling (Claude
Code has one, opencode does not). The old per-mode defaults (16 goal/autopilot,
3 reflection) are gone — a low default IS the premature-stand-down bug. An
explicit override at any of the first three tiers is a deliberate operator
choice and still wins.

### `test/goal-per-turn.test.mjs` — also pins the turn KEY itself

`getMessageSignature` only checked a top-level `msg.id`. opencode's REST
transcript shape is `{ info: { id, role, time }, parts }` — there is no
top-level `id` (verified live: `msg.id === undefined`,
`msg.info.id === "msg_fda79148d001bdPZnwwZoyiPGx"`), so **every** key fell
through to a `${role}:${time}:${first 20 chars}` composite, with `time.start`
unset on user messages. "can you please check the alpha module" and "…the beta
module" both keyed as `user:0:can you please check`, so the second turn
inherited the first's spent budget and was never supervised — a silent
supervision hole. Now `info.id` is used.

### `buildEscalatingFeedback` takes no attempt count

It used to accept `attemptCount` and `maxAttempts` and read NEITHER
(`attemptCount` was never referenced; the `maxAttempts`-derived `effectiveCap`
was computed and discarded). Both are removed rather than wired up: "one calm
template, always" is a standing decision here, escalating tone is pressure to
declare victory, and a silently-ignored parameter is an invitation to display a
number the code cannot honour. `test/feedback.test.mjs` pins the arity. The
attempt number is still rendered into the JUDGE's prompt
(`core/reflection-prompt.mjs`, `core/assessment.mjs`), where it is genuinely
read. The autopilot nudge still shows `(n/N)` — that counter is persisted now,
so it counts up truthfully instead of always reading `1/N`.

