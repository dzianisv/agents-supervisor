import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelfAssessmentJson } from '../core/assessment.mjs';
import { evaluateSelfAssessment } from '../core/evaluation.mjs';

test('initial assessment requires its own status schema, not arbitrary JSON or a judge DTO', () => {
  for (const text of ['{"title":"Done"}', '{"complete":false,"missing":["Run checks"]}', '{"status":"achieved"}', 'null']) {
    assert.equal(parseSelfAssessmentJson(text, { requireStatus: true }), null);
  }
});

test('valid self-assessment statuses remain accepted', () => {
  for (const status of ['complete', 'in_progress', 'blocked', 'stuck', 'waiting_for_user']) {
    assert.equal(parseSelfAssessmentJson(JSON.stringify({ status }), { requireStatus: true }).status, status);
  }
});

test('a valid stuck assessment with actionable alternate work continues instead of silently failing parse', () => {
  const assessment = parseSelfAssessmentJson(JSON.stringify({ status: 'stuck', stuck: true, confidence: 0.9, remaining_work: ['Try the alternate implementation and rerun acceptance checks'], next_steps: [], needs_user_action: [] }), { requireStatus: true });
  assert.ok(assessment);
  assert.equal(evaluateSelfAssessment(assessment, {}).shouldContinue, true);
});

test('second-stage judge parsing still accepts its distinct complete/missing schema', () => {
  const verdict = { complete: false, missing: ['Run acceptance checks'], next_actions: ['Run them now'] };
  assert.deepEqual(parseSelfAssessmentJson(JSON.stringify(verdict)), verdict);
});
