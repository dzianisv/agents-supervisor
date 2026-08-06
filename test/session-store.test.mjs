/**
 * session-store.test.mjs — the per-session state layout.
 *
 * Covers the owner's six required cases plus the invariants that make them
 * safe. Every case here failed (or was untestable) before core/session-store.mjs
 * existed.
 *
 * THE BUG BEING FIXED: `.supervisor/current_session` is ONE shared file that
 * every Stop hook in the project overwrites. With two sessions in one repo,
 * `/supervisor off` disabled whichever session stopped LAST — not the caller's.
 * Plus four naming conventions for per-session state with no GC, two of which
 * truncated the session id to 8 chars (a collision risk on its own).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  sessionStore,
  resolveSessionId,
  listSessions,
  listRecentSessions,
  gcSessions,
  maybeGcSessions,
  atomicWriteFileSync,
  statePath,
  verdictsPath,
  sessionDir,
  legacyStatePath,
  legacyAttemptsPath,
  legacyVerdictPath,
  assertSafeSessionId,
  GC_MAX_AGE_MS,
  GC_MAX_SESSIONS,
} from '../core/session-store.mjs';
import { goalStore, resolveSupervisorMode } from '../core/goal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'supervisor.mjs');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sup-store-'));
}

/** Run bin/supervisor.mjs with a scrubbed env so ambient ids never leak in. */
function runCli(cwd, args, env = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDE_SESSION_ID;
  delete clean.SUPERVISOR_SESSION_ID;
  try {
    return {
      code: 0,
      out: execFileSync('node', [CLI, ...args], { cwd, env: { ...clean, ...env }, encoding: 'utf8' }),
    };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function readDisabled(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, '.supervisor', 'disabled'), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

describe('layout', () => {
  test('state lives at .supervisor/sessions/<full session id>/state.json, mode 0600', () => {
    const cwd = tmpProject();
    const sid = 'ses_abcdef0123456789';
    goalStore.setGoal(cwd, sid, 'ship it');

    const p = statePath(cwd, sid);
    assert.equal(p, path.join(cwd, '.supervisor', 'sessions', sid, 'state.json'));
    assert.ok(fs.existsSync(p), 'state.json must exist under the per-session dir');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'file mode must stay 0600');
    assert.equal(sessionStore.load(cwd, sid).goal.condition, 'ship it');
  });

  test('the FULL session id is used — two ids sharing an 8-char prefix do not collide', () => {
    const cwd = tmpProject();
    // The old layout keyed verdicts on sessionId.slice(0,8); these two would
    // have shared one verdict file and one data file.
    const a = 'ses_1234_aaaaaaaa';
    const b = 'ses_1234_bbbbbbbb';
    assert.equal(a.slice(0, 8), b.slice(0, 8), 'fixture precondition: same 8-char prefix');

    sessionStore.appendVerdict(cwd, a, { injected: true, who: 'a' });
    sessionStore.appendVerdict(cwd, b, { injected: false, who: 'b' });

    assert.equal(sessionStore.lastVerdict(cwd, a).who, 'a');
    assert.equal(sessionStore.lastVerdict(cwd, b).who, 'b');
  });

  test('verdicts.jsonl is append-only — history is not overwritten', () => {
    const cwd = tmpProject();
    const sid = 'ses_append';
    sessionStore.appendVerdict(cwd, sid, { n: 1 });
    sessionStore.appendVerdict(cwd, sid, { n: 2 });
    sessionStore.appendVerdict(cwd, sid, { n: 3 });
    const all = sessionStore.readVerdicts(cwd, sid);
    assert.deepEqual(all.map((v) => v.n), [1, 2, 3], 'oldest → newest');
    assert.equal(sessionStore.lastVerdict(cwd, sid).n, 3);
    assert.equal(fs.statSync(verdictsPath(cwd, sid)).mode & 0o777, 0o600);
  });

  test('a corrupt verdict line is skipped, not fatal', () => {
    const cwd = tmpProject();
    const sid = 'ses_corrupt_verdict';
    sessionStore.appendVerdict(cwd, sid, { n: 1 });
    fs.appendFileSync(verdictsPath(cwd, sid), '{not json\n');
    sessionStore.appendVerdict(cwd, sid, { n: 2 });
    assert.deepEqual(sessionStore.readVerdicts(cwd, sid).map((v) => v.n), [1, 2]);
  });

  test('assertSafeSessionId rejects traversal and empties', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../escape', 'x\0y', null, undefined, 7]) {
      assert.throws(() => assertSafeSessionId(bad), /Invalid sessionId/, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(assertSafeSessionId('ses_ok-1.2'), 'ses_ok-1.2');
  });
});

// ---------------------------------------------------------------------------

describe('migration from the old layout', () => {
  /** Lay down a session using ONLY the four legacy conventions. */
  function seedLegacy(cwd, sid, { condition = 'legacy goal', attempts = 3, turnKey = 'turn-A' } = {}) {
    const root = path.join(cwd, '.supervisor');
    fs.mkdirSync(path.join(root, 'goals'), { recursive: true });
    fs.writeFileSync(legacyStatePath(cwd, sid), JSON.stringify({
      mode: 'goal',
      maxAttempts: 9,
      statusDiagram: false,
      projectDir: cwd,
      goal: {
        condition, status: 'active', attempts: 2, tokenBaseline: 0,
        startedAt: 1, deadline: Date.now() + 60_000, lastReason: '', lastTurnKey: turnKey,
      },
    }, null, 2));
    fs.writeFileSync(legacyAttemptsPath(cwd, sid), JSON.stringify({
      count: attempts, turn_key: turnKey, last_iso: new Date().toISOString(),
    }));
    fs.writeFileSync(legacyVerdictPath(cwd, sid), JSON.stringify({ injected: true, status: 'in_progress' }));
    fs.writeFileSync(path.join(root, 'disabled'), `${sid}\n`);
  }

  test('an old-layout session still resolves correctly (goal, retry, flags, disabled)', () => {
    const cwd = tmpProject();
    const sid = 'ses_legacy_one';
    seedLegacy(cwd, sid);

    const state = goalStore.load(cwd, sid);
    assert.equal(state.goal.condition, 'legacy goal', 'the active goal must NOT be lost');
    assert.equal(state.goal.status, 'active');
    assert.equal(state.maxAttempts, 9, 'retry override survives');
    assert.equal(state.statusDiagram, false, 'flags survive');
    assert.equal(state.projectDir, cwd);
    assert.equal(resolveSupervisorMode(state), 'goal');
    assert.deepEqual(readDisabled(cwd), [sid], 'the disabled flag must NOT be lost');
  });

  test('legacy attempts are folded into state.json with per-turn semantics intact', () => {
    const cwd = tmpProject();
    const sid = 'ses_legacy_attempts';
    seedLegacy(cwd, sid, { attempts: 5, turnKey: 'turn-A' });

    assert.equal(sessionStore.readAttempts(cwd, sid, 'turn-A'), 5, 'same turn → count carries over');
    assert.equal(sessionStore.readAttempts(cwd, sid, 'turn-B'), 0, 'new turn → resets to 0');
    assert.equal(sessionStore.readAttempts(cwd, sid), 5, 'no turn key → raw count');
  });

  test('reading migrates forward: the new path exists afterwards and legacy is left intact', () => {
    const cwd = tmpProject();
    const sid = 'ses_legacy_migrate';
    seedLegacy(cwd, sid);
    assert.equal(fs.existsSync(statePath(cwd, sid)), false, 'precondition: nothing at the new path');

    goalStore.load(cwd, sid);

    assert.ok(fs.existsSync(statePath(cwd, sid)), 'must be migrated forward on read');
    assert.equal(JSON.parse(fs.readFileSync(statePath(cwd, sid), 'utf8')).goal.condition, 'legacy goal');
    // Left in place on purpose: deleting it would make a downgrade to an older
    // plugin build silently drop the active goal.
    assert.ok(fs.existsSync(legacyStatePath(cwd, sid)), 'legacy file is NOT deleted by migration');
    // The legacy verdict is carried into the new append-only log.
    assert.equal(sessionStore.lastVerdict(cwd, sid).injected, true);
  });

  test('a migrated session keeps working through goalStore mutations', () => {
    const cwd = tmpProject();
    const sid = 'ses_legacy_mutate';
    seedLegacy(cwd, sid);

    goalStore.setRetry(cwd, sid, 12);
    const after = goalStore.load(cwd, sid);
    assert.equal(after.maxAttempts, 12, 'new write applied');
    assert.equal(after.goal.condition, 'legacy goal', 'migrated goal survives the write');
  });

  test('the new path wins over a stale legacy file', () => {
    const cwd = tmpProject();
    const sid = 'ses_both_layouts';
    seedLegacy(cwd, sid, { condition: 'stale legacy' });
    goalStore.setGoal(cwd, sid, 'current goal');
    assert.equal(goalStore.load(cwd, sid).goal.condition, 'current goal');
  });

  test('a session with no footprint at all reads as {}', () => {
    const cwd = tmpProject();
    assert.deepEqual(goalStore.load(cwd, 'ses_never_seen'), {});
    assert.equal(sessionStore.readAttempts(cwd, 'ses_never_seen', 'k'), 0);
  });
});

// ---------------------------------------------------------------------------

describe('two concurrent sessions in one project', () => {
  test('disabling A does not disable B, and A\'s goal is invisible to B', () => {
    const cwd = tmpProject();
    const A = 'ses_AAAAAAAAAAAA';
    const B = 'ses_BBBBBBBBBBBB';

    goalStore.setGoal(cwd, A, 'A must ship');
    goalStore.setGoal(cwd, B, 'B must ship');
    // B stopped last, so current_session names B — the exact shape that used
    // to make `/supervisor off` hit the wrong session.
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), B, 'utf8');

    const r = runCli(cwd, ['off', '--session', A]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), [A], 'ONLY A is disabled');
    assert.ok(!readDisabled(cwd).includes(B), 'B must stay enabled');

    assert.equal(goalStore.load(cwd, A).goal.condition, 'A must ship');
    assert.equal(goalStore.load(cwd, B).goal.condition, 'B must ship');
  });

  test('per-session state does not leak across sessions on mutation', () => {
    const cwd = tmpProject();
    const A = 'ses_leak_a';
    const B = 'ses_leak_b';
    goalStore.setGoal(cwd, A, 'goal A');
    goalStore.setMode(cwd, B, 'autopilot');

    assert.equal(goalStore.load(cwd, A).goal.condition, 'goal A');
    assert.equal(goalStore.load(cwd, A).mode, 'goal');
    assert.equal(goalStore.load(cwd, B).goal, undefined, "B must not see A's goal");
    assert.equal(goalStore.load(cwd, B).mode, 'autopilot');
  });

  test('attempt counters are independent per session', () => {
    const cwd = tmpProject();
    sessionStore.writeAttempts(cwd, 'ses_c1', 4, 'turn-1');
    sessionStore.writeAttempts(cwd, 'ses_c2', 1, 'turn-1');
    assert.equal(sessionStore.readAttempts(cwd, 'ses_c1', 'turn-1'), 4);
    assert.equal(sessionStore.readAttempts(cwd, 'ses_c2', 'turn-1'), 1);
  });
});

