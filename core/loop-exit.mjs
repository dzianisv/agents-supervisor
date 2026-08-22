/**
 * loop-exit.mjs — THE shared parser for the agent-declared end of the
 * supervision loop.
 *
 * The OpenCode runtime gets a real tool (`supervisor_loop_exit`). The Claude
 * Code runtime is a Stop hook: it has no tool registry, so the same signal
 * arrives as a TEXT SENTINEL the agent prints on its own line:
 *
 *     SUPERVISOR_LOOP_EXIT: completed
 *     SUPERVISOR_LOOP_EXIT: stuck — the supervisor keeps demanding a merged PR
 *
 * ONE parser, shared, so the two runtimes cannot drift on what counts as an
 * exit. Strictness matches the existing AUTOPILOT_EXIT regex: the sentinel must
 * own its line, so a passing mention inside prose ("I'll print
 * SUPERVISOR_LOOP_EXIT when done") never ends the loop. Fenced code blocks are
 * stripped first — the nudge that TELLS the agent about the sentinel quotes it,
 * and a quoted example must not fire.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Canonical sentinel keyword. */
export const LOOP_EXIT_SENTINEL = 'SUPERVISOR_LOOP_EXIT';

/**
 * Backwards-compatible alias. `AUTOPILOT_EXIT` alone on a line predates the
 * sentinel and existing tests/sessions depend on it; it means
 * `reason: 'completed'`.
 *
 * PARSE-ONLY: this alias is deliberately no longer TAUGHT anywhere (no nudge,
 * skill, README, or tool description mentions it) — `SUPERVISOR_LOOP_EXIT` /
 * `supervisor_loop_exit` is the one signal agents and users are shown. The
 * regex stays because shipped skills/*.md get copied into a user's
 * ~/.config and installed copies have lagged shipped fixes before (the 0.3.1
 * manifest-bump incident); a stale on-disk skill that still teaches the old
 * token must keep working. Do not remove without a migration story for
 * already-installed copies.
 */
const AUTOPILOT_EXIT_RE = /(^|\n)[ \t]*AUTOPILOT_EXIT[ \t]*(\n|$)/;

const SENTINEL_RE = /(^|\n)[ \t]*SUPERVISOR_LOOP_EXIT[ \t]*:[ \t]*([^\n]*)(\n|$)/i;

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;

/**
 * @param {string} text final assistant text
 * @returns {{reason:'completed'|'stuck', detail:string}|null}
 */
export function parseLoopExitSentinel(text) {
  if (typeof text !== 'string' || text === '') return null;
  const scanned = text.replace(FENCE_RE, '\n');
  const m = SENTINEL_RE.exec(scanned);
  if (m) {
    const rest = (m[2] || '').trim();
    // First whitespace-delimited token is the reason; everything after it (with
    // a leading dash/em-dash separator dropped) is free-text detail.
    const [word = '', ...tail] = rest.split(/\s+/);
    const reason = word.toLowerCase().replace(/[.,;:]+$/, '') === 'stuck' ? 'stuck' : 'completed';
    const detail = tail.join(' ').replace(/^[\s—–-]+/, '').trim();
    return { reason, detail };
  }
  if (AUTOPILOT_EXIT_RE.test(scanned)) return { reason: 'completed', detail: 'AUTOPILOT_EXIT' };
  return null;
}

/**
 * THE single writer for `.supervisor/loop-exit.log` — forensic evidence that
 * a supervision loop ended without the human driving it further.
 *
 * Two call sites, both runtimes, share this: an agent-declared `stuck` exit
 * (the `supervisor_loop_exit` tool on opencode, the `SUPERVISOR_LOOP_EXIT:
 * stuck` sentinel on Claude Code) and a `runaway_ceiling` hit — the per-turn
 * attempt budget exhausted without the agent ever declaring an exit, which is
 * strictly WORSE than a declared `stuck` because it means the loop never
 * terminated on its own and nothing but the circuit breaker stopped it.
 *
 * One writer, one file, one JSON-lines format — the shape each caller passes
 * as `record` may differ (a ceiling hit adds `mode`/`attempts`/`maxAttempts`;
 * a declared exit adds `turnKey`/`detail`), but there is exactly one function
 * that touches the file, so the two call sites cannot drift onto two formats.
 *
 * Best-effort by contract: a failed write must never block or crash a turn.
 *
 * @param {string} cwd project directory (session cwd on Claude Code, plugin
 *   `directory` on opencode)
 * @param {Record<string, unknown>} record JSON-serializable forensic record.
 *   Callers should always include `reason` and `at` (epoch ms).
 * @returns {boolean} true if the write succeeded, false on any failure
 */
export function appendLoopExitLog(cwd, record) {
  try {
    const dir = path.join(cwd, '.supervisor');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'loop-exit.log'), JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}
