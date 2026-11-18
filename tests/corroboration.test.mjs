import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const good = {
  same_event: true, match_confidence: 0.9, on_topic: true, source_type: 'national_outlet', reliability: 'high',
  independent: true, adds_information: true, characterization: 'national daily', reason: 'own reporting',
};

test('corroboration: a page is accepted only when every criterion holds', () => {
  const { acceptVerdict } = require('../dist/kb/kb-corroboration.service.js');
  assert.equal(acceptVerdict(good).accepted, true);
  assert.equal(acceptVerdict({ ...good, same_event: false }).accepted, false);
  assert.equal(acceptVerdict({ ...good, match_confidence: 0.6 }).accepted, false);
  assert.equal(acceptVerdict({ ...good, source_type: 'aggregator' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, source_type: 'blog' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, reliability: 'low' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, independent: false }).accepted, false);
  assert.equal(acceptVerdict({ ...good, adds_information: false }).accepted, false);
});

test('corroboration: outlet roots are normalised', () => {
  const { rootOf } = require('../dist/kb/kb-corroboration.service.js');
  assert.equal(rootOf('https://www.bbc.co.uk/news/x'), 'bbc.co.uk');
  assert.equal(rootOf('https://edition.cnn.com/a'), 'cnn.com');
  assert.equal(rootOf('not a url'), '');
});

test('news search: Bing RSS parsing, query building and script filter', () => {
  const s = require('../dist/kb/kb-news-search.js');
  const xml = `<rss><channel><item><title>Nvidia posts record revenue</title><link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fwww.reuters.com%2Ftech%2Fnvidia-q3&amp;c=1</link><description>Record quarter</description><pubDate>Tue, 17 Nov 2026 20:56:34 GMT</pubDate><News:Source>Reuters</News:Source></item></channel></rss>`;
  const hits = s.parseBingRss(xml);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'https://www.reuters.com/tech/nvidia-q3');
  assert.equal(hits[0].source, 'Reuters');
  assert.ok(s.titleOverlap('Nvidia posts record quarterly revenue', 'Nvidia reports record revenue') >= 0.5);
  assert.ok(s.titleOverlap('Nvidia posts record revenue', 'Weather in Kyiv tomorrow') < 0.2);
  assert.ok(s.entityHitRatio(['Nvidia', 'Jensen Huang'], 'Nvidia said on Tuesday') === 0.5);
  assert.ok(s.buildQueries('Nvidia posts record revenue', ['Nvidia', 'Jensen Huang']).length >= 1);
  const { rootOf } = require('../dist/kb/kb-corroboration.service.js');
  const ctx = { eventTitle: 'Nvidia posts record revenue', entities: ['Nvidia'], startedAt: '2026-11-17T18:00:00Z', knownRoots: new Set(['bbc.co.uk']), blockedRoots: new Set(['msn.com']), rootOf };
  const mk = (url, title, publishedAt = '2026-11-17T20:00:00Z') => ({ url, title, source: 'x', publishedAt, provider: 'bing' });
  const out = s.filterHits([
    mk('https://www.reuters.com/a', 'Nvidia posts record revenue in Q3'),
    mk('https://www.msn.com/a', 'Nvidia posts record revenue'),
    mk('https://www.bbc.co.uk/a', 'Nvidia posts record revenue'),
    mk('http://insecure.com/a', 'Nvidia posts record revenue'),
    mk('https://old.com/a', 'Nvidia posts record revenue', '2026-10-01T00:00:00Z'),
    mk('https://other.com/tag/nvidia', 'Nvidia posts record revenue'),
    mk('https://offtopic.com/a', 'Weather in Kyiv'),
  ], ctx);
  assert.deepEqual(out.map((h) => h.url), ['https://www.reuters.com/a']);
});

test('corroboration: Gemma verdicts are coerced strictly', () => {
  const { coerceVerdict } = require('../dist/kb/kb-corroboration.service.js');
  const ok = { same_event: 'true', match_confidence: '0.9', on_topic: true, source_type: 'news_agency', reliability: 'high', independent: true, adds_information: true, characterization: 'wire', reason: 'x' };
  assert.equal(coerceVerdict(ok).same_event, true);
  assert.equal(coerceVerdict({ ...ok, source_type: 'made-up' }), null);
  assert.equal(coerceVerdict({ ...ok, match_confidence: 'high' }), null);
  assert.equal(coerceVerdict(null), null);
});

test('news search: ordinary web hits need a deeper URL and a stricter title match', () => {
  const s = require('../dist/kb/kb-news-search.js');
  const { rootOf } = require('../dist/kb/kb-corroboration.service.js');
  const ctx = { eventTitle: 'Nvidia posts record revenue', entities: ['Nvidia'], startedAt: null, knownRoots: new Set(), blockedRoots: new Set(), rootOf };
  const web = (url, title) => ({ url, title, source: '', publishedAt: null, provider: 'bing-web' });
  const out = s.filterHits([
    web('https://nvidianews.nvidia.com/news/nvidia-announces-record-revenue', 'NVIDIA Announces Record Revenue'),
    web('https://www.nvidia.com/', 'NVIDIA Record Revenue Home'),
    web('https://en.wikipedia.org/wiki/Nvidia/revenue', 'Nvidia record revenue'),
    web('https://finance.example.com/quote/NVDA', 'Nvidia stock'),
  ], ctx);
  assert.deepEqual(out.map((h) => h.url), ['https://nvidianews.nvidia.com/news/nvidia-announces-record-revenue']);
});
