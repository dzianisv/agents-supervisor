# Technical Design Document: agents-supervisor

## Overview

`agents-supervisor` is a meta-layer that prevents AI coding agents from stopping prematurely. It intercepts agent idle/stop events, classifies the agent's actual completion state via a self-assessment LLM call, and injects a continuation prompt when the classification indicates the agent quit early. It runs on two runtime surfaces — Claude Code (CC) and OpenCode — sharing a common classification and feedback core.

---

## Component Map

```
agents-supervisor/
├── bin/
│   └── on-stop.mjs          # CC hook entry point (stdin → stdout)
├── opencode/
│   └── supervisor.ts        # OpenCode plugin (session.idle listener)
├── core/
│   ├── patterns.json        # Shipped classification taxonomy + anti-pattern weights
│   ├── patterns.mjs         # Pattern loader (3-tier merge: shipped → user → project)
│   ├── judge-core.mjs       # Runtime-agnostic stop-classification prompt runner
│   ├── assessment.mjs       # buildSelfAssessmentPrompt, parseSelfAssessmentJson
│   ├── evaluation.mjs       # inferTaskType, evaluateSelfAssessment, detectSignals
│   ├── feedback.mjs         # buildEscalatingFeedback (tone escalation over attempts)
│   ├── feedback-core.mjs    # Feedback primitives
│   ├── goal.mjs             # goalStore, resolveMaxAttempts, decideGoalTransition
│   └── llm-client.mjs       # callAnthropic (judge LLM call, 30s timeout)
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

### Claude Code Runtime

```
Claude Code Stop event
        │
        ▼
bin/on-stop.mjs
  ├─ reads stdin: { session_id, cwd, transcript_path, last_assistant_message, stop_hook_active? }
  ├─ readTranscriptTail (max 200KB / 50 entries) → normalize to shared message format
  ├─ buildStopContext → { taskType, requiresPR, requiresCI, requiresTests, requiresBuild }
  ├─ [safety rails] loop detection, attempt budget check
  ├─ buildSelfAssessmentPrompt (context + patterns + anti-pattern rules + few-shots)
  ├─ callAnthropic (claude-haiku-4-5, 30s timeout) → raw JSON
  ├─ parseSelfAssessmentJson → { category, confidence }
  ├─ evaluateSelfAssessment → inject decision (bool)
  ├─ buildEscalatingFeedback (attempt count → tone/content)
  └─ stdout: { decision: "block", reason: "..." } to block stop, or empty to allow
        │
        ▼
writes: .supervisor/verdict_<sid>.json
```

### OpenCode Runtime

```
session.idle event
        │
        ▼
opencode/supervisor.ts
  ├─ skip if: disabled, judge session, plan mode, recently aborted, transcript too short
  ├─ [safety rails] planning loop, action loop, attempt budget, signature dedup
  ├─ spawn ephemeral session → self-assessment (+ optional cross-model judge)
  ├─ classify → { category, confidence }
  ├─ if category requires injection:
  │     client.session.promptAsync({ parts: [...] })   ← no .model field
  └─ if autopilot mode:
        skip judge, inject generic "keep working" nudge
              │
              ▼
reads/writes: .supervisor/goals/<sessionId>.json
              .supervisor/disabled
```

---

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `patterns.json` | Canonical classification taxonomy with dataset-mined anti-pattern weights. Source of truth for all classification rules. |
| `patterns.mjs` | Three-tier deep merge: shipped → `~/.config/agents-supervisor/patterns.json` → `.supervisor/patterns.json`. Project-local patterns override user-local, which override shipped. |
| `judge-core.mjs` | Builds and executes the runtime-agnostic classification prompt. Used by both CC and OpenCode paths. |
| `assessment.mjs` | Constructs the self-assessment prompt (injects task context, patterns, anti-pattern rules, few-shot examples). Parses raw LLM output to `{ category, confidence }`. |
| `evaluation.mjs` | Infers task type from transcript signals (`coding/docs/research/ops/other`). Evaluates classification to inject decision. Detects local test commands and default-branch push state. |
| `feedback.mjs` | Selects feedback tone and content based on attempt count. Escalates from neutral to firm across attempts. |
| `goal.mjs` | Manages goal state: sets goal + `maxAttempts=16`, evaluates per-stop as `achieved | continue | exhausted`. No inject on terminal states. |
| `llm-client.mjs` | Single Anthropic SDK call with 30s hard timeout. Used for both self-assessment (haiku-4-5) and optional cross-model judge. |

---

## Classification Taxonomy

Six categories govern inject/no-inject decisions:

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
| `.supervisor/verdict_<sid>.json` | Last classification verdict (CC runtime) | — |
| `.supervisor/disabled` | Per-session disable flag (OpenCode runtime) | — |
| `~/.config/agents-supervisor/patterns.json` | User-local learned pattern weights (written by trainer) | — |
| `.dataset/` | Training data (gitignored; CI guard enforced) | — |

Goal mode sets `maxAttempts=16`. Autopilot mode stores `{ autopilot: true }` in the same goals file. Autopilot exits when the agent calls the `autopilot_exit` tool or the attempt budget exhausts.

---

## Key Constraints & Invariants

1. **CC stdout contract.** `on-stop.mjs` must write `{ decision: "block", reason }` to stdout to block, or produce no stdout to allow. Side effects are limited to `.supervisor/` file writes.

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
