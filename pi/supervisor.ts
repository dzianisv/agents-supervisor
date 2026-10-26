import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GOAL_OWNERSHIP_DIRECTIVE, buildGoalRequirementSection } from '../core/goal.mjs';
import { redactFocusText } from '../core/focus.mjs';
import { FocusContext } from './context.ts';
import { registerTools } from './tools.ts';
import { FocusGuard } from './focus.ts';
import { Settlement } from './settlement.ts';

/** Explicit-load native Pi 1.2.0 adapter. Trusted ingress, FIRST input observer,
 * one native owner, known tools and no later argument-mutating handlers.
 * Earlier input transforms/consumption cannot be observed by this host API.
 * This is workflow assistance, not a security boundary. */
export default function supervisor(pi: ExtensionAPI) {
  const owner = new FocusContext(pi);
  const focus = new FocusGuard(owner);
  const settlement = new Settlement(owner);
  registerTools(pi, owner);
  pi.on('session_start', (event, ctx) => owner.start(event, ctx));
  pi.on('input', (event, ctx) => owner.captureReceipt(event, ctx));
  pi.on('before_agent_start', (event, ctx) => {
    owner.newActivity(ctx);
    if (event.messageType !== 'user') owner.control = true;
    if (owner.control || owner.eligibility(ctx)) return;
    const s = owner.state(ctx);
    let restored = '';
    if (s.goal?.status === 'active' && owner.resolveFocusContext(ctx).kind === 'ready') {
      const original = redactFocusText(JSON.stringify({ originalRequest: s.focus.origin.originalText,
        currentConstraints: s.focus.origin.constraintSpans })).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (original.length <= 24_000) restored = `\n${buildGoalRequirementSection(s.goal.condition, s.goal)}\n<pinned_operator_request>${original}</pinned_operator_request>`;
    }
    // Structured append preserves unrelated host/extension prompt sections.
    const existing = event.systemPromptOptions.appendSystemPrompt || '';
    event.systemPromptOptions.appendSystemPrompt = existing + '\n' + GOAL_OWNERSHIP_DIRECTIVE + restored;
  });
  pi.on('message_start', (event, ctx) => owner.messageStart(event, ctx));
  pi.on('message_end', async (event, ctx) => {
    owner.resolveReceipts(ctx);
    focus.finalizedResult(event);
    await focus.prepareBatch(event, ctx);
  });
  pi.on('tool_call', async (event, ctx) => {
    try { return await focus.beforeTool(event, ctx); }
    catch { return owner.hold(ctx, 'Native focus context/check failed; no approval was granted.'); }
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    try { return await settlement.beforeSettle(event, ctx); }
    catch { owner.hold(ctx, 'Native completion context/check failed; completion was not certified.'); }
  });
  pi.on('agent_settled', (event, ctx) => {
    settlement.onSettled(event, ctx);
    owner.prepared.clear(); owner.batch = undefined; owner.revokedActivity = false;
  });
  pi.on('session_before_tree', (_event, ctx) => owner.revoke(ctx, 'before-tree'));
  pi.on('session_tree', (_event, ctx) => owner.branchChanged(ctx));
  pi.on('session_before_compact', (_event, ctx) => owner.revoke(ctx, 'before-compaction'));
  pi.on('session_compact', (_event, ctx) => owner.revoke(ctx, 'compaction'));
  pi.on('session_compact_failed', (_event, ctx) => owner.revoke(ctx, 'compaction-failed'));
  pi.on('session_before_switch', (_event, ctx) => owner.revoke(ctx, 'before-switch'));
  pi.on('session_before_fork', (_event, ctx) => owner.revoke(ctx, 'before-fork'));
  pi.on('session_shutdown', (_event, ctx) => owner.revoke(ctx, 'shutdown'));
}
