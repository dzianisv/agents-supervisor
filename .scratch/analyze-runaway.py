#!/usr/bin/env python3
"""Measure injections-per-human-turn across all local .supervisor stores.

Reads ONLY files under `.supervisor/` directories. Does not copy session
content anywhere. Emits a distribution of attempts (injections) per human turn.

A "human turn" is a maximal run of consecutive `assessment` verdict records in a
single session's verdicts.jsonl that share the same `data.task` string AND are
not separated by a gap > GAP_SPLIT_MIN minutes (a longer gap means the human
sent a new message, even if its text happened to repeat). Each such run's length
= the number of supervisor injections that turn actually took.

Corroborating signal: legacy `*_attempts.json` and new `state.json` `attempts.count`
each record the FINAL count of one (the last) human turn per session.
"""
import json, os, glob, sys
from datetime import datetime

HOME = os.path.expanduser("~")
GAP_SPLIT_MIN = 5.0  # minutes; larger gap between same-task records => new turn

def parse_ts(s):
    if not s: return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None

def find_supervisor_dirs():
    dirs = set()
    for base in [os.path.join(HOME, "workspace")]:
        for d in glob.glob(os.path.join(base, "*", ".supervisor")):
            if os.path.isdir(d):
                dirs.add(d)
    return sorted(dirs)

def turn_runs_from_verdicts(path):
    """Yield run-lengths (injections per turn) from one verdicts.jsonl."""
    recs = []
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get("kind") != "assessment":
                    continue
                data = r.get("data", {})
                task = data.get("task", "")
                ts = parse_ts(r.get("ts") or data.get("timestamp"))
                recs.append((ts, task))
    except Exception:
        return
    if not recs:
        return
    # group consecutive same-task within time gap
    run_len = 0
    prev_task = None
    prev_ts = None
    for ts, task in recs:
        new_turn = False
        if prev_task is None:
            new_turn = True
        elif task != prev_task:
            new_turn = True
        elif prev_ts and ts and (ts - prev_ts).total_seconds() > GAP_SPLIT_MIN * 60:
            new_turn = True
        if new_turn:
            if run_len > 0:
                yield run_len
            run_len = 1
        else:
            run_len += 1
        prev_task = task
        prev_ts = ts
    if run_len > 0:
        yield run_len

def attempts_counts(sup_dir):
    """Final per-last-turn counts from legacy *_attempts.json and state.json."""
    out = []
    for p in glob.glob(os.path.join(sup_dir, "*_attempts.json")):
        try:
            with open(p) as f:
                c = json.load(f).get("count")
                if isinstance(c, int) and c > 0: out.append(c)
        except Exception: pass
    for p in glob.glob(os.path.join(sup_dir, "sessions", "*", "state.json")):
        try:
            with open(p) as f:
                a = json.load(f).get("attempts", {})
                c = a.get("count")
                if isinstance(c, int) and c > 0: out.append(c)
        except Exception: pass
    return out

def pct(sorted_vals, p):
    if not sorted_vals: return None
    k = (len(sorted_vals) - 1) * (p / 100.0)
    lo = int(k); hi = min(lo + 1, len(sorted_vals) - 1)
    frac = k - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac

def summarize(name, vals):
    vals = sorted(vals)
    n = len(vals)
    if n == 0:
        print(f"\n## {name}: NO SAMPLES")
        return
    from collections import Counter
    hist = Counter(vals)
    print(f"\n## {name}")
    print(f"samples (turns): {n}")
    print(f"max: {max(vals)}")
    for p in (50, 90, 95, 99):
        print(f"p{p}: {pct(vals, p):.2f}")
    print(f"mean: {sum(vals)/n:.2f}")
    print("histogram (attempts: turns):")
    for k in sorted(hist):
        print(f"  {k}: {hist[k]}")
    # how often old caps / current ceiling reached
    for cap in (3, 16, 50, 64, 100):
        reached = sum(1 for v in vals if v >= cap)
        print(f"turns reaching >= {cap}: {reached} ({100*reached/n:.2f}%)")

def main():
    sup_dirs = find_supervisor_dirs()
    print(f"# Runaway-limit forensic analysis")
    print(f"generated: {datetime.now().isoformat()}")
    print(f"supervisor stores scanned: {len(sup_dirs)}")
    turn_lengths = []       # injections per human turn (primary)
    final_counts = []       # last-turn final counts (corroborating)
    per_project = {}
    for d in sup_dirs:
        proj = os.path.basename(os.path.dirname(d))
        tl = []
        for vp in glob.glob(os.path.join(d, "sessions", "*", "verdicts.jsonl")):
            for rl in turn_runs_from_verdicts(vp):
                tl.append(rl)
        fc = attempts_counts(d)
        turn_lengths.extend(tl)
        final_counts.extend(fc)
        per_project[proj] = (len(tl), max(tl) if tl else 0, len(fc), max(fc) if fc else 0)
    print("\n## per-project (turns_from_verdicts, max_turn, final_count_samples, max_final)")
    for proj in sorted(per_project):
        t, mt, f, mf = per_project[proj]
        if t or f:
            print(f"  {proj}: turns={t} maxTurn={mt} finalSamples={f} maxFinal={mf}")
    summarize("PRIMARY: injections per human turn (verdicts.jsonl runs)", turn_lengths)
    summarize("CORROBORATING: final attempts.count per last turn (legacy+state)", final_counts)
    combined = turn_lengths + final_counts
    summarize("COMBINED (all per-turn attempt samples)", combined)

if __name__ == "__main__":
    main()
