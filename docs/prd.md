# Product Requirements Document: agents-supervisor

**Version:** 1.0  
**Date:** 2026-06-27  
**Status:** Active

---

## Problem

AI coding agents stop prematurely. The agent reaches a point where it could continue — a tool is available, the task is incomplete, the next step is obvious — but it exits the session anyway. The user returns to a half-finished state and must manually re-engage. This is friction that degrades trust in agentic workflows and wastes developer time.

The inverse problem also exists: agents loop. They re-read the same files, re-plan, or repeat the same commands without making progress.

---

## Goals

1. Detect when an agent stops prematurely and re-inject a continuation prompt automatically.
2. Detect when an agent is looping and surface or interrupt the loop.
3. Support a user-defined completion condition (goal mode) that keeps the agent running until evidence of completion is found.
4. Support an autopilot mode (OpenCode) that removes judge latency entirely and re-prompts on every idle.
5. Run on both Claude Code (hook-based) and OpenCode (plugin-based) without diverging classification logic.
6. Allow users to improve classification accuracy by training against their own session data — locally, never upstream.

---

## Non-Goals

- Does not store training data, transcripts, or raw JSONL in git.
- Does not require internet access (all classification logic runs locally; the judge LLM call is the only external dependency).
- Does not set `.model` in continuation prompts — this would violate OpenCode's session model contract.
- Does not replace the agent's core reasoning or generate task-specific guidance; it only decides whether to re-prompt.
- Does not guarantee task completion — it exhausts a retry budget and stops.

---

## Users

**Primary:** Individual developers using Claude Code or OpenCode for multi-step coding tasks who want the agent to self-recover from premature stops without manual intervention.

**Secondary:** Teams that want consistent agent behavior across projects via shared pattern overrides committed to a repo.

---

## Core Requirements

### Stop Classification

The classifier assigns every agent stop to one of six categories:

| Category | Triggers re-prompt |
|---|---|
| `complete` | No |
| `waiting_for_user_legitimate` | No |
| `working` | No |
| `tool_available_punt` | Yes |
| `summary_drift_stop` | Yes |
| `genuinely_stuck` | Yes |

Classification uses `core/patterns.json` (anti-pattern rules mined from real sessions). The pattern stack is three-layer: shipped defaults → user-local overrides → project overrides.

### Re-Prompting

When a stop triggers re-prompting, the supervisor injects a continuation message into the active session. The injection is runtime-specific:
- **Claude Code:** via the `Stop` hook in `bin/supervisor-on-stop.mjs`, which reads the session transcript and calls back into the session.
- **OpenCode:** via `opencode/supervisor.ts`, which listens to `session.idle` events and calls the OpenCode `session.chat` API.

Both runtimes share classification logic from the core module.

### Goal Mode

User sets a completion condition: `/supervisor:set-goal <natural-language condition>`. The supervisor evaluates each stop against the condition (via LLM judge). Re-prompting continues until the condition is evidenced in the session or the retry budget exhausts. Goal state persists across stops within the session.

### Autopilot Mode (OpenCode only)

`/supervisor autopilot` skips judge evaluation. The supervisor re-prompts on every idle event until the agent emits a recognized done signal or the budget exhausts. Intended for fully unattended runs.

### Tool-Activity Telemetry

A bounded, non-binding counter (`summarizeToolActivity` in `core/evaluation.mjs`) tallies read vs. write tool calls in recent turns and produces a factual, informational-only note (`describeToolActivity`). This note may enrich the autopilot nudge text and the reflection judge's prompt as contextual telemetry, but it never itself decides completion/progress or emits a stop verdict — the reflection judge's own verdict remains the sole authority for that.

### Trainer

`/supervisor:train` (both runtimes) mines the user's local session history, derives updated anti-pattern weights, and writes to a user-local patterns file. Never writes to the shipped `core/patterns.json` or any git-tracked path.

### Privacy Guard

CI enforces that no training data, transcripts, or raw JSONL is committed. This is a hard boundary — not advisory.

### Install Paths

Both marketplace install (URL-based) and local install (file path) must work for each runtime.

---

## Quality Attributes

- **Latency:** Classification and re-prompt injection must complete within the hook timeout window of the respective runtime. No blocking I/O on the critical path beyond the LLM judge call.
- **Reliability:** A crash in the supervisor must not crash the agent session. The hook/plugin must fail open (agent stops normally if supervisor errors).
- **Privacy:** Zero session data leaves the machine unless the user explicitly invokes the judge LLM. Training data never reaches git.
- **Portability:** Core classification logic (`core/patterns.json` + shared engine) must work identically on both runtimes with no runtime-specific forks.
- **Configurability:** Pattern overrides at user and project scope must not require modifying shipped files.

---

## Success Metrics

- Premature stops that would have required manual re-engagement are detected and re-prompted automatically, reducing user interruptions.
- False positive rate (re-prompting on legitimate stops) stays low enough that users do not disable the plugin.
- Trainer workflow produces measurably improved classification accuracy on the user's own session corpus.
- No training data or transcripts appear in git history (enforced by CI, not convention).

---

## Out of Scope

- GUI or dashboard for session monitoring.
- Cross-machine sync of training data or pattern overrides.
- Support for runtimes other than Claude Code and OpenCode.
- Agent-authored task planning, subtask decomposition, or tool orchestration.
- Alerting, notifications, or integrations with external services.
