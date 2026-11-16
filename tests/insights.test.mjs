import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adamicAdar, betweenness, buildEntityMatcher, buildGraph, burstScore, computePairStats, detectEvents,
  eventSequences, extractCandidateTerms, leadLag, louvain, pagerank, parseAmountUsd, scorePair, shortestPath,
} from '../dist/insights/insights-analysis.js';
import { topicLinkDrafts } from '../dist/insights/insights.service.js';

const DAY = 86_400_000;

test('entity matcher: whole words for Latin, prefixes for Cyrillic', () => {
  const match = buildEntityMatcher([
    { id: 'openai', aliases: ['openai', 'o3'] },
    { id: 'agents', aliases: ['агент', 'agents'] },
    { id: 'nvidia', aliases: ['NVIDIA'] },
  ]);
  assert.deepEqual([...match('OpenAI released o3 today')].sort(), ['openai']);
  assert.equal(match('CO3 emissions').size, 0);
  assert.ok(match('Нові можливості агентів').has('agents'));
  assert.ok(match('Nvidia’s chips').has('nvidia'));
});

test('event detection and amounts', () => {
  const tags = detectEvents('Mistral raises $600 million in Series B led by General Catalyst');
  const funding = tags.find((t) => t.eventType === 'funding');
  assert.ok(funding);
  assert.equal(funding.amountUsd, 600e6);
  assert.equal(parseAmountUsd('Компанія залучила 2 млрд доларів'), 2e9);
  assert.equal(parseAmountUsd('valued at $6.6B'), 6.6e9);
  assert.ok(detectEvents('Anthropic придбала стартап').some((t) => t.eventType === 'acquisition'));
  assert.ok(detectEvents('Court rules on OpenAI copyright lawsuit').some((t) => t.eventType === 'legal'));
});

test('candidate terms from titles', () => {
  const terms = extractCandidateTerms('Perplexity launches Comet browser as Grok 5 rumors grow');
  assert.ok(terms.includes('Perplexity'));
  assert.ok(terms.includes('Comet'));
  assert.ok(terms.includes('Grok 5'));
  assert.ok(!terms.some((t) => /^launches$/i.test(t)));
  assert.deepEqual(extractCandidateTerms('How the new model works'), []);
});

test('pair stats count stories, PMI favours rare pairs', () => {
  const now = Date.now();
  const docs = [];
  for (let i = 0; i < 20; i += 1) docs.push({ key: `g${i}`, time: now - 40 * DAY, entityIds: ['google', `x${i}`], sourceIds: ['s1'], newsIds: [`${i}`] });
  docs.push({ key: 'r1', time: now - DAY, entityIds: ['rareA', 'rareB'], sourceIds: ['s1', 's2'], newsIds: ['100'] });
  docs.push({ key: 'r2', time: now - 2 * DAY, entityIds: ['rareA', 'rareB'], sourceIds: ['s3'], newsIds: ['101'] });
  const pairs = computePairStats(docs, now, 14);
  const rare = pairs.get('rareA|rareB');
  assert.equal(rare.coCount, 2);
  assert.equal(rare.sourceCount, 3);
  assert.ok(rare.npmi > 0.9);
  const common = pairs.get('google|x0');
  assert.ok(rare.pmi > common.pmi);
  const s1 = scorePair({ ...rare, knownRelation: false, sameCommunity: false }, now);
  const s2 = scorePair({ ...rare, knownRelation: true, sameCommunity: true }, now);
  assert.ok(s1 > s2);
});

