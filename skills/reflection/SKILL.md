---
name: reflection
description: Switch the supervisor to reflection mode (default). The supervisor runs the completion judge (patterns + antipatterns) on each stop. Project-level goal from .agents/supervisor/Goal.md is also injected if present. Use for "/supervisor:reflection", "supervisor reflection", "enable reflection mode", "return to reflection".
---

# /supervisor:reflection — switch to reflection mode

Set the supervisor to **reflection** mode for this session. In reflection mode:
- The judge runs after each stop and evaluates completion against patterns/antipatterns.
- If `.agents/supervisor/Goal.md` is present in the project, its condition is injected as a mandatory completion requirement.

This is the **default** mode. Use it to return from `autopilot`. Switching mode
**keeps any active goal** — a goal is a session attribute, not a mode, so it
survives the switch (and in reflection it is verified by the judge). To remove a
goal, clear it explicitly with `/supervisor:set-goal clear`.

## Modes at a glance

| Mode | Trigger | Behavior |
|---|---|---|
| **reflection** (default) | `/supervisor:reflection` | Judge runs patterns/antipatterns; injects `Goal.md` if present; grades against an active goal |
| **autopilot** | `/supervisor:autopilot` | Skips judge entirely; always continues until `SUPERVISOR_LOOP_EXIT: completed`. An active goal rides along as context but is **not** verified |

A **goal** (`/supervisor:set-goal <condition>`) is not a mode — it is an
orthogonal attribute. Setting one puts you in reflection (where it is checked);
it stays set across mode switches until you clear it.

Note: `/supervisor:off` and `/supervisor:on` are **not** modes — they enable/disable the supervisor for the current session only.

## Steps

Run the CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" mode reflection
```

Relay the CLI output to the user. Confirm: "Supervisor set to reflection mode. The judge will run on each stop using patterns/antipatterns."

If a `.agents/supervisor/Goal.md` file is present, add: "Project-level goal from `.agents/supervisor/Goal.md` will also be enforced in reflection mode."
