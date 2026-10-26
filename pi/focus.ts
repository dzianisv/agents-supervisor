import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { hashFocusAction, hashFocusGoalContract, renderFocusFeedback, redactFocusText } from '../core/focus.mjs';
import { decideGoalTransition } from '../core/goal.mjs';
import { claimFocusCorrection } from '../core/focus-state.mjs';
import { appendLoopExitLog } from '../core/loop-exit.mjs';
import { sessionStore } from '../core/session-store.mjs';
import { truncateForPrompt } from '../core/task-context.mjs';
import { randomUUID } from 'node:crypto';
import { FocusContext, textContent } from './context.ts';
import { runJudge, combineUsage } from './judge.ts';

export function actionOf(event: any) {
  return { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input,
    ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}) };
}
// Even an inspection must commit before sibling work: an earlier validated
// input handler may have turned it into a declaration before our tool hook.
const unknownEffectsReason = 'Redaction hides dynamic command effects. Rewrite the proposed command to expose its operations without private literals, then explicitly resume.';
const assessmentFailure = (error: any) => error?.code === 'redacted-command-effects-unknown' ? unknownEffectsReason : 'Focus assessment unavailable or malformed';
const declares = (calls: any[]) => calls.some(c => c.name === 'supervisor_goal'
  || (c.name === 'supervisor_loop_exit' && c.arguments?.reason === 'stuck'));

