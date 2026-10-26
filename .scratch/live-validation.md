# Live validation — the supervisor plugin inside a real `opencode serve`

**Date:** 2026-08-06 · **Branch:** `fix/supervisor-intelligence`
**opencode:** 1.18.14 · **node:** v26.0.0 · **platform:** darwin/arm64

Nine claims, each driven against a **real, spawned `opencode serve`** with this
worktree's plugin loaded, over the REST API. Every verdict below is backed by an
artefact the plugin itself produced — its `SUPERVISOR_DEBUG` log, the files it
wrote, or the exact bytes it sent to the model. Nothing here is an assurance.

**Isolation.** Every scenario gets its own throwaway project **and** its own
throwaway `$HOME` under
`/var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/`. Ambient
provider credentials and `OPENCODE_SERVER_*` are stripped from the spawned
server's env. The user's `~/.config/opencode`, `~/.local/share/opencode` and
real repos are never read or written.

## Reproduce everything

```bash
cd /Users/engineer/workspace/agents-supervisor
node --experimental-strip-types test/live-validation.mjs           # all 9
node --experimental-strip-types test/live-validation.mjs --only 4  # one
node --experimental-strip-types test/live-validation.mjs --keep    # keep scratch dirs
```

Artefacts land in
`/var/folders/gq/0rs975rd2b9bj2h6zkymwx6r0000gn/T/opencode/live-val/evidence/`
(`report.md`, `results.json`, per-scenario `*-debug.log.txt`, `*-model-calls.json`,
captured prompts, transcripts). **A snapshot of the final green run is committed
alongside this file** at `.scratch/live-validation-evidence/` — every artefact
referenced below is there (`.log.txt` renamed to `.log.txt`, since `*.log.txt` is
gitignored). The temp dir is wiped on the next run; that snapshot is not.

**The model is a local recording fixture, deliberately.** Three of the nine
claims are about the exact bytes the plugin *sends* and the exact verdict shape
it must survive; neither is observable — or forceable — through a real provider
without a MITM proxy. Everything under test is plugin plumbing, which is
deterministic given a verdict. See "What does NOT work" item 1 for why no real
model was used and exactly what that leaves unproven.

---

## Results

Full run: **9/9 scenarios PASS, 98/98 checks, 398 s wall clock.**
Command: `node --experimental-strip-types test/live-validation.mjs` → exit 0.

| # | Scenario | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | Judge input is the plain conversation chain | **PASS** | Both prompts captured on the wire. 3 real `bash` tool calls ran; their unique output sentinels appear in the transcript and in **neither** prompt |
| 2 | Subagent gate | **PASS** | Debug log: child skipped, root supervised; a judge prompt exists for the root's task and none for the child's |
| 3 | `/supervisor off` persists; fails loudly when it can't | **PASS** | Tool returns a *verified* disable; next idle logs `Supervisor disabled`, no judge, no injection. Unwritable dir **and** read-only file both return `FAILED …` |
| 4 | Wrong-session off | **PASS** | `.supervisor/disabled` holds A's full id only; B judged after A's off, A not judged |
| 5 | Goal retirement | **PASS** | `Goal.md` deleted, `goal-achieved.log.txt` written with condition+session, next judge prompt has no goal section |
| 6 | Non-actionable turn gate | **PASS** | `tldr` → `Skipping reflection —`, zero judge calls; next real request → judge ran |
| 7 | Status directive exactly once per call | **PASS** (with a stated limit) | Hook fired 3× for one turn, every system prompt carried the marker exactly once |
| 8 | Empty verdict stand-down | **PASS** (after a fix) | `verdict had no actionable content …`, no injection, transcript still has exactly 1 user turn |
| 9 | State layout + legacy migration | **PASS** | Legacy goal/retry/attempts migrated into `.supervisor/sessions/<full id>/state.json`; `.agents/supervisor/` byte-identical |

---

## 1. Judge input is the plain conversation chain — PASS (37/37)

```bash
node --experimental-strip-types test/live-validation.mjs --only 1
```

