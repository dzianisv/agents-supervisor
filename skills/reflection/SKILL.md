---
name: reflection
description: Switch the supervisor back to reflection mode (default — judge evaluates each stop). Use for "/supervisor:reflection", "normal supervisor mode", "turn off autopilot/goal".
---

# /supervisor:reflection — return to reflection mode

Switch the supervisor back to reflection mode, the default behavior. On each stop, the supervisor runs the judge and re-prompts only if work looks incomplete. Setting reflection mode clears any active goal or autopilot.

## Steps

Run the CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" mode reflection
```

Relay the CLI output to the user.
