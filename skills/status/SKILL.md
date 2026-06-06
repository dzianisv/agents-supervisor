---
name: status
description: Show supervisor status — effective patterns, where learned overrides live, recent stop verdicts, and whether the session is disabled. Use for "/supervisor:status", "supervisor status", "what patterns is the supervisor using", "is the supervisor on".
---

# /supervisor:status — inspect the supervisor

Report the current supervisor state for this project.

## Steps

1. Run the status reporter:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/status.mjs"
   ```

   It prints:
   - Effective pattern source layering (shipped ⊕ user-config ⊕ project) and which
     files are actually present.
   - Category list + inject categories currently in effect.
   - Pattern provenance (dataset size / premature %).
   - Recent verdicts from `.supervisor/verdict_*.json` (last few), with category +
     whether an inject fired.
   - Whether the current session id is in `.supervisor/disabled`.

2. Summarize concisely for the user. If they asked to turn the supervisor on/off,
   tell them: disable this session with
   `echo "$(cat .supervisor/current_session)" >> .supervisor/disabled`, re-enable by
   removing that line.
