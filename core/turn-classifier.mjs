/**
 * turn-classifier.mjs — cheap, deterministic gate that answers ONE question:
 * "is the user's latest turn a work request at all?"
 *
 * Why (forensics 2026-08-06): the completion judge ran on every idle regardless
 * of what the human actually said. Real observed misfires:
 *   - user: "Stop. Reflect. What is wrong with you. Why feature is not
 *     delivered in 2 days?" -> supervisor, 66 s later: "Run the prod canary
 *     provision end-to-end against prod now… flip HERMES_PRIMARY_CHOICE_ENABLED"
 *   - user: "why did you stop . answer short" -> supervisor: 6-item mandatory
 *     GOAL missing-list about anon-key minting
 *   - "tldr", "thanks", "I think this is opencode plugin?" all ran the full
 *     completion judge as if they were work orders.
 *
 * DESIGN BIAS — deliberately conservative. Falsely skipping a real work request
 * is a supervision hole (bad); one extra reflection on a chatty turn is cheap
 * (annoying). So every rule requires BOTH a positive conversational/meta signal
 * AND the absence of any work signal, and anything long, anything naming a
 * file/path/identifier, and anything containing a work verb is actionable.
 *
 * Pure functions, no I/O — see test/turn-classifier.test.mjs.
 */

/**
 * Above this length we always treat the turn as actionable. Real specs, bug
 * reports and multi-step instructions are long; "tldr" and "thanks" are not.
 */
export const NON_ACTIONABLE_MAX_LEN = 400

/**
 * Verbs that indicate the user is asking for work to be done or checked.
 * Presence of ANY of these makes the turn actionable, whatever else it says.
 * Broad on purpose (see DESIGN BIAS above).
 */
const WORK_VERB = new RegExp(
  '\\b(' +
    'implement|fix|fixes|fixing|add|adds|adding|create|creates|creating|build|builds|building|' +
    'refactor|update|updates|updating|remove|delete|rename|migrat\\w*|deploy\\w*|releas\\w*|ship|' +
    'publish|install|configur\\w*|set\\s?up|setup|write|writes|writing|commit|push|pull|merge|rebase|' +
    'run|runs|running|rerun|re-run|test|tests|testing|verify|verifies|validate|check|checks|' +
    'investigat\\w*|debug|review|audit|analy[sz]\\w*|research|generate|draft|design|document|' +
    'clean\\s?up|optimi[sz]\\w*|upgrade|downgrade|revert|rollback|restart|reboot|start|launch|' +
    'kill|scale|provision|integrat\\w*|wire|port|convert|extract|split|land|patch|bump|tag|lint|' +
    'format|benchmark|profile|monitor|send|email|post|schedule|triage|assign|label|' +
    'work(ing)?\\s+on|proceed|continue|retry|redo|apply|enable|disable|bump|open\\s+(a\\s+)?(pr|issue)|' +
    'pr\\b|ci\\b|build\\b' +
  ')\\b',
  'i'
)

/**
 * Anything that looks like a concrete artifact the user is pointing at: a path,
 * a filename with an extension, a code span, a URL, or an issue/PR reference.
 * Its presence means the turn names real work even if it reads like a question.
 */
