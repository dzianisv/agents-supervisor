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
- `/supervisor:set-goal <condition>` — set a mandatory completion condition; agent continues until the goal is met (the per-turn attempt counter resets each human turn)
- `/supervisor:set-goal resume` — resume a `paused` or `exhausted` goal (keeps the same condition, resets this turn's attempt counter)
- `/supervisor:retry N` — tune the runaway safety valve (any positive integer, honoured verbatim; `0`/`unlimited` removes the cap; default **20**, reduced to 7 on Claude Code — see the platform-cap note). This is NOT a budget you are meant to spend — see "The stop mechanism" below.
- `/supervisor:autopilot` — skip the judge, auto-continue on every idle until `SUPERVISOR_LOOP_EXIT: completed`
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
- `/supervisor:set-goal resume` — resume a `paused` or `exhausted` goal
- `/supervisor:retry N` — tune the runaway safety valve (any positive integer, or `unlimited`/`0` for no cap; default **20**)
- `/supervisor:autopilot` — skip the judge, auto-continue until the agent exits or the runaway valve trips
- `/supervisor:reflection` — return to default completion-judge mode
- `/supervisor:on` — re-enable for this session
- `/supervisor:off` — disable for this session
- `/supervisor autoreview on` / `off` — toggle cross-model review of completion verdicts

OpenCode also supports a bare `/supervisor <subcommand>` dispatcher as an alternative:
- `/supervisor status`
- `/supervisor autopilot`
- `/supervisor set-goal <condition>`
- `/supervisor set-goal resume`
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

The supervisor has **two** public modes, available on both Claude Code and OpenCode:

| Mode | Command | Behavior |
|---|---|---|
| `reflection` | `/supervisor:reflection` | Default. Runs the normal completion judge on idle. If a goal is set, the judge grades against the goal too. |
| `autopilot` | `/supervisor:autopilot` | Skips the judge and continues on every idle until the agent declares `supervisor_loop_exit` (OpenCode tool) / `SUPERVISOR_LOOP_EXIT: completed` (Claude Code sentinel) or the runaway valve trips. If a goal is set, its condition rides along as context on the nudge — **but autopilot never verifies it** (see below). |

The effective default mode is `reflection`.

**A goal is not a mode.** A goal is an orthogonal session *attribute* — you can set
one in either mode (see "Goals" below). It changes what each mode does with it, not
which mode you are in.

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

## Goals (both runtimes)

Beyond catching premature stops, you can point the supervisor at a **goal** it must
demonstrably meet before it lets the agent stop — it keeps re-prompting until the
goal's met. A goal is a session **attribute**, not a mode: setting one puts the
session in `reflection` (the mode that verifies it) and keeps it there.

```
/supervisor:set-goal all tests in test/auth pass and the PR is open with green CI
/supervisor:retry 24           # tune the runaway valve (any positive int; unlimited/0 = no cap)
```

> **In autopilot, a goal is context, not a verified condition.** Autopilot never
> runs the judge, so it cannot check a goal — when a goal is set in autopilot its
> condition is merely appended to the auto-continue nudge as context for the agent.
> If you want the goal actually *checked* before the agent may stop, use
> `reflection` mode (the default, and where `set-goal` leaves you). This is a
> deliberate trade: autopilot trades the goal guarantee for never paying for a
> judge round-trip.

**The retry budget is per human turn, not per session.** It bounds how many times
the supervisor may re-prompt inside one unbroken turn; the moment you send another
message, the budget resets and the goal keeps driving. Spending the budget stands
the supervisor down for the rest of that turn and hands control back to you — it
does not end the goal. Only the judge confirming the condition is met, or an
explicit `/supervisor:set-goal clear`, truly END a goal (deleted from disk). Two
other things stand it down without deleting it — the agent declaring itself
`stuck` (`supervisor_loop_exit`), or the 30-day deadline backstop (see
`DEFAULT_MAX_GOAL_DURATION_MS`) — and both leave it `paused`/`exhausted` with the
condition intact rather than a dead end: resume either with
`/supervisor:set-goal resume`, which flips it back to `active`, clears the stale
pause reason, and gives it a fresh attempt budget (and a fresh 30-day window if
the old deadline had already passed). `/supervisor:status` (and the OpenCode
`supervisor` tool's status text) always reports a paused/exhausted goal honestly,
with the reason and the resume hint — never silently as if it were still active.

This used to be a separate `solofounder` mode. It isn't any more — those semantics
are the default when a goal is set, and `solofounder` survives only as a skill
(`skills/solofounder/`) that arms a goal with a revenue done-bar.

The command is deliberately named `/supervisor:set-goal` on **both** runtimes,
never `/supervisor:goal` — Claude Code ships its own native `/goal` command and
this plugin must not shadow or be confused with it, and one name across runtimes
beats a per-runtime split. The two are different features: the native `/goal` is
evaluated by your configured small fast model with no retry-budget or
pattern/rubric injection; `/supervisor:set-goal` is this plugin's judge-driven
equivalent, sharing state and retry budget with the rest of the supervisor.

Internal identifiers keep the `goal` name (`core/goal.mjs`, the `supervisor_goal`
tool, the on-disk state schema) — those are never typed by a human, so renaming
them would only add migration risk. The retired `goal` *mode* value is still
accepted as a deprecated input alias (it maps to `reflection` and keeps the goal)
so stale skills and installed command files do not hard-error.

Beyond the per-session goal above, a project-level goal can also persist across
sessions — see "Project goals (`Goal.md`)" below.

The goal is injected into the judge as a **mandatory completion requirement** — the
agent is not allowed to stop until the goal is met. The intended stop is the agent's
own `supervisor_loop_exit` (OpenCode) / `SUPERVISOR_LOOP_EXIT:` sentinel (Claude
Code); a per-turn attempt counter exists only as a **runaway safety valve** (default
`RUNAWAY_CEILING = 20`, the same in every mode — there are no per-mode defaults). On
Claude Code the Stop hook reduces that to 7 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` minus
one), so 20 means 7 effective there. State is per-session at
`.supervisor/sessions/<sessionId>/state.json` (mode 0600); the counter is spent only
when a continuation actually fires, and it resets on each new human turn.

> **Why 20?** It is not folklore — it is derived from two independent directions
> that agree. **Internal:** a 30-day forensic sample of real sessions on the
> author's machine (192 per-turn samples across 19 projects) shows legitimate
> turns cluster at **≤3 injections** (p50=3, p90=3); everything above ~16 is a
> doom loop that saturated whatever cap was in force, and the region between is
> **censored** by the old caps, so the healthy number is ≤3 and the true tail is
> unobservable. **External:** the frameworks that count our exact unit — a
> supervisor re-injection ≈ one full agent *turn* — cap at ~10 (OpenAI Agents SDK
> `max_turns=10`, AutoGen v0.2 `GroupChat.max_round=10`) or ship the turn cap OFF
> and bound cost instead (Claude Agent SDK `max_turns=None`, SWE-agent
> `$3`/instance); self-correction research (Self-Refine ≤4 rounds; Reflexion
> plateaus; Huang et al., arXiv 2310.01798 — intrinsic self-correction can
> *degrade* without new feedback) says the payoff is front-loaded to a few rounds.
> **20 = 2× the ~10-turn framework norm** (one doubling of headroom above the
> industry cap) and ~6–7× the measured healthy median of 3 — the top of the
> evidence-supported safety-valve band (~10–20; nothing above ~25 has support in
> any framework default). It bounds only the *cost* of a loop that never declares
> an exit (~20 judge calls, ~7 min at ~20s each); the real stop is
> `supervisor_loop_exit`, then the no-progress gate, a goal deadline, and
> `/supervisor off`. (The same evidence says a fixed iteration cap is the *wrong
> primary* stop — favor no-progress + cost budgets — so this is a deliberate
> backstop, not a claim that the count is the right stop.) Full write-up with
> source URLs: `.scratch/runaway-limit-analysis.md`.

**Making it configurable.** The valve is resolved by ONE shared function
(`describeRunawayLimit`, `core/goal.mjs`), used by both runtimes, with this
precedence (first parseable value wins):

| Tier | Surface | Spelling |
|---|---|---|
| 1. session override | `/supervisor:retry N` (CLI) / `supervisor_retry` tool `n` (OpenCode) | positive int, or `0`/`unlimited`/`off`/`none` |
| 2. config file | `maxAttempts:` in `~/.config/opencode/supervisor.yaml` | positive int, or `unlimited`/`off`/`none`/`0` |
| 3. env | `SUPERVISOR_MAX_ATTEMPTS` (or legacy `REFLECTION_CC_MAX_ATTEMPTS`) | positive int, or `unlimited`/`off`/`none`/`0` |
| 4. default | — | `20` |

```yaml
# ~/.config/opencode/supervisor.yaml
maxAttempts: 128         # any positive integer, honoured verbatim (no upper clamp)
# maxAttempts: unlimited # or off / none / 0 — remove the cap entirely
```

- **No silent rewriting.** A positive integer you type is honoured verbatim —
  there is no upper clamp. An out-of-range value (negative, fractional,
  non-numeric) is **rejected** at the CLI/tool with a message naming the
  accepted range, and **ignored with a debug warning** in the config file
  (falling through to the next tier) — it is never quietly changed to something
  else.
- **`unlimited` (= `0`/`off`/`none`) means no attempt cap at all.** The loop is
  then bounded only by the agent's own `supervisor_loop_exit`, the no-progress
  gate, a goal deadline, and `/supervisor off`. This is a deliberate operator
  choice, so it is honoured — and made **visible**: `/supervisor:status` reports
  it plainly and the debug log records it once per turn, so an unbounded session
  is never a surprise.
- **Claude Code cannot honour `unlimited`.** Its Stop hook is physically capped
  by the platform at `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP - 1` (currently **7**).
  When the resolved limit is reduced by that cap — especially when you asked for
  `unlimited` — `/supervisor:status` and the debug log say so explicitly, naming
  the cap and that Claude Code, not the supervisor, imposes it.

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
- `supervisor_loop_exit` — the agent calls this with `reason: 'completed'` when work is genuinely complete

**Autopilot semantics:**
- Agent continues on every idle **unconditionally** (no judge evaluation)
- Judge is **bypassed entirely** — no latency from scoring/reflection
- Agent must call `supervisor_loop_exit` (OpenCode) / output `SUPERVISOR_LOOP_EXIT: completed` alone on its own line (Claude Code) to signal work is complete
- Or the supervisor's runaway safety valve trips (default 20, 7 on Claude Code, or `unlimited`; tune via `/supervisor:retry N`)
- Safety rails still apply: attempt budget, destructive-action flagging

**How it differs from the goal loop:**

| | Goal loop | Autopilot |
|---|---|---|
| Judge evaluation | Yes (self-assessment + optional cross-model) | No (skipped entirely) |
| Continuation trigger | Judge says "not done" | Every idle (unconditional) |
| Stop condition | Goal met (or 30-day deadline) | Agent calls `supervisor_loop_exit` / outputs `SUPERVISOR_LOOP_EXIT: completed`, or the runaway valve trips |
| Latency per cycle | 5–15s (judge round-trip) | <1s (direct nudge) |

**Safety rails still apply** — even in autopilot mode:
- **Runaway safety valve**: a last-resort breaker that trips at the runaway limit (default 20, 7 on Claude Code, or `unlimited` for no cap; tune via `/supervisor retry N`) — NOT a budget the agent is meant to spend; the intended stop is `supervisor_loop_exit`
- **Destructive-action flagging**: force-push, hard reset, history rewrite, branch deletion, `rm -rf`, and unapproved spend are flagged to the user for approval instead of being nudged
- **Tool-activity telemetry**: a bounded, non-binding note (read/write tool-call counts) may be appended to the nudge as factual context — it never itself decides completion or emits a stop verdict

State is per-session at `.supervisor/sessions/<sessionId>/state.json`. When the runaway
valve trips, autopilot disables itself automatically.

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
regardless. To keep the supervisor's own runaway handling (runaway-ceiling reached,
goal-exhausted) firing deterministically instead of being silently pre-empted by
CC, the Stop hook clamps its runaway safety valve to
`min(runawayLimit, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP - 1)`, where
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` mirrors CC's own override threshold (default
**8**; the hook always stays one under it) and can be overridden via env var if
you raise CC's limit or a future CC version changes it. There are **no per-mode
defaults**: reflection, goal mode, and autopilot all share the same runaway limit
(default 20), which CC then reduces to 7 within any single unbroken turn — the limit
still spans multiple turns, it just can't all be spent in one uninterrupted block
chain, since CC itself wouldn't honor that many. If you set the limit to
`unlimited`, Claude Code still reduces it to 7 (it physically cannot honour an
uncapped Stop hook) and says so in `/supervisor:status` and the debug log.

The counter is also scoped **per turn**: it resets whenever a new, genuine
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

## Plainspeak (both runtimes)

Catches a fluffy final reply and asks for a rewrite instead of letting it stand.
Same detector (`core/verbosity.mjs`) on both runtimes; different amounts of it.

| | Claude Code | OpenCode |
|---|---|---|
| Entry point | second Stop hook (`bin/plainspeak-on-stop.mjs`) | the `session.idle` handler, after the supervisor stands down |
| Detection | deterministic + LLM tiebreak on `suspect` | **deterministic only** — fires on `verdict === 'verbose'`, treats `suspect` as terse |
| Extra model call | yes, on ambiguous replies | **never** |
| Toggle | `.plainspeak/disabled`, `PLAINSPEAK_DISABLED=1` | `/supervisor:plain off` (default ON) |

The opencode path is deterministic on purpose: `buildStylePrompt` is
intentionally unused there, because a network round-trip and a flaky model call
do not belong on the idle path for what is only a style nudge.

Detection is two-stage (Claude Code):
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

### `/supervisor:plain` (OpenCode)

```
/supervisor:plain          # read-only status (alias of /supervisor)
/supervisor:plain off      # stop injecting rewrite directives
/supervisor:plain on       # re-enable
```

ON by default; `off` is the only thing that disables it — absent/undefined both
mean on, so sessions predating the flag keep the feature. State lives next to
the other per-session flags in `.supervisor/sessions/<id>/state.json`, and
`plainspeak: on|off` is reported by `/supervisor`.

On OpenCode it only ever fires on a turn where **the supervisor itself decided
to stand down** (task complete, human action required, actionless verdict,
empty rendered feedback) — and never if the status-checkpoint correction fired,
so a turn gets at most one chore injection. It is suppressed entirely in
subagent sessions, judge sessions, autopilot mode, while a goal is active, on
`/supervisor …` control turns, and when the supervisor is disabled. It never
touches the attempt budget. Injected messages lead with
`<!-- supervisor:plainspeak -->`.

Safety rails:
- **Never fights supervisor.** Defers if a supervisor goal/autopilot is
  active, and again if `.supervisor/sessions/<session_id>/verdicts.jsonl` shows
  supervisor just blocked this same turn. Finishing the work beats polishing
  the prose.
- **One rewrite per turn.** Hard cap, persisted — under `.plainspeak/` on
  Claude Code, as `lastPlainTurnKey` in the session state on OpenCode (keyed by
  the same turn key the attempt budget uses). A second pass on the same turn is
  always silent. That is the whole termination proof.
- **Never mid-work.** A trailing question to the user exits silently — style
  is judged only on a final delivered reply.
- **Fails open.** Any error, timeout, or missing auth exits silently. A broken
  judge never blocks a turn.
- Kill switch: `.plainspeak/disabled` or `PLAINSPEAK_DISABLED=1`.

## Develop / test

```
npm test                 # unit tests (core + hook + train derivation), node:test
npm run test:e2e         # OpenCode plugin end-to-end (real `opencode serve`) — must pass before commit
npm run test:cc          # Claude Code end-to-end (real claude -p, no mocks)
npm run eval             # OpenCode judge eval (promptfoo)
npm run eval:plainspeak  # plainspeak detector eval (default: verbosity-cases.example.jsonl; --cases for the private corpus)
```

## License

MIT © dzianisv
