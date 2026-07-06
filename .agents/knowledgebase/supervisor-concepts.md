# Supervisor Concepts

## Classification

The supervisor classifies stops into categories from the shared pattern set. README lists these categories:

- `complete`
- `waiting_for_user_legitimate`
- `tool_available_punt`
- `summary_drift_stop`
- `genuinely_stuck`
- `working`

Only categories representing actionable unfinished work should produce continuation feedback. Legitimate completion or legitimate user waits are left alone.

## Pattern Resolution

`core/patterns.mjs` deep-merges patterns in this order:

1. Shipped defaults: `core/patterns.json`.
2. User overrides: `~/.config/agents-supervisor/patterns.json`.
3. Project overrides: `<cwd>/.supervisor/patterns.json`.

Arrays and scalars replace wholesale during merge. Objects merge recursively. `/supervisor:train` writes learned patterns outside shipped defaults.

## Objective Loop

> User-facing name is "objective" (`/supervisor:objective`, with `/supervisor:goal` kept as a deprecated alias). Internal identifiers intentionally keep the old `goal` name — `core/goal.mjs`, the `goalStore` object, and the `goal` mode value are not renamed.

- An objective is a user-set completion condition the agent must demonstrably satisfy before the supervisor lets it stop.
- Objective commands (`/supervisor:objective`, with `/supervisor:goal` as a deprecated alias) parse through shared logic in `core/goal.mjs` and equivalent OpenCode logic in `opencode/supervisor.ts`.
- Objective state is stored under `.supervisor/goals/<sessionId>.json`.
- The default objective retry budget is 16 attempts, clamped to 1-100.
- Objective state can become active, achieved, or exhausted.
- An objective exhausts when the attempt budget or deadline is reached.
- `buildGoalRequirementSection` injects the objective as a mandatory evidence-backed completion requirement.

## Autopilot

- Autopilot is OpenCode-specific in the current README.
- In autopilot mode the supervisor skips judge evaluation and nudges on every idle.
- Autopilot stops when the agent calls `autopilot_exit` or the retry budget exhausts.
- Safety rails still include attempt budgets plus planning-loop and action-loop detection.
- Autopilot state uses the same per-session `.supervisor/goals/<sessionId>.json` store.

## Loop Detection

- Planning-loop detection flags read-heavy activity without implementation progress.
- Action-loop detection flags repeated commands/actions without progress.
- OpenCode loop detection lives in `opencode/supervisor.ts`.
- Loop findings can alter feedback so the agent is told to take concrete implementation or verification steps.

## Rubric And Prompt Configuration

- OpenCode rubric precedence is project `.supervisor/rubric.md`, then global `~/.config/opencode/supervisor/rubric.md`, then embedded defaults.
- `opencode/supervisor.ts` supports custom supervisor prompt files such as `.supervisor.md` or `supervisor.md` in the project directory.
- Tool-provided supervisor guidance can be set through the OpenCode `set_supervisor` tool.
- Preferred model and routing configuration are read from `~/.config/opencode/supervisor/config.yaml` when present.

## Privacy Boundary

- Training data is mined into `.dataset/`, which is intended to stay private and git-ignored.
- CI includes a privacy guard to prevent private datasets, transcripts, or non-example JSONL files from being tracked.
- Learned user-local patterns are not committed upstream by the training flow.
