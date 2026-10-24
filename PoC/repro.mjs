#!/usr/bin/env node
/**
 * PoC/repro.mjs — Deterministic reproduction harness for the PR/CI false-positive bug.
 *
 * Run: node PoC/repro.mjs
 * Exit 0 if all fixtures PASS; exit 1 if any FAIL.
 *
 * NO live LLM calls.  Each fixture provides a synthetic assessment JSON
 * (what the LLM judge would have returned) fed directly into evaluateSelfAssessment.
 * buildTaskContextMock produces the TaskContext from text + commands so the full
 * classification chain is exercised (inferTaskType → requiresPR/requiresCI → verdict).
 *
 * Fixtures
 * --------
 * A — BUG REPRODUCTION + FIX: research/report task, agent claims Notion page created
 *     but supplies only a URL claim (no tool evidence). Project instructions contain
 *     AGENTS.md PR/CI workflow text.
 *     EXPECTED after fix:
 *       - taskType = 'research'  (not 'coding')
 *       - requiresPR = false, requiresCI = false
 *       - 'Create PR' / 'Verify CI checks' NOT in missing
 *       - Verification-deferral (unproven Notion page) IS in missing (severity LOW)
 *
 * B — TRUE POSITIVE (must survive): real code task, agent stopped without tests/PR.
 *     EXPECTED:
 *       - taskType = 'coding'
 *       - 'Run tests' and 'Create PR' in missing (gates fire correctly)
 *
 * C — CLEAN STOP: research task fully done with evidence.
 *     EXPECTED:
 *       - complete = true, severity = 'NONE', no blocking
 */

import { inferTaskType, buildTaskContextMock, evaluateSelfAssessment } from './evaluation.mjs'
import { buildEscalatingFeedback } from './feedback.mjs'

// ────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ────────────────────────────────────────────────────────────────────────────

