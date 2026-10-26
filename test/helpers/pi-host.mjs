import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const helpers = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(helpers, '../../node_modules/@earendil-works/pi-coding-agent');
export const cli = join(packageRoot, 'dist/bundle/cli.js');
export function requireHost() {
  assert(existsSync(cli), `Missing pinned Pi CLI: ${cli}`);
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.2.0', 'Native feasibility requires EXACT pinned host');
  assert.equal(resolve(packageRoot, pkg.bin.pi), cli, 'Test the actual user-facing package bin, not an unbundled substitute');
  return { version: pkg.version, cli, node: process.version };
}
export function sandbox(config) {
  requireHost();
  const root = mkdtempSync(join(tmpdir(), 'pi-native-boundary-'));
  chmodSync(root, 0o700);
  for (const name of ['cwd', 'home', 'agent', 'sessions', 'xdg-config', 'xdg-cache', 'xdg-data', 'tmp']) mkdirSync(join(root, name), { mode: 0o700 });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data'),
    PI_CODING_AGENT_DIR: join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1',
    PI_BOUNDARY_ROOT: root, PI_BOUNDARY_CONFIG: join(root, 'config.json'), PI_BOUNDARY_REQUESTS: join(root, 'requests.jsonl'),
    PI_IMAGE_PROTOCOL: 'none', PI_HYPERLINKS: '0', PI_PROGRAM_STATUS: '0' };
  // Allowlist from scratch: no PI_SESSION_*, NODE_TEST_CONTEXT, cloud/auth, proxies or global resources.
  writeFileSync(env.PI_BOUNDARY_CONFIG, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(root, 'project-goal'), 'TEST ONLY original goal', { mode: 0o600 });
  writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false },
    cacheWarming: 'off', defaultProjectTrust: 'never', quietStartup: true, theme: 'dark', enableInstallTelemetry: false }), { mode: 0o600 });
  return { root, env, cwd: join(root, 'cwd'), config, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
export function cliArgs(box, mode = 'json') {
  return [cli, '--no-extensions', '-e', join(helpers, 'pi-provider.ts'), '-e', join(helpers, 'pi-tools.ts'),
    '--no-context-files', '--no-mcp', '--no-approve', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--no-builtin-tools', '--session-dir', join(box.root, 'sessions'), '--offline', '--provider', 'boundary-local', '--model', 'fixture',
    '--thinking', 'off', ...(mode === 'tui' ? ['--tui-mode', 'regular'] : mode === 'print' ? ['--print'] : ['--mode', mode])];
}
export async function runProcess(command, args, box, { timeoutMs = 20000, input = '', expectedCode = 0 } = {}) {
  const child = spawn(command, args, { cwd: box.cwd, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const hardTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 2000);
  child.stdin.end(input);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
    });
    writeFileSync(join(box.root, 'stdout.log'), stdout, { mode: 0o600 });
    writeFileSync(join(box.root, 'stderr.log'), stderr, { mode: 0o600 });
    assert(!timedOut, `Child timed out: ${command}\n${stderr}`);
    assert.equal(code, expectedCode, `Child exit ${code}/${signal}\n${stderr}\n${stdout.slice(-3000)}`);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); clearTimeout(hardTimer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
export function records(box, name = 'hooks.jsonl') {
  const path = join(box.root, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
export async function waitFor(predicate, label, ms = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`Timeout waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function controlledSession(box) {
  const sdk = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  const { fixtureProvider } = await import('./pi-provider.ts');
  const { installProbes } = await import('./pi-tools.ts');
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 },
    retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never', packages: [] });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(box.root, 'agent/auth.json'),
    modelsPath: null, modelsStorePath: join(box.root, 'agent/catalog.json'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('boundary-local', fixtureProvider(box.config, join(box.root, 'requests.jsonl')));
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: box.cwd, agentDir: join(box.root, 'agent'), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Synthetic LOCAL native boundary proof. Not a real model.',
    extensionFactories: [pi => installProbes(pi, box.config, box.root)] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
  const manager = sdk.SessionManager.create(box.cwd, join(box.root, 'sessions'));
  const { session } = await sdk.createAgentSession({ cwd: box.cwd, agentDir: join(box.root, 'agent'), modelRuntime,
    model: modelRuntime.getModel('boundary-local', 'fixture'), thinkingLevel: 'off', resourceLoader, settingsManager,
    tools: [], sessionManager: manager });
  const errors = [];
  await session.bindExtensions({ mode: 'json', onError: error => errors.push(error) });
  session.subscribe(event => {
    // Complete native events retained privately, independent of extension hook captures.
    const path = join(box.root, 'events.jsonl');
    // Dynamic import is unnecessary; append is synchronous to preserve event order.
    appendEvent(path, event);
  });
  return { session, manager, sdk, errors };
}
function appendEvent(path, event) { appendFileSync(path, JSON.stringify(event) + '\n', { mode: 0o600 }); }
