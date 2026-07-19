# Technical Design Document: agents-supervisor

## Overview

`agents-supervisor` is a meta-layer that prevents AI coding agents from stopping prematurely. It intercepts agent idle/stop events, classifies the agent's actual completion state via a self-assessment LLM call, and injects a continuation prompt when the classification indicates the agent quit early. It runs on two runtime surfaces — Claude Code (CC) and OpenCode — sharing a common classification and feedback core.

---

## Component Map

```
agents-supervisor/
├── bin/
│   └── supervisor-on-stop.mjs          # CC hook entry point (stdin → stdout)
├── opencode/
│   ├── supervisor.ts        # 3-line re-export — no logic here
│   └── supervisor-impl.ts   # OpenCode plugin (session.idle listener); ~2049 lines — all real logic lives here
├── core/
│   ├── patterns.json        # Six-category taxonomy + anti-pattern weights — Axis A, offline eval/training only (see "Two Classification Axes")
│   ├── patterns.mjs         # Pattern loader (3-tier merge: shipped → user → project) — feeds Axis A only
│   ├── judge-core.mjs       # classifyStop() — Axis A; callers are eval/train tooling only, not the live hook/plugin
│   ├── assessment.mjs       # buildSelfAssessmentPrompt/buildJudgePrompt over a Rubric{patterns,antipatterns}; parseSelfAssessmentJson
│   ├── reflection-prompt.mjs # buildReflectionPrompt — Axis B; THE live prompt builder for both runtimes (reads .agents/supervisor/*.md)
│   ├── rubric-loader.mjs    # loadRubricMarkdown/loadParsedRubric (.supervisor/rubric.md) — dead code (see "Known Dead Code")
│   ├── evaluation.mjs       # inferTaskType, evaluateSelfAssessment, detectSignals
│   ├── feedback.mjs         # buildEscalatingFeedback — the live feedback builder, shared by both runtimes
│   ├── feedback-core.mjs    # buildFeedback/injectCategories — Axis A, patterns.json-driven (see "Known Dead Code")
│   ├── goal.mjs             # goalStore, resolveMaxAttempts, decideGoalTransition
│   └── llm-client.mjs       # callAnthropic — CC-only on the live path (see Module Responsibilities)
├── .agents/supervisor/       # Git-tracked Axis B override files — shipped defaults; project copy wins per-file
│   ├── SystemPrompt.md      # Mustache-style template interpolated by buildReflectionPrompt
│   ├── Patterns.md          # Patterns/antipatterns rubric, appended verbatim after SystemPrompt.md
│   ├── User.md              # Project-specific additions, appended last (highest precedence)
│   └── Goal.md              # Project-level goal condition scaffold (## Goal Condition)
├── train/
│   ├── build_dataset.py     # Mines CC JSONL + OpenCode SQLite → XML dataset
│   ├── derive.mjs           # Derives anti-pattern weights from dataset
│   ├── update_patterns.mjs  # Writes learned weights to ~/.config/agents-supervisor/
│   ├── hf_export.mjs        # (opt-in) HuggingFace dataset export
│   └── hf_dataset.py
├── hooks/
│   └── hooks.json           # CC Stop hook declaration
└── test/
    ├── *.test.mjs           # Unit tests (core modules)
    ├── e2e-cc.mjs           # CC E2E (fake + live judge)
    ├── smoke-cc.mjs         # CC smoke (live judge: no-tests → block, tests → allow)
    └── e2e-opencode.test.mjs # OpenCode E2E against real opencode serve
```

---

## Data Flows

### Claude Code Runtime (single-stage)

