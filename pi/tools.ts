import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { goalStore, parseSupervisorCommand, readProjectGoalContract, writeProjectGoal, GOAL_CONDITION_MAX_LEN } from '../core/goal.mjs';
import { bindFocus, clearFocusHold, focusStamp, setFocusHold } from '../core/focus-state.mjs';
import { hashFocusAction, hashFocusGoalContract, hashFocusText, redactFocusText } from '../core/focus.mjs';
import { appendLoopExitLog } from '../core/loop-exit.mjs';
import { sessionStore } from '../core/session-store.mjs';
import { FocusContext, textContent } from './context.ts';
import { runJudge } from './judge.ts';

const reply = (text: string, extra: any = {}) => ({ content: [{ type: 'text' as const, text }], details: undefined, ...extra });
export function status(owner: FocusContext, ctx: ExtensionContext) {
  const s = owner.state(ctx), goal = owner.goal(ctx), limit = owner.limit(ctx);
  return `Supervisor ${owner.disabled(ctx) ? 'off' : 'on'}; retry limit ${Number.isFinite(limit.limit) ? limit.limit : 'unlimited'} (${limit.tier}).\n`
    + (s.goal ? `Goal (${s.goal.status}, ${s.goal.source}): ${redactFocusText(s.goal.condition)}` : goal ? `Project goal (focus adoption required): ${redactFocusText(goal.condition)}` : 'No active goal; supervision is not armed.')
    + (s.focus?.hold || owner.localHold ? `\nFocus held: ${s.focus?.hold?.reason || owner.localHold}. Use /supervisor resume after clarification; /supervisor adopt <entry-id> for a missing/foreign anchor.` : '')
    + '\nChecks use the current model. Extra usage is journaled; native totals can omit settlement usage.';
}

