// Tests: Goal.md must NEVER leak across projects.
//
// Production incident (2026-07-27): `opencode serve` ran with cwd
// /Users/engineer/workspace/agents-supervisor (this plugin's own repo), whose
// .agents/supervisor/Goal.md held an OpenClawBot production-readiness
// checklist. Session ses_05dee9808ffewDSZj4D3tn8fte was working in
// /Users/engineer/workspace/KineticAiCoach — which has NO Goal.md — yet
// received that checklist verbatim as a "MANDATORY GOAL" in its reflection
// feedback, causing cross-project scope creep and a 14-session fan-out that
// wedged the server.
//
// Two independent defects made that possible; both are covered here:
//
//   B1  core/reflection-prompt.mjs readSupervisorFile() fell back to
//       <defaultsDir>/<filename> for ALL four supervisor files. defaultsDir is
//       the PLUGIN's own .agents/supervisor dir (opencode/supervisor-impl.ts).
//       SystemPrompt.md/Patterns.md/User.md are generic judge config and SHOULD
//       default; Goal.md is project-specific user intent and MUST NOT.
//
//   B2  The plugin's `directory` is the SERVER's cwd, fixed at plugin init —
//       not the session's cwd. Goal lookups therefore read the wrong project.
//       The real cwd is on each assistant message as `info.path.cwd`.
//
// The SCOPE GUARD paragraph now sitting inside the live Goal.md is a prod
// mitigation, not a fix: it depends on the judge model obeying prose. These
// tests assert the CODE enforces scoping regardless of goal file text.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { buildReflectionPrompt } from '../core/reflection-prompt.mjs'
import { getLastSessionCwd, resolveSessionDirectory } from '../core/session-context.mjs'
import { resolveProjectGoalForSession } from '../opencode/supervisor-impl.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIPPED_DEFAULTS_DIR = join(ROOT, '.agents', 'supervisor')

// Distinctive strings that must never cross a project boundary.
const GOAL_SENTINEL = 'SENTINEL_CROSS_PROJECT_GOAL_MUST_NOT_LEAK_9f3a2c'
const GOAL_SENTINEL_LOWER = 'SENTINEL_LOWERCASE_GOAL_MUST_NOT_LEAK_41bd7e'
const SYSTEM_SENTINEL = 'SENTINEL_DEFAULT_SYSTEM_PROMPT_c81a4d'
const PATTERNS_SENTINEL = 'SENTINEL_DEFAULT_PATTERNS_7ae0b2'
const USER_SENTINEL = 'SENTINEL_DEFAULT_USER_5c9f13'
const PROJECT_GOAL_SENTINEL = 'SENTINEL_PROJECT_OWN_GOAL_2d84fa'

// Rendered by core/goal.mjs buildGoalRequirementSection — its presence in a
// prompt means a goal was injected as a mandatory completion requirement.
const GOAL_SECTION_HEADING = '## GOAL (mandatory completion requirement)'

const sampleContext = {
  taskSummary: 'Add a rate limiter to the API',
  taskType: 'feature',
  agentMode: 'build',
  requiresTests: true,
  requiresBuild: false,
  requiresPR: false,
  requiresCI: false,
  requiresLocalTests: false,
  pushedToDefaultBranch: false,
  detectedSignals: ['npm test'],
  toolsSummary: 'bash: npm test → pass',
}

