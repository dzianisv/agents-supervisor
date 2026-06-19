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
- Current skill directories include all 8 colon subcommands: `status`, `on`, `off`, `goal`, `retry`, `train`, `autopilot`, and `reflection`.
- Canonical CLI is `bin/supervisor.mjs` (with `bin/supervisor-goal.mjs` as a back-compat shim).
- `bin/on-stop.mjs` includes an autopilot fast-path for lightweight continuation.
- README documents the full unified command set: `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, and `/supervisor:reflection`.

## OpenCode Surface

- Package name is `opencode-supervisor` in `opencode/package.json`.
- Plugin entrypoint is `opencode/supervisor.ts`.
- Slash command files are under `opencode/commands/`.
- Current command files include `supervisor.md` (bare dispatcher) plus all 8 colon subcommands: `supervisor:status.md`, `supervisor:on.md`, `supervisor:off.md`, `supervisor:goal.md`, `supervisor:retry.md`, `supervisor:train.md`, `supervisor:autopilot.md`, and `supervisor:reflection.md`.
- README documents the full unified colon-command set and notes OpenCode additionally has the bare `/supervisor <subcommand>` dispatcher.
- README documents OpenCode tools: `supervisor`, `set_supervisor`, `supervisor_train`, `supervisor_goal`, `supervisor_retry`, `supervisor_autopilot`, and `autopilot_exit`.

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

Both Claude Code and OpenCode expose the same 8 colon subcommands:
1. `/supervisor:status` — display current patterns and verdicts
2. `/supervisor:on` — enable supervisor
3. `/supervisor:off` — disable supervisor
4. `/supervisor:goal <condition>` — set a mandatory completion condition
5. `/supervisor:retry N` — set the retry budget
6. `/supervisor:train` — mine and learn from your sessions
7. `/supervisor:autopilot` — skip judge, auto-continue until AUTOPILOT_EXIT or budget
8. `/supervisor:reflection` — return to default completion-judge mode

OpenCode additionally supports a bare `/supervisor <subcommand>` dispatcher as an alternative syntax for the same commands.

## Install Surfaces

- Claude marketplace metadata: `.claude-plugin/marketplace.json`.
- Claude plugin metadata: `.claude-plugin/plugin.json`.
- Claude hook metadata: `hooks/hooks.json`.
- OpenCode package metadata: `opencode/package.json`.
- OpenCode local plugin file: `opencode/supervisor.ts`.
