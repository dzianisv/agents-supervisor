---
name: retry
description: Set or check the supervisor retry budget (max continuation attempts) for this session. Use for "/supervisor:retry", "set supervisor retries", "how many times will the supervisor retry".
---

# /supervisor:retry — tune the runaway safety valve

Control the last-resort runaway safety valve: how many times the supervisor may
re-prompt the agent inside ONE human turn before it stands down to avoid an
unbounded loop. This is NOT a budget the agent is meant to spend — the intended
stop is the agent declaring `supervisor_loop_exit` (OpenCode) / outputting
`SUPERVISOR_LOOP_EXIT: completed` (Claude Code). The valve only bounds a runaway.

## Steps

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" retry "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports the current limit.
- `${ARGUMENTS}` = a number `N` (1–100) → sets this session's runaway limit to N.

Default is 50 (`RUNAWAY_CEILING`), the same in every mode; on Claude Code it is
clamped to 7. Relay the CLI output.
