# Live validation — supervisor plugin in a real `opencode serve`

Generated: 2026-08-07T01:09:42.837Z
opencode: `1.18.14`  ·  node: `v26.0.0`
Scratch root (never the user's config or repos): `/var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val`
Evidence artefacts: `/var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence`

| # | Scenario | Verdict | Checks | Evidence |
|---|----------|---------|--------|----------|
| 1 | Judge input is the plain conversation chain | **PASS** | 37/37 | both judge-facing prompts were actually sent to the model |
| 2 | Subagent gate | **PASS** | 8/8 | child session carries parentID from the live server |
| 3 | `/supervisor off` persists (and fails loudly when it can't) | **PASS** | 11/11 | baseline: the supervisor DID run for this session before the toggle |
| 4 | Wrong-session off: A off must not disable B | **PASS** | 9/9 | A and B share an 8-char id prefix (so a truncated id could not tell them apart) |
| 5 | Goal retirement | **PASS** | 9/9 | explicit set-goal wrote the durable PROJECT goal file |
| 6 | Non-actionable turn gate | **PASS** | 3/3 | plugin logged "Skipping reflection —" for the `tldr` turn |
| 7 | Status directive reaches the model exactly once | **PASS** | 7/7 | this turn produced MORE THAN ONE model call (the multi-call shape) |
| 8 | Empty verdict stand-down | **PASS** | 5/5 | plugin logged a stand-down |
| 9 | State layout + legacy migration | **PASS** | 9/9 | precondition: the NEW-layout state file does not exist yet |

## 1. Judge input is the plain conversation chain — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 1
```

- PASS — both judge-facing prompts were actually sent to the model
- PASS — the session really did make tool calls (otherwise the check is vacuous)
- PASS — tool OUTPUT sentinels are present in the real transcript
- PASS — [reflection/self-assessment] has an extractable conversation section
- PASS — [reflection/self-assessment] contains `user:` turns
- PASS — [reflection/self-assessment] contains `assistant:` turns
- PASS — [reflection/self-assessment] carries user text LIVEVAL_USER_ALPHA
- PASS — [reflection/self-assessment] carries assistant reply LIVEVAL_REPLY_ALPHA
- PASS — [reflection/self-assessment] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_ALPHA_9f21
- PASS — [reflection/self-assessment] carries user text LIVEVAL_USER_BRAVO
- PASS — [reflection/self-assessment] carries assistant reply LIVEVAL_REPLY_BRAVO
- PASS — [reflection/self-assessment] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_BRAVO_7c04
- PASS — [reflection/self-assessment] carries user text LIVEVAL_USER_CHARLIE
- PASS — [reflection/self-assessment] carries assistant reply LIVEVAL_REPLY_CHARLIE
- PASS — [reflection/self-assessment] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_CHARLIE_2b88
- PASS — [reflection/self-assessment] conversation section does NOT name the `bash` tool
- PASS — [reflection/self-assessment] conversation section has NO tool-call/tool-result labels
- PASS — [reflection/self-assessment] does NOT contain a `[1]`/`[2]` numbered demand blob
- PASS — [reflection/self-assessment] does NOT contain a tool-command log section
- PASS — [reflection/self-assessment] turn order is oldest → newest
- PASS — [ANALYZE SUPERVISOR (2nd stage)] has an extractable conversation section
- PASS — [ANALYZE SUPERVISOR (2nd stage)] contains `user:` turns
- PASS — [ANALYZE SUPERVISOR (2nd stage)] contains `assistant:` turns
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries user text LIVEVAL_USER_ALPHA
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries assistant reply LIVEVAL_REPLY_ALPHA
- PASS — [ANALYZE SUPERVISOR (2nd stage)] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_ALPHA_9f21
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries user text LIVEVAL_USER_BRAVO
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries assistant reply LIVEVAL_REPLY_BRAVO
- PASS — [ANALYZE SUPERVISOR (2nd stage)] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_BRAVO_7c04
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries user text LIVEVAL_USER_CHARLIE
- PASS — [ANALYZE SUPERVISOR (2nd stage)] carries assistant reply LIVEVAL_REPLY_CHARLIE
- PASS — [ANALYZE SUPERVISOR (2nd stage)] does NOT contain tool-output sentinel LIVEVAL_TOOLOUT_CHARLIE_2b88
- PASS — [ANALYZE SUPERVISOR (2nd stage)] conversation section does NOT name the `bash` tool
- PASS — [ANALYZE SUPERVISOR (2nd stage)] conversation section has NO tool-call/tool-result labels
- PASS — [ANALYZE SUPERVISOR (2nd stage)] does NOT contain a `[1]`/`[2]` numbered demand blob
- PASS — [ANALYZE SUPERVISOR (2nd stage)] does NOT contain a tool-command log section
- PASS — [ANALYZE SUPERVISOR (2nd stage)] turn order is oldest → newest

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s1-prompt-reflection.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s1-prompt-analyze.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s1-transcript.json
- prompts captured: reflection/self-assessment (11271 chars); ANALYZE SUPERVISOR (2nd stage) (10542 chars)
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s1-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s1-model-calls.json

## 2. Subagent gate — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 2
```

- PASS — child session carries parentID from the live server
- PASS — root session omits parentID
- PASS — plugin logged: skipping delegated subagent session <child>
- PASS — plugin logged: supervising root session <root>
- PASS — child was NEVER supervised
- PASS — root was NEVER skipped as a subagent
- PASS — a judge prompt exists for the ROOT session's task
- PASS — NO judge prompt exists for the CHILD session's task

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s2-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s2-model-calls.json

## 3. `/supervisor off` persists (and fails loudly when it can't) — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 3
```

- PASS — baseline: the supervisor DID run for this session before the toggle
- PASS — the tool call was made with the schema-forced filler mode (`mode:reflection, action:off`)
- PASS — tool reported a VERIFIED disable (not a bare success string)
- PASS — .supervisor/disabled exists and lists the FULL session id
- PASS — plugin logged: Supervisor disabled for session <id>
- PASS — NO judge ran for the post-off turn
- PASS — NO supervisor continuation was injected into the transcript after off
- PASS — [unwritable-dir] the tool returns FAILED, not success
- PASS — [unwritable-dir] the FAILED message does NOT claim the supervisor is off
- PASS — [readonly-file] the tool returns FAILED, not success
- PASS — [readonly-file] the FAILED message does NOT claim the supervisor is off

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s3-off-response.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s3-unwritable-unwritable-dir.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s3-unwritable-readonly-file.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s3-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s3-model-calls.json

## 4. Wrong-session off: A off must not disable B — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 4
```

- PASS — A and B share an 8-char id prefix (so a truncated id could not tell them apart)
- PASS — baseline: A was supervised
- PASS — baseline: B was supervised
- PASS — A's off reported verified success
- PASS — .supervisor/disabled lists A's FULL id
- PASS — .supervisor/disabled does NOT list B's id
- PASS — session B (untouched) WAS still judged after A was turned off
- PASS — session A (turned off) was NOT judged
- PASS — plugin logged the disabled skip with A's FULL id (not an ambiguous 8-char prefix)

- session A = ses_0263d5735ffe0gganbRQlfoTvg
- session B = ses_0263d5709ffeZgznCqC5Tu0cOP
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s4-disabled-file.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s4-judge-prompt-tasks.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s4-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s4-model-calls.json

## 5. Goal retirement — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 5
```

- PASS — explicit set-goal wrote the durable PROJECT goal file
- PASS — while active, the goal condition IS injected into the judge prompt
- PASS — plugin logged the retirement
- PASS — the PROJECT goal file was DELETED
- PASS — .supervisor/goal-achieved.log records the achievement
- PASS — the achievement record names the session
- PASS — a judge prompt was produced for the post-retirement turn
- PASS — post-retirement judge prompt contains NO injected goal condition
- PASS — post-retirement judge prompt contains NO GOAL requirement section

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s5-goal-achieved.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s5-post-retirement-judge-prompt.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s5-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s5-model-calls.json

## 6. Non-actionable turn gate — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 6
```

- PASS — plugin logged "Skipping reflection —" for the `tldr` turn
- PASS — NO judge call was made for the `tldr` turn
- PASS — a real work request DID run the judge

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s6-skip-log.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s6-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s6-model-calls.json

## 7. Status directive reaches the model exactly once — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 7
```

- PASS — this turn produced MORE THAN ONE model call (the multi-call shape)
- PASS — the status directive reached the model for this turn
- PASS — no model call ever received the directive more than ONCE
- PASS — every model call for this turn carried it exactly once
- PASS — the directive body (ROADMAP block + status.md instruction) is present
- PASS — the transform hook fired MORE THAN ONCE for this single user turn
- PASS — the hook fired at least once per model call of this turn

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s7-hook-counts.json
- status-directive hook: fired=3, appended=3, model calls for the turn=3
- NOT PROVEN LIVE on this build: every hook fire got a fresh system array, so the idempotency guard never had to suppress a duplicate. Its suppression path is covered only by test/status-directive.test.mjs.
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s7-system-prompt-sample.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s7-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s7-model-calls.json

## 8. Empty verdict stand-down — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 8
```

- PASS — plugin logged a stand-down
- PASS — the stand-down reason names the actionless verdict
- PASS — plugin did NOT log 'Supervisor pushed continuation'
- PASS — NO continuation was injected into the session transcript
- PASS — the session still has exactly ONE user turn (no injected turns)

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s8-standdown-line.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s8-transcript.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s8-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s8-model-calls.json

## 9. State layout + legacy migration — PASS

Reproduce:
```bash
node --experimental-strip-types test/live-validation.mjs --only 9
```

- PASS — precondition: the NEW-layout state file does not exist yet
- PASS — state migrated to .supervisor/sessions/<full id>/state.json
- PASS — the legacy GOAL survived the migration
- PASS — the legacy retry override survived the migration
- PASS — the legacy per-turn attempt counter survived the migration
- PASS — the session dir uses the FULL session id (not an 8-char prefix)
- PASS — legacy files are deliberately LEFT IN PLACE (downgrade-safe)
- PASS — .agents/supervisor/ was NOT modified
- PASS — .agents/supervisor/ was NOT sharded per session

- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s9-legacy-seed.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s9-migrated-state.json
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s9-supervisor-tree.txt
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s9-debug.log
- artefact: /var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/s9-model-calls.json
