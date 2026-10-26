// Manual live validation only. OAuth stays in this parent process, never the actor sandbox.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createModels, normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export async function startLiveRelay({ modelId = 'gpt-6.1-sol', replay, timeoutMs = 120_000 } = {}) {
  const models = createModels();
  models.setProvider(openaiCodexProvider());
  const model = models.getModel('openai-codex', modelId);
  if (!model) throw new Error(`Live validation model is not in the pinned catalog: ${modelId}`);
  // Normal current-user auth command; stdout is consumed only in memory. No config/auth copy.
  let bearer;
  try {
    bearer = execFileSync('pi', ['auth', 'print-bearer-token', '--provider', 'openai-codex', '--min-expiry', '30m'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
  } catch {
    throw new Error('Live validation authorization is unavailable; credential output is not logged');
  }
  if (!bearer) throw new Error('Live validation has no OpenAI Codex authorization');
  const requests = [];
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/infer') { res.writeHead(404); res.end(); return; }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const started = Date.now();
    let record;
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2_000_000) throw new Error('Live relay context exceeds its explicit limit');
      }
      const data = JSON.parse(raw);
      if (!data.context || !Array.isArray(data.context.messages)) throw new Error('Invalid native model context');
      // Native 1.2 serializes tool definitions INSIDE its system message, not
      // context.tools. Audits are our exact one-user-message registry requests.
      const actor = data.context.messages.some(message => message.role === 'system');
      if (!actor && !(data.context.messages.length === 1 && data.context.messages[0].role === 'user')) {
        throw new Error('Unrecognized native actor/audit envelope; do not guess attribution');
      }
      record = { index: requests.length + 1, underlyingModel: `openai-codex/${modelId}`,
        context: data.context, kind: actor ? 'actor' : 'audit', started, replay: false };
      requests.push(record);
      const replayMessage = replay?.(record);
      let out;
      if (replayMessage) {
        record.replay = true;
        out = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), content: replayMessage.content,
          stopReason: replayMessage.stopReason ?? 'toolUse',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      } else {
        const allowed = {};
        for (const key of ['maxTokens', 'reasoning', 'temperature']) {
          if (data.options?.[key] !== undefined) allowed[key] = data.options[key];
        }
        out = await streamSimple(model, normalizeContext(data.context), {
          ...allowed, maxTokens: allowed.maxTokens ?? 6000,
          reasoning: allowed.reasoning ?? 'low', apiKey: bearer, transport: 'sse', signal: controller.signal,
        }).result();
      }
      if (['error', 'aborted'].includes(out.stopReason)) {
        out = { ...out, errorMessage: 'Real provider failed or was cancelled; credential-bearing diagnostics are withheld' };
      }
      record.latencyMs = Date.now() - started;
      record.response = out;
      record.usageReported = !record.replay && !['error', 'aborted'].includes(out.stopReason);
      // Subscription catalog entries may price at zero; this is not proof of free usage.
      record.costKnown = record.usageReported && Object.values(model.cost ?? {}).some(n => Number(n) > 0);
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch {
      if (record) { record.failed = true; record.latencyMs = Date.now() - started; record.usageReported = false; }
      if (!res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Real-model inference failed; no substitute verdict was produced' }));
      }
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { model: `openai-codex/${modelId}`, requests,
    url: `http://127.0.0.1:${server.address().port}/infer`,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      bearer = '';
    } };
}
