/**
 * verbosity.mjs — deterministic-first style linter for the plainspeak plugin.
 *
 * Mirrors the two-stage shape of core/judge-core.mjs (cheap deterministic pass,
 * LLM only when ambiguous), but judges STYLE (the user's own communication_style
 * contract in ~/.agents/AGENTS.md), not task completion.
 *
 * Exported:
 *   stripNonProse(text) → string
 *   lint(text) → { hits, stats }
 *   scoreVerbosity(text, opts?) → { verdict, score, hits, stats, needsLlm, reasons }
 *   buildStylePrompt(text, lintResult) → string
 *   buildRewriteDirective(result) → string
 *   STYLE_RULES
 *
 * Rules live in core/style-rules.json (data, not code) — same spirit as
 * core/patterns.json for the supervisor plugin: tunable without touching code.
 *
 * scoreVerbosity is pure and synchronous. No network, no fs (STYLE_RULES is
 * read once at module init).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Parsed core/style-rules.json — the data-driven rule set (see file for rule shape). */
export const STYLE_RULES = JSON.parse(readFileSync(join(HERE, 'style-rules.json'), 'utf8'));

// ---------------------------------------------------------------------------
// stripNonProse — remove fenced code, tables, urls, and paths BEFORE any
// word/sentence statistic is computed. This is what makes the scorer measure
// fluff DENSITY rather than raw length: a long, code-heavy reply should
// collapse to a handful of prose sentences and read as terse.
// ---------------------------------------------------------------------------

function isTableLine(line) {
  const t = line.trim();
  if (!t.includes('|')) return false;
  if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(t)) return true; // header separator
  return /^\|.*\|$/.test(t); // a full pipe-delimited row
}

/**
 * @param {string} text
 * @returns {string} prose only — fenced code, inline code, tables, urls, and
 *   file paths removed.
 */
