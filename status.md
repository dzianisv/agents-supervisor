# status — fix/per-turn-budget

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
