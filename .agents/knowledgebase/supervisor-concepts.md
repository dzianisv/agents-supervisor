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

## Goal Loop

> User-facing name is `/supervisor:set-goal` on Claude Code and `/supervisor:goal` on OpenCode — Claude Code has a native `/goal` command a bare-named skill would shadow, OpenCode doesn't. Internal identifiers keep the `goal` name on both surfaces — `core/goal.mjs`, the `goalStore` object, and the `goal` mode value.

- A goal is a user-set completion condition the agent must demonstrably satisfy before the supervisor lets it stop.
- Goal commands parse through shared logic in `core/goal.mjs` and equivalent OpenCode logic in `opencode/supervisor.ts`.
- Goal state is stored under `.supervisor/goals/<sessionId>.json` (per-session). A separate project-level goal persists across sessions in `.agents/supervisor/Goal.md` (manually set, takes precedence) or lower-case `.agents/supervisor/goal.md` (see `writeProjectGoal`/`readProjectGoalCondition` in `core/goal.mjs`), with every write also appended to `goal-history.jsonl` so concurrent writers never silently lose a condition.
- On OpenCode, `/supervisor:goal` invoked with no condition and no existing session/project goal makes a bounded LLM call (`deriveGoalWithLLM`/`buildGoalDerivationPrompt` in `core/goal.mjs` + `opencode/supervisor-impl.ts`) to derive a concise, falsifiable goal from the task context, persisting it to `goal.md` only on success (`parseDerivedGoalResponse` requires `falsifiable: true` and rejects prompt-injection artifacts). If derivation fails or is invalid, no default is fabricated — the goal is left unset with an explicit request to set it manually.
- The default goal retry budget is 16 attempts, clamped to 1-100.
- Goal state can become active, achieved, or exhausted.
- A goal exhausts when the attempt budget or deadline is reached.
- `buildGoalRequirementSection` injects the goal as a mandatory evidence-backed completion requirement.

## Autopilot

- Autopilot is available on both Claude Code and OpenCode.
- In autopilot mode the supervisor skips judge evaluation and sends a static, calm nudge on every idle — it never runs loop detection or any other completion/progress judgement.
- Autopilot stops when the agent calls `autopilot_exit` (OpenCode) / outputs `AUTOPILOT_EXIT` (Claude Code) or the retry budget exhausts. Those are the ONLY two ways autopilot stops.
- Autopilot state uses the same per-session `.supervisor/goals/<sessionId>.json` store.

## Loop Detection

- `core/evaluation.mjs` exports `detectPlanningLoop` (read-heavy activity without implementation progress) and `detectActionLoop` (repeated commands/actions) as pure, stateless functions.
- These functions have **no override authority**. They never author or substitute a completion/progress verdict, and they never produce a scripted "STOP: Loop Detected" message.
- Their only remaining use is `describeToolActivity`, which turns a bounded, recent slice of tool-call counts into one neutral, factual sentence (e.g. "9 tool calls — 0 write-type, 9 read-only"). That sentence may enrich the autopilot nudge or appear in the judge's prompt as clearly non-binding evidence — it is threaded through `TaskContext.toolActivityNote` — but it never changes what the nudge says or what the judge/feedback decides.
- The reflection judge's own verdict (`analysis.severity`/`reason`/`missing`/`nextActions`) is the sole authority for feedback text (`core/feedback.mjs`'s `buildEscalatingFeedback`); loop-detection output cannot flip or replace it.

## Rubric And Prompt Configuration

- OpenCode rubric precedence is project `.supervisor/rubric.md`, then global `~/.config/opencode/supervisor/rubric.md`, then embedded defaults.
- `opencode/supervisor.ts` supports custom supervisor prompt files such as `.supervisor.md` or `supervisor.md` in the project directory.
- Tool-provided supervisor guidance can be set through the OpenCode `set_supervisor` tool.
- Preferred model and routing configuration are read from `~/.config/opencode/supervisor/config.yaml` when present.

## Privacy Boundary

- Training data is mined into `.dataset/`, which is intended to stay private and git-ignored.
- CI includes a privacy guard to prevent private datasets, transcripts, or non-example JSONL files from being tracked.
- Learned user-local patterns are not committed upstream by the training flow.