**Setup.** 3 user turns. Each turn makes a **real** `bash` tool call whose
output carries a sentinel that exists nowhere else in the session
(`LIVEVAL_TOOLOUT_ALPHA_9f21`, `…BRAVO_7c04`, `…CHARLIE_2b88`). Verified first
that all 3 tool calls really executed and all 3 sentinels are in the REST
transcript — otherwise "no tool output in the prompt" would be vacuous.

**The plugin sends TWO judge-facing prompts, and both were captured:**

| Prompt | Built by | When |
|---|---|---|
| `# Reflection Prompt` | `buildReflectionPrompt` (`.agents/supervisor/SystemPrompt.md`) | **every** supervised idle — the primary one |
| `ANALYZE SUPERVISOR` | `buildJudgePrompt` (`core/assessment.mjs`) | only when the self-assessment did **not** parse as JSON |

> Worth knowing: if the model answers the self-assessment with valid JSON, the
> plugin short-circuits into the deterministic `evaluateSelfAssessment` and the
> `ANALYZE SUPERVISOR` LLM judge is **never called**. Both paths were exercised.

Both prompts pass every check: `user:`/`assistant:` turns present, oldest→newest,
all three user texts and all three assistant replies present, **no** sentinel,
**no** `bash`, **no** `[1]`/`[2]` blob, no tool-command section.

### The real `ANALYZE SUPERVISOR` prompt (verbatim, header + conversation)

```
ANALYZE SUPERVISOR

You are validating an agent's self-assessment against workflow requirements.

## Conversation
This is the conversation between the user and the agent, oldest first. Judge ONLY whether the LAST user request was satisfied by the agent's reply to it. Earlier turns are context for resolving references — they were already handled or superseded, and must NEVER be re-opened as missing work. Any `[…truncated by supervisor: …]` or `[…conversation trimmed by supervisor: …]` marker is the SUPERVISOR's own length cut, never the agent stopping mid-sentence.

user:
Add a retry loop to the uploader in src/upload.ts. LIVEVAL_USER_ALPHA

assistant:
Added a 3-attempt retry loop to src/upload.ts. LIVEVAL_REPLY_ALPHA

Done — applied the change in src/ and ran the suite: 12/12 passing.

---

user:
Now write a unit test for that retry. LIVEVAL_USER_BRAVO

assistant:
Added test/upload.retry.test.ts with 4 cases. LIVEVAL_REPLY_BRAVO

Done — applied the change in src/ and ran the suite: 12/12 passing.

---

user:
Run the tests and report the result. LIVEVAL_USER_CHARLIE

assistant:
Ran the suite: 12/12 pass. LIVEVAL_REPLY_CHARLIE

ROADMAP  ██████░░░░  2/3 done
 [x] 1. retry loop
 [x] 2. unit test
 [~] 3. report   <-- YOU ARE HERE

## Task Type
coding

## Workflow Requirements
- Tests required: true
- Build required: false
- PR required: false
- CI checks required: false
- Local test commands required: true

## Agent Self-Assessment
I finished the requested change and verified it. Handing back for judgement.


Rules:
- REPORT REVIEW, NOT AUDIT: you see only what the user and the agent wrote. …
```

(rules/antipatterns continue for ~7 kB; full text:
`.scratch/live-validation-evidence/s1-prompt-analyze.txt`, 10 542 chars. The reflection prompt is
`.scratch/live-validation-evidence/s1-prompt-reflection.txt`, 11 271 chars.)

Three things to read off that text directly:

1. It is `user:` / `assistant:` and nothing else. No tool names, no tool inputs,
   no tool results, no `[1]`/`[2]` numbered demand blob.
2. `LIVEVAL_TOOLOUT_*` — which **is** in the live transcript — is absent.
3. The word `bash` appears **only** in the rubric prose further down (a rule that
   says "the agent has Bash or Read or gh in its tool list"), never in the
   conversation. Checks are scoped to the conversation section for exactly that
   reason; a whole-prompt grep would fail on a rule, not a leak.

