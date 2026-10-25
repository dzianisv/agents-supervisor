# Supervisor misfire forensics — real sessions, last 30 days

Generated 2026-08-06. Read-only analysis. No code changed.

## Method

- **OpenCode**: direct SQLite read of `~/.local/share/opencode/opencode.db`
  (tables `session` / `message` / `part`), window `time_created > 1783407600000`
  (2026-07-07 → 2026-08-06).
- Markers used (literals from `core/evaluation.mjs:5-6`):
  - `FEEDBACK_MARKER = '## Supervisor:'`
  - `SELF_ASSESSMENT_MARKER = '## Supervisor Self-Assessment'`
  - autopilot: `Autopilot (`, `autopilot_exit`
- **Claude Code**: `rg` over all `~/.claude/projects/**/*.jsonl` (27,080 files
  modified in the last 30 days).

### Population

| Metric | Count |
|---|---|
| `## Supervisor:` injections (OpenCode, 30d) | **962** |
| ...into **subagent** sessions (`session.parent_id IS NOT NULL`) | **633 (66%)** |
| ...into top-level user sessions | 329 (34%) |
| `Autopilot (` nudges | 75 |
| `supervisor` tool calls with `action:"off"` | 5 |
| **Claude Code injections found** | **0** |

Injections by project directory:

```
339  OpenClawBot                105  opencode-mobile        102  vibebrowser
 87  OpenClawBot/.worktrees/*    79  backtest                75  AgentPodMobile
 61  KineticAiCoach              39  TaroAiScanner           31  agents-supervisor
 17  rfs   11 /Users/engineer   10  mkt-alerts    9  vt-platform    8  (external vols)
```

---

## Summary table

