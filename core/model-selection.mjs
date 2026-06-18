/**
 * Pure model-selection helpers shared by supervisor runtimes.
 */

export const JUDGE_BLOCKED_PATTERNS = [
  /\bhaiku\b/i,
  /\bmini\b/i,
  /\bnano\b/i,
  /\bflash\b/i,
  /\bgpt-3\.5\b/i,
  /\bllama-3\.1-8b\b/i,
  /\bmixtral-8x7b\b/i,
]

/**
 * @typedef {{ providerID: string, modelID: string }} ModelSpecParts
 */

export function isBlockedJudgeModel(modelSpec) {
  const normalized = modelSpec.toLowerCase()
  return JUDGE_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * @param {string | null | undefined} modelSpec
 * @returns {ModelSpecParts | null}
 */
export function parseModelSpec(modelSpec) {
  if (typeof modelSpec !== 'string') return null
  const trimmed = modelSpec.trim()
  if (!trimmed) return null
  const parts = trimmed.split('/')
  if (parts.length < 2) return null
  const providerID = parts[0] || ''
  const modelID = parts.slice(1).join('/') || ''
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export function getGitHubCopilotModelForRouting(modelSpec) {
  const parsed = parseModelSpec(modelSpec)
  if (!parsed) return null
  const providerID = parsed.providerID.toLowerCase()
  const modelID = parsed.modelID.toLowerCase()
  if (providerID === 'github-copilot' || providerID === 'github-copilot/free') {
    if (modelID.includes('gpt-4.1') || modelID.includes('gpt-4o') || modelID.includes('gpt-4')) {
      return 'github-copilot/gpt-4.1'
    }
  }
  return null
}

export function getCrossReviewModelSpec(modelSpec) {
  const parsed = parseModelSpec(modelSpec)
  if (!parsed) return null
  const modelID = parsed.modelID.toLowerCase()
  if (modelID === 'claude-opus-4.6') return 'github-copilot/gpt-5.2-codex'
  if (modelID === 'gpt-5.2-codex') return 'github-copilot/claude-opus-4.6'
  return null
}

export function getLastSessionModelSpec(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const providerID = msg.info?.providerID
    const modelID = msg.info?.modelID
    if (typeof providerID === 'string' && typeof modelID === 'string' && providerID && modelID) {
      return `${providerID}/${modelID}`
    }
  }
  return null
}
