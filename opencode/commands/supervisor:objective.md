---
description: Set / check / clear a session objective the supervisor pushes the agent to meet before stopping.
---
Manage the supervisor session objective. Setting an objective switches the session to
`goal` mode; clearing it returns the session to `reflection` mode.

Do not use the `task` tool or delegate to a subagent. Call `supervisor_goal`
directly in this session so the plugin-provided tool is available.

Interpret `$ARGUMENTS`:
- empty -> call `supervisor_goal` with no args (report current objective status).
- `clear` / `stop` / `off` / `reset` / `none` / `cancel` -> call `supervisor_goal` with `clear: true`.
- anything else -> call `supervisor_goal` with `condition: "$ARGUMENTS"` (the objective the agent must demonstrably meet, e.g. "all tests in test/auth pass and lint is clean").

After the tool returns, relay its message. While an objective is active the supervisor
keeps re-prompting the agent until it is met or the retry budget runs out.
