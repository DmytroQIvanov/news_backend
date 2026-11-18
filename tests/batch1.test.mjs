import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import quotaFixture from './quota-ledger.cjs';
const require = createRequire(import.meta.url);
const { eligibleNews, sourceCounts, NEWS_ELIGIBILITY_SQL, publicationReadySql } = require('../dist/news/eligibility.js');
const { KbEditorialService } = require('../dist/kb/kb-editorial.service.js');
const { KbTranslationService } = require('../dist/kb/kb-translation.service.js');
const { eventReviews, reviewApproved } = require('../dist/kb/kb-review.js');
const { PipelineDiagnostics, workerState } = require('../dist/health/pipeline-diagnostics.js');

const source = (host, extra = {}) => ({ url: `https://${host}/report`, ...extra });
const valid = { status: 'published', ai_generated: true, cluster_sources: [source('a.example'), source('b.example')] };

test('P01: raw, rejected, duplicate, syndicated, unusable and one-origin KB articles fail the shared policy', () => {
  const fixtures = [
    { ...valid, ai_generated: false },
    { ...valid, status: 'rejected' },
    { ...valid, cluster_sources: [source('a.example'), source('www.a.example')] },
    { ...valid, cluster_sources: [source('a.example', { evidenceRoot: 'reuters' }), source('b.example', { evidenceRoot: 'reuters' })] },
    { ...valid, cluster_sources: [source('a.example'), source('b.example', { extraction: 'blocked' })] },
    { ...valid, cluster_sources: [source('a.example'), { url: 'not-a-url' }] },
    { ...valid, kb_event_id: 1, kbIndependentSources: 1, cluster_sources: [source('a.example')] },
    valid,
    { ...valid, kbIndependentSources: 2, cluster_sources: [] },
  ];
  assert.deepEqual(fixtures.map(eligibleNews), [false, false, false, false, false, false, false, true, true]);
  assert.deepEqual(sourceCounts([source('a.example'), source('a.example', { evidenceRoot: 'other' })]), { documentCount: 1, independentOrigins: 1 });
  assert.deepEqual(sourceCounts([source('a.example'), source('a.example', { url: 'https://a.example/another' })]), { documentCount: 2, independentOrigins: 1 });
});

test('P01: feed, briefs, topics, cached top stories and audio readers issue the identical SQL gate', async () => {
  const { NewsController } = require('../dist/news/news.controller.js');
  const { ObjectivityController } = require('../dist/news/objectivity.controller.js');
  const { TopicsService } = require('../dist/news/topics.service.js');
  const { StoryBriefingService } = require('../dist/news/story-briefing.service.js');
  const { AudioBriefingService } = require('../dist/news/audio-briefing.service.js');
  const sql = [];
  const db = { query: async (q) => { sql.push(q); return { rows: [], rowCount: 0 }; } };
  const news = new NewsController(db, { list: () => { throw Error('raw RSS must stay disabled'); } });
  process.env.FEED_RAW_RSS = 'true';
  await news.list();
  delete process.env.FEED_RAW_RSS;
  await new ObjectivityController(db, {}).dailyBrief('en');
  const topics = new TopicsService(db);
  await topics.list('en');
  await topics.get('a-topic', 'en');
  const stories = new StoryBriefingService(db);
  await stories.list(5, 'en');
  await stories.get('a-cluster', 'en');
  await stories.getForNews('1', 'en');
  const audio = new AudioBriefingService(db);
  await audio.playlist('en', 5, '');
  await audio.findReady('1', 'en', 'standard', 'neutral');
  assert.ok(sql.length >= 7);
  for (const q of sql) assert.ok(q.includes(NEWS_ELIGIBILITY_SQL), q);
  await assert.rejects(news.publish(9));
  assert.ok(sql.at(-1).includes(publicationReadySql()));
  assert.match(sql.at(-1), /status='needs_review'/);
});

