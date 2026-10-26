// Live-test transport only: every non-replay response comes from the real parent relay.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export function liveProvider(url: string, modelId = 'gpt-6.1-sol') {
  return {
    api: 'focus-live-transport', baseUrl: url, apiKey: 'loopback-only-not-a-provider-secret',
    models: [{ id: modelId, name: `Real openai-codex/${modelId} via private test relay`,
      reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 16000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any, options: any = {}) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const callOptions: any = {};
          for (const key of ['maxTokens', 'reasoning', 'temperature']) if (options[key] !== undefined) callOptions[key] = options[key];
          const payload = { context, options: callOptions };
          await options.onPayload?.(payload, model);
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload), signal: options.signal });
          await options.onResponse?.({ status: response.status, headers: response.headers }, model);
          if (!response.ok) throw new Error(`Real-model relay HTTP ${response.status}; no fallback response`);
          const message: any = await response.json();
          if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Invalid real-model response');
          stream.push({ type: 'start', partial: message });
          for (const [index, block] of message.content.entries()) {
            if (block.type === 'text') {
              stream.push({ type: 'text_start', contentIndex: index, partial: message });
              stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message });
              stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: message });
            } else if (block.type === 'toolCall') {
              stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
              stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
              stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: message });
            }
          }
          if (['error', 'aborted'].includes(message.stopReason)) stream.push({ type: 'error', reason: message.stopReason, error: message });
          else stream.push({ type: 'done', reason: message.stopReason, message });
        } catch {
          const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
            content: [], timestamp: Date.now(), stopReason: options.signal?.aborted ? 'aborted' : 'error',
            errorMessage: 'Live provider request failed; no fixture or substitute verdict was used',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  };
}

export default function (pi: any) {
  const url = process.env.SUPERVISOR_PI_LIVE_URL;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/infer$/.test(url)) throw new Error('Explicit loopback live relay required');
  pi.registerProvider('focus-live', liveProvider(url, process.env.SUPERVISOR_PI_LIVE_MODEL || 'gpt-6.1-sol'));
}
