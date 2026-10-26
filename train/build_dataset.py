#!/usr/bin/env python3
"""Build .dataset/{session.id}.xml at TURN granularity from real top-level sessions.

Each session yields MANY examples — one per (assistant turn -> next user turn) pair, i.e. every
point where the agent produced output and the user reacted. Each example records:
  <context>      the user task + preceding user turn (what the agent was responding to)
  <ai_output>    the assistant turn
  <user_followup> the user's reply to it (how they followed up)
  <classification> heuristic labels (free, no LLM): stop_type, followup_reaction, antipattern

Scope: top-level sessions only (no subagents). Sources: OpenCode SQLite (parent_id IS NULL) +
Claude jsonl (~/.claude/projects/*/*.jsonl — deep subagent dirs excluded by the glob depth).

NOTE: sessions can contain personal data — .dataset is git-ignored. ~0 tokens (pure local Python).
"""
import json, os, sqlite3, glob, re, argparse, time
from collections import Counter
from xml.sax.saxutils import escape

OUT = os.path.join(os.path.dirname(__file__), "..", ".dataset")
FIELD_CAP = 4000

def parse_since(s):
    """'14d' / '36h' / '0' -> epoch seconds cutoff (0 = no cutoff)."""
    if not s or s == "0":
        return 0.0
    m = re.match(r"^(\d+)\s*([dh]?)$", s.strip())
    if not m:
        return 0.0
    n = int(m.group(1)); unit = m.group(2) or "d"
    span = n * (86400 if unit == "d" else 3600)
    return time.time() - span

def _xml_ok(ch):
    o = ord(ch)
    return o in (0x9, 0xA, 0xD) or 0x20 <= o <= 0xD7FF or 0xE000 <= o <= 0xFFFD or 0x10000 <= o <= 0x10FFFF

def cdata(s):
    s = (s or "")[:FIELD_CAP]
    s = "".join(c for c in s if _xml_ok(c))
    return "<![CDATA[" + s.replace("]]>", "]]]]><![CDATA[>") + "]]>"

# ---------- source readers: return ordered [(role, text)] for top-level sessions ----------
def opencode_sessions(db_path):
    con = sqlite3.connect(db_path); con.row_factory = sqlite3.Row
    cols = {r[1] for r in con.execute("PRAGMA table_info(session)")}
    has_parent = "parent_id" in cols
    q = "SELECT * FROM session" + (" WHERE parent_id IS NULL" if has_parent else "")
    for s in con.execute(q).fetchall():
        sid = s["id"]; seq = []
        for m in con.execute("SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC", (sid,)):
            md = json.loads(m["data"]); role = md.get("role")
            texts = []
            for p in con.execute("SELECT data FROM part WHERE message_id=? ORDER BY time_created ASC", (m["id"],)):
                pd = json.loads(p["data"])
                if pd.get("type") == "text" and pd.get("text"):
                    texts.append(pd["text"])
            seq.append((role, "\n".join(texts).strip()))
        if seq:
            yield sid, seq
    con.close()

def claude_session(path):
    seq = []
    for l in open(path):
        if not l.strip(): continue
        d = json.loads(l)
        if d.get("type") not in ("user", "assistant"): continue
        m = d.get("message", {}); role = m.get("role"); c = m.get("content")
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = "\n".join(p.get("text", "") for p in c
                             if isinstance(p, dict) and p.get("type") == "text").strip()
        else:
            text = ""
        seq.append((role, text))
    return seq

# ---------- free heuristic classifier per (assistant, followup) pair ----------
QUESTION_RE = re.compile(r"(would you like|want me to|should i\b|shall i\b|let me know|do you want|"
                         r"which (option|one|approach)|how would you like|\?\s*$)", re.I)
TODO_RE = re.compile(r"(remaining (task|work|step)|next step|to-?do|still need to|i'll also|"
                     r"i will also|left to do|outstanding)", re.I)
DEFER_RE = re.compile(r"(try running it|please run|you (can|could|should) run|"
                      r"go ahead and run|run (it|the|npm|the command) (yourself|now))", re.I)
CONTINUE_RE = re.compile(r"^\s*(continue|yes|y|go|proceed|keep going|do it|ok|okay|go ahead|"
                         r"next|carry on|sure|please continue)\b", re.I)
CORRECT_RE = re.compile(r"^\s*(no\b|not\b|nope|wrong|stop|don'?t|actually|instead|that'?s (not|wrong)|"
                        r"you (didn'?t|missed|forgot))", re.I)

def stop_type(asst):
    a = asst.strip()
    if not a: return "empty_output"
    if QUESTION_RE.search(a[-300:]) or a.rstrip().endswith("?"): asked = True
    else: asked = False
    todo = bool(TODO_RE.search(a))
    defer = bool(DEFER_RE.search(a))
    if defer: return "verification_deferral"
    if todo and asked: return "stopped_with_todos_and_question"
    if todo: return "stopped_with_todos"
    if asked: return "asked_question"
    return "stated_progress"

def followup_reaction(fu):
    f = fu.strip()
    if not f: return "none"
    if CONTINUE_RE.search(f): return "told_to_continue"
    if CORRECT_RE.search(f): return "corrected_or_redirected"
    if len(f) < 120: return "short_reply"
    return "answered_or_new_input"

def is_antipattern(st, reac):
    # agent stopped/asked AND the user just told it to continue or corrected it => it shouldn't have stopped
    stopped = st in ("asked_question", "stopped_with_todos", "stopped_with_todos_and_question",
                     "verification_deferral", "empty_output")
    return stopped and reac in ("told_to_continue", "corrected_or_redirected")

