import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sessionStore } from '../core/session-store.mjs';

/** Registry resolves current-model credentials at request time. No worker
 * model change, direct auth access, provider-specific client or raw error log. */
export async function runJudge(ctx: ExtensionContext, {
  prompt, kind, signal, timeoutMs = 30_000, maxTokens = 2_000,
}: { prompt: string; kind: string; signal?: AbortSignal; timeoutMs?: number; maxTokens?: number }) {
  const checkId = randomUUID(), started = performance.now();
  const sessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
  const model = ctx.model;
  const controller = new AbortController();
  const signals = [signal, ctx.signal].filter(Boolean) as AbortSignal[];
  const combined = AbortSignal.any([controller.signal, ...signals]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reported = false;
  const log = (result: any, late = false) => {
    sessionStore.appendVerdict(cwd, sessionId, { kind: late ? `${kind}:late-usage` : kind, checkId,
      model: result.model, provider: result.provider, latencyMs: result.latencyMs,
      outcome: result.outcome, reason: result.reason, usage: result.usage,
      provisional: kind === 'pi:settlement', nativeTotalsIncludeUsage: false });
  };
  const result: any = { checkId, text: '', model: model?.id ?? 'unavailable', provider: model?.provider,
    latencyMs: 0, outcome: 'hold', reason: 'Judge unavailable' };
  try {
    if (!model || !ctx.modelRegistry || combined.aborted) {
      result.reason = combined.aborted ? 'Judge cancelled' : 'Current model unavailable';
      return result;
    }
    // streamSimple owns auth failures, including subscription refresh. Never
    // extract keys into our state, logs, prompts or a different provider.
    const pending = ctx.modelRegistry.streamSimple(model, {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }, { signal: combined, maxTokens: Math.min(maxTokens, 2_000), reasoning: 'off' }).result();
    pending.then(message => {
      if (reported && message.usage) log({ ...result, usage: safeUsage(message.usage), latencyMs: performance.now() - started }, true);
    }, () => {});
    const cancelled = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error('cancelled'));
      combined.addEventListener('abort', fail, { once: true });
      pending.finally(() => combined.removeEventListener('abort', fail)).catch(() => {});
      timer = setTimeout(() => { result.reason = 'Judge timed out'; controller.abort(); }, Math.min(timeoutMs, 30_000));
    });
    const message = await Promise.race([pending, cancelled]);
    result.model = message.model || model.id;
    result.provider = message.provider || model.provider;
    result.usage = safeUsage(message.usage);
    if (combined.aborted || message.stopReason !== 'stop' || message.content.some(p => p.type === 'toolCall')) {
      result.reason = combined.aborted ? 'Judge cancelled' : 'Judge did not return a complete terminal response';
      return result;
    }
    result.text = message.content.filter(p => p.type === 'text').map((p: any) => p.text).join('\n');
    if (!result.text.trim()) { result.reason = 'Judge returned no verdict'; return result; }
    result.outcome = 'ok'; delete result.reason;
    return result;
  } catch {
    // Provider errors can contain request credentials. Only fixed diagnostics.
    if (result.reason !== 'Judge timed out') result.reason = combined.aborted ? 'Judge cancelled' : 'Judge request failed (model/auth/provider)';
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    result.latencyMs = performance.now() - started;
    reported = true; log(result);
    controller.abort();
  }
}

function safeUsage(usage: any): any {
  if (!usage || typeof usage !== 'object') return undefined;
  const out: any = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens']) {
    if (Number.isFinite(usage[k]) && usage[k] >= 0) out[k] = usage[k];
  }
  out.cost = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (Number.isFinite(usage.cost?.[k]) && usage.cost[k] >= 0) out.cost[k] = usage.cost[k];
  }
  return out;
}

/** Attach only at a finalized TOP-LEVEL result. Nested hook costs ride on the
 * parent's result here, never also through nested result aggregation. */
export function combineUsage(a: any, b: any): any {
  if (!a) return structuredClone(b);
  const out = { ...a, cost: { ...a.cost } };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k === 'cost') {
      for (const [key, amount] of Object.entries(v as any)) out.cost[key] = (out.cost[key] ?? 0) + Number(amount);
    } else if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  }
  return out;
}