export function registerTools(pi: ExtensionAPI, owner: FocusContext) {
  pi.registerTool({ name: 'supervisor_goal', label: 'Supervisor goal', exposure: 'model-only',
    description: 'Inspect the goal with no arguments, or declare the user’s multi-step outcome before working. Supply condition, acceptanceCriteria and verification. Agent declarations are session-only and are validated against operator ingress. Replace only your own goal after genuine operator redirection, never by replace alone. Re-propose sibling work in a later batch after declaration commits.',
    parameters: Type.Object({ condition: Type.Optional(Type.String()), acceptanceCriteria: Type.Optional(Type.String()),
      verification: Type.Optional(Type.String()), source: Type.Optional(Type.String()), replace: Type.Optional(Type.Boolean()) }),
    async execute(id, args, signal, _update, ctx) {
      if (!args.condition?.trim()) return reply(status(owner, ctx));
      let declarationUsage: any;
      const reject = (reason: string) => { owner.hold(ctx, reason); return reply(`Focus hold: ${redactFocusText(reason)}`, { isError: true, ...(declarationUsage ? { usage: declarationUsage } : {}) }); };
      owner.resolveReceipts(ctx);
      if (signal?.aborted || owner.eligibility(ctx) || owner.control || owner.localHold || owner.inputProblem()) return reject('Declaration needs eligible, unambiguous operator work input.');
      const s = owner.state(ctx), previous = owner.goal(ctx);
      if (s.focus?.hold) return reject('Explicit operator recovery is required before declaring another goal.');
      if (previous && (!s.goal || previous.source !== 'agent')) return reject('Agent declarations cannot replace a user goal or project fallback.');
      if (previous && (!args.replace || !owner.latest?.entryId || owner.latest.entryId === s.focus?.origin.originalUserEntryId)) return reject('Replacement requires a newer correlated operator redirection, not replace:true alone.');
      if (![args.condition, args.acceptanceCriteria, args.verification].every(v => typeof v === 'string' && v.trim() && v.length <= GOAL_CONDITION_MAX_LEN)) return reject('Declarations require bounded condition, acceptance criteria and verification.');
      const revision = owner.revision, activity = owner.activityId;
      let origin: any;
      try { origin = owner.origin(owner.latest!); } catch { return reject('Focus anchor unavailable; explicitly adopt the operator request.'); }
      const candidate = { condition: args.condition.trim(), acceptanceCriteria: args.acceptanceCriteria!.trim(), verification: args.verification!.trim(), source: 'agent' };
      const action = { toolCallId: id, toolName: 'supervisor_goal', input: { ...candidate, replace: !!args.replace,
        previousContract: previous ?? null } };
      const hash = hashFocusAction(action);
      const controller = new AbortController(); owner.controllers.add(controller);
      try {
        const request = owner.focusRequest({ goal: candidate, origin, latestInstructions: [], temporaryWork: [],
          actions: [{ hash, toolName: action.toolName, input: action.input }], observations: [] });
        const prompt = request.prompt + '\n<declaration_check>Assess the declaration itself, not just whether discussing it is relevant. Allow a concise contract that faithfully covers the requested outcome and verification. The complete original request remains separately pinned and mandatory throughout action checks and completion; constraints and final-response requirements need not be restated verbatim in every contract field. Reject an actual contradiction, substituted/narrower outcome, weakened verification or invented permission; do not confuse a concise summary with revocation of the separately preserved original constraints. For replacement, require that the newer operator receipt genuinely explicitly redirects the previous contract; a summary, status query, prerequisite or temporary detour is not redirection. Ambiguous intent is hold. Model arguments are not authority.</declaration_check>';
        const result = await runJudge(ctx, { prompt, kind: 'pi:declaration', signal: controller.signal });
        declarationUsage = result.usage;
        const now = owner.state(ctx);
        owner.resolveReceipts(ctx);
        if (signal?.aborted || owner.control || owner.inputProblem() || ctx.hasPendingMessages() || revision !== owner.revision || activity !== owner.activityId
            || (previous ? !now.goal || hashFocusGoalContract(now.goal) !== hashFocusGoalContract(previous) : owner.goal(ctx))) return reject('Declaration became stale before commit.');
        if (result.outcome !== 'ok') return reject(result.reason);
        const d = request.parse(result.text).decisions[0];
        if (d.observationIds.length || d.decision !== 'allow') return reject(d.reason);
        goalStore.setGoal(ctx.cwd, owner.sessionId, candidate.condition, { ...candidate, replace: !!args.replace });
        owner.bind(ctx, owner.state(ctx).goal, origin);
        return reply('Session-only agent goal declared and focus anchor bound. Re-propose deferred work in the next batch.', { usage: result.usage });
      } catch { return reject('Declaration assessment/binding failed; supervision has not certified this contract.'); }
      finally { owner.controllers.delete(controller); }
    } });
  pi.registerTool({ name: 'supervisor_loop_exit', label: 'Supervisor loop exit', exposure: 'model-only',
    description: 'Completed requests the active goal’s evidence audit; it never retires the goal directly. Stuck pauses the goal and returns control. Explain the blocker.',
    parameters: Type.Object({ reason: Type.Union([Type.Literal('completed'), Type.Literal('stuck')]), detail: Type.Optional(Type.String()) }),
    async execute(_id, args, signal, _update, ctx) {
      if (signal?.aborted) return reply('Cancelled', { isError: true });
      owner.resolveReceipts(ctx);
      if (owner.eligibility(ctx) || owner.localHold || owner.state(ctx).focus?.hold || owner.revokedActivity) {
        return reply('Supervisor is excluded, disabled, held or cancelled; no goal mutation or audit was authorized.', { isError: true });
      }
      if (owner.goal(ctx) && (owner.control || owner.inputProblem() || owner.resolveFocusContext(ctx).kind !== 'ready')) {
        return reply('Status/control-only or unresolved input cannot authorize a goal audit/pause.', { isError: true });
      }
      if (args.reason === 'completed') { owner.completedRequested = true; return reply('Completion audit requested; goal remains active until a matching non-aborted settlement.'); }
      const s = owner.state(ctx), goal = owner.goal(ctx);
      const detail = redactFocusText(args.detail?.trim() || 'Agent reported stuck');
      if (goal) goalStore.pauseGoal(ctx.cwd, owner.sessionId, s.goal ? { expectedGoal: s.goal, reason: detail } : { projectGoal: goal, reason: detail });
      appendLoopExitLog(ctx.cwd, { at: Date.now(), reason: 'stuck', detail, sessionId: owner.sessionId, platform: 'pi' });
      owner.revoke(ctx, 'stuck'); owner.control = true;
      owner.notice(ctx, `Work paused: ${detail}. Use /supervisor resume to pick it back up.`);
      ctx.abort();
      return reply('Goal paused; operator control returned.');
    } });
  const handler = async (args: string, ctx: any) => {
    try { await command(owner, args, ctx); }
    catch { owner.notice(ctx, 'Supervisor command failed; no successful adoption/recovery is claimed. Inspect /supervisor status.'); }
  };
  pi.registerCommand('supervisor', { description: 'Goal/focus status, on/off, retry N, set-goal TEXT/JSON, clear, resume, adopt <active-user-entry-id>. No execution modes.', handler });
  for (const action of ['set-goal', 'retry', 'on', 'off', 'status']) pi.registerCommand(`supervisor:${action}`, {
    description: `Supervisor ${action} (alias for /supervisor ${action}).`,
    handler: (args, ctx) => handler(`${action} ${args}`, ctx),
  });
}

