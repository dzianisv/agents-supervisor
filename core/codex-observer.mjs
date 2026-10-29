/**
 * Bounded state for the Codex progress observer. This module records evidence
 * and leases review work; it never calls a model or infers role/ancestry.
 */

import { createHash, randomUUID } from 'node:crypto';
import { sessionStore } from './session-store.mjs';

export const CODEX_OBSERVER_INTERVAL = 10;
export const CODEX_OBSERVER_EVENT_LIMIT = 10;
export const CODEX_OBSERVER_MAX_EVENT_LIMIT = 50;
export const CODEX_OBSERVER_REQUEST_LIMIT = 8;
export const CODEX_OBSERVER_ID_LIMIT = 64;
export const CODEX_OBSERVER_LEASE_MS = 60_000;

const REQUEST_TEXT_LIMIT = 4_000;
const JSON_VALUE_LIMIT = 4_000;
const FEEDBACK_HASH_LIMIT = 16;

function text(value, limit) {
  if (typeof value !== 'string') return '';
  if (value.length <= limit) return value;
  const marker = '\n[TRUNCATED: middle omitted]\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.65);
  return `${value.slice(0, head)}${marker}${value.slice(-(remaining - head))}`;
}

function boundedJson(value) {
  if (value === undefined) return null;
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { serialized = JSON.stringify(String(value)); }
  if (serialized === undefined) serialized = 'null';
  if (serialized.length <= JSON_VALUE_LIMIT) {
    try { return JSON.parse(serialized); } catch { return serialized; }
  }
  return { truncated: true, preview: serialized.slice(0, JSON_VALUE_LIMIT) };
}

function normalizeTimestamp(value, fallback) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : fallback;
}

function ensureTurn(state, { turnId, turnStartedAt, userRequest, now }) {
  const observer = state.codexObserver && typeof state.codexObserver === 'object'
    ? state.codexObserver
    : {};
  const startedAt = normalizeTimestamp(turnStartedAt, now);
  if (observer.turnId !== turnId) {
    // Hook delivery can be delayed. Do not let an older turn roll state back.
    if (observer.turnId && Number.isFinite(observer.turnStartedAt) && startedAt < observer.turnStartedAt) {
      return { observer, staleTurn: true };
    }
    const history = Array.isArray(observer.requestHistory) ? observer.requestHistory : [];
    if (typeof userRequest === 'string' && userRequest.trim()) {
      history.push({ turnId, at: startedAt, text: text(userRequest, REQUEST_TEXT_LIMIT) });
    }
    observer.turnId = turnId;
    observer.turnStartedAt = startedAt;
    observer.requestHistory = history.slice(-6);
    observer.events = [];
    observer.seenToolUseIds = [];
    observer.nextSeq = 0;
    observer.reviewedThroughSeq = 0;
    observer.lease = null;
    observer.feedbackHashes = [];
    observer.latestAssistant = null;
    observer.goalDerivation = null;
  } else if (typeof userRequest === 'string' && userRequest.trim()) {
    const history = Array.isArray(observer.requestHistory) ? observer.requestHistory : [];
    const latest = history[history.length - 1];
    if (!latest || latest.turnId !== turnId || latest.text !== text(userRequest, REQUEST_TEXT_LIMIT)) {
      history.push({ turnId, at: startedAt, text: text(userRequest, REQUEST_TEXT_LIMIT) });
      observer.requestHistory = history.slice(-6);
    }
  }
  observer.events = Array.isArray(observer.events) ? observer.events.slice(-CODEX_OBSERVER_MAX_EVENT_LIMIT) : [];
  observer.seenToolUseIds = Array.isArray(observer.seenToolUseIds)
    ? observer.seenToolUseIds.slice(-CODEX_OBSERVER_ID_LIMIT)
    : [];
  observer.feedbackHashes = Array.isArray(observer.feedbackHashes)
    ? observer.feedbackHashes.slice(-FEEDBACK_HASH_LIMIT)
    : [];
  state.codexObserver = observer;
  return { observer, staleTurn: false };
}

/** Register a human prompt and turn boundary without waiting for a tool call. */
export function recordCodexObserverPrompt({ cwd, sessionId, turnId, turnStartedAt, userRequest, now = Date.now() }) {
  if (!cwd || !sessionId || !turnId) throw new TypeError('cwd, sessionId, and turnId are required');
  let result = { recorded: false, staleTurn: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    const { observer, staleTurn } = ensureTurn(state, { turnId, turnStartedAt, userRequest, now });
    result = { recorded: !staleTurn, staleTurn };
    return state;
  });
  return result;
}

