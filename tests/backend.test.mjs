import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { canonicalizeUrl, retryWithBackoff } from '../dist/common/url-utils.js';
import { parseFeedXml } from '../dist/news/company-feeds.service.js';
import { validateArticle } from '../dist/ingest/gemini-editor.service.js';
import { IngestKeyGuard } from '../dist/common/ingest-key.guard.js';
import { diffCatalogItems, isPromotionExpired } from '../dist/catalog/catalog.service.js';
import { INITIAL_CATALOG } from '../dist/catalog/catalog-seed.js';
import { slugifySource } from '../dist/news/source-discovery.service.js';
import { detectStoreName } from '../dist/games/games.service.js';
import {
  classifyCredibilityTier,
  extractEntitySlugs,
  KG_SEED_ENTITIES,
  KG_SEED_RELATIONS,
} from '../dist/kg/kg-seed.js';
import {
  computeGrantMatchScore,
  GRANT_COUNTRY_LABELS_UK,
  GRANT_SECTOR_LABELS_UK,
  INITIAL_GRANTS_SEED,
} from '../dist/grants/grants-seed.js';
import { GrantsService } from '../dist/grants/grants.service.js';
import { GrantsController } from '../dist/grants/grants.controller.js';
import { HealthController } from '../dist/health/health.controller.js';

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

test('extractEntitySlugs links NVIDIA, GPU, local AI, and Ollama', () => {
  const slugs = extractEntitySlugs('NVIDIA Blackwell RTX GPU accelerates local AI with Ollama and Llama 3');
  assert.ok(slugs.includes('nvidia'));
  assert.ok(slugs.includes('gpu-hardware'));
  assert.ok(slugs.includes('local-ai'));
  assert.ok(slugs.includes('ollama-vllm'));
  assert.ok(slugs.includes('llama-models'));
});

test('classifyCredibilityTier separates independent tests, verified facts, and rumors', () => {
  assert.equal(classifyCredibilityTier('Independent SWE-bench benchmark on arXiv').tier, 'independent_test');
  assert.equal(classifyCredibilityTier('Official release notes v2.1 documentation').tier, 'verified_fact');
  assert.equal(classifyCredibilityTier('Rumor: new model might launch next week', true).tier, 'ai_inference');
  assert.equal(classifyCredibilityTier('Correction: earlier latency figures updated').isCorrectionSignal, true);
});

test('INITIAL_GRANTS_SEED covers all 5 regions, all 6 sectors, valid https URLs, and requirementsUk', () => {
  assert.ok(INITIAL_GRANTS_SEED.length >= 16);

  const seenIds = new Set();
  const countries = new Set();
  const sectors = new Set();
  const validTypes = new Set(['grant', 'accelerator', 'cloud_credits', 'fellowship', 'competition']);
  const validStages = new Set(['idea', 'mvp', 'scale']);

  for (const grant of INITIAL_GRANTS_SEED) {
    assert.ok(grant.externalId.length > 0 && grant.externalId.length <= 160);
    assert.equal(seenIds.has(grant.externalId), false, `Duplicate externalId: ${grant.externalId}`);
    seenIds.add(grant.externalId);

    assert.ok(grant.titleUk.length > 5);
    assert.ok(grant.organization.length > 2);
    assert.equal(grant.countryLabelUk, GRANT_COUNTRY_LABELS_UK[grant.countryCode]);
    assert.equal(grant.sectorLabelUk, GRANT_SECTOR_LABELS_UK[grant.sector]);
    assert.ok(validTypes.has(grant.opportunityType));
    assert.ok(validStages.has(grant.stage));
    assert.ok(grant.fundingAmount.length > 0);
    assert.ok(grant.fundingMaxUsd > 0);
    assert.ok(grant.worthScore >= 50 && grant.worthScore <= 100);
    assert.ok(grant.summaryUk.length > 20);
    assert.ok(grant.eligibilityUk.length > 15);
    assert.ok(grant.applicationTipsUk && grant.applicationTipsUk.length > 10);
    assert.ok(grant.officialUrl.startsWith('https://'), `Invalid URL: ${grant.officialUrl}`);
    assert.ok(Array.isArray(grant.requirementsUk) && grant.requirementsUk.length >= 3 && grant.requirementsUk.length <= 5);
    for (const req of grant.requirementsUk) {
      assert.equal(typeof req, 'string');
      assert.ok(req.trim().length > 5);
    }
    if (!grant.isRolling) {
      assert.ok(grant.deadlineAt && Number.isFinite(Date.parse(grant.deadlineAt)));
    }

    countries.add(grant.countryCode);
    sectors.add(grant.sector);
  }

  for (const code of ['ua', 'eu', 'us', 'uk', 'global']) {
    assert.ok(countries.has(code), `Missing country coverage: ${code}`);
  }
  for (const sector of ['ai_deeptech', 'defensetech', 'greentech', 'edtech_science', 'sme_veterans', 'creative_media']) {
    assert.ok(sectors.has(sector), `Missing sector coverage: ${sector}`);
  }
});

