---
description: Set / check / clear a session goal the supervisor pushes the agent to meet before stopping.
---
Manage the supervisor session goal. A goal is a session **attribute**, not a
mode: setting one puts the session in `reflection` mode (where the judge verifies
the goal on each stop). Clearing it leaves the session in `reflection`. Note: in
`autopilot` mode a goal is not verified — its condition is only added to the
auto-continue nudge as context.

Do not use the `task` tool or delegate to a subagent. Call `supervisor_goal`
directly in this session so the plugin-provided tool is available.

Interpret `$ARGUMENTS`:
- empty -> call `supervisor_goal` with no args (report current goal status).
- `clear` / `stop` / `off` / `reset` / `none` / `cancel` -> call `supervisor_goal` with `clear: true`.
- `resume` / `unpause` -> call `supervisor_goal` with `resume: true` (revives a `paused` or `exhausted` goal — keeps the same condition, clears the stale pause reason, and resets this turn's attempt budget; a no-op with an honest message if the goal is not paused/exhausted).
- anything else -> call `supervisor_goal` with `condition: "$ARGUMENTS"` (the goal the agent must demonstrably meet, e.g. "all tests in test/auth pass and lint is clean").

After the tool returns, relay its message. While a goal is active the supervisor
keeps re-prompting the agent until the goal is met or the retry budget runs out.

After relaying the tool response, if the user asked to set a goal, mention:
- This is a **session-scoped** goal (lost when the session ends).
- For a **project-level** persistent goal that applies in reflection mode across
  all sessions, edit `.agents/supervisor/Goal.md` in the project root.
