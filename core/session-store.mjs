/**
 * session-store.mjs — THE single accessor for per-session MACHINE state.
 *
 * Owner's layout decision (2026-08-06). Per-session machine state gets ONE
 * home; project CONFIG stays where it is and is NOT sharded:
 *
 *   .agents/supervisor/          human-written, git-committed, ONE per project
 *     SystemPrompt.md  Patterns.md  User.md  Goal.md  goal-history.jsonl
 *
 *   .supervisor/                 machine-written, gitignored
 *     sessions/<session_id>/     everything per-session
 *       state.json               mode, goal, attempts, flags
 *       verdicts.jsonl           append-only verdict log
 *     disabled                   unchanged (a set of ids; it already works)
 *     current_session            unchanged, but demoted to a LAST-RESORT hint
 *
 * Precedence rule preserved: session overrides project overrides shipped
 * default. This module owns only the session tier.
 *
 * WHY ONE MODULE: `supervisorStore` (opencode/supervisor-impl.ts) and
 * `goalStore` (core/goal.mjs) were two implementations of the same on-disk
 * contract. This repo has repeatedly shipped bugs from duplicated logic
 * drifting (two extractors, two truncation constants, two
 * isStatusDiagramEnabled). Both are now thin adapters over this file:
 * goalStore re-exports it verbatim, supervisorStore wraps it in async
 * signatures. There is no second implementation.
 *
 * SYNC BY DESIGN: the Claude Code hook and the CLIs are synchronous, and the
 * OpenCode plugin already calls sync core helpers (writeProjectGoal,
 * retireProjectGoal, readProjectGoalCondition). A sync core with an async
 * adapter is one implementation; an async core with a sync adapter is
 * impossible. Payloads are a single small JSON object per session.
 */

import fs from 'node:fs';
import path from 'node:path';

export const STATE_ROOT = '.supervisor';
export const SESSIONS_SUBDIR = 'sessions';
export const STATE_FILE = 'state.json';
export const VERDICTS_FILE = 'verdicts.jsonl';

/** Retention defaults — see gcSessions(). */
export const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days untouched
export const GC_MAX_SESSIONS = 200;                     // hard cap on dir count
export const GC_THROTTLE_MS = 24 * 60 * 60 * 1000;      // sweep at most daily
export const GC_STAMP_FILE = '.gc-stamp';

/** A session is "recently active" for ambiguity reporting within this window. */
export const RECENT_SESSION_MS = 24 * 60 * 60 * 1000;

/** Stale lock breaker — a holder older than this is assumed dead. */
export const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_MAX_WAIT_MS = 2_000;

// --- paths -----------------------------------------------------------------

/**
 * Guard against path traversal via a malformed sessionId. Also rejects the
 * empty string and any id that could escape the sessions dir.
 *
 * NOTE: the session id is used WHOLE. The old layout truncated it to 8 chars
 * for verdict/data filenames (`verdict_<sid8>.json`, `<sid8>_<ts>.json`),
 * which is a collision risk on its own — two sessions sharing an 8-char
 * prefix silently shared a verdict file.
 */