def compact(seq):
    """Drop empty-text turns (tool-only round-trips), then merge consecutive same-role text turns.
    Yields the real conversational exchange: alternating assistant/user TEXT turns."""
    nonempty = [(r, t) for (r, t) in seq if t and t.strip()]
    merged = []
    for r, t in nonempty:
        if merged and merged[-1][0] == r:
            merged[-1] = (r, merged[-1][1] + "\n\n" + t)
        else:
            merged.append((r, t))
    return merged

def build(sid, source, task, seq):
    cseq = compact(seq)
    examples = []
    for i in range(len(cseq) - 1):
        if cseq[i][0] != "assistant" or cseq[i + 1][0] != "user":
            continue
        asst = cseq[i][1]; fu = cseq[i + 1][1]
        # context = nearest preceding user text turn
        ctx = ""
        for j in range(i - 1, -1, -1):
            if cseq[j][0] == "user":
                ctx = cseq[j][1]; break
        st = stop_type(asst); reac = followup_reaction(fu)
        ap = is_antipattern(st, reac)
        examples.append((i, ctx, asst, fu, st, reac, ap))
    if not examples:
        return None, 0, 0
    n_ap = sum(1 for e in examples if e[6])
    parts = [f'<?xml version="1.0" encoding="UTF-8"?>',
             f'<session id="{escape(sid)}" source="{escape(source)}" examples="{len(examples)}" antipatterns="{n_ap}">',
             f'  <task>{cdata(task)}</task>']
    for (i, ctx, asst, fu, st, reac, ap) in examples:
        parts.append(f'  <example turn="{i}">')
        parts.append(f'    <context>{cdata(ctx)}</context>')
        parts.append(f'    <ai_output>{cdata(asst)}</ai_output>')
        parts.append(f'    <user_followup>{cdata(fu)}</user_followup>')
        parts.append(f'    <classification stop_type="{st}" followup_reaction="{reac}" antipattern="{str(ap).lower()}"/>')
        parts.append(f'  </example>')
    parts.append('</session>\n')
    return "\n".join(parts), len(examples), n_ap

def main():
    ap = argparse.ArgumentParser(description="Mine agent stop/follow-up pairs into .dataset/")
    ap.add_argument("--since", default="0", help="only sessions newer than N days/hours, e.g. 14d, 36h, 0=all")
    ap.add_argument("--no-clean", action="store_true", help="incremental: keep existing .dataset/*.xml (append/refresh)")
    ap.add_argument("--summary-json", default=os.path.join(OUT, "_analysis", "summary.json"),
                    help="where to write the aggregate label summary")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    cutoff = parse_since(args.since)
    if not args.no_clean:
        for f in glob.glob(os.path.join(OUT, "*.xml")):
            os.remove(f)

    home = os.path.expanduser("~")
    sessions = {}  # sid -> (source, seq)
    for db, tag in [("opencode-local.db", "opencode"), ("opencode.db", "opencodeOld"),
                    ("opencode-main.db", "opencodeMain")]:
        p = f"{home}/.local/share/opencode/{db}"
        if os.path.exists(p):
            if cutoff and os.path.getmtime(p) < cutoff:
                continue  # whole DB untouched since cutoff
            for sid, seq in opencode_sessions(p):
                sessions.setdefault(sid, (tag, seq))
    for path in glob.glob(f"{home}/.claude/projects/*/*.jsonl"):  # top-level only
        if cutoff and os.path.getmtime(path) < cutoff:
            continue
        sid = os.path.splitext(os.path.basename(path))[0]
        sessions.setdefault(sid, ("claude", claude_session(path)))

    files = tot_ex = tot_ap = 0
    stop_counts = Counter()       # stop_type over ALL examples
    ap_stop_counts = Counter()    # stop_type over ANTIPATTERN examples only
    for sid, (source, seq) in sessions.items():
        task = next((t for r, t in seq if r == "user" and t), "")
        cseq = compact(seq)
        for i in range(len(cseq) - 1):
            if cseq[i][0] != "assistant" or cseq[i + 1][0] != "user":
                continue
            st = stop_type(cseq[i][1]); reac = followup_reaction(cseq[i + 1][1])
            stop_counts[st] += 1
            if is_antipattern(st, reac):
                ap_stop_counts[st] += 1
        xml, n, nap = build(sid, source, task, seq)
        if not xml:
            continue
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)
        open(os.path.join(OUT, f"{safe}.xml"), "w").write(xml)
        files += 1; tot_ex += n; tot_ap += nap

    summary = {
        "sessions_written": files,
        "total_examples": tot_ex,
        "antipattern_examples": tot_ap,
        "premature_pct": round(100 * tot_ap / max(tot_ex, 1), 1),
        "stop_type_counts": dict(stop_counts),
        "antipattern_stop_type_counts": dict(ap_stop_counts),
        "since": args.since,
    }
    os.makedirs(os.path.dirname(args.summary_json), exist_ok=True)
    with open(args.summary_json, "w") as fh:
        json.dump(summary, fh, indent=2)

    print(f"sessions written: {files}")
    print(f"total examples (turn-pairs): {tot_ex}")
    print(f"heuristic antipattern examples: {tot_ap} ({summary['premature_pct']}%)")
    print(f"summary -> {args.summary_json}")

if __name__ == "__main__":
    main()