function article() {
  return { event_id: 1, title: 'Confirmed independent reporting', summary: 'Two independent outlets reported the development.',
    body: `${'Supported reporting gives readers useful context. '.repeat(52)}[D1] [D2]`,
    importance_reason: 'Independent corroboration matters.', important: false, category: 'other', confidence: 'high', facts: [] };
}
function dossier() {
  return { event: { id: 1, title: 'Event', summary: 'Summary', independentSources: 2 }, hash: 'dossier-hash',
    docs: ['a.example', 'b.example'].map((host, i) => ({ ref: `D${i + 1}`, documentId: i + 1, title: 'Reporting',
      url: `https://${host}/report`, sourceName: host, sourceSlug: host, extraction: 'full', evidenceRoot: host, excerpt: 'Supported reporting' })),
    facts: [], background: [], linked: [], quotes: [], entities: [], contradictions: [], storyline: null };
}
function publisherDb(currentStatus) {
  const queries = [];
  const db = { query: async (sql, args = []) => {
    queries.push({ sql, args });
    if (sql.startsWith('SELECT source_id')) return { rows: [{ source_id: 'source-1' }] };
    if (sql.startsWith('SELECT status')) return { rows: [{ status: currentStatus }] };
    if (sql.includes('INSERT INTO news_items')) return { rows: [{ id: 10 }] };
    return { rows: [], rowCount: 1 };
  }, connect: async () => ({ query: db.query, release() {} }) };
  return { db, queries };
}

test('P02: per-event review rejects missing, malformed, duplicate and unresolved verdicts and binds final content', () => {
  const a = article();
  for (const rows of [[], [{ event_id: 2, verdict: 'ok', issues: [] }], [{ event_id: 1, verdict: 'ok' }],
    [{ event_id: 1, verdict: 'unknown', issues: [] }], [{ event_id: 1, verdict: 'ok', issues: [{ location: 'body', problem: 'claim', fix: 'remove' }] }],
    [{ event_id: 1, verdict: 'ok', issues: [] }, { event_id: 1, verdict: 'ok', issues: [] }]]) {
    assert.equal(reviewApproved(eventReviews(rows, [a], [1]).get(1), a), false);
  }
  const review = eventReviews([{ event_id: 1, verdict: 'ok', issues: [] }], [a], [1]).get(1);
  assert.equal(reviewApproved(review, a), true);
  assert.equal(reviewApproved(review, { ...a, body: a.body + ' Unsupported expansion.' }), false);
});

test('P02: reviewer timeout/missing verdict holds every tier; approved final article waits for translation', async () => {
  for (const response of [new Error('reviewer timeout'), { json: { reviews: [] }, model: 'reviewer' }]) {
    const { db, queries } = publisherDb();
    const svc = new KbEditorialService(db);
    svc.llm = async ({ purpose }) => {
      if (purpose === 'kb_medium') return { json: { articles: [article()] }, model: 'writer' };
      if (response instanceof Error) throw response;
      return response;
    };
    await svc.runBatch([{ cand: { eventId: 1, articleNewsId: null }, dossier: dossier(), text: 'Dossier' }], 'medium');
    const insert = queries.find((q) => q.sql.includes('INSERT INTO news_items'));
    assert.equal(insert.args[13], 'needs_review');
    assert.equal(JSON.parse(insert.args[11]).kb.checks_passed, false);
  }
  const { db, queries } = publisherDb();
  const svc = new KbEditorialService(db); svc.llm = async () => { throw Error('no provider allowed'); };
  const a = article();
  const review = eventReviews([{ event_id: 1, verdict: 'ok', issues: [] }], [a], [1]).get(1);
  const result = await svc.publish({ eventId: 1, articleNewsId: null }, dossier(), a, 'writer', { review });
  assert.equal(result.status, 'needs_review');
  const meta = JSON.parse(queries.find((q) => q.sql.includes('INSERT INTO news_items')).args[11]);
  assert.equal(meta.kb.checks_passed, true);
  assert.equal(meta.kb.review.state, 'approved');
});

