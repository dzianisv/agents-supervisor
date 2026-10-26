/**
 * feedback-core.mjs — per-category feedback templates, driven by patterns.json.
 *
 * Exported:
 *   buildFeedback(category, ctx, attempt, patterns?) → { shouldInject, reason, additionalContext }
 *   injectCategories(patterns) → Set<string>
 *
 * Template messages live in patterns.feedback.templates.<category>.messages
 * (array indexed by 1-based attempt, clamped to last). Placeholders:
 *   {stepClause} — derived from the agent's named next step (summary_drift_stop)
 *   {toolList}   — comma-joined available tools (tool_available_punt)
 */

import { loadPatterns } from './patterns.mjs';

const NEVER_INJECT_FAILSAFE = {
  complete: 'task_complete',
  waiting_for_user_legitimate: 'legitimate_user_wait',
  working: 'still_working',
  TIMEOUT: 'timeout_failsafe',
  PARSE_ERROR: 'parse_error_failsafe',
  API_ERROR: 'api_error_failsafe',
};

export function injectCategories(patterns) {
  return new Set(patterns?.feedback?.inject_categories ?? []);
}

function extractNextStep(text) {
  if (!text) return null;
  const patterns = [
    /next\s+step[s]?\s*[:–—]\s*([^.!?\n]+[.!?]?)/i,
    /next[,]?\s+i[''](?:ll|m going to)\s+([^.!?\n]+[.!?]?)/i,
    /now\s+i[''](?:ll|m going to)\s+([^.!?\n]+[.!?]?)/i,
    /i(?:'ll|'m going to| will| am going to)\s+now\s+([^.!?\n]+[.!?]?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim().slice(0, 200);
  }
  return null;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '<none recorded>';
  return tools.join(', ');
}

function pick(arr, attempt) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const idx = Math.min(Math.max(attempt, 1), arr.length) - 1;
  return arr[idx];
}

/**
 * @param {string} category
 * @param {object} ctx { final_assistant_text, tools_available_inferred, session_id }
 * @param {number} attempt 1-based
 * @param {object} [patterns]
 * @returns {{ shouldInject: boolean, reason: string, additionalContext: string|null }}
 */
export function buildFeedback(category, ctx, attempt, patterns) {
  const p = patterns ?? loadPatterns();
  const maxAttempt = p?.feedback?.max_inject_attempt ?? 3;

  if (attempt >= maxAttempt + 1) {
    return { shouldInject: false, reason: 'attempt_cap', additionalContext: null };
  }

  if (category in NEVER_INJECT_FAILSAFE) {
    return { shouldInject: false, reason: NEVER_INJECT_FAILSAFE[category], additionalContext: null };
  }

  if (!injectCategories(p).has(category)) {
    return { shouldInject: false, reason: `unknown_category:${category}`, additionalContext: null };
  }

  const tpl = p?.feedback?.templates?.[category];
  if (!tpl) {
    return { shouldInject: false, reason: `no_template:${category}`, additionalContext: null };
  }

  let msg = pick(tpl.messages, attempt);
  const reason = pick(tpl.reasons, attempt) || `${category}: inject ${attempt}`;

  // Placeholder interpolation
  if (msg.includes('{stepClause}')) {
    const nextStep = extractNextStep(ctx?.final_assistant_text ?? '');
    const stepClause = nextStep
      ? `The next step you named was: "${nextStep}".`
      : 'Your last message described a next step but did not execute it.';
    msg = msg.split('{stepClause}').join(stepClause);
  }
  if (msg.includes('{toolList}')) {
    msg = msg.split('{toolList}').join(summarizeTools(ctx?.tools_available_inferred ?? []));
  }

  return { shouldInject: true, reason, additionalContext: msg };
}
