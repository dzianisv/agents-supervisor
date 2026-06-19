---
description: Switch the supervisor to reflection mode (default — judge evaluates each idle).
---
Switch the supervisor to reflection mode, the default mode where the supervisor
evaluates each idle step for safety/quality. Reflection mode clears any active goal
or autopilot session.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Call the `supervisor` tool with `mode: "reflection"`.

Relay the tool response. Prefer `/supervisor reflection`; this colon command is an alias.
