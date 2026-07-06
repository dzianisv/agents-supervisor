/**
 * Supervisor Plugin for OpenCode
 *
 * Consolidated supervisor layer that combines self-assessment with workflow checks.
 * Uses a dynamic prompt (task + workflow requirements) unless supervisor.md overrides it.
 * Ensures tests/build/PR/CI checks are verified before completion.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir, stat, appendFile, readdir, chmod } from "fs/promises"
import { join, dirname } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"
import { execFile } from "child_process"
// Shared goal-loop DECISION logic — single source of truth across runtimes.
// (The per-session store stays runtime-specific: async fs here, sync in core for CC.)
import {
  resolveMaxAttempts, parseSupervisorCommand, buildGoalRequirementSection,
  decideGoalTransition, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_GOAL_DURATION_MS,
  resolveSupervisorMode, DEFAULT_SUPERVISOR_MODE,
  extractGoalCondition, writeProjectGoal,
} from "../core/goal.mjs"
import {
  isBlockedJudgeModel, parseModelSpec, getGitHubCopilotModelForRouting,
  getCrossReviewModelSpec, getLastSessionModelSpec,
} from "../core/model-selection.mjs"
import {
  SELF_ASSESSMENT_MARKER, FEEDBACK_MARKER, inferTaskType, extractToolCommands,
  detectSignals, normalizeCommand, getRecentCommands, hasLocalTestCommand,
  pushedToDefaultBranch, detectPlanningLoop, shouldApplyPlanningLoop,
  detectActionLoop, evaluateSelfAssessment, isPlanMode, isHumanOnlyAction,
  splitActionItems, HUMAN_ONLY_ACTION_PATTERNS, AGENT_ACTION_PATTERNS,
} from "../core/evaluation.mjs"
import {
  DEFAULT_RUBRIC, parseRubric, buildSelfAssessmentPrompt, buildJudgePrompt,
  parseSelfAssessmentJson,
} from "../core/assessment.mjs"
import { buildEscalatingFeedback } from "../core/feedback.mjs"
export { resolveMaxAttempts, parseSupervisorCommand, buildGoalRequirementSection, decideGoalTransition, resolveSupervisorMode, DEFAULT_SUPERVISOR_MODE }
export { isBlockedJudgeModel, parseModelSpec, getGitHubCopilotModelForRouting, getCrossReviewModelSpec, getRoutingModel, classifyTaskForRoutingWithLLM }
export {
  detectPlanningLoop, shouldApplyPlanningLoop, detectActionLoop, buildEscalatingFeedback,
  getLastSessionModelSpec, isPlanMode, buildSelfAssessmentPrompt, buildJudgePrompt,
  DEFAULT_RUBRIC, parseRubric,
}

// Lazy Sentry helper — reports errors without crashing if @sentry/node is unavailable
async function reportError(err: unknown, context?: Record<string, string>): Promise<void> {
  try {
    const Sentry = await import("@sentry/node")
    if (!Sentry.isInitialized()) return
    Sentry.captureException(err, context ? { tags: context } : undefined)
  } catch {}
}

/**
 * Read the top-level `maxAttempts:` integer from ~/.config/opencode/supervisor.yaml.
 * Returns undefined if the file is missing, the key is absent, or the value is invalid.
 */
async function loadConfiguredMaxAttempts(): Promise<number | undefined> {
  try {
    const content = await readFile(SUPERVISOR_CONFIG_PATH, "utf-8")
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith("#")) continue
      const match = line.match(/^maxAttempts\s*:\s*(\S+)/)
      if (match) {
        const raw = match[1].trim()
        if (/^\d+$/.test(raw)) {
          const value = parseInt(raw, 10)
          if (Number.isFinite(value)) return value
        }
      }
    }
  } catch {}
  return undefined
}

// ---------------------------------------------------------------------------
// Supervisor per-session persistence (supervisorStore)
//
// Stores goal + retry state at <directory>/.supervisor/goals/<sessionId>.json
// so supervisor decisions survive across tool invocations within a session.
// ---------------------------------------------------------------------------

export interface SupervisorGoal {
  condition: string
  status: "active" | "paused" | "achieved" | "cleared" | "exhausted"
  attempts: number
  tokenBaseline: number
  startedAt: number
  deadline: number
  lastReason: string
}

export type SupervisorMode = "autopilot" | "goal" | "reflection"

export interface SupervisorState {
  maxAttempts?: number       // /supervisor:retry override (optional)
  goal?: SupervisorGoal
  mode?: SupervisorMode
  autopilot?: boolean        // autopilot mode: skip judge, always continue
  autoreview?: boolean       // cross-model review: gate behind explicit opt-in
}

function supervisorDir(directory: string): string {
  return join(directory, ".supervisor", "goals")
}

/** Guard against path-traversal attacks via a malformed sessionId. */
function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    throw new Error(`Invalid sessionId: ${JSON.stringify(sessionId)}`)
  }
}

function supervisorPath(directory: string, sessionId: string): string {
  return join(supervisorDir(directory), `${sessionId}.json`)
}

export const supervisorStore = {
  async load(directory: string, sessionId: string): Promise<SupervisorState> {
    try {
      const content = await readFile(supervisorPath(directory, sessionId), "utf-8")
      return JSON.parse(content) as SupervisorState
    } catch {
      return {}
    }
  },

  async save(directory: string, sessionId: string, state: SupervisorState): Promise<void> {
    assertSafeSessionId(sessionId)
    const dir = supervisorDir(directory)
    await mkdir(dir, { recursive: true })
    const filePath = supervisorPath(directory, sessionId)
    await writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 })
    await chmod(filePath, 0o600)
  },

  async setGoal(
    directory: string,
    sessionId: string,
    condition: string,
    opts?: { tokenBaseline?: number; now?: number; maxDurationMs?: number }
  ): Promise<SupervisorState> {
    const state = await supervisorStore.load(directory, sessionId)
    const now = opts?.now ?? Date.now()
    const maxDurationMs = opts?.maxDurationMs ?? DEFAULT_MAX_GOAL_DURATION_MS
    state.goal = {
      condition,
      status: "active",
      attempts: 0,
      tokenBaseline: opts?.tokenBaseline ?? 0,
      startedAt: now,
      deadline: now + maxDurationMs,
      lastReason: "",
    }
    state.mode = "goal"
    state.autopilot = false
    await supervisorStore.save(directory, sessionId, state)
    return state
  },

  async clearGoal(directory: string, sessionId: string): Promise<SupervisorState> {
    const state = await supervisorStore.load(directory, sessionId)
    delete state.goal
    state.mode = DEFAULT_SUPERVISOR_MODE
    state.autopilot = false
    await supervisorStore.save(directory, sessionId, state)
    return state
  },

  async setMode(directory: string, sessionId: string, mode: SupervisorMode): Promise<SupervisorState> {
    const state = await supervisorStore.load(directory, sessionId)
    state.mode = mode
    state.autopilot = mode === "autopilot"
    if (mode !== "goal") delete state.goal
    await supervisorStore.save(directory, sessionId, state)
    return state
  },

  async setRetry(directory: string, sessionId: string, n: number): Promise<SupervisorState> {
    const state = await supervisorStore.load(directory, sessionId)
    state.maxAttempts = n
    await supervisorStore.save(directory, sessionId, state)
    return state
  },

  async setAutopilot(directory: string, sessionId: string, enabled: boolean): Promise<SupervisorState> {
    return supervisorStore.setMode(directory, sessionId, enabled ? "autopilot" : DEFAULT_SUPERVISOR_MODE)
  },

  async setAutoreview(directory: string, sessionId: string, enabled: boolean): Promise<SupervisorState> {
    const state = await supervisorStore.load(directory, sessionId)
    state.autoreview = enabled
    await supervisorStore.save(directory, sessionId, state)
    return state
  },

  async list(directory: string): Promise<string[]> {
    try {
      const dir = supervisorDir(directory)
      const entries = await readdir(dir, { withFileTypes: true })
      // Build result in a local array to ensure consistent realm in ESM environments
      const ids: string[] = []
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".json")) ids.push(e.name.slice(0, -".json".length))
      }
      return ids
    } catch {
      return []
    }
  },
}

// ---------------------------------------------------------------------------
// parseSupervisorCommand — pure parser for /supervisor:* command names
//
// Maps a command name + its argument string to a discriminated action.
// No I/O. Safe to call from any context.
// ---------------------------------------------------------------------------

// parseSupervisorCommand now imported from ../core/goal.mjs (shared).

// ---------------------------------------------------------------------------
// buildGoalRequirementSection — prompt fragment for active session goals
//
// Appended to the judge/self-assessment rubric when a goal is active. Pure,
// no I/O. Returns an empty string for blank conditions (caller should skip
// appending in that case).
// ---------------------------------------------------------------------------

// buildGoalRequirementSection now imported from ../core/goal.mjs (shared).

// extractGoalCondition now imported from ../core/goal.mjs (shared — was
// duplicated here and in buildReflectionPromptFromFiles below + bin/on-stop.mjs).

// ---------------------------------------------------------------------------
// decideGoalTransition — pure decision for an active session goal
//
// Given the current goal, the judge's verdict, and the budget, decide the next
// goal state. No I/O; returns a NEW goal object (never mutates the input).
// Applied in strict order: budget exhaustion FIRST (attempts cap or deadline),
// then achievement, then continuation (which increments attempts).
// ---------------------------------------------------------------------------

// decideGoalTransition now imported from ../core/goal.mjs (shared decision logic).