test('P02: partial patches preserve unresolved issue IDs and never synthesize approval', async () => {
  const svc = new KbEditorialService({});
  const a = article();
  svc.llm = async ({ purpose }) => purpose === 'kb_review'
    ? { model: 'reviewer', json: { reviews: [{ event_id: 1, verdict: 'fix', issues: [
      { location: 'title', problem: 'unclear', fix: 'clarify' }, { location: 'body', problem: 'unsupported', fix: 'remove' }] }] } }
    : { model: 'patcher', json: { patches: [{ event_id: 1, field: 'title', find: a.title, replace: 'Revised independent reporting' }] } };
  const fixed = await svc.reviewAndFix([{ eventId: 1, material: 'evidence' }], [a], 1000);
  assert.equal(reviewApproved(fixed.reviews.get(1), fixed.articles[0]), false);
  assert.deepEqual(fixed.reviews.get(1).issues.map((i) => i.id), ['1:1', '1:2']);
});

test('P02: held updates retain the approved published row and rejected rows are never rewritten', async () => {
  for (const status of ['published', 'rejected']) {
    const { db, queries } = publisherDb(status);
    const svc = new KbEditorialService(db); svc.llm = async () => { throw Error('no provider'); };
    const result = await svc.publish({ eventId: 1, articleNewsId: 10 }, dossier(), article(), 'writer');
    assert.equal(result.status, status === 'published' ? 'needs_review' : 'rejected');
    const updates = queries.filter((q) => q.sql.startsWith('UPDATE news_items'));
    assert.equal(updates.length, status === 'published' ? 1 : 0);
    if (updates.length) assert.match(updates[0].sql, /kb_candidate/);
  }
});

test('P02: expansion invalidates the reviewed content and short rescue cannot clear a review hold', async () => {
  const { db, queries } = publisherDb();
  const svc = new KbEditorialService(db);
  const a = { ...article(), body: 'Short supported passage. [D1] [D2]' };
  const review = eventReviews([{ event_id: 1, verdict: 'ok', issues: [] }], [a], [1]).get(1);
  svc.expandShort = async () => article().body;
  const result = await svc.publish({ eventId: 1, articleNewsId: null }, dossier(), a, 'writer', { review });
  assert.equal(result.status, 'needs_review');
  assert.equal(JSON.parse(queries.find((q) => q.sql.includes('INSERT INTO news_items')).args[11]).kb.checks_passed, false);

  const rescueQueries = [];
  const held = { article: article(), kb: { review: { state: 'needs_review', verdict: 'reject', issues: [{ id: '1:1' }] },
    checks_passed: false, validation: { problems: ['too short'] } } };
  const rescue = new KbEditorialService({ query: async (sql, args) => {
    rescueQueries.push({ sql, args });
    return { rows: sql.includes('SELECT id, kb_event_id') ? [{ id: 10, kb_event_id: 1, ai_metadata: held }] : [] };
  } });
  await rescue.rescueShort(1);
  const saved = JSON.parse(rescueQueries.find((q) => q.sql.startsWith('UPDATE')).args[1]);
  assert.equal(saved.kb.checks_passed, false);
  assert.equal(saved.kb.review.verdict, 'reject');
  assert.deepEqual(saved.kb.review.issues, [{ id: '1:1' }]);
  assert.match(rescueQueries[0].sql, /status = 'needs_review'/);
});

test('P02: translation publication rechecks review, evidence, rejection and the translated candidate at write time', async () => {
  const a = article(); const queries = [];
  const db = { query: async (sql, args) => {
    queries.push({ sql, args });
    return { rows: sql.startsWith('SELECT') ? [{ id: 1, status: 'needs_review', article: a, attempts: 0, checks_passed: true }] : sql.startsWith('UPDATE news_items n') ? [{ status: 'published' }] : [], rowCount: 1 };
  } };
  const svc = new KbTranslationService(db);
  svc.translator = async () => ({ title: 'Title', summary: 'Summary', why: 'Reason', body: a.body, model: 'mock' });
  const result = await svc.runOnce();
  assert.equal(result.published, 1);
  const q = queries.find((q) => q.sql.startsWith('UPDATE'));
  assert.ok(q.sql.includes(publicationReadySql()));
  assert.match(q.sql, /status <> 'rejected'.*ai_metadata->'article' = \$8::jsonb/s);
  assert.deepEqual(JSON.parse(q.args[7]), a);
});

