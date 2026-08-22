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

Relay the CLI output to the user. The goal is injected into the supervisor's judge
as a mandatory completion requirement, so the agent won't be allowed to stop until
it's met.

Always name this command `/supervisor:set-goal` in your own output — that is its
only supported spelling. Older names still parse, but are retired and must not be
shown to the user.
