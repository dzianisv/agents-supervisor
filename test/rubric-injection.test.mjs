import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { loadRubricMarkdown, loadParsedRubric, formatRubricMarkdown } from '../core/rubric-loader.mjs'
import { buildSelfAssessmentPrompt, parseRubric, DEFAULT_RUBRIC } from '../core/assessment.mjs'
import { buildReflectionPrompt } from '../core/reflection-prompt.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIPPED_DEFAULTS_DIR = join(ROOT, '.agents', 'supervisor')

async function makeTmpDir() {
  const dir = join(tmpdir(), `rubric-test-${process.pid}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

test('loadRubricMarkdown returns null when no .supervisor/rubric.md exists', async () => {
  const dir = await makeTmpDir()
  try {
    const result = await loadRubricMarkdown(dir)
    assert.equal(result, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadRubricMarkdown returns file content when .supervisor/rubric.md exists', async () => {
  const dir = await makeTmpDir()
  const supervisorDir = join(dir, '.supervisor')
  await mkdir(supervisorDir, { recursive: true })
  const content = '## Patterns\n- research done when report written\n\n## Antipatterns\n- none'
  await writeFile(join(supervisorDir, 'rubric.md'), content, 'utf-8')
  try {
    const result = await loadRubricMarkdown(dir)
    assert.equal(result, content)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadParsedRubric returns null when no file', async () => {
  const dir = await makeTmpDir()
  try {
    const result = await loadParsedRubric(dir)
    assert.equal(result, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadParsedRubric returns parsed rubric object when file exists with valid rubric markdown', async () => {
  const dir = await makeTmpDir()
  const supervisorDir = join(dir, '.supervisor')
  await mkdir(supervisorDir, { recursive: true })
  await writeFile(
    join(supervisorDir, 'rubric.md'),
    '## Patterns\n- task done when report saved\n\n## Antipatterns\n- do not demand PR for research',
    'utf-8'
  )
  try {
    const result = await loadParsedRubric(dir)
    assert.ok(result !== null, 'should return non-null')
    assert.ok(typeof result.patterns === 'string', 'should have patterns string')
    assert.ok(typeof result.antipatterns === 'string', 'should have antipatterns string')
    assert.match(result.patterns, /task done when report saved/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildSelfAssessmentPrompt output differs when custom rubric passed vs null', () => {
  const ctx = {
    taskSummary: 'write a report',
    taskType: 'research',
    agentMode: 'auto',
    requiresTests: false,
    requiresBuild: false,
    requiresPR: false,
    requiresCI: false,
    requiresLocalTests: false,
    pushedToDefaultBranch: false,
    detectedSignals: [],
    toolsSummary: 'read, webfetch',
  }
  const customRubric = parseRubric(
    '## Patterns\n- CUSTOM: research complete when deliverable written\n\n## Antipatterns\n- CUSTOM: never require PR for research'
  )
  const promptDefault = buildSelfAssessmentPrompt(ctx, null, 'done', 0, null, 5)
  const promptCustom = buildSelfAssessmentPrompt(ctx, null, 'done', 0, customRubric, 5)
  assert.notEqual(promptDefault, promptCustom, 'prompts should differ with different rubrics')
  assert.match(promptCustom, /CUSTOM: research complete when deliverable written/)
  assert.doesNotMatch(promptDefault, /CUSTOM:/)
})

test('custom no-PR rubric for research tasks appears in built prompt text', () => {
  const ctx = {
    taskSummary: 'analyze market trends and write report',
    taskType: 'research',
    agentMode: 'auto',
    requiresTests: false,
    requiresBuild: false,
    requiresPR: false,
    requiresCI: false,
    requiresLocalTests: false,
    pushedToDefaultBranch: false,
    detectedSignals: [],
    toolsSummary: 'read, webfetch, write',
  }
  const researchRubric = parseRubric(
    '## Patterns\n- Research tasks: no PR or CI required — done when deliverable is written and saved\n- Code tasks: PR required, CI must pass\n\n## Antipatterns\n- Do not block research tasks for missing PR'
  )
  const prompt = buildSelfAssessmentPrompt(ctx, null, 'Report saved to disk.', 0, researchRubric, 5)
  assert.match(prompt, /no PR or CI required/)
  assert.match(prompt, /Do not block research tasks for missing PR/)
})

// ============================================================
// Regression: Claude Code Stop-hook path (bin/supervisor-on-stop.mjs) must
// actually load <cwd>/.supervisor/rubric.md via buildReflectionPrompt — it
// previously only ever used the shipped/.agents/supervisor/Patterns.md
// default and silently ignored the project rubric override.
// ============================================================

const sampleContext = {
  taskSummary: 'Fix a prod incident',
  taskType: 'coding',
  agentMode: 'build',
  requiresTests: false,
  requiresBuild: false,
  requiresPR: false,
  requiresCI: false,
  requiresLocalTests: false,
  pushedToDefaultBranch: false,
  detectedSignals: [],
  toolsSummary: 'bash: kubectl get pods',
}

test('buildReflectionPrompt (CC Stop-hook path) injects project .supervisor/rubric.md antipatterns', async () => {
  const dir = await makeTmpDir()
  const supervisorDir = join(dir, '.supervisor')
  await mkdir(supervisorDir, { recursive: true })
  const projectRubricMd =
    '## Patterns\n- PROJECT-MARKER: legitimately done only when exercised end-to-end\n\n' +
    '## Antipatterns\n- claimed-works-without-exercising: declared it works using a proxy instead of running the real thing\n' +
    '- unverified cluster target: deployed without proving the target cluster\n' +
    '- merged is not done: reported complete at merge without confirming post-merge deploy'
  await writeFile(join(supervisorDir, 'rubric.md'), projectRubricMd, 'utf-8')
  try {
    // Same call shape bin/supervisor-on-stop.mjs's main() uses: directory=cwd,
    // defaultsDir=the plugin's shipped .agents/supervisor (always present, so
    // systemPromptFile is always found and the file-based branch is taken).
    const prompt = await buildReflectionPrompt({
      directory: dir,
      defaultsDir: SHIPPED_DEFAULTS_DIR,
      context: sampleContext,
      agents: '',
      lastAssistantText: 'Deployed and confirmed CI is green.',
      attemptCount: 0,
      maxAttempts: 3,
    })
    assert.match(prompt, /claimed-works-without-exercising/, 'project rubric antipattern missing from prompt')
    assert.match(prompt, /unverified cluster target/, 'project rubric antipattern missing from prompt')
    assert.match(prompt, /PROJECT-MARKER/, 'project rubric pattern missing from prompt')
    // Replace, not merge/append: the shipped Patterns.md's own distinctive
    // rule text should NOT also appear once a project rubric.md is present.
    assert.doesNotMatch(prompt, /PLANNING LOOP CHECK/, 'shipped Patterns.md leaked in alongside the project rubric override')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildReflectionPrompt falls back to shipped Patterns.md when no project rubric.md exists', async () => {
  const dir = await makeTmpDir()
  try {
    const prompt = await buildReflectionPrompt({
      directory: dir,
      defaultsDir: SHIPPED_DEFAULTS_DIR,
      context: sampleContext,
      agents: '',
      lastAssistantText: 'Done.',
      attemptCount: 0,
      maxAttempts: 3,
    })
    assert.match(prompt, /PLANNING LOOP CHECK/, 'shipped Patterns.md default should be used absent a project rubric.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildReflectionPrompt fails open to shipped Patterns.md when rubric.md is malformed', async () => {
  const dir = await makeTmpDir()
  const supervisorDir = join(dir, '.supervisor')
  await mkdir(supervisorDir, { recursive: true })
  // No "## Patterns" / "## Antipatterns" headers at all — parseRubric() yields
  // {patterns: '', antipatterns: ''}, which loadParsedRubric() must treat as
  // "no usable override" rather than clobbering the prompt with empty sections.
  await writeFile(join(supervisorDir, 'rubric.md'), 'just some free text, no section headers', 'utf-8')
  try {
    const prompt = await buildReflectionPrompt({
      directory: dir,
      defaultsDir: SHIPPED_DEFAULTS_DIR,
      context: sampleContext,
      agents: '',
      lastAssistantText: 'Done.',
      attemptCount: 0,
      maxAttempts: 3,
    })
    assert.match(prompt, /PLANNING LOOP CHECK/, 'malformed rubric.md should fail open to shipped Patterns.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('formatRubricMarkdown round-trips through parseRubric', () => {
  const rubric = { patterns: '- p1\n- p2', antipatterns: '- a1' }
  const md = formatRubricMarkdown(rubric)
  const reparsed = parseRubric(md)
  assert.equal(reparsed.patterns, rubric.patterns)
  assert.equal(reparsed.antipatterns, rubric.antipatterns)
})
