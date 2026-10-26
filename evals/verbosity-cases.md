# Verbosity calibration corpus

Mined from real Claude Code session logs (`~/.claude/projects/**/*.jsonl`), files
touched in roughly the last 14-17 days, 20 distinct projects, 2026-07-02 through
2026-07-18. No synthetic rows — every row is a real assistant turn from a real
session, and every `human_followup` is the human's actual next message.

## Counts

- **200 rows total** — 110 `terse` / 90 `verbose` (55% / 45%, inside the requested band).
- **16 rows are gold (`source:"human_complaint"`)** — the human's very next message
  is a real, on-topic complaint about style/length. All 16 are labeled `verbose`;
  there is no such thing as a gold *terse* label (nobody complains that a reply
  was too short).
- **184 rows are `heuristic`**: 110 short accepted replies (`terse`) and 74 long
  uncomplained-about replies (`verbose`), selected by prose word count since no
  human reaction signals verbosity either way for these.
- Of ~19 regex hits on complaint language, 4 were manually thrown out as false
  positives (e.g. "too long" about a slash-command's *name*, "plain english"
  as a style note for a *future* deliverable, one rate-limit notice misfiled as
  a reply) — kept precision over count on the highest-value rows.
- We deliberately did **not** sample the 61-179 prose-word "gray zone" — the task
  asked to oversample the two extremes, so this corpus has no evidence either way
  about whether medium-length replies draw complaints.

## Offense frequency (verbose rows only, n=90; terse rows are always `[]`)

| offense | count |
|---|---|
| hedging | 7 |
| buried_conclusion | 4 |
| self_narration | 3 |
| filler_opener | 2 |
| praise | 2 |
| qualifier_stack | 2 |
| apology | 0 |
| restates_question | 0 |
| summarizes_own_work | 0 |
| wall_of_text | 0 |

Notably sparse: most of the 90 verbose rows (roughly two-thirds) trigger **no**
offense tag at all. Real verbose replies in this corpus aren't padded with
classic "AI assistant" tics (hedging, apologizing, self-narrating) — they're
verbose because they're long and thorough (big tables, multi-section reports,
exhaustive detail), not because of stock filler phrases. A detector built only
around phrase-matching those tics will miss most of what actually annoys this
user; length/structure signals matter more than lexical tics here.

## Prose word-count distribution (code fences/inline code stripped before counting)

| bucket | n | p50 | p90 | min | max |
|---|---|---|---|---|---|
| verbose — human_complaint (gold) | 16 | 248 | 487 | **9** | 501 |
| verbose — heuristic (long, no complaint) | 74 | 249 | 433 | 180 | 1194 |
| verbose — ALL | 90 | 248 | 433 | 9 | 1194 |
| terse — heuristic (short, accepted) | 110 | 38 | 55 | 0 | 60 |

## Does raw length separate the classes? Mostly, but not cleanly — say so plainly

At the aggregate level length looks like a great signal: gold-verbose p50 (248
words) is ~6.5x the terse p50 (38 words), and terse tops out at 60 words by
construction. A naive `word_count > 150` threshold would catch 14 of the 16
gold complaints (87.5%).

But it would **miss 2 of 16 real complaints outright** — both under 60 words,
squarely inside the "normal terse" range:

- `id=e71acd2ee581`, 9 words: *"Unchanged. Still waiting on your explicit
  go-ahead before merging."* → human replied *"plain english please."*
- `id=b0da5536684e`, 58 words: a short status update → human replied *"too
  long. too much fluff. i have to be able to read and understand this in 1m."*

Both are genuine, on-topic style complaints on replies that are objectively
short. That's a 12.5% false-negative rate for a pure length gate on the gold
set alone, and it's real signal, not noise: people complain about density and
jargon, not just line count. **Length should be one input to the detector, not
the detector.** Given the sparse offense-tag hits above, the more promising
signal for a "plainspeak" plugin is probably structural/jargon density (short
reply, but dense/unclear phrasing) combined with length for the genuinely long
cases — not a single word-count cutoff.

Caveat on the flip side: because the heuristic-verbose (74) and heuristic-terse
(110) buckets were themselves *selected* by a word-count cutoff (≥180 / ≤60),
their separation is tautological by construction and shouldn't be read as
independent evidence. The only non-circular test here is the gold-vs-terse
comparison above, and it's the one that shows the crack in a pure-length
approach.