1. `hooks/hooks.json` registers the Stop hook → `bin/supervisor-on-stop.mjs` runs with the event on stdin.
2. Parse stdin: `{ session_id, cwd, transcript_path, last_assistant_message, stop_hook_active?, ... }`.
3. `loopGuard` — logs a warning only; no longer exits the process (older behavior removed).
4. `sanitizeCwd`.
5. Session bookkeeping — writes `.supervisor/current_session`; checks `.supervisor/disabled` for this session id.
6. `readTranscriptTail()` — bounded transcript read (200KB / 50 entries).
7. Goal/mode resolution — `goalStore.load` + `resolveSupervisorMode`; the attempt-cap check can `process.exit(0)` here if the budget is already exhausted.
8. Autopilot fast-path — when in autopilot mode (and no loop detected), skips the judge call entirely.
9. Trailing-question guard — `endsWithTrailingQuestion` skips supervision when the agent's last message legitimately ends by asking the user something.
10. `buildTaskContextFromTranscript()` derives `{ taskType, requiresPR, requiresCI, requiresTests, requiresBuild, ... }`.
11. `buildReflectionPrompt(...)` — reads project-then-shipped `.agents/supervisor/{SystemPrompt,Patterns,User,Goal}.md`; if `SystemPrompt.md` exists, interpolates it with the template vars and appends `Patterns.md` + `User.md` verbatim. **`.supervisor/rubric.md` is never read on this path.**
12. Judge LLM call — `callAnthropic()` (`claude-haiku-4-5`, 20s timeout override; a single call, no Stage-2 fallback on CC).
13. `parseSelfAssessmentJson()` → `{status, confidence, evidence, remaining_work, next_steps, needs_user_action, stuck}` → `evaluateSelfAssessment()` → `{complete, shouldContinue, reason, missing, nextActions, requiresHumanAction, severity}` → `buildEscalatingFeedback()` (writes `.supervisor/<sid>_attempts.json`, `.supervisor/verdict_<sid>.json`) → stdout `{decision:"block", reason}` to block, or nothing to allow.

### OpenCode Runtime (two-stage — a real architectural difference from CC, not a doc artifact)