test('graph: communities, bridge, prediction, path', () => {
  // Two triangles joined through "bridge".
  const edges = [
    ['a1', 'a2'], ['a2', 'a3'], ['a1', 'a3'], ['b1', 'b2'], ['b2', 'b3'], ['b1', 'b3'],
    ['a1', 'bridge'], ['bridge', 'b1'],
  ].map(([a, b]) => ({ a, b, weight: 3 }));
  const g = buildGraph(edges);
  const comm = louvain(g);
  const c = (id) => comm[g.index.get(id)];
  assert.equal(c('a1'), c('a2'));
  assert.equal(c('b1'), c('b3'));
  assert.notEqual(c('a2'), c('b2'));
  const btw = betweenness(g);
  const top = g.nodes[btw.indexOf(Math.max(...btw))];
  assert.ok(['bridge', 'a1', 'b1'].includes(top));
  assert.equal(pagerank(g).length, g.nodes.length);
  assert.deepEqual(shortestPath(g, 'a2', 'b2'), ['a2', 'a1', 'bridge', 'b1', 'b2']);
  const aa = adamicAdar(g, 1);
  assert.ok(!aa.has('a2|a3')); // adjacent pairs are excluded
  assert.deepEqual(aa.get('a2|bridge').common, ['a1']);
});

test('burst and lead-lag', () => {
  const series = [...new Array(32).fill(0.0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 5, 6, 4];
  const b = burstScore(series, 3);
  assert.ok(b.z > 3);
  const a = new Array(60).fill(0).map((_, i) => (i % 9 === 0 ? 5 : 0));
  const lagged = a.map((_, i) => (i >= 2 ? a[i - 2] : 0));
  const r = leadLag(a, lagged, 7);
  assert.equal(r.lag, 2);
  assert.ok(r.corr > 0.9);
});

test('event sequences', () => {
  const ev = [];
  for (const e of ['c1', 'c2', 'c3', 'c4']) {
    ev.push({ entityId: e, eventType: 'funding', time: 0 });
    ev.push({ entityId: e, eventType: 'launch', time: 20 * DAY });
  }
  ev.push({ entityId: 'c5', eventType: 'legal', time: 0 });
  const seq = eventSequences(ev, 60, 3);
  assert.equal(seq[0].fromType, 'funding');
  assert.equal(seq[0].toType, 'launch');
  assert.equal(seq[0].support, 4);
  assert.equal(Math.round(seq[0].avgGapDays), 20);
});

test('topic links need shared entities but no shared articles', () => {
  const rows = [
    { slug: 't1', title_uk: 'Т1', title_en: 'T1', entity_id: 'e1', cnt: 3, news: ['1'] },
    { slug: 't1', title_uk: 'Т1', title_en: 'T1', entity_id: 'e2', cnt: 1, news: ['1'] },
    { slug: 't2', title_uk: 'Т2', title_en: 'T2', entity_id: 'e1', cnt: 2, news: ['2'] },
    { slug: 't3', title_uk: 'Т3', title_en: 'T3', entity_id: 'e3', cnt: 2, news: ['3'] },
  ];
  const drafts = topicLinkDrafts(rows, [{ slug: 't1', ids: ['1'] }, { slug: 't2', ids: ['2'] }, { slug: 't3', ids: ['3'] }], new Map([['e1', 'NVIDIA']]));
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].topicSlugs, ['t1', 't2']);
  const blocked = topicLinkDrafts(rows, [{ slug: 't1', ids: ['1'] }, { slug: 't2', ids: ['1'] }], new Map());
  assert.equal(blocked.filter((d) => d.key === 't1|t2').length, 0);
});

import { bodyLengthTarget, countWords, referencesWithin, translationTooShort } from '../dist/ingest/gemini-editor.service.js';

test('editorial length checks', () => {
  assert.equal(countWords("OpenAI's new model — це 5 слів [1]."), 6);
  assert.equal(bodyLengthTarget(false).min, 220);
  assert.equal(bodyLengthTarget(true).min, 380);
  assert.ok(referencesWithin('Fact [1]. Another [2].', 2));
  assert.ok(!referencesWithin('Fact [3].', 2));
  const en = 'word '.repeat(200);
  assert.ok(translationTooShort(en, 'слово '.repeat(50)));
  assert.ok(!translationTooShort(en, 'слово '.repeat(170)));
  assert.ok(translationTooShort(en, undefined));
  assert.ok(!translationTooShort('short text', undefined));
});
