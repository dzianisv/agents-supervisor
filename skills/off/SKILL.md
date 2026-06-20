---
name: off
description: Disable the supervisor for this session. Use for "/supervisor:off", "supervisor off", "turn off supervisor", "disable supervisor", "stop supervising".
---

# /supervisor:off — disable for this session

Disable the supervisor hook for the current session only. The plugin stays installed; other sessions are unaffected.

## Steps

1. Get the current session ID and add it to the disabled list:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" off
   ```

   The CLI reads the session from `.supervisor/current_session`, falling back to
   `CLAUDE_SESSION_ID` when the file is absent. It appends the session to
   `.supervisor/disabled` (newline-delimited) and prints
   `Supervisor disabled for session: <sid>`.
   If no session is found it exits with a message indicating nothing to disable.

2. Confirm to the user: "Supervisor disabled for this session. Run `/supervisor:on` to re-enable."

To disable the whole plugin across all sessions: `claude plugin disable supervisor@agents-supervisor`