/**
 * Claim the one goal-derivation attempt allowed for this turn. The claim is
 * persisted before the reviewer starts so delayed/duplicate PostToolUse hooks
 * cannot launch the same derivation twice.
 *
 * @returns {{claimed:boolean, reason?:string, token?:string, status?:string}}
 */
export function claimCodexGoalDerivation({ cwd, sessionId, turnId, now = Date.now() }) {
  if (!cwd || !sessionId || !turnId) throw new TypeError('cwd, sessionId, and turnId are required');
  let result = { claimed: false, reason: 'no-observer' };
  sessionStore.mutate(cwd, sessionId, (state) => {
    const observer = state.codexObserver;
    if (!observer || observer.turnId !== turnId) {
      result = { claimed: false, reason: 'turn-mismatch' };
      return state;
    }
    const current = observer.goalDerivation;
    if (current && current.turnId === turnId) {
      result = { claimed: false, reason: 'already-claimed', status: current.status };
      return state;
    }
    const token = randomUUID();
    observer.goalDerivation = { turnId, token, status: 'pending', at: now };
    result = { claimed: true, token };
    return state;
  });
  return result;
}

/** Finish a goal-derivation claim, only if this caller still owns it. */
export function finishCodexGoalDerivation({ cwd, sessionId, turnId, token, status, condition, error, now = Date.now() }) {
  if (!cwd || !sessionId || !turnId || !token) throw new TypeError('cwd, sessionId, turnId, and token are required');
  if (status !== 'done' && status !== 'failed') throw new TypeError('status must be done or failed');
  let finished = false;
  sessionStore.mutate(cwd, sessionId, (state) => {
    const observer = state.codexObserver;
    const current = observer?.goalDerivation;
    if (!observer || observer.turnId !== turnId || current?.turnId !== turnId || current.token !== token) return state;
    observer.goalDerivation = {
      turnId,
      token,
      status,
      at: now,
      ...(typeof condition === 'string' && condition ? { condition: text(condition, REQUEST_TEXT_LIMIT) } : {}),
      ...(typeof error === 'string' && error ? { error: text(error, 1_000) } : {}),
    };
    finished = true;
    return state;
  });
  return finished;
}

/** Keep the latest assistant reply available as bounded focus context. */
export function recordCodexObserverAssistant({ cwd, sessionId, turnId, assistantReply, now = Date.now() }) {
  if (!cwd || !sessionId || !turnId) throw new TypeError('cwd, sessionId, and turnId are required');
  let recorded = false;
  sessionStore.mutate(cwd, sessionId, (state) => {
    const observer = state.codexObserver;
    if (observer?.turnId === turnId) {
      observer.latestAssistant = { at: now, text: text(assistantReply, REQUEST_TEXT_LIMIT) };
      recorded = true;
    }
    return state;
  });
  return recorded;
}

