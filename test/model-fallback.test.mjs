// Tests: judge session model selection falls back to active session model
// when no model configured in opencode.json or supervisor.yaml
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getLastSessionModelSpec, JUDGE_FREE_FALLBACK, isBlockedJudgeModel } from '../opencode/supervisor-impl.ts';

describe('getLastSessionModelSpec', () => {
  test('returns providerID/modelID from last assistant message', () => {
    const messages = [
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a1', providerID: 'anthropic', modelID: 'claude-opus-4.6' } },
    ];
    assert.equal(getLastSessionModelSpec(messages), 'anthropic/claude-opus-4.6');
  });

  test('returns most recent message with model info', () => {
    const messages = [
      { info: { role: 'assistant', id: 'a1', providerID: 'anthropic', modelID: 'claude-opus-4.6' } },
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a2', providerID: 'github-copilot', modelID: 'gpt-5.3-codex' } },
    ];
    assert.equal(getLastSessionModelSpec(messages), 'github-copilot/gpt-5.3-codex');
  });

  test('returns null when no messages have model info', () => {
    const messages = [
      { info: { role: 'user', id: 'u1' } },
      { info: { role: 'assistant', id: 'a1' } },
    ];
    assert.equal(getLastSessionModelSpec(messages), null);
  });

  test('returns null for empty messages array', () => {
    assert.equal(getLastSessionModelSpec([]), null);
  });

  test('skips messages with empty providerID or modelID', () => {
    const messages = [
      { info: { role: 'assistant', id: 'a1', providerID: '', modelID: 'claude-opus-4.6' } },
      { info: { role: 'assistant', id: 'a2', providerID: 'anthropic', modelID: '' } },
      { info: { role: 'assistant', id: 'a3', providerID: 'anthropic', modelID: 'claude-opus-4.6' } },
    ];
    assert.equal(getLastSessionModelSpec(messages), 'anthropic/claude-opus-4.6');
  });

  test('handles messages without info field', () => {
    const messages = [
      { parts: [{ type: 'text', text: 'hello' }] },
      { info: { role: 'assistant', id: 'a1', providerID: 'anthropic', modelID: 'claude-sonnet-4.6' } },
    ];
    assert.equal(getLastSessionModelSpec(messages), 'anthropic/claude-sonnet-4.6');
  });
});

describe('judge free fallback', () => {
  test('uses the free model ID served by the installed opencode', () => {
    // Regression: the old fallback "opencode/deepseek-v4-flash-free" is not a
    // real model. promptAsync fails server-side, waitForResponse spins for
    // 120s, and the supervisor stands down with no verdict. A flash session
    // model is blocked by isBlockedJudgeModel, so this fallback is the only
    // judge path for those sessions.
    assert.equal(JUDGE_FREE_FALLBACK, 'opencode/deepseek-v4.1-flash-free');
  });

  test('flash session models are blocked, making the fallback path reachable', () => {
    const sessionModel = getLastSessionModelSpec([
      { info: { role: 'assistant', providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' } },
    ]);
    assert.equal(sessionModel, 'opencode/deepseek-v4.1-flash-free');
    assert.equal(isBlockedJudgeModel(sessionModel), true);
  });
});
