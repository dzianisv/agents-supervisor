# agents-supervisor — current architecture and invariants

## Delivery gate (mandatory)

**Never commit or push plugin changes without passing
`node --experimental-strip-types --test test/e2e-opencode.test.mjs`.** Plugin
behavior requires a real isolated `opencode serve` and REST command/tool
registration checks; mocks alone are insufficient. Missing binary, skipped tests,
or zero executed cases is not a pass. Do not restart ambient user sessions.

Run sequentially, never concurrently:

```sh
npm test
node test/e2e-cc.mjs
export PATH="$HOME/.opencode/bin:$PATH"
node --experimental-strip-types --test test/e2e-opencode.test.mjs
```

CI pins OpenCode 1.18.32. Never run the broad `node --test test/*.test.mjs` glob:
it includes server E2E and runs it alongside unit files. `npm run test:e2e` is the
separate real-server gate; `npm run test:all` runs npm test then that gate.
All suites use native `node:test`, not Jest/Vitest. Syntax-check **both**
`opencode/supervisor.ts` and `opencode/supervisor-impl.ts` with
`node --experimental-strip-types --check`. CC E2E invokes the real Stop-hook
script with a fake judge by default; `SUPERVISOR_CC_LIVE=1` enables real calls.

## One goal supervisor

- `opencode/supervisor.ts` loads `opencode/supervisor-impl.ts`.
- `bin/supervisor-on-stop.mjs` is the CC stdin → stdout adapter.
- `core/goal.mjs`, `core/reflection-prompt.mjs`, assessment/evaluation/feedback,
  task context, transcript, no-progress and loop-exit modules are shared logic.
- `bin/supervisor.mjs` dispatches the explicit CC goal CLI; `bin/status.mjs`
  reports actual contracts, enable flags and effective runaway limit.

No public execution modes or unconditional continuation path. No active session
or project goal means no completion judge and no completion feedback. Keep
internal reflection/judge names where useful; do not rebuild a second scheduler,
store, or goal service. Retired commands parse as `mode-removed`; the CLI must
explain removal and exit nonzero without changing state.

A goal carries `condition`, `acceptanceCriteria`, `verification`, `source`
(`user|agent`) and lifecycle fields. OpenCode's shared ownership directive tells
the agent to declare a session-only `supervisor_goal` before multi-step work;
plain questions need no contract. No-condition LLM derivation also creates an
agent contract. CC has no registry and uses explicit CLI goals. Automatic agent
contracts never persist to project files and cannot replace user-owned goals.
Replacing an agent's own goal requires `replace` and real user redirection.
Legacy goals without source become user-owned; load strips obsolete execution
keys while preserving goals, counters and flags.

Session goal > `.agents/supervisor/Goal.md` > legacy `goal.md`. Paused/inactive
session goals and `goalCleared` suppress project fallback. Explicit user goals
can persist their contract to project configuration. Achievement retires only
a file still matching the entire judged contract, with durable evidence logged
before unlinking; agent completion never deletes a project goal. Never delete a
concurrent replacement. Stuck pauses the contract and
logs `.supervisor/loop-exit.log`; resume keeps the contract, resets the turn
counter, clears the stale reason and extends an expired 30-day deadline.

`supervisor_loop_exit(completed)` (OpenCode) and
`SUPERVISOR_LOOP_EXIT: completed` alone on its line (CC) **cannot bypass an active
goal's evidence audit**. No-goal completion is cheap. Judge failure must never
mark achievement. Stuck may still pause and return control.

## Prompt and runtime safety

- **No model switching:** continuation `client.session.promptAsync` must never
  contain `.model`. Judge sessions can use configured routing or the current
  session's model fallback; do not change the active agent's model.
- Judge evidence is alternating user/assistant **prose**, not raw tool calls,
  command logs, results, or derived tool signals. Preserve `buildConversationChain`
  ordering, budgets and explicit truncation markers. Evidence is reported paths,
  URLs, commands **and results**, not “done.” Do not claim independent/perfect
  verification or add deterministic test-command gates under this refactor.
- Keep shipped prose rubrics aligned with the embedded fallback. Do not demand
  observations the judge cannot see or invent PR/deploy requirements outside
  user scope. Project SystemPrompt/Patterns/User overrides remain supported;
  a custom template cannot omit the effective contract.
- Use one calm feedback template; `buildEscalatingFeedback` has no attempt-count
  parameters. Never render injection budget counters into agent-facing feedback.
- Preserve root/child (`session.parentID`, NOT message parentID), judge-session,
  plan, abort, disabled and control-turn gates. Controls are never work, even
  with a goal. Actions on/off remain independent of contract and roadmap flags.
