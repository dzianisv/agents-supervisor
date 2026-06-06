---
description: Show supervisor status, or set guidance / toggle on-off for this session.
agent: build
---
Inspect and control the supervisor for this project.

If the user just typed `/supervisor`, call the `supervisor` tool to report status
(effective patterns, recent verdicts, whether this session is disabled).

Interpret `$ARGUMENTS`:
- `off` / `on` → call the `supervisor` tool with that action to disable/enable the
  judge for THIS session only.
- a plan/checklist → call `set_supervisor` with it as `guidance` so the judge
  validates completion against those steps.
- anything else → report current status.
