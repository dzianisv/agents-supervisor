## User journeys

### Which mode do I use?
- No specific target, just keep going: **autopilot** — skips the judge, nudges every idle.
- Concrete finish line ("tests pass and PR is open"): **goal** — `/supervisor:set-goal <condition>` (Claude Code), `/supervisor:goal <condition>` (OpenCode).
- Default, catch premature/lazy stops: **reflection** — already on, no command needed.
- Turn it off for this session: `/supervisor:off` (resume with `/supervisor:on`).

### Core loop
```
Stop event -> judge (skipped in autopilot) -> inject feedback if incomplete -> agent continues -> exits on AUTOPILOT_EXIT / goal achieved / budget exhausted
```

---

### 1. Install & enable — Claude Code
1. `claude plugin marketplace add https://github.com/dzianisv/agents-supervisor && claude plugin install supervisor@agents-supervisor`
2. Local clone: `git clone https://github.com/dzianisv/agents-supervisor && claude plugin marketplace add ./agents-supervisor && claude plugin install supervisor@agents-supervisor`
3. Takes effect in your *next* session, not the one you installed in. Verify with `claude plugin list` → `supervisor@agents-supervisor ✔ enabled`.
4. **Caveat:** if a project's `.claude/settings.json` also declares a `Stop` hook, the judge fires twice per stop and burns the attempt budget 2x as fast. `.claude/settings.json` should have no `Stop` entry — the plugin is the only source.
5. Disable everywhere: `claude plugin disable supervisor@agents-supervisor` (`enable` to resume).

### 2. Install & enable — OpenCode
1. Add to `~/.config/opencode/opencode.json`: `"plugin": ["github:dzianisv/agents-supervisor/opencode/supervisor.ts"]`
2. Local clone: use `"file:///path/to/agents-supervisor/opencode/supervisor.ts"` instead.
3. Restart the OpenCode session.
4. Verify: `/supervisor:status` — reports mode, retry budget, disabled state.
5. Disable: remove the `plugin` entry from `opencode.json`, or run `opencode --pure`.

### 3. First run
1. Nothing to configure — reflection mode is on by default.
2. A legitimate stop is silent. An incomplete stop injects a "Task Incomplete" block.
3. Customize the judge by adding files under `.agents/supervisor/`: `SystemPrompt.md`, `Patterns.md`, `User.md`, `Goal.md`. None exist by default — the plugin falls back to shipped defaults.

### 4. Autopilot mode
1. Enable: `/supervisor:autopilot`.
2. Judge is skipped entirely; every stop gets a static "keep going" nudge — no loop or progress detection decides anything here.
3. End the loop: output `AUTOPILOT_EXIT` alone on a line (Claude Code), or call the `autopilot_exit` tool (OpenCode).
4. The only hard stop is the attempt budget (default 16, `/supervisor:retry N`, range 1–100). Read/write tool-call counts may appear in the nudge as informational context but never trigger or block a stop.
5. Return to normal: `/supervisor:reflection`.
6. Use it for unattended work where you trust the agent to self-police and want no judge latency.

### 5. Goal mode
1. Set a goal — Claude Code: `/supervisor:set-goal <condition>`. OpenCode: `/supervisor:goal <condition>`.
2. **No condition + nothing set:** OpenCode's `/supervisor:goal` attempts an LLM-derived, falsifiable goal from the session transcript and reports it, or explains why it couldn't (no model available, or the draft wasn't concrete enough) — it never fabricates one. Claude Code's CLI has no LLM call wired in for this: running `supervisor goal` with no argument only reports the current session/project goal status; you must set a condition explicitly.
3. The condition becomes a mandatory completion requirement in the judge prompt.
4. Retry budget rises to 16 while a goal is active (vs. 3 in plain reflection); tune with `/supervisor:retry N` (1–100).
5. Each stop, the judge scores progress and transitions the goal: `exhausted` (cap/deadline hit) → `achieved` (judge says complete) → `continue`.
6. A persistent project-level goal can also live in `.agents/supervisor/Goal.md` (or the derived `goal.md`) — picked up automatically, survives across sessions.

### 6. Reflection mode (default)
1. On by default; `/supervisor:reflection` returns to it from autopilot/goal and clears any active goal.
2. Override judge behavior with `.agents/supervisor/Patterns.md`, `User.md`, `SystemPrompt.md`, optionally `Goal.md`.
3. Each stop, the judge classifies it as `complete | waiting_for_user_legitimate | tool_available_punt | summary_drift_stop | genuinely_stuck | working`. Only the middle three push back.
4. Default retry budget: 3 attempts, configurable via `/supervisor:retry N`.
5. The judge's own verdict is the sole authority on completion/progress. Recent tool-call activity (read vs. write counts) may be surfaced to the judge as non-binding, informational context — it never substitutes for or overrides the judge's verdict.

### 7. Attempt budget / exhaustion
1. One consistent "Task Incomplete (severity)" message fires on each failed attempt — no escalating "final attempt" wording, ever.
2. When the cap is reached, the hook exits quietly — no message, just the agent's last reply. An active goal is marked `exhausted`; active autopilot turns off automatically.
3. There is no separate scripted "loop detected" stop message. Tool-activity telemetry is descriptive only and feeds into the judge/autopilot nudge as context, not as an independent verdict.

### 8. Disable / opt-out
1. This session only: `/supervisor:off`. Re-enable: `/supervisor:on`.
2. Everywhere: `claude plugin disable supervisor@agents-supervisor` (Claude Code) or remove the plugin entry / `opencode --pure` (OpenCode).
3. Check state: `/supervisor:status`.

### 9. Multi-task sessions
1. The attempt counter auto-resets whenever a new, genuine user message arrives in the same long-running session — no manual reset needed.
2. An autonomous loop with no new human input (goal/autopilot chaining) keeps accumulating on the same task; it only resets on genuinely new input.

### 10. Read-only / research tasks
1. Task type is inferred from the request (`coding | docs | research | ops | other`); evidence gates (tests/build/PR/CI) are heuristic, not hard requirements.
2. Pure Q&A or research tasks are not flagged for missing tests/PR, and don't trip a "start coding now" nudge just for heavy reading.

<!-- PLACEHOLDER: Plainspeak journey — companion hook (bin/plainspeak-on-stop.mjs), registered alongside the supervisor Stop hook. Insert the verified compact Plainspeak journey from the companion agent here as section 11. Do not fill in from this pass — not independently verified in this session. -->
