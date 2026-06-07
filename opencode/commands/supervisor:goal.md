---
description: Set / check / clear a session goal the supervisor pushes the agent to meet before stopping.
agent: build
---
Manage the supervisor session goal by calling the `supervisor_goal` tool.

Interpret `$ARGUMENTS`:
- empty → call `supervisor_goal` with no args (report current goal status).
- `clear` / `stop` / `off` / `reset` / `none` / `cancel` → call `supervisor_goal` with `clear: true`.
- anything else → call `supervisor_goal` with `condition: "$ARGUMENTS"` (the goal the agent must demonstrably meet, e.g. "all tests in test/auth pass and lint is clean").

After the tool returns, relay its message. While a goal is active the supervisor
keeps re-prompting the agent until the goal is met or the retry budget runs out.
