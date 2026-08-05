---
description: Show supervisor status or switch supervisor modes for this session.
---
Inspect and control the supervisor for this project. The primary modes are
`reflection` (default), `goal`, and `autopilot`.

Do not use the `task` tool or delegate to a subagent. Call the supervisor tools
directly in this session so the plugin-provided tools are available.

If the user just typed `/supervisor`, call the `supervisor` tool with no args to
report status: enabled/disabled state, effective mode, goal, and retry budget.

Interpret `$ARGUMENTS`:
- empty / `status` -> call `supervisor` with no args.
- `off` / `on` -> call `supervisor` with that action to disable/enable the
  supervisor for THIS session only. These are not modes.
- `autopilot` -> call `supervisor` with `mode: "autopilot"`.
- `reflection` -> call `supervisor` with `mode: "reflection"`.
- `set-goal <condition>` (legacy alias: `goal <condition>`) -> call `supervisor_goal` with the remaining text.
- exactly `set-goal` / `goal` -> call `supervisor_goal` with no args.
- `set-goal clear` / `goal clear` -> call `supervisor_goal` with `clear: true`.
- `retry N` -> call `supervisor_retry` with `n: N`.
- otherwise -> call `set_supervisor` with `$ARGUMENTS` as guidance.