export function stripNonProse(text) {
  if (!text) return '';
  let s = text;

  // Fenced code blocks (``` or ~~~), including any language tag / trailing output.
  s = s.replace(/```[\s\S]*?```/g, '\n');
  s = s.replace(/~~~[\s\S]*?~~~/g, '\n');

  // Inline code spans — these usually carry command output / identifiers, not prose.
  s = s.replace(/`[^`\n]+`/g, ' ');

  // Markdown tables — drop whole rows (data + header-separator lines).
  s = s.split('\n').filter((l) => !isTableLine(l)).join('\n');

  // URLs.
  s = s.replace(/https?:\/\/\S+/g, ' ');

  // Rooted paths: /abs/path, ./rel/path, ../rel/path, ~/home/path.
  s = s.replace(/(?:~|\.{1,2})?\/[\w.\-/]+/g, ' ');

  // Repo-relative paths with an extension, e.g. core/judge-core.mjs, test/foo.test.mjs.
  s = s.replace(/\b[\w-]+(?:\/[\w.-]+)+\.\w+\b/g, ' ');

  // Collapse whitespace left behind by the strips above.
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// Word/sentence/structure statistics over stripped prose.
// ---------------------------------------------------------------------------

function countWords(s) {
  const m = s.match(/[A-Za-z0-9']+/g);
  return m ? m.length : 0;
}

function splitSentences(s) {
  const t = s.trim();
  if (!t) return [];
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function isBulletLine(line) {
  return /^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);
}

function bulletRatioOf(s) {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  const bullets = lines.filter(isBulletLine).length;
  return bullets / lines.length;
}

function countParagraphs(s) {
  return s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// lint — the zero-cost deterministic pass. Runs on every reply.
// ---------------------------------------------------------------------------

function ensureGlobal(flags) {
  return flags.includes('g') ? flags : flags + 'g';
}

/**
 * @param {string} text raw assistant reply (markdown allowed)
 * @returns {{ hits: Array<{rule: string, severity: string, excerpt: string, index: number}>,
 *             stats: { proseWords: number, sentences: number, avgSentenceWords: number,
 *                       bulletRatio: number, paragraphs: number, hedgeCount: number, fillerCount: number } }}
 */
export function lint(text) {
  const stripped = stripNonProse(text);
  const openerWindow = STYLE_RULES.thresholds?.openerWindowChars ?? 100;
  const hits = [];

  for (const rule of STYLE_RULES.rules ?? []) {
    const baseFlags = rule.flags ?? 'i';
    if (rule.anchor === 'start') {
      const scope = stripped.slice(0, openerWindow);
      for (const patSrc of rule.patterns) {
        const re = new RegExp(patSrc, baseFlags);
        const m = scope.match(re);
        if (m) {
          hits.push({ rule: rule.id, severity: rule.severity, excerpt: m[0].trim(), index: m.index ?? 0 });
        }
      }
    } else {
      for (const patSrc of rule.patterns) {
        const re = new RegExp(patSrc, ensureGlobal(baseFlags));
        let m;
        while ((m = re.exec(stripped)) !== null) {
          hits.push({ rule: rule.id, severity: rule.severity, excerpt: m[0].trim(), index: m.index });
          if (m[0].length === 0) re.lastIndex += 1;
        }
      }
    }
  }

  hits.sort((a, b) => a.index - b.index);

  const proseWords = countWords(stripped);
  const sentencesArr = splitSentences(stripped);
  const sentences = sentencesArr.length;
  const avgSentenceWords = sentences > 0 ? proseWords / sentences : proseWords;
  const bulletRatio = bulletRatioOf(stripped);
  const paragraphs = countParagraphs(stripped);
  const hedgeCount = hits.filter((h) => h.rule === 'hedge').length;
  const fillerCount = hits.filter((h) => h.rule === 'filler_opener').length;

  return {
    hits,
    stats: { proseWords, sentences, avgSentenceWords, bulletRatio, paragraphs, hedgeCount, fillerCount },
  };
}

// ---------------------------------------------------------------------------
// scoreVerbosity — combines lint() hits with structural stats into a verdict.
// Pure, synchronous, deterministic: same input always produces the same output.
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {object} [opts] reserved for future tuning; currently unused
 * @returns {{ verdict: 'terse'|'suspect'|'verbose', score: number, hits: Array,
 *             stats: object, needsLlm: boolean, reasons: string[] }}
 */
export function scoreVerbosity(text, opts = {}) {
  void opts;
  const th = STYLE_RULES.thresholds ?? {};
  const stripped = stripNonProse(text);
  const proseWords = countWords(stripped);

  // Constraint: never fire on short replies. Under ~40 words of prose, exit
  // terse immediately — no LLM call, regardless of any regex hit.
  if (proseWords < (th.shortReplyWords ?? 40)) {
    return {
      verdict: 'terse',
      score: 0,
      hits: [],
      stats: { proseWords, sentences: 0, avgSentenceWords: 0, bulletRatio: 0, paragraphs: 0, hedgeCount: 0, fillerCount: 0 },
      needsLlm: false,
      reasons: ['under short-reply word threshold — never fire on short replies'],
    };
  }

  const { hits, stats } = lint(text);
  const weights = th.severityWeight ?? { high: 0.4, medium: 0.2, low: 0.1 };

  let score = 0;
  const reasons = [];
  const seenRules = new Set();
  for (const hit of hits) {
    score += weights[hit.severity] ?? 0.15;
    if (!seenRules.has(hit.rule)) {
      reasons.push(`${hit.rule}: "${hit.excerpt}"`);
      seenRules.add(hit.rule);
    }
  }

  // Structural ambiguity signal: long, multi-paragraph, low-bullet, long-sentence
  // prose with ZERO regex hits — this is exactly what regex cannot resolve
  // ("conclusion buried", "restates the question", "structurally overcomplicated"),
  // so route it to the LLM instead of guessing.
  const structurallySuspect =
    proseWords >= (th.suspectWordFloor ?? 120) &&
    stats.paragraphs >= (th.suspectParagraphFloor ?? 3) &&
    stats.bulletRatio < (th.bulletRatioGood ?? 0.15) &&
    stats.avgSentenceWords > (th.avgSentenceWordsSuspect ?? 22);

  if (structurallySuspect) {
    reasons.push('long multi-paragraph prose, low bullet use, long sentences — structure unclear from regex alone');
  }

  const hasHighSeverityHit = hits.some((h) => h.severity === 'high');
  score = Math.min(1, score);

  let verdict;
  if (hasHighSeverityHit || score >= (th.verboseScore ?? 0.5)) {
    verdict = 'verbose';
  } else if (structurallySuspect || score >= (th.suspectScore ?? 0.2)) {
    verdict = 'suspect';
  } else {
    verdict = 'terse';
  }

  const needsLlm = verdict === 'suspect';

  return { verdict, score, hits, stats, needsLlm, reasons };
}

// ---------------------------------------------------------------------------
// buildStylePrompt — LLM judge prompt, called ONLY when scoreVerbosity says
// needsLlm (verdict === 'suspect'). Mirrors judge-core.mjs's buildPrompt shape:
// a single-line JSON contract, no markdown fence.
// ---------------------------------------------------------------------------

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

/**
 * @param {string} text raw assistant reply
 * @param {{hits: Array<{rule:string, severity:string, excerpt:string}>}} lintResult
 *   the result of lint(text) — passed in so the prompt can tell the judge what
 *   the deterministic pass already caught, and ask it to look past that.
 * @returns {string}
 */
export function buildStylePrompt(text, lintResult) {
  const stripped = stripNonProse(text);
  const excerpt = truncate(stripped, 3000);
  const hits = lintResult?.hits ?? [];
  const hitsBlock = hits.length
    ? hits.map((h) => `- ${h.rule} (${h.severity}): "${h.excerpt}"`).join('\n')
    : '(none — the deterministic linter found no filler/hedge/praise/apology/self-narration matches)';

  return `You judge an assistant reply against a plain-English style contract, but ONLY for issues a regex linter cannot see. A deterministic linter already ran; do not re-flag anything it already caught below — look past it.

WHAT TO LOOK FOR (regex-blind failures only):
- The conclusion is buried after multiple reasons/paragraphs instead of stated first (one reason, not three).
- The reply restates or summarizes the question/task before answering, when not asked to.
- The prose is structurally overcomplicated — nested caveats, meandering paragraphs, no clear throughline — even though no single sentence trips a filler/hedge pattern.

LINTER FINDINGS (already known, already penalized — do not repeat):
${hitsBlock}

REPLY (non-prose stripped):
${excerpt}

Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"verdict": "<terse|verbose>", "worst_offense": "<short phrase naming the single worst issue found, empty string if none>", "rewrite_directive": "<one sentence telling the agent exactly what to fix, empty string if verdict is terse>"}`;
}

// ---------------------------------------------------------------------------
// buildRewriteDirective — the text injected back into the agent. Surgical:
// names the specific offenses with excerpts, then gives ONE instruction that
// fixes them. Never echoes the whole rubric back (that would itself be fluff).
// ---------------------------------------------------------------------------

const OFFENSE_LABEL = {
  filler_opener: (hits) => `filler opener ("${hits[0].excerpt}")`,
  hedge: (hits) =>
    hits.length > 1
      ? `${hits.length} hedges (${hits.map((h) => `"${h.excerpt}"`).join(', ')})`
      : `hedge ("${hits[0].excerpt}")`,
  praise: (hits) => `praise ("${hits[0].excerpt}")`,
  apology: (hits) => `apology ("${hits[0].excerpt}")`,
  self_doubt: (hits) => `self-doubt ("${hits[0].excerpt}")`,
  self_narration: (hits) => `self-narration ("${hits[0].excerpt}")`,
};

/**
 * @param {{ hits?: Array<{rule:string, severity:string, excerpt:string}>,
 *           llmJudge?: { verdict: string, worst_offense?: string, rewrite_directive?: string } }} result
 *   Typically scoreVerbosity(text)'s return value, optionally merged with the
 *   parsed JSON from an LLM call made with buildStylePrompt() as `llmJudge`.
 * @returns {string} the directive to inject, or '' if there is nothing to fix.
 */
export function buildRewriteDirective(result) {
  const hits = result?.hits ?? [];
  const byRule = new Map();
  for (const h of hits) {
    if (!byRule.has(h.rule)) byRule.set(h.rule, []);
    byRule.get(h.rule).push(h);
  }

  const offenses = [];
  for (const [ruleId, ruleHits] of byRule) {
    const label = OFFENSE_LABEL[ruleId] ? OFFENSE_LABEL[ruleId](ruleHits) : `${ruleId} ("${ruleHits[0].excerpt}")`;
    offenses.push(label);
  }

  const llm = result?.llmJudge;
  if (llm?.worst_offense) offenses.push(llm.worst_offense);

  if (offenses.length === 0) return '';

  const correctiveByRule = {};
  for (const rule of STYLE_RULES.rules ?? []) correctiveByRule[rule.id] = rule.corrective;

  const instructions = [];
  const seenInstr = new Set();
  for (const ruleId of byRule.keys()) {
    const c = correctiveByRule[ruleId];
    if (c && !seenInstr.has(c)) {
      instructions.push(c);
      seenInstr.add(c);
    }
  }
  if (llm?.rewrite_directive && !seenInstr.has(llm.rewrite_directive)) {
    instructions.push(llm.rewrite_directive);
  }

  const instructionText = instructions.length ? instructions.join(' ') : 'Cut the fluff and lead with the conclusion.';

  return `Rewrite. Offenses: ${offenses.join(', ')}. ${instructionText} Same facts, fewer words.`;
}
