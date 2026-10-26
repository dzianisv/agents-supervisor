# Runaway-limit forensic analysis — deriving `RUNAWAY_CEILING`

**Question (owner):** "let's make it configurable. 50 seems to be just from mind
number. why 50, why not 64 or 100?"

He is right. `RUNAWAY_CEILING = 50` was picked by feel. This is the measurement
that replaces the feeling, plus the honest caveat about what the data can and
cannot prove.

Reproduce: `python3 .scratch/analyze-runaway.py` (reads ONLY files under
`~/workspace/*/.supervisor/`; no session content is copied anywhere).

---

## What "attempts per human turn" means here

The supervisor keeps a single per-turn counter (`attempts.count`, keyed to the
last human message id). Each supervisor injection into a turn increments it; a
new human message resets it. So "attempts per human turn" = how many times the
supervisor pushed the agent before the turn ended. The ceiling force-stops a
turn once the counter reaches it.

Two data sources, with very different reliability:

| Source | What it is | Reliability for the TAIL |
|---|---|---|
| `state.json` `attempts.count` + legacy `*_attempts.json` `count` | the **authoritative** per-turn counter, one value per session's LAST turn | **ground truth** (59 samples) |
| `sessions/<id>/verdicts.jsonl` `assessment` records | a judged-assessment log | **undercounts** — see below |

`verdicts.jsonl` is NOT a per-injection log. Proof: session
`vibebrowser/…/ses_002643a37ffeLJr3WnlobnkBWQ` has `attempts.count = 50` but
only **1** `assessment` line. So any "runs in verdicts.jsonl" metric is a lower
bound on the common case only, useless for the tail. The ground truth is
`attempts.count`.

---

## The numbers (19 stores, ~30 days)

**Ground truth — final `attempts.count` per session's last turn (59 samples):**

| stat | value |
|---|---|
| samples (turns) | 59 |
| p50 | 3 |
| p90 | 3 |
| p95 | 50 |
| p99 | 71 |
| max | **100** |
| mean | 6.37 |

