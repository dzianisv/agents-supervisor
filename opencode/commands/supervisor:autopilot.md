---
description: Enable, disable, or inspect supervisor autopilot mode.
---
Manage autopilot mode by calling `supervisor_autopilot` or `supervisor`.

Do not use the `task` tool or delegate to a subagent. Call the supervisor tools
directly in this session so the plugin-provided tools are available.

Interpret `$ARGUMENTS`:
- empty / `on` / `true` / `start` -> call `supervisor_autopilot` with `enabled: true`.
- `off` / `false` / `stop` / `exit` -> call `supervisor_autopilot` with `enabled: false`.
- `status` -> call `supervisor` with no args.

Relay the tool response. Prefer `/supervisor autopilot` in new docs; this colon
command remains an alias.
