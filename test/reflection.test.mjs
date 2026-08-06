import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolateTemplate } from '../core/reflection-prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR_DIR = path.join(ROOT, '.agents', 'supervisor');

// --- Sample context for prompt assembly ---
const sampleContext = {
  taskSummary: 'Implement user authentication with JWT tokens',
  taskType: 'feature',
  agentMode: 'build',
  requiresTests: true,
  requiresBuild: true,
  requiresPR: false,
  requiresCI: false,
  requiresLocalTests: false,
  pushedToDefaultBranch: false,
  detectedSignals: ['npm test', 'git commit'],
  toolsSummary: 'bash: npm test → pass\nbash: git add . && git commit -m "feat: auth"',
};

// ============================================================
// 1. Template interpolation unit tests
// ============================================================
describe('interpolateTemplate', () => {
  test('simple variable replacement', () => {
    assert.equal(interpolateTemplate('Hello {{name}}!', { name: 'world' }), 'Hello world!');
  });

  test('missing variable → empty string', () => {
    assert.equal(interpolateTemplate('Hello {{name}}!', {}), 'Hello !');
  });

  test('conditional section present → rendered', () => {
    const tpl = '{{#show}}visible: {{val}}{{/show}}';
    assert.equal(interpolateTemplate(tpl, { show: 'yes', val: 'data' }), 'visible: data');
  });

  test('conditional section absent → removed', () => {
    const tpl = 'before{{#show}} hidden {{/show}}after';
    assert.equal(interpolateTemplate(tpl, {}), 'beforeafter');
  });

  test('multiple sections and variables', () => {
    const tpl = '{{a}} {{#b}}(b={{b}}){{/b}} {{#c}}(c){{/c}} end';
    assert.equal(interpolateTemplate(tpl, { a: 'X', b: 'Y' }), 'X (b=Y)  end');
  });

  test('nested variable inside conditional uses outer vars', () => {
    const tpl = '{{#active}}attempt {{num}}/{{max}}{{/active}}';
    assert.equal(
      interpolateTemplate(tpl, { active: 'true', num: '2', max: '5' }),
      'attempt 2/5'
    );
  });
});

// ============================================================
// 2. File presence tests
// ============================================================
describe('reflection files exist', () => {
  test('SystemPrompt.md exists with expected markers', () => {
    const content = fs.readFileSync(path.join(SUPERVISOR_DIR, 'SystemPrompt.md'), 'utf-8');
    // The judge's context is the plain alternating conversation and nothing
    // else: {{currentTask}} / {{priorContext}} / {{turnEvidence}} /
    // {{toolsSummary}} were all replaced by {{conversationChain}}.
    assert.ok(content.includes('{{conversationChain}}'), 'missing {{conversationChain}} placeholder');
    assert.ok(content.includes('## Conversation'), 'missing Conversation section');
    assert.ok(content.includes('## Task Context'), 'missing Task Context section');
    assert.ok(content.includes('## Response Format'), 'missing Response Format section');
    // Tool data must never reach the judge again.
    assert.ok(!content.includes('{{toolsSummary}}'), 'tool commands must not be judge input');
    assert.ok(!content.includes('{{turnEvidence}}'), 'turn evidence must not be judge input');
    assert.ok(!content.includes('{{toolActivityNote}}'), 'tool activity must not be judge input');
  });

  test('Patterns.md exists with patterns section', () => {
    const content = fs.readFileSync(path.join(SUPERVISOR_DIR, 'Patterns.md'), 'utf-8');
    assert.ok(content.includes('## Patterns') || content.includes('# Patterns'), 'missing Patterns section');
  });

  test('User.md exists', () => {
    assert.ok(fs.existsSync(path.join(SUPERVISOR_DIR, 'User.md')), 'User.md missing');
  });
});

