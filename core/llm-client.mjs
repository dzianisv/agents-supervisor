/**
 * llm-client.mjs — shared Anthropic HTTP client for supervisor runtimes.
 *
 * Exported:
 *   loadAuth()  → { type: 'apikey'|'oauth', value: string }
 *   callAnthropic({ prompt, system?, model, maxTokens?, timeoutMs?, signal? })
 *       → Promise<{ text: string, usage?: { input_tokens, output_tokens } }>
 *
 * Auth: ANTHROPIC_API_KEY, else Claude Code OAuth (file or macOS keychain).
 */

import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_BETA = 'oauth-2025-04-20';

export function sanitizeError(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  let s = text;
  s = s.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <REDACTED>');
  s = s.replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"<REDACTED>"');
  s = s.replace(/"x-api-key"\s*:\s*"[^"]*"/gi, '"x-api-key":"<REDACTED>"');
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function readOauthCredentials() {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    return JSON.parse(readFileSync(credPath, 'utf8'));
  } catch {
    /* fall through to keychain on macOS */
  }
  if (platform() === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return JSON.parse(out.trim());
    } catch {
      /* no keychain item */
    }
  }
  return null;
}

export function loadAuth() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim()) return { type: 'apikey', value: apiKey.trim() };
  const obj = readOauthCredentials();
  if (!obj) {
    throw new Error(
      'llm-client: no ANTHROPIC_API_KEY set and no Claude Code OAuth credentials found ' +
      '(checked ~/.claude/.credentials.json and the macOS keychain)',
    );
  }
  const token = obj?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('llm-client: OAuth credentials present but missing claudeAiOauth.accessToken');
  return { type: 'oauth', value: token };
}

/**
 * Call the Anthropic Messages API.
 *
 * When `images` is provided and non-empty, the user turn becomes a multimodal
 * content array (text block + one image block per entry) so the judge can SEE
 * delivered media. When absent/empty, the request body is byte-for-byte the
 * legacy single-string form — text-only callers are unaffected.
 *
 * @param {{ prompt: string, system?: string, model: string, maxTokens?: number, timeoutMs?: number, signal?: AbortSignal, images?: Array<{ media_type: string, data: string }> }} opts
 * @returns {Promise<{ text: string, usage?: { input_tokens: number, output_tokens: number } }>}
 */
export async function callAnthropic({ prompt, system, model, maxTokens = 1024, timeoutMs = 30_000, signal, images } = {}) {
  const auth = loadAuth();

  const validImages = Array.isArray(images)
    ? images.filter((img) => img && typeof img.data === 'string' && img.data && typeof img.media_type === 'string')
    : [];
  const content = validImages.length > 0
    ? [
        { type: 'text', text: prompt },
        ...validImages.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.media_type, data: img.data },
        })),
      ]
    : prompt;

  const bodyObj = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  if (system) bodyObj.system = system;
  const body = JSON.stringify(bodyObj);

  const headers = { 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  if (auth.type === 'apikey') {
    headers['x-api-key'] = auth.value;
  } else {
    headers['authorization'] = `Bearer ${auth.value}`;
    headers['anthropic-beta'] = ANTHROPIC_BETA;
  }

  const timeoutController = new AbortController();
  const timerId = setTimeout(() => timeoutController.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => timeoutController.abort(), { once: true });

  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body, signal: timeoutController.signal });
  } catch (err) {
    clearTimeout(timerId);
    if (timeoutController.signal.aborted) {
      throw new Error(`callAnthropic: timed out after ${timeoutMs}ms`);
    }
    throw new Error(`callAnthropic: fetch failed: ${sanitizeError(err.message)}`);
  } finally {
    clearTimeout(timerId);
  }

  if (!res.ok) {
    let errBody;
    try { errBody = await res.text(); } catch { errBody = ''; }
    throw new Error(`callAnthropic: api ${res.status}: ${sanitizeError(errBody)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`callAnthropic: failed to parse response: ${sanitizeError(err.message)}`);
  }

  const text = json.content?.[0]?.text ?? '';
  const usage = json.usage
    ? { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens }
    : undefined;
  return { text, usage };
}
