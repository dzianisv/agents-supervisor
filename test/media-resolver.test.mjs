import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanTranscriptForMedia,
  collectDeliveredMedia,
  tryExtractVideoFrame,
} from '../bin/supervisor-on-stop.mjs';
import { callAnthropic } from '../core/llm-client.mjs';

// A synthetic CC transcript tail: the agent delivered install.mp4 via
// SendUserFile and reported a passing test-result JSON, while the goal demands
// video proof. Before this fix the tool-less judge saw only text and could
// false-reject on "missing media".
function makeTranscriptTail(videoPath) {
  return [
    {
      type: 'user',
      message: { content: [{ type: 'text', text: 'Record a video proof of the extension installing and deliver install.mp4.' }] },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Recorded the install flow. Test result: {"OVERALL passed": True}. Delivering the video now.' },
          { type: 'tool_use', name: 'SendUserFile', input: { path: videoPath, file_uuid: 'abc-123-uuid' } },
        ],
      },
    },
  ];
}

describe('delivered-media resolver', () => {
  test('scanTranscriptForMedia finds the video path, receipt uuid, and passing-test evidence', () => {
    const { paths, receipts, testEvidence } = scanTranscriptForMedia(makeTranscriptTail('/deliver/install.mp4'));
    assert.ok(paths.some((p) => p.path === '/deliver/install.mp4'), 'video path collected');
    assert.ok(receipts.some((r) => r.file_uuid === 'abc-123-uuid'), 'SendUserFile receipt captured');
    assert.match(testEvidence ?? '', /OVERALL[^\n]*passed[^\n]*True/i);
  });

  test('video without ffmpeg → no image block, but a note surfacing delivery + pass proof (false-reject fixed)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
    const videoPath = path.join(dir, 'install.mp4');
    fs.writeFileSync(videoPath, Buffer.from('not-a-real-mp4-but-on-disk'));

    // Inject a runner that simulates ffmpeg being unavailable / failing.
    const media = collectDeliveredMedia(makeTranscriptTail(videoPath), dir, { runFfmpeg: () => false });

    assert.equal(media.images.length, 0, 'no image inlined when ffmpeg fails');
    assert.ok(media.note, 'a text note is produced instead of silence');
    assert.match(media.note, /install\.mp4/, 'note lists the delivered video artifact');
    assert.match(media.note, /OVERALL[^\n]*passed[^\n]*True/i, 'note carries passing-test evidence');
    assert.match(media.note, /VALID proof/i, 'note tells the judge delivery+pass is valid proof');
    assert.match(media.note, /Do NOT ask the agent to base64/i, 'note explicitly forbids inlining media');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('video WITH a working ffmpeg → attaches an extracted frame as an image block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
    const videoPath = path.join(dir, 'install.mp4');
    fs.writeFileSync(videoPath, Buffer.from('video'));
    // Fake runner writes a "frame" png to the requested output path.
    const runFfmpeg = (_input, out) => { fs.writeFileSync(out, Buffer.from('fake-png-bytes')); return true; };
    const media = collectDeliveredMedia(makeTranscriptTail(videoPath), dir, { runFfmpeg });
    assert.equal(media.images.length, 1, 'one extracted frame attached');
    assert.equal(media.images[0].media_type, 'image/png');
    assert.ok(media.images[0].data.length > 0, 'frame is base64-encoded');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('delivered PNG on disk is inlined as a base64 image block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
    const pngPath = path.join(dir, 'shot.png');
    fs.writeFileSync(pngPath, Buffer.from('pretend-png'));
    const tail = [{
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'SendUserFile', input: { path: pngPath } }] },
    }];
    const media = collectDeliveredMedia(tail, dir, {});
    assert.equal(media.images.length, 1);
    assert.equal(media.images[0].media_type, 'image/png');
    assert.equal(Buffer.from(media.images[0].data, 'base64').toString(), 'pretend-png');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a merely-MENTIONED on-disk file (not SendUserFile-delivered) is NOT read or inlined', () => {
    // Security: the agent runs `ls` and its output mentions an unrelated image
    // sitting next to real work. That file must never be shipped to the judge.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
    const secret = path.join(dir, 'confidential-invoice.png');
    fs.writeFileSync(secret, Buffer.from('SECRET-BYTES-DO-NOT-EXFILTRATE'));
    const tail = [{
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', content: `report.txt\nconfidential-invoice.png\n` },
        ],
      },
    }];
    const scan = scanTranscriptForMedia(tail);
    assert.ok(scan.paths.some((p) => p.path.endsWith('confidential-invoice.png')), 'path is recorded');
    assert.ok(!scan.paths.find((p) => p.path.endsWith('confidential-invoice.png'))?.delivered, 'but flagged NOT delivered');
    const media = collectDeliveredMedia(tail, dir, {});
    assert.equal(media.images.length, 0, 'mentioned-but-undelivered file is never inlined');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('off-disk paths are skipped and produce no images (pure fallback)', () => {
    const media = collectDeliveredMedia(makeTranscriptTail('/nope/missing.mp4'), '/nonexistent-cwd', { runFfmpeg: () => false });
    assert.equal(media.images.length, 0);
    // The SendUserFile receipt still surfaces as proof-of-delivery.
    assert.match(media.note ?? '', /file_uuid=abc-123-uuid/);
  });
});

describe('callAnthropic multimodal body', () => {
  test('images present → content is a text+image array; absent → single string', async () => {
    const origFetch = global.fetch;
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const captured = [];
    global.fetch = async (_url, opts) => {
      captured.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ content: [{ text: '{"status":"complete"}' }], usage: { input_tokens: 1, output_tokens: 1 } }) };
    };
    try {
      await callAnthropic({ prompt: 'hi', model: 'claude-opus-4-8' });
      await callAnthropic({ prompt: 'look', model: 'claude-opus-4-8', images: [{ media_type: 'image/png', data: 'QUJD' }] });
    } finally {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = origKey;
    }
    // Text-only: content stays a plain string (no behavior change).
    assert.equal(typeof captured[0].messages[0].content, 'string');
    // Multimodal: content becomes [text, image] blocks.
    const content = captured[1].messages[0].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].source.type, 'base64');
    assert.equal(content[1].source.media_type, 'image/png');
    assert.equal(content[1].source.data, 'QUJD');
  });
});

// Smoke: the real ffmpeg-backed extractor returns null (not throw) when the
// input is not a valid video / ffmpeg is absent — proves the fallback path.
test('tryExtractVideoFrame returns null on invalid input without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  const bogus = path.join(dir, 'bogus.mp4');
  fs.writeFileSync(bogus, Buffer.from('definitely-not-a-video'));
  const out = tryExtractVideoFrame(bogus, () => false); // force "ffmpeg unavailable"
  assert.equal(out, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
