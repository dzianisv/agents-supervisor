# Task 4 — Design

## Problem
The supervisor's LLM judge fails to catch `stopped_with_todos` antipatterns on first
occurrence. Data shows 41/52 (79%) of "Next Steps" terminal lists are premature stops
where the user had to say "continue." The judge sometimes needs a second signal to
fire, wasting a turn. Additionally, benign `stated_progress` (mid-stream) gets confused
with terminal `stopped_with_todos` because the rule lacks position guidance.

## Goal
The LLM judge catches `stopped_with_todos` on FIRST occurrence when it appears at
terminal position. False positives on mid-stream progress reports stay at zero.
A new `verification_deferral` nudge fires when code is written without running tests.

## Success Metric (R1)
Task is done when **`npm run eval`** produces **100% recall on `summary_drift_stop`
gold cases** (stopped_with_todos antipattern detected on first occurrence) AND
**`npm test`** passes with zero regressions.

## Out of Scope
- Adding regex heuristic pre-screen (previously rejected by user)
- Changing the supervisor loop architecture
- Adding new LLM calls
- Modifying the training pipeline

## Current State
- `core/patterns.json:49-52` — `stopped_with_todos` rule text
- `core/patterns.json:126-136` — `summary_drift_stop` feedback templates
- `opencode/supervisor.ts:223` — `DEFAULT_RUBRIC` inline copy of the rule
- Both share the same text; changes must be synchronized
- Few-shots B, H, Q already cover `summary_drift_stop` examples

## Proposed Design

### Change 1: Strengthen `stopped_with_todos` rule (P1 + P2)
Add explicit terminal-position discriminator and first-occurrence firing language:

**Current rule (line 52 in patterns.json):**
> "STOPPED-WITH-TODOS (~30%): the response lists 'Remaining Tasks'/'Next steps'/
> 'Still TODO'/'What I did NOT do' or names a verify/run/check/create-PR step as
> 'next' — then stops without doing it."

**New rule:**
> "STOPPED-WITH-TODOS (~30%): the response lists 'Remaining Tasks'/'Next steps'/
> 'Still TODO'/'What I did NOT do'/'Outstanding Work' or names a verify/run/check/
> create-PR step as 'next' — then stops without doing it. FIRST-OCCURRENCE IS
> SUFFICIENT: do NOT wait for a second signal; 98% of these are premature (user says
> 'continue'). TERMINAL-POSITION TEST: the list appears in the LAST ~40% of the
> response with NO subsequent tool calls or execution following it. A mid-response
> 'here's what I did' followed by actual execution is process narration (complete),
> not a stop-with-todos."

### Change 2: Add `verification_deferral` antipattern (P3)
New antipattern entry in patterns.json and DEFAULT_RUBRIC:
> "VERIFICATION-DEFERRAL: agent wrote/edited code (write/edit tool calls present)
> but the response ends without running tests, build, or lint — and the task type
> requires verification. The agent should run verification before stopping."

Maps to `summary_drift_stop` category (same injection behavior).

### Change 3: Add verification_deferral feedback template
New template in patterns.json `feedback.templates`:
```json
"verification_deferral": {
  "reasons": ["verification_deferral: code written but not verified"],
  "messages": [
    "You wrote code but did not run tests/build/lint. Run verification now before stopping. {stepClause}",
    "Second time. You wrote code but STILL did not verify. Run the test/build command NOW.",
    "Third inject. Code unverified. Run tests/build immediately or state what blocks you."
  ]
}
```
Also add `"verification_deferral"` to `inject_categories` array.

### Change 4: Add few-shot example for terminal-position discrimination
Add few-shot demonstrating mid-stream progress (complete) vs terminal todos (drift).

## Alternatives Considered
1. **Regex heuristic pre-screen** — rejected by user; duplicates LLM logic
2. **Separate LLM call for position analysis** — over-engineered, adds latency
3. **Weight tuning only** — insufficient without rule text clarification

## Risks & Open Questions
- Risk: Strengthened rule causes false positives on legitimate progress reports
  → Mitigation: terminal-position test + few-shot examples + existing `closing_delivery_dominates` rule
- Risk: `verification_deferral` fires on tasks that don't need verification
  → Mitigation: condition on task type requiring verification (explicit in rule)

## Touched Surface
- `core/patterns.json` — rule text, templates, few-shots, inject_categories
- `opencode/supervisor.ts` lines 208-226 — DEFAULT_RUBRIC sync
