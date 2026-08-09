---
description: Show supervisor status, or turn the plainspeak style rewrite nudge on/off.
---
Report the supervisor status: enabled/disabled state, effective mode (reflection,
goal, or autopilot), any active goal, retry budget, and whether the plainspeak
style nudge is on.

Do not use the `task` tool or delegate to a subagent. Call the `supervisor` tool
directly in this session so the plugin-provided tool is available.

Interpret `$ARGUMENTS`:
- empty → call `supervisor` with no args (read-only status report). This bare
  form is an alias of `/supervisor`.
- `on` → call `supervisor` with `action: "plain on"`. Re-enables plainspeak:
  when a turn ends with nothing left to do and the reply reads verbose, the
  supervisor asks for exactly one rewrite.
- `off` → call `supervisor` with `action: "plain off"`. Stops injecting rewrite
  directives entirely.

Plainspeak is ON by default; `off` is the only thing that disables it. It is
deterministic (no extra model call), it fires at most once per turn, and it
never fires on a turn where the supervisor itself injected feedback, an
autopilot nudge, or a status checkpoint correction.

Relay the tool response.