let tmpSeq = 0
async function makeTmpDir(label) {
  const dir = join(tmpdir(), `goal-scope-${label}-${process.pid}-${Date.now()}-${tmpSeq++}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write <dir>/.agents/supervisor/<name> with `content`. */
async function writeSupervisorFile(dir, name, content) {
  const sup = join(dir, '.agents', 'supervisor')
  await mkdir(sup, { recursive: true })
  await writeFile(join(sup, name), content, 'utf-8')
}

/**
 * A defaultsDir standing in for the plugin's own .agents/supervisor: it holds
 * generic judge config (which SHOULD default) plus a Goal.md (which MUST NOT).
 */
async function makeDefaultsDir({ goalFilename = 'Goal.md', goalBody = GOAL_SENTINEL } = {}) {
  const dir = await makeTmpDir('defaults')
  await writeFile(
    join(dir, 'SystemPrompt.md'),
    `${SYSTEM_SENTINEL}\nTask: {{taskSummary}}\n{{#goalSection}}\n{{goalSection}}\n{{/goalSection}}\n`,
    'utf-8'
  )
  await writeFile(join(dir, 'Patterns.md'), `## Patterns\n- ${PATTERNS_SENTINEL}\n`, 'utf-8')
  await writeFile(join(dir, 'User.md'), `${USER_SENTINEL}\n`, 'utf-8')
  await writeFile(
    join(dir, goalFilename),
    `# Project Goal\n\n## Goal Condition\n\n${goalBody}\n`,
    'utf-8'
  )
  return dir
}

// ============================================================
// B1 — Goal.md must never be inherited from defaultsDir
// ============================================================
describe('B1: Goal.md is project-scoped and never inherits plugin defaults', () => {
  test('project WITHOUT Goal.md does not inherit defaultsDir Goal.md', async () => {
    const projectDir = await makeTmpDir('project-nogoal')
    const defaultsDir = await makeDefaultsDir()
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
      })
      assert.ok(
        !prompt.includes(GOAL_SENTINEL),
        'defaultsDir Goal.md leaked into a project that has none'
      )
      assert.ok(
        !prompt.includes(GOAL_SECTION_HEADING),
        'a MANDATORY GOAL section was injected despite the project having no Goal.md'
      )
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })

  test('project WITHOUT Goal.md does not inherit defaultsDir lower-case goal.md alias', async () => {
    const projectDir = await makeTmpDir('project-nogoal-alias')
    const defaultsDir = await makeDefaultsDir({
      goalFilename: 'goal.md',
      goalBody: GOAL_SENTINEL_LOWER,
    })
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
      })
      assert.ok(
        !prompt.includes(GOAL_SENTINEL_LOWER),
        'defaultsDir goal.md alias leaked into a project that has none'
      )
      assert.ok(!prompt.includes(GOAL_SECTION_HEADING), 'MANDATORY GOAL section injected from alias')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })

  test('regression guard: SystemPrompt.md / Patterns.md / User.md STILL fall back to defaultsDir', async () => {
    const projectDir = await makeTmpDir('project-bare')
    const defaultsDir = await makeDefaultsDir()
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
      })
      assert.ok(prompt.includes(SYSTEM_SENTINEL), 'SystemPrompt.md must still default')
      assert.ok(prompt.includes(PATTERNS_SENTINEL), 'Patterns.md must still default')
      assert.ok(prompt.includes(USER_SENTINEL), 'User.md must still default')
      // And the template still interpolates, i.e. we did not break the pipeline.
      assert.ok(prompt.includes(sampleContext.taskSummary))
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })

  test('regression guard: shipped defaults dir still supplies the judge rubric/system prompt', async () => {
    const projectDir = await makeTmpDir('project-shipped')
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir: SHIPPED_DEFAULTS_DIR,
        context: sampleContext,
        agents: '',
      })
      assert.ok(prompt.length > 200, 'shipped SystemPrompt.md should still be used')
      assert.ok(prompt.includes(sampleContext.taskSummary))
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('project WITH its own Goal.md still gets its goal injected', async () => {
    const projectDir = await makeTmpDir('project-owngoal')
    const defaultsDir = await makeDefaultsDir()
    await writeSupervisorFile(
      projectDir,
      'Goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${PROJECT_GOAL_SENTINEL}\n`
    )
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
      })
      assert.ok(prompt.includes(PROJECT_GOAL_SENTINEL), "project's own Goal.md must be injected")
      assert.ok(prompt.includes(GOAL_SECTION_HEADING), 'MANDATORY GOAL section expected')
      assert.ok(!prompt.includes(GOAL_SENTINEL), 'defaultsDir goal must not also appear')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })

  test("project's own lower-case goal.md alias still gets injected", async () => {
    const projectDir = await makeTmpDir('project-owngoal-alias')
    const defaultsDir = await makeDefaultsDir()
    await writeSupervisorFile(
      projectDir,
      'goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${PROJECT_GOAL_SENTINEL}\n`
    )
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
      })
      assert.ok(prompt.includes(PROJECT_GOAL_SENTINEL), "project's own goal.md alias must be injected")
      assert.ok(!prompt.includes(GOAL_SENTINEL), 'defaultsDir goal must not also appear')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })

  test('an explicit session goalSection still wins and defaults never contribute', async () => {
    const projectDir = await makeTmpDir('project-sessiongoal')
    const defaultsDir = await makeDefaultsDir()
    try {
      const prompt = await buildReflectionPrompt({
        directory: projectDir,
        defaultsDir,
        context: sampleContext,
        agents: '',
        goalSection: `${GOAL_SECTION_HEADING}\n\nSESSION_GOAL_ONLY`,
      })
      assert.ok(prompt.includes('SESSION_GOAL_ONLY'))
      assert.ok(!prompt.includes(GOAL_SENTINEL))
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(defaultsDir, { recursive: true, force: true })
    }
  })
})

