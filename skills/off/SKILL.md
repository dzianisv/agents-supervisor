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

   The CLI resolves the session in this order: `--session <id>` (a unique
   prefix is expanded), then `$SUPERVISOR_SESSION_ID` (exported by the Stop
   hook from its own stdin payload), then `$CLAUDE_SESSION_ID`, and only as a
   last resort `.supervisor/current_session` — which it announces, because
   that file is shared by every session in the project and names whichever
   stopped last. If the id is ambiguous it lists the candidates and acts on
   NOTHING. It appends the resolved session to
   `.supervisor/disabled` (newline-delimited) and prints
   `Supervisor disabled for session: <sid>`.
   If no session is found it exits with a message indicating nothing to disable.

   To target a specific session explicitly:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" off --session <session-id>`

2. Confirm to the user: "Supervisor disabled for this session. Run `/supervisor:on` to re-enable."

To disable the whole plugin across all sessions: `claude plugin disable supervisor@agents-supervisor`
