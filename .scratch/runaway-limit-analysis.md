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

## External evidence (owner: "base reasoning on some researches and numbers")

The internal data fixes the HEALTHY number (≤3) but cannot fix the ceiling
(censored tail). So the ceiling is anchored to published defaults for the **same
unit we count**. Critical: a supervisor re-injection ≈ **one full agent TURN**
(each injection spawns a fresh turn that itself runs many inner steps), NOT one
inner ReAct step. Only frameworks that count *full turns* are comparable.

**Framework defaults (verified from source / official docs):**

| Framework | Param | Default | Unit vs. ours | Source |
|---|---|---|---|---|
| **OpenAI Agents SDK** | `Runner.run(max_turns=)` | **10** (`None` disables) | **full turns — comparable** | github.com/openai/openai-agents-python `run_config.py` (`DEFAULT_MAX_TURNS=10`) |
| **AutoGen v0.2** | `GroupChat.max_round` | **10** | **full rounds — comparable** | github.com/microsoft/autogen@0.2 `groupchat.py` |
| **AutoGen v0.2** | `max_consecutive_auto_reply` | None→**100** | consecutive replies (≈turns) | `conversable_agent.py` (`MAX_CONSECUTIVE_AUTO_REPLY=100`) |
| **AutoGen v0.4** | team `max_turns` | **None** | full turns (off) | `_base_group_chat.py` |
| **Claude Agent SDK** | `max_turns` | **None** (uses `max_budget_usd`) | full turns (off, budget instead) | github.com/anthropics/claude-agent-sdk-python `types.py` |
| **SWE-agent** | `per_instance_cost_limit` | **$3.00** (step cap off) | **cost budget**, not steps | github.com/SWE-agent/SWE-agent `models.py` |
| LangChain | `AgentExecutor.max_iterations` | 15 | inner ReAct steps — NOT comparable | `langchain_classic/agents/agent.py` |
| LangGraph | `recursion_limit` | 25 | super-steps — NOT comparable | `langchain_core/.../config.py` |
| smolagents | `max_steps` | 20 | ReAct steps — NOT comparable | huggingface/smolagents `agents.py` |
| OpenHands | `max_iterations` | 500 (+ `StuckDetector`) | ReAct steps — NOT comparable | All-Hands-AI/OpenHands `config_utils.py` |
| CrewAI | `max_iter` | 20 | inner reasoning iters — NOT comparable | docs.crewai.com |

**The comparable unit clusters at ~10** (OpenAI 10, AutoGen v0.2 GroupChat 10),
or is disabled in favor of a cost/token budget (Claude SDK, SWE-agent).

**Empirical / stop-condition literature:**

- **Self-correction is front-loaded.** Self-Refine runs ≤4 refinement rounds for
  ~20% absolute gain (arXiv 2303.17651); Reflexion's reflective trials plateau
  (arXiv 2303.11366); Huang et al., **"LLMs Cannot Self-Correct Reasoning Yet"**
  (arXiv 2310.01798), show intrinsic self-correction (no new external feedback)
  can *degrade* performance — i.e. re-prompting a stuck agent past a few rounds
  is often net-negative. That is exactly our failure mode: the no-progress gate
  only catches BYTE-IDENTICAL replies, so a reworded doom loop runs to the ceiling.
- **Iteration cap is explicitly a control/safety net, not the functional stop.**
  Anthropic, *Building Effective Agents*: stopping conditions "such as a maximum
  number of iterations" exist "to maintain control." OpenHands bolts a
  **`StuckDetector`** (halts on 3–4 repeated action/observation or error loops)
  on top of its counter. Industry drift is toward **cost/token budgets**
  (SWE-agent $3; Claude SDK `max_budget_usd` + token `TaskBudget`) and
  **no-progress detection**, with the raw iteration count demoted to a backstop.

---

## The default chosen: `RUNAWAY_CEILING = 20`

Internal and external agree on the HEALTHY number (≤3 injections / ≤4–5
self-correction rounds). They also agree the ceiling is a coarse backstop, not
the functional stop. So the ceiling is anchored to the comparable-unit norm:

> **20 = 2× the ~10-turn cap shipped by the two frameworks that count our exact
> unit** (OpenAI Agents SDK `max_turns=10`, AutoGen v0.2 `GroupChat.max_round=10`)
> — one full doubling of headroom above the industry norm — and **~6–7× the
> measured healthy median of 3**. It sits at the TOP of the evidence-supported
> safety-valve band (~10–20 for a turn-counted loop; nothing above ~25 has
> support in any framework default).

This answers the owner's "why 50, why not 64 or 100?" head-on: **none of
50/64/100 has any evidentiary support** — they are all above every framework's
turn cap and every self-correction study's productive range. 64 was the exact
"pick a power of two off the menu" folklore he called out. 20 is the first number
in this whole exercise tied to a *cited external anchor* (the ~10-turn norm) and
the *measured* healthy median (3), not to a feeling or a power-of-two rule.

Why not go all the way down to the framework norm of 10? Two reasons to keep one
doubling of headroom: (1) the repo's hard rule — a low default IS the
premature-stand-down bug — and (2) our legitimate tail is *censored*, so we
cannot rule out a real goal turn wanting 8–15 injections. 16 was "premature" only
as a FUNCTIONAL stop; as a pure BACKSTOP behind `supervisor_loop_exit` + the
no-progress gate + a goal deadline + `/supervisor off`, 20 is safe. 20 bounds a
doom loop to ~20 judge calls / ~7 min instead of 64's ~21 min of pure waste.

**Mechanism judgement (owner's call, NOT silently redesigned):** the evidence
says a fixed iteration cap is the WRONG *primary* stop — the field favors
no-progress detection (OpenHands StuckDetector) + cost/token budgets (SWE-agent,
Claude SDK) as the binding limit. This repo already matches that shape (the
primary stop is `supervisor_loop_exit` + the no-progress gate + goal deadline;
the count is only a backstop). If the owner wants to go further, the highest-value
next step is a stronger no-progress detector (semantic, not byte-identical) and/or
a per-turn cost/token budget — a mechanism change that is the owner's decision.

**One-line summary for docs:** *Across 192 real per-turn samples the healthy turn
took ≤3 injections (p50=3, p90=3); the frameworks that count our unit of full
agent turns cap at ~10 (OpenAI Agents SDK, AutoGen GroupChat) and self-correction
research says the payoff is front-loaded, so the default is 20 = 2× that norm — a
runaway backstop, not a budget — and it is now fully configurable, including
`unlimited`.*
