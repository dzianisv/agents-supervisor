---
name: goal
description: Set, check, or clear a session goal the supervisor pushes the agent to meet before it stops. Use for "/supervisor:goal", "set a supervisor goal", "keep going until X", "don't stop until <condition>".
---

# /supervisor:goal — push toward a goal

Set a goal condition the supervisor enforces: while it's active, the Stop hook
keeps re-prompting the agent (up to the retry budget) until the goal is
demonstrably met or the budget runs out.

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
