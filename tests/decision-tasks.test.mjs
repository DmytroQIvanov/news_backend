import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const quotaFixture = require('./quota-ledger.cjs');
const budget = require('../dist/common/llm-budget.js');
const decision = require('../dist/common/decision-client.js');
const corr = require('../dist/kb/kb-corroboration.service.js');
const tasks = require('../dist/kb/kb-llm-tasks.service.js');
const { decisionReviewArticle } = require('../dist/kb/kb-editorial.service.js');
const { verifySectionsWithDecisions } = require('../dist/kb/kb-deepdive.service.js');
const { verificationPasses } = require('../dist/kb/kb-deepdive-gates.js');
const { judgeVideoWithDecisions, acceptVideo } = require('../dist/youtube/event-videos.service.js');
const { judgeAmbientWithDecisions } = require('../dist/news/ambient-check.service.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDecisionEnv(t) {
  const ledger = quotaFixture.installQuotaLedger();
  const before = { ...process.env };
  const fetchBefore = globalThis.fetch;
  process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test';
  process.env.GEMINI_API_KEY = 'mock';
  budget.resetLlmBudgetForTests();
  decision.resetDecisionClientForTests();
  t.after(() => {
    ledger.restore();
    process.env = before;
    globalThis.fetch = fetchBefore;
    decision.resetDecisionClientForTests();
    budget.resetLlmBudgetForTests();
  });
  return ledger;
}

const okDecisions = (answers, promptTokenCount = 400) => ({
  ok: true,
  status: 200,
  json: async () => ({ answers, usageMetadata: { promptTokenCount } }),
});

test('DecisionLimiter paces 45K TPM window, prioritizes high over low, and releases unused tokens', async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  Object.assign(process.env, { DECISION_TPM: '100', DECISION_RPM: '1000', DECISION_RPS: '500', DECISION_CONCURRENCY: '5' });
  const limiter = new decision.DecisionLimiter(120, 40);
  const first = await limiter.acquire(80, 'normal');
  let secondDone = false;
  const pending = limiter.acquire(50, 'low').then((l) => { secondDone = true; return l; });
  await sleep(30);
  assert.equal(secondDone, false, '50 tokens must wait until 80-token window clears');
  first.release(10);
  (await pending).release(50);
  assert.equal(secondDone, true);

  Object.assign(process.env, { DECISION_TPM: '100000', DECISION_CONCURRENCY: '1' });
  const prio = new decision.DecisionLimiter(60, 20);
  const order = [];
  const hold = await prio.acquire(1, 'normal');
  const pLow = prio.acquire(1, 'low').then((l) => { order.push('low'); l.release(1); });
  const pHigh = prio.acquire(1, 'high').then((l) => { order.push('high'); l.release(1); });
  hold.release(1);
  await Promise.all([pLow, pHigh]);
  assert.deepEqual(order, ['high', 'low']);
  limiter.reset();
  prio.reset();
});

test('gemini-decision-1 uses 10K RPD block leases (LEASE_SIZE=25) and fails closed without DB', async (t) => {
  const ledger = withDecisionEnv(t);
  assert.equal(budget.dailyLlmLimit('gemini-decision-1'), 10000);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(await budget.reserveLlmCall('gemini-decision-1', 'kb_verify'), true);
  }
  assert.equal(ledger.locks.length, 2, '30 calls touch Postgres twice (blocks of 25)');
  assert.equal([...ledger.rows.values()][0].used, 50);

  delete process.env.DATABASE_URL;
  budget.resetLlmBudgetForTests();
  assert.equal(await budget.reserveLlmCall('gemini-decision-1', 'kb_verify'), false);
});

