# Command Surface

## Root Scripts

Defined in `package.json`:

- `npm test` - runs `node --experimental-strip-types --test test/*.test.mjs`.
- `npm run test:cc` - runs `node test/e2e-cc.mjs`.
- `npm run eval` - runs `node evals/judge-eval.mjs`.
- `npm run train` - runs `node train/run-train.mjs`.

CI uses Node 22 and runs unit tests, Claude hook e2e, judge eval, OpenCode plugin syntax check, and a privacy guard that rejects committed private dataset/transcript/jsonl files except examples.

## Claude Code Surface

- Installation is via Claude plugin metadata under `.claude-plugin/`.
- Runtime enforcement uses the `Stop` hook in `hooks/hooks.json`, which runs `bin/supervisor-on-stop.mjs`.
- User-facing skills live under `skills/`.
- Current skill directories: `status`, `on`, `off`, `set-goal`, `retry`, `train`, `autopilot`, `reflection` (8 canonical, no `goal`/`objective` alias directories).
- `set-goal` is deliberately not named `goal` — Claude Code has a native `/goal` command and a bare-named skill would shadow it (see fix/goal-skill-shadows-native-command). Plugin skills are always namespaced (`/supervisor:<name>`), so the rename only shortens the suffix, not the mandatory `supervisor:` prefix.
- Canonical CLI is `bin/supervisor.mjs` (with `bin/supervisor-goal.mjs` as a back-compat shim).
- `bin/supervisor-on-stop.mjs` includes an autopilot fast-path for lightweight continuation, plus the background-subagent stop exemption and project-goal (`Goal.md`) injection.
- README documents the full unified command set: `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:set-goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, and `/supervisor:reflection`.

## OpenCode Surface

- Package name is `opencode-supervisor` in `opencode/package.json`.
- Plugin entrypoint is `opencode/supervisor.ts`.
- Slash command files are under `opencode/commands/`.
- Current command files: `supervisor.md` (bare `/supervisor <mode>` dispatcher) plus colon subcommands — `supervisor:status.md`, `supervisor:on.md`, `supervisor:off.md`, `supervisor:set-goal.md`, `supervisor:retry.md`, `supervisor:train.md`, `supervisor:autopilot.md`, `supervisor:reflection.md`. Naming is identical to Claude Code's skill set.
- **Regression history — `/supervisor:goal` must never come back.** It was renamed to `/supervisor:objective` on both runtimes (PR #41, `b2a28a4`), then independently renamed `goal → set-goal` on the Claude Code side only (#43, `0d8ead8`). Merge `27d873e` resolved the two by keeping `set-goal` and deleting the `objective` files — but only touched the Claude Code skills, so OpenCode silently kept `supervisor:goal.md`. Unified to `set-goal` on both runtimes; `test/manifest.test.mjs` now pins the OpenCode command filenames and asserts no user-facing surface emits the literal `/supervisor:goal`.
- README documents the full unified colon-command set and notes OpenCode additionally has the bare `/supervisor <subcommand>` dispatcher.
- README documents OpenCode tools: `supervisor`, `set_supervisor`, `supervisor_train`, `supervisor_goal`, `supervisor_retry`, `supervisor_autopilot`, and `supervisor_loop_exit`.

## Training And Eval

- `train/run-train.mjs` orchestrates training.
- `train/build_dataset.py` mines OpenCode SQLite DBs and Claude transcripts into `.dataset/*.xml`.
- `train/derive.mjs` derives metadata and antipattern weights.
- `train/update_patterns.mjs` writes learned pattern overrides from `.dataset/_analysis/summary.json`.
- `train/validate_dataset.py` validates mined XML datasets.
- `train/export_stop_candidates.py` exports stop/defer candidates to `/tmp/stop-candidates`.
- `train/classify-bulk.mjs` classifies JSONL candidates through `core/judge-core.mjs`.
- `train/hf_export.mjs` redacts and exports JSONL for HuggingFace format.
- `train/hf_dataset.py` pushes private `.dataset/` content to a HuggingFace dataset repo.
- `evals/judge-eval.mjs` runs judge evals.

## Unified Command Set

Both Claude Code and OpenCode expose the same 8 colon subcommands (naming differs only for the goal-setting one, see above):
1. `/supervisor:status` — display current patterns and verdicts
2. `/supervisor:on` — enable supervisor
3. `/supervisor:off` — disable supervisor
4. `/supervisor:set-goal <condition>` (both runtimes) — set a mandatory completion condition
5. `/supervisor:retry N` — tune the runaway safety valve (positive int, or `unlimited`/`0` for no cap; default 64)
6. `/supervisor:train` — mine and learn from your sessions
7. `/supervisor:autopilot` — skip judge, auto-continue until `supervisor_loop_exit`/`SUPERVISOR_LOOP_EXIT: completed` or budget
8. `/supervisor:reflection` — return to default completion-judge mode

OpenCode additionally supports a bare `/supervisor <subcommand>` dispatcher as an alternative syntax for the same commands.

## Install Surfaces

- Claude marketplace metadata: `.claude-plugin/marketplace.json`.
- Claude plugin metadata: `.claude-plugin/plugin.json`.
- Claude hook metadata: `hooks/hooks.json`.
- OpenCode package metadata: `opencode/package.json`.
- OpenCode local plugin file: `opencode/supervisor.ts`.