test('P03: atomic reservations protect daily and reserved shares across concurrent callers and module restarts', async () => {
  const ledger = quotaFixture.installQuotaLedger();
  const before = { ...process.env };
  try {
    process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test';
    process.env.LLM_DAILY_LIMITS = 'gemini-3-flash=20';
    process.env.LLM_BUDGET_RESERVED = 'gemini-3-flash=kb_review|translate:5';
    const budget = require('../dist/common/llm-budget.js'); budget.resetLlmBudgetForTests();
    const noon = Date.parse('2026-11-18T12:00:00Z');
    const decorative = await Promise.all(Array.from({ length: 40 }, () => budget.reserveLlmCall('gemini-3-flash-preview', 'captions', noon)));
    assert.equal(decorative.filter(Boolean).length, 15);
    delete require.cache[require.resolve('../dist/common/llm-budget.js')];
    const restarted = require('../dist/common/llm-budget.js');
    const essential = await Promise.all(Array.from({ length: 20 }, () => restarted.reserveLlmCall('gemini-3-flash', 'kb_review', noon)));
    assert.equal(essential.filter(Boolean).length, 5);
    assert.equal(await restarted.reserveLlmCall('gemini-3-flash', 'translate', noon), false);
    assert.equal(await restarted.reserveLlmCall('gemini-3-flash', 'translate', noon + 86400_000), true);
    assert.ok(ledger.locks.every((k) => k.startsWith('llm:2026-11-')));
  } finally { ledger.restore(); process.env = before; }
});

test('P03: failed accounting sends zero budgeted Gemini/OpenRouter HTTP calls; paid OpenRouter targets are excluded', async () => {
  const budget = require('../dist/common/llm-budget.js');
  const router = require('../dist/common/llm-router.js');
  const gemini = require('../dist/common/gemini-client.js');
  const before = { ...process.env }; const fetchBefore = globalThis.fetch;
  let calls = 0;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.LLM_DAILY_LIMITS;
    process.env.GEMINI_API_KEY = 'mock'; process.env.openrouter_api_key = 'mock';
    process.env.LLM_CHAIN_SUMMARY = 'openrouter'; process.env.OPENROUTER_MODEL = 'paid/model';
    budget.resetLlmBudgetForTests(); gemini.resetGeminiClientStateForTests(); router.resetLlmRouterForTests();
    globalThis.fetch = async () => { calls++; throw Error('HTTP forbidden'); };
    await assert.rejects(gemini.postGeminiGenerateContent({ apiKey: 'mock', candidateModels: ['gemini-3.1-flash-lite'], body: {} }), /budget/);
    assert.equal(await router.generateWithRouter({ task: 'summary', prompt: 'test' }), null);
    assert.equal(calls, 0);
    assert.ok(router.getTargets().openrouter.every((t) => t.model === 'openrouter/free' || t.model.endsWith(':free')));
    assert.equal(await budget.remainingLlmCalls('gemini-3-flash', 'kb_review'), 0);
    assert.equal(await budget.reserveLlmCall('gemma-4-31b-it', 'kb_review'), false);
  } finally { globalThis.fetch = fetchBefore; process.env = before; }
});

test('P03: connection and transaction failures defer reservations and accounting recovers', async () => {
  const ledger = quotaFixture.installQuotaLedger();
  const { Pool } = require('pg');
  const connect = Pool.prototype.connect;
  const before = { ...process.env };
  try {
    process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test';
    const budget = require('../dist/common/llm-budget.js');
    Pool.prototype.connect = async () => { throw Error('database unavailable'); };
    assert.equal(await budget.reserveLlmCall('gemini-3.1-flash-lite', 'kb_review'), false);
    Pool.prototype.connect = async () => ({ query: async () => { throw Error('table unavailable'); }, release() {} });
    assert.equal(await budget.reserveLlmCall('gemini-3.1-flash-lite', 'kb_review'), false);
    Pool.prototype.connect = connect;
    assert.equal(await budget.reserveLlmCall('gemini-3.1-flash-lite', 'kb_review'), true);
    assert.equal(budget.dailyLlmLimit('gemini-3.1-flash-lite'), 500);
    const router = require('../dist/common/llm-router.js');
    process.env.GEMINI_MODEL = 'gemma-4-31b-it';
    assert.equal(router.getTargets().gemini[0].rpd, Infinity);
  } finally { ledger.restore(); process.env = before; }
});

