---
name: autopilot
description: Enable, disable, or inspect supervisor autopilot mode. Use for "/supervisor:autopilot", "turn on autopilot", "keep going without asking", "auto-continue".
---

# /supervisor:autopilot — enable continuous execution

Enable or disable supervisor autopilot mode, where the supervisor auto-continues after each stop WITHOUT running the judge, until the agent outputs `AUTOPILOT_EXIT` on its own line or the retry budget runs out.

## Steps

Run the CLI, passing the user's argument through verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" autopilot ${ARGUMENTS}
```

- `${ARGUMENTS}` empty, `on`, or `start` → enable autopilot mode.
- `${ARGUMENTS}` = `off`, `stop`, or `exit` → disable autopilot (back to reflection mode).
- `${ARGUMENTS}` = `status` → report autopilot status.

Relay the CLI output to the user.
