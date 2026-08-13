# status

## Track E — agent-declared loop exit (replaces static retry counter)

Task: static per-turn retry budget (3 reflection / 16 goal) stood the
supervisor down before the task was finished. Replace "counter decides" with
"agent declares", keep the counter only as a runaway breaker.

```
ROADMAP  ████████████████████  6/6 done
 [x] 1. supervisor_loop_exit tool (opencode) + loopExit state + idle gate
 [x] 2. counter demoted -> RUNAWAY_CEILING=50, all modes
 [x] 3. CC parity: SUPERVISOR_LOOP_EXIT sentinel, shared core/loop-exit.mjs
 [x] 4. runtime-correct exit hint in every injected message
 [x] 5. all 3 suites green, re-run independently by me
 [x] 6. AGENTS.md stop-mechanism section rewritten

WHY SLOW
 - first subagent reported "E2E pass" but never ran e2e-cc.mjs; its ceiling
   change had already broken a CC test. Caught on the parity pass.
 - E2E is ~4.5 min; ran full suite 3x to verify independently

NEXT
 - commit
```

### Verified (re-run by me, not subagent-reported)

| suite | command | result |
|---|---|---|
| unit/integration | `npm test` | 708 pass / 0 fail, 87 suites |
| opencode E2E | `npm run test:e2e` | 20 pass / 0 fail, 6 suites |
| Claude Code E2E | `node test/e2e-cc.mjs` | 18 pass / 0 fail (was 12) |

### Design locked

- Two runtimes, one parser (`core/loop-exit.mjs`). opencode = tool, CC = text
  sentinel (Stop hook has no tool registry).
- `completed` leaves an active goal untouched; `stuck` pauses it and writes
  `.supervisor/loop-exit.log`. Neither ever deletes the goal.
- Idle gate is a plain `return`, never a counter saturation.
- `AUTOPILOT_EXIT` kept as alias for `completed`.

---

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
