# Task 4 — Plan

## Approach Summary
Improve the LLM judge's prompt rules for `stopped_with_todos` detection by
strengthening the rule text with terminal-position discriminator, adding first-occurrence
firing language, adding a `verification_deferral` antipattern, and syncing to DEFAULT_RUBRIC.

## Tradeoff: Speed vs Quality
- chosen: balanced
- rationale: small surface area (2 files), prompt-only changes, testable via eval

## Tasks
| # | Title | Files | Depends on | Parallel group | Suggested model |
|---|-------|-------|------------|----------------|-----------------|
| 1 | Strengthen stopped_with_todos rule in patterns.json | core/patterns.json | — | A | claude-sonnet-4-6 |
| 2 | Add verification_deferral antipattern + template in patterns.json | core/patterns.json | 1 | B | claude-sonnet-4-6 |
| 3 | Add terminal-position few-shot example to patterns.json | core/patterns.json | 2 | C | claude-sonnet-4-6 |
| 4 | Sync DEFAULT_RUBRIC in supervisor.ts | opencode/supervisor.ts | 3 | D | claude-sonnet-4-6 |
| 5 | Run npm test + npm run eval to verify | — | 4 | E | claude-sonnet-4-6 |

## Parallel Groups
- **A**: Task 1 — modify rule text
- **B**: Task 2 — add antipattern (depends on 1 since same file section)
- **C**: Task 3 — add few-shot
- **D**: Task 4 — sync rubric
- **E**: Task 5 — verification

## Done Criteria
1. `stopped_with_todos` rule includes "FIRST-OCCURRENCE IS SUFFICIENT" + terminal-position test
2. `verification_deferral` antipattern exists in patterns.json with template + inject_categories entry
3. New few-shot U demonstrating terminal vs mid-stream discrimination
4. DEFAULT_RUBRIC in supervisor.ts includes matching STOPPED-WITH-TODOS + VERIFICATION-DEFERRAL rules
5. `npm test` passes, `npm run eval` shows improved/maintained recall

## Rollback Plan
`git checkout -- core/patterns.json opencode/supervisor.ts`