// ---------------------------------------------------------------------------
// Supervisor rubric (configurable patterns/antipatterns)
//
// The judge's positive completion rules ("Patterns") and the mined
// premature-stop rules ("Antipatterns") were historically hardcoded inline in
// two prompt builders. They now live in this single embedded default, which
// users can override with a rubric.md file (see loadRubric). The embedded
// default keeps the single-file `cp supervisor-3.ts` install working.
// ---------------------------------------------------------------------------

export interface Rubric {
  patterns: string
  antipatterns: string
}

/**
 * Load the active rubric for a project. Precedence (first complete one wins):
 *   1. project: <directory>/.supervisor/rubric.md      → source "project"
 *   2. global:  ~/.config/opencode/supervisor/rubric.md → source "global"
 *   3. embedded DEFAULT_RUBRIC                           → source "default"
 * An override missing either section falls through to the next source, so the
 * judge never runs with an empty rubric.
 */
export async function loadRubric(
  directory: string
): Promise<Rubric & { source: "project" | "global" | "default" }> {
  const candidates: Array<{ path: string; source: "project" | "global" }> = [
    { path: join(directory, ".supervisor", "rubric.md"), source: "project" },
    { path: join(homedir(), ".config", "opencode", "supervisor", "rubric.md"), source: "global" },
  ]
  for (const { path, source } of candidates) {
    try {
      const md = await readFile(path, "utf-8")
      const r = parseRubric(md)
      if (r.patterns && r.antipatterns) return { ...r, source }
    } catch {
      /* not present / unreadable — try next */
    }
  }
  return { ...parseRubric(DEFAULT_RUBRIC), source: "default" }
}

type TaskType = "coding" | "docs" | "research" | "ops" | "other"
type AgentMode = "plan" | "build" | "unknown"
type RoutingCategory = "backend" | "architecture" | "frontend" | "default"

interface WorkflowRequirements {
  requiresTests: boolean
  requiresBuild: boolean
  requiresPR: boolean
  requiresCI: boolean
  requiresLocalTests: boolean
  requiresLocalTestsEvidence: boolean
}

interface TaskContext extends WorkflowRequirements {
  taskSummary: string
  taskType: TaskType
  agentMode: AgentMode
  humanMessages: string[]
  toolsSummary: string
  detectedSignals: string[]
  recentCommands: string[]
  pushedToDefaultBranch: boolean
}

interface SelfAssessment {
  task_summary?: string
  task_type?: string
  status?: "complete" | "in_progress" | "blocked" | "stuck" | "waiting_for_user"
  confidence?: number
  evidence?: {
    tests?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
      ran_after_changes?: boolean
      commands?: string[]
      skipped?: boolean
      skip_reason?: string
    }
    build?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
    }
    pr?: {
      created?: boolean
      url?: string
      ci_status?: "pass" | "fail" | "unknown"
      checked?: boolean
    }
  }
  remaining_work?: string[]
  next_steps?: string[]
  needs_user_action?: string[]
  stuck?: boolean
  alternate_approach?: string
}

interface SupervisorAnalysis {
  complete: boolean
  shouldContinue: boolean
  reason: string
  missing: string[]
  nextActions: string[]
  requiresHumanAction: boolean
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
}

interface RoutingConfig {
  enabled: boolean
  models: Record<RoutingCategory, string>
}

const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false,
  models: {
    backend: "",
    architecture: "",
    frontend: "",
    default: ""
  }
}

const JUDGE_RESPONSE_TIMEOUT = 120_000
const POLL_INTERVAL = 2_000
const ABORT_COOLDOWN = 10_000
const ABORT_RACE_DELAY = 1_500 // ms to wait for session.error to arrive before running supervisor
const SUPERVISOR_CONFIG_PATH = join(homedir(), ".config", "opencode", "supervisor.yaml")
// Last-resort fallback when no model is configured. Uses a free opencode model
// to avoid silently routing judge sessions to OpenAI (which requires a paid API key).
const JUDGE_FREE_FALLBACK = "opencode/deepseek-v4-flash-free"
const SESSION_SCOPED_TOOLS = new Set(["supervisor", "supervisor_goal", "supervisor_retry", "supervisor_autopilot", "autopilot_exit", "set_supervisor"])

export function trackSessionScopedToolSession(
  currentSessionId: string | null,
  input: { tool?: string; sessionID?: string }
): string | null {
  if (input.sessionID && input.tool && SESSION_SCOPED_TOOLS.has(input.tool)) {
    return input.sessionID
  }
  return currentSessionId
}

// Debug logging — writes to .supervisor/debug.log when SUPERVISOR_DEBUG=1.
// Never write to stdout/stderr — it corrupts the OpenCode TUI.
const SUPERVISOR_DEBUG = process.env.SUPERVISOR_DEBUG === "1"

// Module-level debug function, initially a no-op.
// Replaced with a file-backed logger once the plugin initializes with a directory.
let debug: (...args: any[]) => void = () => {}

function initDebugLogger(directory: string) {
  if (!SUPERVISOR_DEBUG) return
  const logPath = join(directory, ".supervisor", "debug.log")
  let dirEnsured = false
  debug = (...args: any[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    const ts = new Date().toISOString()
    const line = `[${ts}] [Supervisor] ${msg}\n`
    // Fire-and-forget: do not await to avoid slowing down the plugin
    ;(async () => {
      if (!dirEnsured) {
        try { await mkdir(join(directory, ".supervisor"), { recursive: true }) } catch {}
        dirEnsured = true
      }
      try { await appendFile(logPath, line) } catch {}
    })()
  }
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
}

async function loadPreferredModelSpec(directory: string): Promise<string | null> {
  const candidates = [
    join(directory, "opencode.json"),
    join(directory, ".opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf-8")
      const parsed = JSON.parse(stripJsonComments(content))
      const model = parsed?.model
      if (typeof model === "string" && model.trim()) {
        return model.trim()
      }
    } catch {}
  }
  return null
}

async function loadSupervisorPrompt(directory: string): Promise<string | null> {
  const candidates = [".supervisor.md", ".supervisor.MD", "supervisor.md", "supervisor.MD"]
  for (const name of candidates) {
    try {
      const supervisorPath = join(directory, name)
      const customPrompt = await readFile(supervisorPath, "utf-8")
      debug("Loaded custom prompt from", name)
      return customPrompt.trim()
    } catch {}
  }
  return null
}

function buildToolSupervisorGuidanceSection(toolSupervisorPrompt: string | null): string {
  if (!toolSupervisorPrompt) return ""
  return `\n## Tool Supervisor Guidance\n${toolSupervisorPrompt.slice(0, 4000)}\n`
}

function resolveSupervisorPromptPrecedence(
  filePrompt: string | null,
  toolSupervisorPrompt: string | null,
  defaultPrompt: string
): { prompt: string; source: "file" | "tool" | "default"; effectiveToolSupervisorPrompt: string | null } {
  if (filePrompt) {
    return {
      prompt: filePrompt,
      source: "file",
      effectiveToolSupervisorPrompt: null
    }
  }
  if (toolSupervisorPrompt) {
    return {
      prompt: `${defaultPrompt}${buildToolSupervisorGuidanceSection(toolSupervisorPrompt)}`,
      source: "tool",
      effectiveToolSupervisorPrompt: toolSupervisorPrompt
    }
  }
  return {
    prompt: defaultPrompt,
    source: "default",
    effectiveToolSupervisorPrompt: null
  }
}

async function getAgentsFile(directory: string): Promise<string> {
  for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
    try {
      const content = await readFile(join(directory, name), "utf-8")
      return content
    } catch {}
  }
  return ""
}

function getMessageSignature(msg: any): string {
  if (msg.id) return msg.id
  const role = msg.info?.role || "unknown"
  const time = msg.info?.time?.start || 0
  const textPart = msg.parts?.find((p: any) => p.type === "text")?.text?.slice(0, 20) || ""
  return `${role}:${time}:${textPart}`
}

function getLastRelevantUserMessageId(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user") {
      let isSupervisor = false
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) {
            isSupervisor = true
            break
          }
        }
      }
      if (!isSupervisor) return getMessageSignature(msg)
    }
  }
  return null
}

function isJudgeSession(sessionId: string, messages: any[], judgeSessionIds: Set<string>): boolean {
  if (judgeSessionIds.has(sessionId)) return true
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && (part.text?.includes("ANALYZE SUPERVISOR") || part.text?.includes("SELF-ASSESS SUPERVISOR") || part.text?.includes("REVIEW SUPERVISOR COMPLETION"))) {
        return true
      }
    }
  }
  return false
}

async function showToast(client: any, directory: string, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  try {
    await client.tui.publish({
      query: { directory },
      body: {
        type: "tui.toast.show",
        properties: { title: "Supervisor", message, variant, duration: 5000 }
      }
    })
  } catch {}
}

function parseModelListFromYaml(content: string): string[] {
  const models: string[] = []
  const lines = content.split(/\r?\n/)
  let inModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^models\s*:/i.test(line)) {
      inModels = true
      const inline = line.replace(/^models\s*:/i, "").trim()
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const items = inline.slice(1, -1).split(",")
        for (const item of items) {
          const value = item.trim().replace(/^['"]|['"]$/g, "")
          if (value) models.push(value)
        }
        inModels = false
      }
      continue
    }

    if (inModels) {
      if (/^[\w-]+\s*:/.test(line)) {
        inModels = false
        continue
      }
      if (line.startsWith("-")) {
        const value = line.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "")
        if (value) models.push(value)
      }
    }
  }

  return models
}

