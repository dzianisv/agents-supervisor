---
description: Show supervisor status, or turn the status-checkpoint directive on/off.
---
Report the supervisor status: enabled/disabled state, effective mode (reflection,
goal, or autopilot), any active goal, retry budget, and whether the status
checkpoint directive is on.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Interpret `$ARGUMENTS`:
- empty → call `supervisor` with no args (read-only status report). This bare
  form is an alias of `/supervisor`.
- `on` → call `supervisor` with `action: "status on"`. Re-enables the status
  checkpoint: every turn carries the `status.md`/roadmap instruction, and a task
  the judge calls complete without it gets one reminder.
- `off` → call `supervisor` with `action: "status off"`. Stops injecting the
  instruction and stops gating completion on it.

The directive is ON by default; `off` is the only thing that disables it.

Relay the tool response.
