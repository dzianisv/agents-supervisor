---
session: ses_128c
updated: 2026-06-17T20:13:25.272Z
---

# Session Summary

## Goal
Implement autopilot mode in the agents-supervisor OpenCode plugin (`supervisor.ts` + `core/goal.mjs`) so users can run autonomous agent sessions without needing the OpenCode fork — 7 changes total covering state, store, command parsing, 2 new tools, runSupervisor fast-path, and tool export.

## Constraints & Preferences
- Follow exact coding style of existing codebase (TypeScript types, async patterns, error handling)
- `core/goal.mjs` uses ES module syntax (plain JS, `export function`)
- `supervisorStore` methods take `(directory, sessionId, ...)` — always pass `directory` first
- Continuation must use `client.session.promptAsync()` exclusively
- `autopilot_exit` tool must work even when supervisor is disabled — just toggles flag off
- Increment `goal.attempts` on each autopilot continuation to track budget
- Tool API has two paths: `tool()` helper (primary) and `zod` fallback — both must be updated
- `supervisor.ts` is 2457 lines (now ~2493 after edits); `core/goal.mjs` is 129 lines

## Progress
### Done
- [x] **Step 1**: Added `autopilot?: boolean` field to `SupervisorState` interface (line ~79)
- [x] **Step 2**: Added `setAutopilot(directory, sessionId, enabled)` method to `supervisorStore` (after `setRetry`, around line ~163)
- [x] **Step 3**: Added `autopilot` command parsing to `parseSupervisorCommand` in `core/goal.mjs` — handles on/off/status/start/stop/exit/true/false keywords, returns `{ kind: 'autopilot-on' | 'autopilot-off' | 'autopilot-status' }`
- [x] **Step 4 (partial)**: Added `executeSupervisorAutopilot` and `executeAutopilotExit` handler functions (after `executeSupervisorRetry`, around line ~1915-1942)
- [x] **Step 4 (partial)**: Added `let supervisorAutopilotTool` and `let autopilotExitTool` variable declarations (line ~1949-1950)

### In Progress
- [ ] **Step 4 (remaining)**: Need to add tool construction in BOTH the `tool()` API try block AND the `zod` fallback block — this is the immediate next step

### Blocked
- (none)

## Key Decisions
- **Autopilot nudge bypasses judge entirely**: In autopilot mode, `runSupervisor` skips self-assessment/judge evaluation and directly calls `promptAsync` with a prescriptive nudge — but still runs loop detection (planning loop, action loop) and respects attempt budget
- **`autopilot_exit` always works**: Even if supervisor is disabled, the tool just sets `state.autopilot = false` so the next idle won't auto-continue
- **parseSupervisorCommand aliases**: `on/true/start/""` → autopilot-on; `off/false/stop/exit` → autopilot-off; `status` → autopilot-status

## Next Steps
1. **Add tool construction in `tool()` API block** (around line ~1991): Add `supervisorAutopilotTool = tool({...})` and `autopilotExitTool = tool({...})` after `supervisorToggleTool` construction
2. **Add tool construction in `zod` fallback block** (around line ~2009): Add both tools using `z.boolean()` / no args pattern matching existing zod tools
3. **Step 5**: Add autopilot fast-path in `runSupervisor()` — after state load (~line 2084), before self-assessment: check `state.autopilot`, handle budget exhaustion, loop detection, and autopilot nudge via `promptAsync`
4. **Step 7**: Add `supervisor_autopilot` and `autopilot_exit` to the tool export object (currently at ~line 2441): add spread entries like `...(supervisorAutopilotTool ? { supervisor_autopilot: supervisorAutopilotTool } : {})`
5. **Verification**: Check for TypeScript syntax correctness (braces, types), valid JS in goal.mjs, all tools in export array, edge cases in autopilot fast-path

## Critical Context
- **Tool API dual-path pattern**: Tools are first constructed with `tool()` helper in a try block (lines ~1955-1991); if that fails, a catch block uses `zod` imports (lines ~1993-2035). Both paths must include the new tools.
- **tool() API schema**: Uses `tool.schema.string()`, `tool.schema.boolean()` etc. The zod path uses `z.string()`, `z.boolean()`, `z.enum([...])` etc.
- **Tool export structure** (line ~2441): `tool: (setSupervisorTool || supervisorToggleTool || ...) ? { ...(tool ? { name: tool } : {}), ... } : undefined`
- **runSupervisor key flow**: Guard checks → load messages → isJudgeSession/isPlanMode checks → abort detection → load state → configuredMaxAttempts → buildTaskContext → detectPlanningLoop/detectActionLoop → self-assessment/judge → feedback injection via `promptAsync`
- **`buildTaskContext(messages, sessionId)`** and **`detectPlanningLoop(messages)`** / **`detectActionLoop(messages)`** are existing functions available for the autopilot fast-path
- **`buildEscalatingFeedback`** signature includes params for `planningLoop` and `actionLoop` flags — autopilot should reuse it for loop cases
- **Attempt tracking**: `state.goal.attempts` tracks count; `resolveMaxAttempts({sessionOverride, config})` resolves effective max; `attemptKey` pattern used in runSupervisor for the `attempts` Map
- The `showToast(client, directory, msg, level)` helper is available for user notifications

## File Operations
### Read
- `/Users/engineer/workspace/agents-supervisor/core/goal.mjs` (full file, 129→~140 lines after edit)
- `/Users/engineer/workspace/agents-supervisor/opencode/supervisor.ts` (full file + targeted sections: lines 75-175 for state/store, 1794-2010 for tool defs, 2005-2115 for runSupervisor start, 2300-2399 for promptAsync continuation, 2390-2460 for plugin export)

### Modified
- `/Users/engineer/workspace/agents-supervisor/core/goal.mjs` — updated `parseSupervisorCommand` to handle `name === 'autopilot'`
- `/Users/engineer/workspace/agents-supervisor/opencode/supervisor.ts` — added `autopilot` to `SupervisorState`, `setAutopilot` to store, executor functions, tool variable declarations
