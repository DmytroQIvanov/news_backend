#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createHash } = require('node:crypto');
const { readWav, analyze, sliceWav, silenceSettings } = require('./tts-batch/audio.cjs');
const { reportHtml } = require('./tts-batch/report.cjs');
const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function validateSegments(segments) {
  if (!Array.isArray(segments) || ![3, 6].includes(segments.length)) throw new Error('Input must contain exactly 3 or 6 segments');
  const ids = new Set();
  for (const s of segments) {
    if (!s || typeof s.id !== 'string' || !s.id.trim() || ids.has(s.id) || typeof s.text !== 'string' || s.text.trim().split(/\s+/u).length < 8 || /[<>]/u.test(s.text)) throw new Error('Segments need unique IDs and at least 8 words of plain text (no inline tags)');
    ids.add(s.id);
  }
  if (segments.reduce((n, s) => n + s.text.length, 0) > 16000) throw new Error('Batch text exceeds the 16000 character experiment cap');
  return segments;
}

async function prepare(args) {
  const model = args.model || 'gemini-3.8-flash-tts';
  if (!['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].includes(model)) throw new Error('This experiment uses documented 3.8 pause tags; select a 3.8 TTS model explicitly');
  let input;
  if (args.input) input = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));
  else if (args['from-db']) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
    const { Client } = require('pg');
    const { NEWS_ELIGIBILITY_SQL } = require('../dist/news/eligibility.js');
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
    try {
      await client.connect();
      const { rows } = await client.query(`SELECT n.id::text, n.title_uk AS "titleUk", n.original_title AS "originalTitle",
        n.summary_uk AS "summaryUk", n.original_summary AS "originalSummary", n.why_it_matters AS "whyItMatters",
        COALESCE(n.ai_metadata->>'briefing_script', n.ai_metadata->'article'->>'briefing_script') AS "briefingScript",
        s.name AS "sourceName" FROM news_items n JOIN sources s ON s.id = n.source_id
        WHERE ${NEWS_ELIGIBILITY_SQL} AND NULLIF(btrim(n.summary_uk), '') IS NOT NULL
        ORDER BY n.published_at DESC NULLS LAST, n.id DESC LIMIT 2`);
      input = { articles: rows };
    } finally { await client.end(); }
  } else throw new Error('Use --input FILE or --from-db');
  if (!input.segments) {
    if (!Array.isArray(input.articles) || ![1, 2].includes(input.articles.length)) throw new Error('Expected one or two articles');
    const { buildBroadcastScriptUk } = require('../dist/news/news-tts.service.js');
    const modes = [['global_brief', 'headline_flash'], ['balanced', 'podcast_story'], ['deep_technical', 'analyst_brief']];
    input.segments = input.articles.flatMap((a, i) => modes.map(([depth, style]) => ({ id: `${a.id || i + 1}/${style}`, text: buildBroadcastScriptUk(a, { depth, style }) })));
  }
  const segments = validateSegments(input.segments);
  const transcript = segments.map(s => s.text.trim()).join('\n<long pause>\n');
  const request = { model, input: [{ type: 'user_input', content: [{ type: 'text', text: transcript }] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: args.voice || 'Kore' }] }, store: false };
  return { version: 1, createdAt: new Date().toISOString(), model, voice: args.voice || 'Kore', segments, transcript, request, sha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
}

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }

async function generate(dir, manifest) {
  validateSegments(manifest.segments);
  if (!['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].includes(manifest.model) || manifest.request?.model !== manifest.model || createHash('sha256').update(JSON.stringify(manifest.request)).digest('hex') !== manifest.sha256) throw new Error('Prepared request integrity check failed; prepare a new run');
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing; no request was sent');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the shared quota ledger');
  const { reserveLlmCall, refundLlmCall, recordLlmTokens } = require('../dist/common/llm-budget.js');
  const purpose = 'tts_batch_lab';
  // Reserve before writing the attempt marker. Failed/reserved attempts are never retried automatically.
  if (!(await reserveLlmCall(manifest.model, purpose))) throw new Error('Shared model quota unavailable; no request was sent');
  try { fs.writeFileSync(path.join(dir, 'attempt.json'), JSON.stringify({ at: new Date().toISOString(), model: manifest.model, requests: 1 }), { flag: 'wx' }); }
  catch (e) { await refundLlmCall(manifest.model, purpose); throw e; }
  console.log('Sending ONE TTS request; no retries and no model fallback.');
  const startedAt = Date.now();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(manifest.request), signal: AbortSignal.timeout(240000), redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429 || response.status >= 500) await refundLlmCall(manifest.model, purpose);
    // Do not write upstream response bodies: they may echo credentials or request headers.
    throw new Error(`Gemini returned HTTP ${response.status}; no retry was made`);
  }
  // Bound the response BEFORE JSON/base64 decoding, including chunked responses.
  const reader = response.body.getReader(), chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 90 * 1024 * 1024) throw new Error('TTS response exceeds the 90 MiB cap');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  writeJson(path.join(dir, 'response-meta.json'), { latencyMs: Date.now() - startedAt, responseBytes: received, model: manifest.model });
  const audios = (body.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'audio' && c.data);
  const audio = body.output_audio || (audios.length === 1 ? audios[0] : null);
  if (!audio?.data) throw new Error('Expected one complete audio block; unsupported response. No retry was made.');
  if (audio.data.length > 90 * 1024 * 1024) throw new Error('Audio exceeds experiment size cap');
  const buffer = Buffer.from(audio.data, 'base64');
  // Always preserve returned bytes before parsing or splitting.
  fs.writeFileSync(path.join(dir, 'response-audio.bin'), buffer);
  readWav(buffer);
  fs.renameSync(path.join(dir, 'response-audio.bin'), path.join(dir, 'original.wav'));
  writeJson(path.join(dir, 'usage.json'), body.usage || body.usage_metadata || {});
  const usage = body.usage || {};
  await recordLlmTokens(manifest.model, purpose, usage.total_input_tokens || 0, usage.total_output_tokens || 0);
}

