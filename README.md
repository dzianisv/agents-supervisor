# agents-supervisor

A dataset-backed **supervisor** for coding agents. It watches for the agent
stopping **prematurely** — asking permission for work it could just do, listing
"next steps" then halting, or stalling mid-task — and re-prompts it to finish.
Always-on, low-risk (it approves legitimate stops and waits), and it learns from
your own sessions.

> Successor to the (now archived) [dzianisv/opencode-plugins](https://github.com/dzianisv/opencode-plugins) reflection plugin.

Works on two runtimes from one shared core:

| Runtime | Mechanism | Colon commands | Additional |
|---|---|---|---|
| **Claude Code** | `Stop` hook (`bin/on-stop.mjs`) | `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, `/supervisor:reflection` | — |
| **OpenCode** | `session.idle` event (`opencode/supervisor.ts`) | `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, `/supervisor:reflection` | bare `/supervisor <subcommand>` dispatcher |

The classification taxonomy (6 categories + mined anti-patterns) and its feedback
templates live in a single source of truth, [`core/patterns.json`](core/patterns.json),
so both runtimes — and the trainer — share one brain.

## Quickstart (1 minute)

### Claude Code

Run in your terminal:
```sh
claude plugin marketplace add dzianisv/agents-supervisor
claude plugin install supervisor@agents-supervisor
```
The `Stop` hook is active in the next session. Verify:
```sh
claude plugin list   # should show: supervisor@agents-supervisor  ✔ enabled
```

Then, inside any Claude Code session, use any of these commands:
- `/supervisor:status` — effective patterns + recent verdicts
- `/supervisor:train` — learn from your sessions (updates your local patterns)
- `/supervisor:goal <condition>` — set a mandatory completion condition; agent continues until goal is met or budget exhausts
- `/supervisor:retry N` — set the retry budget (1–100, default 16)
- `/supervisor:autopilot` — skip the judge, auto-continue on every idle until `AUTOPILOT_EXIT` or budget exhaustion
- `/supervisor:reflection` — return to default completion-judge mode
- `/supervisor:on` — re-enable for this session
- `/supervisor:off` — disable for this session

> **Slash commands vs CLI:** `claude plugin ...` runs from your terminal; `/plugin ...` is the equivalent inside an active Claude Code session. Both work — use whichever fits your context.

**Local dev install** (clone first, then):
```sh
claude plugin marketplace add /path/to/agents-supervisor
claude plugin install supervisor@agents-supervisor
```

**Switch off / on:**
```sh
# whole plugin (all sessions) — run in terminal
claude plugin disable supervisor@agents-supervisor
claude plugin enable  supervisor@agents-supervisor
```

Inside an active Claude Code session:
- `/supervisor:off` — disable for this session
- `/supervisor:on` — re-enable for this session

### OpenCode
Add to `opencode.json`:
```json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-supervisor"] }
```
or drop `opencode/supervisor.ts` into `~/.config/opencode/plugin/`. Then, use the same colon-command set as Claude Code:
- `/supervisor:status` — effective patterns + recent verdicts
- `/supervisor:train` — learn from your sessions
- `/supervisor:goal <condition>` — set a mandatory completion condition
- `/supervisor:retry N` — set the retry budget (1–100)
- `/supervisor:autopilot` — skip the judge, auto-continue until exit or budget exhaustion
- `/supervisor:reflection` — return to default completion-judge mode
- `/supervisor:on` — re-enable for this session
- `/supervisor:off` — disable for this session

OpenCode also supports a bare `/supervisor <subcommand>` dispatcher as an alternative:
- `/supervisor status`
- `/supervisor autopilot`
- `/supervisor goal <condition>`
- `/supervisor reflection`
- `/supervisor on`
- `/supervisor off`
- (note: in the web app, use the tool names directly; file commands don't expand in the web UI)

**Switch off / on:**
```
/supervisor off     # disable for this session
/supervisor on      # re-enable
```
Whole plugin off: remove `"opencode-supervisor"` from `opencode.json`, or launch with `opencode --pure`.

## Supervisor modes (both runtimes)

The supervisor has three public modes, available on both Claude Code and OpenCode:

| Mode | Command | Behavior |
|---|---|---|
| `reflection` | `/supervisor:reflection` | Default. Runs the normal completion judge on idle. |
| `goal` | `/supervisor:goal <condition>` | Adds a mandatory completion condition and keeps pushing until it is met or the retry budget runs out. |
| `autopilot` | `/supervisor:autopilot` | Skips the judge and continues on every idle until `AUTOPILOT_EXIT` is called or budget exhaustion. |

The effective default mode is `reflection`.

## Goal mode (both runtimes)

Beyond catching premature stops, you can point the supervisor at a **goal** it must
demonstrably meet before it lets the agent stop — it keeps re-prompting (up to a
retry budget) until the goal's met or the budget runs out.

```
/supervisor goal all tests in test/auth pass and the PR is open with green CI
/supervisor goal clear
/supervisor retry 24           # set this session's retry budget (1–100, default 16)
```

The goal is injected into the judge as a **mandatory completion requirement** — the
agent is not allowed to stop until the goal is met (or the budget exhausts). While a
goal is active the retry budget rises to 16 (vs 3 normally). State is per-session at
`.supervisor/goals/<sessionId>.json` (mode 0600); budget is spent only when a
continuation actually fires.

In the web app call the `supervisor_goal` / `supervisor_retry` tools directly.

**Configurable rubric (OpenCode):** drop a `.supervisor/rubric.md` (or
`~/.config/opencode/supervisor/rubric.md`) with `## Patterns` / `## Antipatterns`
sections to override the judge's rubric; otherwise the shipped default is used.
(Claude Code reads its rubric from `core/patterns.json` ⊕ your user-local patterns.)

## Autopilot mode (both runtimes)

Autopilot is a lightweight autonomous mode: the supervisor **skips the judge
entirely** and re-prompts the agent on every idle until it explicitly signals
completion. No evaluation overhead, no latency from judge round-trips — just a
prescriptive nudge to keep working.

**Claude Code:**
```
/supervisor:autopilot          # enable
/supervisor:reflection         # disable, return to default mode
```

**OpenCode (colon-command or dispatcher):**
```
/supervisor:autopilot  # or: /supervisor autopilot
/supervisor:reflection # or: /supervisor reflection
```

For web app / OpenCode API, call tools directly:
- `supervisor_autopilot` — toggle on/off (`enabled: true | false`)
- `autopilot_exit` — the agent calls this when work is genuinely complete

**Autopilot semantics:**
- Agent continues on every idle **unconditionally** (no judge evaluation)
- Judge is **bypassed entirely** — no latency from scoring/reflection
- Agent must call `AUTOPILOT_EXIT` to signal work is complete
- Or the supervisor stops if the retry budget exhausts (default 16, configurable via `/supervisor:retry N`)
- Safety rails still apply: attempt budget, loop detection

**How it differs from the goal loop:**

| | Goal loop | Autopilot |
|---|---|---|
| Judge evaluation | Yes (self-assessment + optional cross-model) | No (skipped entirely) |
| Continuation trigger | Judge says "not done" | Every idle (unconditional) |
| Stop condition | Goal met or budget exhausted | Agent calls `autopilot_exit` or budget exhausted |
| Latency per cycle | 5–15s (judge round-trip) | <1s (direct nudge) |

**Safety rails still apply** — even in autopilot mode:
- **Attempt budget**: stops at `maxAttempts` (default 16, configurable via `/supervisor retry N`)
- **Planning loop detection**: catches agents that read files endlessly without writing code
- **Action loop detection**: catches agents repeating the same commands 3+ times

State is per-session at `.supervisor/goals/<sessionId>.json`. When the budget
exhausts, autopilot disables itself automatically.

## How it decides

A judge LLM classifies each stop into one of:
`complete`, `waiting_for_user_legitimate`, `tool_available_punt`,
`summary_drift_stop`, `genuinely_stuck`, `working`. Only the middle three inject a
continuation nudge (escalating over up to 3 attempts); the rest are left alone.
The anti-pattern rules that sharpen these (permission-seeking, stopped-with-todos,
false-complete, legitimate-stop) were mined from real agent stops where the user
had to reply.

## `/supervisor:train` — learn from your sessions

```
/supervisor:train                 # mine last 14d, update your local patterns
/supervisor:train --since=30d
/supervisor:train --dry-run       # preview the pattern diff, write nothing
/supervisor:train --push-hf       # also archive the private dataset to HuggingFace
```

It mines `agent stopped → user followed up` pairs from your OpenCode DBs and Claude
transcripts, derives refreshed anti-pattern weights + provenance, and writes them to
your **user-local** patterns file:

```
~/.config/agents-supervisor/patterns.json   # learned overrides (deep-merged over shipped)
```

Guarantees:
- **Never commits** to this repo / upstream — learning is user-side only.
- **Dataset stays private** — mined data lands in `.dataset/` (git-ignored) and,
  with `--push-hf`, a **private** HuggingFace dataset repo
  (`$SUPERVISOR_HF_DATASET`, default `dzianisv/agent-supervisor-stops`). Never in git.
- A `.bak` of the prior patterns is kept; revert with the printed command.

First `--push-hf` run needs `hf auth login` and `pip install -U huggingface_hub`.

## Pattern resolution

`core/patterns.mjs` deep-merges, later overriding earlier:
1. shipped `core/patterns.json` (read-only defaults)
2. `~/.config/agents-supervisor/patterns.json` (user, written by train)
3. `<project>/.supervisor/patterns.json` (project, `--scope=project`)

## Develop / test

```
npm test            # unit tests (core + hook + train derivation), node:test
npm run test:cc     # Claude Code end-to-end (real claude -p, no mocks)
npm run eval        # OpenCode judge eval (promptfoo)
```

## License

MIT © dzianisv
