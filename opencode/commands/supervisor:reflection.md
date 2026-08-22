---
description: Switch the supervisor to reflection mode (default — judge on patterns/antipatterns).
---
Switch to reflection mode by calling the `supervisor` tool. Reflection mode clears
any active goal or autopilot session.

Do not use the `task` tool or delegate to a subagent. Call the supervisor tools
directly in this session so the plugin-provided tools are available.

Call `supervisor` with `mode: "reflection"`.

After it returns, relay the response. Add context for the user:

- **reflection** (default): judge runs after each stop; evaluates against
  patterns/antipatterns. If `.agents/supervisor/Goal.md` is present, its condition
  is also injected as a mandatory requirement.
- **goal**: set with `/supervisor:set-goal <condition>`; keeps pushing until that
  specific condition is met.
- **autopilot**: set with `/supervisor:autopilot on`; skips the judge and always
  continues until the agent calls `supervisor_loop_exit`.

`/supervisor:on` / `/supervisor:off` are **not** modes — they enable/disable the
supervisor for the current session only.