- Coalesce idle events received during an active audit and replay after it exits;
  do not lose a new human turn. Skip replay while the actual session is busy,
  retrying or recently aborted. An old audit cannot mutate a replacement goal.
- CC stdout: exactly `{decision:"block",reason}` when continuing; otherwise
  empty. Diagnostics go to logs, not stdout. Validate cwd before logging.
- Skip supervisor and foreign Stop-hook feedback as human input (`isMeta`,
  `Stop hook feedback:` and shared non-human helpers); they must not become
  task context, goal seeds, or new human turns.

## Counters and no-progress

One counter per human turn, persisted through the shared store. `goal.attempts`
is a mirror, not a second independently incremented budget. New genuine human
messages reset it; generated feedback does not. Every committed injection writes
count+1 before prompting (failed sends still cost an attempt).

Runaway valve: session retry > supervisor.yaml `maxAttempts` >
`SUPERVISOR_MAX_ATTEMPTS` / legacy env > default 50 **injections**, not inner model
steps. Positive integers are stored verbatim; invalid inputs reject loudly;
`unlimited`/`off`/`none`/`0` disables the count cap on OpenCode. CC reduces to
`resolveClaudeCodeHardCap()` (normally 7) and reports any reduction, including
unlimited, honestly. Ceiling logs include limit, tier, and platform reduction.
Spending a turn's budget leaves the goal active; only deadline exhaustion is
terminal. Eligibility skips never saturate or increment the counter.

The deterministic repeated-reply gate tolerates one repeat and stands down on
the next; it does not consume budget. Explicit stuck reaches its handler;
completed still reaches the audit. Empty/actionless verdicts and rendered
feedback without a body do not inject. Status/exit hints and a standing goal
alone must not manufacture a feedback body. Human-only blockers stand down.

## Store, identity and concurrency

`core/session-store.mjs` is the single accessor; goalStore and OpenCode's
supervisorStore are facades, not duplicate storage implementations.

```
.supervisor/sessions/<full-id>/state.json       # 0600
.supervisor/sessions/<full-id>/verdicts.jsonl   # append-only
.supervisor/disabled                           # session IDs
.supervisor/current_session                    # hint only
.agents/supervisor/*                           # project configuration
```

CLI identity: explicit `--session` (unique prefix expanded) >
`SUPERVISOR_SESSION_ID` > `CLAUDE_SESSION_ID` > announced local fallback.
Ambiguity acts on nothing. Full IDs avoid prefix collisions. Never trust the
shared current_session file as the caller when two sessions share a repo.

Atomic temp+rename alone prevents corruption, not lost updates. Hot-path writes
use locked `mutate`, never save an earlier whole-state snapshot over a newly
written counter/flag. O_EXCL locks have a 10s stale breaker and best-effort
fallback. Legacy layouts migrate on load and are left for retention cleanup.
GC is best effort, daily at most, excludes the live session, retains 30 days and
caps at 200 session directories. Project config is not sharded per session.

## Status and independent plainspeak

`statusDiagram` is default **off**; only explicit true enables it. Roadmap
injection is idempotent, respects disabled/control/child gates and remains
separate from on/off. At most one status correction per human turn. Retire an
achieved goal before a status-correction early return.

Plainspeak is independent: default-on OpenCode flag, deterministic-only there;
CC has a second hook with an optional LLM tiebreak. It defers to active
session/project goals and a just-injected supervisor verdict. It never spends
completion attempts and claims its one-rewrite-per-human-turn slot before
prompting. Respect trailing questions, kill switches and fail-open behavior.
No-goal must not disable an otherwise eligible style check.

## Validation focus and privacy

Pin contract propagation into the actual judge prompt, no-goal no-judge behavior,
completed-signal audit, unmet criteria continuation, evidence-based retirement,
user-goal protection, session-only agent contracts, paused/cleared fallback,
controls/disable/children, retry counter reset, forensic ceilings, status and
plainspeak composition. E2E must inspect state and captured model requests, not
just a reply claiming a goal. Match model calls by per-turn probe content rather
than slicing a shared asynchronous call list. Strip runner-private
`NODE_TEST_CONTEXT` from spawned servers and independent checks: otherwise
nested `node --test` can skip every file with exit 0. Assert real test totals.

Keep unrelated model-routing, training, media, no-progress, prompt and session
store regressions. Training is local, never auto-commits. Real transcripts,
`.dataset/`, credentials and trace artifacts stay out of git. CI's privacy guard
is mandatory; synthetic `evals/*.example.jsonl` fixtures are the limited exception.