test('P03: free OpenRouter models consume one account allowance including failed attempts', async () => {
  const ledger = quotaFixture.installQuotaLedger(); const before = { ...process.env }; const fetchBefore = globalThis.fetch;
  try {
    process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test'; process.env.OPENROUTER_DAILY_LIMIT = '2';
    process.env.openrouter_api_key = 'mock'; process.env.LLM_CHAIN_SUMMARY = 'openrouter';
    const router = require('../dist/common/llm-router.js'); router.resetLlmRouterForTests();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'invalid schema', headers: new Headers() }; };
    await assert.rejects(router.generateWithRouter({ task: 'summary', prompt: 'x' }));
    router.resetLlmRouterForTests();
    await assert.rejects(router.generateWithRouter({ task: 'summary', prompt: 'x' }));
    router.resetLlmRouterForTests(); // Simulate a process restart: durable counter must still block.
    assert.equal(await router.generateWithRouter({ task: 'summary', prompt: 'x' }), null);
    assert.equal(calls, 2);
    assert.equal([...ledger.rows.values()].reduce((s, r) => s + r.used, 0), 2);
    assert.ok([...ledger.rows.values()].every((r) => r.model === 'openrouter:account'));
  } finally { ledger.restore(); globalThis.fetch = fetchBefore; process.env = before; }
});

test('P04: proposal bounds the small VM and excludes heavy jobs without changing deployed definitions', () => {
  const compose = readFileSync('compose.low-memory.yaml', 'utf8');
  assert.match(compose, /shared_buffers=64MB/); assert.match(compose, /max_connections=24/);
  assert.match(compose, /max-old-space-size=160/); assert.match(compose, /KB_COLLECTOR_CONCURRENCY: 1/);
  assert.match(compose, /KB_EMBEDDINGS: 'false'/);
  for (const service of ['kb-nlp', 'kb-video', 'kb-maintain', 'kb-connectors']) {
    assert.match(compose, new RegExp(`${service}:\\s+profiles: \\[heavy-off-vm\\]`));
  }
  assert.match(readFileSync('docs/LOW_MEMORY_PROFILE.md', 'utf8'), /unverified/);
});

test('P05: starts without completion become stalled; successful completion means progressing', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(workerState({ active_since: '2026-11-18T11:59:00Z', last_success: null }, now), 'running');
  assert.equal(workerState({ active_since: '2026-11-18T11:00:00Z', last_success: null }, now), 'stalled');
  assert.equal(workerState({ active_since: null, last_success: '2026-11-18T11:59:00Z' }, now), 'progressing');
  assert.equal(workerState({ active_since: null, last_success: null }, now), 'idle');
});

test('P05: diagnostic aggregates are cached/coalesced, failures are explicit, details use the existing guard', async () => {
  let count = 0; let now = 0;
  const db = { query: async () => { count++; throw Error('sensitive provider response'); } };
  const cache = new PipelineDiagnostics(db, () => now);
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.strictEqual(a, b); assert.equal(count, 4);
  assert.equal(a.status, 'degraded'); assert.equal(a.unavailable.length, 4);
  assert.equal(JSON.stringify(a).includes('sensitive'), false);
  await cache.get(); assert.equal(count, 4);
  now = 30_001; await cache.get(); assert.equal(count, 8);
  const { HealthController } = require('../dist/health/health.controller.js');
  const { IngestKeyGuard } = require('../dist/common/ingest-key.guard.js');
  assert.ok(Reflect.getMetadata('__guards__', HealthController.prototype.diagnostics).includes(IngestKeyGuard));
  assert.match(readFileSync('.github/workflows/check.yml', 'utf8'), /run: npm test/);
  assert.match(readFileSync('.github/workflows/knowledge.yml', 'utf8'), /KB_REQUIRE_QUALITY_TESTS: 'true'/);
});