// ---------------------------------------------------------------------------

describe('bin/supervisor.mjs session id resolution', () => {
  test('off with an explicit id acts on THAT session, not on current_session', () => {
    const cwd = tmpProject();
    const target = 'ses_explicit_target';
    const current = 'ses_last_to_stop';
    goalStore.setGoal(cwd, target, 't');
    goalStore.setGoal(cwd, current, 'c');
    fs.mkdirSync(path.join(cwd, '.supervisor'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), current, 'utf8');

    const r = runCli(cwd, ['off', '--session', target]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), [target]);
    assert.ok(r.out.includes(target), 'must name the session it acted on');
    assert.ok(!r.out.includes('current_session'), 'must NOT claim it fell back');
  });

  test('an ambiguous prefix acts on NOTHING and lists the candidates', () => {
    const cwd = tmpProject();
    const A = 'ses_dup_aaaa';
    const B = 'ses_dup_bbbb';
    goalStore.setGoal(cwd, A, 'a');
    goalStore.setGoal(cwd, B, 'b');

    const r = runCli(cwd, ['off', '--session', 'ses_dup_']);
    assert.notEqual(r.code, 0, 'must fail loudly');
    assert.deepEqual(readDisabled(cwd), [], 'NOTHING may be disabled');
    assert.match(r.out, /Ambiguous session/i);
    assert.ok(r.out.includes(A) && r.out.includes(B), 'both candidates must be listed');
  });

  test('no id anywhere + several recent sessions → acts on nothing, lists candidates', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_x1', 'x');
    goalStore.setGoal(cwd, 'ses_x2', 'y');
    // deliberately no current_session, no env

    const r = runCli(cwd, ['off']);
    assert.notEqual(r.code, 0);
    assert.deepEqual(readDisabled(cwd), []);
    assert.match(r.out, /Ambiguous session/i);
  });

  test('a unique prefix is expanded to the full id', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_unique_prefix_1', 'a');
    goalStore.setGoal(cwd, 'ses_other', 'b');
    const r = runCli(cwd, ['off', '--session', 'ses_uniq']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), ['ses_unique_prefix_1']);
  });

  test('SUPERVISOR_SESSION_ID (the hook payload id) beats current_session', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_env_one', 'a');
    goalStore.setGoal(cwd, 'ses_stale_current', 'b');
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), 'ses_stale_current', 'utf8');

    const r = runCli(cwd, ['off'], { SUPERVISOR_SESSION_ID: 'ses_env_one' });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), ['ses_env_one']);
    assert.match(r.out, /SUPERVISOR_SESSION_ID/);
  });

  test('CLAUDE_SESSION_ID is honoured when SUPERVISOR_SESSION_ID is absent', () => {
    const cwd = tmpProject();
    const r = runCli(cwd, ['off'], { CLAUDE_SESSION_ID: 'ses_cc_env' });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), ['ses_cc_env']);
  });

  test('falling back to current_session SAYS SO and names the session', () => {
    const cwd = tmpProject();
    const only = 'ses_only_one_here';
    goalStore.setGoal(cwd, only, 'a');
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), only, 'utf8');

    const r = runCli(cwd, ['off']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), [only]);
    assert.ok(r.out.includes('current_session'), 'the fallback must be disclosed');
    assert.ok(r.out.includes(only), 'the acted-on session must be named in full');
  });

  test('the current_session fallback warns about other recently-active sessions', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_fallback_target', 'a');
    goalStore.setGoal(cwd, 'ses_other_active', 'b');
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), 'ses_fallback_target', 'utf8');

    const r = runCli(cwd, ['off']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), ['ses_fallback_target']);
    assert.match(r.out, /other session\(s\) were also active/i);
    assert.match(r.out, /--session/, 'must tell the user how to target the other one');
  });

  test('`on` re-enables only the named session', () => {
    const cwd = tmpProject();
    const A = 'ses_on_a';
    const B = 'ses_on_b';
    fs.mkdirSync(path.join(cwd, '.supervisor'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.supervisor', 'disabled'), `${A}\n${B}\n`, 'utf8');

    const r = runCli(cwd, ['on', '--session', A]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readDisabled(cwd), [B]);
  });

  test('resolveSessionId precedence, unit level', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_p_current', 'a');
    fs.writeFileSync(path.join(cwd, '.supervisor', 'current_session'), 'ses_p_current', 'utf8');

    assert.equal(resolveSessionId(cwd, { explicit: 'ses_explicit', env: {} }).source, 'explicit');
    assert.equal(resolveSessionId(cwd, { env: { SUPERVISOR_SESSION_ID: 'x' } }).sessionId, 'x');
    assert.equal(resolveSessionId(cwd, { env: { CLAUDE_SESSION_ID: 'y' } }).sessionId, 'y');
    assert.equal(
      resolveSessionId(cwd, { env: { SUPERVISOR_SESSION_ID: 'x', CLAUDE_SESSION_ID: 'y' } }).sessionId,
      'x',
      'SUPERVISOR_SESSION_ID wins over CLAUDE_SESSION_ID'
    );
    const fallback = resolveSessionId(cwd, { env: {} });
    assert.equal(fallback.sessionId, 'ses_p_current');
    assert.equal(fallback.source, 'current_session');
  });

  test('an id with no local footprint is still trusted when passed explicitly', () => {
    // A brand-new session that has not stopped once has no state dir yet;
    // refusing to act on it would make `off` unusable at the start of a session.
    const cwd = tmpProject();
    const r = resolveSessionId(cwd, { explicit: 'ses_brand_new', env: {} });
    assert.equal(r.sessionId, 'ses_brand_new');
    assert.equal(r.ambiguous, false);
  });
});

