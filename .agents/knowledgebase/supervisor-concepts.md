# Supervisor Concepts

## One goal supervisor

There are no selectable execution modes. Without an active session or project goal, no completion judge or task continuation runs. Status and plainspeak remain independent features.

A goal contains an outcome (`condition`), observable `acceptanceCriteria`, a `verification` plan, provenance (`source: user | agent`), and lifecycle metadata. New declarations have unique IDs so an old audit cannot clear, pause or overwrite a replacement.

- OpenCode receives an idempotent system directive to declare a goal before requested multi-step work, using `supervisor_goal`. Plain questions and cancelled work need no goal.
- With no goal, calling that tool without a condition can derive a falsifiable contract from the task context. Invalid derivations set nothing and report failure.
- Agent goals stay session-only. Agent replacement requires an explicit redirect and cannot overwrite a user goal.
- Explicit user goals can persist to `.agents/supervisor/Goal.md`, including their criteria and verification. Legacy lower-case files remain readable; inferred goals never create them.
- Clearing a session goal sets a tombstone, preventing a stale project file from reactivating it.

## Completion and stopping

An active goal is checked against conversation evidence on idle/Stop. The judge reads prose, not raw tool results: reports must name specific commands and results, paths or artifact IDs. A verification plan is not evidence that its checks ran.

`supervisor_loop_exit` on OpenCode and `SUPERVISOR_LOOP_EXIT: completed` on Claude Code request completion; they cannot bypass an active goal's audit. A `stuck` declaration pauses the exact goal and retains its contract for explicit resume. Genuine human dependencies stand supervision down without claiming achievement.

`goalStore.completeGoal` and `goalStore.pauseGoal` use locked, identity-checked mutations. Achievement is logged before state is cleared. Agent completion cannot delete a project goal, even when its text happens to match.

## Safety valve

The per-human-turn counter limits supervisor injections, not tool calls. `describeRunawayLimit` resolves retry override > config > environment > default 50. Positive integers are honored; `unlimited`/0 removes the cap on OpenCode. Claude Code reduces it to its platform cap, currently 7, and reports that reduction. Exhausting a turn does not mean the goal is achieved. A deadline can exhaust a goal; resume retains the contract and renews an expired deadline.

## Patterns and configuration

Pattern precedence: shipped `core/patterns.json` → user `~/.config/agents-supervisor/patterns.json` → project `.supervisor/patterns.json`. Training writes local overrides, not shipped defaults.

Both runtimes use `core/reflection-prompt.mjs` to load project/shipped `SystemPrompt.md`, `Patterns.md` and `User.md`, plus project-only `Goal.md`. The internal module name is not a mode. Project rubric overrides replace the default rubric.

## Privacy

Machine state lives in `.supervisor/sessions/<full session id>/`. Mined data and transcripts remain gitignored. CI rejects private datasets, transcripts and non-example JSONL files.
