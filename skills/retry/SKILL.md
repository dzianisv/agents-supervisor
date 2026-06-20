---
name: retry
description: Set or check the supervisor retry budget (max continuation attempts) for this session. Use for "/supervisor:retry", "set supervisor retries", "how many times will the supervisor retry".
---

# /supervisor:retry — set the retry budget

Control how many times the supervisor will re-prompt the agent toward an active
goal before giving up.

## Steps

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" retry "${ARGUMENTS}"
```

- `${ARGUMENTS}` empty → reports the current budget.
- `${ARGUMENTS}` = a number `N` (1–100) → sets this session's budget to N.

Default is 16 while a goal is active (3 with no goal). Relay the CLI output.