1. `session.idle` event → `opencode/supervisor.ts` (3-line re-export) → `opencode/supervisor-impl.ts` (2049 lines) → `runSupervisor(sessionId)`.
2. Guards/dedup — `isSessionDisabled`, `isJudgeSession` + `isPlanMode`, last-relevant-user-message-id dedup (`lastReflectedMsgId`).
3. `buildTaskContext()` — async twin of CC step 7 (`buildTaskContextFromTranscript()`).
4. `loadSupervisorPrompt(directory)` — **OpenCode-only, no CC equivalent.** Reads `.supervisor.md`/`supervisor.md` from the project root. A whole-prompt override; wins outright over everything else if present.
5. `loadRubric(directory)` — reads `.supervisor/rubric.md` → `~/.config/opencode/supervisor/rubric.md` → embedded `DEFAULT_RUBRIC`. **This is OpenCode's own, independently-implemented loader — it is NOT `core/rubric-loader.mjs`**, and it targets a different global config path (`~/.config/opencode/supervisor/` vs. the dead loader's `~/.config/agents-supervisor/`).
6. Project `Goal.md` read (reflection mode, no active goal) + autopilot fast-path.
7. `buildReflectionPrompt(...)` — the same shared function CC uses, producing `defaultSupervisorPrompt`. Does **not** receive step 5's rubric as an argument.
8. Precedence resolution (`resolveSupervisorPromptPrecedence`) — step 4's file wins outright; else tool-guidance is appended to `defaultSupervisorPrompt`; else `defaultSupervisorPrompt` alone.
9. Stage 1 LLM call — fresh ephemeral session (`client.session.create` / `promptAsync` / `waitForResponse`).
10. `parseSelfAssessmentJson()` parses (the common case) → `evaluateSelfAssessment()`. **Step 5's rubric is discarded, unused, on this path.**
11. If parsing fails (uncommon): Stage 2 LLM call — `analyzeSelfAssessmentWithLLM()` → `buildJudgePrompt(context, selfAssessment, toolGuidance, rubric)`, in a second fresh ephemeral judge session. **This is the only place anywhere in the codebase where `rubric.md` content actually reaches an LLM prompt.**
12. Goal transition (`decideGoalTransition`), optional cross-model review (gated on `sup.autoreview === true`), routing classification (logged only — never switches the active session's model).
13. Writes verdict/attempts; if continuing, `buildEscalatingFeedback()` (same shared function as CC) → `client.session.promptAsync()` into the ORIGINAL session.

---

## Two Classification Axes

The codebase contains two entirely separate classification mechanisms that both produce something that looks like a "verdict." This is easy to miss reading the code bottom-up, so it's stated here once, prominently, up front: **Axis A does not gate any live inject/no-inject decision today.** Axis B is the only thing the live Stop hook / `session.idle` plugin ever actually consults.

| | Axis A | Axis B |
|---|---|---|
| Source | `core/patterns.json` — six-category taxonomy + anti-pattern weights | `.agents/supervisor/{SystemPrompt,Patterns,User,Goal}.md` — shipped defaults, project copy wins per-file |
| Loader | `core/patterns.mjs` — 3-tier merge: shipped → `~/.config/agents-supervisor/patterns.json` (user) → `.supervisor/patterns.json` (project, gitignored) | `core/reflection-prompt.mjs`'s `buildReflectionPrompt()` |
| Output shape | `{category, reason, confidence, raw_text, usage}` (one of six categories) | `{status, confidence, evidence, remaining_work, next_steps, needs_user_action, stuck}` (a status enum) |
| Consumers | `core/judge-core.mjs` (`classifyStop`), `core/feedback-core.mjs` (`buildFeedback`/`injectCategories`) | `bin/supervisor-on-stop.mjs` (CC), `opencode/supervisor-impl.ts` (OpenCode) |
| Actual callers | `evals/judge-eval.mjs`, `train/classify-bulk.mjs` — offline CLI tools only | Every live agent session, both runtimes |

Confirmed by full-repo grep: neither `bin/supervisor-on-stop.mjs` nor `opencode/supervisor-impl.ts` references `patterns.json`, `patterns.mjs`, or `loadPatterns` at all. Axis A is confined entirely to offline evaluation and training tooling.

---

## Known Dead Code

| Module | Status |
|---|---|
| `core/rubric-loader.mjs` (`loadRubricMarkdown`, `loadParsedRubric`) | Zero production callers on either runtime — confirmed by full-repo grep. Its only reference anywhere is its own unit test, `test/rubric-injection.test.mjs`. Reads `.supervisor/rubric.md` → `~/.config/agents-supervisor/rubric.md`, but nothing in `bin/supervisor-on-stop.mjs` or `opencode/supervisor-impl.ts` imports it. |
| `core/feedback-core.mjs` (`buildFeedback`, `injectCategories`) | `buildFeedback` has zero callers outside its own unit test (`test/core.test.mjs`) — fully dead. `injectCategories` has exactly one non-test caller: `bin/status.mjs`, which uses it to print configured inject categories for `/supervisor:status` — a read-only display that gates nothing. |

Neither module is reachable from a real agent session today. `rubric-loader.mjs` matters beyond tidiness — see "Planned: Reflection File Consolidation" below: its intended niche (a project-local `.supervisor/rubric.md` override on Claude Code) is currently silently unenforced.

---

## Planned: Reflection File Consolidation

Today there are three separate, non-unified rubric/pattern override mechanisms in play:

1. **Axis A's `patterns.json` 3-tier merge** (`core/patterns.mjs`) — shipped → user → project. Offline-only (see Two Classification Axes above).
2. **Axis B's `.agents/supervisor/*.md`** (`core/reflection-prompt.mjs`) — shipped → project, per file. Live on both runtimes.
3. **Two separate legacy `.supervisor/rubric.md` loaders, one per runtime:**
   - CC's `core/rubric-loader.mjs` — dead (see Known Dead Code above).
   - OpenCode's own `loadRubric()` in `opencode/supervisor-impl.ts` — a separate, independently-implemented function targeting a *different* global config path than the dead CC loader. It IS wired up, but per the OpenCode Data Flow above, the rubric it loads only reaches an LLM on the uncommon Stage-2 fallback path — silently discarded on the common path.

These two loaders are easy to assume are "the same mechanism, one per runtime." They are not: different implementations, different config paths, and only one of the two is ever called from anywhere.

**The plan:** retire both `.supervisor/rubric.md` loaders and Axis A's role in live gating, consolidating everything onto Axis B (`.agents/supervisor/*.md`) as the single override path for both runtimes.

**Live prerequisite — not hypothetical.** The sibling repo `OpenClawBot` (a separate Telegram-bot project that installs this plugin, confirmed running this exact branch in production) has real, git-tracked `.supervisor/rubric.md` content: a cluster-deploy-identity guard, a claimed-vs-verified guard, and a merged-vs-deployed guard — all safety-relevant for a bot that deploys to a live Kubernetes cluster. That content is currently **inert under Claude Code** (`core/rubric-loader.mjs` has zero callers) — these guardrails are silently not being enforced right now. OpenClawBot's own `.agents/supervisor/Patterns.md` / `User.md` / `SystemPrompt.md` do not exist yet — only an unrelated `Goal.md` is present.

Retiring the legacy loader before migrating that content into OpenClawBot's own `.agents/supervisor/Patterns.md` would turn a silent gap into a permanent one. That migration touches a different repository and is out of scope for this repo's own changes — it is a **blocking prerequisite** for the consolidation, not something this repo can complete unilaterally.

---

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `patterns.json` | Six-category classification taxonomy + dataset-mined anti-pattern weights. **Axis A only** — consumed by `judge-core.mjs`/`feedback-core.mjs`, which are in turn only called by offline eval/training tooling (see Two Classification Axes). Not read by the live hook or plugin. |
| `patterns.mjs` | Three-tier deep merge: shipped → `~/.config/agents-supervisor/patterns.json` → `.supervisor/patterns.json`. Project-local patterns override user-local, which override shipped. Feeds Axis A only. |
| `judge-core.mjs` | Builds and executes the Axis A classification prompt (`classifyStop`). Callers: `evals/judge-eval.mjs`, `train/classify-bulk.mjs` — offline tooling only. |
| `assessment.mjs` | Builds `buildSelfAssessmentPrompt`/`buildJudgePrompt` from a `Rubric {patterns, antipatterns}` object (parsed from markdown via `parseRubric`, not from `patterns.json`). `parseSelfAssessmentJson` does a generic `{...}` extraction + `JSON.parse` — returns whatever shape the model emitted, in practice `{status, confidence, evidence, remaining_work, next_steps, needs_user_action, stuck}` on the live path (a different shape from Axis A's `{category, confidence}`). |
| `reflection-prompt.mjs` | `buildReflectionPrompt()` — **Axis B, the live prompt builder for both runtimes.** Reads project-then-shipped `.agents/supervisor/{SystemPrompt,Patterns,User,Goal}.md`; interpolates `SystemPrompt.md` and appends `Patterns.md` + `User.md`. Falls back to `assessment.mjs`'s hardcoded `DEFAULT_RUBRIC` only if no `SystemPrompt.md` is found at all (shipped or project). |
| `rubric-loader.mjs` | `loadRubricMarkdown`/`loadParsedRubric` — reads `.supervisor/rubric.md` → `~/.config/agents-supervisor/rubric.md`. **Dead code** (see Known Dead Code): zero production callers, only exercised by its own test. Not the same mechanism as OpenCode's own `loadRubric()` in `supervisor-impl.ts` (different global path — and that one IS called). |
| `evaluation.mjs` | Infers task type from transcript signals (`coding/docs/research/ops/other`). `evaluateSelfAssessment` turns a parsed self-assessment into `{complete, shouldContinue, reason, missing, nextActions, requiresHumanAction, severity}`. Detects planning loops, action loops, local test commands, default-branch pushes. |
| `feedback.mjs` | `buildEscalatingFeedback` — the live continuation-feedback builder, shared by both runtimes. One consistent tone/template regardless of attempt count (attempt count affects displayed budget text, not tone); separate fixed templates for detected planning loops and action loops. Rewrites destructive actions (force-push, `reset --hard`, `rm -rf`, history rewrites, branch deletion) into an approval flag rather than a nudge. |
| `feedback-core.mjs` | `buildFeedback`/`injectCategories` — Axis A's per-category feedback templates, driven by `patterns.json`. **Dead in the live gating path**: `buildFeedback` has zero non-test callers; `injectCategories`'s only non-test caller is `bin/status.mjs`'s read-only `/supervisor:status` display (see Known Dead Code). |
| `goal.mjs` | Manages goal state: sets goal + `maxAttempts=16`, evaluates per-stop as `achieved | continue | exhausted`. No inject on terminal states. |
| `llm-client.mjs` | `callAnthropic` — raw Anthropic Messages API call, 30s default timeout (callers override: CC's Stop hook passes 20s, Axis A's `judge-core.mjs` passes 15s). **CC-only on the live path** — OpenCode never imports this module; all of its LLM calls (self-assessment, Stage-2 judge, cross-model review) go through the OpenCode SDK's own ephemeral `client.session.*` mechanism instead. |

---

## Classification Taxonomy

**Axis A only** (see Two Classification Axes above). This is the taxonomy in `core/patterns.json`, consumed solely by `core/judge-core.mjs`'s `classifyStop()` — the offline eval/training classifier. It is **not** consulted by the live Stop hook / `session.idle` plugin; those call `buildReflectionPrompt()` (Axis B) instead, whose output is a `status` enum, not one of the six categories below.

Six categories govern Axis A's inject/no-inject decisions:

| Category | Action |
|---|---|
| `complete` | No inject — task is done |
| `waiting_for_user_legitimate` | No inject — genuinely blocked on human input |
| `working` | No inject — agent stopped mid-action (rare) |
| `tool_available_punt` | Inject — agent gave up without trying available tools |
| `summary_drift_stop` | Inject — agent summarized instead of completing |
| `genuinely_stuck` | Inject — agent is stuck but has not exhausted retry options |

---

## State Model

All state lives under `.supervisor/` in the project working directory, plus one user-global location:

| File | Contents | Mode |
|---|---|---|
| `.supervisor/goals/<sessionId>.json` | `{ goal, maxAttempts, attempts, autopilot }` | 0600 |
| `.supervisor/<sid>_attempts.json` | Attempt/turn-key bookkeeping, written by `buildEscalatingFeedback`'s caller (CC runtime) | — |
| `.supervisor/verdict_<sid>.json` | Last classification verdict (CC runtime) | — |
| `.supervisor/disabled` | Per-session disable flag (OpenCode runtime) | — |
| `~/.config/agents-supervisor/patterns.json` | User-local learned pattern weights (written by trainer) | — |
| `.dataset/` | Training data (gitignored; CI guard enforced) | — |

Goal mode sets `maxAttempts=16`. Autopilot mode stores `{ autopilot: true }` in the same goals file. Autopilot exits when the agent calls the `autopilot_exit` tool or the attempt budget exhausts.

---

## Key Constraints & Invariants

1. **CC stdout contract.** `supervisor-on-stop.mjs` must write `{ decision: "block", reason }` to stdout to block, or produce no stdout to allow. Side effects are limited to `.supervisor/` file writes.

2. **OpenCode promptAsync body.** `client.session.promptAsync` must never include a `.model` field. Enforced by `no-model-switch-integration.test.mjs`. Violating this would switch the active session model mid-run.

3. **Judge session exclusion.** OpenCode skips supervision for sessions created by the supervisor itself (ephemeral judge sessions). Without this guard, the supervisor would recursively supervise its own judge calls.

4. **Privacy / dataset isolation.** `.dataset/` is gitignored. CI has a guard that fails the build if JSONL or transcript files appear in tracked git state.

5. **Pattern merge order.** Shipped patterns are always the base. User-local overrides are applied next. Project-local overrides have highest precedence. Deep merge — individual rules can be overridden without replacing the full taxonomy.

6. **Attempt budget.** Goal mode caps at 16 attempts. Non-goal mode caps are resolved via `resolveMaxAttempts`. Both paths check the budget before injecting; exhausted budget → no inject, no block.

---

## Testing Strategy

| Suite | Scope | Notes |
|---|---|---|
| `test/*.test.mjs` | Unit — core modules in isolation | Fast; no network; covers classification logic, pattern loading, feedback escalation, goal transitions |
| `test/e2e-cc.mjs` | E2E — full CC hook pipeline | Fast path uses fake judge. Set `SUPERVISOR_CC_LIVE=1` for real Anthropic API calls. |
| `test/smoke-cc.mjs` | Smoke — live judge behavioral contract | Asserts no-tests case produces `block`, tests-ran case produces allow. Requires live API key. |
| `test/e2e-opencode.test.mjs` | E2E — OpenCode plugin against real `opencode serve` | Auto-discovers a free model. Verifies end-to-end idle → classify → inject flow. |

The test pyramid is deliberately lightweight at the integration layer: the shared `core/` modules handle all classification logic and are fully unit-tested. Runtime-surface tests (`e2e-cc`, `e2e-opencode`) verify the wiring, not the classification decisions.
