import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { goalStore } from "./core/goal.mjs"

const DEFAULT_MODEL = process.env.SUPERVISOR_MODEL ?? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
const MAX_ATTEMPTS = Number(process.env.SUPERVISOR_MAX_ATTEMPTS ?? 8)
const CONTINUATION = "Continue working toward the active goal. Do not stop until the goal is met or you are blocked."

function modelSpec(spec: string) {
  const slash = spec.indexOf("/")
  if (slash < 0) return undefined
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) }
}

function attemptsFile(directory: string, sessionID: string) {
  return join(directory, ".supervisor", "sessions", `${sessionID}.v2-attempts.json`)
}

function readAttempts(directory: string, sessionID: string, condition: string): number {
  try {
    const data = JSON.parse(readFileSync(attemptsFile(directory, sessionID), "utf8"))
    return data?.condition === condition ? Number(data.count ?? 0) : 0
  } catch {
    return 0
  }
}

function writeAttempts(directory: string, sessionID: string, condition: string, count: number) {
  try {
    const file = attemptsFile(directory, sessionID)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ condition, count }), { mode: 0o600 })
  } catch {}
}

function clearAttempts(directory: string, sessionID: string) {
  try {
    unlinkSync(attemptsFile(directory, sessionID))
  } catch {}
}

function transcript(items: any[]) {
  const lines: string[] = []
  for (const item of items ?? []) {
    if (item?.type === "user" && typeof item.text === "string") lines.push(`User: ${item.text.slice(0, 1200)}`)
    if (item?.type === "assistant") {
      const text = (item.content ?? [])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join(" ")
      if (text.trim()) lines.push(`Assistant: ${text.slice(0, 1200)}`)
    }
  }
  return lines.slice(-10).join("\n").slice(-6000)
}

function judgePrompt(condition: string, body: string) {
  return `You decide whether a coding session met its active goal.

GOAL: ${condition}

Answer with exactly one line:
DONE - <evidence from the transcript>
CONTINUE - <the single most important remaining step>

Judge only against the goal condition. Do not accept a claim without evidence in the transcript.

TRANSCRIPT:
${body}`
}

/** Goal supervisor for opencode v2: sets a goal, judges each finished turn, and pushes the agent until it is met. */
export default {
  id: "goal-supervisor",
  async setup(ctx: any) {
    const directory = ctx.location?.directory ?? process.cwd()
    const model = modelSpec(DEFAULT_MODEL)

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "supervisor_goal",
        description: "Set, show or clear the goal this session must finish. The supervisor judges every finished turn against it and continues the agent until it is met.",
        input: {
          type: "object",
          properties: {
            condition: { type: "string", description: "Observable condition that means the work is finished" },
            clear: { type: "boolean", description: "Remove the active goal" },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          if (input?.clear) {
            goalStore.clearGoal(directory, context.sessionID)
            return { content: "Goal cleared." }
          }
          const condition = String(input?.condition ?? "").trim()
          if (!condition) {
            const state = goalStore.load(directory, context.sessionID)
            return { content: state?.goal ? `Goal: ${state.goal.condition}` : "No active goal." }
          }
          goalStore.setGoal(directory, context.sessionID, condition, { source: "user" })
          return { content: `Goal set: ${condition}` }
        },
      })
    })

    await ctx.session.hook("context", (event: any) => {
      const state = goalStore.load(directory, event.sessionID)
      const goal = state?.goal
      if (!goal || goal.status !== "active") return
      event.system.push({
        type: "text",
        text: `<goal>\n${goal.condition}\n</goal>\nFinish this goal; do not stop before it is met.`,
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sessionID = event?.data?.sessionID
        if (typeof sessionID !== "string") continue
        const finished =
          event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
        if (!finished) continue
        const state = goalStore.load(directory, sessionID)
        const goal = state?.goal
        if (!goal || goal.status !== "active") continue
        const attempts = readAttempts(directory, sessionID, goal.condition)
        if (attempts >= MAX_ATTEMPTS) continue

        let verdict = ""
        try {
          const body = transcript(await ctx.session.context({ sessionID }))
          const result = await ctx.experimental.generate.text(
            { model, prompt: judgePrompt(goal.condition, body) },
            { signal: controller.signal },
          )
          verdict = String(result?.text ?? "").trim()
        } catch {
          continue
        }

        const line = verdict.split("\n").find((l: string) => /^(DONE|CONTINUE)\b/i.test(l.trim()))?.trim() ?? ""
        if (/^DONE\b/i.test(line)) {
          goalStore.completeGoal(directory, sessionID, { expectedGoal: goal, reason: line })
          clearAttempts(directory, sessionID)
          continue
        }
        writeAttempts(directory, sessionID, goal.condition, attempts + 1)
        await ctx.session.prompt({
          sessionID,
          text: line ? `${CONTINUATION}\n\nJudge note: ${line}` : CONTINUATION,
        })
      }
    })()

    return () => controller.abort()
  },
}
