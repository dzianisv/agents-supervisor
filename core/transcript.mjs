/**
 * core/transcript.mjs — THE shared Claude Code Stop-hook primitives.
 *
 * Both Stop hooks (`bin/supervisor-on-stop.mjs`, `bin/plainspeak-on-stop.mjs`)
 * read the same stdin payload shape and the same transcript jsonl, so they had
 * grown a private copy of each primitive below. Two copies of one contract is
 * the drift shape this repo keeps reproducing (see AGENTS.md on `sessionStore`
 * and on "ONE extractor"), and it had already bitten `sanitizeCwd`: the two
 * copies disagreed on the failure mode (throw vs. return null) under the same
 * name. This module is the single owner.
 *
 * Exports: sanitizeCwd, readTranscriptTail, endsWithTrailingQuestion,
 * computeTurnKeyFromMessages, computeTurnKeyFromTranscript, readStdin,
 * createDebugLogger.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER,
  isNonHumanUserMessage, isNonHumanUserText,
} from './evaluation.mjs';

export const TRANSCRIPT_MAX_BYTES = 200_000;
export const TRANSCRIPT_MAX_ENTRIES = 50;
export const TURN_KEY_MAX_CHARS = 300;

/**
 * Validate a Stop payload's `cwd`.
 *
 * CONTRACT: returns the resolved absolute path, or `null` for anything that is
 * not an already-resolved absolute string. It is TOTAL — it never throws.
 *
 * The two former copies disagreed: plainspeak returned null, supervisor threw.
 * Null is the contract a caller actually *reads*: plainspeak's `main()` does
 * `if (!cwd) process.exit(0)`. Nothing ever caught supervisor's throw — it
 * unwound out of an un-awaited async `main()` into the process-level
 * `unhandledRejection` backstop, which fails open to exit 0 anyway. So the
 * throw bought no extra safety, was invisible at the call site, and made an
 * expected bad input indistinguishable from a genuine crash in the logs.
 * Callers must check for null explicitly.
 *
 * @param {unknown} cwd
 * @returns {string|null}
 */
export function sanitizeCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const resolved = path.resolve(cwd);
  return resolved === cwd ? resolved : null;
}

/**
 * Bounded tail-read of a Claude Code transcript jsonl. Reads at most
 * `maxBytes` from the END of the file, drops the (probably partial) first line
 * whenever the read was truncated, keeps only user/assistant entries, drops
 * pure tool_result user entries, and returns at most `maxEntries` of them.
 * Never throws: an unreadable/absent file yields [].
 *
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @param {number} [maxEntries]
 * @returns {Array<object>}
 */
export function readTranscriptTail(filePath, maxBytes = TRANSCRIPT_MAX_BYTES, maxEntries = TRANSCRIPT_MAX_ENTRIES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const fileSize = stat.size;
  const readSize = Math.min(maxBytes, fileSize);
  const offset = fileSize - readSize;
  let buffer;
  let fd;
  try {
    buffer = Buffer.alloc(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, offset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  const rawText = buffer.toString('utf8');
  const lines = rawText.split('\n');
  const startIdx = offset === 0 ? 0 : 1;
  const filtered = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = entry?.type;
    if (t === 'user' || t === 'assistant') {
      if (t === 'user') {
        const content = entry?.message?.content;
        if (Array.isArray(content) && content.every((c) => c?.type === 'tool_result')) continue;
      }
      filtered.push(entry);
    }
  }
  return filtered.slice(-maxEntries);
}

/**
 * True when the agent's final message is a genuine question to the user (its
 * last non-empty line ends in '?'). Forcing a continuation over an open
 * question recreates the "ignore the human" pattern the supervisor exists to
 * catch — a trailing question means the correct status is waiting_for_user, so
 * callers should skip the judge entirely.
 * @param {unknown} text
 * @returns {boolean}
 */
export function endsWithTrailingQuestion(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines[lines.length - 1].endsWith('?');
}

/**
 * Shared scan behind both computeTurnKey* entrances: walk newest→oldest, take
 * the first genuine (non-machine-injected) user text, return it trimmed and
 * truncated. One implementation, two input shapes — the transcript entry shape
 * (`{type,message.content}`) and the normalized message shape
 * (`{info.role,parts}`) are genuinely different records, so the ADAPTER varies
 * while the scan does not.
 *
 * @param {Array} items
 * @param {{isUser:(item:any)=>boolean, skipItem:(item:any)=>boolean, textsOf:(item:any)=>string[], skipText:(text:string)=>boolean}} adapter
 * @returns {string|null}
 */
function scanForTurnKey(items, adapter) {
  const list = Array.isArray(items) ? items : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (!adapter.isUser(item)) continue;
    if (adapter.skipItem(item)) continue;
    for (const text of adapter.textsOf(item)) {
      if (typeof text !== 'string') continue;
      if (adapter.skipText(text)) continue;
      const trimmed = text.trim();
      if (trimmed) return trimmed.slice(0, TURN_KEY_MAX_CHARS);
    }
  }
  return null;
}

