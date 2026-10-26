import { classifyTurn, isSupervisorControlTurn } from '../core/turn-classifier.mjs';

// Pi authorization is stricter than the legacy classifier's artifact escape.
// Match a request for a recap, not a filename/quoted occurrence of "status".
const recap = /^(?:(?:please|just|only)\s+|(?:give|show|get|tell)\s+me\s+(?:a |the )?|(?:provide|report)\s+(?:a |the )?|(?:what(?:'s|\s+is)|how\s+is)\s+(?:the\s+)?|(?:can|could|would)\s+you\s+|i\s+(?:only\s+)?want\s+(?:a |the )?)*(?:status|sitrep|recap|summary|summari[sz]e|tl;?\s?dr|sum\s+up|where\s+are\s+we|what\s+(?:happened|did\s+you\s+do))\b/i;
const imperative = /^(?:(?:please|also|then|now)\s+)*(?:implement|fix|add|create|build|refactor|update|remove|delete|rename|deploy|write|run|test|verify|check|investigate|debug|review|audit|research|generate|draft|design|document|install|configure|continue|proceed|provision|commit|push|open)\b/i;
// Information requests remain read-only even when their subject names a file.
// Recognize the speech act, rather than enumerating every status noun/filename.
const inquiry = /^(?:(?:please|just|only|now)\s+)*(?:(?:can|could|would)\s+you\s+)?(?:tell\s+me\b|let\s+me\s+know\b)/i;
const statusQuestion = /^(?:(?:please|just|only)\s+)*(?:is|are|has|have|did|does|what|where|how|whether)\b[\s\S]*\b(?:status|progress|complete|completed|done|finished|ready|pending|going|remaining)\b/i;

export function isPiWorkInput(text: string): boolean {
  if (isSupervisorControlTurn(text)) return false;
  // Negative clauses must not turn "do not run tools" into a work order.
  const clauses = text.trim().split(/[.!?;\n]+(?:\s|$)|\s+(?:and\s+then|then|and|but|also)\s+/i).map(s => s.trim()).filter(Boolean);
  const negative = /^(?:(?:please|just)\s+)*(?:do\s+not|don't|never|no)\b/i;
  // An explicit global tool prohibition cannot authorize an effect; narrower
  // restrictions ("write status.md; do not run tests") still allow real work.
  if (clauses.some(c => negative.test(c) && /\b(?:run|use|call|execute)\s+(?:any\s+)?tools?\b/i.test(c))) return false;
  if (clauses.length && clauses.every(c => negative.test(c))) return false;
  const hasRecap = clauses.some(c => recap.test(c) || inquiry.test(c) || statusQuestion.test(c) || /^(?:read[- ]only|status[- ]only)\b/i.test(c));
  if (hasRecap) {
    const prohibited = clauses.some(c => negative.test(c) && /\b(?:tools?|work|implement|write|change|run)\b/i.test(c));
    // A genuine combined request ("give status; then fix X") remains work.
    // Contradictory read-only + work intent requires clarification, not restart.
    if (prohibited || !clauses.some(c => !negative.test(c) && imperative.test(c))) return false;
  }
  return classifyTurn(text).actionable;
}