// ---------------------------------------------------------------------------

describe('atomic write', () => {
  test('an interrupted write does not leave a corrupt state file', () => {
    const cwd = tmpProject();
    const sid = 'ses_atomic';
    goalStore.setGoal(cwd, sid, 'original condition');
    const before = fs.readFileSync(statePath(cwd, sid), 'utf8');

    // Simulate a writer killed mid-write: the temp file exists with a partial
    // payload, and rename never happened.
    const dir = sessionDir(cwd, sid);
    fs.writeFileSync(path.join(dir, '.state.json.9999.999.tmp'), '{"goal":{"condi');

    assert.equal(fs.readFileSync(statePath(cwd, sid), 'utf8'), before, 'target file untouched');
    assert.equal(goalStore.load(cwd, sid).goal.condition, 'original condition', 'state still readable');
  });

  test('the target is never observed partially written (temp is in the same dir, rename is atomic)', () => {
    const cwd = tmpProject();
    const p = path.join(cwd, '.supervisor', 'sessions', 'ses_rename', 'state.json');
    atomicWriteFileSync(p, JSON.stringify({ a: 1 }));
    const seenDuring = [];
    // Interleave: every intermediate write must land as a whole document.
    for (let i = 2; i <= 20; i++) {
      atomicWriteFileSync(p, JSON.stringify({ a: i }));
      seenDuring.push(JSON.parse(fs.readFileSync(p, 'utf8')).a);
    }
    assert.deepEqual(seenDuring, Array.from({ length: 19 }, (_, i) => i + 2));
  });

  test('atomic write leaves no temp files behind', () => {
    const cwd = tmpProject();
    const sid = 'ses_no_temp';
    for (let i = 0; i < 5; i++) goalStore.setRetry(cwd, sid, i + 1);
    const leftovers = fs.readdirSync(sessionDir(cwd, sid)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no .tmp residue');
  });

  test('a corrupt state.json degrades to {} rather than throwing', () => {
    const cwd = tmpProject();
    const sid = 'ses_corrupt_state';
    goalStore.setGoal(cwd, sid, 'x');
    fs.writeFileSync(statePath(cwd, sid), '{ truncated');
    assert.deepEqual(goalStore.load(cwd, sid), {}, 'same failure contract as the code this replaces');
  });

  test('mutate() serialises read-modify-write — no field is clobbered', () => {
    const cwd = tmpProject();
    const sid = 'ses_rmw';
    goalStore.setGoal(cwd, sid, 'keep me');
    sessionStore.mutate(cwd, sid, (s) => { s.maxAttempts = 7; });
    sessionStore.mutate(cwd, sid, (s) => { s.statusDiagram = false; });
    const s = goalStore.load(cwd, sid);
    assert.equal(s.goal.condition, 'keep me');
    assert.equal(s.maxAttempts, 7);
    assert.equal(s.statusDiagram, false);
  });

  test('a stale lock is broken rather than wedging the store', () => {
    const cwd = tmpProject();
    const sid = 'ses_stale_lock';
    goalStore.setGoal(cwd, sid, 'a');
    const lock = path.join(sessionDir(cwd, sid), '.lock');
    fs.writeFileSync(lock, '999999\n');
    // Backdate well past LOCK_STALE_MS.
    const old = Date.now() - 60_000;
    fs.utimesSync(lock, old / 1000, old / 1000);

    const t0 = Date.now();
    goalStore.setRetry(cwd, sid, 5);
    assert.ok(Date.now() - t0 < 1500, 'must not block on a dead holder');
    assert.equal(goalStore.load(cwd, sid).maxAttempts, 5);
  });
});

// ---------------------------------------------------------------------------

describe('attempt counter semantics (preserved through the move)', () => {
  test('monotonic within a turn: a non-advancing write is dropped', () => {
    const cwd = tmpProject();
    const sid = 'ses_mono';
    assert.equal(sessionStore.writeAttempts(cwd, sid, 3, 'turn-1'), true);
    assert.equal(sessionStore.writeAttempts(cwd, sid, 2, 'turn-1'), false, 'lower count ignored');
    assert.equal(sessionStore.readAttempts(cwd, sid, 'turn-1'), 3);
  });

  test('a turn change resets the comparison so the new turn\'s first write lands', () => {
    const cwd = tmpProject();
    const sid = 'ses_turnchange';
    sessionStore.writeAttempts(cwd, sid, 5, 'turn-1');
    assert.equal(sessionStore.writeAttempts(cwd, sid, 1, 'turn-2'), true, 'new turn writes even a lower count');
    assert.equal(sessionStore.readAttempts(cwd, sid, 'turn-2'), 1);
    assert.equal(sessionStore.readAttempts(cwd, sid, 'turn-1'), 0, 'old turn key reads 0');
  });
});

// ---------------------------------------------------------------------------

describe('garbage collection', () => {
  function seedSession(cwd, sid, ageMs) {
    goalStore.setGoal(cwd, sid, `goal ${sid}`);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(statePath(cwd, sid), t, t);
    fs.utimesSync(sessionDir(cwd, sid), t, t);
  }

  test('removes an old session dir and keeps a fresh one', () => {
    const cwd = tmpProject();
    seedSession(cwd, 'ses_old', GC_MAX_AGE_MS + 60_000);
    seedSession(cwd, 'ses_fresh', 60_000);

    const r = gcSessions(cwd);
    assert.deepEqual(r.removed, ['ses_old']);
    assert.equal(fs.existsSync(sessionDir(cwd, 'ses_old')), false, 'old dir gone');
    assert.ok(fs.existsSync(sessionDir(cwd, 'ses_fresh')), 'fresh dir kept');
    assert.equal(goalStore.load(cwd, 'ses_fresh').goal.condition, 'goal ses_fresh');
  });

  test('the live session is never collected, however old it looks', () => {
    const cwd = tmpProject();
    seedSession(cwd, 'ses_live', GC_MAX_AGE_MS * 10);
    const r = gcSessions(cwd, { protect: 'ses_live' });
    assert.deepEqual(r.removed, []);
    assert.ok(fs.existsSync(sessionDir(cwd, 'ses_live')));
  });

  test('the count cap drops the oldest beyond maxSessions', () => {
    const cwd = tmpProject();
    for (let i = 0; i < 6; i++) seedSession(cwd, `ses_cap_${i}`, (6 - i) * 1000);
    const r = gcSessions(cwd, { maxSessions: 3 });
    assert.equal(r.removed.length, 3);
    assert.equal(listSessions(cwd).length, 3);
    // Newest survive: ses_cap_5 (1s old) … ses_cap_3.
    assert.ok(fs.existsSync(sessionDir(cwd, 'ses_cap_5')));
    assert.equal(fs.existsSync(sessionDir(cwd, 'ses_cap_0')), false);
  });

  test('GC also reclaims a removed session\'s legacy sibling files', () => {
    const cwd = tmpProject();
    const sid = 'ses_gc_legacy';
    seedSession(cwd, sid, GC_MAX_AGE_MS + 1000);
    fs.mkdirSync(path.join(cwd, '.supervisor', 'goals'), { recursive: true });
    fs.writeFileSync(legacyStatePath(cwd, sid), '{}');
    fs.writeFileSync(legacyAttemptsPath(cwd, sid), '{}');
    // Backdate the legacy file too or listSessions() sees the session as fresh.
    const t = (Date.now() - GC_MAX_AGE_MS - 1000) / 1000;
    fs.utimesSync(legacyStatePath(cwd, sid), t, t);

    gcSessions(cwd);
    assert.equal(fs.existsSync(legacyStatePath(cwd, sid)), false);
    assert.equal(fs.existsSync(legacyAttemptsPath(cwd, sid)), false);
  });

  test('GC never throws on a missing/unreadable .supervisor', () => {
    const cwd = tmpProject();
    assert.doesNotThrow(() => gcSessions(cwd));
    assert.deepEqual(gcSessions(cwd).removed, []);
  });

  test('maybeGcSessions is throttled — it sweeps once, then stands down', () => {
    const cwd = tmpProject();
    seedSession(cwd, 'ses_throttle_old', GC_MAX_AGE_MS + 1000);
    const first = maybeGcSessions(cwd);
    assert.ok(first, 'first call sweeps');
    assert.deepEqual(first.removed, ['ses_throttle_old']);

    seedSession(cwd, 'ses_throttle_old2', GC_MAX_AGE_MS + 1000);
    assert.equal(maybeGcSessions(cwd), null, 'second call within the window is a no-op');
    assert.ok(fs.existsSync(sessionDir(cwd, 'ses_throttle_old2')));

    // Past the window it sweeps again.
    const later = maybeGcSessions(cwd, { now: Date.now() + 25 * 60 * 60 * 1000 });
    assert.ok(later && later.removed.includes('ses_throttle_old2'));
  });

  test('defaults are the stated policy: 30 days, 200 sessions', () => {
    assert.equal(GC_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(GC_MAX_SESSIONS, 200);
  });
});

// ---------------------------------------------------------------------------

describe('enumeration', () => {
  test('listSessions sees new-layout AND un-migrated legacy sessions, newest first', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_new', 'a');
    fs.mkdirSync(path.join(cwd, '.supervisor', 'goals'), { recursive: true });
    fs.writeFileSync(legacyStatePath(cwd, 'ses_legacy_only'), JSON.stringify({ mode: 'reflection' }));

    const ids = listSessions(cwd).map((s) => s.id);
    assert.ok(ids.includes('ses_new'));
    assert.ok(ids.includes('ses_legacy_only'), 'an unmigrated session must still be nameable');
  });

  test('listRecentSessions filters by the activity window', () => {
    const cwd = tmpProject();
    goalStore.setGoal(cwd, 'ses_recent', 'a');
    goalStore.setGoal(cwd, 'ses_ancient', 'b');
    const t = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(statePath(cwd, 'ses_ancient'), t, t);
    fs.utimesSync(sessionDir(cwd, 'ses_ancient'), t, t);

    const ids = listRecentSessions(cwd).map((s) => s.id);
    assert.deepEqual(ids, ['ses_recent']);
  });
});
