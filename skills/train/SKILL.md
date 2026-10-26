---
name: train
description: Train the supervisor on your recent sessions. Mines how the agent stopped and how you followed up, then updates your LOCAL patterns/anti-patterns so future stop-classification is sharper. Use when asked to "train the supervisor", "/supervisor:train", "learn from my sessions", or "improve stop detection".
---

# /supervisor:train — learn from real sessions

Run the supervisor training loop. It reads your recent agent sessions (Claude Code
transcripts and OpenCode DBs), extracts every "agent stopped → user followed up"
pair, classifies each, and updates your **user-local** patterns/anti-patterns
(`~/.config/agents-supervisor/patterns.json`). The shipped defaults and the
upstream repo are never modified, and the mined dataset is kept private (local +
optional private HuggingFace).

## Steps

1. Run the orchestrator (decide flags from the user's request):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/train/run-train.mjs" \
     --since=14d \
     ${ARGUMENTS}
   ```

   Useful flags:
   - `--since=<N>d` — only mine sessions from the last N days (default 14d).
   - `--dry-run` — mine + classify + show the proposed pattern diff, but do NOT
     write the user-local patterns file.
   - `--scope=user|project` — where to write learned patterns (default `user`).
   - `--push-hf` — also push the private mined dataset to HuggingFace
     (requires `hf auth login`; dataset repo from `SUPERVISOR_HF_DATASET`, default
     `dzianisv/agent-supervisor-stops`, created private).

2. Read the orchestrator's report. It prints: sessions scanned, new stop/follow-up
   pairs added, label distribution, the proposed change to each category /
   anti-pattern, and the eval delta on the local validation set.

3. If the eval delta is non-negative, the new user-local patterns are applied
   (a `.bak` of the prior file is kept). If it regressed, the run reports the
   diff and rolls back automatically — relay that to the user.

4. Summarize for the user: what changed in their patterns, where the file lives,
   and how to revert (`mv <file>.bak <file>`).

## Notes
- First run may need: `hf auth login` and `pip install -U huggingface_hub datasets`
  (only if `--push-hf` is used).
- This is a learning action on the user's machine. It never commits to git and
  never sends transcripts anywhere except (optionally) the user's own private HF
  dataset.
