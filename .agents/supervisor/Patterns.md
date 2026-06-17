# Patterns & Antipatterns

## Patterns
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- Tests cannot be skipped or marked as flaky/not important.
- Direct pushes to main/master are not allowed; require a PR instead.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials, access requests, uploads, approvals), list it in needs_user_action.
- PLANNING LOOP CHECK: If the task requires code changes (fix, implement, add, create, build, refactor, update) but the tool commands show ONLY read operations (read, glob, grep, git log, git status, git diff, webfetch, task/explore) and NO write operations (edit, write, bash with build/test/commit, github_create_pull_request, etc.), then the task is NOT complete. Set status to "in_progress", set stuck to true, and list "Implement the actual code changes" in remaining_work. Analyzing and recommending changes is not the same as making them.
- If you are repeating the same actions (deploy, test, build) without making progress, set "stuck": true.
- Do not retry the same failing approach more than twice — try something different or report stuck.

## Antipatterns
PREMATURE-STOP ANTIPATTERNS (mined from 284 real agent stops where the user replied; 78% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). If the agent's last response matches one of these AND executable work remains, the task is NOT complete — set status "in_progress", and put the concrete next action in remaining_work and next_steps:
- PERMISSION-SEEKING (most common, ~40%): the response ends by asking to do work it can already do — "Want me to...?", "Would you like me to...?", "Should I...?", "Shall I proceed?", or "Try running it now"/"Please run X and confirm" (deferring a check it could run itself). DECISIVE TEST: if the final turn is a yes/no or "want me to X?" question AND X is something the agent can do with its own tools AND X carries no irreversible risk, the stop is premature — it should have just done X. Asking is only legitimate before a destructive/irreversible action (delete prod data, force-push, send an irreversible external message).
- STOPPED-WITH-TODOS (~30%): the response lists "Remaining Tasks"/"Next steps"/"Still TODO"/"What I did NOT do"/"Outstanding Work" or names a verify/run/check/create-PR step as "next" — then stops without doing it. FIRST-OCCURRENCE IS SUFFICIENT: do NOT wait for a second signal; 98% of these are premature. TERMINAL-POSITION TEST: the list appears in the LAST ~40% of the response with NO subsequent tool calls or execution. A mid-response progress report followed by actual execution is complete, not drift. Set status "in_progress" with that work in remaining_work.
- VERIFICATION-DEFERRAL: agent wrote/edited code (write/edit tool calls in tool commands) but the response ends without running tests, build, or lint — and the task requires verification. Run verification before stopping. Set status "in_progress" with "run tests/build" in remaining_work.
- FALSE-COMPLETE: claims "done"/"complete"/"ready"/"all tasks complete" but the CORE requested action never happened, a required check was skipped, or there is no evidence. An empty/no-text response, or a response with no write/tool evidence on an action task, is NEVER complete. For an "add a feature/system" task, writing files is necessary but NOT sufficient — the new code must be WIRED IN (imported/registered/routed, not orphaned modules) AND verified (test/build/run); "ready to use" with no integration is incomplete (status "in_progress").
- LEGITIMATE STOP (do NOT flag): genuine human-only block (OAuth consent, 2FA code, credential/API-key retrieval, captcha) -> status "waiting_for_user" with the item in needs_user_action. Genuine completion WITH evidence (commands+output, tests passing, PR/CI verified) -> status "complete"; do not invent missing work.
- SEVERITY/STUCK: a single recoverable technical snag mid-task (knows the fix) is not "stuck". But a policy/process violation — pushing to main when a PR was required, skipping mandated tests — is a real failure: status "in_progress" with the corrective action in remaining_work, never "complete".