**One wart, visible above.** The stray `Done — applied the change in src/ …`
paragraph in turns 1 and 2 is the agent's reply to the supervisor's own
status-checkpoint correction. The injected *user* message is correctly excluded
from the human chain, but the *assistant's reply to it* is folded into the
previous human turn. The judge therefore reads text the human never asked for,
attributed to the wrong turn. Not fixed here — see "What does not work".

---

## 2. Subagent gate — PASS (8/8)

```bash
node --experimental-strip-types test/live-validation.mjs --only 2
```

- Live server contract confirmed: `POST /session {parentID}` returns
  `parentID` on the child; `GET /session/{root}` omits the key entirely.
- Child driven to idle → `subagent-gate: skipping delegated subagent session ses_…`
- Root driven to idle → `subagent-gate: supervising root session ses_…`
- Neither line ever appears with the other session's id.
- **Independent of the log:** a judge prompt exists containing the root's task
  text (`LIVEVAL_ROOT_TASK`) and **none** containing the child's
  (`LIVEVAL_CHILD_TASK`).

Evidence: `.scratch/live-validation-evidence/s2-debug.log.txt`, `.scratch/live-validation-evidence/s2-model-calls.json`.

---

## 3. `/supervisor off` persists, and fails loudly when it cannot — PASS (11/11)

```bash
node --experimental-strip-types test/live-validation.mjs --only 3
```

The tool is called the way the runtime really forces the model to call it —
`supervisor({ mode: "reflection", action: "off" })`, filler `mode` included. The
message text is `"Please stop supervising this session. LIVEVAL_TURN_IT_OFF"`,
which deliberately does **not** contain the literal `/supervisor off` line, so
the transcript-scanning path (`detectSupervisorActionInText`) cannot fire. The
only thing that can disable the session is the tool call.

- Baseline: the supervisor demonstrably ran for this session *before* the toggle.
- Tool reply: `Supervisor disabled for session ses_…… (added to .supervisor/disabled, verified). Mode also set to reflection.`
- `.supervisor/disabled` contains the **full** session id.
- Next idle with real work: `Supervisor disabled for session: ses_…`, **no**
  judge prompt for that turn, **no** continuation in the transcript.

**Failure reporting.** Two independent ways the write can fail — they are not the
same syscall, and testing only one passes vacuously (it did on the first attempt:
`chmod 0500` on `.supervisor/` changes nothing once `disabled` already exists,
because overwriting needs write on the *file*):

| Setup | Tool returns |
|---|---|
| `.supervisor/` `chmod 0500`, no pre-existing `disabled` | `FAILED to disable supervisor for session ses_0267… — could not write .supervisor/disabled: EACCES: permission denied, open '…/.supervisor/disabled'. The supervisor is still ON. Mode also set to reflection.` |
| `.supervisor/disabled` `chmod 0444` | same `FAILED …` shape |

Neither reply contains the success string. Evidence:
`.scratch/live-validation-evidence/s3-unwritable-unwritable-dir.json`,
`.scratch/live-validation-evidence/s3-unwritable-readonly-file.json`.

---

## 4. Wrong-session off — PASS (9/9)

```bash
node --experimental-strip-types test/live-validation.mjs --only 4
```

Two sessions in one project, ids minted seconds apart:

```
A = ses_0266ff0baffe5abkLVKlI2EVMm
B = ses_0266ff02dffezQoZgqimSezR4j
```

Both supervised at baseline. `off` issued **from inside session A**.

- `.supervisor/disabled` afterwards: exactly `ses_0266ff0baffe5abkLVKlI2EVMm` —
  A's full id, B absent.
- Both sessions then driven again with distinct work.
- Judge prompts produced afterwards, by task marker:
  `["LIVEVAL_S4_B_WORK1,LIVEVAL_S4_B_WORK2", "LIVEVAL_S4_B_WORK1,LIVEVAL_S4_B_WORK2"]`
  — **only B.** No prompt mentions `LIVEVAL_S4_A_WORK2`.

