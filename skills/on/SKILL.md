---
name: on
description: Re-enable the supervisor for this session after it was disabled with /supervisor:off. Use for "/supervisor:on", "supervisor on", "turn on supervisor", "enable supervisor", "resume supervising".
---

# /supervisor:on — re-enable for this session

Remove the current session from the disabled list so an active session/project
goal can be supervised on the next stop. Enabling alone does not create a goal;
without a goal there is no completion judge or completion continuation.

## Steps

1. Remove session ID from the disabled list:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" on
   ```

   The CLI resolves the session in this order: `--session <id>` (a unique
   prefix is expanded), then `$SUPERVISOR_SESSION_ID` (exported by the Stop
   hook from its own stdin payload), then `$CLAUDE_SESSION_ID`, and only as a
   last resort `.supervisor/current_session` — which it announces, because
   that file is shared by every session in the project and names whichever
   stopped last. If the id is ambiguous it lists the candidates and acts on
   NOTHING. It removes the resolved session from
   `.supervisor/disabled` and prints `Supervisor re-enabled for session: <sid>`.
   If no session is found it exits with a message indicating the supervisor is
   already active.

   To target a specific session explicitly:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" on --session <session-id>`

2. Confirm to the user: "Supervisor re-enabled for this session."

To re-enable the whole plugin after `claude plugin disable`: `claude plugin enable supervisor@agents-supervisor`