export function assertSafeSessionId(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId === '.' ||
    sessionId === '..' ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0')
  ) {
    throw new Error(`Invalid sessionId: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

export function stateRoot(cwd) {
  return path.join(cwd, STATE_ROOT);
}
export function sessionsRoot(cwd) {
  return path.join(stateRoot(cwd), SESSIONS_SUBDIR);
}
export function sessionDir(cwd, sessionId) {
  return path.join(sessionsRoot(cwd), assertSafeSessionId(sessionId));
}
export function statePath(cwd, sessionId) {
  return path.join(sessionDir(cwd, sessionId), STATE_FILE);
}
export function verdictsPath(cwd, sessionId) {
  return path.join(sessionDir(cwd, sessionId), VERDICTS_FILE);
}

/** Create (0700) and return a session's directory. Idempotent. */
export function ensureSessionDir(cwd, sessionId) {
  const dir = sessionDir(cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// --- legacy paths (read-only; migrated forward on first load) --------------

/** `.supervisor/goals/<sid>.json` — the old goalStore/supervisorStore file. */
export function legacyStatePath(cwd, sessionId) {
  return path.join(stateRoot(cwd), 'goals', `${assertSafeSessionId(sessionId)}.json`);
}
/** `.supervisor/<sid>_attempts.json` — the old CC per-turn attempt counter. */
export function legacyAttemptsPath(cwd, sessionId) {
  return path.join(stateRoot(cwd), `${assertSafeSessionId(sessionId)}_attempts.json`);
}
/** `.supervisor/verdict_<sid>.json` — CC wrote the FULL id here… */
export function legacyVerdictPath(cwd, sessionId) {
  return path.join(stateRoot(cwd), `verdict_${assertSafeSessionId(sessionId)}.json`);
}
/** …while the OpenCode plugin wrote a TRUNCATED 8-char id. Both are read. */
export function legacyVerdictPathTruncated(cwd, sessionId) {
  return path.join(stateRoot(cwd), `verdict_${assertSafeSessionId(sessionId).slice(0, 8)}.json`);
}

// --- atomic write ----------------------------------------------------------

/**
 * Write via temp-file + rename inside the SAME directory, so a reader never
 * observes a partially-written file and an interrupted writer never leaves a
 * corrupt target. The temp file is created with the final mode so there is no
 * window where the state is world-readable.
 *
 * rename(2) is atomic within a filesystem; the temp file lives beside the
 * target, so it can never cross a filesystem boundary.
 */
export function atomicWriteFileSync(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch { /* fsync unsupported on some FS — best effort */ }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
}

// --- advisory lock (closes the read-modify-write window) -------------------
//
// Atomic write alone prevents a CORRUPT file, not a LOST UPDATE: two writers
// that both read v1 and both write produce last-writer-wins, and the loser's
// field silently vanishes. Per-session dirs narrow the window (one hook
// process per session in practice) but do not close it — the OpenCode plugin
// and a `bin/supervisor.mjs` invocation can touch the same session
// concurrently. `mutate()` below serialises read-modify-write behind this
// lock so the update itself is atomic, not just the write.
//
// O_EXCL create is the primitive (atomic on POSIX and on Windows NTFS). A
// holder older than LOCK_STALE_MS is assumed dead and broken — a crashed
// process must never wedge the supervisor. Failing to take the lock is NOT
// fatal: we proceed unlocked rather than block a turn.

function lockPath(cwd, sessionId) {
  return path.join(sessionDir(cwd, sessionId), '.lock');
}

function tryAcquireLock(file) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${process.pid}\n`); } catch { /* informational only */ }
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return false;
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(file); // break a dead holder's lock
        return tryAcquireLock(file);
      }
    } catch { /* vanished between calls — next attempt retries */ }
    return false;
  }
}

/**
 * Run `fn` holding the session's advisory lock. Best-effort: if the lock
 * cannot be taken within LOCK_MAX_WAIT_MS we run anyway (degrading to plain
 * last-writer-wins) rather than fail a turn.
 */
export function withSessionLock(cwd, sessionId, fn) {
  const file = lockPath(cwd, sessionId);
  let held = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (tryAcquireLock(file)) { held = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS); // sync sleep
    }
  } catch { /* lock unavailable — proceed unlocked */ }
  try {
    return fn();
  } finally {
    if (held) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
  }
}

// --- migration -------------------------------------------------------------

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Fold the four legacy per-session files into one new-layout state object.
 * Returns null when the session has no legacy footprint at all.
 *
 * Legacy shapes:
 *   .supervisor/goals/<sid>.json      → { mode, goal, maxAttempts, autopilot, … }
 *   .supervisor/<sid>_attempts.json   → { count, turn_key, last_iso }
 */
export function readLegacyState(cwd, sessionId) {
  const legacy = readJsonSync(legacyStatePath(cwd, sessionId));
  const attempts = readJsonSync(legacyAttemptsPath(cwd, sessionId));
  if (!legacy && !attempts) return null;
  const state = legacy && typeof legacy === 'object' ? { ...legacy } : {};
  if (attempts && typeof attempts === 'object') {
    state.attempts = {
      count: typeof attempts.count === 'number' ? attempts.count : 0,
      turnKey: attempts.turn_key ?? null,
      lastIso: attempts.last_iso ?? null,
    };
  }
  return state;
}

/**
 * Migrate a legacy session forward, once, on first read. Best-effort by
 * design: a migration failure must degrade to "read the legacy value", never
 * to "lose the goal" or "lose the disabled flag".
 *
 * The legacy files are LEFT IN PLACE. Deleting them would make a rollback to
 * an older plugin build silently drop an active goal, and they are tiny; the
 * GC sweep is what eventually reclaims them.
 */
