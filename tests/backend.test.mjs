import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { canonicalizeUrl, retryWithBackoff } from '../dist/common/url-utils.js';
import { parseFeedXml } from '../dist/news/company-feeds.service.js';
import {
  EDITORIAL_ARTICLE_SCHEMA,
  GeminiEditorService,
  validateArticle,
} from '../dist/ingest/gemini-editor.service.js';
import { IngestKeyGuard } from '../dist/common/ingest-key.guard.js';
import { CatalogService, diffCatalogItems, isPromotionExpired } from '../dist/catalog/catalog.service.js';
import { computeModelTokenPracticality, INITIAL_CATALOG } from '../dist/catalog/catalog-seed.js';
import { slugifySource } from '../dist/news/source-discovery.service.js';
import { detectStoreName } from '../dist/games/games.service.js';
import {
  buildGeminiRequestBody,
  canUseHydrogenQuota,
  DEFAULT_HYDROGEN_MODEL,
  FALLBACK_GEMINI_MODELS,
  getHydrogenQuotaStatus,
  isHydrogenModel,
  normalizeGeminiModel,
  postGeminiGenerateContent,
  recordHydrogenUsage,
  resetGeminiClientStateForTests,
  supportsSearchTools,
} from '../dist/common/gemini-client.js';
import {
  buildBroadcastScriptUk,
  NewsTtsService,
  pcm16ToWavBase64,
  PREFERRED_TTS_MODELS,
} from '../dist/news/news-tts.service.js';
import {
  classifyCredibilityTier,
  extractEntitySlugs,
  KG_SEED_ENTITIES,
  KG_SEED_RELATIONS,
} from '../dist/kg/kg-seed.js';
import {
  computeGrantMatchScore,
  GRANT_AUDIENCE_LABELS_UK,
  GRANT_COUNTRY_LABELS_UK,
  GRANT_SECTOR_LABELS_UK,
  INITIAL_GRANTS_SEED,
} from '../dist/grants/grants-seed.js';
import { GrantsService } from '../dist/grants/grants.service.js';
import { GrantsController } from '../dist/grants/grants.controller.js';
import { HealthController } from '../dist/health/health.controller.js';
import { buildHealthUrls, parseKeepAliveArgs } from '../scripts/keep-alive.mjs';

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

test('INITIAL_GRANTS_SEED covers all 5 regions, 6 sectors, 6 audiences, hackathons/contests, and valid https URLs', () => {
  assert.ok(INITIAL_GRANTS_SEED.length >= 25);

  const seenIds = new Set();
  const countries = new Set();
  const sectors = new Set();
  const types = new Set();
  const audiences = new Set();
  const validTypes = new Set(['grant', 'hackathon', 'accelerator', 'contest', 'cloud_credits', 'fellowship']);
  const validStages = new Set(['idea', 'mvp', 'scale']);
  const validAudiences = new Set(Object.keys(GRANT_AUDIENCE_LABELS_UK));

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
    assert.ok(Array.isArray(grant.audiences) && grant.audiences.length >= 1);
    for (const aud of grant.audiences) {
      assert.ok(validAudiences.has(aud), `Invalid audience: ${aud}`);
      audiences.add(aud);
    }
    assert.ok(grant.targetAudienceUk && grant.targetAudienceUk.length > 5);
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
    types.add(grant.opportunityType);
  }

  for (const code of ['ua', 'eu', 'us', 'uk', 'global']) {
    assert.ok(countries.has(code), `Missing country coverage: ${code}`);
  }
  for (const sector of ['ai_deeptech', 'defensetech', 'greentech', 'edtech_science', 'sme_veterans', 'creative_media']) {
    assert.ok(sectors.has(sector), `Missing sector coverage: ${sector}`);
  }
  for (const aud of ['students_youth', 'indie_devs', 'startups', 'researchers', 'defense_veterans', 'sme_ngo']) {
    assert.ok(audiences.has(aud), `Missing audience coverage: ${aud}`);
  }
  assert.ok(types.has('hackathon'), 'Expected hackathon opportunities');
  assert.ok(types.has('contest'), 'Expected contest opportunities');
});

