# Command Surface

## Validation

Run suites sequentially:

```sh
npm test
node test/e2e-cc.mjs
PATH="$HOME/.opencode/bin:$PATH" npm run test:e2e
```

`npm test` excludes the real-server E2E. Never use `node --test test/*.test.mjs`: it runs that server suite concurrently with unit files. A missing OpenCode binary fails the E2E loudly. Plugin commits and pushes require the real-server suite to pass first.

CI uses Node 22, a pinned OpenCode binary, unit tests, the CC hook E2E, the isolated OpenCode server E2E, syntax checks, judge eval and the privacy guard.

## Shared user commands

Both runtimes expose these colon commands:

- `/supervisor:status` — inspect actual goal, contract, flags and retry valve.
- `/supervisor:on` / `/supervisor:off` — enable/disable this session.
- `/supervisor:set-goal <condition>` — set an explicit goal.
- `/supervisor:set-goal clear` / `resume` — cancel or resume it.
- `/supervisor:retry N` — tune the runaway injection valve.
- `/supervisor:train` — learn local stop patterns.

There is one goal-based supervisor, with no mode switch. Upgrade to 0.4.0 and remove retired installed command/skill copies as described in README.

## Claude Code

Marketplace metadata: `.claude-plugin/{plugin,marketplace}.json`. Hook: `hooks/hooks.json` → `bin/supervisor-on-stop.mjs`. Canonical CLI: `bin/supervisor.mjs`; `bin/supervisor-goal.mjs` remains a compatibility entry point. Skills live under `skills/`; `solofounder` is a playbook that uses the same goal loop, not another execution mode.

CLI contract fields:

```sh
node bin/supervisor.mjs set-goal "Login validation works" --session <id> \
  --acceptance-criteria "Invalid inputs are rejected; valid input signs in" \
  --verification "Run node --test test/login.mjs and report results"
```

## OpenCode

Entrypoint: `opencode/supervisor.ts` → `supervisor-impl.ts`. `opencode/commands/` supplies colon commands; the config hook registers the bare `/supervisor <subcommand>` dispatcher. `/supervisor:plain on|off` controls style correction.

Tools: `supervisor`, `set_supervisor`, `supervisor_train`, `supervisor_goal`, `supervisor_retry`, `supervisor_autoreview`, `supervisor_loop_exit`.

Before requested multi-step work, declare a session contract with `supervisor_goal` using `condition`, `acceptanceCriteria`, `verification`, `source: agent`. Use `source: user` only for an explicit user-set goal. Agent replacement needs `replace: true`; explicit user cancellation uses `clear: true, source: user`. A completed loop signal requests an evidence audit while a goal is active.

## Training and eval

`train/run-train.mjs` orchestrates mining and local pattern updates; `.dataset/` remains private. `evals/judge-eval.mjs` runs the judge eval. Neither is a second goal runtime.
