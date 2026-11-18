import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const quotaFixture = require('./quota-ledger.cjs');
const { GemmaLimiter, estimateInputTokens } = require('../dist/common/gemma-limiter.js');
const gemini = require('../dist/common/gemini-client.js');
const budget = require('../dist/common/llm-budget.js');
const { tryGemmaJson } = require('../dist/kb/kb-gemma.js');
const tasks = require('../dist/kb/kb-llm-tasks.service.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okReply = (text, tokens = 100) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { totalTokenCount: tokens } }) });
const failReply = (status) => ({ ok: false, status, headers: new Headers(), text: async () => 'per minute limit' });

function withGemmaEnv(t) {
  const ledger = quotaFixture.installQuotaLedger();
  const before = { ...process.env };
  const fetchBefore = globalThis.fetch;
  process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test';
  process.env.GEMINI_API_KEY = 'mock';
  process.env.GEMMA_RPM = '6000';
  budget.resetLlmBudgetForTests();
  gemini.resetGeminiClientStateForTests();
  t.after(() => { ledger.restore(); process.env = before; globalThis.fetch = fetchBefore; gemini.resetGeminiClientStateForTests(); budget.resetLlmBudgetForTests(); });
  return ledger;
}
const request = { system: 's', prompt: 'p', schema: { properties: { a: {} } }, validate: (raw) => (raw.a ? raw : null), purpose: 'kb_verify' };

test('Gemma limiter holds a call until its tokens fit and reuses tokens the answer did not spend', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, { GEMMA_RPM: '1000', GEMMA_TPM: '100', GEMMA_CONCURRENCY: '5' });
  const limiter = new GemmaLimiter(120);
  const first = await limiter.acquire('m', 80);
  let second = false;
  const pending = limiter.acquire('m', 50).then((lease) => { second = true; return lease; });
  await sleep(30);
  assert.equal(second, false, 'tokens do not fit yet');
  first.release(10);
  (await pending).release(50);
  assert.equal(second, true);
  limiter.reset();
});

test('Gemma limiter serves publication work before background work', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, { GEMMA_RPM: '6000', GEMMA_TPM: '100000', GEMMA_CONCURRENCY: '1' });
  const limiter = new GemmaLimiter(60);
  const order = [];
  const first = await limiter.acquire('m', 1);
  const low = limiter.acquire('m', 1, 'low').then((l) => { order.push('low'); l.release(1); });
  const high = limiter.acquire('m', 1, 'high').then((l) => { order.push('high'); l.release(1); });
  first.release(1);
  await Promise.all([low, high]);
  assert.deepEqual(order, ['high', 'low']);
  limiter.reset();
});

test('a prompt too large for Gemma is never sent', async (t) => {
  withGemmaEnv(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return okReply('{"a":1}'); };
  assert.deepEqual(await tryGemmaJson({ ...request, prompt: 'x'.repeat(60_000) }), { ok: false, reason: 'invalid' });
  assert.equal(calls, 0);
  assert.equal(estimateInputTokens({ contents: [{ parts: [{ text: 'x'.repeat(300) }] }] }), 100);
});

test('a rate-limited Gemma model hands over to the other one; both failing means wait', async (t) => {
  withGemmaEnv(t);
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(/gemma-4-31b/.test(url) ? '31b' : '26b'); return seen.length === 1 ? failReply(429) : okReply('{"a":1}'); };
  const res = await tryGemmaJson(request);
  assert.equal(res.ok, true);
  assert.equal(res.model, 'gemma-4-26b-a4b-it');
  assert.deepEqual(seen, ['31b', '26b']);
  gemini.resetGeminiClientStateForTests();
  globalThis.fetch = async () => failReply(503);
  assert.deepEqual(await tryGemmaJson(request), { ok: false, reason: 'unavailable' });
});

test('Gemma daily accounting touches the ledger once per block', async (t) => {
  const ledger = withGemmaEnv(t);
  for (let i = 0; i < 30; i += 1) assert.equal(await budget.reserveLlmCall('gemma-4-31b-it', 'kb_verify'), true);
  assert.equal(ledger.locks.length, 2);
  assert.equal([...ledger.rows.values()][0].used, 50);
  await budget.refundLlmCall('gemma-4-31b-it', 'kb_verify');
  assert.equal(ledger.locks.length, 2);
  assert.equal(budget.dailyLlmLimit('gemma-4-26b-a4b-it'), 14000);
});

