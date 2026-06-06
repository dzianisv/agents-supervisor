Task done when:

1. **Claude Code**: install `supervisor` plugin from the repo marketplace, run a `claude -p`
   session that stops mid-task → the Stop hook injects supervisor feedback (observed in
   `.supervisor/verdict_*.json` and the re-prompt). Then `/supervisor:train` runs and
   `~/.config/agents-supervisor/patterns.json` is created/updated (diff shown).

2. **OpenCode**: `opencode/supervisor.ts` loads; a `session.idle` on an incomplete task
   triggers a supervisor continuation; the `supervisor_train` tool updates user-local patterns.

3. **Evals**: `npm test` green (unit, both runtimes); `npm run eval` (OpenCode promptfoo) and
   `npm run test:cc` (Claude e2e) meet threshold.

4. **Privacy**: `git ls-files | grep -E '\.dataset|\.jsonl$|transcripts'` returns empty —
   no mined data committed; dataset lives only locally + private HuggingFace.
