---
description: Set, derive, inspect, clear, or resume a verified goal contract.
---
Call `supervisor_goal` directly in this session; do not delegate.

Interpret `$ARGUMENTS`:
- empty: call with no args. Reports an existing goal, or derives a session-only agent contract from requested work if none exists.
- `clear` / `stop` / `off` / `reset` / `none` / `cancel`: call with `clear: true, source: "user"` (explicit user cancellation).
- `resume` / `unpause`: call with `resume: true`.
- anything else: call with `condition: "$ARGUMENTS"`, `source: "user"`, `acceptanceCriteria` describing observable success within exactly the requested scope, and `verification` describing checks/evidence for every criterion.

Relay the tool's actual result, including failures. Explicit user-set goals are also saved to `.agents/supervisor/Goal.md`; inferred agent contracts are session-only. The idle judge audits all criteria before accepting completion. `supervisor_loop_exit(completed)` cannot bypass that audit.