Evidence: `.scratch/live-validation-evidence/s4-disabled-file.txt`,
`.scratch/live-validation-evidence/s4-judge-prompt-tasks.json`, `.scratch/live-validation-evidence/s4-debug.log.txt`.

---

## 5. Goal retirement — PASS (9/9)

```bash
node --experimental-strip-types test/live-validation.mjs --only 5
```

Goal: `the retry backoff is capped at 30s and covered by a unit test`.

1. `/supervisor set-goal <cond>` wrote `.agents/supervisor/Goal.md`.
2. While active, the condition **is** injected into the judge prompt (proven
   before proving it stops).
3. Judge returns complete → plugin logs the retirement.
4. `Goal.md` is **gone**.
5. `.supervisor/goal-achieved.log.txt`:

```json
{"ts":"2026-08-07T00:12:49.351Z","pid":23098,
 "condition":"the retry backoff is capped at 30s and covered by a unit test",
 "sessionId":"ses_0266f7233ffeBG13l8yrk5Uxx8",
 "source":"opencode:session-goal-achieved","reason":"goal met",
 "removed":["…/proj-s5-PHDPdW/.agents/supervisor/Goal.md"],"skipped":[]}
```

6. Next idle's judge prompt contains **no** injected goal condition and **no**
   `## GOAL (mandatory completion requirement)` section.

The condition text still appears inside the *conversation* — the user literally
typed `/supervisor set-goal <cond>`, so it is transcript history forever. The
check is scoped to everything outside the conversation section; asserting on the
whole prompt would be asserting that the plugin rewrites history.

Evidence: `.scratch/live-validation-evidence/s5-goal-achieved.log.txt`,
`.scratch/live-validation-evidence/s5-post-retirement-judge-prompt.txt`.

---

## 6. Non-actionable turn gate — PASS (3/3)

```bash
node --experimental-strip-types test/live-validation.mjs --only 6
```

- Turn 1: real work → supervised (baseline).
- Turn 2: `tldr` → `Skipping reflection — …` in the debug log, and the judge
  prompt count is **unchanged** across that turn (checked after a 3.5 s
  settle — absence proven by counting, not by hoping).
- Turn 3: `Now add integration tests for --dry-run and run them.` → a judge
  prompt containing that text **does** appear.

Evidence: `.scratch/live-validation-evidence/s6-skip-log.txt`, `.scratch/live-validation-evidence/s6-model-calls.json`.

---

## 7. Status directive reaches the model exactly once — PASS (7/7), with a stated limit

```bash
node --experimental-strip-types test/live-validation.mjs --only 7
```

Captured at the fixture model, i.e. **on the wire** — opencode 1.18.14 does not
populate `AssistantMessage.system` over REST, so a transcript assertion would
pass vacuously.

One user turn, deliberately shaped as a multi-call turn (tool call → follow-up):

| Measurement | Value |
|---|---|
| model calls attributable to the turn | 3 |
| `experimental.chat.system.transform` fires | **3** |
| times it actually appended | 3 |
| max copies of the marker in any one system prompt | **1** |

Every model call carried the directive exactly once, marker **and** body
(`ROADMAP`, `status.md`).

**Honest limit — the part that is NOT proven live.** On this build every hook
fire received a **fresh** `output.system` array, so `appended === fired` and the
marker guard never had to suppress anything at runtime. The claim "system arrays
may be reused" (AGENTS.md, and the code comment, both measured on opencode
**1.17.9**) did **not** reproduce on **1.18.14**. What is proven live is the
guarantee that matters — the hook fires more than once per turn and the directive
still lands exactly once per call. The guard's suppression branch itself is
covered only by `test/status-directive.test.mjs`.

The unconditional entry-trace line this measurement needs
(`status-directive hook fired for …`, SUPERVISOR_DEBUG-only) was added to
`opencode/supervisor-impl.ts` as part of this work; without it, "fired" and
"appended" are indistinguishable.

Evidence: `.scratch/live-validation-evidence/s7-hook-counts.json`,
`.scratch/live-validation-evidence/s7-system-prompt-sample.txt`.

