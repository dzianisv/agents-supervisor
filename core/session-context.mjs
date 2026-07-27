/**
 * session-context.mjs — resolve the directory a SESSION is actually working in.
 *
 * Why this exists (INCIDENT 2026-07-27):
 * The opencode plugin entrypoint receives `directory` once, at plugin init:
 *
 *   export const SupervisorPlugin: Plugin = async ({ client, directory }) => ...
 *
 * That `directory` is the SERVER's working directory — the cwd `opencode serve`
 * was started from. It is NOT per-session. One server happily hosts sessions
 * rooted in many different projects, so using `directory` for anything
 * project-specific silently reads the wrong project.
 *
 * Concretely: `opencode serve` ran in this plugin's own repo, whose
 * .agents/supervisor/Goal.md held an OpenClawBot production-readiness
 * checklist. A session working in /Users/engineer/workspace/KineticAiCoach got
 * that checklist injected as a "MANDATORY GOAL", causing cross-project scope
 * creep and a 14-session fan-out that wedged the server.
 *
 * The real per-session cwd IS available: every opencode AssistantMessage
 * carries it as `info.path.cwd` (see @opencode-ai/sdk types.gen.d.ts —
 * `AssistantMessage.path: { cwd: string; root: string }`).
 *
 * Same shape and defensiveness as getLastSessionModelSpec in
 * core/model-selection.mjs: walk messages newest-first, return the first
 * usable value, never throw on malformed input.
 */

/**
 * Extract the session's working directory from its messages.
 * Scans newest-first and returns the first assistant message carrying a
 * non-blank `info.path.cwd`. Returns null when nothing usable is present.
 * Never throws — message shapes come off the wire and may be partial.
 * @param {Array<{info?: {path?: {cwd?: string}}}>} messages
 * @returns {string|null}
 */
export function getLastSessionCwd(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const cwd = messages[i]?.info?.path?.cwd
    if (typeof cwd === 'string' && cwd.trim()) return cwd
  }
  return null
}

/**
 * The directory the supervisor should treat as "this session's project".
 * Prefers the session's own cwd; falls back to the plugin/server directory
 * only when the session cwd cannot be determined (e.g. no assistant message
 * yet). The fallback is a best-effort last resort, NOT a default — see the
 * incident note above for why it must never be the primary source.
 * @param {Array<object>} messages
 * @param {string} pluginDirectory — the server cwd handed to the plugin
 * @returns {string}
 */
export function resolveSessionDirectory(messages, pluginDirectory) {
  return getLastSessionCwd(messages) ?? pluginDirectory
}