function parseRoutingFromYaml(content: string): RoutingConfig {
  const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  const lines = content.split(/\r?\n/)
  let inRouting = false
  let inRoutingModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^routing\s*:/i.test(line)) {
      inRouting = true
      continue
    }

    if (inRouting) {
      // Exit routing section when we hit a top-level key
      if (/^[a-zA-Z][\w-]*\s*:/.test(rawLine) && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        inRouting = false
        inRoutingModels = false
        continue
      }

      if (/^\s*enabled\s*:\s*(true|false)/i.test(rawLine)) {
        config.enabled = /true/i.test(rawLine)
        continue
      }

      if (/^\s*models\s*:/i.test(rawLine)) {
        inRoutingModels = true
        continue
      }

      if (inRoutingModels) {
        // Exit models sub-section on a non-indented or non-model key
        if (/^\s{2,}[\w-]+\s*:/.test(rawLine) || /^\s+[\w-]+\s*:/.test(rawLine)) {
          const match = rawLine.match(/^\s+([\w-]+)\s*:\s*(.*)/)
          if (match) {
            const key = match[1].toLowerCase() as RoutingCategory
            const value = match[2].trim().replace(/^['"]|['"]$/g, "")
            if (key === "backend" || key === "architecture" || key === "frontend" || key === "default") {
              config.models[key] = value
            }
          }
        }
      }
    }
  }

  return config
}


function parseRoutingCategory(text: string | null | undefined): RoutingCategory | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { category?: string }
      const value = (parsed.category || "").toLowerCase()
      if (value === "backend" || value === "architecture" || value === "frontend" || value === "default") {
        return value
      }
    } catch {}
  }
  const word = trimmed.split(/\s+/)[0]?.toLowerCase()
  if (word === "backend" || word === "architecture" || word === "frontend" || word === "default") {
    return word
  }
  return null
}

async function classifyTaskForRoutingWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  judgeSessionIds: Set<string>,
  sessionMessages?: any[],
  opts?: { routingEnabled?: boolean }
): Promise<RoutingCategory | null> {
  // Gate: skip entire classification when routing is disabled — saves tokens
  if (opts?.routingEnabled === false) return null

  const modelList = await loadSupervisorModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  const sessionModelSpec = getLastSessionModelSpec(sessionMessages || [])

  let attempts: string[] = []
  if (modelList.length) {
    attempts = modelList
  } else if (preferredModel) {
    const routingModel = getGitHubCopilotModelForRouting(preferredModel)
    if (routingModel && !isBlockedJudgeModel(routingModel)) {
      attempts = [routingModel]
    } else if (!isBlockedJudgeModel(preferredModel)) {
      attempts = [preferredModel]
    }
  }
  if (attempts.length === 0) {
    attempts = sessionModelSpec && !isBlockedJudgeModel(sessionModelSpec) ? [sessionModelSpec] : [JUDGE_FREE_FALLBACK]
  }

  const prompt = `CLASSIFY TASK ROUTING\n\nYou are classifying a task into one routing category.\n\nTask summary:\n${context.taskSummary}\n\nTask type: ${context.taskType}\n\nRecent user messages:\n${context.humanMessages.slice(0, 4).join("\n\n")}\n\nChoose exactly one category from: backend, architecture, frontend, default.\nReturn JSON only:\n{\n  "category": "backend|architecture|frontend|default"\n}`

  for (const modelSpec of attempts) {
    let classifierSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      classifierSession = data
    } catch {
      return null
    }
    if (!classifierSession?.id) return null
    judgeSessionIds.add(classifierSession.id)

    let response: string | null = null
    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""
      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: classifierSession.id },
        body
      })

      response = await waitForResponse(client, classifierSession.id)
    } catch (e) {
      reportError(e, { plugin: "supervisor-3", op: "routing-classifier" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: classifierSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(classifierSession.id)
    }

    const category = parseRoutingCategory(response)
    if (category) return category
  }

  return null
}

async function loadRoutingConfig(): Promise<RoutingConfig> {
  try {
    const content = await readFile(SUPERVISOR_CONFIG_PATH, "utf-8")
    return parseRoutingFromYaml(content)
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  }
}

function getRoutingModel(config: RoutingConfig, category: RoutingCategory | null): { providerID: string; modelID: string } | null {
  if (!category) return null
  if (!config.enabled) return null
  const modelSpec = config.models[category] || config.models["default"] || ""
  if (!modelSpec) return null
  const parts = modelSpec.split("/")
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

async function loadSupervisorModelList(): Promise<string[]> {
  try {
    const content = await readFile(SUPERVISOR_CONFIG_PATH, "utf-8")
    const models = parseModelListFromYaml(content)
    const filtered = models.filter((model) => {
      if (isBlockedJudgeModel(model)) {
        debug("Blocked weak supervisor model:", model)
        return false
      }
      return true
    })
    if (filtered.length) debug("Loaded supervisor model list:", JSON.stringify(filtered))
    return filtered
  } catch {
    return []
  }
}

async function ensureSupervisorDir(directory: string): Promise<string> {
  const supervisorDir = join(directory, ".supervisor")
  try {
    await mkdir(supervisorDir, { recursive: true })
  } catch {}
  return supervisorDir
}

async function writeVerdictSignal(directory: string, sessionId: string, complete: boolean, severity: string): Promise<void> {
  const supervisorDir = await ensureSupervisorDir(directory)
  const signalPath = join(supervisorDir, `verdict_${sessionId.slice(0, 8)}.json`)
  const signal = {
    sessionId: sessionId.slice(0, 8),
    complete,
    severity,
    timestamp: Date.now()
  }
  try {
    await writeFile(signalPath, JSON.stringify(signal))
    debug("Wrote verdict signal:", signalPath)
  } catch (e) {
    debug("Failed to write verdict signal:", String(e))
    reportError(e, { plugin: "supervisor-3", op: "write-verdict-signal" })
  }
}

async function saveSupervisorData(directory: string, sessionId: string, data: any): Promise<void> {
  const supervisorDir = await ensureSupervisorDir(directory)
  const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
  const filepath = join(supervisorDir, filename)
  try {
    await writeFile(filepath, JSON.stringify(data, null, 2))
  } catch {}
}

async function waitForResponse(client: any, sessionId: string): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    try {
      const { data } = await client.session.messages({ path: { id: sessionId } })
      const messages = Array.isArray(data) ? data : []
      const assistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
      if (!(assistantMsg?.info?.time as any)?.completed) continue
      for (const part of assistantMsg?.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    } catch {}
  }
  return null
}

async function hasPath(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function getRepoSignals(directory: string): Promise<{ hasTestScript: boolean; hasBuildScript: boolean; hasTestsDir: boolean }>{
  let hasTestScript = false
  let hasBuildScript = false
  const packagePath = join(directory, "package.json")
  try {
    const content = await readFile(packagePath, "utf-8")
    const pkg = JSON.parse(content)
    const scripts = pkg?.scripts || {}
    hasTestScript = Boolean(scripts.test || scripts["test:ci"] || scripts["test:e2e"])
    hasBuildScript = Boolean(scripts.build || scripts["build:prod"])
  } catch {}

  const hasTestsDir = (await hasPath(join(directory, "test"))) || (await hasPath(join(directory, "tests")))
  return { hasTestScript, hasBuildScript, hasTestsDir }
}

async function buildTaskContext(messages: any[], directory: string): Promise<TaskContext | null> {
  if (!Array.isArray(messages)) return null
  const humanMessages: string[] = []
  let lastAssistantText = ""

  for (const msg of messages) {
    if (msg.info?.role === "user") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) continue
          humanMessages.push(part.text)
          break
        }
      }
    }
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          lastAssistantText = part.text
        }
      }
    }
  }

  if (humanMessages.length === 0) return null

  const taskSummary = humanMessages.length === 1
    ? humanMessages[0]
    : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")

  const combinedText = `${humanMessages.join(" ")} ${lastAssistantText}`
  const taskType = inferTaskType(combinedText)
  const agentMode: AgentMode = isPlanMode(messages) ? "plan" : "build"

  const repoSignals = await getRepoSignals(directory)
  const commands = extractToolCommands(messages)
  const detectedSignals = detectSignals(combinedText, commands)
  const recentCommands = getRecentCommands(commands)
  const hasLocalTests = hasLocalTestCommand(commands)
  const pushedDefault = pushedToDefaultBranch(commands)

  const requiresTests = taskType === "coding" && (repoSignals.hasTestScript || repoSignals.hasTestsDir || detectedSignals.includes("test-mention"))
  const requiresBuild = taskType === "coding" && (repoSignals.hasBuildScript || detectedSignals.includes("build-mention"))
  // PR and CI are only required for coding tasks; ops/personal-assistant tasks don't need them
  const requiresPR = taskType === "coding"
  const requiresCI = taskType === "coding"
  const requiresLocalTests = requiresTests
  const requiresLocalTestsEvidence = requiresTests && !hasLocalTests

  const toolsSummary = commands.slice(-6).join("\n") || "(none)"

  return {
    taskSummary,
    taskType,
    agentMode,
    humanMessages,
    toolsSummary,
    detectedSignals,
    recentCommands,
    pushedToDefaultBranch: pushedDefault,
    requiresTests,
    requiresBuild,
    requiresPR,
    requiresCI,
    requiresLocalTests,
    requiresLocalTestsEvidence
  }
}

function extractLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    }
  }
  return ""
}

/**
 * Interpolate a simple mustache-like template:
 * - {{variable}} → replaced with value
 * - {{#section}}...{{/section}} → included only if variable is truthy
 */
