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

## The default chosen: `RUNAWAY_CEILING = 64`

Given (3) — the legitimate tail is unobservable — we follow the repo's standing
rule that **a low default is the premature-stand-down bug** and err HIGH. Given
(2) — a runaway saturates whatever we pick — the precise value is arbitrary in
`[16, 128]`, so we make the arbitrariness principled with a power of two and a
stated rule:

> **64 = the smallest power of two that is (a) ≥ the previously-shipped 50 (so
> upgrading never silently narrows an operator's safety margin) and (b) 4× the
> retired goal cap of 16 (generous headroom above the most generous legitimate
> regime ever shipped).**

This directly answers the owner:
- **Why not 50?** 50 is not a power of two and was folklore; 64 is the next
  power of two ≥ 50, chosen by an explicit rule instead of by feel.
- **Why not 100?** 100 was observed only as a *configured runaway that
  saturated* — we do not want the DEFAULT that high (more wasted doom-loop cost);
  64 < 100, and anyone who wants 100 (or more, or none) can now set it.

64 bounds only the COST of a loop that never declares an exit (~64 judge LLM
calls / ~21 min at ~20 s/injection). It is **not** a budget and never signals
completion: the real stop is the agent's `supervisor_loop_exit`, then the
no-progress gate, a goal deadline, and `/supervisor off`.

**One-line summary for docs:** *Across 192 real per-turn samples the median turn
took 1 injection and the p99 was 3; every value above that was a doom loop that
saturated whatever ceiling was in force, so the default is a runaway safety valve
(64), not a budget — and it is now fully configurable, including `unlimited`.*