// ============================================================
// 3. Prompt assembly test
// ============================================================
describe('prompt assembly', () => {
  test('assembled prompt contains expected content and no unresolved vars', () => {
    const systemPrompt = fs.readFileSync(path.join(SUPERVISOR_DIR, 'SystemPrompt.md'), 'utf-8');
    const patterns = fs.readFileSync(path.join(SUPERVISOR_DIR, 'Patterns.md'), 'utf-8');
    const user = fs.readFileSync(path.join(SUPERVISOR_DIR, 'User.md'), 'utf-8');

    // Build template vars (same logic as buildReflectionPromptFromFiles)
    const requirements = [];
    if (sampleContext.requiresTests) requirements.push('Tests required');
    if (sampleContext.requiresBuild) requirements.push('Build required');
    if (requirements.length === 0) requirements.push('No explicit workflow gates');

    const vars = {
      taskSummary: sampleContext.taskSummary,
      currentTask: sampleContext.taskSummary,
      conversationChain: `user:\n${sampleContext.taskSummary}\n\nassistant:\nI have completed the authentication implementation.`,
      taskType: sampleContext.taskType,
      agentMode: sampleContext.agentMode,
      requirements: requirements.join('; '),
      signals: sampleContext.detectedSignals.join(', '),
      lastAssistantText: 'I have completed the authentication implementation.',
      attemptSection: undefined, // first attempt
      attemptNumber: '1',
      maxAttempts: '3',
      projectInstructions: undefined,
      goalSection: undefined,
    };

    const interpolated = interpolateTemplate(systemPrompt, vars);
    const assembled = [interpolated, patterns, user].join('\n\n');

    // Contains context from vars
    assert.ok(assembled.includes('Implement user authentication with JWT tokens'), 'task summary missing');
    assert.ok(assembled.includes('feature'), 'task type missing');
    assert.ok(assembled.includes('npm test, git commit'), 'signals missing');
    assert.ok(assembled.includes('Tests required'), 'requirements missing');

    // Contains patterns
    assert.ok(assembled.includes('Patterns') || assembled.includes('patterns'), 'patterns content missing');

    // Contains response format
    assert.ok(assembled.includes('"task_summary"'), 'response format JSON schema missing');

    // No unresolved simple {{var}} placeholders (conditionals are ok to be removed)
    const unresolved = assembled.match(/\{\{[a-zA-Z]\w*\}\}/g);
    assert.equal(unresolved, null, `unresolved placeholders: ${JSON.stringify(unresolved)}`);
  });

  test('conditional sections omitted when vars absent', () => {
    const systemPrompt = fs.readFileSync(path.join(SUPERVISOR_DIR, 'SystemPrompt.md'), 'utf-8');
    const vars = {
      taskSummary: 'test',
      taskType: 'bugfix',
      agentMode: 'build',
      requirements: 'none',
      signals: 'none',
      conversationChain: 'user:\nfix it\n\nassistant:\ndone',
      // Deliberately omitting: attemptSection, projectInstructions, goalSection
    };

    const result = interpolateTemplate(systemPrompt, vars);
    assert.ok(!result.includes('Supervisor History'), 'attempt section should be hidden');
    assert.ok(!result.includes('Project Instructions'), 'project instructions should be hidden');
    assert.ok(!result.includes('Goal (mandatory'), 'goal section should be hidden');
  });

  test('conditional sections shown when vars present', () => {
    const systemPrompt = fs.readFileSync(path.join(SUPERVISOR_DIR, 'SystemPrompt.md'), 'utf-8');
    const vars = {
      taskSummary: 'test',
      taskType: 'bugfix',
      agentMode: 'build',
      requirements: 'Tests required',
      signals: 'npm test',
      conversationChain: 'user:\nfix it\n\nassistant:\nDone with the fix.',
      attemptSection: 'true',
      attemptNumber: '2',
      maxAttempts: '5',
      projectInstructions: 'Always run lint before committing.',
      goalSection: 'All tests must pass.',
    };

    const result = interpolateTemplate(systemPrompt, vars);
    assert.ok(result.includes('Done with the fix.'), 'conversation chain content missing');
    assert.ok(result.includes('attempt 2/5'), 'attempt numbers missing');
    assert.ok(result.includes('Always run lint'), 'project instructions missing');
    assert.ok(result.includes('All tests must pass'), 'goal section missing');
  });
});

// ============================================================
// 4. Fallback logic test
// ============================================================
describe('fallback behavior', () => {
  test('missing SystemPrompt.md means files are not loadable', () => {
    const tmpDir = path.join(ROOT, '.test-tmp-no-files');
    const missingPath = path.join(tmpDir, '.agents', 'supervisor', 'SystemPrompt.md');
    assert.ok(!fs.existsSync(missingPath), 'temp dir should not have SystemPrompt.md');
    // The actual buildReflectionPromptFromFiles checks for null return from tryRead
    // and falls back to buildSelfAssessmentPrompt. We verify the pattern here.
  });
});

// ============================================================
// 5. Structural equivalence: old prompt sections → new template
// ============================================================
describe('structural equivalence with old buildSelfAssessmentPrompt', () => {
  const systemPrompt = fs.readFileSync(path.join(SUPERVISOR_DIR, 'SystemPrompt.md'), 'utf-8');

  // The old buildSelfAssessmentPrompt had these required sections:
  const requiredSections = [
    ['Task Context', /## Task Context/],
    // Was {{taskSummary}} — the whole "[1]..[n]" session history; then the
    // currentTask/priorContext/turnEvidence split. Both are gone: the judge's
    // context is now the plain alternating conversation (core/task-context.mjs).
    ['Conversation section', /## Conversation/],
    ['Conversation chain var', /\{\{conversationChain\}\}/],
    ['Task Type var', /\{\{taskType\}\}/],
    ['Agent Mode var', /\{\{agentMode\}\}/],
    ['Requirements var', /\{\{requirements\}\}/],
    ['Signals var', /\{\{signals\}\}/],
    ['Attempt section (conditional)', /attemptSection/],
    ['Project Instructions (conditional)', /projectInstructions/],
    ['Goal section (conditional)', /goalSection/],
    ['Response Format', /## Response Format/],
    ['JSON schema with task_summary', /"task_summary"/],
    ['JSON schema with status', /"status"/],
    ['JSON schema with evidence', /"evidence"/],
    ['JSON schema with remaining_work', /"remaining_work"/],
    ['JSON schema with next_steps', /"next_steps"/],
    ['JSON schema with stuck', /"stuck"/],
  ];

  for (const [label, pattern] of requiredSections) {
    test(`template contains: ${label}`, () => {
      assert.ok(pattern.test(systemPrompt), `missing: ${label}`);
    });
  }
});