---

## 8. Empty verdict stand-down — PASS (5/5) — **found and fixed a real bug**

```bash
node --experimental-strip-types test/live-validation.mjs --only 8
```

Judge forced to return the exact shape that was once observed re-injecting
byte-identically 15× at ~20 s intervals:
`{complete:false, severity:"MEDIUM", feedback:"", missing:[], next_actions:[]}`.

**What the first run showed:**

```
Supervisor standing down, no injection: judge did not ask to continue (shouldContinue=false)
```

Nothing was injected — but for the **wrong reason**. `isActionlessVerdict` never
fired. Cause, in `opencode/supervisor-impl.ts`:

```ts
reason: verdict.feedback || "Judge analysis completed",   // blank -> placeholder
…
isActionlessVerdict({ …, feedback: analysis.reason })     // never blank, so never actionless
```

The blank-feedback arm of the guard the repo documents as *the* fix for that
15× loop was **unreachable on the opencode runtime**. It only ever mislabels the
stand-down today (the separate `!shouldContinue` branch catches the same
verdicts), but the operator-facing reason was wrong for the one case the guard
exists to name, and any future verdict shape that keeps `shouldContinue` true
with a blank body would have slipped through.

**Fix:** carry the judge's feedback through verbatim as
`SupervisorAnalysis.rawFeedback` and give the guard that, not the placeholder.
Regression test: `test/goal-lifecycle.test.mjs` →
`opencode feeds isActionlessVerdict the RAW judge feedback, not the placeholder`.

**After the fix:**

```
Supervisor standing down, no injection: verdict had no actionable content (empty missing, empty next_actions, blank feedback)
```

Plus: no `Supervisor pushed continuation` line, nothing injected into the
transcript, and the session still has **exactly one** user turn after an 8 s
wait — the window in which the old loop would have re-fired.

Evidence: `.scratch/live-validation-evidence/s8-standdown-line.txt`, `.scratch/live-validation-evidence/s8-transcript.json`.

---

## 9. State layout + legacy migration — PASS (9/9)

```bash
node --experimental-strip-types test/live-validation.mjs --only 9
```

A session created but never loaded by the plugin, then seeded by hand with the
OLD layout (`.supervisor/goals/<sid>.json` with `mode:"goal"`, an active goal,
`maxAttempts: 9`, plus `.supervisor/<sid>_attempts.json` with `count: 4`), then
driven for real.

Migrated `.supervisor/sessions/<full id>/state.json`:

```json
{
  "mode": "goal",
  "autopilot": false,
  "maxAttempts": 9,
  "goal": { "condition": "legacy goal survived the migration",
            "status": "active", "attempts": 3, "setAt": 1786061755629,
            "lastTurnKey": "user:0:Add a --verbose flag" },
  "attempts": { "count": 4, "turnKey": "legacy-turn", "lastIso": "…" },
  "projectDir": "…/proj-s9-dR0S9U"
}
```

Resulting `.supervisor/` tree — legacy files deliberately left in place
(downgrade-safe), new layout keyed on the **full** id:

```
.gc-stamp
debug.log
goals/ses_0266c6b17ffeLBqHLHub5neqCi.json
ses_0266c6b17ffeLBqHLHub5neqCi_attempts.json
sessions/ses_0266c6b17ffeLBqHLHub5neqCi/state.json
```

`.agents/supervisor/` was seeded with known content and SHA-256'd before and
after: **identical**, and contains no `sessions/` dir and no file named after the
session. Project config is not sharded and not touched.

Evidence: `.scratch/live-validation-evidence/s9-legacy-seed.json`,
`.scratch/live-validation-evidence/s9-migrated-state.json`, `.scratch/live-validation-evidence/s9-supervisor-tree.txt`.

---

# The E2E flake

## Measured before

| Condition | Result |
|---|---|
| `test/e2e-opencode.test.mjs` alone, 16 runs | **15 PASS / 1 FAIL** |
| same, 26 further runs with diagnostics | 25 PASS / 1 FAIL (a *different* failure mode) |

