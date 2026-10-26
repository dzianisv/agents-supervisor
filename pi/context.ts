import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sessionStore, atomicWriteFileSync } from '../core/session-store.mjs';
import { goalStore, readProjectGoalContract, describeRunawayLimit, readConfiguredMaxAttempts } from '../core/goal.mjs';
import { bindFocus, invalidateFocus, recordFocusQuotes, focusStamp, setFocusHold } from '../core/focus-state.mjs';
import { hashFocusText, hashFocusGoalContract, isFocusFresh, redactFocusText, prepareFocusRequest } from '../core/focus.mjs';
import { isNonHumanUserText } from '../core/evaluation.mjs';
import { isPiWorkInput } from './intent.ts';

export const REF = 'supervisor.focus-ref';
export const textContent = (content: any): string => typeof content === 'string' ? content :
  (Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n\n') : '');

/** Only ordinary user/assistant prose. Custom messages, tools, thinking and
 * focus journal entries are never completion evidence or new human authority. */
export function normalizePiProse(entries: any[], nonHumanEntryIds: string[] = []) {
  return entries.flatMap(e => {
    const m = e.type === 'message' ? e.message : undefined;
    if (!m || !['user', 'assistant'].includes(m.role)) return [];
    const text = textContent(m.content);
    if (m.role === 'user' && (nonHumanEntryIds.includes(e.id) || isNonHumanUserText(text))) return [];
    return [{ info: { role: m.role, id: e.id }, parts: [{ type: 'text', text }] }];
  });
}

type Receipt = {
  id: string; ordinal: number; text: string; hash: string; source: string;
  ingress: string; startLeaf: string | null; trusted: boolean; ambiguous: boolean;
  lane: 'immediate' | 'steer' | 'followUp';
  message?: any; entryId?: string; cohort?: string; accepted?: boolean; delivery?: number;
};

/** One owner per native session. No timers, scheduler or alternate goal store. */
export class FocusContext {
  pi: ExtensionAPI;
  sessionId = '';
  activityId = randomUUID();
  revision = 0;
  receipts: Receipt[] = [];
  seenUsers = new Set<string>();
  deliveryOrdinal = 0;
  checkOrdinal = 0;
  latest?: Receipt;
  ambiguity = '';
  control = true;
  localHold = '';
  heldNotice = false;
  controllers = new Set<AbortController>();
  // Native PREPARED permissions live beyond tool_call's return until execution.
  prepared = new Set<string>();
  revokedActivity = false;
  redirectPrinted = false;
  observations: any[] = [];
  candidate: any;
  batch: any;
  completedRequested = false;
  // All state claims are synchronous; serialize awaited in-process checks too.
  queue: Promise<any> = Promise.resolve();
  constructor(pi: ExtensionAPI) { this.pi = pi; }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  focusRequest(input: any) {
    if (this.checkOrdinal >= Number.MAX_SAFE_INTEGER) throw new Error('Focus request references exhausted');
    return prepareFocusRequest(input, { requestId: `q${(++this.checkOrdinal).toString(36)}` });
  }
  state(ctx: ExtensionContext): any { return sessionStore.load(ctx.cwd, ctx.sessionManager.getSessionId()); }
  goal(ctx: ExtensionContext): any {
    const s = this.state(ctx);
    if (s.goal) return s.goal.status === 'active' ? s.goal : null;
    return s.goalCleared ? null : readProjectGoalContract(ctx.cwd);
  }
  limit(ctx: ExtensionContext) {
    return describeRunawayLimit({ sessionOverride: this.state(ctx).maxAttempts,
      config: readConfiguredMaxAttempts(message => this.notice(ctx, message)) });
  }
  disabled(ctx: ExtensionContext) {
    try { return readFileSync(join(ctx.cwd, '.supervisor/disabled'), 'utf8').split(/\r?\n/).includes(this.sessionId); }
    catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
  }
  setDisabled(ctx: ExtensionContext, disabled: boolean) {
    const file = join(ctx.cwd, '.supervisor/disabled');
    let lines: string[] = [];
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    lines = lines.filter(id => id !== this.sessionId);
    if (disabled) lines.push(this.sessionId);
    atomicWriteFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
    if (this.disabled(ctx) !== disabled) throw new Error('Supervisor enable change did not persist');
  }
  notice(ctx: ExtensionContext, text: string) {
    const safe = redactFocusText(text);
    this.pi.sendMessage({ customType: 'supervisor.feedback', content: safe, display: true }, { triggerTurn: false });
    // Native print does not render queued custom messages (proved on 1.2.0).
    if (ctx.mode === 'print') process.stderr.write(`${safe}\n`);
  }
  revoke(ctx: ExtensionContext, reason: string) {
    const preparedAuthority = this.prepared.size > 0;
    const activeAuthority = preparedAuthority || this.controllers.size > 0 || this.batch?.guarded;
    this.revision++;
    this.candidate = undefined;
    this.batch = undefined;
    if (activeAuthority) this.revokedActivity = true;
    if (preparedAuthority && !ctx.isIdle()) {
      // Abort the NATIVE activity once a permission has left tool_call: local
      // freshness can no longer fence that sibling. Never await idle from a
      // hook, clear queues or manufacture replacement prompts. Before any allow
      // exists, cancellation + the revoked-activity gate suffice and let native
      // queues drain normally. Idle ingress must not abort a fresh run.
      ctx.abort();
    }
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    invalidateFocus(ctx.cwd, ctx.sessionManager.getSessionId(), { reason });
  }
  start(event: any, ctx: ExtensionContext) {
    this.sessionId = ctx.sessionManager.getSessionId();
    this.receipts = []; this.latest = undefined;
    this.seenUsers = new Set(ctx.sessionManager.getBranch().filter((e: any) => e.type === 'message' && e.message.role === 'user').map(e => e.id));
    this.ambiguity = ''; this.localHold = ''; this.heldNotice = false;
    this.control = true; this.activityId = randomUUID();
    this.revoke(ctx, `session-${event.reason}`);
    this.prepared.clear(); this.revokedActivity = false;
  }
  captureReceipt(event: any, ctx: ExtensionContext) {
    this.resolveReceipts(ctx);
    this.revoke(ctx, 'new-input');
    const undelivered = this.receipts.filter(r => !r.entryId && !r.message);
    // The host supplies no delivery ID or handled notification. Another ingress
    // before delivery may mean consumption, not queuing. Defer acceptance until
    // a closed, entirely trusted native queue cohort has delivered in full.
    const trusted = ['interactive', 'rpc'].includes(event.source) && !isNonHumanUserText(event.text);
    const r: Receipt = { id: randomUUID(), ordinal: this.receipts.length + 1, text: event.text,
      hash: hashFocusText(event.text), source: event.source,
      ingress: ctx.mode === 'print' ? 'print' : event.source === 'rpc' ? 'rpc' : 'interactive',
      startLeaf: ctx.sessionManager.getLeafId(), trusted, ambiguous: !!event.images?.length,
      lane: event.streamingBehavior ?? 'immediate' };
    if (undelivered.length) {
      const cohort = undelivered.find(p => p.cohort)?.cohort ?? randomUUID();
      for (const p of undelivered) p.cohort = cohort;
      r.cohort = cohort;
      const group = [...this.receipts.filter(p => p.cohort === cohort), r];
      if (group.some(p => !p.trusted || p.ambiguous || p.lane === 'immediate' || p.source !== r.source)) {
        this.ambiguity = 'Unresolved/consumed or mixed-provenance input requires explicit adoption of the intended request.';
      }
    }
    this.receipts.push(r);
    this.control = !trusted || !isPiWorkInput(event.text);
    // Source is a trusted-host deployment assumption, NOT human authentication.
  }
  messageStart(event: any, ctx: ExtensionContext) {
    if (event.message.role !== 'user') return;
    this.resolveReceipts(ctx);
    const pending = this.receipts.filter(r => !r.message && !r.entryId);
    // Native delivery prioritizes steering over follow-up, not ingress FIFO.
    // Immediate input belongs to the newly started run. This ordering is NOT
    // proof of provenance when a receipt may have been consumed: those remain
    // ambiguous and cannot authorize anything without explicit adoption.
    const receipt = pending.filter(r => r.lane === 'immediate').at(-1)
      ?? pending.find(r => r.lane === 'steer') ?? pending.find(r => r.lane === 'followUp');
    if (!receipt) { this.ambiguity = 'User entry has no correlated operator ingress; explicitly adopt it.'; return; }
    receipt.delivery = ++this.deliveryOrdinal;
    receipt.message = { timestamp: event.message.timestamp, text: textContent(event.message.content) };
    // A delivered input starts a new authority boundary within a native run
    // (steer/followUp do not emit before_agent_start). It cannot un-abort a
    // native signal or resolve ambiguous provenance.
    this.revokedActivity = false;
    if (receipt.message.text !== receipt.text || receipt.ambiguous) {
      receipt.ambiguous = true;
      this.ambiguity = 'Transformed input or attachments require explicit adoption of the intended text.';
    }
    this.control = !receipt.trusted || !isPiWorkInput(receipt.text);
  }
  resolveReceipts(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getBranch().filter((e: any) => e.type === 'message' && e.message.role === 'user' && !this.seenUsers.has(e.id));
    for (const entry of entries as any[]) {
      this.seenUsers.add(entry.id);
      const r = this.receipts.filter(r => r.message && !r.entryId)
        .sort((a, b) => a.delivery! - b.delivery!)[0];
      // Order + finalized timestamp + starting ancestry + payload, never text alone.
      if (!r || r.message.timestamp !== entry.message.timestamp || r.message.text !== textContent(entry.message.content)
          || (r.startLeaf && !ctx.sessionManager.getBranch().some(e => e.id === r.startLeaf))) {
        this.ambiguity = 'Input sequence/ancestry is ambiguous; explicitly adopt the intended request.';
        continue;
      }
      r.entryId = entry.id;
      if (!r.trusted || r.ambiguous) {
        sessionStore.mutate(ctx.cwd, this.sessionId, s => {
          s.piNonHumanEntries = [...new Set([...(s.piNonHumanEntries ?? []), entry.id])];
        });
        continue;
      }
    }
    for (const r of [...this.receipts].sort((a, b) => (a.delivery ?? Infinity) - (b.delivery ?? Infinity))) {
      if (!r.entryId || r.accepted || !r.trusted || r.ambiguous || this.ambiguity) continue;
      if (r.cohort) {
        const group = this.receipts.filter(p => p.cohort === r.cohort);
        // Full cardinality closure proves no member was consumed. Native lane
        // order + each exact finalized payload/timestamp were checked above;
        // equal text alone never closes a missing or generated receipt.
        if (group.some(p => !p.entryId || !p.trusted || p.ambiguous || p.lane === 'immediate')) continue;
      }
      r.accepted = true;
      this.latest = r;
      const s = this.state(ctx);
      if (s.focus && s.focus.goalId === s.goal?.id) {
        if (s.goal.status === 'active' && isPiWorkInput(r.text)) {
          invalidateFocus(ctx.cwd, this.sessionId, { reason: 'accepted-operator-turn',
            nextHuman: { entryId: r.entryId, epoch: s.focus.human.epoch + 1, turnKey: `${this.sessionId}:${r.entryId}` },
            appendConstraints: [{ entryId: r.entryId, text: r.text }] });
        } else {
          // Non-work is not non-authority: a standalone prohibition or paused
          // clarification must survive resume/restart without restarting work.
          recordFocusQuotes(ctx.cwd, this.sessionId, { expectedGoal: s.goal,
            stamp: focusStamp(s.focus, this.activityId), quotes: [{ entryId: r.entryId, text: r.text }] });
        }
      }
    }
  }
  origin(receipt: Receipt, authority = 'operator-ingress') {
    if (!receipt?.entryId || !receipt.accepted || receipt.ambiguous || !receipt.trusted || this.inputProblem()) throw new Error('Focus anchor unavailable; use /supervisor adopt <entry-id>');
    return { receiptId: receipt.id, originalUserEntryId: receipt.entryId, originalText: receipt.text,
      originalTextHash: receipt.hash, ingress: receipt.ingress, authority, constraintSpans: [] };
  }
  bind(ctx: ExtensionContext, goal: any, origin: any) {
    const previous = this.state(ctx).focus;
    const generation = (previous?.generation ?? 0) + 1;
    this.pi.appendEntry(REF, { version: 1, sessionId: this.sessionId, goalId: goal.id,
      receiptId: origin.receiptId, originalUserEntryId: origin.originalUserEntryId, generation });
    const markerEntryId = ctx.sessionManager.getLeafId();
    const meta = { version: 1, runtime: 'pi', sessionId: this.sessionId, goalId: goal.id,
      contractHash: hashFocusGoalContract(goal), origin,
      branch: { markerEntryId, epoch: (previous?.branch.epoch ?? 0) + 1 },
      human: { entryId: origin.originalUserEntryId, epoch: (previous?.human.epoch ?? 0) + 1,
        turnKey: `${this.sessionId}:${origin.originalUserEntryId}` }, generation };
    if (!bindFocus(ctx.cwd, this.sessionId, { expectedGoal: goal, meta }).bound) throw new Error('Focus binding did not commit');
    this.ambiguity = ''; this.localHold = ''; this.heldNotice = false;
  }
  eligibility(ctx: ExtensionContext): string | null {
    if (this.disabled(ctx)) return 'disabled';
    const s = this.state(ctx);
    if (['child', 'judge', 'plan'].includes(s.piRole)) return s.piRole;
    if (s.piRole && s.piRole !== 'root') return 'Unknown runtime role requires explicit adoption';
    if (ctx.sessionManager.getHeader()?.parentSession && s.piRootAdopted !== this.sessionId) return 'fork requires explicit adoption';
    if (s.piRootAdopted !== this.sessionId && ctx.sessionManager.getBranch().some((e: any) =>
      e.type === 'custom' && e.customType === REF && e.data?.sessionId !== this.sessionId)) return 'Foreign focus reference requires explicit adoption';
    return null;
  }
  inputProblem(): string {
    return this.ambiguity || (this.receipts.some(r => !r.entryId || r.ambiguous || (r.trusted && !r.accepted))
      ? 'Unresolved, ambiguous or consumed input needs explicit adoption/clarification.' : '');
  }
  resolveFocusContext(ctx: ExtensionContext): any {
    this.resolveReceipts(ctx);
    const eligibility = this.eligibility(ctx);
    if (eligibility) return { kind: eligibility.includes('adoption') ? 'hold' : 'skip', reason: eligibility };
    const goal = this.goal(ctx);
    if (!goal) return { kind: 'skip', reason: 'no-active-goal' };
    const s = this.state(ctx), meta = s.focus;
    if (!goal.id || !meta || meta.sessionId !== this.sessionId || meta.goalId !== goal.id || meta.contractHash !== hashFocusGoalContract(goal)) {
      return { kind: 'hold', reason: 'Focus anchor unavailable; use /supervisor adopt <active-user-entry-id> (project goals need explicit session adoption).' };
    }
    const branch: any[] = ctx.sessionManager.getBranch();
    const ref = branch.find(e => e.id === meta.branch.markerEntryId);
    const raw = branch.find(e => e.id === meta.origin.originalUserEntryId);
    const rawMatches = raw && ((raw.type === 'message' && raw.message.role === 'user' && hashFocusText(textContent(raw.message.content)) === meta.origin.originalTextHash)
      || (meta.origin.authority === 'explicit-adoption' && raw.type === 'custom' && raw.customType === 'supervisor.operator-command' && raw.data?.receiptId === meta.origin.receiptId));
    if (!ref || ref.customType !== REF || ref.data?.version !== 1 || ref.data?.sessionId !== this.sessionId || ref.data?.goalId !== goal.id
        || ref.data?.receiptId !== meta.origin.receiptId || ref.data?.originalUserEntryId !== meta.origin.originalUserEntryId
        || !Number.isSafeInteger(ref.data?.generation) || ref.data.generation > meta.generation || !rawMatches
        || !branch.some(e => e.id === meta.human.entryId)
        || meta.origin.constraintSpans.some(c => {
          // Later instructions can grant permissions as well as restrict work.
          // Abandoned history cannot authorize the active branch. Preserve the
          // canonical mission, but require explicit re-adoption when any accepted
          // instruction leaves active ancestry; never silently drop its limits.
          const e: any = branch.find(e => e.id === c.entryId);
          return !e || e.type !== 'message' || e.message.role !== 'user' || textContent(e.message.content) !== c.text;
        })) {
      return { kind: 'hold', reason: 'Current branch does not own the canonical focus anchor; explicitly adopt this branch.' };
    }
    if (this.ambiguity) return { kind: 'hold', reason: this.ambiguity };
    if (this.localHold || meta.hold) return { kind: 'hold', reason: this.localHold || meta.hold.reason };
    if (this.inputProblem()) return { kind: 'hold', reason: this.inputProblem() };
    return { kind: 'ready', goal, meta, stamp: focusStamp(meta, this.activityId), revision: this.revision };
  }
  fresh(ctx: ExtensionContext, expected: any) {
    if (this.control || this.revokedActivity || ctx.signal?.aborted || ctx.hasPendingMessages() || expected.revision !== this.revision || expected.stamp.activityId !== this.activityId) return false;
    const current = this.resolveFocusContext(ctx);
    return current.kind === 'ready' && isFocusFresh(expected.stamp, current.stamp);
  }
  hold(ctx: ExtensionContext, reason: string, resolved?: any) {
    if (!resolved) {
      try { const current = this.resolveFocusContext(ctx); if (current.kind === 'ready') resolved = current; }
      catch { /* Still visibly hold when context itself is unavailable. */ }
    }
    this.localHold ||= redactFocusText(reason);
    this.candidate = undefined;
    if (resolved?.kind === 'ready') setFocusHold(ctx.cwd, this.sessionId, { stamp: resolved.stamp, reason: this.localHold });
    if (!this.heldNotice) {
      this.heldNotice = true;
      this.notice(ctx, `Focus hold: ${this.localHold} Work is paused, not completed. Clarify the request, then use /supervisor resume; missing/foreign anchors require /supervisor adopt <entry-id>.`);
    }
    ctx.abort(); // Native hook abort must NOT wait for idle.
    return { block: true, reason: `Focus hold: ${this.localHold}` };
  }
  newActivity(ctx: ExtensionContext) {
    this.resolveReceipts(ctx);
    this.activityId = randomUUID(); this.batch = undefined; this.candidate = undefined; this.completedRequested = false;
    this.prepared.clear(); this.revokedActivity = false; this.redirectPrinted = false;
    // A canonical/local hold is cleared only by explicit operator recovery.
  }
  commandReceipt(ctx: ExtensionContext, text: string): any {
    this.revoke(ctx, 'operator-command');
    const receiptId = randomUUID();
    this.pi.appendEntry('supervisor.operator-command', { receiptId }); // reference only; body stays canonical
    const entryId = ctx.sessionManager.getLeafId()!;
    return { receiptId, originalUserEntryId: entryId, originalText: text, originalTextHash: hashFocusText(text),
      ingress: ctx.mode === 'print' ? 'print' : ctx.mode === 'rpc' ? 'rpc' : 'interactive',
      authority: 'explicit-adoption', constraintSpans: [] };
  }
  branchChanged(ctx: ExtensionContext) {
    this.control = true; // navigating alone is not an operator request to restart
    this.revoke(ctx, 'branch-navigation');
    const s = this.state(ctx);
    if (s.focus) invalidateFocus(ctx.cwd, this.sessionId, { reason: 'branch-epoch',
      nextBranch: { markerEntryId: s.focus.branch.markerEntryId, epoch: s.focus.branch.epoch + 1 } });
    this.seenUsers = new Set(ctx.sessionManager.getBranch().filter((e: any) => e.type === 'message' && e.message.role === 'user').map(e => e.id));
  }
}