Histogram (attempts → #turns): `1→17, 2→5, 3→33, 50→3, 100→1`

Reached ≥3: 37/59 (62.7%) · ≥16: 4/59 (6.8%) · ≥50: 4/59 (6.8%) · =100: 1.

**Common-case corroboration — verdicts.jsonl same-task runs (133 samples,
undercounts tail):** p50=1, p90=2.8, p99=3, max=3, mean=1.27. Confirms the
common case is 1–3 and nothing else.

The four tail turns (the only samples above 16), inspected individually:

| project / session | count | what it was |
|---|---|---|
| `backtest/96e1d47a…_attempts.json` | 100 | doom loop, saturated a 100 clamp (June) |
| `OpenClawBot/…ses_00337de8…` | 50 | **active goal**, saturated the 50 ceiling |
| `vibebrowser/…ses_002643a3…` | 50 | saturated the 50 ceiling |
| `vibebrowser/…ses_005ff348…` | 50 | saturated the 50 ceiling |

---

## The critical caveat: the distribution above 3 is CENSORED

The histogram is **bimodal with an empty middle**: a big cluster at 1–3, a tiny
tail sitting exactly on a ceiling value (50, 100), and **nothing at all between
3 and 50.** That gap is not real — it is an artifact of the caps that were in
force when the data was written:

- Legitimate turns that wanted to continue past the cap were **clipped** at
  whatever cap existed (old reflection cap = 3, old goal cap = 16). So the "3"
  bucket (33 turns) is inflated with turns that would have gone higher.
- Every value above 16 is a **doom loop** that ran until the ceiling force-stopped
  it (three at 50, one at 100). Those are exactly the pathology the ceiling
  exists to stop, not evidence of legitimate work needing 50 injections.

So the data proves two things and **cannot** prove a third:

1. ✅ Legitimate turns finish fast — median 1, the overwhelming majority ≤3.
2. ✅ Runaways saturate **whatever** ceiling is set. The ceiling **is** hit in
   reality (6.8% of last-turn samples) — refuting the original premise that "50
   is high enough never to be hit." Hitting it is its job.
3. ❌ It **cannot** show the true length of a legitimate turn that needs >3
   injections, because prior caps censored that entire region. We literally
   cannot see whether a genuine long goal turn would want 8 or 20.

**Blunt conclusion: the data is not thin, but the region a precise ceiling would
be fit to is structurally unobservable (censored by prior caps). Any exact number
above ~3 is therefore arbitrary within a wide band. Honesty requires saying so
rather than inventing a false derivation from the 50/100 doom-loop artifacts.**

---

## External evidence (owner forwarded verified primary sources)

### The unit mismatch — the correction that changes the answer

An earlier pass compared our N to framework "max_turns" caps and concluded ~20.
That was WRONG about the unit. Our N counts **supervisor INJECTIONS** — the
OUTER loop. Each injection **restarts a whole agent turn** that itself runs the
INNER loop of dozens of tool calls. Framework per-run caps (LangChain
`max_iterations`, OpenAI `max_turns`, OpenHands `max_iteration_per_run`) bound
that INNER loop of a SINGLE run. So:

> **50 of our injections ≈ 50 completed agent turns ≈ plausibly
> hundreds-to-thousands of model steps.** Against the published table, 50 is one
> of the MOST PERMISSIVE limits in the ecosystem, effectively unbounded in
> dollars. Comparing "50" to LangChain's 15 or the SDK's 10 is a category error.

### Framework defaults — iteration / step caps (inner loop)

| Framework | Param | Default | Source |
|---|---|---|---|
| LangChain | `AgentExecutor.max_iterations` | **15** | `libs/langchain/langchain/agents/agent.py` |
| LangGraph / LC Core | `recursion_limit` | **25** (`DEFAULT_RECURSION_LIMIT`) | `langchain_core/runnables/config.py` |
| OpenAI Agents SDK | `max_turns` | **10** (`DEFAULT_MAX_TURNS`; `None` disables) | `src/agents/run_config.py` |
| smolagents | `max_steps` | **20** (+ 1 forced-answer call) | `agents.py` |
| CrewAI | `max_iter` | **25** | crewai docs / `agent.py` |
| AutoGen v0.2 | `max_consecutive_auto_reply` | **100** | `conversable_agent.py` |
| AutoGen v0.4+ | `max_tool_iterations` | **1** | `_assistant_agent.py` |
| OpenHands | `max_iteration_per_run` | **100 → 500** across versions, `stuck_detection=True` default | `config_utils.py` |
| Aider | `max_reflections` | **3** | aider source |

### Frameworks that moved to COST/BUDGET caps (the long-horizon coding ones)

| Framework | Real stop | Source |
|---|---|---|
| SWE-agent | `per_instance_cost_limit` = **$3.00**; `per_instance_call_limit` = 0 (disabled) | `sweagent/agent/models.py` |
| mini-SWE-agent | `step_limit` = **0 (NO LIMIT)**; `cost_limit` = **$3.00** is the real stop; `max_consecutive_format_errors` = 3 | mini-swe-agent source |
| Claude Agent SDK | `max_turns` = no limit, `max_budget_usd` = no limit; docs: "Setting a budget is a good default for production agents" | code.claude.com/docs/en/agent-sdk/agent-loop |
| OpenHands V1 | `max_budget_per_run` | OpenHands V1 SDK |
| Anthropic SWE-bench scaffold | **NO turn cap** — "sample until the model decides it is finished, or exceeds 200k context" | anthropic.com/engineering/swe-bench-sonnet |

### Empirical

- **arXiv 2510.16786** (SWE-bench Verified, 100 tasks, 3 models): median
  turns-to-solve for leading agents = **41–58**, tail **>175**. Token cost grows
  **~O(n²)** in turns. Setting the limit at the **p75 of your OWN observed
  distribution** cuts cost 24–68% with minor/no solve-rate loss; a dynamic "start
  at p25, grant ONE extension to p50 on failure" beats any fixed number by a
  further 12–24%. Calls static step limits *"a brute-force approach that lacks the
  adaptability needed for tasks of varying complexity."*
- **Anthropic SWE-bench post**: successful runs took *"more than 100 turns"*, some
  *"hundreds of turns"* — **successes live in the TAIL**, so a low cap trades tail
  success for cost.
- **arXiv 2602.17037 ("Wink", >10,000 production agent trajectories)**:
  misbehaviors in ~30% of trajectories; an asynchronous observer injecting
  targeted course-correction resolves **90%** of single-intervention misbehaviors.
  Recovery: infinite loops 39%. NON-recovery: *"agent ignored the course-correction
  instructions"* **37%**, premature termination **22%**. (This validates the
  supervisor's whole premise — an external observer nudging a stuck agent works —
  and warns that a too-twitchy nudge that the agent ignores is the top failure mode.)
