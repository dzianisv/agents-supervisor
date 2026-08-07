# status

## Track C — OpenClawBot "runaway supervisor" investigation (2026-08-07)

**Ask:** review recent Claude sessions on ~/workspace/OpenClawBot; supervisor
allegedly kept pushing a session that was mid-conversation with the user.

```
ROADMAP  ████████████████████  12/12 done
 [x] 1. Grep CC transcripts (session 98473024, 105 Stop-hook msgs)
 [x] 2. Map stand-down conditions + session-id resolution (file:line)
 [x] 3. Verify H1 (own injection resets turn budget) — REFUTED as the cause
 [x] 4. Verify H2 (/supervisor off ignored)         — REFUTED, disable honoured
 [x] 5. Report findings + ranked fix list
 [x] 6. Fix #1 foreign-Stop-hook turn-key leak      -> #63 merged
 [x] 7. Fix #3 no-progress gate (threshold 2)       -> #63 merged
 [x] 8. Drain the 5-branch unmerged stack           -> #61, #65 merged
 [x] 9. Root-cause "fixes never land": manifest version never bumped
 [x] 10. Release 0.3.1 + `claude plugin update`     -> #66 merged, cache d4013b4
 [x] 11. OpenClawBot CI-guard hook refire cap       -> OpenClawBot#3653 (open)
 [x] 12. Delete 6 merged branches + worktrees; PR backlog now empty

WHY SLOW
 - Misattribution cost a full round. The 105 injections were NOT
   agents-supervisor: 49 = Claude Code NATIVE /goal sentinel, 54 = OpenClawBot's
   own claude-post-merge-ci-guard-hook.sh. agents-supervisor injected 0 times.
 - First no-progress gate was a boolean (stand down on 1st repeat) and silently
   collapsed every per-turn budget to 1 injection. CI caught it, not local runs.
 - #61 squash-merge orphaned the stacked PR #64; had to reopen as #65 and
   hand-rebase #63 through a semantic conflict (goalStore -> sessionStore).

NEXT
 - Merge OpenClawBot#3653. Claude Code restart required for 0.3.1 to take effect.
 - Not done: fix #4 (opencode has no pre-judge human-block guard),
   fix #6 (184 orphan goal files in OpenClawBot/.supervisor/goals/),
   `npm test` glob on main still matches the E2E (flaky, pre-existing).
```

Final state: `main` = `d4013b4`, installed plugin `0.3.1` = `d4013b4`, 0 open PRs,
0 stale branches. Verified the shipped cache actually contains both fixes
(`FOREIGN_STOP_HOOK_PREFIX`, `NO_PROGRESS_REPEAT_THRESHOLD`, `core/session-store.mjs`).

Two tracks below. Earlier session worked track B, which is not code in this repo.

## Track B — demo video registry (2026-07-29, current session)

**Goal:** one list of all our demo videos, so agents stop uploading duplicates.

```
ROADMAP  ████████████████████  9/9 done
 [x] 1. Audit real YouTube channel via Studio (18 Shorts, 0 long-form)
 [x] 2. oEmbed-check all 15 IDs — all 200, zero dead
 [x] 3. Merge partial registry from OpenCode Mobile Notion page
 [x] 4. Create Demo Video Registry page + RULES (single source of truth)
 [x] 5. Unlist 4 duplicates (13 -> 9 public); nothing deleted
 [x] 6. Close opencode-mobile#158 — "broken upload" was a video-ID typo
 [x] 7. Archive evidence off ephemeral /tmp
 [x] 8. Revert global AGENTS.md (0 occurrences); rule now in
        ~/.agents/skills/upload-youtube-video/SKILL.md instead
 [x] 9. Append QZsi71RTfUM + record NOT-duplicate verdict vs the 3 VibeBrowser
        Shorts (32.5s vs 9-20.6s, only full install->answer arc, only captioned;
        21/21 frame MD5s distinct)

WHY SLOW
 - I wrongly accused a parallel session of uploading a duplicate. It was not one.
   Checked properly only after being challenged.
 - First registry edit silently no-opped: other sessions converted the table to
   HTML, so my markdown old_str never matched. API returned success anyway.
   Had to re-read the page and redo the insert.

NEXT
 - Nothing pending in this track. Registry is live and self-serve.
```

Not done, and deliberately so: no tests / build / PR. Nothing in this repo's
code changed — all work was Notion, YouTube and a skill file under ~/.agents.
Running `npm test` here would prove nothing about it.

Registry: https://app.notion.com/p/Demo-Video-Registry-3acac25eb49f8102b36efccf3a3f93e7

## Track A — fix/per-turn-budget (this repo, earlier)

One stop mechanism for the opencode supervisor: a persisted per-turn attempt
counter replaces the boolean "already reflected this turn" gate that capped
every human turn at ONE injection.

```
ROADMAP  ████████████████████  9/9 done
 [x] 1. Classify all 22 `lastReflectedMsgId.set` sites (inject vs stand-down)
 [x] 2. Replace the boolean gate with a pre-increment counter budget
 [x] 3. Persist the counter via sessionStore.mutate() (locked RMW)
 [x] 4. Autopilot on the same persisted budget; "(n/N)" now truthful
 [x] 5. Escalation decided: dead params deleted from buildEscalatingFeedback
 [x] 6. One budget rule for both runtimes (resolveTurnMaxAttempts)
 [x] 7. E2E: N injections/turn, termination, retry 1 vs 5, complete, actionless,
        autopilot cap, server-restart persistence
 [x] 8. Control test: re-adding the deleted line turns 3 injections into 1
 [x] 9. npm test / test:e2e / e2e-cc all green; 10x E2E flake run

WHY SLOW
 - Two real defects surfaced mid-work and had to be fixed, not worked around:
   eligibility gates saturating the counter disarmed autopilot on its own
   command turn; and the turn key was a 20-char text prefix, not the message id.

NEXT
 - Push branch. Do NOT merge (owner review).
```

## Mechanism

```
session.idle
    |
    v
[subagent gate] [.supervisor/disabled]        -> plain return (eligibility)
    |
    v
turnKey = last NON-supervisor user message id   (stable across injections)
count   = max(memory, .supervisor/sessions/<id>/state.json)
    |
    +-- count >= budget ? --yes--> disarm autopilot / goal bookkeeping -> STOP
    |
   no
    |
    v
[non-actionable / control-command gate]      -> plain return (eligibility)
    |
    v
autopilot?  --yes--> write count+1 -> nudge "(n/N)" -> return
    |
   no
    v
judge -> complete | actionless | human-block | error  -> saturate count -> STOP
      -> continue -> write count+1 -> inject -> return   (NO stand-down here)
```

## Budgets

| mode | default | `/supervisor retry N` | opencode | Claude Code |
|---|---|---|---|---|
| reflection | 3 | N | N | min(N, 7) |
| goal / autopilot | 16 | N | N | min(N, 7) |