const ARTIFACT = /(`[^`]+`|\bhttps?:\/\/|[\w./-]*\/[\w.-]+|\b[\w-]+\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|py|go|rs|sh|sql|toml|css|html|txt)\b|#\d+)/i

/** Whole message is a bare acknowledgement. */
const ACKNOWLEDGEMENT =
  /^\s*(thanks?|thank\s+you|ty|thx|ok(ay)?|k|cool|nice|great|awesome|perfect|got\s+it|makes\s+sense|sounds\s+good|understood|noted|lgtm|ship\s*it|\+1|👍|🙏|✅)[\s.!,]*$/i

/**
 * An explicit stop/halt as its OWN clause: "Stop.", "stop!", "halt — ...",
 * "pause, ...". Requires terminating punctuation (or end of message) right
 * after the word so that "stop the dev server" / "pause the queue worker",
 * which are real imperatives, do NOT match.
 */
const STOP_CLAUSE = /^\s*(stop|halt|pause|abort|cancel|nevermind|never\s+mind|stand\s+down|hold\s+on|wait)\s*([.!?,;—-]|$)/i

/** Request for a recap/summary/status rather than for work. */
const SUMMARY_REQUEST =
  /^\s*((give|get)\s+me\s+(a|an|the)\s+|can\s+i\s+get\s+(a|the)\s+|(just\s+)?)(tl;?\s?dr|recap|summar(y|ise|ize|izing)|sum\s+up|status|sitrep|explain|what\s+happened|what\s+did\s+you\s+(do|change)|where\s+are\s+we|catch\s+me\s+up)\b/i

/**
 * A question aimed at the agent itself / at the conversation rather than at the
 * codebase: "why did you stop", "are you stuck?", "what is wrong with you".
 */
const META_QUESTION =
  /^\s*(why|what|what's|whats|how\s+come|are\s+you|were\s+you|did\s+you|do\s+you|is\s+this|isn'?t\s+this|i\s+think|can\s+you\s+explain|you\s+(stopped|stop))\b/i

/**
 * @typedef {{actionable: boolean, category: 'work'|'empty'|'acknowledgement'|'stop'|'summary'|'meta_question'|'question'}} TurnClassification
 */

/**
 * Classify the user's latest turn.
 * @param {string} text
 * @returns {TurnClassification}
 */
export function classifyTurn(text) {
  const raw = typeof text === 'string' ? text : ''
  const t = raw.trim()
  if (!t) return { actionable: false, category: 'empty' }

  // Escape 1: long turns are specs/reports, never small talk.
  if (t.length > NON_ACTIONABLE_MAX_LEN) return { actionable: true, category: 'work' }

  // Escape 2: naming a concrete artifact means real work is in scope.
  if (ARTIFACT.test(t)) return { actionable: true, category: 'work' }

  // Bare acknowledgement — checked before the work-verb escape so "ship it"
  // and "lgtm" (whole-message only) don't re-trigger the judge.
  if (ACKNOWLEDGEMENT.test(t)) return { actionable: false, category: 'acknowledgement' }

  // Escape 3: any work verb anywhere makes it actionable.
  const hasWorkVerb = WORK_VERB.test(t)

  if (STOP_CLAUSE.test(t) && !hasWorkVerb) return { actionable: false, category: 'stop' }
  if (hasWorkVerb) return { actionable: true, category: 'work' }
  if (SUMMARY_REQUEST.test(t)) return { actionable: false, category: 'summary' }
  if (META_QUESTION.test(t)) return { actionable: false, category: 'meta_question' }
  // A pure question with no work verb and no artifact is a discussion turn.
  if (t.endsWith('?')) return { actionable: false, category: 'question' }

  return { actionable: true, category: 'work' }
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isNonActionableTurn(text) {
  return !classifyTurn(text).actionable
}

/**
 * A turn whose whole content is a supervisor CONTROL command
 * (`/supervisor …`, `/supervisor:retry 3`, `/autopilot`). Never work, in ANY
 * mode.
 *
 * This is checked BEFORE the goal/autopilot escape hatches, unlike every other
 * rule here, and that ordering is load-bearing. Before the per-turn budget was
 * real, autopilot injected at most once per turn, so nudging the
 * `/supervisor autopilot` command turn itself cost one wasted message. With a
 * real budget it is fatal: the command turn burns the ENTIRE budget within
 * seconds and the exhaustion path disarms autopilot — so `/supervisor
 * autopilot` would turn itself off before the user ever typed a task.
 * Measured directly in test/e2e-opencode.test.mjs ("autopilot nudges
 * repeatedly…"): the task turn ran in reflection mode with zero autopilot
 * nudges.
 *
 * Deliberately narrow: the ENTIRE trimmed message must be the command, so
 * "run /supervisor retry 3 then fix the build" stays actionable.
 */
const SUPERVISOR_CONTROL_TURN = /^\s*\/?(supervisor(:[a-z-]+)?|autopilot)\b[^\n]*$/i

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isSupervisorControlTurn(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  return SUPERVISOR_CONTROL_TURN.test(trimmed)
}

/**
 * The decision the runtimes actually call.
 *
 * ESCAPE HATCH: an active goal (or autopilot) keeps supervising regardless —
 * a goal is a standing, user-set completion contract that outlives any single
 * chatty turn, so "thanks" must not silently disarm it. The ONE thing that
 * escape hatch does not cover is a supervisor control command; see
 * isSupervisorControlTurn.
 *
 * @param {{text?: string, hasActiveGoal?: boolean, mode?: string}} opts
 * @returns {{skip: boolean, reason: string}}
 */
export function shouldSkipReflection({ text, hasActiveGoal, mode } = {}) {
  if (isSupervisorControlTurn(text)) return { skip: true, reason: 'supervisor-control-command' }
  if (hasActiveGoal) return { skip: false, reason: 'active-goal' }
  if (mode === 'autopilot' || mode === 'goal') return { skip: false, reason: `mode:${mode}` }
  const { actionable, category } = classifyTurn(text)
  if (actionable) return { skip: false, reason: 'actionable' }
  return { skip: true, reason: `non-actionable:${category}` }
}