export class FocusGuard {
  owner: FocusContext;
  credits = new Map<string, any[]>();
  roots = new Map<string, string>();
  usedCredits = new Set<string>();
  constructor(owner: FocusContext) { this.owner = owner; }
  credit(callId: string, result: any) {
    if (!result.usage) return;
    const root = this.roots.get(callId) ?? callId;
    this.credits.set(root, [...(this.credits.get(root) ?? []), result]);
  }
  async assess(ctx: ExtensionContext, resolved: any, actions: any[]) {
    const controller = new AbortController(); this.owner.controllers.add(controller);
    try {
      const request = this.owner.focusRequest({ goal: resolved.goal, origin: resolved.meta.origin,
        latestInstructions: resolved.meta.origin.constraintSpans, temporaryWork: resolved.meta.temporaryWork ?? [],
        actions: actions.map(a => ({ hash: hashFocusAction(a), toolName: a.toolName, input: a.input })),
        observations: this.owner.observations });
      const result = await runJudge(ctx, { prompt: request.prompt, kind: 'pi:focus', signal: controller.signal });
      this.credit(actions[0].toolCallId, result);
      if (result.outcome !== 'ok') throw new Error(result.reason);
      const verdict = request.parse(result.text);
      const ids = new Set(this.owner.observations.map(o => o.id));
      if (verdict.decisions.some(d => d.observationIds.some(id => !ids.has(id)))) throw new Error('Unknown observation reference');
      return verdict.decisions;
    } finally { this.owner.controllers.delete(controller); }
  }
  async prepareBatch(event: any, ctx: ExtensionContext) {
    if (event.message.role !== 'assistant') return;
    const calls = event.message.content.filter((p: any) => p.type === 'toolCall');
    this.owner.resolveReceipts(ctx);
    this.owner.activityId = randomUUID();
    const batch: any = { id: this.owner.activityId, declaration: declares(calls), cache: new Map(), correction: '' };
    this.owner.batch = batch;
    if (!calls.length || batch.declaration || this.owner.control || ctx.signal?.aborted) return;
    const resolved = this.owner.resolveFocusContext(ctx);
    if (resolved.kind !== 'ready') return; // tool_call remains authoritative
    batch.guarded = true;
    this.owner.redirectPrinted = false;
    const actions = calls.filter((c: any) => !['supervisor_goal', 'supervisor_loop_exit'].includes(c.name))
      .map((c: any) => ({ toolCallId: c.id, toolName: c.name, input: c.arguments }));
    if (!actions.length) return;
    try {
      const decisions = await this.owner.serial(() => this.assess(ctx, resolved, actions));
      if (this.owner.batch !== batch || !this.owner.fresh(ctx, resolved)) return;
      for (const decision of decisions) batch.cache.set(decision.actionHash, { decision, resolved });
    } catch (error) {
      // Pi swallows message_end exceptions. Cache a hold, never a missing-cache allow.
      batch.failure = assessmentFailure(error);
    }
  }
  expire(ctx: ExtensionContext, resolved: any) {
    const owner = this.owner;
    const transition = decideGoalTransition({ goal: resolved.goal, complete: false, now: Date.now(), maxAttempts: owner.limit(ctx).limit });
    sessionStore.mutate(ctx.cwd, owner.sessionId, s => {
      if (s.goal && hashFocusGoalContract(s.goal) === hashFocusGoalContract(resolved.goal)) s.goal = transition.goal;
    });
    appendLoopExitLog(ctx.cwd, { reason: 'deadline', at: Date.now(), sessionId: owner.sessionId, platform: 'pi' });
    return owner.hold(ctx, 'The goal deadline expired; explicitly resume it.');
  }
  async beforeTool(event: any, ctx: ExtensionContext): Promise<any> {
    const owner = this.owner;
    this.roots.set(event.toolCallId, event.parentToolCallId ? this.roots.get(event.parentToolCallId) ?? event.parentToolCallId : event.toolCallId);
    owner.resolveReceipts(ctx);
    if (event.toolName === 'supervisor_goal' || event.toolName === 'supervisor_loop_exit') {
      if (event.parentToolCallId) return owner.hold(ctx, 'Goal/control tools must be declared directly, not nested.');
      return; // tools.ts validates actual declarations; status/completed are deterministic
    }
    if (ctx.signal?.aborted || owner.revokedActivity) return { block: true, reason: 'Operation cancelled by authority revocation; reassess under the current request.' };
    const eligibility = owner.eligibility(ctx);
    if (eligibility?.includes('adoption')) return owner.hold(ctx, eligibility);
    if (eligibility) return;
    // Read the persisted actual assistant batch too: preparation is an
    // optimization and may have failed. Pi prepares siblings before execute.
    const assistant: any = [...ctx.sessionManager.getBranch()].reverse().find((e: any) => e.type === 'message' && e.message.role === 'assistant');
    if (owner.batch?.declaration || declares(assistant?.message.content?.filter((p: any) => p.type === 'toolCall') ?? [])) {
      return { block: true, reason: 'Defer this batch’s work until supervisor_goal has actually committed its declaration and focus binding. Re-propose the action in the next batch.' };
    }
    if (owner.localHold) return owner.hold(ctx, owner.localHold);
    if (!owner.goal(ctx)) return; // ordinary no-goal questions: no focus audit
    if (ctx.hasPendingMessages()) return { block: true, reason: 'New operator input is pending. Defer this action until it is accepted and reassessed.' };
    if (owner.inputProblem()) return owner.hold(ctx, owner.inputProblem());
    if (owner.control) {
      owner.notice(ctx, 'Status/control-only turn: the pending goal has not been restarted.');
      ctx.abort(); return { block: true, reason: 'Status/control-only turn does not authorize work.' };
    }
    const resolved = owner.resolveFocusContext(ctx);
    if (resolved.kind === 'skip') return;
    if (resolved.kind === 'hold') return owner.hold(ctx, resolved.reason);
    if (ctx.hasPendingMessages()) return { block: true, reason: 'New operator input is pending. Defer this action until it is accepted and reassessed.' };
    if (Date.now() >= resolved.goal.deadline) return this.expire(ctx, resolved);
    try {
      const action = actionOf(event), hash = hashFocusAction(action);
      let cached = owner.batch?.cache.get(hash);
      if (!cached || !owner.fresh(ctx, cached.resolved)) {
        if (owner.batch?.failure) return owner.hold(ctx, owner.batch.failure, resolved);
        const decisions = await owner.serial(async () => {
          if (!owner.fresh(ctx, resolved)) throw new Error('stale');
          return this.assess(ctx, resolved, [action]);
        });
        cached = { decision: decisions[0], resolved };
        if (owner.batch) owner.batch.cache.set(hash, cached);
      }
      // Exact validated input rehash after await + current host/canonical fence.
      if (hashFocusAction(actionOf(event)) !== hash || !owner.fresh(ctx, cached.resolved)) {
        if (ctx.hasPendingMessages() || owner.revision !== resolved.revision) return { block: true, reason: 'Context changed; defer this action until new input is accepted and reassessed.' };
        return owner.hold(ctx, 'Input, goal, human turn or branch changed during assessment; a fresh check is required.', resolved);
      }
      if (Date.now() >= resolved.goal.deadline) return this.expire(ctx, resolved);
      const d = cached.decision;
      if (d.decision === 'hold') return owner.hold(ctx, renderFocusFeedback(d), resolved);
      if (d.decision === 'allow') {
        owner.prepared.add(event.toolCallId);
        return;
      }
      const claimed = claimFocusCorrection(ctx.cwd, owner.sessionId, { expectedGoal: resolved.goal,
        stamp: resolved.stamp, key: hash, maxAttempts: owner.limit(ctx).limit });
      if (!claimed.claimed && claimed.reason !== 'duplicate') {
        const limit = owner.limit(ctx);
        appendLoopExitLog(ctx.cwd, { reason: 'runaway_ceiling', platform: 'pi', at: Date.now(), sessionId: owner.sessionId,
          attempts: claimed.count, maxAttempts: Number.isFinite(limit.limit) ? limit.limit : 'unlimited', tier: limit.tier,
          cappedByPlatform: false, detail: claimed.reason });
        return owner.hold(ctx, 'Focus correction cannot continue automatically; operator recovery is required.', resolved);
      }
      const feedback = claimed.claimed ? renderFocusFeedback(d) : 'Action deferred with this batch’s focus correction. Follow that correction before retrying.';
      // Print hides native tool-result reasons. Attribute one safe correction
      // per batch on stderr only; JSON stdout and the TUI's tool rendering stay native.
      if (ctx.mode === 'print' && !owner.redirectPrinted) {
        owner.redirectPrinted = true;
        process.stderr.write(`Supervisor focus redirect: ${redactFocusText(feedback)}\n`);
      }
      sessionStore.appendVerdict(ctx.cwd, owner.sessionId, { kind: 'pi:focus-decision', decision: 'redirect', actionHash: hash,
        feedback, activityId: owner.activityId });
      return { block: true, reason: feedback };
    } catch (error) {
      if (ctx.signal?.aborted || ctx.hasPendingMessages() || owner.revision !== resolved.revision) return { block: true, reason: 'Assessment cancelled by changed input/context. Reassess the action after the pending input.' };
      return owner.hold(ctx, error?.code === 'redacted-command-effects-unknown' ? unknownEffectsReason : 'Focus assessment unavailable, malformed or over its critical-input budget.', resolved);
    }
  }
  finalizedResult(event: any) {
    const message = event.message;
    if (message.role !== 'toolResult') return;
    this.owner.prepared.delete(message.toolCallId);
    for (const credit of this.credits.get(message.toolCallId) ?? []) {
      if (this.usedCredits.has(credit.checkId)) continue;
      message.usage = combineUsage(message.usage, credit.usage);
      this.usedCredits.add(credit.checkId);
    }
    this.credits.delete(message.toolCallId);
    const raw = redactFocusText(textContent(message.content));
    const text = truncateForPrompt(raw, 4000, { keep: 'head', label: 'focus tool observation' });
    this.owner.observations = this.owner.observations.filter(o => o.id !== `tool:${message.toolCallId}`);
    this.owner.observations.push({ id: `tool:${message.toolCallId}`, text, truncated: raw.length > 4000 });
    this.owner.observations = this.owner.observations.slice(-6);
  }
}
