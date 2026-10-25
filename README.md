# agents-supervisor

Goal-based completion supervision for **OpenCode** and **Claude Code**. One
supervisor, no selectable execution modes. An active goal tells the judge what
must be finished; unmet requirements can trigger a continuation.

**No active session or project goal means no completion judge and no completion
continuation.** Plainspeak is a separate, independently gated style feature.

## Install

### Claude Code

```sh
claude plugin marketplace add https://github.com/dzianisv/agents-supervisor
claude plugin install supervisor@agents-supervisor
claude plugin list
```

For a local clone, add its directory as the marketplace instead. The Stop hooks
load in the next session. Enable/disable the entire plugin with
`claude plugin enable supervisor@agents-supervisor` or `claude plugin disable
supervisor@agents-supervisor`.

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["github:dzianisv/agents-supervisor/opencode/supervisor.ts"] }
```

For a local clone use `file:///absolute/path/to/agents-supervisor/opencode/supervisor.ts`.
Restart OpenCode to load the plugin. Remove that entry to disable the plugin.
The real-server CI gate uses OpenCode **1.18.32**.

## Start with a completion contract

### OpenCode: the agent declares the goal

Ask for multi-step work normally, for example:

> Add a health endpoint, cover success and failure, and verify the tests.

The system instruction tells the agent to call `supervisor_goal` **before
multi-step work**, declaring a session-only contract:

```json
{
  "condition": "Health endpoint implemented and verified",
  "acceptanceCriteria": "GET /health returns the documented response; success and failure cases have tests",
  "verification": "Run the endpoint tests and report the command and results",
  "source": "agent"
}
```

Plain questions such as “what does this function do?” do not need a goal.
Automatic declaration is a model instruction, not guaranteed inference: inspect
`/supervisor:status` to confirm the actual goal. The existing no-condition goal
derivation flow also produces criteria and verification as an agent-owned,
session-only goal. It never creates a project goal file.

User-set goals take precedence. An agent cannot replace a user-owned goal;
replacing its own contract requires explicit `replace` and must follow a real
user redirection, not lower the bar to escape a failing check.

### Claude Code: set an explicit goal

```text
/supervisor:set-goal Health endpoint works; success and failure cases pass npm test
/supervisor:status
```

CC has no goal tool registry and does not automatically declare a goal. Its CLI
also accepts separate contract fields:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/supervisor.mjs" set-goal "Health endpoint works" \
  --acceptance-criteria "GET /health returns 200; failure path is covered" \
  --verification "Run npm test and report its result" --session <id>