test('computeGrantMatchScore returns clamped [40, 99] integers and ranks aligned grants higher', () => {
  const brave1 = INITIAL_GRANTS_SEED.find((g) => g.externalId === 'brave1-defense-tech');
  const eic = INITIAL_GRANTS_SEED.find((g) => g.externalId === 'eic-accelerator-horizon');
  assert.ok(brave1 && eic);

  const alignedScore = computeGrantMatchScore(brave1, {
    legalStatus: 'tov',
    stage: 'mvp',
    sector: 'defensetech',
    country: 'ua',
    preferEquityFree: true,
  });
  const mismatchedScore = computeGrantMatchScore(eic, {
    legalStatus: 'individual',
    stage: 'idea',
    sector: 'creative_media',
    country: 'us',
    preferEquityFree: true,
  });

  assert.ok(Number.isInteger(alignedScore) && alignedScore >= 40 && alignedScore <= 99);
  assert.ok(Number.isInteger(mismatchedScore) && mismatchedScore >= 40 && mismatchedScore <= 99);
  assert.ok(alignedScore > mismatchedScore);

  for (const grant of INITIAL_GRANTS_SEED) {
    const score = computeGrantMatchScore(grant, {
      legalStatus: 'fop',
      stage: 'mvp',
      sector: 'ai_deeptech',
      country: 'ua',
      preferEquityFree: true,
    });
    assert.ok(Number.isInteger(score) && score >= 40 && score <= 99);
  }
});

test('KG seed contains grant ecosystem entities and links them to AI entities', () => {
  const slugs = new Set(KG_SEED_ENTITIES.map((e) => e.slug));
  const allowedTypes = new Set(['company', 'model', 'technology', 'product', 'event']);

  for (const entity of KG_SEED_ENTITIES) {
    assert.ok(allowedTypes.has(entity.entityType), `Invalid KG entityType: ${entity.entityType}`);
  }
  for (const grantSlug of ['brave1-usf', 'eic-horizon', 'cloud-gpu-grants']) {
    assert.ok(slugs.has(grantSlug), `Missing KG grant entity: ${grantSlug}`);
  }
  for (const rel of KG_SEED_RELATIONS) {
    assert.ok(slugs.has(rel.from), `Unknown relation from: ${rel.from}`);
    assert.ok(slugs.has(rel.to), `Unknown relation to: ${rel.to}`);
  }

  const linkedTargets = new Set(
    KG_SEED_RELATIONS.flatMap((r) =>
      ['brave1-usf', 'eic-horizon', 'cloud-gpu-grants'].includes(r.from)
        ? [r.to]
        : ['brave1-usf', 'eic-horizon', 'cloud-gpu-grants'].includes(r.to)
          ? [r.from]
          : [],
    ),
  );
  for (const expectedTarget of ['nvidia', 'google', 'openai', 'local-ai', 'ai-agents', 'ai-coding-tools']) {
    assert.ok(linkedTargets.has(expectedTarget), `Missing KG grant link to: ${expectedTarget}`);
  }

  const matched = extractEntitySlugs('Brave1 and USF launch DefenseTech call with NVIDIA DGX Cloud credits');
  assert.ok(matched.includes('brave1-usf'));
  assert.ok(matched.includes('nvidia'));
  assert.ok(matched.includes('cloud-gpu-grants'));
});

test('GrantsService and GrantsController fall back cleanly to INITIAL_GRANTS_SEED when DB is unavailable', async () => {
  const failingDb = {
    query: async () => {
      throw new Error('relation "grants_opportunities" does not exist');
    },
  };
  const service = new GrantsService(failingDb);
  const controller = new GrantsController(service);

  const all = await service.list();
  assert.equal(all.total, INITIAL_GRANTS_SEED.length);
  assert.equal(all.items.length, INITIAL_GRANTS_SEED.length);
  assert.equal(all.hasMore, false);

  const uaGrants = await service.list({ country: 'ua' });
  assert.equal(uaGrants.total, 4);
  assert.ok(uaGrants.items.every((g) => g.countryCode === 'ua'));

  const byFunding = await service.list({ sort: 'funding_desc', limit: 3 });
  assert.equal(byFunding.items.length, 3);
  assert.equal(byFunding.hasMore, true);
  assert.equal(byFunding.items[0].externalId, 'eic-accelerator-horizon');

  const byDeadline = await service.list({ sort: 'deadline_asc' });
  assert.equal(byDeadline.items[0].isRolling, false);
  assert.equal(byDeadline.items[0].externalId, 'house-of-europe-culture-media');

  const meta = await controller.getMeta();
  assert.equal(meta.totalActive, INITIAL_GRANTS_SEED.length);
  assert.equal(meta.uaCount, 4);
  assert.equal(meta.byCountry.ua, 4);
  assert.ok(meta.totalFundingUsd > 5_000_000);

  const brave1 = await controller.detail('brave1-defense-tech');
  assert.equal(brave1.countryCode, 'ua');

  await assert.rejects(() => controller.detail('missing-grant-id'), NotFoundException);
});

test('HealthController.summary falls back gracefully to INITIAL_GRANTS_SEED when grants table is absent', async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('grants_opportunities')) {
        throw new Error('relation "grants_opportunities" does not exist');
      }
      if (sql.includes('news_items')) {
        return { rows: [{ total: '5', important_total: '2', needs_review: '1', rejected: '0', last_at: null }] };
      }
      if (sql.includes('sources')) {
        return { rows: [{ total: '10', healthy: '9' }] };
      }
      if (sql.includes('ai_catalogs')) {
        return { rows: [{ total: '12', last_verified: null }] };
      }
      return { rows: [{ total: '3', free_giveaways: '2', last_verified: null }] };
    },
  };
  const health = new HealthController(mockDb);
  const summary = await health.summary();
  assert.equal(summary.status, 'ok');
  assert.equal(summary.grants.active, INITIAL_GRANTS_SEED.length);
  assert.equal(summary.grants.equityFree, INITIAL_GRANTS_SEED.filter((g) => g.equityFree).length);
  assert.ok(summary.grants.totalFundingUsd > 5_000_000);
});
