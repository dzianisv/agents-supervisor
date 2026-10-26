import { parseStrictJSON } from '../core/focus.mjs';
import { parseSelfAssessmentJson } from '../core/assessment.mjs';

const record = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: any) => Array.isArray(v) && v.every(s => typeof s === 'string');
const fields = (v: any, keys: string[]) => record(v) && keys.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => keys.includes(k));
const result = (v: any) => ['pass', 'fail', 'unknown'].includes(v);

/** Validate the requested Pi DTO before the compatible shared parser/evaluator.
 * Explicit unknown/ran:false is evidence, not a new workflow obligation.
 * Reject unknown fields rather than silently losing potentially actionable work. */
export function parsePiAssessment(text: string) {
  const a = parseStrictJSON(text);
  const e = a?.evidence;
  if (!fields(a, ['task_summary', 'task_type', 'status', 'confidence', 'evidence',
    'remaining_work', 'next_steps', 'needs_user_action', 'stuck', 'alternate_approach'])
    || typeof a.task_summary !== 'string'
    || !['feature', 'bugfix', 'refactor', 'docs', 'research', 'ops', 'other'].includes(a.task_type)
    || !['complete', 'in_progress', 'blocked', 'stuck', 'waiting_for_user'].includes(a.status)
    || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1
    || !['remaining_work', 'next_steps', 'needs_user_action'].every(k => strings(a[k]))
    || typeof a.stuck !== 'boolean' || typeof a.alternate_approach !== 'string'
    || !fields(e, ['tests', 'build', 'pr'])
    || !fields(e.tests, ['ran', 'results', 'ran_after_changes', 'commands'])
    || typeof e.tests.ran !== 'boolean' || !result(e.tests.results)
    || typeof e.tests.ran_after_changes !== 'boolean' || !strings(e.tests.commands)
    || !fields(e.build, ['ran', 'results']) || typeof e.build.ran !== 'boolean' || !result(e.build.results)
    || !fields(e.pr, ['created', 'url', 'ci_status', 'checked']) || typeof e.pr.created !== 'boolean'
    || typeof e.pr.url !== 'string' || !result(e.pr.ci_status) || typeof e.pr.checked !== 'boolean') {
    throw new Error('Malformed Pi assessment');
  }
  // Preserve the shared DTO representation and every validated field.
  const dto = parseSelfAssessmentJson(text, { requireStatus: true });
  if (!dto) throw new Error('Malformed Pi assessment');
  return dto;
}
