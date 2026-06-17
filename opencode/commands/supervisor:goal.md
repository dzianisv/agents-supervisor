---
description: Set / check / clear a session goal the supervisor pushes the agent to meet before stopping.
---
Manage the supervisor session goal. Setting a goal switches the session to
`goal` mode; clearing it returns the session to `reflection` mode.

Do not use the `task` tool or delegate to a subagent. Call `supervisor_goal`
directly in this session so the plugin-provided tool is available.

Interpret `$ARGUMENTS`:
- empty -> call `supervisor_goal` with no args (report current goal status).
- `clear` / `stop` / `off` / `reset` / `none` / `cancel` -> call `supervisor_goal` with `clear: true`.
- anything else -> call `supervisor_goal` with `condition: "$ARGUMENTS"` (the goal the agent must demonstrably meet, e.g. "all tests in test/auth pass and lint is clean").

After the tool returns, relay its message. While a goal is active the supervisor
keeps re-prompting the agent until the goal is met or the retry budget runs out.
