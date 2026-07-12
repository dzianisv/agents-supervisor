# Reflection Prompt

You are evaluating an agent's work against workflow requirements.
Analyze the task context, the agent's last response, and the tool signals to determine whether the task is complete.

## Task Context
- Summary: {{taskSummary}}
- Type: {{taskType}}
- Mode: {{agentMode}}
- Heuristic signals (repo checks; informative, not binding): {{requirements}}
- Detected signals: {{signals}}

## Tool Commands Run
{{toolsSummary}}

{{#lastAssistantText}}
## Agent's Last Response
{{lastAssistantText}}
{{/lastAssistantText}}

{{#attemptSection}}
## Supervisor History
- This is supervisor attempt {{attemptNumber}}/{{maxAttempts}} for this task.
- Previous supervisors found the task incomplete.
- If you are repeating the same actions without progress, set "stuck": true and explain what is blocking you.
{{/attemptSection}}

{{#projectInstructions}}
## Project Instructions
{{projectInstructions}}
{{/projectInstructions}}

{{#goalSection}}
## Goal (mandatory completion requirement)
{{goalSection}}
{{/goalSection}}

## Response Format

Return JSON only:
{
  "task_summary": "brief description of what was done",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.95,
  "evidence": {
    "tests": { "ran": true, "results": "pass|fail|unknown", "ran_after_changes": true, "commands": [] },
    "build": { "ran": true, "results": "pass|fail|unknown" },
    "pr": { "created": true, "url": "", "ci_status": "pass|fail|unknown", "checked": true }
  },
  "remaining_work": ["list any incomplete items"],
  "next_steps": ["list next actions needed"],
  "needs_user_action": ["list any actions requiring user input"],
  "stuck": false,
  "alternate_approach": "describe if needed"
}
