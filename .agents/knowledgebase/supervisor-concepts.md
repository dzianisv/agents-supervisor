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

> User-facing name is `/supervisor:set-goal` on **both** runtimes. Claude Code has a native `/goal` command a bare-named skill would shadow; OpenCode doesn't, but one name across runtimes beats a per-runtime split (the split silently reappeared once already — see `command-surface.md`). Internal identifiers keep the `goal` name on both surfaces — `core/goal.mjs`, the `goalStore` object, and the `supervisor_goal` tool. NOTE: `goal` is NO LONGER a supervisor mode — a goal is an orthogonal session attribute (`state.goal`) carried by either the `reflection` or `autopilot` mode. The string `'goal'` survives only as a deprecated INPUT alias for `reflection` (kept so stale skills/commands don't hard-error).

- A goal is a user-set completion condition the agent must demonstrably satisfy before the supervisor lets it stop. It is an attribute, not a mode: setting one puts the session in `reflection` (the mode that verifies it). In `reflection` the judge grades against it; in `autopilot` its condition rides along as CONTEXT on the nudge but is NEVER verified (accepted trade-off — autopilot never runs the judge).
- Goal commands parse through shared logic in `core/goal.mjs` and equivalent OpenCode logic in `opencode/supervisor.ts`.
- Goal state is stored under `.supervisor/goals/<sessionId>.json` (per-session). A separate project-level goal persists across sessions in `.agents/supervisor/Goal.md` (manually set, takes precedence) or lower-case `.agents/supervisor/goal.md` (see `writeProjectGoal`/`readProjectGoalCondition` in `core/goal.mjs`), with every write also appended to `goal-history.jsonl` so concurrent writers never silently lose a condition.
- On OpenCode, `/supervisor:set-goal` invoked with no condition and no existing session/project goal makes a bounded LLM call (`deriveGoalWithLLM`/`buildGoalDerivationPrompt` in `core/goal.mjs` + `opencode/supervisor-impl.ts`) to derive a concise, falsifiable goal from the task context, persisting it to `goal.md` only on success (`parseDerivedGoalResponse` requires `falsifiable: true` and rejects prompt-injection artifacts). If derivation fails or is invalid, no default is fabricated — the goal is left unset with an explicit request to set it manually.
- The attempt counter is a **runaway safety valve**, not a budget the agent is meant to spend: the intended stop is the agent's own `supervisor_loop_exit` / `SUPERVISOR_LOOP_EXIT:` declaration. It defaults to `RUNAWAY_CEILING = 64` (derived from a 30-day forensic sample — real legit turns cap at ≤3 injections; see `.scratch/runaway-limit-analysis.md`), the SAME in every mode (no per-mode defaults). It is fully configurable — `/supervisor:retry N` (session) > `maxAttempts:` in `~/.config/opencode/supervisor.yaml` > `SUPERVISOR_MAX_ATTEMPTS` env > default — where a positive integer is honoured verbatim (no upper clamp) and `unlimited`/`off`/`none`/`0` removes the cap entirely. On Claude Code the resolved limit is reduced to 7 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` minus one), which is surfaced in status + debug when it forces the requested value (esp. `unlimited`) down. Tune it with `/supervisor:retry N`. One function resolves it: `describeRunawayLimit` in `core/goal.mjs` (with `resolveRunawayLimit` as the thin number accessor).
- Goal state can become active, achieved, or exhausted.
- A goal exhausts when the runaway safety valve or deadline is reached.
- `buildGoalRequirementSection` injects the goal as a mandatory evidence-backed completion requirement.

## Autopilot

- Autopilot is available on both Claude Code and OpenCode.
- In autopilot mode the supervisor skips judge evaluation unconditionally and sends a static, calm nudge on every idle — the fast-path is gated only by `mode === "autopilot"` plus the runaway-valve check, never by any loop check. If a goal is active, its condition is appended to that nudge as context (via `appendGoalContextToNudge`), but autopilot never verifies it.
- Autopilot stops when the agent declares `supervisor_loop_exit` (OpenCode tool call) / outputs `SUPERVISOR_LOOP_EXIT: completed` (Claude Code sentinel) or the runaway safety valve trips. Those are the ONLY two ways autopilot stops. (`core/loop-exit.mjs` keeps a parse-only legacy alias for stale installed skill copies — not taught here or anywhere else shipped.)
- Autopilot state uses the same per-session `.supervisor/goals/<sessionId>.json` store.

## Tool-Activity Telemetry

- There is no deterministic repetitive-behavior verdict mechanism in the codebase anymore — the pure functions that used to compute a boolean "read-heavy without progress" / "repeated command" verdict in `core/evaluation.mjs` have been fully removed (two were dead code never called by anything; the remaining one's boolean verdict was never consumed by any caller).
- What remains is `summarizeToolActivity(messages)` in `core/evaluation.mjs` — a pure, stateless counter that returns only `{ readCount, writeCount, totalTools }` over a bounded, recent slice of tool calls. It makes no judgment and returns no verdict of any kind.
- `describeToolActivity(stats)` turns those counts into one neutral, factual sentence (e.g. "Recent tool activity (informational only, not a verdict): 9 tool calls — 0 write-type, 9 read-only."). That sentence is threaded through `TaskContext.toolActivityNote` and may enrich the autopilot nudge text and the reflection judge's prompt as non-binding context — it never changes what the nudge says or what the judge/feedback decides.
- The reflection judge's own verdict (`analysis.severity`/`reason`/`missing`/`nextActions`, or the self-assessment `status`/`confidence`) remains the sole authority for completion/progress feedback text (`core/feedback.mjs`'s `buildEscalatingFeedback`). Tool-activity telemetry cannot flip or replace it.

## Rubric And Prompt Configuration

- OpenCode rubric precedence is project `.supervisor/rubric.md`, then global `~/.config/opencode/supervisor/rubric.md`, then embedded defaults.
- `opencode/supervisor.ts` supports custom supervisor prompt files such as `.supervisor.md` or `supervisor.md` in the project directory.
- Tool-provided supervisor guidance can be set through the OpenCode `set_supervisor` tool.
- Preferred model and routing configuration are read from `~/.config/opencode/supervisor/config.yaml` when present.

## Privacy Boundary

- Training data is mined into `.dataset/`, which is intended to stay private and git-ignored.
- CI includes a privacy guard to prevent private datasets, transcripts, or non-example JSONL files from being tracked.
- Learned user-local patterns are not committed upstream by the training flow.
