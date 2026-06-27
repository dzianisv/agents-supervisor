import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRubricMarkdown, loadParsedRubric } from '../core/rubric-loader.mjs'
import { buildSelfAssessmentPrompt, parseRubric, DEFAULT_RUBRIC } from '../core/assessment.mjs'

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
