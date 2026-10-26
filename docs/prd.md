# Product requirements — goal-only supervisor (0.4.0)

## Outcome

Multi-step coding work continues toward a clear acceptance contract, without
judging plain questions or running an unconditional continuation loop. One
supervisor serves OpenCode and Claude Code using shared completion logic.

## User journey

1. OpenCode: the agent declares a session-only `supervisor_goal` before
   multi-step work, with condition, observable acceptance criteria, verification
   plan and `source=agent`. Plain questions need no goal. The same contract fields
   are returned by existing no-condition LLM derivation.
2. A user may set an explicit goal on either runtime using
   `/supervisor:set-goal <condition>`. CC relies on this explicit CLI path, not
   model goal tools. CLI contract options can specify criteria and verification.
3. Status shows the actual contract and ownership, lifecycle, retry valve,
   enable flags, and paused/exhausted recovery instruction.
4. Idle/Stop with an active session or inherited project goal audits evidence.
   Unmet criteria with actionable next steps can trigger continuation. With no
   active goal, no completion judge or completion continuation runs.
5. Completion requires the existing judge's evidence check. A completed tool or
   CC sentinel is a request for audit, not a bypass. Stuck can pause with forensic
   logging; clear and resume remain explicit user controls.

## Required behavior

- No public mode split, retired execution tools, skills or mode commands. Stale
  CLI invocations explain removal and fail nonzero without mutating state.
- Goal fields: condition, acceptanceCriteria, verification, source (`user|agent`)
  plus lifecycle fields. Missing legacy source means user. Strip obsolete
  execution keys during state load without losing goals or flags.
- User-owned goals cannot be overwritten by automatic inference or an agent.
  Replacing an agent-owned goal requires explicit replacement and user redirection.
- Agent goals are session-only. Explicit user goals may retain project condition
  persistence including criteria and verification. Session goal overrides
  `Goal.md`, which overrides legacy `goal.md`.
  Paused/inactive or cleared sessions must not reactivate stale project fallback.
- Achievement retires only the matching full project contract after writing
  durable evidence; concurrent replacements survive. Judge errors never achieve
  goals and fail open without blocking the runtime.
- Preserve enable axes, controls, root/child/judge/plan/abort gates, per-human-turn
  counter, no-progress and content-free-feedback guards, roadmap toggles, and
  independent plainspeak. No goal does not mean no style checking.
- Retry is a runaway valve, not completion: default 50 injections, configurable
  session > file > env > default; CC effective hard cap normally 7, reported
  honestly even when unlimited was requested. Spending it leaves the goal active
  for the next human turn. Stuck/deadline preserve a resumable contract.
- A goal never grants permission for merges, destructive actions, deployment or
  spending. Continuation must never change the active session model.

## Evidence and limitations

The judge reads conversation prose and concrete reported specifics: paths,
commands **and results**, URLs, artifact IDs. It does not independently inspect
raw tool evidence. Every acceptance criterion must be evidenced; bare assertions
are insufficient. This release adds no deterministic test-command gate and does
not guarantee correct verification or eventual completion. Automatic declaration
is prompt-directed and may be omitted by a model; status and real-server state
assertions are necessary to observe it.

## Distribution and privacy

Both Claude marketplace and OpenCode plugin installs remain supported. Bump
plugin/marketplace to 0.4.0. Remove retired source skill/command files; manual
command copies require explicit documented cleanup where no installer exists.
Training writes local learned patterns, never commits data upstream. Selected
conversation prose reaches the configured judge LLM; transcripts, credentials,
mined datasets and real trace artifacts never belong in git.

## Validation and success

Run unit/integration tests, CC hook E2E, then real isolated OpenCode E2E
**sequentially**. **Never commit/push plugin changes without the passing mandatory
real-server E2E gate.** No missing-binary skip counts as success. Verify supported
commands/tools register and removed ones do not. Inspect actual contracts and
captured judge input, not prose claims alone. Capture a real-model task trace
when routing/credentials allow, outside git.

Success means fewer manual re-engagements for contracted work without imposing
completion work on no-goal turns, preserving all termination/scope safeguards,
and observing evidence checks before retirement. Perfect verification, a new
scheduler/store, autonomous permissions, cost-budget controls, and new runtime
support are out of scope for 0.4.0.

## During-work focus checks and native Pi support — locally verified, delivery pending <!-- issue #72 -->

### User and usage

- Developer whose agent substitutes a convenient subtask or wrong target for the
  requested outcome during a long task.
- Load the native Pi extension explicitly; assign the task once. The existing
  goal contract preserves the original operator request and acceptance criteria.
- Before proposed tools run, the supervisor checks their relation to that request.
  Clear drift is blocked with one concrete correction. Necessary prerequisites
  and authorized temporary work remain possible without replacing the mission.
- At settlement, the same supervisor audits completion. A ticket, an old tenant,
  an existing account or missing observations cannot substitute for the requested
  outcome. Unknown evidence stays unknown.

### Acceptance criteria

- [x] A real Pi run/replay blocks the wrong action before its observable effect,
  recovers the original task and produces its independently checked result.
- [x] Legitimate prerequisites, explicit redirection and authorized temporary work
  are permitted; status questions do not replace or restart the task.
- [x] The request survives compaction/resume. Branch changes, aborts and newer user
  instructions invalidate old decisions; foreign/delegated sessions are not adopted.
- [x] Missing/ambiguous judgments return control visibly rather than certify
  alignment, completion or a weaker replacement goal. No unlimited retry loop.
- [x] Decisions, latency and added model usage are observable without logging
  credentials or committing private conversation traces.
- [x] Existing unit, Claude Code and mandatory real OpenCode suites remain green.

### Boundaries

Pi is the first mid-work adapter; OpenCode/Claude Code keep their existing
completion behavior. Reuse the existing goal, session store and completion
helpers. No second scheduler, observer fleet, model router, KPI service, AgentPod
operations, global configuration changes or consumer-Muse-style security boundary.
The guard is fallible workflow assistance, not a sandbox or a proof of delivery.
One bounded model check per proposed tool batch adds cost and latency; nested or
changed calls need their own decision. Implementation and selected-profile local
validation are complete; PR/CI and merge authorization remain separate.
See [validation evidence and limits](focus-validation.md).
