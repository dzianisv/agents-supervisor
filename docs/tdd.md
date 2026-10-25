# Technical design — goal-only supervisor (0.4.0)

## Components

| Component | Responsibility |
|---|---|
| `opencode/supervisor.ts` → `supervisor-impl.ts` | OpenCode hooks, tools, command routing, idle supervision |
| `bin/supervisor-on-stop.mjs` | CC Stop adapter: JSON stdin → block JSON or empty stdout |
| `bin/supervisor.mjs`, `bin/status.mjs` | Explicit CC goal/control CLI and truthful status |
| `core/goal.mjs` | Goal contracts, provenance/protection, lifecycle, project persistence/retirement, retry resolution |
| `core/session-store.mjs` | Single per-session accessor and migration/concurrency owner |
| `core/reflection-prompt.mjs` | Shared judge prompt assembly (internal name, not selectable mode) |
| task-context / transcript / assessment / evaluation / feedback | Prose context, judge verdict parsing, evaluation and actionable continuation |
| loop-exit / no-progress modules | Shared exit parsing/logging and deterministic repeat stand-down |
| `bin/plainspeak-on-stop.mjs`, core verbosity helpers | Independent CC style hook; OpenCode reuses deterministic detector |

No second scheduler or goal service. Removed APIs include execution-mode
resolution/mutation and unconditional continuation helpers. Removed commands
parse as `{kind:'mode-removed'}` and the CLI fails nonzero without state changes.

## Contract and ownership

New declarations have unique `id`s. `state.goal` also contains `condition`,
`acceptanceCriteria`, `verification`, `source` (`user|agent`), status, attempts
mirror, timestamps/deadline and reason/turn key. Legacy IDs may be absent.
`goalStore.setGoal` retains its signature with new contract/source/replace opts.
Default source is user; missing legacy provenance is user. Agent replacement
checks happen atomically inside mutation: never replace a user goal, and require
explicit replace for another agent goal. Agent inference/declaration never
writes a project goal file. Explicit user goals retain project contract
persistence, including acceptance criteria and verification sections.

OpenCode injects one shared goal-ownership directive into its system prompt:
declare `supervisor_goal` before multi-step work, derive observable criteria and
verification without enlarging user scope, skip plain questions, preserve user
contracts. Existing no-condition derivation also produces a complete agent
contract. CC uses explicit CLI goals, not that tool-ownership directive.

## Runtime flow

1. Preserve identity/directory validation and existing disabled, root/child,
   judge, plan, abort and control gates appropriate to each runtime.
2. Load the session. An active session goal wins. Any inactive/paused session
   goal or `goalCleared` tombstone blocks project fallback. Otherwise read the
   project condition (`Goal.md` before legacy `goal.md`).
3. Without an active session/project goal, allow completion immediately before
   any completion judge/feedback; independently eligible plainspeak may still run.
4. Resolve the single per-human-turn injection counter and effective runaway
   valve. Eligibility skips do not consume or saturate it. CC mirrors this value
   into goal.attempts rather than independently incrementing it.
5. Apply no-progress and existing human-wait gates. An explicit stuck exit records forensic
   evidence, pauses/retains the session contract and returns control. Inherited
   project goals are materialized when pausing so fallback cannot revive them.
   A completed signal does not bypass the active goal audit.
6. Build the shared judge prompt with
   `buildGoalRequirementSection(goal.condition, goal)`, including **all** criteria
   and verification. The context is alternating user/assistant prose, with
   bounded, attributed truncation; never raw tool results or tool-derived signals.
7. Parse/evaluate the judge. Failure is fail-open and never achievement. Verified
   completion retires the contract and only matching project files, logging before
   unlinking. Unmet criteria with actionable feedback and no human-only block
   spend count+1 before injecting. Empty/actionless feedback never loops.

CC stdout remains exactly `{decision:"block",reason}` for continuation, otherwise
empty. Diagnostics and forensic evidence go to local logs, not stdout. It teaches
the line-anchored `SUPERVISOR_LOOP_EXIT:` sentinel; OpenCode teaches the
`supervisor_loop_exit` tool. Both completed variants require the goal audit.

