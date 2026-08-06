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
/supervisor set-goal <condition>   # stop only when condition is met
```

Works on two runtimes from one shared core:

| Runtime | Mechanism | Colon commands | Additional |
|---|---|---|---|
| **Claude Code** | `Stop` hook (`bin/supervisor-on-stop.mjs`) | `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:set-goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, `/supervisor:reflection` | — |
| **OpenCode** | `session.idle` event (`opencode/supervisor.ts`) | `/supervisor:status`, `/supervisor:on`, `/supervisor:off`, `/supervisor:set-goal`, `/supervisor:retry`, `/supervisor:train`, `/supervisor:autopilot`, `/supervisor:reflection` | bare `/supervisor <subcommand>` dispatcher |

The classification taxonomy (6 categories + mined anti-patterns) and its feedback
templates live in a single source of truth, [`core/patterns.json`](core/patterns.json),
so both runtimes — and the trainer — share one brain.

## Commands

### Claude Code

Inside any Claude Code session, use any of these commands:
- `/supervisor:status` — effective patterns + recent verdicts
- `/supervisor:train` — learn from your sessions (updates your local patterns)
- `/supervisor:set-goal <condition>` — set a mandatory completion condition; agent continues until the goal is met (budget resets each human turn)
- `/supervisor:retry N` — set the per-turn retry budget (1–100, default 16)
- `/supervisor:autopilot` — skip the judge, auto-continue on every idle until `AUTOPILOT_EXIT` or budget exhaustion
- `/supervisor:reflection` — return to default completion-judge mode
- `/supervisor:on` — re-enable for this session
- `/supervisor:off` — disable for this session

> **Slash commands vs CLI:** `claude plugin ...` runs from your terminal; `/plugin ...` is the equivalent inside an active Claude Code session. Both work — use whichever fits your context.

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

Use the same colon-command set as Claude Code:
- `/supervisor:status` — effective patterns + recent verdicts
- `/supervisor:train` — learn from your sessions
- `/supervisor:set-goal <condition>` — set a mandatory completion condition
- `/supervisor:retry N` — set the retry budget (1–100)
- `/supervisor:autopilot` — skip the judge, auto-continue until exit or budget exhaustion
- `/supervisor:reflection` — return to default completion-judge mode
- `/supervisor:on` — re-enable for this session
- `/supervisor:off` — disable for this session
- `/supervisor autoreview on` / `off` — toggle cross-model review of completion verdicts