function analyzeRun(dir, args) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  validateSegments(manifest.segments);
  const file = path.join(dir, 'original.wav');
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('Audio exceeds the 64 MiB cap');
  const audio = readWav(fs.readFileSync(file));
  const result = analyze(audio, manifest.segments, { thresholdDb: args['threshold-db'] === undefined ? undefined : Number(args['threshold-db']), minSilenceSec: args['min-silence'] === undefined ? undefined : Number(args['min-silence']) });
  // Each analysis has its own directory, so changed settings never leave stale clip files.
  const out = path.join(dir, `analysis-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(out);
  // Hard link avoids storing another full recording for every threshold experiment.
  fs.linkSync(file, path.join(out, 'original.wav'));
  for (const clip of result.clips) fs.writeFileSync(path.join(out, `${String(clip.index).padStart(2, '0')}.wav`), sliceWav(audio, clip.start, clip.end));
  writeJson(path.join(out, 'report.json'), result);
  fs.writeFileSync(path.join(out, 'index.html'), reportHtml(manifest, result));
  console.log(`${result.status}\nReview directory: ${out}`);
  return out;
}

function serve(dir, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid HTTP port');
  const server = require('node:http').createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !/^(?:index\.html|report\.json|original\.wav|0[1-6]\.wav)$/.test(name)) { res.writeHead(404).end(); return; }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8', 'Content-Length': fs.statSync(file).size, 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Review: http://127.0.0.1:${port} (use SSH port forwarding from the server)`));
}

async function main() {
  const { values: args } = parseArgs({ options: { help: { type: 'boolean' }, input: { type: 'string' }, 'from-db': { type: 'boolean' }, model: { type: 'string' }, voice: { type: 'string' }, generate: { type: 'boolean' }, run: { type: 'string' }, analyze: { type: 'string' }, serve: { type: 'string' }, port: { type: 'string' }, out: { type: 'string' }, 'threshold-db': { type: 'string' }, 'min-silence': { type: 'string' } } });
  if (args.help) { console.log('Prepare: node scripts/tts-batch-lab.cjs --from-db [--generate] [--out NEW_DIR]\nGenerate the exact prepared texts: --run RUN_DIR --generate\nAnalyze existing WAV without API calls: --analyze RUN_DIR [--threshold-db=-42] [--min-silence 1.2]\nReview: --serve ANALYSIS_DIR [--port 8791]\nInput JSON: {articles:[{id,titleUk,summaryUk,...},...]} or {segments:[{id,text},...]} (3 or 6 segments).'); return; }
  silenceSettings({ thresholdDb: args['threshold-db'] === undefined ? undefined : Number(args['threshold-db']), minSilenceSec: args['min-silence'] === undefined ? undefined : Number(args['min-silence']) });
  if ([args.serve, args.analyze, args.run].filter(Boolean).length > 1 || (args.input && args['from-db'])) throw new Error('Choose only one mode and one input source');
  if (args.serve) { serve(path.resolve(args.serve), Number(args.port || 8791)); return; }
  if (args.analyze) { analyzeRun(path.resolve(args.analyze), args); return; }
  if (args.run && !args.generate) throw new Error('Generating a prepared run requires --run RUN_DIR --generate');
  const manifest = args.run ? JSON.parse(fs.readFileSync(path.resolve(args.run, 'manifest.json'), 'utf8')) : await prepare(args);
  const dir = args.run ? path.resolve(args.run) : path.resolve(args.out || path.join(ROOT, 'backups/tts-batch-lab', new Date().toISOString().replace(/[:.]/g, '-')));
  if (!args.run) {
    fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.mkdirSync(dir);
    writeJson(path.join(dir, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(dir, 'transcript.txt'), manifest.transcript);
  }
  console.log(`Prepared ${manifest.segments.length} segments: ${dir}`);
  if (!args.generate) { console.log('Preparation only: ZERO API calls. Generate this exact manifest with --run RUN_DIR --generate.'); return; }
  try { await generate(dir, manifest); analyzeRun(dir, args); }
  catch (e) { writeJson(path.join(dir, 'failure.json'), { at: new Date().toISOString(), message: String(e.message).split(process.env.GEMINI_API_KEY || '\0').join('[redacted]') }); throw e; }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { validateSegments, prepare, generate, analyzeRun, main };