```

Without separate criteria, the condition itself is the acceptance criterion.
These explicit CLI goals have `source=user`. Do not impersonate an explicit user
goal by inferring one in CC.

## Commands

Both runtimes support:

| Command | Effect |
|---|---|
| `/supervisor:set-goal <condition>` | Set an explicit user goal |
| `/supervisor:set-goal` | Show the goal (OpenCode can derive one when absent) |
| `/supervisor:set-goal clear` | Clear this session's goal and suppress project fallback here |
| `/supervisor:set-goal resume` | Resume a paused/exhausted contract with a fresh turn budget |
| `/supervisor:status` | Inspect goal, source, criteria, verification, retry valve and enable flags |
| `/supervisor:status on` / `off` | Toggle the optional status/roadmap directive only |
| `/supervisor:on` / `off` | Enable/disable completion supervision for this session |
| `/supervisor:retry N` | Set the per-human-turn runaway valve |
| `/supervisor:train` | Learn local classification patterns from your sessions |

OpenCode additionally supports the bare `/supervisor <subcommand>` dispatcher,
`/supervisor autoreview on|off` (optional second-model review, default off), and
`/supervisor:plain on|off` (style toggle, default on). In its web/API runtime,
call the corresponding tools directly. CC autoreview is not wired into its CLI.
`solofounder` remains a goal alias/playbook, not another supervisor.

## Evidence before completion

The shared judge checks the goal, **every acceptance criterion**, and the
verification plan against concrete evidence reported in the conversation.
Commands **and results**, paths, URLs, and artifact IDs are useful; “done” alone
is not evidence. The judge reads alternating user/assistant **prose**, not raw
tool calls or independent tool results. It can be mistaken; this release does
**not** add deterministic test-command gates or guarantee perfect verification.

- OpenCode completion signal: `supervisor_loop_exit` with `reason: "completed"`.
- CC completion signal: `SUPERVISOR_LOOP_EXIT: completed`, alone on its own line.

With an active goal, either signal requests the evidence audit; it cannot bypass
it or mark the goal achieved. A failed/unreachable judge fails open without
marking achievement. No active goal requires no completion audit.

The `stuck` reason remains an escape hatch: it pauses the contract, keeps it
visible for explicit resume, and appends forensic evidence to
`.supervisor/loop-exit.log`. CC uses `SUPERVISOR_LOOP_EXIT: stuck — explanation`.
Human-only blockers, trailing questions, content-free verdicts, and repeated
unchanged replies can also stand supervision down without pretending success.

## Lifecycle and safety

Session goals override project goals. Explicit user goals also save their
**contract** to `.agents/supervisor/Goal.md` for future sessions, including
separate acceptance criteria and verification when supplied. `Goal.md` wins over the legacy
lower-case `goal.md`. Agent-owned contracts are session-only. Paused or cleared
session goals never silently reactivate through a project fallback. Clearing a
session does not delete another session's shared project configuration.

Achievement retires only a project file still matching the judged condition,
with an audit record in `.supervisor/goal-achieved.log` before deletion. A paused
or deadline-exhausted goal keeps its contract and exposes the resume instruction.
The deadline backstop is 30 days; resume extends an expired deadline.

The **runaway safety valve** counts supervisor injections, not tool/model steps.
Its default is 50, deliberately permissive, not a completion signal or a budget
that must be spent. Resolution is session retry override > `maxAttempts` in
`~/.config/opencode/supervisor.yaml` > `SUPERVISOR_MAX_ATTEMPTS` (legacy
`REFLECTION_CC_MAX_ATTEMPTS`) > default. Positive integers are stored verbatim;
negative, fractional, or invalid values are rejected. `unlimited`/`off`/`none`/`0`
removes the count cap on OpenCode.

**CC caps this at 7 injections per human turn**, one under its default Stop-hook
block ceiling of 8. It cannot honor unlimited; CLI/status/debug output reports
that reduction. The single counter resets on a genuine new human message;
supervisor and foreign Stop-hook feedback never reset it. Spending it leaves the
goal active for the next human turn and records `runaway_ceiling` in the forensic
log. Eligibility gates must not consume attempts.

Disabled sessions and control commands are not work. OpenCode also excludes
judge sessions, child sessions by default (`parentID`), planning and abort gates.
`superviseSubagents: true` opts into child supervision. Continuations never switch
the active session model or grant new permissions. A goal does not authorize
merges, deployment, destructive actions, or spending.

## State and configuration

- `.supervisor/sessions/<full-id>/state.json`: contract, counters and flags (0600).
- `.supervisor/sessions/<full-id>/verdicts.jsonl`: append-only verdicts.
- `.supervisor/disabled`: disabled session IDs.
- `.supervisor/current_session`: last-writer hint, **not** caller identity.

CLI identity: `--session` (unique prefixes expand) > `SUPERVISOR_SESSION_ID` >
`CLAUDE_SESSION_ID` > announced local fallback. Ambiguity acts on nothing. Use
explicit IDs when multiple sessions share a project. State mutations use the
shared locked store, not whole-state overwrites. Old state loses obsolete
execution keys but preserves goals/flags; goals without provenance become user
owned.

Customize `.agents/supervisor/{SystemPrompt,Patterns,User}.md`; both runtimes use
`core/reflection-prompt.mjs` (an internal implementation name, not a public mode).
The judge must retain its prose-only evidence contract. Learned classification
patterns merge shipped `core/patterns.json` →
`~/.config/agents-supervisor/patterns.json` → project `.supervisor/patterns.json`.

## Plainspeak

Independent style detection catches fluffy delivered replies. CC uses a second
Stop hook: deterministic scoring plus an LLM tiebreak; disable with
`.plainspeak/disabled` or `PLAINSPEAK_DISABLED=1`. OpenCode uses deterministic
scoring only, toggled with `/supervisor:plain off`.

It defers to active session/project goals and supervisor continuation, never
consumes the completion retry counter, and permits **one rewrite per human
turn**. Short replies, trailing questions, disabled/control/child gates and
errors stand it down. No goal disables completion supervision, not independent
style checking. The optional status directive is default **off**, separate from
both enable axes, and cannot turn an empty verdict into actionable feedback.

## Upgrade to 0.4.0

Autopilot and reflection **commands/skills/tools and mode selection are removed**.
Stale CLI invocations fail with a clear removed notice and nonzero exit; they do
not silently enable a different route. Stored legacy execution keys are stripped
on load, without dropping the goal.

Update/reinstall the Claude plugin and restart the runtime. OpenCode's config
hook hides the two retired names even if old command files remain, while
preserving unrelated user commands; it does not delete your files. This
repository has no general installer for cleaning manual copies. Remove stale
`supervisor:autopilot.md` and `supervisor:reflection.md` from **your actual command
installation directory** (for example `~/.config/opencode/commands/`, or a
project's `.opencode/commands/`). Also remove retired `autopilot`/`reflection`
skill directories from any manually copied skill installation. Do not delete
unrelated user commands. A version bump alone cannot clean manual copies.

## Train and develop

`/supervisor:train --since=30d --dry-run` previews learned patterns; omit
`--dry-run` to update your user-local patterns (with backup). Training never
commits upstream. `.dataset/` and real transcripts stay private and out of git.
`--push-hf` is an explicit opt-in private dataset export, requiring HuggingFace
credentials. Judge calls send selected conversation prose to the configured LLM.

Run these **sequentially**, not in parallel:

```sh
npm test
node test/e2e-cc.mjs
export PATH="$HOME/.opencode/bin:$PATH"
node --experimental-strip-types --test test/e2e-opencode.test.mjs
```

**Mandatory precommit invariant:** never commit/push plugin changes without a
passing real isolated OpenCode E2E gate; missing binary or skipped gate is not a
pass. Verify command/tool registration against real `opencode serve`; mocks
alone are insufficient. Never use the broad `test/*.test.mjs` test-runner glob:
it includes E2E and launches it concurrently with unit files.

Syntax checks: `node --experimental-strip-types --check opencode/supervisor.ts`
and the same command for `opencode/supervisor-impl.ts`. `npm run test:cc` is the
real CC hook entry point with a fake judge by default, not a live `claude -p`
session. Set `SUPERVISOR_CC_LIVE=1` for real judge calls. Optional:
`npm run eval`, `npm run eval:plainspeak` (synthetic cases by default).

## License

MIT © dzianisv
