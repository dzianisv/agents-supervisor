---
name: retry
description: Set or check the supervisor retry budget (max continuation attempts) for this session. Use for "/supervisor:retry", "set supervisor retries", "how many times will the supervisor retry".
---

# /supervisor:retry — tune the runaway safety valve

Control the last-resort runaway safety valve: how many times the supervisor may
re-prompt the agent inside ONE human turn before it stands down to avoid an
unbounded loop. This is NOT a budget the agent is meant to spend — the intended
stop is evidence-based achievement of the active goal. A completed
`supervisor_loop_exit` (OpenCode) / `SUPERVISOR_LOOP_EXIT: completed` (Claude Code)
requests that audit; it cannot bypass it. The valve only bounds a runaway.

## Steps

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" retry "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports the current limit.
- `${ARGUMENTS}` = a positive integer `N` → sets this session's runaway limit to
  N, honoured verbatim (no upper clamp).
- `${ARGUMENTS}` = `unlimited` (or `off` / `none` / `0`) → removes the cap
  entirely; the loop then stops only on `supervisor_loop_exit`, the no-progress
  gate, a goal deadline, or `/supervisor off`.
- An invalid value (negative, fractional, non-numeric) is rejected with a clear
  message and leaves the current limit unchanged.

Default is 50 (`RUNAWAY_CEILING`); on Claude Code the
resolved limit is reduced to 7 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` minus one), and
`unlimited` cannot be honoured there — the CLI says so. Relay the CLI output.