function interpolateTemplate(template: string, vars: Record<string, string | undefined>): string {
  // Handle conditional sections: {{#key}}...{{/key}}
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, content: string) => {
      const value = vars[key]
      if (!value) return ""
      // Within the section, also interpolate variables
      return content.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => vars[k] ?? "")
    }
  )
  // Handle remaining simple variables
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "")
  return result
}

/**
 * Build the reflection prompt by reading 3 external files and interpolating:
 *   1. .agents/supervisor/SystemPrompt.md — template with {{variable}} placeholders
 *   2. .agents/supervisor/Patterns.md — patterns & antipatterns
 *   3. .agents/supervisor/User.md — user-editable overrides
 *
 * Falls back to embedded defaults (buildSelfAssessmentPrompt equivalent) if files
 * are missing, so the plugin works without the files on disk.
 */
async function buildReflectionPromptFromFiles(
  directory: string,
  context: TaskContext,
  agents: string,
  lastAssistantText: string | undefined,
  attemptCount: number | undefined,
  maxAttempts: number | undefined,
  goalSection?: string
): Promise<string> {
  const basePath = join(directory, ".agents", "supervisor")

  // Attempt to read each file; null if not found
  async function tryRead(filename: string): Promise<string | null> {
    try {
      return await readFile(join(basePath, filename), "utf-8")
    } catch {
      return null
    }
  }

  const [systemPromptFile, patternsFile, userFile, goalFile] = await Promise.all([
    tryRead("SystemPrompt.md"),
    tryRead("Patterns.md"),
    tryRead("User.md"),
    tryRead("Goal.md"),
  ])

  // extractGoalCondition now imported from ../core/goal.mjs (shared).

  // Build context variables for interpolation
  const safeContext = {
    ...context,
    detectedSignals: Array.isArray(context.detectedSignals) ? context.detectedSignals : []
  }

  const requirements: string[] = []
  if (safeContext.requiresTests) requirements.push("Tests required (run after latest changes)")
  if (safeContext.requiresBuild) requirements.push("Build/compile required")
  if (safeContext.requiresPR) requirements.push("PR required (include link)")
  if (safeContext.requiresCI) requirements.push("CI checks required (verify status)")
  if (safeContext.requiresLocalTests) requirements.push("Local tests required (must run in this session)")
  if (safeContext.pushedToDefaultBranch) requirements.push("Detected direct push to default branch (must be avoided)")
  if (requirements.length === 0) requirements.push("No explicit workflow gates detected")

  const effectiveCap = maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const currentAttempt = attemptCount || 0

  // If no session goal was passed, check Goal.md for a project-level goal
  const projectGoalCondition = !goalSection ? extractGoalCondition(goalFile) : ""
  const effectiveGoalSection = goalSection || (projectGoalCondition ? buildGoalRequirementSection(projectGoalCondition) : undefined)

  const templateVars: Record<string, string | undefined> = {
    taskSummary: safeContext.taskSummary,
    taskType: safeContext.taskType,
    agentMode: safeContext.agentMode,
    requirements: requirements.join("; "),
    signals: safeContext.detectedSignals.length ? safeContext.detectedSignals.join(", ") : "none",
    toolsSummary: safeContext.toolsSummary,
    lastAssistantText: lastAssistantText ? lastAssistantText.slice(0, 4000) : undefined,
    attemptSection: currentAttempt > 0 ? "true" : undefined,
    attemptNumber: String(currentAttempt + 1),
    maxAttempts: String(effectiveCap),
    projectInstructions: agents ? agents.slice(0, 800) : undefined,
    goalSection: effectiveGoalSection || undefined,
  }

  // If the system prompt file exists, use the file-based approach
  if (systemPromptFile) {
    const interpolated = interpolateTemplate(systemPromptFile, templateVars)
    const parts = [interpolated]
    if (patternsFile) {
      parts.push(patternsFile)
    }
    if (userFile && userFile.trim() !== "") {
      parts.push(userFile)
    }
    return parts.join("\n\n")
  }

  // Fallback: build prompt using the same logic as buildSelfAssessmentPrompt
  // (for projects that don't have the 3-file structure yet)
  const rubric = parseRubric(DEFAULT_RUBRIC)
  const effRubric: Rubric = effectiveGoalSection
    ? { ...rubric, antipatterns: `${rubric.antipatterns}\n\n${effectiveGoalSection}` }
    : rubric
  return buildSelfAssessmentPrompt(
    context,
    agents,
    lastAssistantText,
    currentAttempt,
    effRubric,
    effectiveCap
  )
}

async function analyzeSelfAssessmentWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  selfAssessment: string,
  judgeSessionIds: Set<string>,
  toolSupervisorPrompt?: string | null,
  rubric?: Rubric,
  sessionMessages?: any[]
): Promise<SupervisorAnalysis | null> {
  const modelList = await loadSupervisorModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  const sessionModelSpec = getLastSessionModelSpec(sessionMessages || [])
  const attempts = modelList.length
    ? modelList
    : preferredModel && !isBlockedJudgeModel(preferredModel)
      ? [preferredModel]
      : sessionModelSpec && !isBlockedJudgeModel(sessionModelSpec)
        ? [sessionModelSpec]
        : [JUDGE_FREE_FALLBACK]

  const prompt = buildJudgePrompt(context, selfAssessment, toolSupervisorPrompt, rubric)

  for (const modelSpec of attempts) {
    let judgeSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      judgeSession = data
    } catch {
      return null
    }
    if (!judgeSession?.id) return null
    judgeSessionIds.add(judgeSession.id)

    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""

      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body
      })

      const response = await waitForResponse(client, judgeSession.id)
      if (!response) continue

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue

      const verdict = JSON.parse(jsonMatch[0]) as any
      const missing = Array.isArray(verdict.missing) ? verdict.missing : []
      const humanOnlyMissing = missing.filter((item: string) => isHumanOnlyAction(item))
      const actionableMissing = missing.filter((item: string) => !isHumanOnlyAction(item))
      const actionableNextActions = Array.isArray(verdict.next_actions)
        ? verdict.next_actions.filter((item: string) => typeof item === "string" && !isHumanOnlyAction(item))
        : []
      const shouldContinue = !verdict.complete && (actionableMissing.length > 0 || actionableNextActions.length > 0)
      const requiresHumanAction = !!verdict.requires_human_action || humanOnlyMissing.length > 0
      return {
        complete: !!verdict.complete,
        shouldContinue,
        reason: verdict.feedback || "Judge analysis completed",
        missing,
        nextActions: Array.isArray(verdict.next_actions) ? verdict.next_actions : [],
        requiresHumanAction,
        severity: verdict.severity || "MEDIUM"
      }
    } catch (e) {
      reportError(e, { plugin: "supervisor-3", op: "judge-session" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: judgeSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  return null
}

async function runCrossModelReview(
  client: any,
  directory: string,
  context: TaskContext,
  selfAssessment: string,
  analysis: SupervisorAnalysis,
  lastAssistantText: string,
  assessmentModelSpec: string | null,
  judgeSessionIds: Set<string>,
  toolSupervisorPrompt?: string | null
): Promise<{ modelSpec: string; response: string } | null> {
  const crossModelSpec = getCrossReviewModelSpec(assessmentModelSpec)
  if (!crossModelSpec) return null

  debug("Starting cross-model review session with model:", crossModelSpec)

  let reviewSession: any
  try {
    const { data } = await client.session.create({ query: { directory } })
    reviewSession = data
  } catch {
    debug("Failed to create cross-review session")
    return null
  }
  if (!reviewSession?.id) return null
  judgeSessionIds.add(reviewSession.id)

  const prompt = `REVIEW SUPERVISOR COMPLETION

You are reviewing another model's completion verdict for an agent task.
Provide a concise critique and supervisor:
- Does the self-assessment evidence justify completion?
- Any missing workflow gates (tests/build/PR/CI)?
- Any inconsistencies between tool signals and the agent's claim?
- Provide a short supervisor: what could have been stronger?

## Task Summary
${context.taskSummary}

## Task Type
${context.taskType}

## Tool Signals
${context.toolsSummary}

## Agent Last Response
${lastAssistantText.slice(0, 2000)}

## Self-Assessment
${selfAssessment.slice(0, 3000)}
${buildToolSupervisorGuidanceSection(toolSupervisorPrompt || null)}

## Supervisor Analysis Verdict
${JSON.stringify(analysis, null, 2)}

Return a short paragraph plus bullet list of any gaps.`

  try {
    const modelParts = parseModelSpec(crossModelSpec)
    const body: any = { parts: [{ type: "text", text: prompt }] }
    if (modelParts) body.model = modelParts

    await client.session.promptAsync({
      path: { id: reviewSession.id },
      body
    })

    const response = await waitForResponse(client, reviewSession.id)
    if (!response) return null
    return { modelSpec: crossModelSpec, response }
  } catch (e) {
    reportError(e, { plugin: "supervisor-3", op: "cross-review" })
    return null
  } finally {
    try {
      await client.session.delete({ path: { id: reviewSession.id }, query: { directory } })
    } catch {}
    judgeSessionIds.delete(reviewSession.id)
  }
}

export const SupervisorPlugin: Plugin = async ({ client, directory }) => {
  initDebugLogger(directory)
  const judgeSessionIds = new Set<string>()
  const lastReflectedMsgId = new Map<string, string>()
  const activeSupervisors = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()
  const attempts = new Map<string, number>()
  let toolSupervisorPrompt: string | null = null
  let currentSessionId: string | null = null  // tracks most recent active session for the toggle tool

  const disabledFlagPath = join(directory, '.supervisor', 'disabled')

  async function isSessionDisabled(sessionId: string): Promise<boolean> {
    try {
      const content = await readFile(disabledFlagPath, 'utf8')
      return content.split('\n').map(l => l.trim()).filter(Boolean).includes(sessionId)
    } catch { return false }
  }

  async function setSessionDisabled(sessionId: string, disabled: boolean): Promise<void> {
    let lines: string[] = []
    try {
      const content = await readFile(disabledFlagPath, 'utf8')
      lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    } catch {}
    if (disabled) {
      if (!lines.includes(sessionId)) lines.push(sessionId)
    } else {
      lines = lines.filter(l => l !== sessionId)
    }
    await mkdir(join(directory, '.supervisor'), { recursive: true })
    await writeFile(disabledFlagPath, lines.join('\n') + (lines.length ? '\n' : ''))
  }

  const setSupervisorDescription = "Use this for difficult or complex tasks to set supervisor guidance with a plan/checklist. Provide concrete steps and verification checks so supervisor can validate completion quality and catch missed work."
  const executeSetSupervisor = async (args: { guidance?: string; clear?: boolean }) => {
    if (args.clear) {
      toolSupervisorPrompt = null
      return "Cleared tool-provided supervisor guidance. Supervisor now uses file override (.supervisor.md/supervisor.md) or default prompt."
    }
    const guidance = (args.guidance || "").trim()
    if (!guidance) {
      if (!toolSupervisorPrompt) {
        return "No tool-provided supervisor guidance is set."
      }
      return `Current tool-provided supervisor guidance:\n${toolSupervisorPrompt}`
    }
    toolSupervisorPrompt = guidance
    const msg = "Set tool-provided supervisor guidance for this runtime. It will be used when no .supervisor.md/supervisor.md file override exists."
    if (guidance.length > 4000) return `${msg}\n\nNote: guidance exceeds 4000 chars and will be truncated when applied to supervisor prompts.`
    return msg
  }

  // Primary supervisor tool: status, session on/off, and mode selection.
  const supervisorToggleDescription = "Inspect or change supervisor state for the current session. Use mode=autopilot or mode=reflection to switch modes. Use action=off/on for session disable/enable, or omit args for status. Legacy action=autopilot/reflection/goal/retry remains supported; prefer supervisor_goal and supervisor_retry for goal/retry."
  const executeSupervisorToggle = async (args: { action?: string; mode?: SupervisorMode; condition?: string; clear?: boolean; n?: number } = {}) => {
    const sid = currentSessionId
    if (!sid) return "No active session tracked yet — wait for the first session.idle event, then try again."
    const requestedMode = args.mode?.trim().toLowerCase()
    if (requestedMode === "autopilot") {
      await supervisorStore.setMode(directory, sid, "autopilot")
      return `Supervisor mode set to autopilot for session ${sid.slice(0, 8)}…. The supervisor will automatically continue after each idle without judge evaluation. Call autopilot_exit when work is complete.`
    }
    if (requestedMode === "reflection") {
      await supervisorStore.setMode(directory, sid, "reflection")
      return `Supervisor mode set to reflection for session ${sid.slice(0, 8)}…. The supervisor will run the normal completion judge on idle.`
    }
    const action = (args.action || "status").trim().toLowerCase()
    if (action === "off") {
      await setSessionDisabled(sid, true)
      return `Supervisor disabled for session ${sid.slice(0, 8)}… (added to .supervisor/disabled).`
    }
    if (action === "on") {
      await setSessionDisabled(sid, false)
      return `Supervisor enabled for session ${sid.slice(0, 8)}… (removed from .supervisor/disabled).`
    }
    if (action === "autopilot") {
      await supervisorStore.setMode(directory, sid, "autopilot")
      return `Supervisor mode set to autopilot for session ${sid.slice(0, 8)}…. The supervisor will automatically continue after each idle without judge evaluation. Call autopilot_exit when work is complete.`
    }
    if (action === "reflection") {
      await supervisorStore.setMode(directory, sid, "reflection")
      return `Supervisor mode set to reflection for session ${sid.slice(0, 8)}…. The supervisor will run the normal completion judge on idle.`
    }
    if (action === "goal") {
      return executeSupervisorGoal({ condition: args.condition, clear: args.clear })
    }
    if (action === "retry") {
      return executeSupervisorRetry({ n: args.n })
    }
    if (action === "autoreview" || action === "autoreview-on" || action === "autoreview-off" || action === "autoreview-status") {
      if (action === "autoreview-off") return executeSupervisorAutoreview({ enabled: false })
      if (action === "autoreview-status") {
        const st = await supervisorStore.load(directory, sid)
        return `Autoreview: ${st.autoreview ? "on" : "off"}`
      }
      return executeSupervisorAutoreview({ enabled: true })
    }
    const disabled = await isSessionDisabled(sid)
    const st = await supervisorStore.load(directory, sid)
    const mode = resolveSupervisorMode(st)
    const goalText = st.goal ? `\ngoal: ${st.goal.status} — ${st.goal.condition}\nattempts: ${st.goal.attempts}${st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : ""}` : "\ngoal: (none)"
    return `Supervisor status for session ${sid.slice(0, 8)}…\nenabled: ${disabled ? "no" : "yes"}\nmode: ${mode}\nretry: ${st.maxAttempts ?? "(default)"}\nautoreview: ${st.autoreview ? "on" : "off"}${goalText}`
  }

  // supervisor_train tool — runs the learning loop (mine sessions -> classify ->
  // update USER-LOCAL patterns). Web-app portable (works in TUI, web, and serve).
  const supervisorTrainDescription = "Train the supervisor on recent sessions: mine how the agent stopped and how the user followed up, then update the user-local patterns/anti-patterns. Never commits to git; dataset stays private. Args: since (e.g. '14d'), dryRun (preview only), pushHf (push private dataset to HuggingFace)."
  const executeSupervisorTrain = async (args: { since?: string; dryRun?: boolean; pushHf?: boolean }) => {
    const trainScript = join(dirname(fileURLToPath(import.meta.url)), "..", "train", "run-train.mjs")
    const argv = [trainScript, `--since=${args.since || "14d"}`]
    if (args.dryRun) argv.push("--dry-run")
    if (args.pushHf) argv.push("--push-hf")
    return await new Promise<string>((resolve) => {
      execFile("node", argv, { cwd: directory, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = `${stdout || ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim()
        if (err) resolve(`supervisor:train failed (${err.message}).\n${out.slice(-4000)}`)
        else resolve(out.slice(-8000) || "supervisor:train completed (no output).")
      })
    })
  }

  // supervisor_goal / supervisor_retry tools — wire the supervisor-mode goal loop
  // to a callable surface (works in TUI, web, serve). The runSupervisor loop reads
  // this per-session state on the next session.idle.
  const supervisorGoalDescription = "Set, check, or clear a session GOAL the agent must demonstrably meet before the supervisor lets it stop. Args: condition (the goal text; omit to check status), clear (true to clear)."
  const executeSupervisorGoal = async (args: { condition?: string; clear?: boolean }) => {
    const sid = currentSessionId
    if (!sid) return "No active session yet — wait for the first session.idle, then set a goal."
    if (args.clear) {
      await supervisorStore.clearGoal(directory, sid)
      return `Goal cleared for session ${sid.slice(0, 8)}….`
    }
    const condition = (args.condition || "").trim()
    if (!condition) {
      const st = await supervisorStore.load(directory, sid)
      if (!st.goal) return "No goal set for this session."
      return `Goal (${st.goal.status}): ${st.goal.condition}\nattempts: ${st.goal.attempts}${st.goal.lastReason ? `\nlast: ${st.goal.lastReason}` : ""}`
    }
    await supervisorStore.setGoal(directory, sid, condition, {})
    // Also persist to .agents/supervisor/Goal.md so reflection mode picks it up
    // across sessions. Safe under concurrent writers — see writeProjectGoal.
    writeProjectGoal(directory, condition)
    return `Goal set for session ${sid.slice(0, 8)}…: "${condition}". Supervisor will keep pushing until it's met (or the retry budget runs out). Also saved to .agents/supervisor/Goal.md for reflection mode.`
  }
  const supervisorRetryDescription = "Set or check the supervisor retry budget (max continuation attempts) for this session. Args: n (1–100; omit to check current)."
  const executeSupervisorRetry = async (args: { n?: number }) => {
    const sid = currentSessionId
    if (!sid) return "No active session yet — wait for the first session.idle, then set retry."
    if (typeof args.n === "number" && Number.isFinite(args.n)) {
      await supervisorStore.setRetry(directory, sid, args.n)
      const eff = resolveMaxAttempts({ sessionOverride: Math.max(1, Math.min(100, Math.floor(args.n))) })
      return `Retry budget set to ${eff} for session ${sid.slice(0, 8)}….`
    }
    const st = await supervisorStore.load(directory, sid)
    return `Retry budget (session override): ${st.maxAttempts ?? "(default)"}.`
  }

  // supervisor_autopilot tool — toggle autopilot mode (skip judge, always continue)
  const supervisorAutopilotDescription = "Toggle autopilot mode. In autopilot mode, the supervisor automatically continues the session after each idle, without running the judge evaluation. The agent must call autopilot_exit to stop. Usage: call with enabled=true to start autopilot, enabled=false to stop."
  const executeSupervisorAutopilot = async (args: { enabled: boolean }) => {
    const sid = currentSessionId
    if (!sid) return "No active session yet — wait for the first session.idle, then toggle autopilot."
    await supervisorStore.setAutopilot(directory, sid, args.enabled)
    if (args.enabled) {
      return `Autopilot enabled for session ${sid.slice(0, 8)}…. The supervisor will automatically continue after each idle without judge evaluation. Call autopilot_exit when work is complete.`
    }
    return `Autopilot disabled for session ${sid.slice(0, 8)}….`
  }

  // supervisor_autoreview tool — toggle cross-model review on completion
  const supervisorAutoreviewDescription = "Toggle cross-model autoreview. When enabled, a second AI model reviews task completion verdicts for blind-spot coverage. Usage: call with enabled=true to enable, enabled=false to disable."
  const executeSupervisorAutoreview = async (args: { enabled: boolean }) => {
    const sid = currentSessionId
    if (!sid) return "No active session yet — wait for the first session.idle, then toggle autoreview."
    await supervisorStore.setAutoreview(directory, sid, args.enabled)
    if (args.enabled) {
      return `Autoreview enabled for session ${sid.slice(0, 8)}…. Cross-model review will run when the judge marks a task complete.`
    }
    return `Autoreview disabled for session ${sid.slice(0, 8)}….`
  }

  // autopilot_exit tool — signal that autopilot work is complete
  const autopilotExitDescription = `Use this tool when autopilot work is complete and you are ready to hand control back to build mode.
Call this tool:
- After finishing the autonomous implementation task
- When you are ready to provide a final concise summary
Do NOT call this tool:
- Before implementation work is complete
- If you still need to run more tools to finish the task`
  const executeAutopilotExit = async () => {
    const sid = currentSessionId
    if (sid) {
      await supervisorStore.setAutopilot(directory, sid, false)
    }
    return { title: "Exited autopilot", output: "Autopilot completed." }
  }

  let setSupervisorTool: any = null
  let supervisorToggleTool: any = null
  let supervisorTrainTool: any = null
  let supervisorGoalTool: any = null
  let supervisorRetryTool: any = null
  let supervisorAutopilotTool: any = null
  let supervisorAutoreviewTool: any = null
  let autopilotExitTool: any = null
  try {
    const { tool } = await import("@opencode-ai/plugin/tool")
    supervisorGoalTool = tool({
      description: supervisorGoalDescription,
      args: {
        condition: tool.schema.string().optional().describe("The goal the agent must meet before stopping. Omit to check status."),
        clear: tool.schema.boolean().optional().describe("Set true to clear the current session goal.")
      },
      execute: executeSupervisorGoal as any
    })
    supervisorRetryTool = tool({
      description: supervisorRetryDescription,
      args: {
        n: tool.schema.number().optional().describe("Retry budget (1–100). Omit to check current.")
      },
      execute: executeSupervisorRetry as any
    })
    supervisorTrainTool = tool({
      description: supervisorTrainDescription,
      args: {
        since: tool.schema.string().optional().describe("Mine sessions from the last N days, e.g. '14d'. Default 14d."),
        dryRun: tool.schema.boolean().optional().describe("Preview the proposed pattern changes without writing."),
        pushHf: tool.schema.boolean().optional().describe("Also push the private mined dataset to HuggingFace (requires `hf auth login`).")
      },
      execute: executeSupervisorTrain as any
    })
    setSupervisorTool = tool({
      description: setSupervisorDescription,
      args: {
        guidance: tool.schema.string().optional().describe("Supervisor guidance. Include a concise plan/checklist for complex work and evidence expectations."),
        clear: tool.schema.boolean().optional().describe("Set true to clear the current tool-provided supervisor guidance.")
      },
      execute: executeSetSupervisor
    })
    supervisorToggleTool = tool({
      description: supervisorToggleDescription,
      args: {
        mode: tool.schema.string().optional().describe("Supervisor mode to set: autopilot or reflection. Prefer this over action for mode changes."),
        action: tool.schema.string().optional().describe("status, off, or on. Legacy autopilot, reflection, goal, and retry are still accepted. Omit for status."),
        condition: tool.schema.string().optional().describe("Goal text when action is 'goal'."),
        clear: tool.schema.boolean().optional().describe("Set true with action 'goal' to clear the current goal."),
        n: tool.schema.number().optional().describe("Retry budget when action is 'retry'.")
      },
      execute: executeSupervisorToggle as any
    })
    supervisorAutopilotTool = tool({
      description: supervisorAutopilotDescription,
      args: {
        enabled: tool.schema.boolean().describe("Set true to enable autopilot mode, false to disable it.")
      },
      execute: executeSupervisorAutopilot as any
    })
    supervisorAutoreviewTool = tool({
      description: supervisorAutoreviewDescription,
      args: {
        enabled: tool.schema.boolean().describe("Set true to enable cross-model autoreview, false to disable it.")
      },
      execute: executeSupervisorAutoreview as any
    })
    autopilotExitTool = tool({
      description: autopilotExitDescription,
      args: {},
      execute: executeAutopilotExit as any
    })
  } catch {
    try {
      const { z } = await import("zod")
      setSupervisorTool = {
        description: setSupervisorDescription,
        args: {
          guidance: z.string().optional().describe("Supervisor guidance. Include a concise plan/checklist for complex work and evidence expectations."),
          clear: z.boolean().optional().describe("Set true to clear the current tool-provided supervisor guidance.")
        },
        execute: executeSetSupervisor
      }
      supervisorToggleTool = {
        description: supervisorToggleDescription,
        args: {
          mode: z.enum(["autopilot", "reflection"]).optional().describe("Supervisor mode to set. Prefer this over action for mode changes."),
          action: z.string().optional().describe("status, off, or on. Legacy autopilot, reflection, goal, and retry are still accepted. Omit for status."),
          condition: z.string().optional().describe("Goal text when action is 'goal'."),
          clear: z.boolean().optional().describe("Set true with action 'goal' to clear the current goal."),
          n: z.number().optional().describe("Retry budget when action is 'retry'.")
        },
        execute: executeSupervisorToggle
      }
      supervisorTrainTool = {
        description: supervisorTrainDescription,
        args: {
          since: z.string().optional().describe("Mine sessions from the last N days, e.g. '14d'. Default 14d."),
          dryRun: z.boolean().optional().describe("Preview the proposed pattern changes without writing."),
          pushHf: z.boolean().optional().describe("Also push the private mined dataset to HuggingFace (requires `hf auth login`).")
        },
        execute: executeSupervisorTrain
      }
      supervisorGoalTool = {
        description: supervisorGoalDescription,
        args: {
          condition: z.string().optional().describe("The goal the agent must meet before stopping. Omit to check status."),
          clear: z.boolean().optional().describe("Set true to clear the current session goal.")
        },
        execute: executeSupervisorGoal
      }
      supervisorRetryTool = {
        description: supervisorRetryDescription,
        args: {
          n: z.number().optional().describe("Retry budget (1–100). Omit to check current.")
        },
        execute: executeSupervisorRetry
      }
      supervisorAutopilotTool = {
        description: supervisorAutopilotDescription,
        args: {
          enabled: z.boolean().describe("Set true to enable autopilot mode, false to disable it.")
        },
        execute: executeSupervisorAutopilot
      }
      supervisorAutoreviewTool = {
        description: supervisorAutoreviewDescription,
        args: {
          enabled: z.boolean().describe("Set true to enable cross-model autoreview, false to disable it.")
        },
        execute: executeSupervisorAutoreview
      }
      autopilotExitTool = {
        description: autopilotExitDescription,
        args: {},
        execute: executeAutopilotExit
      }
    } catch {
      setSupervisorTool = null
      supervisorToggleTool = null
      supervisorTrainTool = null
      supervisorGoalTool = null
      supervisorRetryTool = null
      supervisorAutopilotTool = null
      supervisorAutoreviewTool = null
      autopilotExitTool = null
    }
  }

  async function runSupervisor(sessionId: string): Promise<void> {
      debug("runSupervisor called for session:", sessionId.slice(0, 8))
      if (activeSupervisors.has(sessionId)) return

      currentSessionId = sessionId
      if (await isSessionDisabled(sessionId)) {
        debug("Supervisor disabled for session:", sessionId.slice(0, 8))
        return
      }

      activeSupervisors.add(sessionId)

      try {
        let messages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          messages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session not found (likely deleted), skipping supervisor:", sessionId.slice(0, 8))
          return
        }
        if (!messages || messages.length < 2) return

        if (isJudgeSession(sessionId, messages, judgeSessionIds)) return
        if (isPlanMode(messages)) return

        // Issue #82 / Issue #109: ESC-abort detection.
        // Previously we checked time.completed on the last assistant message, but
        // that caused false negatives — sessions where the model stopped producing
        // output (context exhaustion, rate limit, etc.) also lack time.completed,
        // and supervisor would silently skip them.
        // We now rely solely on the recentlyAbortedSessions map (populated by
        // session.error with MessageAbortedError) plus a brief delay in the event
        // handler to handle the race where session.idle fires before session.error.

        const lastUserMsgId = getLastRelevantUserMessageId(messages)
        if (!lastUserMsgId) return

        const initialUserMsgId = lastUserMsgId
        const attemptKey = `${sessionId}:${lastUserMsgId}`
        const lastReflectedId = lastReflectedMsgId.get(sessionId)
        if (lastUserMsgId === lastReflectedId) return

        const context = await buildTaskContext(messages, directory)
        if (!context) return

        const lastAssistantText = extractLastAssistantText(messages)
        const customPrompt = await loadSupervisorPrompt(directory)
        const agents = await getAgentsFile(directory)
        const rubric = await loadRubric(directory)
        const currentAttemptCount = attempts.get(attemptKey) || 0
        // Supervisor goal/retry state. A /supervisor:retry override applies even
        // without a goal (sessionOverride). An active goal augments the judge
        // rubric with a mandatory completion requirement and drives the goal loop.
        const sup = await supervisorStore.load(directory, sessionId)
        const mode = resolveSupervisorMode(sup) as SupervisorMode
        const goal = mode === "goal" && sup.goal && sup.goal.status === "active" ? sup.goal : null
        const effectiveMaxAttempts = resolveMaxAttempts({ sessionOverride: sup.maxAttempts, config: await loadConfiguredMaxAttempts() })

        // ── Autopilot fast-path ──────────────────────────────────────────
        // When autopilot is on, skip the judge entirely and inject a
        // prescriptive nudge directly into the active session. Still honour
        // the attempt budget and loop detectors as safety rails.
        if (mode === "autopilot") {
          const autopilotAttempt = (attempts.get(attemptKey) || 0) + 1
          attempts.set(attemptKey, autopilotAttempt)

          if (autopilotAttempt >= effectiveMaxAttempts) {
            await supervisorStore.setAutopilot(directory, sessionId, false)
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            await showToast(client, directory, `Autopilot budget exhausted (${effectiveMaxAttempts} attempts)`, "warning")
            debug("Autopilot budget exhausted for", sessionId.slice(0, 8))
            return
          }

          const loopCheck = detectPlanningLoop(messages)
          const usePlanningLoopMsg = shouldApplyPlanningLoop(context.taskType, loopCheck.detected)
          const actionLoopCheck = detectActionLoop(messages)

          if (usePlanningLoopMsg || actionLoopCheck.detected) {
            // Loop detected — use the normal escalating feedback for loops
            const loopFeedback = buildEscalatingFeedback(
              autopilotAttempt,
              "HIGH",
              { feedback: "Autopilot loop detected — take concrete action.", missing: [], next_actions: [] },
              usePlanningLoopMsg,
              actionLoopCheck.detected,
              effectiveMaxAttempts
            )
            try {
              await client.session.promptAsync({
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: loopFeedback }] }
              })
            } catch (e: any) {
              debug("promptAsync failed (autopilot loop):", e?.message || e)
              reportError(e, { plugin: "supervisor-3", op: "prompt-autopilot-loop" })
            }
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }

          // Normal autopilot nudge — no judge, just continue
          const nudge = `${FEEDBACK_MARKER} Autopilot (${autopilotAttempt}/${effectiveMaxAttempts})

You are in autopilot mode. Continue working on the current task. Do not stop to ask for permission or confirmation — proceed with implementation.

When you have genuinely completed ALL work (not just one step), call the autopilot_exit tool to hand control back.

Continue now.`

          await showToast(client, directory, `Autopilot continuing (${autopilotAttempt}/${effectiveMaxAttempts})`, "info")
          try {
            await client.session.promptAsync({
              path: { id: sessionId },
              body: { parts: [{ type: "text", text: nudge }] }
            })
          } catch (e: any) {
            debug("promptAsync failed (autopilot nudge):", e?.message || e)
            reportError(e, { plugin: "supervisor-3", op: "prompt-autopilot" })
          }
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        // When a goal is active, its condition is the strongest stated intent and
        // MUST compose with the existing gates.
        const goalSection = goal ? buildGoalRequirementSection(goal.condition) : ""

        // Reflection mode: also read project-level goal from .agents/supervisor/Goal.md
        let projectGoalSection = ""
        if (mode === "reflection" && !goal) {
          try {
            const goalFilePath = join(directory, ".agents", "supervisor", "Goal.md")
            const goalFileContent = await readFile(goalFilePath, "utf-8")
            const cond = extractGoalCondition(goalFileContent)
            if (cond) projectGoalSection = buildGoalRequirementSection(cond)
          } catch {}
        }
        const effectiveGoalSection = goalSection || projectGoalSection

        const effRubric: Rubric = effectiveGoalSection
          ? { ...rubric, antipatterns: `${rubric.antipatterns}\n\n${effectiveGoalSection}` }
          : rubric

        // Use 3-file reflection system (falls back to buildSelfAssessmentPrompt internally)
        const defaultSupervisorPrompt = await buildReflectionPromptFromFiles(
          directory,
          context,
          agents,
          lastAssistantText,
          currentAttemptCount,
          effectiveMaxAttempts,
          effectiveGoalSection || undefined
        )
        let supervisorPrompt: string
        let effectiveToolSupervisorPrompt: string | null
        let promptSource: "file" | "tool" | "default" | "goal" | "reflection+goal"
        if (goal) {
          // Goal active: use the default (goal-augmented) prompt directly.
          supervisorPrompt = defaultSupervisorPrompt
          effectiveToolSupervisorPrompt = null
          promptSource = "goal"
        } else if (mode === "reflection" && projectGoalSection) {
          supervisorPrompt = defaultSupervisorPrompt
          effectiveToolSupervisorPrompt = null
          promptSource = "reflection+goal"
        } else {
          const resolvedPrompt = resolveSupervisorPromptPrecedence(customPrompt, toolSupervisorPrompt, defaultSupervisorPrompt)
          supervisorPrompt = resolvedPrompt.prompt
          effectiveToolSupervisorPrompt = resolvedPrompt.effectiveToolSupervisorPrompt
          promptSource = resolvedPrompt.source
        }

        await showToast(client, directory, "Requesting supervisor self-assessment...", "info")
        debug("Requesting supervisor self-assessment (source:", promptSource, ")")

        // Issue #98: Run self-assessment in a separate ephemeral session instead
        // of prompting the active agent session. Asking the active session to
        // respond in JSON poisons its context, causing subsequent replies to be
        // JSON-only.
        const modelList = await loadSupervisorModelList()
        const preferredModel = await loadPreferredModelSpec(directory)
        const sessionModelSpec = getLastSessionModelSpec(messages || [])
        const assessmentAttempts = modelList.length
          ? modelList
          : preferredModel && !isBlockedJudgeModel(preferredModel)
            ? [preferredModel]
            : sessionModelSpec && !isBlockedJudgeModel(sessionModelSpec)
              ? [sessionModelSpec]
              : [JUDGE_FREE_FALLBACK]

      let selfAssessment: string | null = null
      let assessmentModelSpec: string | null = null
      for (const modelSpec of assessmentAttempts) {
        let assessmentSession: any
        try {
          const { data } = await client.session.create({ query: { directory } })
            assessmentSession = data
          } catch {
            debug("Failed to create self-assessment session")
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          if (!assessmentSession?.id) {
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          judgeSessionIds.add(assessmentSession.id)

          try {
            const modelParts = modelSpec ? modelSpec.split("/") : []
            const providerID = modelParts[0] || ""
            const modelID = modelParts.slice(1).join("/") || ""
            const body: any = { parts: [{ type: "text", text: supervisorPrompt }] }
            if (providerID && modelID) body.model = { providerID, modelID }

            await client.session.promptAsync({
              path: { id: assessmentSession.id },
              body
            })

            selfAssessment = await waitForResponse(client, assessmentSession.id)
            if (selfAssessment) {
              assessmentModelSpec = modelSpec || null
              break
            }
          } catch (e: any) {
            debug("promptAsync failed (self-assessment):", e?.message || e)
            reportError(e, { plugin: "supervisor-3", op: "prompt-self-assessment" })
            continue
          } finally {
            try {
              await client.session.delete({ path: { id: assessmentSession.id }, query: { directory } })
            } catch {}
            judgeSessionIds.delete(assessmentSession.id)
          }
        }

        if (!selfAssessment) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        debug("Self-assessment received")

        // Check if user sent a new message or aborted during assessment
        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        let currentMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          currentMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted during supervisor, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const currentUserMsgId = getLastRelevantUserMessageId(currentMessages || [])
        if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          return
        }

        let analysis: SupervisorAnalysis | null = null
        const parsedAssessment = parseSelfAssessmentJson(selfAssessment)
        if (parsedAssessment) {
          analysis = evaluateSelfAssessment(parsedAssessment, context)
        } else {
          analysis = await analyzeSelfAssessmentWithLLM(
            client,
            directory,
            context,
            selfAssessment,
            judgeSessionIds,
            effectiveToolSupervisorPrompt,
            effRubric,
            currentMessages
          )
        }

        if (!analysis) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, "Supervisor analysis failed", "warning")
          return
        }

        debug("Supervisor analysis completed")

        // Supervisor goal loop: when an active goal exists, decide its next state
        // (budget exhaustion FIRST, then achievement, then continuation). An
        // exhausted goal pauses the loop WITHOUT injecting a continuation; an
        // achieved goal is persisted and falls through to the normal complete
        // bookkeeping; a continuing goal must ONLY burn budget (attempts+1) when a
        // continuation is actually injected — so we defer that persist until after
        // the feedback prompt succeeds (see pendingGoalContinue below). This avoids
        // silently losing budget on interrupted passes (human-action, new-message,
        // abort, or per-message max-attempts rechecks that early-return).
        let pendingGoalContinue: SupervisorState | null = null
        if (goal) {
          const t = decideGoalTransition({
            goal,
            complete: analysis.complete,
            now: Date.now(),
            maxAttempts: effectiveMaxAttempts,
            reason: analysis.reason,
          })
          if (t.action === "exhausted") {
            await supervisorStore.save(directory, sessionId, { ...sup, mode: "reflection", autopilot: false, goal: t.goal })
            attempts.delete(attemptKey)
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            await showToast(
              client,
              directory,
              `Goal budget exhausted (${t.goal.attempts} attempts) — paused`,
              "warning"
            )
            debug("Goal budget exhausted, pausing without continuation")
            return
          }
          if (t.action === "achieved") {
            // Persist the achieved status now; the existing analysis.complete
            // branch below handles the bookkeeping + return. No attempts increment.
            await supervisorStore.save(directory, sessionId, { ...sup, mode: "reflection", autopilot: false, goal: t.goal })
          } else {
            // "continue": DO NOT persist the attempts++ here. Stash it and only
            // write it after a continuation is actually injected (post-promptAsync
            // success). Any early-return below leaves goal.attempts unchanged.
            pendingGoalContinue = { ...sup, mode: "goal", autopilot: false, goal: t.goal }
          }
        }

        let crossReview: { modelSpec: string; response: string } | null = null
        if (analysis.complete && sup.autoreview === true) {
          debug("Task complete, attempting cross-model review (assessmentModel:", assessmentModelSpec || "unknown", ")")
          crossReview = await runCrossModelReview(
            client,
            directory,
            context,
            selfAssessment,
            analysis,
            lastAssistantText,
            assessmentModelSpec,
            judgeSessionIds,
            effectiveToolSupervisorPrompt
          )
          if (crossReview) {
            debug("Cross-model review completed by", crossReview.modelSpec)
          } else {
            debug("Cross-model review skipped (no cross-model mapping or error)")
          }
        }

        // Compute routing early so it can be included in saved data
        const routingConfig = await loadRoutingConfig()
        const routingCategory = await classifyTaskForRoutingWithLLM(
          client, directory, context, judgeSessionIds, currentMessages,
          { routingEnabled: routingConfig.enabled }
        )
        const routingModel = getRoutingModel(routingConfig, routingCategory)

        await saveSupervisorData(directory, sessionId, {
          task: context.taskSummary,
          assessment: selfAssessment.slice(0, 4000),
          analysis,
          crossReview,
          routing: routingModel ? { category: routingCategory, model: routingModel } : null,
          timestamp: new Date().toISOString()
        })

        await writeVerdictSignal(directory, sessionId, analysis.complete, analysis.severity)

        if (analysis.complete) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, goal ? `Goal achieved ✓ (${analysis.severity})` : `Task complete ✓ (${analysis.severity})`, "success")
          debug("Supervisor complete")
          return
        }

        if (analysis.requiresHumanAction && !analysis.shouldContinue) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          const hint = (Array.isArray(analysis.missing) && analysis.missing[0]) || "User action required"
          await showToast(client, directory, `Action needed: ${hint}`, "warning")
          debug("Supervisor requires human action (no agent-actionable work remaining)")
          return
        }

        // Re-check for new user messages or abort before feedback injection
        // (analysis/judge phase can take significant time)
        let preFeedbackMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          preFeedbackMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted before feedback injection, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const preFeedbackUserMsgId = getLastRelevantUserMessageId(preFeedbackMessages || [])
        if (preFeedbackUserMsgId && preFeedbackUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          debug("User sent new message during analysis, skipping feedback")
          return
        }
        const preFeedbackAbort = recentlyAbortedSessions.get(sessionId)
        if (preFeedbackAbort) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          debug("Session aborted during analysis, skipping feedback")
          return
        }

        // When a goal is active, goal.attempts (persisted) guards the budget via
        // decideGoalTransition above; this per-message counter still fires as the
        // fallback cap for ordinary sessions without a goal. They coexist on purpose.
        const nextAttemptCount = (attempts.get(attemptKey) || 0) + 1
        attempts.set(attemptKey, nextAttemptCount)
        if (nextAttemptCount >= effectiveMaxAttempts) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Max attempts (${effectiveMaxAttempts}) reached`, "warning")
          debug("Max attempts reached for", sessionId.slice(0, 8))
          return
        }

        const loopCheck = detectPlanningLoop(preFeedbackMessages || messages)
        const usePlanningLoopMessage = shouldApplyPlanningLoop(context.taskType, loopCheck.detected)
        const actionLoopCheck = detectActionLoop(preFeedbackMessages || messages)
        const feedbackText = buildEscalatingFeedback(
          nextAttemptCount,
          analysis.severity || "MEDIUM",
          {
            feedback: analysis.reason || "Task incomplete",
            missing: analysis.missing,
            next_actions: analysis.nextActions
          },
          usePlanningLoopMessage,
          actionLoopCheck.detected,
          effectiveMaxAttempts
        )

        // NEVER apply routing model to the active session feedback. The active
        // session must keep its original model. Routing was removed because it
        // silently switched the user's session model (e.g. to gpt-5.2-codex),
        // breaking the session when the target model/provider wasn't available.
        // If task-based routing is needed in the future, it must spawn a separate
        // subagent session — never mutate the active session's model.
        const feedbackBody: any = { parts: [{ type: "text", text: feedbackText }] }
        if (routingModel) {
          // Log for diagnostics but do NOT apply to active session
          debug("Routing would suggest", routingCategory, "model:", JSON.stringify(routingModel), "(NOT applied to active session)")
        }

        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: feedbackBody
          })
        } catch (e: any) {
          debug("promptAsync failed (feedback):", e?.message || e)
          reportError(e, { plugin: "supervisor-3", op: "prompt-feedback" })
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        // Prevent supervisor loop: mark this task as reflected so the next
        // session.idle (triggered by the agent responding to feedback) does not
        // start another supervisor cycle for the same user message.
        lastReflectedMsgId.set(sessionId, lastUserMsgId)

        // Goal budget is burned ONLY here, after a continuation was actually
        // injected. If any earlier recheck early-returned (or promptAsync above
        // threw and returned), pendingGoalContinue was never set / never reached,
        // so goal.attempts stays unchanged — no silent budget loss.
        if (pendingGoalContinue) await supervisorStore.save(directory, sessionId, pendingGoalContinue)

        debug("Supervisor pushed continuation")

        const routingInfo = routingModel ? ` [routing: ${routingCategory}]` : ""
        await showToast(client, directory, `Pushed agent to continue${routingInfo}`, "info")
      } finally {
        activeSupervisors.delete(sessionId)
      }
    }

  return {
    config: async (cfg: any) => {
      // Register the /supervisor slash command so users can type
      // /supervisor [args] directly in the TUI instead of calling the tool.
      // The template instructs the LLM to route to the appropriate tool call.
      cfg.command = {
        ...(cfg.command || {}),
        supervisor: {
          description: "Control the supervisor: status | on | off | reflection | autopilot | goal <condition> | goal clear | retry <N> | autoreview on|off",
          template: `Execute this supervisor command by calling the supervisor tool with the appropriate arguments.

Command: "{{input}}"

Routing rules:
- empty or "status" → supervisor({ action: "status" })
- "on" → supervisor({ action: "on" })
- "off" → supervisor({ action: "off" })
- "reflection" → supervisor({ mode: "reflection" })
- "autopilot" → supervisor({ mode: "autopilot" })
- "goal <condition text>" → supervisor({ action: "goal", condition: "<condition text>" })
- "goal clear" → supervisor({ action: "goal", clear: true })
- "retry <N>" → supervisor({ action: "retry", n: N })
- "autoreview on" → supervisor_autoreview({ enabled: true })
- "autoreview off" → supervisor_autoreview({ enabled: false })

Call the tool now. Do not explain, just execute the tool call.`
        }
      }
    },
    "tool.execute.before": async (input: { tool?: string; sessionID?: string }) => {
      currentSessionId = trackSessionScopedToolSession(currentSessionId, input)
    },
    tool: (setSupervisorTool || supervisorToggleTool || supervisorTrainTool || supervisorGoalTool || supervisorRetryTool || supervisorAutopilotTool || autopilotExitTool) ? {
      ...(setSupervisorTool ? { set_supervisor: setSupervisorTool } : {}),
      ...(supervisorToggleTool ? { supervisor: supervisorToggleTool } : {}),
      ...(supervisorTrainTool ? { supervisor_train: supervisorTrainTool } : {}),
      ...(supervisorGoalTool ? { supervisor_goal: supervisorGoalTool } : {}),
      ...(supervisorRetryTool ? { supervisor_retry: supervisorRetryTool } : {}),
      ...(supervisorAutopilotTool ? { supervisor_autopilot: supervisorAutopilotTool } : {}),
      ...(supervisorAutoreviewTool ? { supervisor_autoreview: supervisorAutoreviewTool } : {}),
      ...(autopilotExitTool ? { autopilot_exit: autopilotExitTool } : {}),
    } : undefined,
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type)
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionId, Date.now())
          debug("Session aborted (Esc), cooldown started:", sessionId.slice(0, 8))
        }
      }

      if (event.type === "session.idle") {
        debug("session.idle received")
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          const elapsed = Date.now() - abortTime
          if (elapsed < ABORT_COOLDOWN) return
          recentlyAbortedSessions.delete(sessionId)
        }

        // Issue #109: Brief delay before running supervisor to let session.error
        // arrive first (handles race where session.idle fires before session.error
        // when user presses ESC). After the delay, re-check the abort map.
        await new Promise(resolve => setTimeout(resolve, ABORT_RACE_DELAY))
        const postDelayAbortTime = recentlyAbortedSessions.get(sessionId)
        if (postDelayAbortTime) {
          debug("Session aborted during race delay, skipping supervisor:", sessionId.slice(0, 8))
          return
        }

        try {
          await runSupervisor(sessionId)
        } catch (e: any) {
          debug("runSupervisor error:", e?.message || e)
          reportError(e, { plugin: "supervisor-3", op: "run-supervisor" })
        }
      }
    }
  }
}

export default SupervisorPlugin