async function command(owner: FocusContext, raw: string, ctx: ExtensionContext) {
  owner.resolveReceipts(ctx); owner.control = true;
  owner.revoke(ctx, 'operator-control');
  const [head, ...rest] = raw.trim().split(/\s+/);
  const tail = rest.join(' ');
  if (head === 'status' && ['on', 'off'].includes(tail)) {
    goalStore.setStatusDiagram(ctx.cwd, owner.sessionId, tail === 'on');
    owner.notice(ctx, `Status directive ${tail}; supervisor enablement and goal are unchanged.`); return;
  }
  if (head === 'adopt') {
    const entry: any = ctx.sessionManager.getBranch().find(e => e.id === tail);
    if (!entry || entry.type !== 'message' || entry.message.role !== 'user' || !textContent(entry.message.content).trim()
        || (Array.isArray(entry.message.content) && entry.message.content.some(p => p.type !== 'text'))) {
      owner.notice(ctx, 'Adoption needs one active-ancestry user entry containing the complete intended text, without ambiguous attachments.'); return;
    }
    const goal = owner.goal(ctx) ?? owner.state(ctx).goal;
    if (!goal) { owner.notice(ctx, 'No contract to adopt. Use /supervisor set-goal TEXT or JSON first.'); return; }
    const previous = owner.state(ctx).focus;
    const branch = ctx.sessionManager.getBranch();
    const constraints = new Map<string, { entryId: string; text: string }>();
    if (previous?.sessionId === owner.sessionId && previous.goalId === goal.id) {
      // Adoption reanchors the SAME mission, not permission to revoke its still-
      // active instructions. Carry only canonical accepted authority validated
      // on active ancestry, never permissions recovered from abandoned history.
      const prior = branch.find(e => e.id === previous.origin.originalUserEntryId);
      if (!prior || prior.type !== 'message' || prior.message.role !== 'user') {
        owner.notice(ctx, 'Adoption cannot silently discard a command-origin or missing original request. Restate the full condition, criteria and constraints with /supervisor set-goal TEXT/JSON instead; the existing goal is unchanged.');
        return;
      }
      if (prior.type === 'message' && prior.message.role === 'user') {
        const text = textContent(prior.message.content);
        if (hashFocusText(text) !== previous.origin.originalTextHash) throw new Error('changed original authority');
        constraints.set(prior.id, { entryId: prior.id, text });
      }
      for (const span of previous.origin.constraintSpans) {
        const active = branch.find(e => e.id === span.entryId);
        if (!active) continue; // Explicit branch adoption does not resurrect permission.
        if (active.type !== 'message' || active.message.role !== 'user' || textContent(active.message.content) !== span.text) {
          throw new Error('changed accepted authority');
        }
        constraints.set(span.entryId, span);
      }
      constraints.delete(entry.id); // This complete text becomes the new origin itself.
    }
    owner.commandReceipt(ctx, `/supervisor ${raw}`);
    const text = textContent(entry.message.content);
    const origin = { receiptId: owner.activityId + ':' + entry.id, originalUserEntryId: entry.id, originalText: text,
      originalTextHash: hashFocusText(text), authority: 'explicit-adoption', ingress: ctx.mode === 'rpc' ? 'rpc' : ctx.mode === 'print' ? 'print' : 'interactive', constraintSpans: [...constraints.values()] };
    // Explicit adoption makes an identical USER-owned session declaration. Never
    // write project files or import another session's state/custom goal body.
    goalStore.setGoal(ctx.cwd, owner.sessionId, goal.condition, { acceptanceCriteria: goal.acceptanceCriteria, verification: goal.verification, source: 'user' });
    sessionStore.mutate(ctx.cwd, owner.sessionId, s => {
      s.piRootAdopted = owner.sessionId;
      if (s.piRole && !['child', 'judge', 'plan'].includes(s.piRole)) s.piRole = 'root';
      s.piNonHumanEntries = (s.piNonHumanEntries ?? []).filter(id => id !== entry.id);
    });
    owner.bind(ctx, owner.state(ctx).goal, origin);
    owner.receipts = []; owner.latest = undefined;
    owner.notice(ctx, 'Active branch/request explicitly adopted into an identical user-owned session contract. Work has not automatically restarted.'); return;
  }
  const action = head === 'clear' ? { kind: 'goal-clear' } : head === 'resume' ? { kind: 'goal-resume' } : parseSupervisorCommand('supervisor', raw);
  if (['supervisor-status', 'goal-status', 'retry-status'].includes(action.kind)) { owner.notice(ctx, status(owner, ctx)); return; }
  if (action.kind === 'mode-removed') { owner.notice(ctx, 'Execution modes were removed. Use one goal and supervisor on/off.'); return; }
  if (action.kind === 'retry-invalid') { owner.notice(ctx, 'Invalid retry limit: use a positive integer or unlimited/off/0.'); return; }
  if (action.kind === 'supervisor-on' || action.kind === 'supervisor-off') {
    owner.setDisabled(ctx, action.kind === 'supervisor-off'); owner.notice(ctx, status(owner, ctx)); return;
  }
  if (action.kind === 'retry-set') { goalStore.setRetry(ctx.cwd, owner.sessionId, action.n); owner.notice(ctx, status(owner, ctx)); return; }
  if (action.kind === 'goal-clear') {
    goalStore.clearGoal(ctx.cwd, owner.sessionId);
    sessionStore.mutate(ctx.cwd, owner.sessionId, s => { s.piRootAdopted = owner.sessionId; });
    owner.localHold = ''; owner.ambiguity = ''; owner.receipts = [];
    owner.notice(ctx, 'Session goal cleared; project fallback is suppressed.'); return;
  }
  if (action.kind === 'goal-resume') {
    if (owner.inputProblem()) { owner.notice(ctx, 'Ambiguous/unresolved input cannot be resumed implicitly. Use /supervisor adopt <entry-id>.'); return; }
    const old = owner.state(ctx);
    const result = goalStore.resumeGoal(ctx.cwd, owner.sessionId);
    const s = owner.state(ctx);
    if (!s.goal || s.goal.status !== 'active' || !s.focus || s.focus.goalId !== s.goal.id) {
      owner.notice(ctx, `Resume ${result.resumed ? 'restored the goal, but focus adoption is required' : 'did not restore an active anchored goal'}. Use /supervisor adopt <entry-id>.`); return;
    }
    if (hashFocusGoalContract(s.goal) !== s.focus.contractHash) {
      bindFocus(ctx.cwd, owner.sessionId, { expectedGoal: s.goal, meta: { ...s.focus,
        contractHash: hashFocusGoalContract(s.goal), generation: s.focus.generation + 1 } });
    }
    const current = owner.state(ctx);
    // Check raw anchors before clearing either latch. A temporary local bypass
    // is limited to this synchronous validation, never an execution allow.
    const held = owner.localHold; owner.localHold = '';
    const canonicalHold = current.focus.hold;
    if (canonicalHold) clearFocusHold(ctx.cwd, owner.sessionId, { expectedGoal: current.goal,
      stamp: focusStamp(current.focus, owner.activityId), authorized: true });
    const resolved = owner.resolveFocusContext(ctx);
    if (resolved.kind !== 'ready') {
      if (canonicalHold) {
        const latest = owner.state(ctx);
        setFocusHold(ctx.cwd, owner.sessionId, { stamp: focusStamp(latest.focus, owner.activityId), reason: canonicalHold.reason });
      }
      owner.localHold = held || resolved.reason;
      owner.notice(ctx, 'Focus anchor still unavailable; explicitly adopt this branch.'); return;
    }
    sessionStore.mutate(ctx.cwd, owner.sessionId, st => {
      if (st.goal?.id !== current.goal.id) return;
      st.attempts = { count: 0, turnKey: st.focus.human.turnKey, lastIso: new Date().toISOString() };
      st.goal.attempts = 0; delete st.focus.lastCorrection; delete st.focus.correctionActivities;
    });
    owner.heldNotice = false; owner.notice(ctx, old.focus?.hold || held || result.resumed ? 'Goal/focus resumed; the next work request receives fresh checks. No work was automatically restarted.' : 'Goal already active; no automatic restart.'); return;
  }
  if (action.kind === 'goal-set') {
    const operatorText = raw.trim().replace(/^(?:set-goal|goal)\s+/, '');
    let declaration: any = { condition: operatorText };
    if (operatorText.startsWith('{')) {
      declaration = JSON.parse(operatorText);
      const fields = new Set(['condition', 'acceptanceCriteria', 'verification', 'persist']);
      if (!declaration || Array.isArray(declaration) || Object.keys(declaration).some(key => !fields.has(key))
          || (declaration.persist !== undefined && typeof declaration.persist !== 'boolean')) {
        owner.notice(ctx, 'set-goal JSON supports only condition, acceptanceCriteria, verification and boolean persist. Put all task constraints in those contract fields; no goal was changed.');
        return;
      }
    }
    if (typeof declaration.condition !== 'string' || !declaration.condition.trim() || declaration.condition.length > GOAL_CONDITION_MAX_LEN
        || ['acceptanceCriteria', 'verification'].some(k => declaration[k] !== undefined && (typeof declaration[k] !== 'string' || declaration[k].length > GOAL_CONDITION_MAX_LEN))) throw new Error('invalid contract');
    const origin = owner.commandReceipt(ctx, operatorText);
    goalStore.setGoal(ctx.cwd, owner.sessionId, declaration.condition, { source: 'user', acceptanceCriteria: declaration.acceptanceCriteria, verification: declaration.verification });
    const goal = owner.state(ctx).goal;
    sessionStore.mutate(ctx.cwd, owner.sessionId, s => {
      s.piRootAdopted = owner.sessionId;
      if (s.piRole && !['child', 'judge', 'plan'].includes(s.piRole)) s.piRole = 'root';
    });
    owner.bind(ctx, goal, origin);
    if (declaration.persist === true) writeProjectGoal(ctx.cwd, goal.condition, goal);
    owner.receipts = []; owner.latest = undefined;
    owner.notice(ctx, 'User-owned session goal set and focus anchored. Project persistence occurs only with JSON persist:true.'); return;
  }
  owner.notice(ctx, 'Supported: /supervisor status|on|off|retry N|set-goal TEXT/JSON|clear|resume|adopt <entry-id>.');
}