function migrateLegacySession(cwd, sessionId) {
  const legacy = readLegacyState(cwd, sessionId);
  if (!legacy) return null;
  try {
    atomicWriteFileSync(statePath(cwd, sessionId), JSON.stringify(legacy, null, 2));
  } catch { /* keep serving the in-memory legacy value */ }
  // Carry the last legacy verdict forward so `status` and the OpenCode
  // no-loop override still see it under the new layout.
  try {
    const v =
      readJsonSync(legacyVerdictPath(cwd, sessionId)) ??
      readJsonSync(legacyVerdictPathTruncated(cwd, sessionId));
    if (v && !fs.existsSync(verdictsPath(cwd, sessionId))) {
      appendVerdict(cwd, sessionId, { ...v, migratedFrom: 'legacy-verdict-file' });
    }
  } catch { /* best effort */ }
  return legacy;
}

// --- the store -------------------------------------------------------------

export const sessionStore = {
  /**
   * Read a session's state. New layout wins; a legacy-only session is read
   * AND transparently migrated forward. Never throws — an unreadable or
   * corrupt file reads as `{}` exactly like the code this replaces.
   */
  load(cwd, sessionId) {
    if (!cwd || typeof sessionId !== 'string' || !sessionId) return {};
    let p;
    try { p = statePath(cwd, sessionId); } catch { return {}; }
    const current = readJsonSync(p);
    if (current && typeof current === 'object') return current;
    try {
      return migrateLegacySession(cwd, sessionId) ?? {};
    } catch {
      return {};
    }
  },

  /** Overwrite a session's state atomically (0600). */
  save(cwd, sessionId, state) {
    assertSafeSessionId(sessionId);
    atomicWriteFileSync(statePath(cwd, sessionId), JSON.stringify(state ?? {}, null, 2));
    return state;
  },

  /**
   * Serialised read-modify-write. `fn` receives the current state and returns
   * the state to persist (returning undefined persists the mutated input).
   * This is the ONLY safe way to change one field without clobbering another
   * writer's field.
   */
  mutate(cwd, sessionId, fn) {
    assertSafeSessionId(sessionId);
    return withSessionLock(cwd, sessionId, () => {
      const state = sessionStore.load(cwd, sessionId);
      const next = fn(state) ?? state;
      sessionStore.save(cwd, sessionId, next);
      return next;
    });
  },

  /** Remove a session's state entirely (used by GC and tests). */
  remove(cwd, sessionId) {
    try {
      fs.rmSync(sessionDir(cwd, sessionId), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  },

  // --- per-turn attempt counter -------------------------------------------
  //
  // Lives in state.json under `attempts:{count,turnKey,lastIso}`, replacing
  // `.supervisor/<sid>_attempts.json`. Same semantics as before: the count is
  // scoped to ONE human turn and reads as 0 the moment turnKey moves.

  readAttempts(cwd, sessionId, turnKey) {
    const state = sessionStore.load(cwd, sessionId);
    const a = state?.attempts;
    if (!a || typeof a !== 'object') return 0;
    if (turnKey != null && a.turnKey != null && a.turnKey !== turnKey) return 0;
    return typeof a.count === 'number' ? a.count : 0;
  },

  /**
   * Monotonic within a turn: a write that does not advance the count is
   * dropped, EXCEPT when the turn changed (a new turn's first write must not
   * be compared against the previous turn's tally).
   * @returns {boolean} whether the counter was advanced
   */
  writeAttempts(cwd, sessionId, n, turnKey) {
    let wrote = false;
    sessionStore.mutate(cwd, sessionId, (state) => {
      const a = state.attempts && typeof state.attempts === 'object' ? state.attempts : {};
      const existingCount = typeof a.count === 'number' ? a.count : 0;
      const existingTurnKey = a.turnKey ?? null;
      const turnChanged = turnKey != null && existingTurnKey != null && existingTurnKey !== turnKey;
      if (!turnChanged && n <= existingCount) return state;
      state.attempts = {
        count: n,
        turnKey: turnKey != null ? turnKey : existingTurnKey,
        lastIso: new Date().toISOString(),
      };
      wrote = true;
      return state;
    });
    return wrote;
  },

  // --- verdict log ---------------------------------------------------------

  /**
   * Append-only verdict log. Replaces BOTH legacy shapes:
   *   `.supervisor/verdict_<sid8>.json` (last-verdict, overwritten, truncated id)
   *   `.supervisor/<sid8>_<ts>.json`    (one file per assessment, truncated id)
   * A single appendFileSync of one JSON line lands whole under O_APPEND on a
   * local filesystem, so concurrent writers interleave lines but never tear
   * one. Best-effort: never throws.
   */
  appendVerdict(cwd, sessionId, record) {
    try {
      const p = verdictsPath(cwd, sessionId);
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      return true;
    } catch {
      return false;
    }
  },

  /** Read the verdict log oldest→newest. Corrupt lines are skipped. */
  readVerdicts(cwd, sessionId, limit) {
    let raw;
    try {
      raw = fs.readFileSync(verdictsPath(cwd, sessionId), 'utf8');
    } catch {
      // Legacy fallback: a session that never wrote under the new layout.
      const v =
        readJsonSync(legacyVerdictPath(cwd, sessionId)) ??
        readJsonSync(legacyVerdictPathTruncated(cwd, sessionId));
      return v ? [v] : [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
    }
    return typeof limit === 'number' && limit > 0 ? out.slice(-limit) : out;
  },

  /** Most recent verdict, or null. */
  lastVerdict(cwd, sessionId) {
    const all = sessionStore.readVerdicts(cwd, sessionId);
    return all.length ? all[all.length - 1] : null;
  },
};

// --- enumeration -----------------------------------------------------------

/**
 * Every session known in this project, newest-touched first. Includes
 * legacy-layout sessions (from `.supervisor/goals/*.json`) so `on|off` can
 * still name a session that has not been migrated yet.
 */
export function listSessions(cwd) {
  const seen = new Map();
  const note = (id, mtimeMs, layout) => {
    const prev = seen.get(id);
    if (!prev || mtimeMs > prev.mtimeMs) seen.set(id, { id, mtimeMs, layout });
    else if (prev && layout === 'current') prev.layout = 'current';
  };
  try {
    for (const entry of fs.readdirSync(sessionsRoot(cwd), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(path.join(sessionsRoot(cwd), entry.name, STATE_FILE));
        mtimeMs = st.mtimeMs;
      } catch {
        try { mtimeMs = fs.statSync(path.join(sessionsRoot(cwd), entry.name)).mtimeMs; } catch { /* skip */ }
      }
      note(entry.name, mtimeMs, 'current');
    }
  } catch { /* no sessions dir yet */ }
  try {
    const legacyDir = path.join(stateRoot(cwd), 'goals');
    for (const f of fs.readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(legacyDir, f)).mtimeMs; } catch { /* skip */ }
      note(id, mtimeMs, 'legacy');
    }
  } catch { /* no legacy dir */ }
  return [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Sessions touched within `windowMs` (default 24h). */
export function listRecentSessions(cwd, windowMs = RECENT_SESSION_MS, now = Date.now()) {
  return listSessions(cwd).filter((s) => now - s.mtimeMs <= windowMs);
}

// --- session id resolution -------------------------------------------------

/**
 * Decide WHICH session a CLI invocation acts on.
 *
 * THE BUG THIS FIXES: `.supervisor/current_session` is a single shared file
 * rewritten by every Stop hook in the project. With two sessions running in
 * one repo, `/supervisor off` disabled whichever session wrote LAST — not the
 * caller's. Real, user-reported.
 *
 * Precedence (first hit wins):
 *   1. explicit  — an id passed on the command line (`--session <id>`, or the
 *                  trailing positional). A unique PREFIX is accepted and
 *                  expanded; an ambiguous prefix resolves to NOTHING.
 *   2. env       — SUPERVISOR_SESSION_ID, then CLAUDE_SESSION_ID. The Claude
 *                  Code Stop hook receives `session_id` on stdin and exports
 *                  it; this is the authority for any hook-driven invocation.
 *   3. fallback  — `.supervisor/current_session`, INTERACTIVE USE ONLY. The
 *                  caller MUST surface `source === 'current_session'` in its
 *                  output so the user knows which session was acted on.
 *
 * Never guesses. `ambiguous:true` means the caller must act on NOTHING and
 * print `candidates`.
 *
 * @returns {{sessionId: string|null,
 *            source: 'explicit'|'explicit-prefix'|'env'|'current_session'|'sole-session'|null,
 *            ambiguous: boolean, candidates: string[], envVar?: string, reason?: string}}
 */
export function resolveSessionId(cwd, opts = {}) {
  const env = opts.env ?? process.env;
  const none = { sessionId: null, source: null, ambiguous: false, candidates: [] };

  const explicit = (opts.explicit ?? '').toString().trim();
  if (explicit) {
    const known = listSessions(cwd).map((s) => s.id);
    if (known.includes(explicit)) {
      return { sessionId: explicit, source: 'explicit', ambiguous: false, candidates: [] };
    }
    const matches = known.filter((id) => id.startsWith(explicit));
    if (matches.length === 1) {
      return { sessionId: matches[0], source: 'explicit-prefix', ambiguous: false, candidates: [] };
    }
    if (matches.length > 1) {
      return {
        sessionId: null,
        source: null,
        ambiguous: true,
        candidates: matches,
        reason: `"${explicit}" matches ${matches.length} sessions`,
      };
    }
    // No local footprint yet (a brand-new session that has not stopped once).
    // Trust the caller's exact id rather than refusing to act on it.
    return { sessionId: explicit, source: 'explicit', ambiguous: false, candidates: [] };
  }

  for (const name of ['SUPERVISOR_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const v = (env[name] ?? '').toString().trim();
    if (v) return { sessionId: v, source: 'env', ambiguous: false, candidates: [], envVar: name };
  }

  let current = null;
  try {
    current = fs.readFileSync(path.join(stateRoot(cwd), 'current_session'), 'utf8').trim() || null;
  } catch { /* absent */ }
  if (current) {
    const others = listRecentSessions(cwd, opts.recentWindowMs ?? RECENT_SESSION_MS)
      .map((s) => s.id)
      .filter((id) => id !== current);
    return {
      sessionId: current,
      source: 'current_session',
      ambiguous: false,
      candidates: others, // other recently-active sessions, for the warning
    };
  }

  // Nothing to go on. If exactly one session is known, that is not a guess —
  // but say so distinctly, never as "current_session" (that file may not even
  // exist, and mislabelling the source is how the original bug hid).
  const recent = listRecentSessions(cwd, opts.recentWindowMs ?? RECENT_SESSION_MS).map((s) => s.id);
  if (recent.length === 1) {
    return { sessionId: recent[0], source: 'sole-session', ambiguous: false, candidates: [] };
  }
  if (recent.length > 1) {
    return {
      sessionId: null,
      source: null,
      ambiguous: true,
      candidates: recent,
      reason: `${recent.length} sessions were active recently and no session id was supplied`,
    };
  }
  return none;
}

// --- garbage collection ----------------------------------------------------

/**
 * Retention policy (defaults): drop a session dir untouched for more than
 * GC_MAX_AGE_MS (30 days), then drop the oldest beyond GC_MAX_SESSIONS (200).
 * Legacy per-session files for a removed session go with it.
 *
 * Cheap and best-effort by contract: it never throws, never blocks a turn,
 * and any individual failure is skipped rather than propagated. `protect`
 * always survives (the live session must never be collected mid-turn).
 */
export function gcSessions(cwd, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? GC_MAX_AGE_MS;
  const maxSessions = opts.maxSessions ?? GC_MAX_SESSIONS;
  const protect = new Set([opts.protect].flat().filter(Boolean));
  const result = { removed: [], kept: [], scanned: 0 };
  let sessions;
  try {
    sessions = listSessions(cwd);
  } catch {
    return result;
  }
  result.scanned = sessions.length;
  const doomed = [];
  const survivors = [];
  for (const s of sessions) {
    if (protect.has(s.id)) { survivors.push(s); continue; }
    if (now - s.mtimeMs > maxAgeMs) doomed.push(s);
    else survivors.push(s);
  }
  // survivors are newest-first; anything past the cap is the oldest tail.
  if (survivors.length > maxSessions) {
    for (const s of survivors.splice(maxSessions)) {
      if (!protect.has(s.id)) doomed.push(s);
    }
  }
  for (const s of doomed) {
    try {
      fs.rmSync(sessionDir(cwd, s.id), { recursive: true, force: true });
      // Legacy siblings for the same session, if any.
      for (const p of [legacyStatePath(cwd, s.id), legacyAttemptsPath(cwd, s.id), legacyVerdictPath(cwd, s.id)]) {
        try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
      }
      result.removed.push(s.id);
    } catch { /* skip */ }
  }
  result.kept = survivors.map((s) => s.id);
  return result;
}

/**
 * Throttled GC entry point for hot paths (the Stop hook, the plugin's idle
 * handler). Sweeps at most once per GC_THROTTLE_MS per project, gated by a
 * stamp file whose mtime is the clock. Swallows everything.
 */
export function maybeGcSessions(cwd, opts = {}) {
  try {
    const stamp = path.join(stateRoot(cwd), GC_STAMP_FILE);
    const now = opts.now ?? Date.now();
    const throttleMs = opts.throttleMs ?? GC_THROTTLE_MS;
    try {
      if (now - fs.statSync(stamp).mtimeMs < throttleMs) return null;
    } catch { /* no stamp yet — first sweep */ }
    fs.mkdirSync(stateRoot(cwd), { recursive: true, mode: 0o700 });
    // Stamp FIRST so a slow/failing sweep cannot re-run on every single turn.
    try { atomicWriteFileSync(stamp, String(now)); } catch { /* best effort */ }
    return gcSessions(cwd, opts);
  } catch {
    return null;
  }
}