function runFixture(label, { context, assessment, expectations }) {
  const analysis = evaluateSelfAssessment(assessment, context)

  const failures = []

  for (const [key, expected] of Object.entries(expectations)) {
    const actual = analysis[key]
    if (typeof expected === 'boolean') {
      if (actual !== expected) failures.push(`  ${key}: expected ${expected}, got ${actual}`)
    } else if (Array.isArray(expected)) {
      // expected is a list of patterns that MUST appear in the actual array
      for (const pattern of expected) {
        const found = (actual || []).some(item =>
          typeof pattern === 'string'
            ? item.includes(pattern)
            : pattern.test(item)
        )
        if (!found) failures.push(`  ${key}: expected item matching ${pattern} not found in [${(actual || []).join(', ')}]`)
      }
    } else if (expected && typeof expected === 'object' && expected._absent) {
      // special sentinel: these strings must NOT appear in actual array
      for (const pattern of expected._absent) {
        const found = (actual || []).some(item =>
          typeof pattern === 'string'
            ? item.toLowerCase().includes(pattern.toLowerCase())
            : pattern.test(item)
        )
        if (found) failures.push(`  ${key}: item matching "${pattern}" should be ABSENT but was found in [${(actual || []).join(', ')}]`)
      }
    } else {
      if (actual !== expected) failures.push(`  ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }

  const pass = failures.length === 0
  const icon = pass ? '✓ PASS' : '✗ FAIL'
  console.log(`\n${icon}  ${label}`)
  console.log(`  taskType     : ${context.taskType}`)
  console.log(`  requiresPR   : ${context.requiresPR}`)
  console.log(`  requiresCI   : ${context.requiresCI}`)
  console.log(`  complete     : ${analysis.complete}`)
  console.log(`  severity     : ${analysis.severity}`)
  console.log(`  missing      : ${JSON.stringify(analysis.missing)}`)
  if (failures.length) {
    console.log('  FAILURES:')
    for (const f of failures) console.log(f)
  }
  return pass
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture A — BUG REPRODUCTION + FIX
// ────────────────────────────────────────────────────────────────────────────

// Simulates the user task description that triggers the bug.
// Contains "analyze" (research signal) AND "create" (coding action signal)
// AND "notion" + "report" (non-code output markers that the fix uses).
const fixtureAHumanText = `
Produce a market-analysis report comparing the top 3 cloud storage providers.
Analyze pricing, SLA, and compliance. Create a structured Notion page with a summary
table and recommendations. Publish to the team Notion workspace via MCP. Do NOT
modify any production code or repository.
`.trim()

// Simulates the agent's final response — also contains "create/created" which
// previously pushed combinedText into 'coding' taskType.
const fixtureAAgentText = `
I've completed the market-analysis report. I created a comprehensive Notion page at
https://notion.so/team/market-analysis-2024 covering AWS S3, GCS, and Azure Blob with
pricing tables and compliance notes. The analysis is now published and shared.
`.trim()

// NOTE: fixtureA intentionally has NO git commands — it's a pure MCP/Notion task.
const fixtureACommands = [
  'mcp__notion__create_page {"title": "Market Analysis 2024", "parent": "team"}',
  'mcp__notion__update_page {"page_id": "abc123", "content": "..."}',
]

// This is what the LLM judge would return: claims complete, but the assessment
// correctly captures the verification-deferral (Notion URL claim without tool
// evidence that the page actually exists and is populated correctly).
// The LLM IS doing its job on the unproven-claim path; the bug is the system
// ALSO adding false PR/CI gates from the task-type misclassification.
const fixtureAAssessment = {
  task_summary: 'Market analysis report published to Notion',
  task_type: 'research',
  status: 'complete',
  confidence: 0.88,
  evidence: {
    tests: { ran: false, results: 'unknown', ran_after_changes: false, commands: [] },
    build: { ran: false, results: 'unknown' },
    pr: { created: false, url: '', ci_status: 'unknown', checked: false }
  },
  remaining_work: [
    'Verify Notion page was actually created and accessible — URL claim made but no tool confirmation of page content'
  ],
  next_steps: ['Fetch the Notion page to confirm it exists and content is correct'],
  needs_user_action: [],
  stuck: false,
  alternate_approach: ''
}

const fixtureAContext = buildTaskContextMock({
  humanText: fixtureAHumanText,
  agentText: fixtureAAgentText,
  commands: fixtureACommands,
  repoSignals: { hasTestScript: false, hasBuildScript: false, hasTestsDir: false }
})

// ────────────────────────────────────────────────────────────────────────────
// Fixture B — TRUE POSITIVE (code gates must fire)
// ────────────────────────────────────────────────────────────────────────────

const fixtureBHumanText = `
Fix the authentication bug in UserController.js — there's a null pointer exception
when a user session is not initialised. The repo has unit tests. After fixing,
run the tests, commit, and open a PR.
`.trim()

const fixtureBAgentText = `
I've found the bug in UserController.js on line 42. The session object is not guarded.
I've updated the null check. The fix looks correct to me. Stopping here.
`.trim()

// Agent made code changes but ran NO tests and did NOT create a PR.
const fixtureBCommands = [
  'grep -n "session" src/UserController.js',
  'cat src/UserController.js',
  // No npm test, no git commit, no gh pr create
]

// Synthetic self-assessment: agent claims complete even though tests weren't run
// and no PR was created — the gates should catch this.
const fixtureBAssessment = {
  task_summary: 'Fixed null pointer exception in UserController.js',
  task_type: 'bugfix',
  status: 'complete',
  confidence: 0.85,
  evidence: {
    tests: { ran: false, results: 'unknown', ran_after_changes: false, commands: [] },
    build: { ran: false, results: 'unknown' },
    pr: { created: false, url: '', ci_status: 'unknown', checked: false }
  },
  remaining_work: [],
  next_steps: [],
  needs_user_action: [],
  stuck: false,
  alternate_approach: ''
}

const fixtureBContext = buildTaskContextMock({
  humanText: fixtureBHumanText,
  agentText: fixtureBAgentText,
  commands: fixtureBCommands,
  // Repo has tests: npm test script + tests/ directory
  repoSignals: { hasTestScript: true, hasBuildScript: false, hasTestsDir: true }
})

// ────────────────────────────────────────────────────────────────────────────
// Fixture C — CLEAN RESEARCH STOP (no blocking)
// ────────────────────────────────────────────────────────────────────────────

const fixtureCHumanText = `
Research the top 5 Node.js ORM libraries (Prisma, TypeORM, Sequelize, Drizzle, MikroORM)
and write a comparison summary covering performance, TypeScript support, migration tooling,
and ecosystem maturity.
`.trim()

const fixtureCAgentText = `
I've completed the ORM comparison. Summary: Prisma leads on DX and TypeScript integration,
Drizzle on performance and bundle size, TypeORM is mature but verbose. Sequelize is
legacy-friendly, MikroORM has the most advanced Unit-of-Work pattern. Full analysis is
in docs/orm-comparison.md with benchmarks and migration notes.
`.trim()

// No git commands — pure research deliverable to a markdown file.
const fixtureCCommands = [
  'curl https://npmtrends.com/prisma-vs-typeorm',
  'cat docs/orm-comparison.md',
]

const fixtureCAssessment = {
  task_summary: 'ORM comparison research document completed',
  task_type: 'research',
  status: 'complete',
  confidence: 0.95,
  evidence: {
    tests: { ran: false, results: 'unknown', ran_after_changes: false, commands: [] },
    build: { ran: false, results: 'unknown' },
    pr: { created: false, url: '', ci_status: 'unknown', checked: false }
  },
  remaining_work: [],
  next_steps: [],
  needs_user_action: [],
  stuck: false,
  alternate_approach: ''
}

const fixtureCContext = buildTaskContextMock({
  humanText: fixtureCHumanText,
  agentText: fixtureCAgentText,
  commands: fixtureCCommands,
  repoSignals: { hasTestScript: false, hasBuildScript: false, hasTestsDir: false }
})

// ────────────────────────────────────────────────────────────────────────────
// Run fixtures
// ────────────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════')
console.log('  PoC/repro.mjs — PR/CI false-positive gate fix verification')
console.log('═══════════════════════════════════════════════════════════════')

// Also show the raw inferTaskType result so the fix is visible in the output.
console.log('\n── inferTaskType checks ──')
const taskTypeA = inferTaskType(`${fixtureAHumanText} ${fixtureAAgentText}`)
const taskTypeB = inferTaskType(`${fixtureBHumanText} ${fixtureBAgentText}`)
const taskTypeC = inferTaskType(`${fixtureCHumanText} ${fixtureCAgentText}`)
console.log(`  Fixture A (research/Notion report): "${taskTypeA}" (want: research)`)
console.log(`  Fixture B (code/bugfix):            "${taskTypeB}" (want: coding)`)
console.log(`  Fixture C (research/ORM summary):   "${taskTypeC}" (want: research or other)`)

const results = []

results.push(runFixture('Fixture A — Research/Notion task (bug fix: PR/CI gates suppressed, verification-deferral preserved)', {
  context: fixtureAContext,
  assessment: fixtureAAssessment,
  expectations: {
    // taskType must be research after the fix
    // (verified separately via inferTaskType above; also visible in context printout)
    complete: false,                         // incomplete because Notion page unverified
    severity: 'LOW',                         // NOT MEDIUM/HIGH — no test/build/CI flags
    // PR and CI gates must NOT appear in missing
    missing: { _absent: ['Create PR', 'Verify CI', 'CI check', 'PR link', 'PR creation'] },
    // Verification-deferral IS in missing (unproven Notion page)
    missing: [/notion|Verify Notion|actually created/i],
  }
}))

// Extend: also check that PR/CI are absent from the same fixture
// (second assignment to `missing` above wins; add a separate check)
const fixtureAAnalysis = evaluateSelfAssessment(fixtureAAssessment, fixtureAContext)
const fixtureAPRAbsent = !fixtureAAnalysis.missing.some(m =>
  /create pr|pull request|PR link|PR creation|ci check|verify ci/i.test(m)
)
const fixtureANotionPresent = fixtureAAnalysis.missing.some(m =>
  /notion|verify.*created|actually created/i.test(m)
)
if (!fixtureAPRAbsent) {
  console.log('\n  EXTRA CHECK FAIL: PR/CI found in missing when they should be absent')
  results[results.length - 1] = false
}
if (!fixtureANotionPresent) {
  console.log('\n  EXTRA CHECK FAIL: Notion verification-deferral NOT found in missing — must be preserved')
  results[results.length - 1] = false
}
if (fixtureAContext.taskType !== 'research') {
  console.log(`\n  EXTRA CHECK FAIL: taskType is '${fixtureAContext.taskType}' not 'research'`)
  results[results.length - 1] = false
}

results.push(runFixture('Fixture B — Code/bugfix task (true positive: test+PR gates fire)', {
  context: fixtureBContext,
  assessment: fixtureBAssessment,
  expectations: {
    complete: false,
    // Tests and PR must be flagged
    missing: [/Run tests|test suite/i, /Create PR|pull request/i],
  }
}))

results.push(runFixture('Fixture C — Clean research stop (no blocking, complete=true)', {
  context: fixtureCContext,
  assessment: fixtureCAssessment,
  expectations: {
    complete: true,
    severity: 'NONE',
    shouldContinue: false,
  }
}))

// ────────────────────────────────────────────────────────────────────────────
// Final summary
// ────────────────────────────────────────────────────────────────────────────

const allPass = results.every(Boolean)
console.log('\n═══════════════════════════════════════════════════════════════')
console.log(`  Result: ${results.filter(Boolean).length}/${results.length} PASS  ${allPass ? '— ALL PASS ✓' : '— FAILURES DETECTED ✗'}`)
console.log('═══════════════════════════════════════════════════════════════\n')

if (!allPass) process.exit(1)