The evidence check remains LLM judgment of reported prose, not independent tool
verification. This release adds no deterministic test-command gate. Do not
invent PR/merge/deploy deliverables absent from user scope or claim perfect proof.
OpenCode continuation `session.promptAsync` bodies must **never contain `.model`**.

## State and concurrency

```
.agents/supervisor/Goal.md                     # explicit shared user contract
.agents/supervisor/{SystemPrompt,Patterns,User}.md
.supervisor/sessions/<full-id>/state.json       # 0600 machine state
.supervisor/sessions/<full-id>/verdicts.jsonl   # append-only
.supervisor/disabled                           # disabled session IDs
.supervisor/current_session                    # last-writer hint only
.supervisor/{health.json,debug.log,goal-achieved.log,loop-exit.log}
```

GoalStore and OpenCode supervisorStore are facades over sessionStore. Load
normalizes legacy layouts, strips obsolete mode/autopilot keys and preserves
goals, counters and flags. `clearGoal` suppresses project fallback in that
session; set resets the tombstone. Resume preserves contract fields and resets
the shared attempt record, extending expired deadlines (30-day backstop).

Writes are same-directory temp+rename with 0600 from creation. Read-modify-write
uses locked mutate (O_EXCL, 10s stale breaker, best-effort fallback). Never save an
old whole-state snapshot over an intervening counter/flag update. Pause and
completion compare declaration identity and the full contract; project retirement
compares condition, criteria and verification, not condition alone. Concurrent
replacements survive. Idle events arriving during an older audit are coalesced
and replayed against fresh state, unless the session is now busy/retrying/aborted. Legacy files remain for retention cleanup. GC is best effort, daily at
most, excludes the live session, retains 30 days and caps at 200 directories.

CC CLI identity: explicit session/prefix > SUPERVISOR_SESSION_ID >
CLAUDE_SESSION_ID > announced local fallback. Ambiguity acts on nothing. Forward
that resolved identity to the status child. Project configuration is not sharded
per session.

## Termination and independent features

- One retry rule: session > supervisor.yaml `maxAttempts` > env > 50 injections.
  Invalid explicit values reject; positive integers persist verbatim;
  unlimited/off/none/0 removes the OpenCode count cap. CC clamps to normally 7
  and exposes requested/effective values and tier in status/debug/ceiling logs.
- Budget exhaustion stands down only for this human turn, leaving the goal
  active. Deadline exhaustion is terminal/resumable. Controls and foreign hook
  feedback must not reset counters or seed task context/goals.
- Repeated unchanged replies stand down after the shared tolerance. Stuck still
  reaches its handler; completed still reaches the evidence audit.
- Status roadmap is default off and idempotent; its on/off toggle is independent
  of supervision enablement. One correction per human turn; retire achieved
  goals before that early return. Hints alone cannot manufacture a feedback body.
- Plainspeak is separately gated and one rewrite per human turn, claimed before
  prompting. It defers to active session/project goals and just-injected
  supervisor feedback, never spends completion attempts, and fails open. OpenCode
  uses deterministic scoring only; CC retains the optional model tiebreak.

## Validation and distribution

Run sequentially: `npm test`, `node test/e2e-cc.mjs`, then
`node --experimental-strip-types --test test/e2e-opencode.test.mjs`.
**Mandatory invariant: never commit/push plugin changes without this passing real
isolated server gate.** Missing binary/skips do not pass. CI installs pinned
OpenCode 1.18.32, runs npm test (not the broad all-test glob), CC E2E, and separate
`test:e2e`. Syntax-check both the plugin wrapper and real implementation.

Real-server cases must inspect registered tools/commands and persisted contract
state: automatic declaration, no project write for agent goals, user protection,
unmet criteria continuation, completed-signal audit, evidence retirement, no-goal
no-judge, and preserved control/disable/child/status/plainspeak safety. Capture a
real-model trace when possible, outside git. Keep privacy CI guards and existing
unrelated regression coverage. See AGENTS.md for commands and constraints.

Plugin and marketplace versions become 0.4.0. Retired source skills/commands are
removed. There is no repository-wide installer guaranteeing manual command-copy
cleanup; README documents explicit deletion in the user's actual installation
directory rather than claiming a version bump cleans those copies.
