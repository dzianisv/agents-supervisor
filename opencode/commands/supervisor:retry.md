---
description: Set or check the supervisor retry budget (max continuation attempts) for this session.
---
Call the `supervisor_retry` tool directly in this session. Do not use the `task`
tool or delegate to a subagent, because plugin-provided tools are available only
in the current session.

Interpret `$ARGUMENTS`:
- empty → call `supervisor_retry` with no args (report current budget).
- a number `N` (1–100) → call `supervisor_retry` with `n: N`.

Relay the tool's response. Default budget is 16.