Both documented commands in AGENTS.md also overlapped:
`node --test test/*.test.mjs` **matches** `e2e-opencode.test.mjs`, and
`node --test` runs files **concurrently** (`availableParallelism` = 8 here). The
"unit test" command started a real `opencode serve` alongside 37 unit files, and
running the documented E2E command straight afterwards started a second one.

## Root cause 1 — cross-session attribution (this is the 1-in-16)

The failing assertion was always the same:

```
✖ /supervisor status off suppresses the directive for that session
  AssertionError: status directive was injected even though /supervisor status off was set
```

The test did:

```js
const before = fixtureLlm.getSystemPrompts().length
await sendMessage(baseUrl, session.id, "Say hello again.")
for (const s of fixtureLlm.getSystemPrompts().slice(before)) assert.ok(!s.includes(MARKER))
```

That slice is a **global, server-wide** list, and the server is concurrent. The
supervisor's background work for the **previous test's** session — specifically
its one-shot "status checkpoint missing" correction, which is injected into that
*other* session and therefore legitimately carries the directive — lands in the
slice whenever it finishes inside the ~500 ms window between capturing `before`
and asserting.

**Proven, not inferred.** Reproduced deterministically by holding the same
window open for 20 s instead of 500 ms:

```
#18 marker=true  roles=system,system,user,assistant,tool,assistant,user
    last user: "## Supervisor: Status checkpoint | The work looks complete, but the required
                status checkpoint is missing — you did not update `status.md` …"
#19 marker=true  (its tool-loop follow-up)

OFFENDERS AFTER before: 2   (the E2E asserts this must be 0)
```

Both offenders belong to session **s1**, not the session under test. Narrow the
window back to ~500 ms and the same offenders hit it roughly 1 run in 16.

**Fix:** attribute model calls to a session by **content**, not by index. Each
turn carries a unique probe string; `turnCalls()` keeps only calls whose *last*
user message is that turn (excluding the supervisor's own judge prompts, which
quote the conversation back), and `callsMentioning()` is the superset used for
the "no marker anywhere" direction. Index arithmetic cannot express "this
session"; content can.

## Root cause 2 — `waitForHealth` could not enforce its own deadline

The second failure mode, caught once with diagnostics:

```
[opencode.stdout] opencode server listening on http://127.0.0.1:57694
✖ ... 14 tests ... cancelled
✖ opencode supervisor plugin E2E (302698.288875ms)
```

The server started fine. `before()` then hung for **302 seconds** and node:test
cancelled all 14 tests. `waitForHealth` was:

```js
while (Date.now() < deadline) { try { const res = await fetch(url); … } catch {} … }
```

`fetch` with no signal blocks until the OS gives up. One stalled request
therefore defeats the `deadline` guard entirely — the loop never gets to
re-evaluate it. The 15 000 ms budget was never enforced.

**Fix:** every attempt carries its own `AbortSignal.timeout(2000)`; the overall
budget is 90 s with 100 ms → 1 s backoff. A fast boot is still detected in
~100 ms; a slow one is waited out instead of failed. (The budget bump alone
would **not** have fixed this — the deadline was unenforceable, not too small.)

## Root cause 3 — port reservation race (hardening, not observed failing)

`findFreePort()` closed the probe socket and *then* spawned. Between the two,
anything else on the machine — including a second copy of this suite under
`node --test` — could take the port. `reserveFreePort()` now holds the listener
until the moment before spawn and releases it synchronously.

## Also fixed while here

