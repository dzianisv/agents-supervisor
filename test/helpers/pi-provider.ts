// Deterministic, in-process LOCAL fixture. This is not semantic model validation.
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export function fixtureProvider(config: any, logPath: string) {
  let request = 0;
  return {
    api: "pi-boundary-fixture",
    baseUrl: "http://127.0.0.1:1/unused-in-process-fixture",
    apiKey: "fake-local-only",
    models: [{ id: "fixture", name: "Synthetic boundary fixture (NOT a real model)",
      reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any, options: any = {}) {
      const stream = createAssistantMessageEventStream();
      const ordinal = ++request;
      const step = config.responses[ordinal - 1];
      const record = (value: any) => appendFileSync(logPath, JSON.stringify(value) + "\n", { mode: 0o600 });
      record({ kind: "request", ordinal, model, messages: context.messages, maxTokens: options.maxTokens });
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "pending",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          if (!step) throw new Error(`Unexpected fixture provider request ${ordinal}`);
          const payload = { ordinal, messages: context.messages };
          await options.onPayload?.(payload, model);
          await options.onResponse?.({ status: 200, headers: new Headers() }, model);
          await options.onProviderStreamEvent?.({ fixture: ordinal }, model);
          stream.push({ type: "start", partial: message });
          // Labeled non-cooperative provider: the actual native stream reports
          // usage AFTER cancellation. Tests never fabricate usage journal entries.
          if (step.delayMs) await delay(step.delayMs, undefined, step.ignoreCancellation ? {} : { signal: options.signal });
          if (options.signal?.aborted && !step.ignoreCancellation) throw new Error("Fixture request aborted");
          if (step.error) throw new Error(step.error);
          for (const call of step.calls ?? []) {
            const index = message.content.length;
            const block = { type: "toolCall", id: call.id ?? `call-${ordinal}-${index}`, name: call.name, arguments: {} };
            message.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
            block.arguments = call.arguments ?? {};
            stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
          }
          if (step.text !== undefined) {
            const index = message.content.length;
            const block = { type: "text", text: "" };
            message.content.push(block);
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            block.text = step.text;
            stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
          }
          message.stopReason = step.stopReason ?? (step.calls?.length ? "toolUse" : "stop");
          record({ kind: "response", ordinal, message, signalAbortedAtCompletion: !!options.signal?.aborted,
            ignoredCancellation: !!step.ignoreCancellation });
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error: any) {
          message.stopReason = options.signal?.aborted ? "aborted" : "error";
          message.errorMessage = error.message;
          record({ kind: "response", ordinal, message });
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  };
}

export default function (pi: any) {
  const config = JSON.parse(readFileSync(process.env.PI_BOUNDARY_CONFIG!, "utf8"));
  pi.registerProvider("boundary-local", fixtureProvider(config, process.env.PI_BOUNDARY_REQUESTS!));
}
