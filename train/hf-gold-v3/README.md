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
size_categories:
- n<1K
pretty_name: agents-supervisor gold v3 — premature-stop classifier eval set
---

# agents-supervisor gold v3 — premature-stop classifier eval set

57 audited, redacted examples of how coding-agent sessions END a turn —
labeled with the 6-category taxonomy used by
[`dzianisv/agents-supervisor`](https://github.com/dzianisv/agents-supervisor)
to decide whether the agent stopped prematurely and should be re-prompted.

**This is an evaluation dataset, not a training corpus.** Assistant text is
Claude-generated and remains subject to Anthropic's terms of service. The
labels (gold classifications) are released under CC-BY-4.0.

## What's in it

- **57 records** across 4 categories actually observed in the source sessions
  (`tool_available_punt` and `working` are present in the taxonomy but did
  not appear in this slice — see Limitations):

  | label                        | count |
  |------------------------------|-------|
  | `complete`                   | 28    |
  | `waiting_for_user_legitimate`| 14    |
  | `summary_drift_stop`         | 8     |
  | `genuinely_stuck`            | 7     |

- **Origin split:** 30 from Claude Code (`~/.claude/projects/**/*.jsonl`)
  + 27 from OpenCode (`~/.local/share/opencode/opencode.db`), all from a
  single user's sessions in Q1–Q2 2026.

## Schema

Each line is a JSON object:

```json
{
  "name": "cc-01-complete",
  "expected": "complete",
  "ctx": {
    "user_messages": ["..."],
    "final_assistant_text": "...",
    "tools_available_inferred": ["Bash", "Read", "Edit", "WebFetch"]
  }
}
```

## Labels

| category | inject? | meaning |
|---|---|---|
| `complete` | no | task delivered with evidence |
| `waiting_for_user_legitimate` | no | needs OAuth / 2FA / human decision |
| `tool_available_punt` | yes | agent asked when its tools could answer |
| `summary_drift_stop` | yes | wrote a "next step" plan and stopped |
| `genuinely_stuck` | yes | halted mid-thought, no closure |
| `working` | no | rare — explicit mid-action |

Full definitions: [`core/patterns.json` in agents-supervisor](https://github.com/dzianisv/agents-supervisor/blob/main/core/patterns.json).

## Redaction

Two passes were applied to every record:

**Pass 1 (at audit time):** OAuth tokens, API keys (sk-ant-*, ghp_*, gho_*,
AKIA*, JWT-shaped), Bearer/x-api-key headers, email addresses,
`/home/<real-name>/` paths, `github.com/<owner>/<repo>` slugs.

**Pass 2 (HF export):** Project identifiers mapped to opaque labels
(`<proj-a>` through `<proj-p>`), user handle stripped, IPv4 addresses
replaced with `<ip>` except `127.0.0.1` / `0.0.0.0` / `169.254.169.254`,
generic homedir normalised to `/home/<user>`.

A spot-check after both passes confirms zero hits on the leak-pattern
grep set: `dzianisv|paperclip|openclaw|vibebrowser|clawhub|skills\.sh|
beadaholique|whoisdzianisvm|dzianisvs|<real-IP>|/home/<real-name>/`.

**Residual fingerprinting risk:** generic vendor names (Anthropic, GitHub,
Tailscale, Hetzner, HubSpot, Vercel, Linear, Stripe, Cloudflare) are kept
in place because the classifier needs realistic tool/service context.
The combination of vendors is itself identifying. If you mirror or
republish this dataset, please cite the source.

## Usage

```python
from datasets import load_dataset
ds = load_dataset("dzianisv/agents-supervisor-gold-v3", split="train")
print(ds[0])
```

To run it against the agents-supervisor judge:

```bash
git clone https://github.com/dzianisv/agents-supervisor
cd agents-supervisor
ANTHROPIC_API_KEY=sk-ant-... node evals/judge-eval.mjs \
  --cases /path/to/this/train.jsonl --threshold 0.7
```

Baseline (v3 prompt, Haiku 4.5): **70.2% accuracy on this set**.

## Limitations

- **Small.** 57 records, single user. Generalises to other users' sessions
  poorly. Useful for *regression* on prompt edits, not for absolute
  accuracy claims.
- **Two categories absent.** `tool_available_punt` and `working` were not
  observed in this user's stops. If you're tuning those, you'll need to
  mine your own data — see [`train/`](https://github.com/dzianisv/agents-supervisor/tree/main/train)
  in the repo.
- **Label convention matters.** "Want me to update the doc?" is labeled
  `waiting_for_user_legitimate` in 4 of these records but
  agents-supervisor v3 classifies them as `tool_available_punt` when
  tools were available. Convention-adjusted accuracy is ~82%. Don't
  treat 70% as the ceiling.
- **Claude-only.** All assistant text is from Claude (Haiku, Sonnet, Opus
  4.5–4.7 era). Other models stop differently.

## Citation

```
@misc{agents-supervisor-gold-v3,
  title  = {agents-supervisor gold v3: premature-stop classifier eval set},
  author = {dzianisv},
  year   = {2026},
  url    = {https://huggingface.co/datasets/dzianisv/agents-supervisor-gold-v3}
}
```

## License

- **Labels + dataset structure:** CC-BY-4.0
- **Assistant text:** Generated by Claude (Anthropic). Use bound by
  Anthropic's terms. Do NOT use this dataset to train models that compete
  with Anthropic services.