test('validateDecisionAnswers & postGeminiDecisions reject malformed answers, oversize prompts and refund on 429', async (t) => {
  const ledger = withDecisionEnv(t);
  const qs = {
    ok: { type: 'noul', instructions: 'ok?' },
    cat: { type: 'choice', instructions: 'cat?', criteria: { a: 'A', b: 'B' } },
    rank: { type: 'score', instructions: 'rank?', criteria: ['0', '1', '2'] },
  };
  assert.equal(decision.validateDecisionAnswers(qs, { answers: { ok: { noul: 0.9, confidence: 0.8 }, cat: { choice: 'z', confidence: 0.9 }, rank: { score: 1, confidence: 0.9 } } }), null);
  assert.equal(decision.validateDecisionAnswers(qs, { answers: { ok: { noul: 0.9, confidence: 0.8 }, cat: { choice: 'a', confidence: 0.9 }, rank: { score: 5, confidence: 0.9 } } }), null);
  assert.ok(decision.validateDecisionAnswers(qs, { answers: { ok: { noul: 0.9, confidence: 0.8 }, cat: { choice: 'a', confidence: 0.9 }, rank: { score: 1.5, confidence: 0.9 } } }));

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => 'per minute quota', headers: new Headers() };
  };
  process.env.DECISION_MAX_INPUT_TOKENS = '50';
  await assert.rejects(
    decision.postGeminiDecisions({ input: 'x'.repeat(300), questions: { ok: qs.ok }, purpose: 'kb_verify' }),
    (err) => err.status === 400,
  );
  assert.equal(calls, 0);

  process.env.DECISION_MAX_INPUT_TOKENS = '40000';
  await assert.rejects(
    decision.postGeminiDecisions({ input: 'short', questions: { ok: qs.ok }, purpose: 'kb_verify' }),
    (err) => err.status === 429,
  );
  assert.equal(calls, 1);
  assert.ok(ledger.locks.length >= 1);
});

test('corroboration tryDecisionVerdict accepts high-confidence verdicts, tightens sensitive events, and falls back on conflict/uncertainty', async (t) => {
  withDecisionEnv(t);
  const baseAns = {
    same_event: { noul: 0.92, confidence: 0.90 },
    on_topic: { noul: 0.95, confidence: 0.92 },
    source_type: { choice: 'national_outlet', confidence: 0.88 },
    reliability: { choice: 'high', confidence: 0.91 },
    independent: { noul: 0.94, confidence: 0.90 },
    adds_information: { noul: 0.89, confidence: 0.87 },
    conflicts_with_event: { noul: 0.05, confidence: 0.92 },
  };
  globalThis.fetch = async () => okDecisions(baseAns);
  const ok = await corr.tryDecisionVerdict({ system: 'sys', prompt: 'candidate' });
  assert.equal(ok.model, 'gemini-decision-1');
  assert.equal(corr.acceptVerdict(ok.json, 0.75, true).accepted, true);

  // Sensitive threshold (0.85) rejects 0.82 even if non-sensitive accepts it.
  globalThis.fetch = async () => okDecisions({ ...baseAns, same_event: { noul: 0.82, confidence: 0.82 } });
  const border = await corr.tryDecisionVerdict({ system: 'sys', prompt: 'candidate' });
  assert.equal(corr.acceptVerdict(border.json, 0.75, false).accepted, true);
  assert.equal(corr.acceptVerdict(border.json, 0.75, true).accepted, false);

  // Low confidence or detected conflict returns null to fall back to generative explanation.
  globalThis.fetch = async () => okDecisions({ ...baseAns, same_event: { noul: 0.90, confidence: 0.40 } });
  assert.equal(await corr.tryDecisionVerdict({ system: 'sys', prompt: 'candidate' }), null);

  globalThis.fetch = async () => okDecisions({ ...baseAns, conflicts_with_event: { noul: 0.85, confidence: 0.88 } });
  assert.equal(await corr.tryDecisionVerdict({ system: 'sys', prompt: 'candidate' }), null);
});

