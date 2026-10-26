/** Session-only facade, not a storage/lifecycle service. All writes delegate
 * synchronously to sessionStore.mutate. Its advisory lock has an unlocked
 * fallback: one adapter-local queue / one native owner is still required. */
import { sessionStore, assertSafeSessionId } from './session-store.mjs';
import { sameGoalContract, parseAttemptsValue } from './goal.mjs';
import {
  FocusPolicyError, hashFocusAction, hashFocusGoalContract, hashFocusText,
  isFocusFresh, redactFocusText,
} from './focus.mjs';

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entries = (v) => Array.isArray(v) && v.every((x) => object(x) && text(x.entryId) && typeof x.text === 'string');
function copy(value) {
  // Reuse strict complete-JSON validation; JSON clone is safe only afterward.
  hashFocusAction({ toolCallId: 'focus-state', toolName: 'metadata', input: value });
  return JSON.parse(JSON.stringify(value));
}
function badInput() { throw new FocusPolicyError('invalid-state-input'); }
function validHuman(h) { return object(h) && text(h.entryId) && integer(h.epoch) && text(h.turnKey); }
function validBranch(b) { return object(b) && text(b.markerEntryId) && integer(b.epoch); }
function validMeta(m, sessionId) {
  return object(m) && m.version === 1 && m.runtime === 'pi' && m.sessionId === sessionId
    && text(m.goalId) && text(m.contractHash) && integer(m.generation)
    && validHuman(m.human) && validBranch(m.branch)
    && object(m.origin) && text(m.origin.receiptId) && text(m.origin.originalUserEntryId)
    && text(m.origin.originalText) && m.origin.originalTextHash === hashFocusText(m.origin.originalText)
    && ['interactive', 'print', 'rpc'].includes(m.origin.ingress)
    && ['operator-ingress', 'explicit-adoption'].includes(m.origin.authority)
    && entries(m.origin.constraintSpans)
    && (m.temporaryWork === undefined || (Array.isArray(m.temporaryWork) && m.temporaryWork.every((x) => object(x) && text(x.authorizationEntryId) && text(x.description))))
    && (m.hold === undefined || (object(m.hold) && text(m.hold.activityId) && text(m.hold.reason) && text(m.hold.since)))
    && (m.lastCorrection === undefined || (object(m.lastCorrection) && text(m.lastCorrection.activityId) && text(m.lastCorrection.key)))
    && (m.correctionActivities === undefined || (Array.isArray(m.correctionActivities) && m.correctionActivities.every(text)
      && new Set(m.correctionActivities).size === m.correctionActivities.length));
}
function activeGoal(state) {
  return object(state.goal) && text(state.goal.id) && state.goal.status === 'active' && !state.goalCleared;
}
function anchored(state, sessionId, expectedGoal) {
  try {
    return activeGoal(state) && validMeta(state.focus, sessionId)
      && state.focus.goalId === state.goal.id
      && state.focus.contractHash === hashFocusGoalContract(state.goal)
      && (!expectedGoal || (sameGoalContract(expectedGoal, state.goal)
        && hashFocusGoalContract(expectedGoal) === state.focus.contractHash));
  } catch { return false; }
}
/** Build with the CURRENT batch/activity ID, not an arbitrary cached ID. The
 * activity itself is adapter-owned; metadata tracks branch/human/generation. */
export function focusStamp(meta, activityId) {
  return {
    sessionId: meta?.sessionId, goalId: meta?.goalId, contractHash: meta?.contractHash,
    branchEpoch: meta?.branch?.epoch, markerEntryId: meta?.branch?.markerEntryId,
    humanEpoch: meta?.human?.epoch, generation: meta?.generation, activityId,
  };
}
function fresh(state, sessionId, stamp, expectedGoal) {
  return anchored(state, sessionId, expectedGoal)
    && isFocusFresh(stamp, focusStamp(state.focus, stamp?.activityId));
}

/** Bind only a real current session declaration (never materialize a project
 * fallback). Identical rebinding is idempotent; same-goal original receipts
 * cannot be rewritten. Use invalidateFocus for later context. Reanchoring the
 * same declaration after an explicit resume requires a greater generation and
 * identical receipt/human/branch/annotations; existing holds and claims survive.
 * For a replacement goal, also supply a greater generation. */
