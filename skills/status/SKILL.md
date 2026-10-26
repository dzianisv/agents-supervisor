---
name: status
description: Show supervisor status — effective patterns, where learned overrides live, recent stop verdicts, and whether the session is disabled. Use for "/supervisor:status", "supervisor status", "what patterns is the supervisor using", "is the supervisor on".
---

# /supervisor:status — inspect the supervisor

Report the current supervisor state for this project.

## Steps

1. Run the status reporter:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" status "${ARGUMENTS}"
   ```

   Empty arguments inspect state. `on`/`off` toggles only the default-off
   status/roadmap directive, never the supervisor enable axis.

   It prints:
   - Goal-based supervisor, actual goal status/condition/source, acceptance
     criteria, verification and paused/exhausted resume hint.
   - Effective runaway valve, tier, and Claude Code platform reduction.
   - Effective pattern source layering (shipped ⊕ user-config ⊕ project) and which
     files are actually present.
   - Category list + inject categories currently in effect.
   - Pattern provenance (dataset size / premature %).
   - Recent verdicts from `.supervisor/sessions/<id>/verdicts.jsonl` (last few,
     newest first across sessions), with category + whether an inject fired.
   - Which session id it resolved and WHERE that id came from.
   - Whether that session id is in `.supervisor/disabled`.

2. Summarize concisely for the user. If they asked to turn the supervisor on/off,
   tell them: `/supervisor:off` to disable this session, `/supervisor:on` to re-enable.
   For the whole plugin: `claude plugin disable supervisor@agents-supervisor`.