test('kb-llm-tasks uses verbatim passage sentences for decision quotes and falls back on low confidence', async (t) => {
  withDecisionEnv(t);
  const passage = '<page_text>[E1] Reuters — News\nThe central bank raised rates by 0.5 points on Tuesday. Analysts expected steady inflation.</page_text>';
  const sents = tasks.extractPassageSentences(passage);
  assert.equal(sents.length, 2);
  assert.match(sents[0].text, /raised rates by 0.5 points/);

  globalThis.fetch = async () => okDecisions({
    verdict: { choice: 'supported', confidence: 0.91 },
    quote_sentence: { choice: 'S1', confidence: 0.88 },
  });
  const ok = await tasks.tryDecisionFactCheck('#1: Bank | raised | rates', passage);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.verdict, 'supported');
  assert.equal(ok.value.quote, sents[0].text);

  // If supported lacks a high-confidence quote, returns invalid so Gemma handles it.
  globalThis.fetch = async () => okDecisions({
    verdict: { choice: 'supported', confidence: 0.91 },
    quote_sentence: { choice: 'none', confidence: 0.90 },
  });
  assert.deepEqual(await tasks.tryDecisionFactCheck('#1: Bank | raised | rates', passage), { ok: false, reason: 'invalid' });

  globalThis.fetch = async () => okDecisions({ supported: { noul: 0.93, confidence: 0.89 } });
  const causal = await tasks.tryDecisionCausal('EVENT A\n...\nEVENT B\n...');
  assert.equal(causal.ok, true);
  assert.equal(causal.value.supported, true);

  globalThis.fetch = async () => okDecisions({ resolution: { choice: 'option_1', confidence: 0.92 } });
  const ent = await tasks.tryDecisionEntityChoice('Acme', 'ORG', [{ qid: 'Q1' }], 'Acme announced');
  assert.equal(ent.ok, true);
  assert.equal(ent.value.decision, 'option');
  assert.equal(ent.value.optionIndex, 1);
});

test('editorial decisionReviewArticle approves only unanimous high-confidence articles and flags weak paragraphs', async (t) => {
  withDecisionEnv(t);
  const art = {
    event_id: 42,
    title: 'Central bank raises rates',
    summary: 'Rates moved by 0.5 points.',
    body: 'The central bank raised rates by 0.5 points on Tuesday [D1].\n\n## Outlook\nAnalysts expect stable policy through winter [D2].',
    importance_reason: 'Affects borrowing costs.',
    important: false,
    category: 'finance',
    confidence: 'high',
    facts: [],
  };
  globalThis.fetch = async () => okDecisions({
    headline_supported: { noul: 0.95, confidence: 0.92 },
    context_complete: { noul: 0.91, confidence: 0.90 },
    overall_verdict: { choice: 'ok', confidence: 0.93 },
    p_1: { choice: 'supported', confidence: 0.90 },
    p_2: { choice: 'supported', confidence: 0.88 },
  });
  const ok = await decisionReviewArticle(42, 'dossier', art, 30_000);
  assert.equal(ok.review.verdict, 'ok');
  assert.deepEqual(ok.review.issues, []);

  // Flagged paragraph yields structured fix issue.
  globalThis.fetch = async () => okDecisions({
    headline_supported: { noul: 0.90, confidence: 0.90 },
    context_complete: { noul: 0.88, confidence: 0.88 },
    overall_verdict: { choice: 'fix', confidence: 0.86 },
    p_1: { choice: 'supported', confidence: 0.91 },
    p_2: { choice: 'wrong_citation', confidence: 0.85 },
  });
  const fix = await decisionReviewArticle(42, 'dossier', art, 30_000);
  assert.equal(fix.review.verdict, 'fix');
  assert.equal(fix.review.issues[0].location, 'paragraph P2');

  // Borderline confidence without concrete issues returns null so generative reviewer checks it.
  globalThis.fetch = async () => okDecisions({
    headline_supported: { noul: 0.90, confidence: 0.90 },
    context_complete: { noul: 0.88, confidence: 0.88 },
    overall_verdict: { choice: 'ok', confidence: 0.70 },
    p_1: { choice: 'supported', confidence: 0.70 },
    p_2: { choice: 'supported', confidence: 0.90 },
  });
  assert.equal(await decisionReviewArticle(42, 'dossier', art, 30_000), null);
});