export function bindFocus(cwd, sessionId, { expectedGoal, meta } = {}) {
  assertSafeSessionId(sessionId);
  const snapshot = copy(meta);
  let result = { bound: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    if (!activeGoal(state) || !expectedGoal || !sameGoalContract(expectedGoal, state.goal)
        || !validMeta(snapshot, sessionId) || snapshot.goalId !== state.goal.id
        || snapshot.contractHash !== hashFocusGoalContract(state.goal)
        || snapshot.contractHash !== hashFocusGoalContract(expectedGoal)) return;
    if (state.focus) {
      if (state.focus.goalId === state.goal.id) {
        const hash = (m) => hashFocusAction({ toolCallId: 'bind', toolName: 'meta', input: m });
        if (hash(state.focus) === hash(snapshot)) { result = { bound: true }; return; }
        // Resume may extend the deadline without changing the declaration ID.
        // Never use this path to reset receipts, holds, claims, or human turns.
        const stable = (m) => Object.fromEntries(Object.entries(m).filter(([k]) =>
          !['contractHash', 'generation', 'hold', 'lastCorrection', 'correctionActivities'].includes(k)));
        if (!integer(state.focus.generation) || snapshot.generation <= state.focus.generation
            || hash(stable(state.focus)) !== hash(stable(snapshot))) return;
        state.focus.contractHash = snapshot.contractHash;
        state.focus.generation = snapshot.generation;
        result = { bound: true };
        return;
      }
      if (!integer(state.focus.generation) || snapshot.generation <= state.focus.generation) return;
    }
    // A fresh binding cannot smuggle a prior batch's authorization/accounting.
    if (snapshot.hold || snapshot.lastCorrection || snapshot.correctionActivities?.length) return;
    state.focus = snapshot;
    result = { bound: true };
  });
  return result;
}

/** Invalidate the canonical current anchor; no caller snapshot is saved.
 * Optional stamp/expectedGoal fence delayed lifecycle callbacks. Without them,
 * capture a synchronous revocation stamp and recheck it inside mutate too.
 * nextHuman is
 * ONLY a newly accepted genuine operator work turn (not status/generated text).
 * A nextHuman resets the existing counter and its goal mirror together.
 * Hold survives invalidation, including new humans, until explicit recovery.
 * appendConstraints are accepted quotations, not a replacement original;
 * temporaryWork replaces annotations only. Both increment generation. */
export function invalidateFocus(cwd, sessionId, {
  reason, nextHuman, nextBranch, stamp, expectedGoal, appendConstraints = [], temporaryWork,
} = {}) {
  if (!text(reason) || (nextHuman !== undefined && !validHuman(nextHuman))
      || (nextBranch !== undefined && !validBranch(nextBranch)) || !entries(appendConstraints)) badInput();
  const human = nextHuman === undefined ? undefined : copy(nextHuman);
  const branch = nextBranch === undefined ? undefined : copy(nextBranch);
  const constraints = copy(appendConstraints);
  const work = temporaryWork === undefined ? undefined : copy(temporaryWork);
  if (work !== undefined && (!Array.isArray(work) || work.some((x) => !object(x) || !text(x.authorizationEntryId) || !text(x.description)))) badInput();
  assertSafeSessionId(sessionId);
  // Capture identity only, never save this state snapshot. The locked reload
  // below must still match even when a caller just wants immediate revocation.
  const observed = sessionStore.load(cwd, sessionId);
  const expected = expectedGoal === undefined ? observed.goal : expectedGoal;
  const expectedStamp = stamp === undefined ? focusStamp(observed.focus, 'focus-invalidation') : stamp;
  let result = null;
  sessionStore.mutate(cwd, sessionId, (state) => {
    if (!expected || !fresh(state, sessionId, expectedStamp, expected)) return;
    const m = state.focus;
    if (m.generation === Number.MAX_SAFE_INTEGER) return;
    if (human && (human.epoch <= m.human.epoch || human.entryId === m.human.entryId || human.turnKey === m.human.turnKey)) return;
    if (branch && branch.epoch <= m.branch.epoch) return;
    m.generation++;
    if (human) {
      m.human = human;
      state.attempts = { count: 0, turnKey: human.turnKey, lastIso: new Date().toISOString() };
      state.goal.attempts = 0;
      state.goal.lastTurnKey = human.turnKey;
      delete m.lastCorrection;
      delete m.correctionActivities;
    }
    if (branch) m.branch = branch;
    m.origin.constraintSpans.push(...constraints);
    if (work !== undefined) m.temporaryWork = work;
    result = copy(m);
  });
  return result;
}

/** Preserve accepted operator quotations even on read-only turns or while
 * paused/exhausted. This cannot restart work, alter the goal or reset attempts.
 * The stored binding must still name the exact declaration in its active form;
 * lifecycle status alone may differ. Adapter supplies correlated active-branch
 * entries, never model text or history mined for authority. */
