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
- Runtime enforcement uses the `Stop` hook in `hooks/hooks.json`, which runs `bin/on-stop.mjs`.
- User-facing skills live under `skills/`.
- Current skill directories include `status`, `on`, `off`, `supervisor-goal`, `retry`, and `train`.
- README documents `/supervisor:status`, `/supervisor:train`, `/supervisor:supervisor-goal`, and `/supervisor:retry` for Claude Code.
- `supervisor-goal` is deliberately not named `goal` — Claude Code has a native `/goal` command and a bare-named skill would shadow it (see fix/goal-skill-shadows-native-command).

## OpenCode Surface

- Package name is `opencode-supervisor` in `opencode/package.json`.
- Plugin entrypoint is `opencode/supervisor.ts`.
- Slash command files are under `opencode/commands/`.
- Current command files include `supervisor.md`, `supervisor:goal.md`, `supervisor:retry.md`, and `supervisor:train.md`.
- README documents OpenCode tools: `supervisor`, `set_supervisor`, `supervisor_train`, `supervisor_goal`, `supervisor_retry`, `supervisor_autopilot`, and `autopilot_exit`.
- README documents `/supervisor:autopilot`, but no `opencode/commands/supervisor:autopilot.md` file is present in this repository snapshot.

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

## Install Surfaces

- Claude marketplace metadata: `.claude-plugin/marketplace.json`.
- Claude plugin metadata: `.claude-plugin/plugin.json`.
- Claude hook metadata: `hooks/hooks.json`.
- OpenCode package metadata: `opencode/package.json`.
- OpenCode local plugin file: `opencode/supervisor.ts`.
