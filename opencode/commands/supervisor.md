---
description: Inspect and control the goal supervisor for this session.
---
Call the tools directly in this session; do not delegate.

Interpret `$ARGUMENTS`:
- empty / `status`: `supervisor({ action: "status" })`.
- `on` / `off`: `supervisor({ action: "$ARGUMENTS" })`.
- `status on` / `status off` / `plain on` / `plain off`: `supervisor({ action: "$ARGUMENTS" })`.
- `set-goal` / `goal`: `supervisor_goal({})` (status or session-only derivation).
- `set-goal <condition>` / `goal <condition>`: `supervisor_goal` with that condition, `source: "user"`, observable `acceptanceCriteria`, and `verification` evidence/checks. Preserve exactly the user's scope.
- `set-goal clear`: `supervisor_goal({ clear: true, source: "user" })`.
- `set-goal resume`: `supervisor_goal({ resume: true })`.
- `retry <N>`: `supervisor_retry({ n: N })`; `unlimited` means `n: 0`.
- `autoreview on` / `autoreview off`: `supervisor_autoreview({ enabled: true/false })`.

There are no selectable modes. Old mode requests must not change or drop goals. Relay the actual tool result, including errors. With no active session/project goal there is no completion judge or continuation; status and plainspeak are independent toggles.
