# PoC — PR/CI false-positive gate fix

Sandbox for reproducing and fixing the bug where the supervisor Stop hook incorrectly
applies code-workflow gates (PR required, CI checks required) to a non-code
research/report task.

## How to run

```
node PoC/repro.mjs
```

Exit 0 = all fixtures PASS.  No network calls, no LLM, no filesystem side-effects.

---

## Root cause — exact file:line references

### Where task type is inferred

**`core/evaluation.mjs` line 194–209** — `inferTaskType(text)`

The function classifies tasks by regex-matching the combined
`humanMessages + lastAssistantText` string.  The branch on line 200:

```js
if (hasResearch && (hasCodingAction || hasGitHubIssue)) return 'coding'
```

fires whenever **both** a research word (`analyze`, `investigate`, …) **and** a
coding-action word (`create`, `build`, `add`, …) appear anywhere in the combined
text.  For a task like "create a market-analysis report and publish to Notion", both
`analyze` (via "market-analysis") and `create` match, so it returns `'coding'` even
though the deliverable is a document, not code.

### Where `requiresPR` / `requiresCI` get set `true`

**`bin/on-stop.mjs` lines 337–338** (inside `buildTaskContextFromTranscript`):

```js
const requiresPR = taskType === 'coding'   // line 337
const requiresCI = taskType === 'coding'   // line 338
```

Because `inferTaskType` wrongly returned `'coding'`, both flags become `true`.

### Where missing items are added from the flags

**`core/evaluation.mjs` lines 447–465** (inside `evaluateSelfAssessment`):

```js
if (safeContext.requiresPR) {
  if (pr.created !== true) {
    addMissing('Create PR', 'Create a pull request with summary and checklist')
  } else if (safeContext.requiresCI) {
    // … adds Verify CI checks, Provide CI check evidence, etc.
  }
}
```

### Where severity is computed

**`core/evaluation.mjs` lines 481–486**:

```js
let severity = 'NONE'
const severityItems = missing.length > 0 ? missing : nextActions
if (severityItems.some(item => /test|build/i.test(item))) severity = 'HIGH'
else if (severityItems.some(item => /CI|check/i.test(item))) severity = 'MEDIUM'  // line 483
else if (severityItems.length > 0) severity = 'LOW'
```

The false-positive PR/CI items injected the string `"Verify CI checks"` into `missing`,
triggering the `/CI|check/i` branch and producing **MEDIUM** severity instead of
**LOW** (which would be the correct severity for the only real problem: an unverified
Notion URL claim).

---

## The fix

**Single targeted change in `inferTaskType` (line 200 region).**

Added a `hasNonCodeOutput` guard: when the primary deliverable of the task is a
non-code artifact (report, Notion page, market analysis, etc.), the
`research + create/analyze → coding` branch is skipped and the task falls through
to `return 'research'`.  A GitHub-issue URL in the task text still forces `'coding'`
regardless (that is an unambiguous code-task signal).

```js
// NEW — added to inferTaskType in PoC/evaluation.mjs
const hasNonCodeOutput = /\b(report|notion|spreadsheet|dashboard|slide\s*deck|
  wiki\s*page|blog\s*post|market[\s-]+analysis|write[\s-]+up)\b/i.test(text)

if (hasResearch && (hasCodingAction || hasGitHubIssue)) {
  if (hasGitHubIssue) return 'coding'          // explicit code task
  if (hasNonCodeOutput) { /* fall through */ }  // research/report task → not coding
  else return 'coding'
}
```

With `taskType = 'research'`, the two lines in `buildTaskContextFromTranscript`
(`requiresPR = taskType === 'coding'` and `requiresCI = taskType === 'coding'`) both
evaluate to `false` without any further changes — the fix cascades naturally.

The verification-deferral path (LLM flags "Notion page claimed but no evidence of
actual creation" via `remaining_work`) continues to work unchanged because it goes
through `addMissing(item)` from `remaining` (line 397–399 of `evaluateSelfAssessment`)
independent of the code gates.

---

## Before / after — Fixture A

**Task:** "Produce a market-analysis report … publish to Notion via MCP."

| Field | BEFORE fix | AFTER fix |
|---|---|---|
| `taskType` | `'coding'` | `'research'` |
| `requiresPR` | `true` | `false` |
| `requiresCI` | `true` | `false` |
| `missing` | `["Create PR", "Verify CI checks", "Provide CI check evidence", "Verify Notion page …"]` | `["Verify Notion page was actually created … no tool confirmation"]` |
| `severity` | `MEDIUM` (CI/check match) | `LOW` |
| `complete` | `false` | `false` |
| Feedback shown to agent | "CRITICAL: No PR … CRITICAL: … CI checks …" (false positive) | "Verify Notion page … URL claim made but no tool confirmation" (correct) |

---

## PORT-TO-PRODUCTION

Two production files need changes when this PoC is accepted:

### 1. `core/evaluation.mjs` — `inferTaskType` (PRIMARY FIX, ~8 lines)

Replace the block at lines 200–201:
```js
// BEFORE
if (hasResearch && (hasCodingAction || hasGitHubIssue)) return 'coding'
```

With the guarded version from `PoC/evaluation.mjs` (lines 65–74):
```js
const hasNonCodeOutput = /\b(report|notion|spreadsheet|dashboard|slide\s*deck|
  wiki\s*page|blog\s*post|market[\s-]+analysis|write[\s-]+up)\b/i.test(text)

if (hasResearch && (hasCodingAction || hasGitHubIssue)) {
  if (hasGitHubIssue) return 'coding'
  if (hasNonCodeOutput) { /* fall through to research */ }
  else return 'coding'
}
```

No other changes to `core/evaluation.mjs` are needed.

### 2. `bin/on-stop.mjs` — `buildTaskContextFromTranscript` (NO CHANGE REQUIRED)

Lines 337–338 (`requiresPR = taskType === 'coding'` / `requiresCI = taskType === 'coding'`)
do not need modification — they cascade correctly once `inferTaskType` returns the right
type.  Document this in a comment for future readers to avoid confusion.

### Tests to add (post-port)

- Unit test for `inferTaskType` with "market-analysis report + Notion" → `'research'`
- Unit test for `inferTaskType` with "fix the bug in github.com/org/repo/issues/42" → `'coding'`
- Integration test for `evaluateSelfAssessment` with research taskContext + no PR evidence → `missing` must not contain PR/CI items

---

## Files in this PoC

| File | Description |
|---|---|
| `PoC/evaluation.mjs` | Fixed copy of `core/evaluation.mjs`; adds `buildTaskContextMock` |
| `PoC/feedback.mjs` | Copy of `core/feedback.mjs` with local imports |
| `PoC/repro.mjs` | Runnable harness — 3 fixtures, PASS/FAIL, exit code |
| `PoC/README.md` | This file |
