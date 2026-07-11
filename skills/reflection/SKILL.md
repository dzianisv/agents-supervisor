---
name: reflection
description: Switch the supervisor to reflection mode (default). The supervisor runs the completion judge (patterns + antipatterns) on each stop. Project-level goal from .agents/supervisor/Goal.md is also injected if present. Use for "/supervisor:reflection", "supervisor reflection", "enable reflection mode", "return to reflection".
---

# /supervisor:reflection — switch to reflection mode

Set the supervisor to **reflection** mode for this session. In reflection mode:
- The judge runs after each stop and evaluates completion against patterns/antipatterns.
- If `.agents/supervisor/Goal.md` is present in the project, its condition is injected as a mandatory completion requirement.

This is the **default** mode. Use it to return from `autopilot` or `goal` mode. Setting reflection mode clears any active goal or autopilot.

## Modes at a glance

| Mode | Trigger | Behavior |
|---|---|---|
| **reflection** (default) | `/supervisor:reflection` | Judge runs patterns/antipatterns; injects `Goal.md` if present |
| **goal** | `/supervisor:set-goal <condition>` | Keeps pushing until the specific condition is met |
| **autopilot** | `/supervisor:autopilot` | Skips judge entirely; always continues until `AUTOPILOT_EXIT` |

Note: `/supervisor:off` and `/supervisor:on` are **not** modes — they enable/disable the supervisor for the current session only.

## Steps

Run the CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" mode reflection
```

Relay the CLI output to the user. Confirm: "Supervisor set to reflection mode. The judge will run on each stop using patterns/antipatterns."

If a `.agents/supervisor/Goal.md` file is present, add: "Project-level goal from `.agents/supervisor/Goal.md` will also be enforced in reflection mode."