/**
 * Turn key over NORMALIZED messages (`{info:{role},parts:[{type,text}]}`) —
 * the supervisor Stop hook's shape, mirroring opencode's
 * getLastRelevantUserMessageId/getMessageSignature. CC's normalized messages
 * carry no message IDs/timestamps, so the key is a truncated text fingerprint
 * of the real user turn. Used to scope the per-attempt counter to the CURRENT
 * human turn: a new real message means a new turn_key, which resets the
 * counter, while an autonomous loop that never sees new human input keeps the
 * same turn_key across many Stop events.
 *
 * Machine-injected user records are not human turns. This covers BOTH the
 * supervisor's own markers AND foreign Stop hooks (`isMeta:true` /
 * `Stop hook feedback:`) — the latter used to flip the turn key on every Stop
 * event, resetting readAttempts to 0 forever.
 *
 * Returns null when no genuine user message is found (e.g. empty/unreadable
 * transcript) — callers must treat null as "unknown" and skip turn-key-based
 * reset/dedup rather than forcing a reset.
 *
 * @param {Array} normalizedMessages
 * @returns {string|null}
 */
export function computeTurnKeyFromMessages(normalizedMessages) {
  return scanForTurnKey(normalizedMessages, {
    isUser: (msg) => msg?.info?.role === 'user',
    skipItem: (msg) => isNonHumanUserMessage(msg),
    textsOf: (msg) => (msg?.parts ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text),
    skipText: (text) => isNonHumanUserText(text),
  });
}

/**
 * Turn key over RAW transcript entries (`{type,message:{content}}`) — the
 * plainspeak Stop hook's shape, which reads the jsonl tail directly rather
 * than normalizing it first. Skips the supervisor's own injected markers plus
 * any `extraMarkers` the caller owns (plainspeak passes its own
 * PLAINSPEAK_MARKER, so a prior rewrite directive is never mistaken for a new
 * human turn). Returns null when no genuine user message is found; callers
 * must treat null as "unknown" and never fire.
 *
 * @param {Array} transcriptTail
 * @param {{extraMarkers?: string[]}} [opts]
 * @returns {string|null}
 */
export function computeTurnKeyFromTranscript(transcriptTail, { extraMarkers = [] } = {}) {
  const markers = [SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER, ...extraMarkers];
  return scanForTurnKey(transcriptTail, {
    isUser: (entry) => entry?.type === 'user',
    skipItem: () => false,
    textsOf: (entry) => {
      const content = entry?.message?.content;
      if (typeof content === 'string') return [content];
      if (Array.isArray(content)) {
        const block = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
        if (block) return [block.text];
      }
      return [];
    },
    skipText: (text) => markers.some((m) => text.includes(m)),
  });
}

/**
 * Collect the whole Stop payload from stdin. Identical in both hooks —
 * stdin→string collection is not something that varies.
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

/**
 * Build a hook's `debug(obj, cwd)` logger. The BODY is shared; the policy is
 * not — the two hooks deliberately differ on state dir, enable flag, and what
 * happens when the append itself fails (supervisor is loud on stderr,
 * plainspeak is silent because it must never add noise to a delivered reply).
 * `isEnabled` is a function, not a boolean, so a caller may read env at call
 * time rather than at module load.
 *
 * CONTRACT: the returned logger is TOTAL — a logger that can throw is a logger
 * that can kill the turn it was only supposed to describe. `path.join` throws a
 * TypeError on a non-string `cwd` and `JSON.stringify` throws on a circular or
 * BigInt-bearing `obj`, so BOTH the path build and the serialization live
 * inside the try, not just the write. (plainspeak's private copy wrapped its
 * whole body and documented "best effort"; supervisor's did not. Sharing one
 * body must not quietly export the weaker of the two guarantees — plainspeak in
 * particular must never add noise to, or abort, a delivered reply.) `onError`
 * is called for any failure and is itself guarded: a throwing `onError` cannot
 * escape either. `line` is passed as null when the failure was the
 * serialization itself.
 *
 * @param {{stateDir:string, isEnabled:() => boolean, file?:string, onError?:(err:unknown, line:string|null)=>void}} opts
 * @returns {(obj:object, cwd?:string) => void}
 */
export function createDebugLogger({ stateDir, isEnabled, file = 'debug.log', onError }) {
  return function debug(obj, cwd) {
    let line = null;
    try {
      if (!isEnabled()) return;
      const dir = path.join(cwd ?? process.cwd(), stateDir);
      line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, file), line);
    } catch (err) {
      try { if (onError) onError(err, line); } catch { /* a logger must never throw */ }
    }
  };
}
