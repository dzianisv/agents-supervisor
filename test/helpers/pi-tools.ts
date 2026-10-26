// TEST ONLY host probes; no supervisor implementation or semantic claims.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export function installProbes(pi: any, config: any, root: string) {
  const log = (kind: string, data: any = {}) => appendFileSync(join(root, "hooks.jsonl"),
    JSON.stringify({ kind, time: Date.now(), ...data }) + "\n", { mode: 0o600 });
  const mark = (name: string, value: any = true) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  const branch = (ctx: any) => ({ sessionId: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(),
    entries: ctx.sessionManager.getBranch() });
  let epoch = 0, declared = false, held = false, auditCount = 0, commits = 0;
  let candidate: any;
  pi.on("input", (event: any, ctx: any) => {
    epoch++;
    log("input", { event, epoch, ...branch(ctx) });
    if (event.text === "consumed") return { action: "handled" };
    if (event.text === "transform-me") return { action: "transform", text: "transformed" };
  });
  pi.registerCommand("generated", { description: "TEST ONLY generated input", handler: async () => {
    pi.sendUserMessage("identical");
  } });
  for (const eventName of ["before_agent_start", "message_start", "message_end", "turn_end", "session_start",
    "session_before_tree", "session_tree", "session_before_compact", "session_compact", "session_shutdown"]) {
    pi.on(eventName, (event: any, ctx: any) => {
      log(eventName, { event, epoch, ...branch(ctx) });
      if (eventName === "session_before_tree" || eventName === "session_before_compact") epoch++;
      if (eventName === "session_before_compact" && config.customCompaction) {
        return { compaction: { summary: "TEST synthetic compaction", firstKeptEntryId: null,
          tokensBefore: event.preparation.tokensBefore } };
      }
    });
  }
  const parameters = Type.Object({ target: Type.Optional(Type.String()) });
  for (const name of ["effect", "declare", "nested"]) {
    pi.registerTool({ name, label: name, description: "TEST ONLY sandbox probe", parameters,
      async execute(id: string, args: any, _signal: any, _update: any, ctx: any) {
        log("execute", { name, id, args, declared });
        if (name === "declare") { declared = true; mark("declared"); }
        else if (name === "nested") {
          const result = await ctx.executeTool("effect", { target: args.target ?? "forbidden" });
          log("nested-outcome", { result });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } };
        } else {
          // Never accept arbitrary paths supplied by the fixture model.
          if (!["allowed", "forbidden", "unknown", "sibling", "mutated"].includes(args.target)) throw new Error("Bad fixture target");
          mark(`effect-${args.target}`);
        }
        return { content: [{ type: "text", text: `Executed ${name}` }], details: {},
          ...(config.successTerminates ? { terminate: true } : {}) };
      } });
  }
  if (config.earlierMutation) pi.on("tool_call", (event: any) => {
    if (event.toolName === "effect") event.input.target = "forbidden";
  });
  pi.on("tool_call", (event: any, ctx: any) => {
    log("gate", { event, declared, held, ...branch(ctx) });
    if (event.toolName !== "effect") return;
    if (config.declarationRace && !declared) return { block: true, reason: "Declaration has NOT executed; defer sibling" };
    if (held) return { block: true, reason: "Activity held" };
    if (event.input.target === "unknown") {
      if (config.holdAbort) {
        held = true;
        pi.sendMessage({ customType: "boundary-hold", content: "BOUNDARY HOLD: clarify the original target.", display: true }, { triggerTurn: false });
        // Print has no custom-message renderer. This explicit diagnostic is essential there.
        if (config.printDiagnostic && ctx.mode === "print") console.error("BOUNDARY HOLD: clarify the original target.");
        ctx.abort(); // Deliberately NOT awaited (ExtensionContext.abort(): void).
      }
      return { block: true, reason: "BOUNDARY HOLD: unknown evidence", terminate: true };
    }
    if (config.block !== false && event.input.target === "forbidden") return { block: true, reason: "BOUNDARY BLOCK: wrong target" };
  });
  if (config.laterMutation) pi.on("tool_call", (event: any) => {
    if (event.toolName === "effect") { event.input.target = "mutated"; log("later-mutator", { event }); }
  });
  pi.on("tool_result", (event: any) => { log("tool_result", { event }); });
  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    log("before-settle", { event, signalPresent: !!ctx.signal, pending: ctx.hasPendingMessages(), ...branch(ctx) });
    if (!config.audit || (config.auditFirstOnly && auditCount) || event.outcome !== "completed" || held) return;
    auditCount++;
    const stamp = { epoch, leaf: ctx.sessionManager.getLeafId(), sessionId: ctx.sessionManager.getSessionId() };
    mark("audit-start", stamp);
    // Real nested provider call on the current model/runtime, not a direct mocked audit handler.
    const verdict = await ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "TEST ONLY settlement audit", timestamp: Date.now() }] }, { maxTokens: 32 }).result();
    log("audit-return", { verdict, epoch, ...branch(ctx) });
    candidate = verdict.stopReason === "stop" ? stamp : undefined;
    mark("audit-returned");
  });
  let otherBoundaryCount = 0;
  if (config.otherDraft) pi.on("agent_before_settle", (event: any) => {
    if (otherBoundaryCount++) return;
    return { entries: [...event.entries,
      { type: "custom_message", customType: "other-boundary", content: "Other extension boundary draft", display: true }],
      continue: !!config.otherContinue };
  });
  pi.on("agent_settled", (event: any, ctx: any) => {
    const valid = candidate && !event.aborted && candidate.epoch === epoch &&
      candidate.leaf === ctx.sessionManager.getLeafId() && candidate.sessionId === ctx.sessionManager.getSessionId() && !ctx.hasPendingMessages();
    log("settled", { event, candidate, valid: !!valid, pending: ctx.hasPendingMessages(), epoch, ...branch(ctx) });
    candidate = undefined;
    if (valid) {
      // TEST ONLY irreversible markers stand in for the real lifecycle helper, which must be retested later.
      appendFileSync(join(root, "achievement.jsonl"), JSON.stringify({ commit: ++commits }) + "\n", { mode: 0o600 });
      if (existsSync(join(root, "project-goal"))) unlinkSync(join(root, "project-goal"));
      mark("committed", commits);
    }
    if (config.shutdownOnSettle) ctx.shutdown();
  });
  log("installed", { config });
}

export default function (pi: any) {
  installProbes(pi, JSON.parse(readFileSync(process.env.PI_BOUNDARY_CONFIG!, "utf8")), process.env.PI_BOUNDARY_ROOT!);
}
