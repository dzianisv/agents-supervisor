---
description: Set or check the supervisor per-turn runaway safety valve for this session.
---
Call the `supervisor_retry` tool directly in this session. Do not use the `task`
tool or delegate to a subagent, because plugin-provided tools are available only
in the current session.

Interpret `$ARGUMENTS`:
- empty → call `supervisor_retry` with no args (report current limit).
- a positive integer `N` → call `supervisor_retry` with `n: N` (honoured
  verbatim, no upper clamp).
- `unlimited` / `off` / `none` / `0` → call `supervisor_retry` with `n: 0`
  (removes the cap entirely).

Relay the tool's response. Default is 50 (`RUNAWAY_CEILING`), the same in every
mode — it is a runaway safety valve, not a budget; the real stop is
`supervisor_loop_exit`.
