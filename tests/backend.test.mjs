import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { canonicalizeUrl, retryWithBackoff } from '../dist/common/url-utils.js';
import { parseFeedXml } from '../dist/news/company-feeds.service.js';
import { validateArticle } from '../dist/ingest/gemini-editor.service.js';
import { IngestKeyGuard } from '../dist/common/ingest-key.guard.js';
import { diffCatalogItems, isPromotionExpired } from '../dist/catalog/catalog.service.js';
import { INITIAL_CATALOG } from '../dist/catalog/catalog-seed.js';
import { slugifySource } from '../dist/news/source-discovery.service.js';
import { detectStoreName } from '../dist/games/games.service.js';

test('canonicalizeUrl strips tracking params, www, hash, and trailing slash', () => {
  const input = 'https://www.openai.com/news/gpt-5/?utm_source=rss&fbclid=123&ref=x#top';
  assert.equal(canonicalizeUrl(input), 'https://openai.com/news/gpt-5');
});

test('parseFeedXml parses RSS 2.0 and deduplicates canonical URLs', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel><title>OpenAI</title>
    <item>
      <title>New Model</title>
      <link>https://openai.com/news/new-model/?utm_source=rss</link>
      <pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    </item>
    <item>
      <title>New Model Duplicate</title>
      <link>https://www.openai.com/news/new-model/</link>
      <pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate>
      <description>Duplicate</description>
    </item>
    <item>
      <title>Bad Domain</title>
      <link>https://evil.example.com/news/hack</link>
      <pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;

  const items = parseFeedXml(rss, {
    slug: 'openai-news',
    name: 'OpenAI',
    domain: 'openai.com',
    url: 'https://openai.com/news/rss.xml',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].canonical_url, 'https://openai.com/news/new-model');
  assert.equal(items[0].original_summary, 'Hello world');
});

test('parseFeedXml parses Atom feeds', () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <title>Hugging Face Blog</title>
    <entry>
      <title>Open Weights Update</title>
      <link rel="alternate" href="https://huggingface.co/blog/open-weights"/>
      <published>2026-11-14T08:00:00Z</published>
      <summary>Details about open weights</summary>
    </entry>
  </feed>`;

  const items = parseFeedXml(atom, {
    slug: 'hugging-face',
    name: 'Hugging Face',
    domain: 'huggingface.co',
    url: 'https://huggingface.co/blog/feed.xml',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].original_title, 'Open Weights Update');
  assert.equal(items[0].canonical_url, 'https://huggingface.co/blog/open-weights');
});

test('validateArticle validates structured Gemini JSON and enforces source grounding', () => {
  const valid = validateArticle({
    title: 'Оновлення моделі',
    summary: 'Короткий огляд.',
    body: 'Текст статті [1].',
    important: true,
    importance_reason: 'Важливий реліз.',
    category: 'model',
    sources: [{ title: 'Official', url: 'https://openai.com/news/test' }],
    facts: [{ claim: 'Контекст 128k', status: 'confirmed', url: 'https://openai.com/news/test' }],
    comparisons: [],
    confidence: 'high',
    editorial: { angles: ['engineering'], style: 'concise', limitations: '' },
  }, 'https://openai.com/news/test');

  assert.equal(valid.title, 'Оновлення моделі');
  assert.equal(valid.sources.length, 1);

  assert.throws(() => validateArticle({
    title: 'Bad',
    summary: 'S',
    body: 'B',
    important: false,
    importance_reason: 'R',
    category: 'model',
    sources: [],
    facts: [{ claim: 'Fake', status: 'confirmed', url: 'https://not-in-sources.example/x' }],
    comparisons: [],
    confidence: 'low',
    editorial: { angles: [], style: 's', limitations: '' },
  }, 'https://openai.com/news/test'), /Fact source is missing/);
});

test('IngestKeyGuard enforces x-ingest-key', () => {
  process.env.INGEST_API_KEY = 'a'.repeat(32);
  const guard = new IngestKeyGuard();
  const makeCtx = (key) => ({
    switchToHttp: () => ({
      getRequest: () => ({ header: (name) => (name === 'x-ingest-key' ? key : undefined) }),
    }),
  });

  assert.equal(guard.canActivate(makeCtx('a'.repeat(32))), true);
  assert.throws(() => guard.canActivate(makeCtx('wrong')), UnauthorizedException);
  assert.throws(() => guard.canActivate(makeCtx(undefined)), UnauthorizedException);
});

test('isPromotionExpired and diffCatalogItems detect expiration and incremental changes', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  assert.equal(isPromotionExpired({ title: 'Old', badge: 'X', description: 'D', eligible: 'All', expires: '2026-11-01' }, now), true);
  assert.equal(isPromotionExpired({ title: 'Active', badge: 'X', description: 'D', eligible: 'All', expires: '2026-12-31' }, now), false);

  const prev = {
    id: 'test',
    providerId: 'test',
    providerName: 'Test',
    category: 'Cat',
    title: 'T',
    tagline: 'Tag',
    models: [{ name: 'M1', contextWindow: '100k', bestFor: 'Code', strengths: ['Fast'] }],
    freeTier: { hasFree: true, limits: '10 RPM', description: 'D', renewPeriod: 'Daily' },
    currentPromotions: [],
    advantages: [],
    limitations: [],
    pricingSummary: '$1/1M',
    officialUrl: 'https://example.com',
    lastVerifiedAt: now.toISOString(),
  };
  const next = {
    ...prev,
    models: [...prev.models, { name: 'M2', contextWindow: '200k', bestFor: 'All', strengths: ['Smart'] }],
    pricingSummary: '$0.50/1M',
  };

  const changes = diffCatalogItems(prev, next, 'https://example.com/pricing');
  assert.equal(changes.length, 2);
  assert.equal(changes[0].changeType, 'model_added');
  assert.equal(changes[1].changeType, 'pricing_updated');
});

test('retryWithBackoff retries transient errors and succeeds', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 50 },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('slugifySource normalizes source names into valid slugs', () => {
  assert.equal(slugifySource('LangChain Blog!'), 'langchain-blog');
  assert.match(slugifySource('AI'), /^src-[a-f0-9]{12}$/);
});

test('INITIAL_CATALOG covers top 12 AI providers with pricing metadata', () => {
  assert.ok(INITIAL_CATALOG.length >= 12);
  for (const item of INITIAL_CATALOG) {
    assert.ok(item.pricingSummary.length > 0);
    assert.ok(item.minInputPricePer1M !== undefined);
  }
});

test('detectStoreName identifies game marketplaces', () => {
  assert.equal(detectStoreName('PC, Epic Games Store', 'https://store.epicgames.com/uk/p/test'), 'Epic Games');
  assert.equal(detectStoreName('Steam', 'https://store.steampowered.com/app/123'), 'Steam');
  assert.equal(detectStoreName('GOG', 'https://www.gog.com/game/test'), 'GOG');
});
