---
description: Train the supervisor on recent sessions and update your local patterns/anti-patterns.
agent: build
subtask: true
---
Run the supervisor training loop by calling the `supervisor_train` tool.

Mine recent sessions for "agent stopped → user followed up" pairs, classify them,
and update the user-local patterns/anti-patterns. The dataset stays private (local
+ optional private HuggingFace); nothing is committed to git.

Interpret `$ARGUMENTS` and pass to the tool:
- `--since=<N>d` → `since` (default `14d`)
- `--dry-run` → `dryRun: true` (preview the pattern diff, do not write)
- `--push-hf` → `pushHf: true` (also push the private dataset to HuggingFace)

After the tool returns, summarize for the user: sessions scanned, new pairs added,
label distribution, what changed in their patterns, the eval delta, and how to
revert (`mv <patterns>.bak <patterns>`).
