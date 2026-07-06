---
name: goal
description: Deprecated alias for /supervisor:objective, kept for backward compatibility. Set, check, or clear a session goal the supervisor pushes the agent to meet before it stops. Prefer "/supervisor:objective" going forward.
---

# /supervisor:goal — deprecated alias for /supervisor:objective

This command is a deprecated alias. Prefer `/supervisor:objective`, which
does the same thing under a name that doesn't collide with Claude Code's
own built-in `/goal` command.

## Steps

Run the CLI, passing the user's argument through verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" goal "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports current goal status.
- `${ARGUMENTS}` = `clear` / `stop` / `off` / `reset` / `none` / `cancel` → clears the goal.
- otherwise → sets the goal to that condition (e.g. "all tests in test/auth pass and lint is clean").

Relay the CLI output to the user. The goal is injected into the supervisor's judge
as a mandatory completion requirement, so the agent won't be allowed to stop until
it's met.