/** Record a completed tool event and claim review work once the interval is due. */
export function recordCodexObserverTool({
  cwd,
  sessionId,
  turnId,
  turnStartedAt,
  userRequest,
  toolCall,
  interval = CODEX_OBSERVER_INTERVAL,
  now = Date.now(),
}) {
  if (!cwd || !sessionId || !turnId || !toolCall) throw new TypeError('cwd, sessionId, turnId, and toolCall are required');
  const every = Number.isInteger(interval) && interval > 0 ? interval : CODEX_OBSERVER_INTERVAL;
  let result = { due: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    let observer = state.codexObserver;
    if (observer?.turnId && observer.turnId !== turnId) {
      // Only a UserPromptSubmit event can authoritatively advance the active
      // human turn. Tool hooks may arrive late and have no reliable start time.
      result = { due: false, staleTurn: true };
      return state;
    }
    if (!observer?.turnId) {
      observer = ensureTurn(state, { turnId, turnStartedAt, userRequest, now }).observer;
    } else {
      observer = ensureTurn(state, { turnId, turnStartedAt: observer.turnStartedAt, userRequest, now }).observer;
    }
    if (!observer) {
      result = { due: false, staleTurn: true };
      return state;
    }
    const id = text(toolCall.tool_use_id ?? toolCall.toolUseId ?? toolCall.id, 256);
    if (!id || observer.seenToolUseIds.includes(id)) {
      result = { due: false, duplicate: Boolean(id) };
      return state;
    }
    observer.seenToolUseIds.push(id);
    observer.seenToolUseIds = observer.seenToolUseIds.slice(-CODEX_OBSERVER_ID_LIMIT);
    const seq = (Number.isInteger(observer.nextSeq) ? observer.nextSeq : 0) + 1;
    observer.nextSeq = seq;
    observer.events.push({
      seq,
      tool_use_id: id,
      tool: text(toolCall.tool ?? toolCall.name, 200),
      model: text(toolCall.model, 200),
      input: boundedJson(toolCall.input),
      result: boundedJson(toolCall.result),
      startedAt: normalizeTimestamp(toolCall.startedAt, now),
      completedAt: normalizeTimestamp(toolCall.completedAt, now),
    });
    observer.events = observer.events.slice(-Math.min(
      CODEX_OBSERVER_MAX_EVENT_LIMIT,
      Math.max(CODEX_OBSERVER_EVENT_LIMIT, every),
    ));

    const lease = observer.lease;
    if (lease && now - lease.startedAt <= CODEX_OBSERVER_LEASE_MS) return state;
    if (lease) observer.lease = null;
    const reviewed = Number.isInteger(observer.reviewedThroughSeq) ? observer.reviewedThroughSeq : 0;
    if (!observer.requestHistory?.length || seq - reviewed < every) return state;
    const token = randomUUID();
    observer.lease = { token, turnId, startedAt: now, throughSeq: seq };
    result = {
      due: true,
      token,
      snapshot: {
        turnId,
        turnStartedAt: observer.turnStartedAt,
        userRequests: observer.requestHistory.slice(-6),
        latestAssistant: observer.latestAssistant ?? null,
        events: observer.events.slice(-Math.min(CODEX_OBSERVER_MAX_EVENT_LIMIT, Math.max(CODEX_OBSERVER_EVENT_LIMIT, every))),
        completedSinceReview: seq - reviewed,
      },
    };
    return state;
  });
  return result;
}

/** Release a review lease, accepting feedback only if it still owns that lease and turn. */
export function finishCodexObserverReview({ cwd, sessionId, turnId, token, feedback, now = Date.now() }) {
  if (!cwd || !sessionId || !turnId || !token) throw new TypeError('cwd, sessionId, turnId, and token are required');
  let result = { accepted: false, stale: true, inject: false };
  sessionStore.mutate(cwd, sessionId, (state) => {
    const observer = state.codexObserver;
    const lease = observer?.lease;
    if (!observer || observer.turnId !== turnId || !lease || lease.token !== token || lease.turnId !== turnId) return state;
    if (now - lease.startedAt > CODEX_OBSERVER_LEASE_MS) {
      observer.lease = null;
      return state;
    }
    observer.reviewedThroughSeq = Math.max(observer.reviewedThroughSeq ?? 0, lease.throughSeq);
    observer.lease = null;
    const body = text(feedback, 4_000).trim();
    const hash = body ? createHash('sha256').update(body).digest('hex') : '';
    const duplicate = Boolean(hash && observer.feedbackHashes.includes(hash));
    if (hash && !duplicate) {
      observer.feedbackHashes.push(hash);
      observer.feedbackHashes = observer.feedbackHashes.slice(-FEEDBACK_HASH_LIMIT);
    }
    observer.lastReview = { at: now, feedback: body, duplicate, throughSeq: lease.throughSeq };
    result = { accepted: true, stale: false, inject: Boolean(body && !duplicate), feedback: body, duplicate, completedAt: now };
    return state;
  });
  return result;
}

/** Best-effort release after a reviewer failure; only the matching lease is touched. */
export function releaseCodexObserverReview({ cwd, sessionId, turnId, token }) {
  if (!cwd || !sessionId || !turnId || !token) throw new TypeError('cwd, sessionId, turnId, and token are required');
  let released = false;
  sessionStore.mutate(cwd, sessionId, (state) => {
    const observer = state.codexObserver;
    if (observer?.turnId === turnId && observer.lease?.turnId === turnId && observer.lease.token === token) {
      // The failed review still consumed this sampled window. Otherwise each
      // subsequent tool call would immediately launch another failed judge.
      observer.reviewedThroughSeq = Math.max(observer.reviewedThroughSeq ?? 0, observer.lease.throughSeq);
      observer.lastReview = { at: Date.now(), failed: true, throughSeq: observer.lease.throughSeq };
      observer.lease = null;
      released = true;
    }
    return state;
  });
  return released;
}