export function recordFocusQuotes(cwd, sessionId, { expectedGoal, stamp, quotes } = {}) {
  if (!entries(quotes) || new Set(quotes.map(span => span.entryId)).size !== quotes.length) badInput();
  const accepted = copy(quotes);
  assertSafeSessionId(sessionId);
  let result = { recorded: false };
  sessionStore.mutate(cwd, sessionId, state => {
    const goal = state.goal, meta = state.focus;
    if (!goal || !expectedGoal || state.goalCleared || !['active', 'paused', 'exhausted'].includes(goal.status)
        || !validMeta(meta, sessionId) || meta.goalId !== goal.id
        || hashFocusGoalContract(expectedGoal) !== hashFocusGoalContract(goal)
        || meta.contractHash !== hashFocusGoalContract({ ...goal, status: 'active' })
        || !isFocusFresh(stamp, focusStamp(meta, stamp?.activityId)) || meta.generation === Number.MAX_SAFE_INTEGER) return;
    const prior = new Map(meta.origin.constraintSpans.map(span => [span.entryId, span.text]));
    if (accepted.some(span => prior.has(span.entryId) && prior.get(span.entryId) !== span.text)) return;
    const additions = accepted.filter(span => !prior.has(span.entryId) && span.entryId !== meta.origin.originalUserEntryId);
    if (additions.length) { meta.origin.constraintSpans.push(...additions); meta.generation++; }
    result = { recorded: true };
  });
  return result;
}

/** Claim BEFORE delivering a redirect/settlement continuation. One activity
 * costs once even for interleaved A/B/A siblings; different keys in one batch
 * are still siblings. correctionActivities is additive, scoped to the human
 * turn, and never a second budget. goal.attempts mirrors state.attempts.count.
 * maxAttempts is the adapter's already resolved limit (shared parser accepts
 * positive integers and unlimited/off/0). Invalid limits reject loudly. */
export function claimFocusCorrection(cwd, sessionId, { expectedGoal, stamp, key, maxAttempts } = {}) {
  const limit = parseAttemptsValue(maxAttempts);
  if (limit === null || !text(key)) badInput();
  let result = { claimed: false, reason: 'stale' };
  sessionStore.mutate(cwd, sessionId, (state) => {
    if (!expectedGoal || !fresh(state, sessionId, stamp, expectedGoal)) return;
    const m = state.focus;
    if (m.hold) { result = { claimed: false, reason: 'held' }; return; }
    if (!Number.isFinite(state.goal.deadline) || Date.now() >= state.goal.deadline) {
      result = { claimed: false, reason: 'deadline' }; return;
    }
    const a = state.attempts;
    if (a !== undefined && (!object(a) || !integer(a.count)
        || (a.turnKey != null && !text(a.turnKey)))) {
      result = { claimed: false, reason: 'invalid-counter' }; return;
    }
    // Exactly the store's existing null-key carry and changed-turn semantics.
    const turnChanged = a?.turnKey != null && a.turnKey !== m.human.turnKey;
    const count = turnChanged ? 0 : (a?.count ?? 0);
    if (m.lastCorrection?.activityId === stamp.activityId || m.correctionActivities?.includes(stamp.activityId)) {
      result = { claimed: false, count, reason: 'duplicate' }; return;
    }
    if (count >= limit || count === Number.MAX_SAFE_INTEGER) {
      result = { claimed: false, count, reason: 'attempts' }; return;
    }
    const next = count + 1;
    state.attempts = { count: next, turnKey: m.human.turnKey, lastIso: new Date().toISOString() };
    state.goal.attempts = next;
    state.goal.lastTurnKey = m.human.turnKey;
    m.correctionActivities = [...(m.correctionActivities ?? []), stamp.activityId];
    m.lastCorrection = { activityId: stamp.activityId, key };
    result = { claimed: true, count: next };
  });
  return result;
}

/** A hold is a session guard latch, not permission for another activity. The
 * adapter blocks all guarded work/settlement while present. Never auto-clear
 * on generated retries, invalidation, or rebinding. First reason wins. */
export function setFocusHold(cwd, sessionId, { stamp, reason } = {}) {
  if (!text(reason)) badInput();
  let result = { held: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    if (!fresh(state, sessionId, stamp)) return;
    if (!state.focus.hold) state.focus.hold = {
      activityId: stamp.activityId, reason: redactFocusText(reason.trim()), since: new Date().toISOString(),
    };
    result = { held: true };
  });
  return result;
}

/** Optional recovery after explicit operator clarification/resume. authorized
 * is an adapter assertion, NOT authentication; never copy it from model args.
 * Bump generation so no pre-recovery approval can survive. Reassess afterward. */
export function clearFocusHold(cwd, sessionId, { expectedGoal, stamp, authorized } = {}) {
  let result = { cleared: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    if (authorized !== true || !expectedGoal || !fresh(state, sessionId, stamp, expectedGoal)
        || !state.focus.hold || state.focus.generation === Number.MAX_SAFE_INTEGER) return;
    delete state.focus.hold;
    state.focus.generation++;
    result = { cleared: true };
  });
  return result;
}