| Classification | Count | Worst example |
|---|---:|---|
| **FALSE_INCOMPLETE** (supervisor's own 4000-char slice mis-read as agent truncation) | **169** | `vibebrowser` / `ses_07004dd4bffeDsHbB8vJAOgEyl` — "cut off at `${VIBE_API_U`" is literally byte 4000 of a complete 5877-char report |
| **SUBAGENT_SCOPE** (injected into a delegated child session that has no human) | **633** (375 not otherwise classified) | `vibebrowser` / `ses_070a978faffe4cg4nVUsR8yh9N` — read-only SEO audit subagent pushed to open a PR and pull Stripe/GA4 creds |
| **STALE_GOAL** (cites MANDATORY/session GOAL unrelated to current ask) | **95** | `vibebrowser` / `ses_070a978faffe4cg4nVUsR8yh9N` — "$1,000 MRR growth" injected into an SEO metadata audit |
| **LOOP** (identical content-free verdict repeated) | **38** | `opencode-mobile` / `ses_06f0159c9ffe1K701cjV7U6FMA` — same 1-line message **15×** at 20 s intervals over 4.7 min |
| **WRONG_DIRECTION** (overrode an explicit human stop/question) | ~12 hand-verified | `OpenClawBot` / `ses_06cde9dddffeI2A11kMn5eiUCO` @ `1785128879874` — user said "**Stop. Reflect.**", supervisor demanded a **prod canary provision + feature-flag flip** 66 s later |
| **OFF_IGNORED** (supervisor kept injecting after `/supervisor off`) | **3 of 5** off-attempts | `OpenClawBot` / `ses_02c9e0c82ffeP0P0y2jTQ80TPB` — 3 injections, first **+25 s** after the user ran `/supervisor off` |
| **STALE_TASK** (Missing list = abandoned earlier topic) | ~40 (0-token-overlap sample) | `mkt-alerts` / `ses_0726f33edffeaheBOml5Dpdexs` — user said "open the PR, build, deploy"; supervisor demanded "commit PRD.md and TDD.md" |
| OTHER | 285 | — |

Classification is heuristic on the injection text (regex over `### Missing`
plus `session.parent_id`); the "worst example" rows are all hand-verified
against the full transcript.

---

## Top 5 bugs by real-world impact

### 1. `/supervisor off` is a silent no-op 60% of the time — `mode` swallows `action`

**Impact:** the user's #1 reported complaint. Confirmed reproducible.

**Evidence — every `action:"off"` tool call in 30 days:**

| ts | session | dir | input | output |
|---|---|---|---|---|
| 1784884583618 | `ses_06cab2fd5…` | OpenClawBot | `{"mode":"autopilot","action":"off",…}` | **"mode set to autopilot"** ← asked OFF, got the *most* aggressive mode |
| 1785362553989 | `ses_05051de95…` | backtest | `{"action":"off","mode":"reflection",…}` | **"mode set to reflection"** ← no-op |
| 1785369989169 | `ses_04fa80648…` | backtest | `{"action":"off","mode":null,…}` | "Supervisor **disabled**" ✅ |
| 1785995352629 | `ses_02c9e0c82…` | OpenClawBot | `{"action":"off","mode":"reflection",…}` | **"mode set to reflection"** ← no-op |
| 1786002908136 | `ses_02a2a1ece…` | agents-supervisor | `{"action":"off","mode":null,…}` | "Supervisor **disabled**" ✅ |

Correlation with post-off injections is perfect:

| off-call | persisted? | injections after |
|---|---|---|
| `ses_06cab2fd5…` (mode:autopilot) | ✗ | 1 |
| `ses_05051de95…` (mode:reflection) | ✗ | 1 (+79 s) |
| `ses_02c9e0c82…` (mode:reflection) | ✗ | **3** (+25 s) |
| `ses_04fa80648…` (mode:null) | ✓ | **0** |
| `ses_02a2a1ece…` (mode:null) | ✓ | **0** |

**Root cause — `opencode/supervisor-impl.ts:1509-1519`:**

```ts
const requestedMode = args.mode?.trim().toLowerCase()
if (requestedMode === "autopilot") { … return … }
if (requestedMode === "reflection") {
  await supervisorStore.setMode(directory, sid, "reflection")
  return `Supervisor mode set to reflection …`      // ← returns
}
const action = (args.action || "status").trim().toLowerCase()   // ← NEVER REACHED
```

`mode` is checked **before** `action` and early-returns. The zod fields are
declared `.optional()` (`supervisor-impl.ts:1833-1837`), but the schema that
reaches the model serialises as
`"required": ["mode","action","condition","clear","n"]` — verified in the live
tool manifest of this very session. So the model is **forced** to emit `mode`,
picks `"reflection"` (or worse, `"autopilot"`) as a filler, and `action:"off"`
is discarded.

The tool then returns a success-shaped string, so the agent tells the user
*"Supervisor is off for this session."* — a lie it inferred from a call that
did nothing (`ses_02c9e0c82ffeP0P0y2jTQ80TPB`, `msg_fd59e5ef7001kpUMmMcoUWByqw`).

Fixes: (a) make `action` take precedence over `mode`, or handle both in one
call; (b) treat `mode: ""`/`"reflection"` as "unset" when `action` is
non-empty; (c) emit a real optional JSON schema so filler args stop appearing.

---

### 2. The judge blames the agent for the supervisor's own truncation — 169 injections (17.6%)

**Impact:** highest-volume *content* bug. Every one of these is a false
"Task Incomplete" that made a finished agent redo work.

**Root cause — `core/assessment.mjs:108-110`:**

```js
const assistantSection = lastAssistantText
  ? `\n## Agent's Last Response\n${lastAssistantText.slice(0, 4000)}\n`
  : ''
```

`slice(0, 4000)` with **no truncation marker**. The judge sees a message ending
mid-word and correctly reports "the response is truncated" — but the truncation
is ours.

**Byte-exact proof.** For each case below, `asst_len` is the real length of the
agent's last message and the quoted claim is the supervisor's; `a[3960:4040]`
is the actual text straddling offset 4000:

| session | asst_len | supervisor claim | actual text at offset 4000 |
|---|---:|---|---|
| `ses_07004dd4bffeDsHbB8vJAOgEyl` (vibebrowser) | 5877 | "cut off at `${VIBE_API_U`" | `…\`${VIBE_API_URL}/api/analytics/collect\`…` |
| `ses_0727c5059ffehVT84oj8cf8OZK` (AgentPodMobile) | 11763 | "truncated at `imagePullPo…`" | `…\`imagePullPolicy: Never\` (locally-built)…` |
| `ses_072313bb7ffe5KreYV7ZCEXoJu` (AgentPodMobile) | 5157 | "ends mid-sentence at `1. Internal testing -> Testers -> crea`" | `… list, add tester Gmail addresses, save.` |
| `ses_07251afc3ffeyUOaZckZGEHGhv` (vibebrowser) | 7926 | "file listing incomplete (#20 cuts off at path)" | `…/docs/launch/.supervisor/current_session\`…` |

Every one of these assistant messages ends in a complete sentence with a
period. Nothing was truncated by the agent.

Secondary defect in the same path: two different extractors disagree.
`extractLastAssistantText` (`supervisor-impl.ts:1082-1092`) returns the **first**
text part; `buildTaskContext` (`supervisor-impl.ts:1016-1021`) keeps the **last**
text part. Multi-part assistant messages lose content either way.

---

### 3. Supervisor fires inside subagent sessions — 633 of 962 injections (66%)

**Impact:** two-thirds of all supervisor traffic goes to sessions the human
never sees, where the "user" is a scoped delegation prompt, not a person.
Causes token burn, scope creep, and every loop in §4.

**Evidence — `vibebrowser` / `ses_070a978faffe4cg4nVUsR8yh9N`**
(`parent_id = ses_07251cbd2ffePXytaiZ77gSBRu`, title *"SEO audit product page
(@general subagent)"*), t=`1784816323367`:

- **Delegated task:** *"Audit SEO metadata … This is READ + REPORT +
  minimal-fix."*
- **Agent did:** full 12-row audit table with file:line, live curl checks. Done.
- **Supervisor injected:** *"the MANDATORY session GOAL ($1,000 MRR growth for
  VibeBrowser) is NOT met… No live-data grounding surfaced (Stripe MRR, CWS
  installs, GA4, LiteLLM)… Founder gate: approve merge of the OG-image and
  sitemap fix PR"*
- **Result:** the subagent left read-only scope, created a branch, rasterised
  an image, and **opened PR #181**. It then wrote back:
  *"Supervisor conflates two things… The $1k MRR goal is not achievable by an
  SEO audit."*

Top offenders by injection count (all `parent_id IS NOT NULL`):

```
15  opencode-mobile   Triage GitHub health (@general subagent)
15  opencode-mobile   Audit live project state (@general subagent)
15  opencode-mobile   Audit engineering queues (@general subagent)
 9  agents-supervisor Mine sessions for supervisor misfires (@general subagent)
```

**Root cause:** `runSupervisor` (`supervisor-impl.ts:1900-1946`) gates on
`isJudgeSession`, `isPlanMode`, and `.supervisor/disabled` — but **never checks
`session.parent_id`**. `grep -n "parent_id\|parentID\|isSubagent"
opencode/supervisor-impl.ts core/*.mjs` returns nothing relevant
(only an unrelated comment at `supervisor-impl.ts:2452`).

---

### 4. Content-free verdict loops to the retry cap — 38 injections, 15× in one session

**Evidence — `opencode-mobile` / `ses_06f0159c9ffe1K701cjV7U6FMA`** (subagent,
*"Audit live project state"*). 15 byte-identical injections, gaps
`[19,19,20,20,20,20,20,20,20,19,20,20,20,20]` seconds, 4.7 minutes total:

```
## Supervisor: Task Incomplete (MEDIUM)
The supervisor could not obtain a strong self-assessment verdict; continue with the next actionable step.

Please address these issues and continue.
```

No `### Missing`, no `### Next Actions`. Zero information. Same pattern in
`ses_06e254ebaffeEreE5xCn7VrxTc` (15×) and `ses_0715e086bffe4egcoguh3RYXgS` (7×).

**Root cause:** the failure branch of the self-assessment/judge pipeline emits a
`shouldContinue: true` verdict with an empty `missing` array instead of bailing
out. `core/assessment.mjs:113` / `core/feedback.mjs:51` clamp to
`DEFAULT_MAX_ATTEMPTS = 16` (`core/goal.mjs:18`) — which is exactly the 15
injections + 1 observed. Nothing short-circuits on "verdict had no content".
The string itself is not in HEAD, so it comes from a shipped older build — but
the structural hole (empty verdict → still continue → burn 16 attempts) is
still there.

---

### 5. Stale goals and stale tasks override the live human turn

**Impact:** this is the "pushes the agent in the wrong direction" complaint.
95 goal-citing injections; the worst override an explicit human STOP.

**5a — WRONG_DIRECTION, `OpenClawBot` / `ses_06cde9dddffeI2A11kMn5eiUCO`, t=`1785128879874`**

| | |
|---|---|
| User asked (t=1785128813690) | *"Stop. Reflect. What is wrong with you. Why feature is not delivered in 2 days?"* |
| Agent did | a genuine 5-point retrospective — exactly the ask |
| Supervisor injected (+66 s) | *"Run the Max+Hermes LXD canary provision end-to-end **against prod** now… Flip HERMES_PRIMARY_CHOICE_ENABLED so the picker is actually live"* |
| Agent's next words | *"No more asking. Running it."* |

The supervisor cancelled a human "Stop" and pushed a production mutation.

**5b — STALE_GOAL on a delivered turn, `vibebrowser` / `ses_06f9582cbffesLXyB1eOJWYwZ9`, t=`1784838409756`**
User: *"why did you stop . answer short"* → supervisor replied with a
6-item mandatory-GOAL missing list about anon-key minting.

**5c — STALE_TASK, `mkt-alerts` / `ses_0726f33edffeaheBOml5Dpdexs`, t=`1784791885288`**
User: *"open the PR, run the full next build, and proceed to deploy. Report PR
link + deploy status."* → supervisor: *"Commit PRD.md and TDD.md … the
mandatory GOAL requires these artefacts"*. Zero token overlap with the ask.

**5d — STALE_TASK on a 3-word clarification, `OpenClawBot` / `ses_06cde9dddffeI2A11kMn5eiUCO`, t=`1784916885135`**
User: *"for Max clients*"* → supervisor: 4-item merge/approve/cleanup list.

**Root cause (two parts):**

1. `buildTaskContext` (`supervisor-impl.ts:1002-1030`) concatenates **every**
   user message in the session into `taskSummary`
   (`humanMessages.map((msg,i) => "[i] "+msg).join("\n\n")`). There is no
   recency weighting and no "the current turn is the one that matters" signal,
   so a 20-turn session's judge sees turn 1 with the same weight as turn 20.
2. `resolveProjectGoalForSession` (`supervisor-impl.ts:113-116`) reads
   `.agents/supervisor/Goal.md` from the session's project and injects it as a
   MANDATORY requirement on **every** idle, regardless of what the human just
   asked. `vibebrowser/.agents/supervisor/Goal.md` still holds the "$1,000 MRR"
   condition — a business outcome no single turn can satisfy, so it fires
   forever. There is no expiry, no relevance check against the current turn,
   and no "the user changed topic" reset.

There is also **no gate for non-actionable turns**: a question ("why did you
stop", "I think this is opencode plugin?"), a `tldr` request, or a "Stop.
Reflect." all run the full completion judge as if they were work orders.

---

## The OFF bug — definitive verdict

> **Is the `/supervisor off` failure caused by a reproducible path mismatch
> between plugin `directory` and `resolveSessionDirectory`?**
>
> ## **NO.**

The path-mismatch hypothesis is **not supported by the evidence**. The real
cause is the `mode`-before-`action` early return described in bug #1.

### Evidence against path mismatch

**The failing session is in NO disabled file, anywhere.** For
`ses_02c9e0c82ffeP0P0y2jTQ80TPB` (OpenClawBot — 3 injections after the user ran
`/supervisor off`):

```
$ find /Users/engineer -maxdepth 5 -path '*/.supervisor/disabled' | xargs grep -l 02c9e0c82
(no matches)
```

Every disabled file on the machine:

```
/Users/engineer/workspace/rfs/.supervisor/disabled                     (empty)
/Users/engineer/workspace/OpenClawBot/.supervisor/disabled             ses_074c0164cffeH99cCsUVwKu5uY
/Users/engineer/workspace/agents-supervisor/.supervisor/disabled       855b2da0…, ed818200…, 18575874…,
                                                                       c87861a9…, ses_05051de95…, ses_02a2a1ece…
/Users/engineer/workspace/backtest/.supervisor/disabled                5909789b…, 8706b942…, e820e4c3…, 93ca6093…,
                                                                       96e1d47a…, af0d9a4b…, dd26590e…,
                                                                       ses_04fa80648…, ses_05051de95…
/Users/engineer/workspace/vibebrowser/VibeBrowserProductPage/.supervisor/disabled   e4ad79dc…
/Users/engineer/workspace/vibebrowser/vibe/.supervisor/disabled        377e221f…, 296fdaa4…
/Users/engineer/workspace/spark/.supervisor/disabled                   96d24279…
```

If it were a path mismatch, the ID would be present in *some* directory — just
the wrong one. It is present in **none**. The write never executed, because
`setSessionDisabled` was never called: `executeSupervisorToggle` returned at
the `mode === "reflection"` branch (`supervisor-impl.ts:1514-1517`).

### Session-ID match check

The user's request asked whether the ID written into the disabled file matches
the session that kept getting injected. For all three failures the answer is
**there was no ID written at all**. For the two successes
(`ses_04fa80648…`, `ses_02a2a1ece…`) the ID written matches the session exactly
and **zero** injections followed.

### There IS a real dual-write artifact — but it is benign today

`ses_05051de95ffeWsHASEr2bckvrs` appears in **two** files:

- `/Users/engineer/workspace/backtest/.supervisor/disabled` (its actual
  `session.directory`)
- `/Users/engineer/workspace/agents-supervisor/.supervisor/disabled` (the
  `opencode serve` cwd)

That is direct evidence the two resolution paths diverge:
`setSessionDisabled` writes to `sessionDir || directory`
(`supervisor-impl.ts:1435-1439`), where `sessionDir` comes from
`resolveSessionDirectoryFor` → `resolveSessionDirectory(messages, directory)`
(`core/session-context.mjs:57`), which falls back to the plugin `directory`
when the session has no assistant message carrying `info.path.cwd` yet. Early
in a session you get the server cwd; later you get the real project.

It does not currently break the idle path, because `isSessionDisabled`
(`supervisor-impl.ts:1417-1430`) checks **both** locations.

### Latent path-mismatch risk (not yet observed in the data)

`shouldInjectStatusDirective` (`supervisor-impl.ts:1468-1478`) reads
`sessionDirCache.get(sessionID)` — an **in-memory** map populated only by
`runSupervisor`/`resolveSessionDirectoryFor`. After an `opencode serve` restart
the cache is empty, so `isSessionDisabled` is called with
`sessionDir === undefined` and only the server-cwd file is consulted. A session
disabled into its own project directory would then have the status directive
re-injected. Real-world impact today: **0 observed cases** (the status directive
is a new, mostly-uncommitted feature). Fix it before it ships.

---

## Claude Code — no evidence of any supervisor activity

`supervisor@agents-supervisor` is enabled in `~/.claude/settings.json:17` with
`path: /Users/engineer/workspace/agents-supervisor`, yet:

```
$ rg -l "Supervisor Self-Assessment|autopilot_exit" -g '*.jsonl' ~/.claude/projects
(no matches)
$ rg -l "## Supervisor:" -g '*.jsonl' ~/.claude/projects | wc -l
0
```

across 27,080 transcripts touched in the last 30 days, spanning 15 projects
including OpenClawBot, agents-supervisor, backtest, AgentPodMobile.

**Verdict: the Claude Code integration produced zero injections in 30 days.**
Either the hook is not firing, or it writes nothing into the transcript. Either
way, none of the bugs above can be reproduced there, and the CC path is
effectively untested in production. Worth a separate investigation — but do not
assume it is "working quietly".

---

## Claims checked and NOT supported

| Claim | Verdict |
|---|---|
| `/supervisor off` fails because of a `directory` vs `resolveSessionDirectory` path mismatch | **NOT SUPPORTED** — the ID is absent from every disabled file; the write never runs. Real cause is `mode`-before-`action`. |
| Supervisor ignores `.supervisor/disabled` when it is correctly written | **NOT SUPPORTED** — both correctly-persisted off-calls produced 0 subsequent injections. |
| Autopilot nudges are a major misfire source | **NOT SUPPORTED at scale** — only 75 in 30 days vs 962 feedback injections; no loop or wrong-direction pattern found in them. |
