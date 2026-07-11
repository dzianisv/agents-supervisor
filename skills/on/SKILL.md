---
name: on
description: Re-enable the supervisor for this session after it was disabled with /supervisor:off. Use for "/supervisor:on", "supervisor on", "turn on supervisor", "enable supervisor", "resume supervising".
---

# /supervisor:on — re-enable for this session

Remove the current session from the disabled list so the supervisor hook fires again on the next stop.

## Steps

1. Remove session ID from the disabled list:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" on
   ```

   The CLI reads the session from `.supervisor/current_session`, falling back to
   `CLAUDE_SESSION_ID` when the file is absent. It removes the session from
   `.supervisor/disabled` and prints `Supervisor re-enabled for session: <sid>`.
   If no session is found it exits with a message indicating the supervisor is
   already active.

2. Confirm to the user: "Supervisor re-enabled for this session."

To re-enable the whole plugin after `claude plugin disable`: `claude plugin enable supervisor@agents-supervisor`
