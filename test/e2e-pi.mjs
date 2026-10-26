// npm run test:pi — native suites are deliberately SEQUENTIAL, never a glob.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHost, packageRoot } from './helpers/pi-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = requireHost();
assert(existsSync(join(root, 'pi/supervisor.ts')), 'Missing production extension; no native-suite skip is allowed');
const graph = Object.fromEntries(['pi-coding-agent', 'pi-agent-core', 'pi-ai'].map(name => {
  const path = name === 'pi-coding-agent' ? join(packageRoot, 'package.json') : join(root, 'node_modules/@earendil-works', name, 'package.json');
  assert(existsSync(path), `Missing SDK transitive package ${name}`);
  return [name, JSON.parse(readFileSync(path, 'utf8')).version];
}));
console.log(`# Actual package bin ${JSON.stringify(host)}; SDK graph ${JSON.stringify(graph)}`);
console.log('# Bundled CLI and public SDK are tested separately; their dependency graphs are NOT asserted equivalent.');
console.log('# Deterministic actor/judge fixtures prove native wiring, not live semantic reliability.');
const suites = [
  ['test/e2e-pi-boundary.mjs', 19],
  ['test/e2e-pi-tools.mjs', 24],
  ['test/e2e-pi-lifecycle.mjs', 38],
  ['test/e2e-pi-review.mjs', 56],
  ['test/pi-assessment.test.mjs', 68, 'unit'],
];
let total = 0;
for (const [file, expected, kind] of suites) {
  assert(existsSync(join(root, file)), `Missing mandatory native suite ${file}`);
  console.log(`# BEGIN sequential ${file}: expected ${expected} cases`);
  // Construct, do not copy, process environment. Each suite further isolates SDK,
  // CLI and PTY children in private HOME/XDG/agent/session fixture directories.
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1' };
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test-reporter=tap', ...(kind === 'unit' ? ['--test'] : []), join(root, file),
    ...(kind !== 'unit' && process.argv.includes('--keep') ? ['--keep'] : [])], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', expired = false;
  child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
  child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
  const soft = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 240000);
  const hard = setTimeout(() => child.kill('SIGKILL'), 242000);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(soft); clearTimeout(hard); }
  assert(!expired, `Native suite timed out: ${file}`);
  assert.equal(result.code, 0, `${file} failed (${result.signal})\n${stderr.slice(-2000)}`);
  const metric = name => {
    const values = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    assert.equal(values.length, 1, `${file}: missing/ambiguous native test summary ${name}`);
    return Number(values[0][1]);
  };
  assert.equal(metric('tests'), expected, `${file}: missing/zero cases`);
  assert.equal(metric('pass'), expected, `${file}: not all mandatory cases passed`);
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(metric(name), 0, `${file}: ${name} cannot pass`);
  total += expected;
}
assert.equal(total, 205);
console.log('# Pi regression gate: 137 native + 68 strict-parser = 205/205 required, zero skipped; sequential suites.');
console.log('# Includes labeled unsupported-composition negative controls, not protected/authenticated cases. Live-model acceptance is separate.');
