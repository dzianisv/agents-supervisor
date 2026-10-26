// Pi-specific strict boundary; do NOT change the compatible shared parser.
// Missing upcoming production helper is a hard module-load failure, never a skip
// or a local substitute implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiAssessment } from '../pi/assessment.ts';

const valid = () => ({ task_summary: 'Wrote note.txt as requested', task_type: 'docs', status: 'complete', confidence: 1,
  evidence: { tests: { ran: false, results: 'unknown', ran_after_changes: false, commands: [] },
    build: { ran: false, results: 'unknown' }, pr: { created: false, url: '', ci_status: 'unknown', checked: false } },
  remaining_work: [], next_steps: [], needs_user_action: [], stuck: false, alternate_approach: '' });
const parse = value => parsePiAssessment(JSON.stringify(value));

test('Explicit unknown evidence is structurally valid; arbitrary goals need no tests/build/PR', () => {
  const dto = parse(valid());
  assert.equal(dto.status, 'complete'); assert.equal(dto.evidence.tests.results, 'unknown');
  assert.equal(dto.evidence.tests.ran, false); assert.equal(dto.evidence.build.results, 'unknown');
  assert.equal(dto.evidence.pr.ci_status, 'unknown'); assert.equal(dto.evidence.pr.created, false);
});
test('All declared statuses and evidence result enums are accepted without inventing workflow requirements', () => {
  for (const status of ['complete', 'in_progress', 'blocked', 'stuck', 'waiting_for_user']) {
    for (const result of ['pass', 'fail', 'unknown']) {
      const a = valid(); a.status = status; a.evidence.tests.results = result;
      a.evidence.build.results = result; a.evidence.pr.ci_status = result;
      assert.equal(parse(a).status, status);
    }
  }
});
test('Concrete evidence commands/URL and nonempty work lists survive parsing', () => {
  const a = valid(); a.evidence.tests = { ran: true, results: 'pass', ran_after_changes: true, commands: ['arbitrary goal-specific command'] };
  a.evidence.pr = { created: true, url: 'https://example.invalid/pr/7', ci_status: 'unknown', checked: false };
  a.remaining_work = ['Write the local report']; a.next_steps = ['Collect available observations']; a.needs_user_action = ['Provide API key'];
  const dto = parse(a); assert.deepEqual(dto.evidence, a.evidence); assert.deepEqual(dto.remaining_work, a.remaining_work);
});

const bad = [];
const reject = (name, change) => { const a = valid(); change(a); bad.push([name, JSON.stringify(a)]); };
for (const value of [null, [], 'complete', 1]) bad.push([`non-record root ${JSON.stringify(value)}`, JSON.stringify(value)]);
for (const field of ['task_summary', 'task_type', 'status', 'confidence', 'evidence', 'remaining_work', 'next_steps', 'needs_user_action', 'stuck', 'alternate_approach'])
  reject(`missing required ${field}`, a => { delete a[field]; });
for (const value of [[], null, 'unknown']) reject(`evidence non-record ${JSON.stringify(value)}`, a => { a.evidence = value; });
for (const part of ['tests', 'build', 'pr']) {
  reject(`missing evidence.${part}`, a => { delete a.evidence[part]; });
  reject(`array evidence.${part}`, a => { a.evidence[part] = []; });
  reject(`null evidence.${part}`, a => { a.evidence[part] = null; });
}
for (const [part, field] of [['tests', 'ran'], ['tests', 'results'], ['tests', 'ran_after_changes'], ['tests', 'commands'],
  ['build', 'ran'], ['build', 'results'], ['pr', 'created'], ['pr', 'url'], ['pr', 'ci_status'], ['pr', 'checked']])
  reject(`missing evidence.${part}.${field}`, a => { delete a.evidence[part][field]; });
for (const [part, field, value] of [['tests', 'ran', 'false'], ['tests', 'ran_after_changes', null], ['tests', 'results', 'success'],
  ['tests', 'commands', 'npm test'], ['tests', 'commands', [7]], ['build', 'ran', 0], ['build', 'results', true],
  ['pr', 'created', 'no'], ['pr', 'url', {}], ['pr', 'ci_status', 'green'], ['pr', 'checked', 1]])
  reject(`wrong evidence.${part}.${field}: ${JSON.stringify(value)}`, a => { a.evidence[part][field] = value; });
for (const [field, value] of [['status', 'done'], ['task_type', {}], ['task_summary', []], ['confidence', '1'], ['confidence', -0.1],
  ['confidence', 1.1], ['stuck', 'false'], ['remaining_work', {}], ['next_steps', [null]], ['needs_user_action', [9]], ['alternate_approach', false]])
  reject(`wrong ${field}: ${JSON.stringify(value)}`, a => { a[field] = value; });
const json = JSON.stringify(valid());
bad.push(['duplicate root status', json.replace('"status":"complete"', '"status":"in_progress","status":"complete"')]);
bad.push(['duplicate nested results', json.replace('"results":"unknown"', '"results":"pass","results":"unknown"')]);
bad.push(['escaped duplicate nested checked', json.replace('"checked":false', '"checked":true,"\\u0063hecked":false')]);
bad.push(['JSON prose wrapper', 'Here is the assessment: ' + json]);
bad.push(['Markdown fence', '```json\n' + json + '\n```']);
bad.push(['trailing JSON', json + '{}']);
bad.push(['syntactically invalid JSON', '{not-json']);
for (const [name, input] of bad) test(`Strict assessment rejects ${name}`, () => {
  assert.throws(() => parsePiAssessment(input), undefined, 'Malformed DTO must throw, not coerce/default/extract/retire');
});

// 3 positive + 4 roots + 10 missing top-level + 3 evidence records + 9 nested
// records + 10 nested fields + 11 nested types + 11 top-level types + 7 JSON = 68.
assert.equal(bad.length + 3, 68, 'Review parser case count explicitly; zero/skipped cases never pass');