test('computeGrantMatchScore supports audience (+12) and clamps scores to [40, 99]', () => {
  const brave1 = INITIAL_GRANTS_SEED.find((g) => g.externalId === 'brave1-defense-tech');
  const eic = INITIAL_GRANTS_SEED.find((g) => g.externalId === 'eic-accelerator-horizon');
  const devpost = INITIAL_GRANTS_SEED.find((g) => g.externalId === 'devpost-mlh-ai-hackathons');
  assert.ok(brave1 && eic && devpost);

  const alignedScore = computeGrantMatchScore(brave1, {
    legalStatus: 'tov',
    stage: 'mvp',
    sector: 'defensetech',
    country: 'ua',
    audience: 'defense_veterans',
    preferEquityFree: true,
  });
  const mismatchedScore = computeGrantMatchScore(eic, {
    legalStatus: 'individual',
    stage: 'idea',
    sector: 'creative_media',
    country: 'us',
    audience: 'students_youth',
    preferEquityFree: true,
  });

  assert.ok(Number.isInteger(alignedScore) && alignedScore >= 40 && alignedScore <= 99);
  assert.ok(Number.isInteger(mismatchedScore) && mismatchedScore >= 40 && mismatchedScore <= 99);
  assert.ok(alignedScore > mismatchedScore);

  const withoutAud = computeGrantMatchScore(devpost, {});
  const withMatchedAud = computeGrantMatchScore(devpost, { audience: 'students_youth' });
  const withMismatchedAud = computeGrantMatchScore(devpost, { audience: 'sme_ngo' });
  assert.equal(withMatchedAud - withoutAud, 12);
  assert.ok(withMatchedAud > withMismatchedAud);

  for (const grant of INITIAL_GRANTS_SEED) {
    const score = computeGrantMatchScore(grant, {
      legalStatus: 'fop',
      stage: 'mvp',
      sector: 'ai_deeptech',
      country: 'ua',
      audience: 'startups',
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

test('GrantsService and GrantsController support audience filtering, meta fields, and DB fallbacks', async () => {
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
  assert.equal(uaGrants.total, 6);
  assert.ok(uaGrants.items.every((g) => g.countryCode === 'ua'));

  const studentGrants = await controller.list(
    undefined,
    undefined,
    undefined,
    undefined,
    'students_youth',
  );
  assert.ok(studentGrants.total >= 10);
  assert.ok(studentGrants.items.every((g) => g.audiences.includes('students_youth')));

  const hackathons = await service.list({ type: 'hackathon' });
  assert.ok(hackathons.total >= 3);
  assert.ok(hackathons.items.every((g) => g.opportunityType === 'hackathon'));

  const byFunding = await service.list({ sort: 'funding_desc', limit: 3 });
  assert.equal(byFunding.items.length, 3);
  assert.equal(byFunding.hasMore, true);
  assert.equal(byFunding.items[0].externalId, 'eic-accelerator-horizon');

  const byDeadline = await service.list({ sort: 'deadline_asc' });
  assert.equal(byDeadline.items[0].isRolling, false);
  assert.equal(byDeadline.items[0].externalId, 'house-of-europe-culture-media');

  const meta = await controller.getMeta();
  assert.equal(meta.totalActive, INITIAL_GRANTS_SEED.length);
  assert.equal(meta.uaCount, 6);
  assert.equal(meta.byCountry.ua, 6);
  assert.equal(meta.dailyCheckIntervalHours, 24);
  assert.ok(Number.isFinite(Date.parse(meta.lastAiVerificationAt)));
  for (const aud of Object.keys(GRANT_AUDIENCE_LABELS_UK)) {
    assert.ok((meta.byAudience[aud] ?? 0) > 0, `Missing meta.byAudience for ${aud}`);
  }
  assert.ok(meta.totalFundingUsd > 5_000_000);

  const brave1 = await controller.detail('brave1-defense-tech');
  assert.equal(brave1.countryCode, 'ua');
  assert.ok(brave1.audiences.includes('defense_veterans'));

  await assert.rejects(() => controller.detail('missing-grant-id'), NotFoundException);

  // Verify daily verification check skips cleanly within 24h cooldown
  GrantsService.lastAiVerificationAt = new Date().toISOString();
  const verifyResult = await service.verifyAndRefreshWithGemini(false);
  assert.equal(verifyResult.skipped, true);
});

test('GrantsService gracefully falls back when migration 009 columns do not exist yet', async () => {
  const pre009Db = {
    query: async (sql) => {
      if (sql.includes('UPDATE grants_opportunities')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('target_audience_uk') || sql.includes('audiences @>')) {
        throw new Error('column "audiences" does not exist');
      }
      if (sql.includes('FROM grants_opportunities')) {
        return {
          rows: [
            {
              id: '1',
              externalId: 'brave1-defense-tech',
              title: 'Brave1 Defense Tech Grants',
              titleUk: 'Brave1 — Гранти на DefenseTech-розробки',
              organization: 'Brave1',
              countryCode: 'ua',
              countryLabelUk: 'Україна',
              regionDetailsUk: 'Україна',
              sector: 'defensetech',
              sectorLabelUk: 'DefenseTech та Кібербезпека',
              opportunityType: 'grant',
              fundingAmount: 'до $200,000',
              fundingMaxUsd: 200000,
              equityFree: true,
              coFinancingPct: 0,
              stage: 'mvp',
              deadlineAt: null,
              isRolling: true,
              summaryUk: 'Опис гранту Brave1.',
              eligibilityUk: 'Українські компанії.',
              requirementsUk: ['Анкета', 'Pitch deck', 'Бюджет'],
              applicationTipsUk: 'Порада.',
              officialUrl: 'https://brave1.gov.ua/',
              worthScore: 98,
              status: 'active',
              lastVerifiedAt: '2026-11-14T18:00:00Z',
              totalCount: 1,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const service = new GrantsService(pre009Db);
  const res = await service.list({ audience: 'defense_veterans' });
  assert.equal(res.total, 1);
  assert.equal(res.items[0].externalId, 'brave1-defense-tech');
  assert.ok(res.items[0].audiences.includes('defense_veterans'));
  assert.ok(res.items[0].targetAudienceUk.length > 0);
});

test('HealthController.summary exposes grants audience breakdown and 24h AI verification metadata', async () => {
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
  assert.equal(summary.grants.dailyCheckIntervalHours, 24);
  assert.ok(Number.isFinite(Date.parse(summary.grants.lastAiVerificationAt)));
  assert.ok((summary.grants.byAudience.students_youth ?? 0) > 0);
  assert.ok(summary.grants.totalFundingUsd > 5_000_000);
});

test('computeModelTokenPracticality scores INITIAL_CATALOG models deterministically', () => {
  for (const provider of INITIAL_CATALOG) {
    assert.ok(provider.models.length > 0);
    for (const model of provider.models) {
      assert.ok(typeof model.tokenPracticalityScore === 'number');
      assert.ok(model.tokenPracticalityScore >= 0 && model.tokenPracticalityScore <= 100);
      assert.ok(typeof model.costEfficiencyScore === 'number');
      assert.ok(model.costEfficiencyScore >= 0 && model.costEfficiencyScore <= 100);
      assert.ok(typeof model.tokensPer1kWordsUk === 'number');
      assert.ok(model.tokensPer1kWordsUk >= 1450 && model.tokensPer1kWordsUk <= 2350);
      assert.ok(typeof model.practicalityNoteUk === 'string' && model.practicalityNoteUk.length > 15);
    }
  }

  const geminiFlash = computeModelTokenPracticality(
    {
      name: 'Gemini 2.5 Flash',
      contextWindow: '1M',
      contextTokens: 1000000,
      inputPrice: '$0.075 / 1M',
      outputPrice: '$0.30 / 1M',
      capabilities: ['fast', 'coding'],
      bestFor: 'Fast API',
      strengths: ['Fast'],
    },
    'gemini',
  );
  const heavyReasoning = computeModelTokenPracticality(
    {
      name: 'OpenAI o1',
      contextWindow: '200k',
      contextTokens: 200000,
      inputPrice: '$15.00 / 1M',
      outputPrice: '$60.00 / 1M',
      capabilities: ['reasoning', 'math'],
      bestFor: 'Math',
      strengths: ['Reasoning'],
    },
    'openai',
  );
  assert.ok(geminiFlash.tokenPracticalityScore > heavyReasoning.tokenPracticalityScore);
  assert.ok(geminiFlash.costEfficiencyScore > heavyReasoning.costEfficiencyScore);
  assert.ok(geminiFlash.tokensPer1kWordsUk < 1600);

  const catalogSvc = new CatalogService({ query: async () => ({ rows: [] }) });
  assert.equal(catalogSvc.getDailyVerificationStatus().dailyCheckIntervalHours, 24);
});

test('Gemini client prioritizes Gemini 3.8/3.6/3 Flash + Hydrogen router and strips tools for Hydrogen', () => {
  assert.deepEqual(FALLBACK_GEMINI_MODELS.slice(0, 5), [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3-flash',
    'gemini-4-hydrogen',
    'gemini-2.5-flash',
  ]);
  assert.equal(normalizeGeminiModel(undefined), 'gemini-3.8-flash');
  assert.equal(normalizeGeminiModel('models/gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(DEFAULT_HYDROGEN_MODEL, 'gemini-4-hydrogen');
  assert.equal(isHydrogenModel('gemini-4-hydrogen'), true);
  assert.equal(isHydrogenModel('gemini-3.8-flash'), false);
  assert.equal(supportsSearchTools('gemini-4-hydrogen'), false);
  assert.equal(supportsSearchTools('gemini-3.8-flash'), true);

  const baseBody = {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object', properties: {} },
    },
  };

  const body38 = buildGeminiRequestBody(baseBody, 'gemini-3.8-flash', '1024');
  assert.deepEqual(body38.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  assert.ok(Array.isArray(body38.tools));

  const bodyHydrogen = buildGeminiRequestBody(baseBody, 'gemini-4-hydrogen', '1024');
  assert.equal(bodyHydrogen.tools, undefined);
  assert.deepEqual(bodyHydrogen.generationConfig.thinkingConfig, { thinkingBudget: 1024 });

  const body25 = buildGeminiRequestBody(baseBody, 'gemini-2.5-flash', '1024');
  assert.deepEqual(body25.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  assert.deepEqual(body25.generationConfig.responseJsonSchema, { type: 'object', properties: {} });
  assert.equal(body25.generationConfig.temperature, 0.2);

  const body20 = buildGeminiRequestBody(baseBody, 'gemini-2.0-flash', '1024');
  assert.equal(body20.generationConfig.thinkingConfig, undefined);

  const explicitBody = buildGeminiRequestBody(
    {
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    },
    'gemini-3.8-flash',
    '2048',
  );
  assert.deepEqual(explicitBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('HydrogenQuotaGuard enforces elevated 10 RPM / 150 RPD limits and fast 404 fallback caches unavailable models', async () => {
  resetGeminiClientStateForTests();
  try {
    const initial = getHydrogenQuotaStatus();
    assert.equal(initial.maxRpm, 10);
    assert.equal(initial.maxRpd, 150);
    assert.equal(initial.remainingToday, 150);
    assert.equal(canUseHydrogenQuota(), true);

    recordHydrogenUsage(149);
    assert.equal(canUseHydrogenQuota(), true);
    assert.equal(getHydrogenQuotaStatus().remainingToday, 1);

    recordHydrogenUsage(1);
    assert.equal(getHydrogenQuotaStatus().remainingToday, 0);
    assert.equal(canUseHydrogenQuota(), false);

    resetGeminiClientStateForTests();
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('gemini-3.8-flash:generateContent')) {
        return new Response('Model not found', { status: 404 });
      }
      return new Response(
        JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    try {
      const startedAt = Date.now();
      const first = await postGeminiGenerateContent({
        apiKey: 'test-key',
        preferredModel: 'gemini-3.8-flash',
        candidateModels: ['gemini-3.8-flash', 'gemini-3.6-flash'],
        body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      });
      const elapsedMs = Date.now() - startedAt;
      assert.equal(first.modelUsed, 'gemini-3.6-flash');
      assert.ok(elapsedMs < 2_000, `Expected instant 404 fallback without 15.5s wait, got ${elapsedMs}ms`);
      assert.equal(calls.length, 2);

      calls.length = 0;
      const second = await postGeminiGenerateContent({
        apiKey: 'test-key',
        preferredModel: 'gemini-3.8-flash',
        candidateModels: ['gemini-3.8-flash', 'gemini-3.6-flash'],
        body: { contents: [{ role: 'user', parts: [{ text: 'ping2' }] }] },
      });
      assert.equal(second.modelUsed, 'gemini-3.6-flash');
      // First model was cached from 404 so only gemini-3.6-flash is called
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('gemini-3.6-flash'));
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    resetGeminiClientStateForTests();
  }
});

test('Chain-of-Verification schema places evidence before prose and Hydrogen mechanisms operate cleanly', async () => {
  resetGeminiClientStateForTests();
  GeminiEditorService.resetHydrogenDirectiveCacheForTests();
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-hydrogen-key';

  const propKeys = Object.keys(EDITORIAL_ARTICLE_SCHEMA.properties);
  assert.ok(propKeys.indexOf('facts') < propKeys.indexOf('title'));
  assert.ok(propKeys.indexOf('confidence') < propKeys.indexOf('body'));
  assert.ok(propKeys.indexOf('important') < propKeys.indexOf('summary'));

  const dbUpdates = [];
  const mockDb = {
    query: async (sql, params = []) => {
      if (sql.includes("FROM news_items") && sql.includes("hydrogen_polished")) {
        return {
          rows: [
            {
              id: '42',
              external_id: 'rss-42',
              url: 'https://openai.com/news/test-42',
              original_title: 'Test Release 42',
              title_uk: 'Тест заголовка 42',
              summary_uk: 'Короткий опис 42',
              why_it_matters: 'Практичний вплив 42',
              category: 'model',
              importance: 'high',
              source_name: 'OpenAI',
            },
          ],
        };
      }
      if (sql.includes('UPDATE news_items')) {
        dbUpdates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM news_items')) {
        return {
          rows: [
            {
              title_uk: 'OpenAI випустила оновлення',
              original_title: 'OpenAI release',
              summary_uk: 'Опис попереднього релізу',
              category: 'model',
              published_at: '2026-11-14T10:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('FROM ai_catalogs')) {
        return {
          rows: [
            {
              name: 'Gemini 3.8 Flash',
              provider_id: 'gemini',
              pricing_summary_uk: '$0.10 / 1M',
              price_in: '$0.10',
              price_out: '$0.40',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const origFetch = globalThis.fetch;
  let directiveFetchCount = 0;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://openai.com/news/')) {
      return new Response(
        '<html><head><script>bad()</script></head><body><h1>Launch</h1><p>Latency dropped 35 percent in coding tasks.</p></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const body = JSON.parse(String(init?.body || '{}'));
    const userText = body?.contents?.[0]?.parts?.[0]?.text || '';
    if (userText.includes('Проаналізуй 5 останніх новин')) {
      directiveFetchCount += 1;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: 'Орієнтуйся на реальні токени, без кліше про революцію.' }] },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (userText.includes('"externalId":"ext-1"')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [
                        {
                          externalId: 'ext-1',
                          angleUk: 'Порівняння вартості інференсу',
                          skepticQuestionUk: 'Де незалежний бенчмарк на SWE-bench?',
                          compareWithUk: 'Claude Haiku 4.5 та DeepSeek V3.2',
                          boostImportant: true,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    items: [
                      {
                        id: '42',
                        titleUk: 'OpenAI оптимізувала затримку API для кодингу',
                        summaryUk: 'Оновлення зменшує латентність API на 35% у задачах генерації коду.',
                        whyItMatters: 'IDE-агенти реагуватимуть помітно швидше без зміни тарифу.',
                        hydrogenInsightUk: 'Ключова перевага саме у TTFT на довгих контекстах, але потрібні незалежні заміри.',
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const editor = new GeminiEditorService(mockDb);

    const evidencePack = await editor.collectArticleEvidencePack(
      { slug: 'openai', name: 'OpenAI', homepageUrl: 'https://openai.com' },
      {
        externalId: 'ext-1',
        url: 'https://openai.com/news/test-evidence',
        originalTitle: 'Test',
        category: 'model',
        importance: 'unknown',
        freeAccess: 'unknown',
      },
    );
    assert.ok(evidencePack.includes('Latency dropped 35 percent'));
    assert.ok(!evidencePack.includes('bad()'));
    assert.ok(evidencePack.includes('Gemini 3.8 Flash'));

    const d1 = await editor.refreshDailyHydrogenDirective(false);
    const d2 = await editor.refreshDailyHydrogenDirective(false);
    assert.equal(d1.cached, false);
    assert.equal(d2.cached, true);
    assert.equal(directiveFetchCount, 1);

    const angles = await editor.planBatchAnglesWithHydrogen([
      {
        externalId: 'ext-1',
        sourceName: 'OpenAI',
        originalTitle: 'Fast API Launch',
        originalSummary: '35% faster',
        url: 'https://openai.com/news/fast-api',
      },
    ]);
    assert.equal(angles['ext-1']?.boostImportant, true);
    assert.ok(angles['ext-1']?.compareWithUk.includes('DeepSeek'));

    const polishRes = await editor.polishArticlesBatchWithHydrogen(12);
    assert.equal(polishRes.polishedCount, 1);
    assert.equal(polishRes.modelUsed, 'gemini-4-hydrogen');
    assert.equal(dbUpdates.length, 1);
    assert.equal(dbUpdates[0].params[1], 'OpenAI оптимізувала затримку API для кодингу');
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    GeminiEditorService.resetHydrogenDirectiveCacheForTests();
    resetGeminiClientStateForTests();
  }
});

test('GeminiEditorService.edit runs Chain-of-Verification editorial and Hydrogen deep analysis pass for important items', async () => {
  resetGeminiClientStateForTests();
  GeminiEditorService.resetHydrogenDirectiveCacheForTests();
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-edit-key';

  const mockDb = {
    query: async (sql) => {
      if (sql.includes('FROM news_items')) {
        return { rows: [{ title_uk: 'Попередній реліз', original_title: 'Prev', summary_uk: 'Коротко', category: 'model', published_at: '2026-11-14T08:00:00Z' }] };
      }
      if (sql.includes('FROM ai_catalogs')) {
        return { rows: [{ name: 'Gemini 3.8 Flash', provider_id: 'gemini', pricing_summary_uk: '$0.10/1M', price_in: '$0.10', price_out: '$0.40' }] };
      }
      return { rows: [] };
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://openai.com/news/')) {
      return new Response('<html><body><p>Benchmark numbers confirmed on public repo.</p></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    const userText = body?.contents?.[0]?.parts?.[0]?.text || '';
    if (userText.includes('Проаналізуй 5 останніх новин')) {
      return new Response(
        JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Тримай фокус на вартості інференсу.' }] } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (target.includes('gemini-4-hydrogen:generateContent')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      hydrogen_insight: 'Перевірка показала реальне зниження затримки API без зростання ціни.',
                      refined_why_it_matters: 'Практичне прискорення продакшн-агентів уже сьогодні.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    sources: [{ title: 'OpenAI', url: 'https://openai.com/news/deep-1' }],
                    facts: [{ claim: 'Підтверджені бенчмарки', status: 'confirmed', url: 'https://openai.com/news/deep-1' }],
                    confidence: 'high',
                    important: true,
                    importance_reason: 'Суттєве оновлення API.',
                    category: 'api',
                    comparisons: ['Швидше за попередній реліз'],
                    title: 'OpenAI випустила швидкий режим API',
                    summary: 'Новий режим знижує затримку у продакшені.',
                    body: 'Повний огляд технологічних змін [1].',
                    editorial: { angles: ['engineering'], style: 'concise', limitations: '' },
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const editor = new GeminiEditorService(mockDb);
    const source = { slug: 'openai', name: 'OpenAI', homepageUrl: 'https://openai.com' };
    const item = {
      externalId: 'deep-1',
      url: 'https://openai.com/news/deep-1',
      originalTitle: 'Fast API Launch',
      originalSummary: 'Faster latency',
      category: 'api',
      importance: 'unknown',
      freeAccess: 'unknown',
    };
    const edited = await editor.edit(source, item, 'fp-deep-1', {
      angleHint: {
        externalId: 'deep-1',
        angleUk: 'Затримка інференсу',
        skepticQuestionUk: 'Чи не впала точність?',
        compareWithUk: 'Claude Haiku 4.5',
        boostImportant: true,
      },
    });
    assert.equal(edited.importance, 'high');
    assert.equal(edited.aiMetadata?.model, 'gemini-3.8-flash');
    assert.equal(edited.aiMetadata?.hydrogen_deep_analysis, true);
    assert.equal(
      edited.aiMetadata?.hydrogen_insight,
      'Перевірка показала реальне зниження затримки API без зростання ціни.',
    );
    assert.equal(edited.whyItMatters, 'Практичне прискорення продакшн-агентів уже сьогодні.');
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    GeminiEditorService.resetHydrogenDirectiveCacheForTests();
    resetGeminiClientStateForTests();
  }
});

test('NewsTtsService enforces importance gate, builds clean scripts, wraps PCM16 to RIFF WAVE, and caches results', async () => {
  resetGeminiClientStateForTests();
  assert.deepEqual(PREFERRED_TTS_MODELS, [
    'gemini-3.1-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-2.5-flash-preview-tts',
  ]);

  const script = buildBroadcastScriptUk({
    titleUk: '## **OpenAI** випустила агентський API [1]',
    summaryUk: 'Деталі на [сайті](https://openai.com/news) та https://example.com з підтримкою інструментів.',
    whyItMatters: 'Розробники отримують нижчу затримку.',
    sourceName: 'OpenAI',
  });
  assert.ok(!/https?:\/\/|[*#`\[\]]/.test(script));
  assert.ok(script.split(/\s+/).length <= 110);

  const samplePcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wavB64 = pcm16ToWavBase64(samplePcm, 24000, 1, 16);
  const wavBuf = Buffer.from(wavB64, 'base64');
  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wavBuf.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wavBuf.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wavBuf.length, 44 + samplePcm.length);

  const mockDb = {
    query: async (_sql, params = []) => {
      const targetId = params[0];
      if (targetId === 'minor-1') {
        return {
          rows: [
            {
              id: '10',
              external_id: 'minor-1',
              title_uk: 'Дрібне оновлення',
              original_title: 'Minor patch',
              summary_uk: 'Виправлено баги.',
              original_summary: null,
              why_it_matters: 'Незначно.',
              importance: 'low',
              important_flag: false,
              source_name: 'OpenAI',
            },
          ],
        };
      }
      if (targetId === 'major-1') {
        return {
          rows: [
            {
              id: '99',
              external_id: 'major-1',
              title_uk: 'Проривна мультимодальна модель',
              original_title: 'Major multimodal launch',
              summary_uk: 'Підтримка живого аудіо та відео у реальному часі.',
              original_summary: null,
              why_it_matters: 'Змінює голосові інтерфейси у мобільних застосунках.',
              importance: 'high',
              important_flag: true,
              source_name: 'Google DeepMind',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const ttsNoKey = new NewsTtsService(mockDb);

  await assert.rejects(() => ttsNoKey.generateImportantNewsBriefing('minor-1'), BadRequestException);
  await assert.rejects(() => ttsNoKey.generateImportantNewsBriefing('missing-999'), NotFoundException);

  const fallbackRes = await ttsNoKey.generateImportantNewsBriefing('major-1');
  assert.equal(fallbackRes.status, 'script_only');
  assert.equal(fallbackRes.audioBase64, null);
  assert.equal(fallbackRes.important, true);
  assert.ok(fallbackRes.scriptUk.includes('Проривна мультимодальна модель'));

  process.env.GEMINI_API_KEY = 'test-tts-key';
  const ttsWithKey = new NewsTtsService(mockDb);
  let ttsFetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    ttsFetchCalls += 1;
    assert.ok(String(url).includes('gemini-3.1-flash-tts:generateContent'));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: samplePcm.toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const firstAudio = await ttsWithKey.generateImportantNewsBriefing('major-1');
    assert.equal(firstAudio.status, 'gemini_audio');
    assert.equal(firstAudio.modelUsed, 'gemini-3.1-flash-tts');
    assert.equal(firstAudio.mimeType, 'audio/wav');
    assert.equal(firstAudio.cached, false);
    const decoded = Buffer.from(firstAudio.audioBase64, 'base64');
    assert.equal(decoded.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(ttsFetchCalls, 1);

    const secondAudio = await ttsWithKey.generateImportantNewsBriefing('major-1');
    assert.equal(secondAudio.cached, true);
    assert.equal(ttsFetchCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    resetGeminiClientStateForTests();
  }
});

test('keep-alive helpers build health URLs and parse CLI args cleanly', () => {
  assert.deepEqual(buildHealthUrls('https://news-backend-v0jj.onrender.com/'), [
    'https://news-backend-v0jj.onrender.com/api/v1/health',
    'https://news-backend-v0jj.onrender.com/health/db',
  ]);

  const defaultArgs = parseKeepAliveArgs([], {});
  assert.equal(defaultArgs.apiUrl, 'https://news-backend-v0jj.onrender.com');
  assert.equal(defaultArgs.once, false);
  assert.equal(defaultArgs.intervalSeconds, 720);
  assert.equal(defaultArgs.syncIfKey, false);

  const parsed = parseKeepAliveArgs(
    ['--api', 'https://custom.example.com/', '--once', '--interval=900', '--sync-if-key'],
    {},
  );
  assert.equal(parsed.apiUrl, 'https://custom.example.com');
  assert.equal(parsed.once, true);
  assert.equal(parsed.intervalSeconds, 900);
  assert.equal(parsed.syncIfKey, true);
});
