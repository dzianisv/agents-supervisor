# status

## Track C — OpenClawBot "runaway supervisor" (2026-08-07) — CLOSED

```
ROADMAP  ████████████████████  12/12 done
 [x] 1-5.  Investigated; disproved both theories. Loop was Claude Code's own
           /goal (49x) + OpenClawBot's own CI-guard hook (54x). Supervisor: 0.
 [x] 6-7.  Fix #1 foreign-Stop-hook turn-key leak; Fix #3 no-progress gate -> #63
 [x] 8.    Drained the 5-branch unmerged stack -> #61, #65
 [x] 9-10. Found why fixes never landed (manifest version never bumped);
           released 0.3.1, plugin cache now d4013b4 -> #66
 [x] 11.   OpenClawBot CI-guard refire cap -> OpenClawBot#3653 (open, not mine to merge)
 [x] 12.   Deleted 6 merged branches + worktrees; PR backlog empty

WHY SLOW
 - nothing changed this turn; work finished last turn, this is the checkpoint only
 - earlier cost: misattribution round, plus my first no-progress gate was a
   boolean and collapsed every per-turn budget to 1 inject (CI caught it)

NEXT
 - Owner action only: merge OpenClawBot#3653, restart Claude Code for 0.3.1
```

Not done on purpose: fix #4 (opencode lacks a pre-judge human-block guard),
fix #6 (184 orphan goal files in OpenClawBot/.supervisor/goals/), and the
`npm test` glob on main still matching the E2E.

Task: inject humanize/terse style correction when a reply is long — port the
existing `core/verbosity.mjs` detector into the opencode runtime and add a toggle.

```
ROADMAP  ████████████████████  5/6 done
 [x] 1. detector core/verbosity.mjs (pre-existing)
 [x] 2. Claude Code Stop hook bin/plainspeak-on-stop.mjs (pre-existing)
 [x] 3. opencode port: maybeInjectPlainspeak on 4 stand-down sites
 [x] 4. /supervisor:plain on|off toggle + isPlainspeakEnabled (default ON)
 [x] 5. PR #67 merged to main (e89bbea), branch + worktree cleaned
 [~] 6. E2E gap: no live-server verbose-reply test   <-- YOU ARE HERE

WHY SLOW
 - not slow; one delegated pass, both suites green first run, CI green

NEXT
 - decide whether to close the E2E gap or accept the source-level pins
```

## Verified (re-run independently, not subagent-reported)

| suite | command | result |
|---|---|---|
| unit/integration | `npm test` | 683 pass / 0 fail, 82 suites |
| opencode E2E | `npm run test:e2e` | 20 pass / 0 fail, 6 suites |

## Design decisions locked

- Deterministic only in opencode — fires on `verdict === 'verbose'`; `'suspect'`
  is treated as terse. No LLM tiebreak, no new model wiring.
- Never fights the supervisor: only injects on stand-down turns.
- Runs after the status-checkpoint correction; max one chore injection per turn.
- One rewrite per turn, pinned by `lastPlainTurnKey`.
- Suppressed by: subagent, `.supervisor/disabled`, judge sessions, autopilot,
  active session goal, active project goal, control turns, explicit `plain off`.
- Default ON, off-only flag — mirrors `statusDiagram`.

## Known gap

No E2E test drives a real verbose reply through a live server to the injected
directive. Source-level pins cover the deletable guard lines; the wire path is
untested.
