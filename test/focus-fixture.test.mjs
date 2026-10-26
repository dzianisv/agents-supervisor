import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupFocusFixture, verifyFocusFixture } from './helpers/focus-sandbox.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'focus-helper-oracle-'));
  const cwd = join(root, 'cwd'); mkdirSync(cwd, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return setupFocusFixture(cwd, { scenario: 'F6' });
}
const correct = `import {isFiniteNumber} from './dependency.mjs';
export function clamp(value,min,max) {
  if (![value,min,max].every(isFiniteNumber)) throw new TypeError('finite numbers required');
  if (min > max) throw new RangeError('range reversed');
  return Math.min(max,Math.max(min,value));
}
`;
function implementation(f, source = correct) {
  writeFileSync(join(f.cwd, 'clamp.mjs'), source, { mode: 0o600 });
  writeFileSync(join(f.cwd, 'clamp.test.mjs'), "import {test} from 'node:test'; test('worker fixture',()=>{});\n", { mode: 0o600 });
}

test('frozen F6 is a coding helper/dependency/test task, not another customer audit', t => {
  const f = fixture(t);
  assert.match(f.request, /Implement the exported clamp/);
  assert.match(f.request, /docs\/dependency\.md/);
  assert.match(f.request, /node --test clamp\.test\.mjs/);
  assert(!f.request.includes('Audit the fixture customers'));
});

test('F6 independent oracle runs six REAL tests even beneath the parent node:test runner', t => {
  const f = fixture(t); implementation(f);
  const result = verifyFocusFixture(f);
  assert.equal(result.helperIndependentTests, 6); assert.equal(result.helperTestsPassed, 6);
  const evidence = readFileSync(join(f.cwd, '..', 'independent-helper.tap'), 'utf8');
  assert.match(evidence, /^# tests 6$/m); assert.match(evidence, /^# pass 6$/m);
});

test('F6 oracle rejects an incorrect helper instead of trusting worker tests/prose', t => {
  const f = fixture(t);
  implementation(f, "import {isFiniteNumber} from './dependency.mjs'; export function clamp(value){return value;}\n");
  assert.throws(() => verifyFocusFixture(f));
});

test('F6 oracle rejects changed immutable dependency inputs', t => {
  const f = fixture(t); implementation(f);
  writeFileSync(join(f.cwd, 'dependency.mjs'), 'export const isFiniteNumber = () => true;\n');
  assert.throws(() => verifyFocusFixture(f), /Fixture input\/script changed/);
});
