// DETERMINISTIC LOCAL ACTOR/JUDGE FIXTURES ONLY. Not live semantic acceptance.
// Routing is based on the actual production prompt, never a production test flag.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureProvider } from "./pi-provider.ts";
import { installFixtureTools, installTailObserver } from "./pi-production-host.mjs";

export function requestText(messages: any[]) {
  return messages.filter(m => m.role !== "system").map(m => typeof m.content === "string" ? m.content :
    (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")).join("\n");
}
export function productionProvider(config: any, root: string) {
  const cursors: Record<string, number> = { actor: 0, focus: 0, settlement: 0, declaration: 0 };
  let selected: any;
  // The P1 stream implementation supplies real balanced native streams and cancellation.
  const responses = new Proxy([], { get(_target, key) { return /^\d+$/.test(String(key)) ? selected : undefined; } });
  const base = fixtureProvider({ responses }, join(root, "requests.jsonl"));
  return { ...base, streamSimple(model: any, context: any, options: any = {}) {
    const prompt = requestText(context.messages);
    const actionsText = prompt.match(/<untrusted_actions>([\s\S]*?)<\/untrusted_actions>/)?.[1];
    // Only audit requests carry these production rubric markers. Actor history may
    // contain a quoted feedback message, so do not route on the word 'supervisor'.
    const kind = actionsText && prompt.includes("<declaration_check>") ? "declaration" : actionsText ? "focus"
      : /SELF-ASSESS SUPERVISOR|ANALYZE SUPERVISOR|You are evaluating an agent's work against workflow requirements/.test(prompt)
        ? "settlement" : "actor";
    const index = cursors[kind]++;
    const fixture = config[kind]?.[index];
    appendFileSync(join(root, "routes.jsonl"), JSON.stringify({ kind, index, prompt, model: model.id,
      provider: model.provider, maxTokens: options.maxTokens, time: Date.now() }) + "\n", { mode: 0o600 });
    if (!fixture) {
      appendFileSync(join(root, "fixture-errors.jsonl"), JSON.stringify({ kind, index }) + "\n", { mode: 0o600 });
      selected = { error: `UNPLANNED deterministic ${kind} request ${index}` };
    } else if (kind === "focus" || kind === "declaration") {
      const actions = JSON.parse(actionsText!);
      if (!Array.isArray(actions) || !actions.length || actions.some(a => !a.hash || !a.toolName)) throw new Error("Production action prompt schema changed");
      const decisions = actions.map((a: any, i: number) => {
        // Expectations are per fixture call/tool/target, not a second policy engine.
        const key = `${a.toolName}:${a.input?.target ?? a.input?.path ?? ""}`;
        const decision = fixture.byAction?.[key] ?? fixture.decisions?.[i] ?? fixture.decision;
        if (!["allow", "redirect", "hold"].includes(decision)) throw new Error(`Missing frozen decision for ${key}`);
        return { actionHash: a.hash, decision, reason: decision === "allow" ? "FIXTURE: prerequisite for tenant-current report."
          : decision === "redirect" ? "FIXTURE: original request targets tenant-current, not the substitute action."
            : "FIXTURE: target evidence is unknown; operator clarification is needed.", observationIds: [],
          ...(decision !== "allow" ? { nextStep: "Inspect tenant-current and produce report.json; clarify unknown target first." } : {}) };
      });
      selected = { ...fixture, text: fixture.raw ?? JSON.stringify({ decisions }) };
    } else selected = fixture;
    if (kind !== "actor") {
      writeFileSync(join(root, `${kind}-start`), JSON.stringify({ index, time: Date.now() }), { mode: 0o600 });
      // PTY compatibility marker indicates the REAL production settlement request.
      if (kind === "settlement") writeFileSync(join(root, "audit-start"), "production judge pending", { mode: 0o600 });
    }
    const stream = base.streamSimple(model, context, options);
    if (kind === "settlement") void stream.result().then(() => writeFileSync(join(root, "audit-returned"), "returned", { mode: 0o600 }));
    return stream;
  } };
}
export function installProductionFixture(pi: any, config: any, root: string) {
  pi.registerProvider("production-local", productionProvider(config, root));
  installFixtureTools(pi, config, root);
}
export default function(pi: any) {
  const root = process.env.PI_BOUNDARY_ROOT!;
  const config = JSON.parse(readFileSync(process.env.PI_BOUNDARY_CONFIG!, "utf8"));
  installProductionFixture(pi, config, root);
}
// Imported by a separate, explicitly loaded last observer extension for CLI runs.
export { installTailObserver };