OpenCode also supports a bare `/supervisor <subcommand>` dispatcher as an alternative:
- `/supervisor status`
- `/supervisor autopilot`
- `/supervisor set-goal <condition>`
- `/supervisor reflection`
- `/supervisor on`
- `/supervisor off`
- (note: in the web app, use the tool names directly; file commands don't expand in the web UI)

**Switch off / on:**
```
/supervisor off     # disable for this session
/supervisor on      # re-enable
```
Whole plugin off: remove the plugin entry from `opencode.json`, or launch with `opencode --pure`.

## Supervisor modes (both runtimes)

The supervisor has three public modes, available on both Claude Code and OpenCode:

| Mode | Command | Behavior |
|---|---|---|
| `reflection` | `/supervisor:reflection` | Default. Runs the normal completion judge on idle. |
| `goal` | `/supervisor:set-goal <condition>` | Adds a mandatory completion condition and keeps pushing until it is met. The retry budget bounds one human turn, then resets when you speak again. |
| `autopilot` | `/supervisor:autopilot` | Skips the judge and continues on every idle until `AUTOPILOT_EXIT` is called or budget exhaustion. |

The effective default mode is `reflection`.

## Where the supervisor does NOT run (OpenCode)

The supervisor skips a session entirely when any of these hold:

| Gate | Why |
|---|---|
| Judge/self-assessment session | It would supervise its own judge. |
| Plan mode | Planning is not work-in-progress. |
| **Delegated subagent session** (`parentID` set) | The "user" is a scoped delegation prompt, not a human. Supervising these pushed read-only audit subagents to open PRs and pull credentials, and produced 66% of all injections in a 30-day sample. |
| Session listed in `.supervisor/disabled` | `/supervisor off`. |

To restore the old behaviour and supervise delegated subagents too, add this to
`~/.config/opencode/supervisor.yaml`:

```yaml
superviseSubagents: true
```

Turning the supervisor off for the current session is independent of mode:

```
/supervisor off      # disables; verified by reading the flag back
/supervisor on       # re-enables
```

The `off`/`on` action always wins over any `mode` argument sent in the same
call, and the tool reports an explicit `FAILED …` string rather than a success
message if the change did not persist.

## Goal mode (both runtimes)

Beyond catching premature stops, you can point the supervisor at a **goal** it must
demonstrably meet before it lets the agent stop — it keeps re-prompting until the
goal's met.

```
/supervisor:set-goal all tests in test/auth pass and the PR is open with green CI
/supervisor:retry 24           # set this turn's retry budget (1–100, default 16)
```

**The retry budget is per human turn, not per session.** It bounds how many times
the supervisor may re-prompt inside one unbroken turn; the moment you send another
message, the budget resets and the goal keeps driving. Spending the budget stands
the supervisor down for the rest of that turn and hands control back to you — it
does not end the goal. Only two things end a goal: the judge confirming the
condition is met, or the 30-day deadline backstop (see
`DEFAULT_MAX_GOAL_DURATION_MS`). Clear one early with `/supervisor:set-goal clear`.

This used to be a separate `solofounder` mode. It isn't any more — those semantics
are goal mode's default, and `solofounder` survives only as a skill
(`skills/solofounder/`) that arms a goal with a revenue done-bar.

The command is deliberately named `/supervisor:set-goal` on **both** runtimes,
never `/supervisor:goal` — Claude Code ships its own native `/goal` command and
this plugin must not shadow or be confused with it, and one name across runtimes
beats a per-runtime split. The two are different features: the native `/goal` is
evaluated by your configured small fast model with no retry-budget or
pattern/rubric injection; `/supervisor:set-goal` is this plugin's judge-driven
equivalent, sharing state and retry budget with the rest of the supervisor.

Internal identifiers keep the `goal` name (`core/goal.mjs`, the `supervisor_goal`
tool, the `goal` mode value, the on-disk state schema) — those are never typed by
a human, so renaming them would only add migration risk.

Beyond the per-session goal above, a project-level goal can also persist across
sessions — see "Project goals (`Goal.md`)" below.

The goal is injected into the judge as a **mandatory completion requirement** — the
agent is not allowed to stop until the goal is met. While a goal is active the retry
budget rises to 16 per human turn (vs 3 normally) — on Claude Code the Stop hook
clamps that to 7 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` minus one), so 16 requested
means 7 effective there. State is per-session at
`.supervisor/sessions/<sessionId>/state.json` (mode 0600); budget is spent only
when a continuation actually fires.

In the web app call the `supervisor_goal` / `supervisor_retry` tools directly.

**Cross-model autoreview (OpenCode):** off by default. When enabled with
`/supervisor autoreview on` (or the `supervisor_autoreview` tool), a second
model reviews the primary judge's completion verdict for blind spots before
the supervisor acts on it. Toggle off with `/supervisor autoreview off`; check
current state with `/supervisor autoreview` or `/supervisor` status.

**Configurable rubric (both runtimes):** the reflection prompt is built by one
shared module — `core/reflection-prompt.mjs` — for both Claude Code (Stop hook) and
OpenCode (session.idle). It reads `.agents/supervisor/{SystemPrompt,Patterns,User}.md`,
with a project's copy overriding the plugin's shipped defaults. To customize the
judge, edit those files: `Patterns.md` holds the `## Patterns` / `## Antipatterns`
rubric, `User.md` appends highest-precedence project overrides, and `SystemPrompt.md`
is the `{{variable}}` template. When no `SystemPrompt.md` is found anywhere, the
builder falls back to the embedded `buildSelfAssessmentPrompt` template in
`core/assessment.mjs`, whose `STATIC_RUBRIC` is kept byte-in-sync with the shipped
`Patterns.md`. (User-local pattern overlays via `.supervisor/patterns.json` remain
OpenCode-only for now.)

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
- Safety rails still apply: attempt budget, destructive-action flagging

**How it differs from the goal loop:**

| | Goal loop | Autopilot |
|---|---|---|
| Judge evaluation | Yes (self-assessment + optional cross-model) | No (skipped entirely) |
| Continuation trigger | Judge says "not done" | Every idle (unconditional) |
| Stop condition | Goal met (or 30-day deadline) | Agent calls `autopilot_exit` or budget exhausted |
| Latency per cycle | 5–15s (judge round-trip) | <1s (direct nudge) |

**Safety rails still apply** — even in autopilot mode:
- **Attempt budget**: stops at `maxAttempts` (default 16, configurable via `/supervisor retry N`)
- **Destructive-action flagging**: force-push, hard reset, history rewrite, branch deletion, `rm -rf`, and unapproved spend are flagged to the user for approval instead of being nudged
- **Tool-activity telemetry**: a bounded, non-binding note (read/write tool-call counts) may be appended to the nudge as factual context — it never itself decides completion or emits a stop verdict

State is per-session at `.supervisor/sessions/<sessionId>/state.json`. When the budget
exhausts, autopilot disables itself automatically.

## How it decides

A judge LLM classifies each stop into one of:
`complete`, `waiting_for_user_legitimate`, `tool_available_punt`,
`summary_drift_stop`, `genuinely_stuck`, `working`. Only the middle three inject a
continuation nudge (escalating over up to 3 attempts); the rest are left alone.
The anti-pattern rules that sharpen these (permission-seeking, stopped-with-todos,
false-complete, legitimate-stop) were mined from real agent stops where the user
had to reply.

### Claude Code: per-turn injection cap

Claude Code allows only **8 consecutive Stop-hook `{decision:'block'}` responses**
within one unbroken turn before it overrides the hook and lets the turn end
regardless. To keep the supervisor's own exhaustion handling (attempt-cap-reached,
goal-exhausted) firing deterministically instead of being silently pre-empted by
CC, the Stop hook caps its per-turn retry budget at
`min(effectiveMax, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP - 1)`, where
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` mirrors CC's own override threshold (default
**8**; the hook always stays one under it) and can be overridden via env var if
you raise CC's limit or a future CC version changes it. This applies uniformly to reflection (default budget 3, unaffected), goal
mode, and autopilot (default budget 16, tightened to 7 within any single unbroken
turn — the higher budget still spans multiple turns, it just can't all be spent in
one uninterrupted block chain, since CC itself wouldn't honor that many).

The retry budget is also scoped **per turn**: it resets whenever a new, genuine
user message arrives, and persists across Stop events that belong to the same
turn (e.g. a goal or autopilot loop running without new human input).

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

## Plainspeak (Claude Code only)

A second Stop hook. It catches a fluffy final reply and blocks with a rewrite
directive instead of letting it stand.

Detection is two-stage:
1. `scoreVerbosity` (deterministic, free) scores the reply against
   `core/style-rules.json` — filler openers, hedges, praise, apology,
   self-narration — plus a structural check (long, low-bullet, long-sentence
   prose). Below 40 prose words, it always exits silently: never fire on a
   short reply.
2. At or above that floor, a cheap model (`claude-haiku-4-5-20251001`,
   override with `PLAINSPEAK_MODEL`) judges what regex can't see: buried
   conclusions, restated questions, overcomplicated structure. A
   deterministically confirmed verbose verdict (a high-severity hit, e.g. a
   filler opener) skips the LLM call — it's already confirmed.

On confirmed verbose, it blocks with one directive: named offenses, one
corrective, same facts, fewer words. Nothing else.

`npm run eval:plainspeak` works out of the box, no credentials needed: it
defaults to a small committed synthetic smoke-test corpus,
`evals/verbosity-cases.example.jsonl` (8 rows, deterministic, no LLM calls).

Real numbers were reproduced against a private, gitignored corpus,
`evals/verbosity-cases.jsonl` (200 rows, 16 real human style complaints —
mined from real session logs, kept local, not committed): run
`npm run eval:plainspeak -- --cases evals/verbosity-cases.jsonl` (or
`node evals/plainspeak-eval.mjs --cases <path>`) with that file supplied
locally to reproduce them. Gold-complaint recall: 50%, 100% precision, 0 false
positives. Cost: an LLM call on 141 of 200 rows. Set
`PLAINSPEAK_STRICT_TERSE_EXIT=1` for the cheaper, blinder mode (skip the LLM
on any `terse` verdict, not just below-floor ones) — gold recall drops to
12.5%. Default trades LLM-call volume for catching real complaints, because on
this corpus the cheap mode misses seven of every eight.

Safety rails:
- **Never fights supervisor.** Defers if a supervisor goal/autopilot is
  active, and again if `.supervisor/sessions/<session_id>/verdicts.jsonl` shows
  supervisor just blocked this same turn. Finishing the work beats polishing
  the prose.
- **One rewrite per turn.** Hard cap, persisted under `.plainspeak/`. A second
  Stop for the same turn is always silent.
- **Never mid-work.** A trailing question to the user exits silently — style
  is judged only on a final delivered reply.
- **Fails open.** Any error, timeout, or missing auth exits silently. A broken
  judge never blocks a turn.
- Kill switch: `.plainspeak/disabled` or `PLAINSPEAK_DISABLED=1`.

## Develop / test

```
npm test                 # unit tests (core + hook + train derivation), node:test
npm run test:cc          # Claude Code end-to-end (real claude -p, no mocks)
npm run eval             # OpenCode judge eval (promptfoo)
npm run eval:plainspeak  # plainspeak detector eval (default: verbosity-cases.example.jsonl; --cases for the private corpus)
```

## License

MIT © dzianisv
