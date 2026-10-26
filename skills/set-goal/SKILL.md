---
name: set-goal
description: Set, check, or clear a session goal the supervisor pushes the agent to meet before it stops. Use for "/supervisor:set-goal", "set a supervisor goal", "keep going until X", "don't stop until <condition>". Distinct from Claude Code's native /goal command.
---

# /supervisor:set-goal — push toward a goal

## Steps

Run the CLI, passing the user's argument through verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" set-goal "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports current goal status.
- `${ARGUMENTS}` = `clear` / `stop` / `off` / `reset` / `none` / `cancel` → clears the goal.
- `${ARGUMENTS}` = `resume` / `unpause` → resumes a `paused` or `exhausted` goal — keeps the same condition, clears the stale pause reason, and resets this turn's attempt budget. If the goal isn't paused/exhausted, reports that honestly instead of silently doing nothing.
- otherwise → sets the goal to that condition (e.g. "all tests in test/auth pass and lint is clean").

Relay the CLI output to the user. This is an explicit user-owned goal; do not
infer or widen it. The condition is the default acceptance criterion. When the
user supplies separate criteria or a verification plan, pass them with
`--acceptance-criteria "<criteria>" --verification "<plan>"` on the same CLI call.
The full explicit user contract persists in session state and
`.agents/supervisor/Goal.md` for future sessions.

The judge checks the contract against concrete evidence reported in conversation
prose, not independent raw tool results. `SUPERVISOR_LOOP_EXIT: completed` requests
that audit and cannot bypass it. A stuck signal can pause; retry/no-progress,
human blockers or judge errors can stand supervision down without achievement.
Without an active session/project goal there is no completion supervision.
Clearing suppresses project fallback in this session; it does not delete shared
project configuration.

Always name this command `/supervisor:set-goal` in your own output — that is its
only supported spelling. Older names still parse, but are retired and must not be
shown to the user.