test('answers must quote the passage they rely on', () => {
  const passage = 'The ministry said that 12 people were injured on Monday.';
  assert.equal(tasks.validateFactCheck({ verdict: 'supported', confidence: 0.9, quote: 'invented sentence here', reason: '' }, passage), null);
  assert.equal(tasks.validateFactCheck({ verdict: 'supported', confidence: 0.9, quote: '12 people were injured', reason: 'ok' }, passage).verdict, 'supported');
  assert.equal(tasks.validateFactCheck({ verdict: 'unclear', confidence: 2, quote: '', reason: '' }, passage), null);
  assert.equal(tasks.validateConflict({ assessment: 'real_conflict', confidence: 0.9, quote: '', explanation: '' }, passage), null);
  assert.equal(tasks.validateEntityChoice({ decision: 'option', option_index: 3, confidence: 0.9 }, 2), null);
  assert.equal(tasks.passageAround('aaa bbb ccc', 'missing'), 'missing');
});

function taskDb(task) {
  const log = [];
  return {
    log,
    query: async (sql, args = []) => {
      log.push({ sql, args });
      if (sql.includes("status = 'running', lease_token")) return { rows: [task] };
      if (sql.includes('FROM kb.facts f')) return { rows: [{ id: 7, predicate: 'acquired', subject: 'A', object: 'B', object_key: '' }] };
      if (sql.includes('FROM kb.claims c JOIN kb.documents')) return { rows: [{ sentence: 'A bought B on Monday.', modality: 'fact', title: 'T', source_name: 'S', body: 'News. A bought B on Monday. More.' }] };
      return { rows: [] };
    },
  };
}
const verifyTask = { id: 1, task_type: 'verify_fact', payload: { fact_id: 7 }, attempts: 0 };

test('a checked fact keeps its status and gets the assessment beside it', async () => {
  const db = taskDb(verifyTask);
  const service = new tasks.KbLlmTasksService(db);
  service.llm = async (req) => ({ ok: true, model: 'gemma-4-31b-it', value: req.validate({ verdict: 'not_supported', confidence: 0.9, quote: '', reason: 'other company' }) });
  assert.equal((await service.runOnce()).done, 1);
  const update = db.log.find((q) => q.sql.includes('UPDATE kb.facts'));
  assert.match(update.sql, /llm_checked = true, llm_verdict/);
  assert.doesNotMatch(update.sql, /status/);
  assert.ok(db.log.some((q) => q.sql.includes('done_at = now()') && q.args[2] === 'done'));
});

test('busy Gemma costs no attempt; unusable answers do', async () => {
  const busy = taskDb(verifyTask);
  const a = new tasks.KbLlmTasksService(busy);
  a.llm = async () => ({ ok: false, reason: 'unavailable' });
  assert.equal((await a.runOnce()).waiting, 1);
  assert.ok(busy.log.some((q) => q.sql.includes("interval '5 minutes'")));
  assert.ok(!busy.log.some((q) => q.sql.includes('attempts = $3')));
  const bad = taskDb({ ...verifyTask, attempts: 2 });
  const b = new tasks.KbLlmTasksService(bad);
  b.llm = async () => ({ ok: false, reason: 'invalid' });
  assert.equal((await b.runOnce()).failed, 1);
  assert.ok(bad.log.some((q) => q.sql.includes('attempts = $3') && q.args[3] === 'failed'));
});

test('an entity decision stays a proposal', async () => {
  const db = taskDb({ id: 2, task_type: 'entity_resolve', payload: { surface: 'Mercury', label: 'ORG', options: [{ qid: 'Q1' }], contexts: ['Mercury said'] }, attempts: 0 });
  const service = new tasks.KbLlmTasksService(db);
  service.llm = async (req) => ({ ok: true, model: 'gemma-4-26b-a4b-it', value: req.validate({ decision: 'option', option_index: 1, confidence: 0.95, reason: '' }) });
  await service.runOnce();
  assert.ok(!db.log.some((q) => /kb\.entit/.test(q.sql)));
});
