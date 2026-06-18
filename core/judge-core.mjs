/**
 * judge-core.mjs — runtime-agnostic LLM classifier for premature agent stops.
 *
 * The prompt is assembled from core/patterns.json (shipped ⊕ user-local), so
 * /supervisor:train can sharpen classification by editing patterns only.
 *
 * Exported:
 *   classifyStop(stopContext, opts?) → Promise<{category, reason, confidence, raw_text?, usage?}>
 *   buildPrompt(stopContext, patterns) → string   (exported for evals/tests)
 *   CATEGORY_NAMES(patterns) → string[]
 *
 * Auth: ANTHROPIC_API_KEY, else Claude Code OAuth (file or macOS keychain).
 * Net:  POST https://api.anthropic.com/v1/messages (global fetch).
 */

import { loadPatterns } from './patterns.mjs';
import { buildGoalRequirementSection } from './goal.mjs';
import { callAnthropic, sanitizeError } from './llm-client.mjs';

const DEFAULT_MODEL = process.env.SUPERVISOR_MODEL ?? process.env.REFLECTION_CC_MODEL ?? 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 250;

export function CATEGORY_NAMES(patterns) {
  return (patterns?.categories ?? []).map((c) => c.name);
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

/**
 * Head + tail truncation: long final_assistant_text has both opening
 * commitment ("Let me apply the fixes...") and closing delivery ("All
 * tests pass. PR pushed."). Cutting head-only at fixed N hides the
 * closing, leading to false-positive drift on long delivery turns
 * (observed on real 3-4kb stops in prior prompt-tune cycle).
 */
function truncateHeadTail(s, head, tail) {
  if (!s) return '';
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…[truncated ${s.length - head - tail}ch middle]…\n` + s.slice(-tail);
}

/**
 * Build the classifier prompt from a stopContext + the merged pattern set.
 * @param {object} ctx
 * @param {object} patterns
 * @returns {string}
 */
export function buildPrompt(ctx, patterns, goalCondition) {
  const cats = patterns?.categories ?? [];
  const names = cats.map((c) => c.name);
  const catLines = cats.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  const antipatternBlock = (patterns?.antipatterns ?? []).map((a) => `- ${a.rule}`).join('\n\n');
  const evidenceRules = patterns?.evidence_rules ?? [];
  const evidenceBlock = evidenceRules.length
    ? `\nEVIDENCE RULES (avoid over-demanding proof):\n${evidenceRules.map((r) => `- ${r}`).join('\n')}\n`
    : '';
  const meta = patterns?.meta ?? {};

  const userMsgs = (ctx.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join('\n\n');
  // Head + tail: keep closing delivery visible on long turns (≥4kb) — a
  // fixed head-only cut would hide the result and force false-positive drift.
  const finalText = truncateHeadTail(ctx.final_assistant_text ?? '', 1800, 2400);
  const tools = (ctx.tools_available_inferred ?? []).join(', ');

  const goalBlock = goalCondition ? `\n${buildGoalRequirementSection(goalCondition)}\n` : '';

  const provenance = meta.dataset_size
    ? `PREMATURE-STOP ANTIPATTERNS (mined from ${meta.dataset_size} real agent stops where the user replied; ${meta.premature_pct ?? '~78'}% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). Use these to sharpen category assignments:`
    : 'PREMATURE-STOP ANTIPATTERNS. Use these to sharpen category assignments:';

  const fewShots = patterns?.few_shots ?? [];
  const fewShotBlock = fewShots.length
    ? `\nFEW-SHOT EXAMPLES (real Stop events; mirror the output format):\n${fewShots.map((ex) => {
        const toolsLine = ex.tools ? `TOOLS: ${ex.tools}. ` : '';
        const out = JSON.stringify(ex.output);
        return `${ex.label}${ex.note ? ` (${ex.note})` : ''}: ${toolsLine}FINAL "${ex.final}" → ${out}`;
      }).join('\n')}\n`
    : '';

  return `You classify how a coding assistant ended a turn. Pick ONE category.

CATEGORIES:
${catLines}

TOOLS THE ASSISTANT HAD: ${tools || '(none recorded)'}

USER MESSAGES (in order):
${userMsgs || '(none)'}

FINAL ASSISTANT TEXT:
${finalText}

${provenance}

${antipatternBlock}
${evidenceBlock}${goalBlock}${fewShotBlock}
Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"category": "<one of: ${names.join(' | ')}>", "reason": "<one short sentence citing the specific antipattern or evidence>", "confidence": <0.0-1.0>}`;
}

function parseResponse(text, usage, names) {
  let s = (text ?? '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) {
    return { category: 'PARSE_ERROR', reason: `no json found: ${s.slice(0, 100)}`, confidence: 0, raw_text: text, usage };
  }
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch (err) {
    return { category: 'PARSE_ERROR', reason: err.message, confidence: 0, raw_text: text, usage };
  }
  if (!names.includes(obj.category)) {
    return { category: 'PARSE_ERROR', reason: `unknown category: ${obj.category}`, confidence: 0, raw_text: text, usage };
  }
  return {
    category: obj.category,
    reason: obj.reason ?? '',
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
    raw_text: text,
    usage,
  };
}

/**
 * Classify a Stop event via a judge LLM call.
 * @param {object} stopContext
 * @param {object} [opts] { model, timeoutMs, signal, patterns, cwd }
 */
export async function classifyStop(stopContext, opts = {}) {
  const patterns = opts.patterns ?? loadPatterns({ cwd: opts.cwd });
  const names = CATEGORY_NAMES(patterns);
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Test escape hatch: SUPERVISOR_FAKE_JUDGE=<category>:<confidence>
  const fakeJudge = process.env.SUPERVISOR_FAKE_JUDGE ?? process.env.REFLECTION_CC_FAKE_JUDGE;
  if (fakeJudge) {
    const [cat, conf] = fakeJudge.split(':');
    const category = names.includes(cat) ? cat : 'complete';
    return { category, reason: `[fake judge] ${fakeJudge}`, confidence: parseFloat(conf ?? '0.9') || 0.9 };
  }

  const prompt = buildPrompt(stopContext, patterns, opts.goalCondition);

  let text, usage;
  try {
    const result = await callAnthropic({
      prompt,
      system: 'You are a precise classifier. Output JSON only.',
      model,
      maxTokens: MAX_TOKENS,
      timeoutMs,
      signal: opts.signal,
    });
    text = result.text;
    usage = result.usage;
  } catch (err) {
    if (err.message.includes('timed out')) {
      return { category: 'TIMEOUT', reason: `judge call exceeded ${timeoutMs}ms`, confidence: 0 };
    }
    throw new Error(`judge: ${sanitizeError(err.message)}`);
  }

  return parseResponse(text, usage, names);
}