`test/helpers/opencode-fixture-llm.mjs` ran with node's default
`keepAliveTimeout` of **5 s**. undici (opencode's HTTP client) keeps that socket
pooled and sends the next request onto it, racing the close; the request fails
and the AI SDK retries with exponential backoff. Observed as a silent ~60 s
stall in the middle of a supervisor pass, with no error surfaced anywhere. Idle
timeouts are now disabled on the fixture.

## Changes

| Change | File |
|---|---|
| Content-based call attribution in both status-directive tests | `test/e2e-opencode.test.mjs` |
| Spawn/teardown/health extracted and shared | `test/helpers/live-server.mjs` (new) |
| Per-attempt `AbortSignal`, backoff, 90 s budget | `test/helpers/live-server.mjs` |
| `reserveFreePort()` (hold-until-spawn) | `test/helpers/live-server.mjs` |
| Guaranteed process-group teardown | `test/helpers/live-server.mjs` |
| Fixture keep-alive/idle timeouts disabled; optional `responder` steering hook | `test/helpers/opencode-fixture-llm.mjs` |
| `npm test` → `test/!(e2e-*).test.mjs`; `npm run test:e2e`; `npm run test:all` | `package.json` |
| Documented commands corrected + why; live-validation + E2E sections | `AGENTS.md` |
| `rawFeedback` so `isActionlessVerdict` can see a blank verdict | `opencode/supervisor-impl.ts` |
| `autopilot_exit` is a no-op outside autopilot mode | `opencode/supervisor-impl.ts` |
| Full session ids in the two "disabled" debug lines | `opencode/supervisor-impl.ts` |
| Unconditional entry trace on the status-directive hook | `opencode/supervisor-impl.ts` |
| Regression tests for the two product fixes | `test/goal-lifecycle.test.mjs` |
| 9-scenario live-validation harness | `test/live-validation.mjs` (new) |

## After the fix

```bash
for i in $(seq 1 20); do npm run test:e2e; done
```

**20 runs, 20 PASS, 0 FAIL** on the final code — the authoritative number.
(An earlier 20/20 was recorded mid-work and re-run from scratch after the last
plugin change, because a pass count taken on code that then changed proves
nothing.)

Unit suite: **601 pass / 0 fail** (`npm test`) — 599 before this work, +2
regression tests (`rawFeedback`, `autopilot_exit`).
E2E: **14 pass / 0 fail** (`npm run test:e2e`).
Live validation: **9/9 scenarios, 98/98 checks**, exit 0.

---

# What does NOT work / what is not proven

Blunt list. Nothing here is hidden in a PASS above.

1. **No real model was used. Credentials exist but were deliberately not used.**
   `~/.local/share/opencode/auth.json` has `anthropic` and `github-copilot`,
   both `type: "oauth"` — refresh tokens, not API keys. Copying them into an
   isolated `$HOME` and letting a second client refresh would risk rotating the
   user's refresh token and logging them out of their real session. That is a
   change to the user's environment, which this exercise is explicitly not
   allowed to make. So **every scenario above ran on the deterministic fixture
   model.** What that leaves unproven: *a real LLM's verdict quality*, and that a
   real provider's streaming/latency does not change the plugin's control flow.
   Everything asserted above is plugin-side and model-independent — prompt
   construction, gates, file writes, state — but "the judge gives good verdicts"
   is **not** demonstrated by this work at all.

2. **Scenario 7's array-reuse premise did not reproduce.** AGENTS.md and the code
   comment claim `experimental.chat.system.transform` may hand back a **reused**
   `output.system` array (measured on opencode 1.17.9). On 1.18.14 every fire got
   a fresh array (`fired == appended == 3`). The guard is still correct and still
   cheap, but its suppression branch is **dead at runtime on this build** and is
   only covered by a unit test.

3. **The supervisor's own injected turns' replies land in the previous human
   turn — and that is DELIBERATE, not a bug.** Visible in the pasted prompt in
   scenario 1: the agent's reply to the status-checkpoint correction
   (`Done — applied the change in src/ …`) sits inside turn 1's assistant block.
   I tried to "fix" it by suppressing replies to injected turns; that broke
   `test/task-context.test.mjs` → *"supervisor-injected messages are NEVER a turn
   in the chain"*, which explicitly asserts the post-injection work **is**
   present. The reason is sound: the agent's reply to "you didn't finish X" IS
   work on the human's original ask, and hiding it would leave the judge seeing
   only the first, incomplete attempt — a guaranteed re-injection loop. Reverted;
   the rationale is now a comment on `collectConversationTurns`. The cosmetic
   oddity in a prompt dump is the price. **Working as designed.**

4. **`autopilot_exit` silently destroyed an active goal — FIXED.** The tool is
   registered plugin-wide and is therefore in the catalog of **every** session,
   including goal-mode ones. It called `setAutopilot(false)` unconditionally →
   `setMode("reflection")` → `delete state.goal` (`core/goal.mjs:235-245`), so a
   model that called `autopilot_exit` in a goal-mode session wiped the user's
   goal with no warning and no log line. Hit for real while building scenario 9
   (the seeded legacy goal vanished mid-run). It is now a no-op outside autopilot
   mode and says so. Regression test: `test/goal-lifecycle.test.mjs` →
   *"autopilot_exit is a no-op outside autopilot mode"*.

5. **A supervisor pass can judge a turn that has no assistant reply yet.**
   `session.idle` → `runSupervisor` is deliberately delayed ~600 ms, then reads
   the transcript. If the next user turn lands inside that window, the pass
   triggered by turn *N* reads a transcript whose last user message is already
   turn *N+1*, judges *N+1* with no reply for it, and stamps `lastReflectedMsgId`
   so the real end-of-turn idle is skipped. Observed directly (scenario 1, first
   attempt: the judge prompt ended at `user: …CHARLIE` with no assistant turn).
   Needs back-to-back turns inside ~600 ms, so a human rarely triggers it — but
   an automated driver does, every time. `settleSupervisor()` works around it in
   the harness. **Not fixed in the plugin.**

10. **An occasional slow supervisor pass — partially explained, not fully
    root-caused.** I first read this as a ~60 s runtime freeze: three debug logs
    showed a ~62 s gap immediately after `Self-assessment received`, with **no**
    lines at all in between (not even the `event received:` trace that fires on
    every server event). Most of what I attributed to it turned out to be **my
    own bug**: `settleSupervisor`'s terminal-line list did not include
    `Supervisor injected status checkpoint correction`, which also `return`s out
    of the pass — so the harness waited for the *next* pass's terminal line and
    scenario 3 inflated from ~30 s to 556 s. Fixed; scenario 1 went 194 s → 23 s,
    scenario 6 137 s → 28 s on the same code.
    A residual remains: a direct probe (poll `/global/health` + the transcript
    every 500 ms for 150 s while a pass runs) saw the server answer **200 in
    1 ms on all 296 polls** and never reproduced the gap — but scenario 2 still
    took 192 s in the final green run. So: intermittent, not whole-server (health
    stays up), **not root-caused**. Do not read the earlier "62 s stall" claim as
    established.

6. **A failed `off` still mutates state.** When `action:"off"` cannot write
   `.supervisor/disabled`, the tool correctly returns `FAILED …` — but a `mode`
   sent alongside it has already been applied, and the reply says so
   (`… The supervisor is still ON. Mode also set to reflection.`). Documented
   behaviour ("both axes apply"), not a silent failure, but a partial write on an
   error path.

7. **The stock E2E never completes a full supervisor cycle.** With the shipped
   fixture, the self-assessment prompt matches none of its markers, so it falls
   through to `autopilot_exit`. The reflection loop's outcome (verdict →
   stand-down/inject) is therefore untested there. `test/live-validation.mjs`
   covers it; the E2E still does not.

8. **The "disabled" debug lines were truncated to 8 chars — FIXED.**
   `debug("Supervisor disabled for session:", sessionId.slice(0, 8))` — sessions
   minted seconds apart share that prefix (scenario 4's A and B do), so the log
   line alone could not say WHICH session was skipped. Both disabled-path lines
   now log the full id, matching what the subagent-gate lines already did.
   Scenario 4 now asserts on the full id and on B's id being absent.

9. **Runtime.** A full live-validation pass takes ~6–7 minutes wall clock
   (final green run: 398 s total; slowest scenario 2 at 192 s — see item 10). It
   is not a pre-commit gate; it is an evidence run.