// ============================================================
// B2 — session cwd resolution (mirrors test/model-fallback.test.mjs)
// ============================================================
describe('getLastSessionCwd', () => {
  test('returns path.cwd from last assistant message', () => {
    const messages = [
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a1', path: { cwd: '/w/KineticAiCoach', root: '/w/KineticAiCoach' } } },
    ]
    assert.equal(getLastSessionCwd(messages), '/w/KineticAiCoach')
  })

  test('returns most recent message with cwd', () => {
    const messages = [
      { info: { role: 'assistant', id: 'a1', path: { cwd: '/w/first', root: '/w/first' } } },
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a2', path: { cwd: '/w/latest', root: '/w/latest' } } },
    ]
    assert.equal(getLastSessionCwd(messages), '/w/latest')
  })

  test('returns null when no messages have path info', () => {
    const messages = [
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a1' } },
    ]
    assert.equal(getLastSessionCwd(messages), null)
  })

  test('returns null for empty messages array', () => {
    assert.equal(getLastSessionCwd([]), null)
  })

  test('returns null for non-array input', () => {
    assert.equal(getLastSessionCwd(undefined), null)
    assert.equal(getLastSessionCwd(null), null)
  })

  test('skips messages with missing or blank cwd', () => {
    const messages = [
      { info: { role: 'assistant', id: 'a1', path: { root: '/w/x' } } },
      { info: { role: 'assistant', id: 'a2', path: { cwd: '', root: '/w/x' } } },
      { info: { role: 'assistant', id: 'a3', path: { cwd: '   ', root: '/w/x' } } },
      { info: { role: 'assistant', id: 'a4', path: { cwd: '/w/real', root: '/w/real' } } },
    ]
    assert.equal(getLastSessionCwd(messages), '/w/real')
  })

  test('handles messages without info field', () => {
    const messages = [
      { parts: [{ type: 'text', text: 'hello' }] },
      { info: { role: 'assistant', id: 'a1', path: { cwd: '/w/ok', root: '/w/ok' } } },
    ]
    assert.equal(getLastSessionCwd(messages), '/w/ok')
  })

  test('handles a null path field without throwing', () => {
    const messages = [{ info: { role: 'assistant', id: 'a1', path: null } }]
    assert.equal(getLastSessionCwd(messages), null)
  })
})

describe('resolveSessionDirectory', () => {
  test('prefers the session cwd over the plugin/server directory', () => {
    const messages = [{ info: { role: 'assistant', id: 'a1', path: { cwd: '/w/session', root: '/w/session' } } }]
    assert.equal(resolveSessionDirectory(messages, '/w/server-cwd'), '/w/session')
  })

  test('falls back to the plugin directory when unresolvable', () => {
    assert.equal(resolveSessionDirectory([], '/w/server-cwd'), '/w/server-cwd')
    assert.equal(resolveSessionDirectory(undefined, '/w/server-cwd'), '/w/server-cwd')
    assert.equal(
      resolveSessionDirectory([{ info: { role: 'assistant', id: 'a1' } }], '/w/server-cwd'),
      '/w/server-cwd'
    )
  })
})

