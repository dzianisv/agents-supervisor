---
license: cc-by-4.0
language:
- en
task_categories:
- text-classification
tags:
- llm-eval
- agent-stops
- prompt-engineering
- claude-code
- opencode
- supervisor
- snapshot
size_categories:
- 1K<n<10K
pretty_name: agents-supervisor sessions snapshot — 2026-05
---

# agents-supervisor sessions snapshot — 2026-05

Larger companion to
[`mrfennec/agents-supervisor-gold-v3`](https://huggingface.co/datasets/mrfennec/agents-supervisor-gold-v3).
Around 1,200 real coding-agent stops mined from one user's Claude Code +
OpenCode sessions, classified end-to-end by the agents-supervisor v3
judge (Claude Haiku 4.5).

**This is NOT a gold set.** Labels are produced by an LLM judge, not by
human auditors. Use for prompt-tuning, error analysis, and pattern
mining — not as a reference for absolute model accuracy. For audited
labels, use `agents-supervisor-gold-v3`.

## What's in it

**Combined distribution** (1194 records, CC + OC, classified by v3 judge):

| label                        | count | %    |
|------------------------------|------:|-----:|
| `complete`                   |  570  | 48%  |
| `summary_drift_stop`         |  197  | 16%  |
| `tool_available_punt`        |  188  | 16%  |
| `working`                    |  123  | 10%  |
| `genuinely_stuck`            |   49  |  4%  |
| `waiting_for_user_legitimate`|   67  |  6%  |

CC slice: 731 records; OC slice: 463 records.

**Known classifier surprise:** the v3 prompt explicitly says `working` is
rare at Stop boundaries, yet the bulk classifier emitted it for ~10% of
records. Spot-checks show this is over-firing on terse acknowledgements
like `"Ignored."` — the prompt rule is correct but Haiku 4.5 is not
honouring it at scale. Treat any `working` label here with suspicion; in
`agents-supervisor-gold-v3` (human-audited) `working` does not appear.

- **Window:** mined May 25–26 2026 from `~/.claude/projects/**/*.jsonl`
  (~793 transcripts) and `~/.local/share/opencode/opencode.db` (~727
  sessions). All sessions from a single user, Q1–Q2 2026.

- **Snapshot ID:** 2026-05 (the slug salt is randomised per-export, so
  this snapshot's `proj-<hash>` labels are NOT comparable to later snapshots).

## Schema

Each line is a JSON object. Flat schema:

```json
{
  "project_slug": "proj-a4b2c1d8",
  "session_id": "<uuid>",
  "timestamp": "2026-05-12T14:33:00.000Z",
  "stop_index": 7,
  "session_total_turns": 24,
  "prior_tool_uses_count": 18,
  "user_messages": ["..."],
  "final_assistant_text": "...",
  "tools_available_inferred": ["Bash", "Read", "Edit"],
  "heuristic_tags": ["hint:summary_drift"],   // CC only
  "classification": {
    "category": "summary_drift_stop",
    "reason": "...",
    "confidence": 0.85
  }
}
```

- `project_slug` is a salted sha256 hash (8 chars). Same project across
  records → same slug. Cross-snapshot the salt is different.
- `session_id` is a UUID — random, safe to keep.
- `timestamp` is absolute ISO 8601.

## Labels

Same 6-category taxonomy as gold-v3. See
[`core/patterns.json` in agents-supervisor](https://github.com/dzianisv/agents-supervisor/blob/main/core/patterns.json).

`tool_available_punt` and `working` not observed in this snapshot.

## How it was built

1. Mining: `evals/scripts/mine-cc-stops.mjs` + `mine-oc-stops.mjs`
   (in archived `dzianisv/opencode-plugins`).
2. Classification: agents-supervisor v3 judge
   (`core/judge-core.mjs` + `core/patterns.json` at commit `3dbd6b4`) via
   the Anthropic API. Cost: ~$3 in Haiku 4.5 input tokens.
3. Redaction (this snapshot):
   - **Pass 1 (mining):** OAuth tokens, API keys (`sk-ant-*`, `ghp_*`,
     `gho_*`, `AKIA*`, JWT-shaped), Bearer / x-api-key headers, email
     addresses, `github.com/<owner>/<repo>` slugs, `/home/<real>/` paths.
   - **Pass 2 (HF export, `train/hf_export.mjs`):** project identifiers
     → opaque labels (`<proj-a..p>`), user handle stripped, IPv4
     addresses → `<ip>` (except 127.0.0.1, 0.0.0.0, 169.254.169.254),
     generic `/home/<user>/` normalisation, `project_slug` → salted
     sha256 hash, `classification.reason` redacted too.

A post-pass leak scan checks for: original project name leaks (`dzianisv`,
`paperclip`, `openclaw`, `vibebrowser`, `clawhub`, `skills.sh`,
`beadaholique`), real IPv4s, real homedirs, GitHub personal owners.

## Usage

```python
from datasets import load_dataset
ds = load_dataset("mrfennec/agents-supervisor-sessions-2026-05", split="train")
print(ds[0])
```

Re-classify a subset with a different prompt:

```bash
git clone https://github.com/dzianisv/agents-supervisor
cd agents-supervisor
ANTHROPIC_API_KEY=sk-ant-... \
  node evals/scripts/classify-with-supervisor-v3.mjs \
    --in <subset.jsonl> --out <subset-myversion.jsonl>
```

## Limitations

- **Single user.** Patterns reflect one developer's style.
- **LLM labels, not human gold.** Use gold-v3 (57 records, audited) for
  ground truth.
- **Two categories absent.** `tool_available_punt` and `working`. If
  you're tuning those, mine your own data.
- **Claude assistant text only.** No GPT / Gemini / etc.

## Citation

```
@misc{agents-supervisor-sessions-2026-05,
  title  = {agents-supervisor sessions snapshot — 2026-05},
  author = {dzianisv},
  year   = {2026},
  url    = {https://huggingface.co/datasets/mrfennec/agents-supervisor-sessions-2026-05}
}
```

## License

- **Labels + dataset structure:** CC-BY-4.0
- **Assistant text:** Generated by Claude (Anthropic). Use bound by
  Anthropic's terms. Do NOT use this dataset to train models that
  compete with Anthropic services.
