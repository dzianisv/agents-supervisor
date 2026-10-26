# Architecture

One goal-based supervisor runs on OpenCode (`session.idle`) and Claude Code (`Stop`). No active session/project goal means no completion judge or task continuation.

## Runtime flow

```text
requested multi-step work → declare goal + criteria + verification
                         → agent works → idle/Stop → audit contract
                                                   ├─ unmet → continuation
                                                   ├─ evidenced → log + retire
                                                   └─ genuine blocker → stand down
```

OpenCode injects goal ownership guidance before work and exposes `supervisor_goal`. Claude Code uses the explicit goal CLI. Both runtimes send the contract to the working agent and completion judge. Completed signals do not bypass the audit; stuck signals retain a paused contract.

## Shared owners

- `core/goal.mjs`: declaration, provenance, replacement, resume, guarded pause/completion, contract prompts and project persistence.
- `core/session-store.mjs`: the only machine-state accessor, atomic writes, locks, migration, per-turn counters and GC.
- `core/reflection-prompt.mjs`: shared judge prompt assembly; its name is internal, not a mode.
- `core/task-context.mjs`: bounded user/assistant conversation chain. Raw tool calls/results are not judge input.
- `core/evaluation.mjs`, `assessment.mjs`, `feedback.mjs`: assessment parsing and continuation feedback.
- `core/patterns.mjs`: shipped → user → project patterns. Training writes local overlays.

## State and isolation

`.supervisor/sessions/<full session id>/{state.json,verdicts.jsonl}` stores the contract, attempts and flags. State files are created 0600. Legacy layouts remain readable; obsolete execution flags are stripped without losing goals. Locked mutations protect against lost updates; declaration identity rejects stale audits.

Project configuration stays under `.agents/supervisor/`. Explicit project goals retain criteria and verification in `Goal.md`; agent-inferred goals never write project files. Project data is resolved from the session's own directory, never inherited from the plugin's shipped defaults or another project. Clear and pause suppress stale fallback.

OpenCode excludes child sessions, its own judge sessions, plan turns, disabled sessions, control commands and recent aborts. Continuations never set the active session's model. The shared retry valve and no-progress gate bound runaway loops without pretending completion.

## Verification

Native node:test suites cover core behavior. `test/e2e-cc.mjs` runs the actual hook process. `test/e2e-opencode.test.mjs` starts a real isolated OpenCode server and drives REST/tool flows. Run these sequentially; the server E2E must pass before plugin commits/pushes. CI also enforces the private-data boundary.
