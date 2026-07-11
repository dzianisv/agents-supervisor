# Architecture

`agents-supervisor` is a dataset-backed supervisor for coding agents. It watches for premature stops and, when appropriate, injects continuation feedback so the agent keeps working.

## Runtime Surfaces

- Claude Code integration uses a `Stop` hook declared in `hooks/hooks.json`.
- The Claude Code hook command is `bin/supervisor-on-stop.mjs`.
- OpenCode integration is the plugin entrypoint `opencode/supervisor.ts`.
- OpenCode plugin package metadata lives in `opencode/package.json`.
- Claude plugin metadata lives in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Shared Core

- `core/patterns.json` is the shipped classification taxonomy and feedback template source of truth.
- `core/patterns.mjs` loads effective patterns by deep-merging shipped defaults, user-local overrides, then project overrides.
- `core/judge-core.mjs` builds and runs runtime-agnostic stop-classification prompts.
- `core/feedback-core.mjs` decides when classifications should produce continuation feedback.
- `core/goal.mjs` contains shared goal-loop parsing, retry-budget resolution, goal prompt generation, per-session state helpers, and concurrency-safe project-level goal persistence (`writeProjectGoal`/`readProjectGoalHistory`/`extractGoalCondition` for `.agents/supervisor/Goal.md`). User-facing command is `/supervisor:set-goal` on Claude Code, `/supervisor:goal` on OpenCode; internal module/identifiers keep the `goal` name on both.

## OpenCode Flow

- `opencode/supervisor.ts` exports the OpenCode plugin and handles `session.idle` events.
- On idle it skips disabled sessions, judge sessions, plan mode, recently aborted sessions, and transcripts that are too short.
- It builds task context from messages, tool use, workflow signals, recent commands, and repository signals.
- It creates separate ephemeral sessions for self-assessment and optional judge/cross-model review.
- If the analysis says work remains, it injects feedback into the active session through `client.session.promptAsync`.
- It tracks reflected message signatures and attempt counts to avoid repeating feedback for the same stop.

## Persistent State

- Goal, retry, and autopilot state is per session under `.supervisor/goals/<sessionId>.json` with mode `0600` where supported.
- OpenCode session disable state is stored under `.supervisor/disabled`.
- OpenCode verdict/debug artifacts are written under `.supervisor/`.
- Learned pattern overrides default to `~/.config/agents-supervisor/patterns.json`.
- Project-specific pattern overrides can live at `<project>/.supervisor/patterns.json`.

## Important Files

- `README.md` - primary product and usage overview.
- `package.json` - root scripts and dependencies.
- `.github/workflows/ci.yml` - CI checks and privacy guard.
- `opencode/commands/*.md` - OpenCode slash command definitions.
- `skills/*/SKILL.md` - Claude Code skill surfaces.
- `train/run-train.mjs` - training pipeline entrypoint.
- `evals/judge-eval.mjs` - judge evaluation entrypoint.
- `test/*.test.mjs` - unit tests.
- `test/e2e-cc.mjs` - Claude Code hook end-to-end test.
