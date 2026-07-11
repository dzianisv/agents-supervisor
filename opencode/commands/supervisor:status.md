---
description: Show supervisor status (enabled state, effective mode, goal, retry budget).
---
Report the supervisor status: enabled/disabled state, effective mode (reflection,
goal, or autopilot), any active goal, and retry budget remaining.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Call the `supervisor` tool with no args.

Relay the tool response. This colon command is an alias of `/supervisor`.
