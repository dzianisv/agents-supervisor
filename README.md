# agents-supervisor

A dataset-backed **supervisor** for coding agents. It watches for the agent
stopping **prematurely** — asking permission for work it could just do, listing
"next steps" then halting, or stalling mid-task — and re-prompts it to finish.
Always-on, low-risk (it approves legitimate stops and waits), and it learns from
your own sessions.

> Successor to the (now archived) [dzianisv/opencode-plugins](https://github.com/dzianisv/opencode-plugins) reflection plugin.

## Quick Start

### Claude Code

**From GitHub (no clone needed):**
```sh
claude plugin marketplace add https://github.com/dzianisv/agents-supervisor
claude plugin install supervisor@agents-supervisor
```

**From a local clone:**
```sh
git clone https://github.com/dzianisv/agents-supervisor
claude plugin marketplace add ./agents-supervisor
claude plugin install supervisor@agents-supervisor
```

The `Stop` hook is active in the next session. Verify:
```sh
claude plugin list   # should show: supervisor@agents-supervisor  ✔ enabled
```

### OpenCode

**From GitHub (no clone needed):**

Add to `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["github:dzianisv/agents-supervisor/opencode/supervisor.ts"] }
```

**From a local clone:**
```sh
git clone https://github.com/dzianisv/agents-supervisor
```
Add to `~/.config/opencode/opencode.json`:
```json
{ "plugin": ["file:///path/to/agents-supervisor/opencode/supervisor.ts"] }
```

Then inside an OpenCode session:
```
/supervisor          # status
/supervisor autopilot   # keep going on every idle
/supervisor goal <condition>   # stop only when condition is met
```

Works on two runtimes from one shared core:

| Runtime | Mechanism | Surface |
|---|---|---|
| **Claude Code** | `Stop` hook (`bin/on-stop.mjs`) | plugin + `/supervisor:train`, `/supervisor:status`, `/supervisor:goal`, `/supervisor:retry` |
| **OpenCode** | `session.idle` event (`opencode/supervisor.ts`) | tools `supervisor`, `set_supervisor`, `supervisor_train`, `supervisor_goal`, `supervisor_retry`, `supervisor_autopilot`, `autopilot_exit` + `/supervisor`, `/supervisor:train` |

The classification taxonomy (6 categories + mined anti-patterns) and its feedback
templates live in a single source of truth, [`core/patterns.json`](core/patterns.json),
so both runtimes — and the trainer — share one brain.

## Supervisor modes

OpenCode exposes three public supervisor modes:

| Mode | Command | Behavior |
|---|---|---|
| `reflection` | `/supervisor reflection` | Default. Runs the normal completion judge on idle. |
| `goal` | `/supervisor goal <condition>` | Adds a mandatory completion condition and keeps pushing until it is met or the retry budget runs out. |
| `autopilot` | `/supervisor autopilot` | Skips the judge and continues on every idle until `autopilot_exit` or budget exhaustion. |

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

## Autopilot mode (OpenCode)

Autopilot is a lightweight autonomous mode: the supervisor **skips the judge
entirely** and re-prompts the agent on every idle until it explicitly signals
completion. No evaluation overhead, no latency from judge round-trips — just a
prescriptive nudge to keep working.

```
/supervisor autopilot          # enable
/supervisor reflection         # disable, return to default mode
```

Or call the tools directly (web app / API):
- `supervisor_autopilot` — toggle on/off (`enabled: true | false`)
- `autopilot_exit` — the agent calls this when work is genuinely complete

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