test('deepdive verifySectionsWithDecisions checks all paragraphs in one call and downgrades low-confidence supported claims', async (t) => {
  withDecisionEnv(t);
  const material = {
    context: '[S1] Reuters (2026-11-19) "Title"\n    The company invested 2000 units.\n[S2] AP (2026-11-19) "Title 2"\n    The board approved the plan.',
    docs: [
      { source: 'Reuters', pub: '2026-11-19', title: 'Title', url: 'https://r.example', evidenceRoot: 'reuters' },
      { source: 'AP', pub: '2026-11-19', title: 'Title 2', url: 'https://ap.example', evidenceRoot: 'ap' },
    ],
    origins: 2,
    events: 1,
  };
  const sections = [
    { heading: 'Part 1', paragraphs: ['The company invested 2000 units [S1].', 'The board approved the plan [S2].'] },
  ];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return okDecisions({
      p_0_0: { choice: 'supported', confidence: 0.92 },
      p_0_1: { choice: 'supported', confidence: 0.65 },
    });
  };
  const out = await verifySectionsWithDecisions(sections, material);
  assert.equal(fetchCalls, 1, 'all paragraphs checked in one forward pass');
  assert.equal(out.verdicts.get('0:0').verdict, 'supported');
  assert.equal(out.verdicts.get('0:1').verdict, 'partial', 'low-confidence supported must not pass as supported');
  assert.equal(verificationPasses([...out.verdicts.values()], 2).ok, false, '50% partial exceeds 25% cap');
});

test('judgeVideoWithDecisions maps noul + kind + authority into VideoVerdict and respects acceptVideo thresholds', async (t) => {
  withDecisionEnv(t);
  globalThis.fetch = async () => okDecisions({
    relevant: { noul: 0.88, confidence: 0.91 },
    kind: { choice: 'news_report', confidence: 0.85 },
    channel_authority: { choice: 'high', confidence: 0.9 },
  });
  const good = await judgeVideoWithDecisions({
    eventTitle: 'APEC Summit in Shenzhen',
    eventSummary: 'Leaders met in Shenzhen.',
    participants: ['Xi Jinping'],
    candidate: {
      videoId: 'vid1', title: 'APEC Summit Report', channel: 'BBC News', channelId: 'bbc',
      durationSec: 240, publishedHint: '2h ago', ageHours: 2, views: 50000, live: false,
    },
  });
  assert.ok(good);
  assert.equal(good.model, 'gemini-decision-1');
  assert.equal(good.verdict.relevant, true);
  assert.equal(good.verdict.kind, 'news_report');
  assert.equal(good.verdict.channel_authority, 'high');
  assert.equal(acceptVideo(good.verdict).accepted, true);

  globalThis.fetch = async () => okDecisions({
    relevant: { noul: 0.82, confidence: 0.85 },
    kind: { choice: 'clickbait', confidence: 0.8 },
    channel_authority: { choice: 'low', confidence: 0.9 },
  });
  const clickbait = await judgeVideoWithDecisions({
    eventTitle: 'APEC Summit in Shenzhen',
    participants: [],
    candidate: {
      videoId: 'vid2', title: 'SHOCKING SUMMIT!!!', channel: 'DramaClips', channelId: null,
      durationSec: 180, publishedHint: '1h ago', ageHours: 1, views: 1000, live: false,
    },
  });
  assert.ok(clickbait);
  assert.equal(acceptVideo(clickbait.verdict).accepted, false);

  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
  const failed = await judgeVideoWithDecisions({
    eventTitle: 'APEC Summit',
    participants: [],
    candidate: {
      videoId: 'vid3', title: 'News', channel: 'Channel', channelId: null,
      durationSec: 180, publishedHint: '1h ago', ageHours: 1, views: 1000, live: false,
    },
  });
  assert.equal(failed, null, 'errors return null so caller can fall back to Gemma');
});

test('judgeAmbientWithDecisions scores text-only background relevance with 0.65 threshold', async (t) => {
  withDecisionEnv(t);
  globalThis.fetch = async () => okDecisions({ fits: { noul: 0.78, confidence: 0.84 } });
  const fit = await judgeAmbientWithDecisions({
    title: 'Rocket launch from Cape Canaveral',
    summary: 'Spacecraft lifted off at dawn.',
    alt: 'rocket launch pad smoke night',
    credit: 'Pixabay',
  });
  assert.ok(fit);
  assert.equal(fit.fits, true);
  assert.equal(fit.vision, false);
  assert.equal(fit.model, 'gemini-decision-1');

  globalThis.fetch = async () => okDecisions({ fits: { noul: 0.42, confidence: 0.8 } });
  const noFit = await judgeAmbientWithDecisions({
    title: 'Central bank rate decision',
    summary: 'Interest rates held steady.',
    alt: 'concrete wall texture',
    credit: 'Pexels',
  });
  assert.ok(noFit);
  assert.equal(noFit.fits, false);
});