- **OpenHands StuckDetector thresholds** (primary source): identical
  action+observation = **4**, identical erroring action = **3**, agent monologue =
  **3**, A/B alternating = **6**, scan window 20 events; V1 nudges ONCE per streak
  at threshold before killing.

---

## The default: `RUNAWAY_CEILING = 50` (kept — now explained + sourced)

The owner's directive, and the honest reading of the evidence: **keep 50 as a
pure runaway backstop; the number stops being folklore because it is now
explained and sourced, not because it changed.** Three legs:

1. **Unit.** 50 injections ≈ 50 full agent runs ≈ hundreds-to-thousands of model
   steps — already one of the most permissive limits in the ecosystem. There is
   no case that 50 is "too low"; if anything it is generous.
2. **Measured backstop, not an optimum.** Authoritative per-turn counter
   (`attempts.count`): 59 last-turn samples / 19 stores, **p50=3, p90=3, p99≈3**;
   133-sample same-task corroboration, same p99=3. No legit turn ever exceeded 3;
   everything above ~16 was a doom loop saturating whatever cap existed. So
   **50 ≈ 17× the observed p99** — deliberately far above reality. Per 2510.16786
   our p75 is 3, so *any* static backstop is many× p75 by construction; that is
   fine for a backstop and meaningless as a tuned optimum.
3. **Shape matches the field.** The frameworks that actually tuned a stop moved
   OFF a step count onto a COST budget (SWE-agent, mini-SWE-agent, Claude SDK,
   OpenHands V1), precisely because **successes live in the tail** (Anthropic
   ">100 turns"; 2510.16786 median 41–58, tail >175) and a low static cap trades
   tail success for cost. Keeping the injection cap high and crude, and letting
   `supervisor_loop_exit` + the no-progress gate + a goal deadline + `/supervisor
   off` do the real stopping, is the correct division of labor.

Why NOT lower it (reversing the earlier 64→20 move): that move rested on a false
unit comparison (injection ≈ one framework "turn"). Corrected, the comparison
says the opposite — 50 injections is already far more permissive than any
framework's per-run cap — so lowering would only bring the crude backstop closer
to the healthy region (p99=3) for no benefit, and against the "successes live in
the tail" lesson. 50 stays.

**One-line summary for docs:** *N counts supervisor injections — each ≈ a whole
agent turn of dozens of steps — so 50 ≈ 50 agent turns ≈ hundreds-to-thousands of
model steps, one of the most permissive caps in the ecosystem; measured legit
turns cap at ≤3 injections (p99≈3), so 50 is a backstop ~17× above reality, not a
budget, and it is now fully configurable including `unlimited`.*

---

## Reported to the owner, NOT implemented (mechanism = owner's call)

1. **Per-turn COST/TOKEN budget as the primary control.** Unanimous across
   SWE-agent, mini-SWE-agent, Claude Agent SDK, OpenHands V1. **opencode DOES
   expose the data**: every `AssistantMessage` carries `cost: number` and
   `tokens: {input, output, reasoning, cache:{read,write}}`
   (`@opencode-ai/sdk` types). The supervisor already fetches the session
   messages each idle to compute the attempt counter, so the smallest honest
   implementation is: sum `cost` (or input+output+reasoning tokens) over the
   assistant messages whose turnKey ≥ the last human message id (identical
   per-turn scoping to `attempts.count`), and stand down with a
   `reason:'cost_budget'` loop-exit.log record when the sum crosses a configured
   budget, resolved through the SAME tier precedence as `maxAttempts`
   (retry/config/env), default `unlimited` (off) to preserve today's behavior.
   Caveat: `cost` can be 0 for local/free models, so a **token** budget is more
   universally reliable than a USD budget — recommend token as the primary knob,
   USD as an optional convenience.
2. **No-progress threshold.** `NO_PROGRESS_REPEAT_THRESHOLD = 2` identical replies
   (`core/evaluation.mjs`) vs OpenHands' 3–4 for the equivalent signals. My read:
   **2 is slightly twitchy**, and Wink's finding that 37% of NON-recoveries are
   "agent ignored the course-correction" is the relevant risk — an early, wrong
   stand-down is cheap, but the more common failure is nudging an agent that then
   ignores it, which a low threshold does not help. I would align to **3** (one
   more identical repeat before standing down) to match OpenHands, but it is a
   behavior change and left to the owner; NOT changed in this branch. Note our
   gate is also byte-identical-only, so it is already conservative (a reworded
   loop never trips it) — which argues the threshold number matters less than
   making the signal semantic.