test('P03: Python uses the same versioned defaults and fails closed without provider calls', () => {
  const result = spawnSync('python', ['tests/batch1_python.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('P01: PostgreSQL executes the shared gate against publication regression fixtures without network access', (t) => {
  // Standalone backend only: never starts a server, opens a socket or uses an existing database.
  const linuxVersions = existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a)) : [];
  const bin = process.env.BATCH1_POSTGRES_BIN || (linuxVersions.length ? `/usr/lib/postgresql/${linuxVersions[0]}/bin` : 'C:/Program Files/PostgreSQL/17/bin');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  if (!existsSync(join(bin, `initdb${suffix}`))) return t.skip('Standalone PostgreSQL binaries unavailable; portable policy/consumer tests still run');
  const data = mkdtempSync(join(tmpdir(), 'radar-batch1-pg-'));
  const init = spawnSync(join(bin, `initdb${suffix}`), ['-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const fixtures = [
    { ...valid, ai_generated: false }, { ...valid, status: 'rejected' },
    { ...valid, cluster_sources: [source('a.example'), source('www.a.example')] },
    { ...valid, cluster_sources: [source('a.example', { evidenceRoot: 'reuters' }), source('b.example', { evidenceRoot: 'reuters' })] },
    { ...valid, cluster_sources: [source('a.example'), source('b.example', { extraction: 'blocked' })] },
    { ...valid, cluster_sources: [source('a.example'), { url: 'broken' }] },
    { ...valid, kb_event_id: 1, cluster_sources: [source('a.example')] }, valid,
    { ...valid, kb_event_id: 2, cluster_sources: [] },
    { ...valid, cluster_sources: [source('a.example'), source('a.example', { evidenceRoot: 'other' })] },
  ];
  const quote = (s) => `'${s.replaceAll("'", "''")}'`;
  const inserts = fixtures.map((f, i) => `(${i + 1},${quote(f.status)},${f.ai_generated},${quote(JSON.stringify(f.cluster_sources))}::jsonb,${f.kb_event_id ?? 'NULL'})`).join(',');
  const statements = [
    'CREATE SCHEMA kb;',
    'CREATE TABLE kb.events (id bigint PRIMARY KEY, independent_source_count int);',
    'INSERT INTO kb.events VALUES (1,1),(2,2);',
    "CREATE TABLE news_items (id int PRIMARY KEY, status text, ai_generated boolean, cluster_sources jsonb, kb_event_id bigint, ai_metadata jsonb DEFAULT '{}', content_hash text);",
    `INSERT INTO news_items (id,status,ai_generated,cluster_sources,kb_event_id) VALUES ${inserts};`,
    `DO $$ BEGIN IF ARRAY(SELECT n.id FROM news_items n WHERE ${NEWS_ELIGIBILITY_SQL} ORDER BY n.id) <> ARRAY[8,9] THEN RAISE EXCEPTION 'Publication regression'; END IF; END $$;`,
    `UPDATE news_items SET status = 'needs_review' WHERE id = 9;`,
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM news_items n WHERE id = 9 AND ${publicationReadySql()}) THEN RAISE EXCEPTION 'Missing review bypass'; END IF; END $$;`,
    `UPDATE news_items SET content_hash = 'reviewed', ai_metadata = '{"kb":{"checks_passed":true,"review":{"state":"approved","article_hash":"reviewed"}}}' WHERE id = 9;`,
    `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM news_items n WHERE id = 9 AND ${publicationReadySql()}) THEN RAISE EXCEPTION 'Approved publication blocked'; END IF; END $$;`,
  ];
  const result = spawnSync(join(bin, `postgres${suffix}`), ['--single', '-D', data, '-c', 'exit_on_error=on', 'postgres'],
    { input: statements.map((s) => s.replaceAll('\n', ' ')).join('\n') + '\n', encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /ERROR:|FATAL:/);
  // Leave this new disposable cluster in the system temp directory; no existing data is deleted.
});
