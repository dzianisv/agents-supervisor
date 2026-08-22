---
name: autopilot
description: Enable, disable, or inspect supervisor autopilot mode. Use for "/supervisor:autopilot", "turn on autopilot", "keep going without asking", "auto-continue".
---

# /supervisor:autopilot — enable continuous execution

Enable or disable supervisor autopilot mode, where the supervisor auto-continues after each stop WITHOUT running the judge, until the agent outputs `SUPERVISOR_LOOP_EXIT: completed` alone on its own line or the runaway safety valve trips (a last-resort breaker, not a budget you spend).

## Steps

Run the CLI, passing the user's argument through verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" autopilot "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty, `on`, or `start` → enable autopilot mode.
- `${ARGUMENTS}` = `off`, `stop`, or `exit` → disable autopilot (back to reflection mode).
- `${ARGUMENTS}` = `status` → report autopilot status.

Relay the CLI output to the user.

## A goal in autopilot is context, not a verified condition

Autopilot never runs the judge, so it cannot check a goal. If a goal is set when
you enable autopilot, its condition is appended to the auto-continue nudge as
context for the agent — but it is **not** verified before the agent may stop.
Switching to autopilot **keeps** any active goal (a goal is a session attribute,
not a mode); it is not cleared. If you want the goal actually checked, use
`reflection` mode instead.
