---
name: objective
description: Set, check, or clear a session objective the supervisor pushes the agent to meet before it stops. Distinct from Claude Code's built-in "/goal" — this is the supervisor plugin's own condition + retry-budget mechanism. Use for "/supervisor:objective", "set a supervisor objective", "keep going until X", "don't stop until <condition>".
---

# /supervisor:objective — push toward an objective

Set a condition the supervisor enforces: while it's active, the Stop hook
keeps re-prompting the agent (up to the retry budget) until the condition is
demonstrably met or the budget runs out.

Note: this is the supervisor plugin's own mechanism, separate from Claude
Code's built-in `/goal` command.

## Steps

Run the CLI, passing the user's argument through verbatim:

```bash
SUPERVISOR_GOAL_LABEL=Objective node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" goal "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports current objective status.
- `${ARGUMENTS}` = `clear` / `stop` / `off` / `reset` / `none` / `cancel` → clears the objective.
- otherwise → sets the objective to that condition (e.g. "all tests in test/auth pass and lint is clean").

Relay the CLI output to the user. The objective is injected into the supervisor's judge
as a mandatory completion requirement, so the agent won't be allowed to stop until
it's met.
