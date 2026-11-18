import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { readWav, wav, analyze, sliceWav } = require('../scripts/tts-batch/audio.cjs');
const { validateSegments, prepare, generate, analyzeRun } = require('../scripts/tts-batch-lab.cjs');
const { reportHtml } = require('../scripts/tts-batch/report.cjs');
const segments = count => Array.from({ length: count }, (_, i) => ({ id: `part-${i}`, text: 'Один два три чотири п’ять шість сім вісім дев’ять десять.' }));
function recording(count, gaps = [], channels = 1) {
  const rate = 8000, chunks = [];
  for (let i = 0; i < count; i++) {
    const pcm = Buffer.alloc(rate * 4 * channels * 2);
    for (let s = 0; s < rate * 4; s++) for (let c = 0; c < channels; c++) pcm.writeInt16LE(Math.round(5000 * Math.sin(s * 2 * Math.PI * 200 / rate)), (s * channels + c) * 2);
    chunks.push(pcm);
    if (i < count - 1) chunks.push(Buffer.alloc(Math.round(rate * (gaps[i] ?? 1.6)) * channels * 2));
  }
  return wav(Buffer.concat(chunks), rate, channels);
}

test('six recordings: five pauses, sample-aligned cuts, 150ms speech margins', () => {
  const audio = readWav(recording(6, [], 2)), result = analyze(audio, segments(6));
  assert.equal(result.status, 'candidate_cuts_need_listening');
  assert.equal(result.semanticVerified, false);
  assert.equal(result.clips.length, 6);
  for (const clip of result.clips) {
    const cut = readWav(sliceWav(audio, clip.start, clip.end));
    assert.equal(cut.channels, 2);
    assert.ok(cut.duration >= 4 && cut.duration <= 4.31);
  }
  assert.equal(result.clips[0].start, 0);
  assert.equal(result.clips.at(-1).end, audio.duration);
});

test('missing and extra pauses never produce guessed cuts', () => {
  assert.equal(analyze(readWav(recording(3, [0.4, 1.6])), segments(3)).clips.length, 0);
  assert.equal(analyze(readWav(recording(4)), segments(3)).clips.length, 0);
  assert.equal(analyze(readWav(wav(Buffer.alloc(8000 * 2 * 10), 8000)), segments(3)).clips.length, 0);
});

test('implausible duration and malformed/unsupported WAV fail safely', () => {
  const items = segments(3); items[1].text = Array(200).fill('слово').join(' ');
  assert.equal(analyze(readWav(recording(3)), items).clips.length, 0);
  const truncated = recording(3).subarray(0, 100);
  assert.throws(() => readWav(truncated), /Truncated/);
  const bad = recording(3); bad.writeUInt16LE(3, 20);
  assert.throws(() => readWav(bad), /PCM/);
  assert.throws(() => analyze(readWav(recording(3)), items, { thresholdDb: NaN }), /settings/);
  assert.throws(() => validateSegments([...segments(3), ...segments(3)]), /unique/);
});

test('prepare is offline; HTML escapes transcript and never claims semantic verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-lab-'));
  try {
    const items = segments(3); items[0].text += ' & "цитата"';
    const file = path.join(dir, 'input.json'); fs.writeFileSync(file, JSON.stringify({ segments: items }));
    const manifest = await prepare({ input: file });
    assert.equal(manifest.transcript.match(/<long pause>/g).length, 2);
    assert.equal(manifest.request.input[0].content[0].text, manifest.transcript);
    assert.equal(manifest.request.store, false);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'original.wav'), recording(3));
    const out = analyzeRun(dir, {});
    assert.ok(fs.existsSync(path.join(out, '03.wav')));
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    const html = reportHtml({ ...manifest, model: '</script><img src=x>' }, analyze(readWav(recording(3)), items));
    assert.ok(!html.includes('</script><img'));
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one HTTP attempt, quota accounting, original survives, failures never retry', async () => {
  const budget = require('../dist/common/llm-budget.js');
  const saved = { reserve: budget.reserveLlmCall, refund: budget.refundLlmCall, tokens: budget.recordLlmTokens, fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY, db: process.env.DATABASE_URL };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-http-'));
  let requests = 0, reservations = 0, refunds = 0;
  try {
    process.env.GEMINI_API_KEY = 'fixture-key'; process.env.DATABASE_URL = 'fixture-db';
    budget.reserveLlmCall = async () => { reservations++; return true; };
    budget.refundLlmCall = async () => { refunds++; };
    budget.recordLlmTokens = async () => {};
    const bytes = recording(3);
    globalThis.fetch = async (url, opts) => {
      requests++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
      assert.equal(opts.headers['x-goog-api-key'], 'fixture-key');
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: bytes.toString('base64') }] }] }), { status: 200 });
    };
    const request = { model: 'gemini-3.8-flash-tts' };
    const manifest = { model: request.model, request, segments: segments(3), sha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
    await generate(dir, manifest);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'original.wav')), bytes);
    await assert.rejects(generate(dir, manifest), /EEXIST/);
    assert.equal(requests, 1); assert.equal(reservations, 2); assert.equal(refunds, 1);
    const failedDir = path.join(dir, 'failed'); fs.mkdirSync(failedDir);
    globalThis.fetch = async () => { requests++; return new Response('{}', { status: 429 }); };
    await assert.rejects(generate(failedDir, manifest), /HTTP 429/);
    assert.equal(requests, 2); assert.equal(refunds, 2);
    assert.ok(fs.existsSync(path.join(failedDir, 'attempt.json')));
  } finally {
    budget.reserveLlmCall = saved.reserve; budget.refundLlmCall = saved.refund; budget.recordLlmTokens = saved.tokens; globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
    if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