// ============================================================
// B2 integration — the plugin's real goal lookup honours session cwd
// ============================================================
describe('resolveProjectGoalForSession (plugin goal lookup)', () => {
  test('a session in another project does NOT read the server cwd Goal.md', async () => {
    // serverDir stands in for `opencode serve`'s cwd (agents-supervisor).
    const serverDir = await makeTmpDir('server-cwd')
    // sessionDir stands in for KineticAiCoach — no Goal.md at all.
    const sessionDir = await makeTmpDir('session-cwd')
    await writeSupervisorFile(
      serverDir,
      'Goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${GOAL_SENTINEL}\n`
    )
    try {
      const messages = [
        { info: { role: 'user', id: 'u1' } },
        { info: { role: 'assistant', id: 'a1', path: { cwd: sessionDir, root: sessionDir } } },
      ]
      assert.equal(
        resolveProjectGoalForSession(messages, serverDir),
        '',
        'goal from the server cwd leaked into a session running elsewhere'
      )
      // Sanity: the leak-source goal really is readable from serverDir, so the
      // assertion above is meaningful and not vacuously passing.
      assert.equal(resolveProjectGoalForSession([], serverDir), GOAL_SENTINEL)
    } finally {
      await rm(serverDir, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test("a session reads its OWN project's Goal.md, not the server's", async () => {
    const serverDir = await makeTmpDir('server-cwd-2')
    const sessionDir = await makeTmpDir('session-cwd-2')
    await writeSupervisorFile(
      serverDir,
      'Goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${GOAL_SENTINEL}\n`
    )
    await writeSupervisorFile(
      sessionDir,
      'Goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${PROJECT_GOAL_SENTINEL}\n`
    )
    try {
      const messages = [
        { info: { role: 'assistant', id: 'a1', path: { cwd: sessionDir, root: sessionDir } } },
      ]
      assert.equal(resolveProjectGoalForSession(messages, serverDir), PROJECT_GOAL_SENTINEL)
    } finally {
      await rm(serverDir, { recursive: true, force: true })
      await rm(sessionDir, { recursive: true, force: true })
    }
  })

  test('falls back to the plugin directory when the session cwd is unknown', async () => {
    const serverDir = await makeTmpDir('server-cwd-3')
    await writeSupervisorFile(
      serverDir,
      'Goal.md',
      `# Project Goal\n\n## Goal Condition\n\n${GOAL_SENTINEL}\n`
    )
    try {
      assert.equal(resolveProjectGoalForSession([], serverDir), GOAL_SENTINEL)
    } finally {
      await rm(serverDir, { recursive: true, force: true })
    }
  })
})

// ============================================================
// B2 wiring guard
// ============================================================
// The leak was a WIRING mistake: the right value existed, the wrong variable
// was passed. No unit test can observe that from outside the plugin — the
// reads happen inside runSupervisor's closure over the plugin-scope
// `directory`, and the E2E harness runs its sessions in the server cwd, so
// sessionDirectory === directory there and the bug stays invisible.
// This asserts on the source text instead. Coarse, but it is the only thing
// that fails if someone re-passes `directory` to a per-project read.
describe('B2 wiring: per-project reads use the session directory', () => {
  test('judge inputs are read from sessionDirectory, never the plugin directory', async () => {
    const raw = await readFile(join(ROOT, 'opencode', 'supervisor-impl.ts'), 'utf-8')
    // Strip comments — the incident notes quote the buggy calls verbatim, and
    // we are asserting on CODE, not on prose about the code.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

    // Everything below describes THIS PROJECT and must be session-scoped.
    const forbidden = [
      'buildTaskContext(messages, directory)',
      'getAgentsFile(directory)',
      'loadRubric(directory)',
      'loadSupervisorPrompt(directory)',
      'readProjectGoalCondition(directory)',
      // Write side: persisting a session's goal into the SERVER cwd is how one
      // project's goal got into another project's Goal.md in the first place.
      'writeProjectGoal(directory,',
      'writeDerivedProjectGoal(directory,',
    ]
    for (const call of forbidden) {
      assert.ok(
        !src.includes(call),
        `${call} reads the SERVER cwd, not the session's project — pass sessionDirectory (INCIDENT 2026-07-27)`
      )
    }

    const required = [
      'buildTaskContext(messages, sessionDirectory)',
      'getAgentsFile(sessionDirectory)',
      'loadRubric(sessionDirectory)',
      'loadSupervisorPrompt(sessionDirectory)',
      'resolveSessionDirectory(messages || [], directory)',
    ]
    for (const call of required) {
      assert.ok(src.includes(call), `expected session-scoped call missing: ${call}`)
    }

    // buildReflectionPrompt must receive the session dir, not the plugin one.
    assert.ok(
      src.includes('directory: sessionDirectory'),
      'buildReflectionPrompt must be given directory: sessionDirectory'
    )
  })
})
