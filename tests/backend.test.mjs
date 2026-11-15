import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { canonicalizeUrl, retryWithBackoff } from '../dist/common/url-utils.js';
import {
  classifyFeedArticleCategory,
  COMPANY_FEED_CATALOG,
  parseFeedXml,
} from '../dist/news/company-feeds.service.js';
import { CATEGORIES } from '../dist/ingest/ingest.dto.js';
import { NewsController } from '../dist/news/news.controller.js';
import { KeepAliveService } from '../dist/health/keep-alive.service.js';
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
  stripTtsPromptDirectives,
} from '../dist/news/news-tts.service.js';
import { FeedEditorialService } from '../dist/news/feed-editorial.service.js';
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
import { EXPERT_DIRECTORY, scoreExpertCompetenceForTopic } from '../dist/news/expert-directory.js';
import {
  buildOfficialEmbedInfo,
  evaluateShouldDisplayExpertBlock,
  ExpertOpinionsService,
  validateExpertOpinionItem,
} from '../dist/news/expert-opinions.service.js';
import { NewsMemesService } from '../dist/news/news-memes.service.js';
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
    if (userText.includes('Проаналізуй останні новини')) {
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
    if (userText.includes('Проаналізуй останні новини')) {
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
    'gemini-3.8-flash-tts',
    'gemini-3.1-flash-tts',
    'gemini-2.5-flash-tts',
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
    assert.ok(String(url).includes('gemini-3.8-flash-tts:generateContent'));
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
    assert.equal(firstAudio.modelUsed, 'gemini-3.8-flash-tts');
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
  assert.equal(parsed.waves, 1);
  assert.equal(parsed.waveDelaySeconds, 240);

  const waveParsed = parseKeepAliveArgs(
    ['--url', 'https://alt.example.com/', '--waves', '3', '--wave-delay', '180'],
    {},
  );
  assert.equal(waveParsed.apiUrl, 'https://alt.example.com');
  assert.equal(waveParsed.waves, 3);
  assert.equal(waveParsed.waveDelaySeconds, 180);
});

test('Multi-topic categories, expanded COMPANY_FEED_CATALOG, keyword classifier, and NewsController topics/depth work seamlessly', async () => {
  const expectedCategories = [
    'politics',
    'law',
    'economy',
    'finance',
    'career',
    'health',
    'psychology',
    'culture',
    'defense',
    'cybersecurity',
    'science_space',
    'hardware_gaming',
    'startups_fintech',
    'education_grants',
    'global_tech',
    'model',
    'api',
    'coding',
    'open_source',
    'research',
    'business',
    'other',
  ];
  assert.deepEqual([...CATEGORIES], expectedCategories);

  const slugs = new Set(COMPANY_FEED_CATALOG.map((feed) => feed.slug));
  assert.equal(slugs.size, COMPANY_FEED_CATALOG.length, 'Feed slugs must be unique');
  for (const requiredSlug of [
    'itc-ua',
    'dou-ua',
    'dev-ua',
    'nasa-breaking-news',
    'ars-technica-science',
    'nature-news',
    'the-hacker-news',
    'cloudflare-blog',
    'github-blog',
    'techcrunch-startups',
    'yc-blog',
    'toms-hardware',
    'eurogamer',
  ]) {
    assert.ok(slugs.has(requiredSlug), `Expected feed ${requiredSlug} in COMPANY_FEED_CATALOG`);
  }
  for (const feed of COMPANY_FEED_CATALOG) {
    assert.match(feed.url, /^https:\/\//);
  }

  assert.equal(classifyFeedArticleCategory('Українські FPV дрони Brave1 отримали новий РЕБ', 'Оборонний проєкт ЗСУ'), 'defense');
  assert.equal(classifyFeedArticleCategory('Critical CVE-2026-9911 zero-day vulnerability hits cloud edge', 'Patch ransomware exploit now'), 'cybersecurity');
  assert.equal(classifyFeedArticleCategory('NASA launches orbital telescope to study exoplanet atmospheres', 'Space mission report'), 'science_space');
  assert.equal(classifyFeedArticleCategory('NVIDIA RTX GPU vs AMD Ryzen gaming benchmarks in Unreal Engine', 'PC hardware test'), 'hardware_gaming');
  assert.equal(classifyFeedArticleCategory('Fintech startup raises $25M Series A led by Y Combinator', 'Venture funding round'), 'startups_fintech');
  assert.equal(classifyFeedArticleCategory('Horizon Europe announces $5M research grant and hackathon', 'University scholarship'), 'education_grants');

  const mockDb = {
    query: async () => ({
      rows: [
        {
          id: '101',
          url: 'https://openai.com/news/model-1',
          title_uk: 'OpenAI випустила оновлення моделі',
          summary_uk: 'Швидший API для кодингу',
          original_title: 'OpenAI model update',
          category: 'model',
          importance: 'low',
          important: false,
          hydrogen_deep_analysis: false,
          published_at: '2026-11-14T12:00:00Z',
          source_name: 'OpenAI',
          source_slug: 'openai-news',
        },
        {
          id: '102',
          url: 'https://dou.ua/lenta/defense-drone',
          title_uk: 'Українська команда презентувала навігацію для БПЛА',
          summary_uk: 'Оборонні дрони автономного польоту',
          original_title: 'Defense UAV autonomy',
          category: 'defense',
          importance: 'high',
          important: true,
          hydrogen_deep_analysis: true,
          published_at: '2026-11-14T10:00:00Z',
          source_name: 'DOU.ua',
          source_slug: 'dou-ua',
        },
      ],
    }),
  };
  const mockFeeds = {
    list: async () => ({ items: [], unavailable: false }),
  };

  const controller = new NewsController(mockDb, mockFeeds);
  const defenseRes = await controller.list(undefined, undefined, undefined, undefined, undefined, 'defense,ukraine', 'deep_technical');
  assert.equal(defenseRes.items.length, 1);
  assert.equal(defenseRes.items[0].id, '102');
  assert.equal(defenseRes.depth, 'deep_technical');

  await assert.rejects(
    () => controller.list(undefined, undefined, undefined, undefined, undefined, undefined, 'invalid_depth'),
    BadRequestException,
  );
});

test('NewsTtsService adapts script length and jargon stripping across global_brief, balanced, and deep_technical styles with per-style caching', async () => {
  resetGeminiClientStateForTests();
  const sampleInput = {
    titleUk: 'OpenAI випустила GPT-5.2 із 405B параметрів та новим API v3.1',
    summaryUk: 'Модель знизила latency TTFT до 120ms, покращила SWE-bench та знизила вартість токенів для SDK розробників.',
    whyItMatters: 'Компанії швидше запускають цифрові сервіси та автоматизацію для користувачів.',
    sourceName: 'OpenAI',
    hydrogenInsight: 'Практичний виграш відчутний на довгих контекстах у продакшені.',
    facts: [{ claim: 'Підтверджене зниження затримки у 2.1 рази' }],
    comparisons: ['Дешевше за попередній флагман у корпоративних сценаріях'],
  };

  const globalScript = buildBroadcastScriptUk(sampleInput, { depth: 'global_brief', style: 'headline_flash' });
  const globalWords = globalScript.split(/\s+/);
  assert.ok(globalWords.length >= 30 && globalWords.length <= 45, `Expected 30-45 words for global_brief, got ${globalWords.length}: ${globalScript}`);
  assert.ok(!/\b(5\.2|405B|120ms|API|SDK|TTFT|SWE-bench|v3\.1)\b/i.test(globalScript), `Expected tech jargon stripped from global brief: ${globalScript}`);

  const balancedScript = buildBroadcastScriptUk(sampleInput, { depth: 'balanced', style: 'podcast_story' });
  const balancedWords = balancedScript.split(/\s+/);
  assert.ok(balancedWords.length >= 65 && balancedWords.length <= 80, `Expected 65-80 words for podcast_story, got ${balancedWords.length}`);

  const deepScript = buildBroadcastScriptUk(sampleInput, { depth: 'deep_technical', style: 'analyst_brief' });
  const deepWords = deepScript.split(/\s+/);
  assert.ok(deepWords.length >= 90 && deepWords.length <= 115, `Expected 90-115 words for analyst_brief, got ${deepWords.length}`);
  assert.ok(deepScript.includes('405B') || deepScript.includes('TTFT') || deepScript.includes('SWE-bench'));

  const mockDb = {
    query: async () => ({
      rows: [
        {
          id: '77',
          external_id: 'major-77',
          title_uk: sampleInput.titleUk,
          original_title: 'GPT-5.2 Release',
          summary_uk: sampleInput.summaryUk,
          original_summary: null,
          why_it_matters: sampleInput.whyItMatters,
          importance: 'high',
          important_flag: true,
          source_name: 'OpenAI',
          hydrogen_insight: sampleInput.hydrogenInsight,
          comparisons: sampleInput.comparisons,
          facts: sampleInput.facts,
        },
      ],
    }),
  };

  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-tts-styles';
  const ttsSvc = new NewsTtsService(mockDb);
  let fetchCount = 0;
  const pcm = Buffer.from([10, 20, 30, 40]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;rate=24000',
                    data: pcm.toString('base64'),
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
    const resGlobal1 = await ttsSvc.generateImportantNewsBriefing('major-77', undefined, {
      depth: 'global_brief',
      style: 'headline_flash',
    });
    assert.equal(resGlobal1.depth, 'global_brief');
    assert.equal(resGlobal1.style, 'headline_flash');
    assert.equal(resGlobal1.cached, false);

    const resGlobal2 = await ttsSvc.generateImportantNewsBriefing('major-77', undefined, {
      depth: 'global_brief',
      style: 'headline_flash',
    });
    assert.equal(resGlobal2.cached, true);
    assert.equal(fetchCount, 1);

    const resDeep = await ttsSvc.generateImportantNewsBriefing('major-77', undefined, {
      depth: 'deep_technical',
      style: 'analyst_brief',
    });
    assert.equal(resDeep.depth, 'deep_technical');
    assert.equal(resDeep.style, 'analyst_brief');
    assert.equal(resDeep.cached, false);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    resetGeminiClientStateForTests();
  }
});

test('KeepAliveService pings health endpoint, runs PostgreSQL SELECT 1 every 3rd tick, and exposes telemetry on GET /health', async () => {
  let dbQueryCount = 0;
  const mockDb = {
    query: async (sql) => {
      if (sql === 'SELECT 1') dbQueryCount += 1;
      return { rows: [{ ok: 1 }] };
    },
  };

  const pingCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    pingCalls.push({ url: String(url), headers: init?.headers });
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const prevUrl = process.env.RENDER_EXTERNAL_URL;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevKeepAliveEnabled = process.env.KEEP_ALIVE_ENABLED;
  process.env.RENDER_EXTERNAL_URL = 'https://radar-test.onrender.com';

  try {
    const svc = new KeepAliveService(mockDb);
    assert.equal(svc.getKeepAliveStats().intervalMs, 180_000);
    assert.equal(svc.getKeepAliveStats().totalPings, 0);
    assert.ok(
      svc.getKeepAliveStats().targetUrl.startsWith('https://radar-test.onrender.com/api/v1/health?t='),
    );

    await svc.runTick();
    await svc.runTick();
    assert.equal(dbQueryCount, 0);

    const afterThird = await svc.runTick();
    assert.equal(afterThird.totalPings, 3);
    assert.equal(afterThird.lastOk, true);
    assert.equal(afterThird.lastStatus, 200);
    assert.equal(afterThird.lastDbOk, true);
    assert.ok(afterThird.lastPingAt);
    assert.ok(afterThird.lastDbPingAt);
    assert.equal(dbQueryCount, 1);
    assert.equal(pingCalls.length, 3);
    assert.match(
      pingCalls[0].url,
      /^https:\/\/radar-test\.onrender\.com\/api\/v1\/health\?t=\d+$/,
    );
    assert.equal(pingCalls[0].headers?.['x-keep-alive'], 'self');
    assert.equal(pingCalls[0].headers?.['Cache-Control'], 'no-store, no-cache, must-revalidate');
    assert.equal(pingCalls[0].headers?.Pragma, 'no-cache');

    const healthController = new HealthController(mockDb, svc);
    const healthPayload = await healthController.health();
    assert.equal(healthPayload.status, 'ok');
    assert.equal(healthPayload.keepAlive.totalPings, 3);
    assert.equal(healthPayload.keepAlive.lastDbOk, true);

    // Verify lifecycle init/destroy registers & cleanly tears down warmup and interval timers
    process.env.NODE_ENV = 'production';
    process.env.KEEP_ALIVE_ENABLED = 'true';
    const liveSvc = new KeepAliveService(mockDb);
    liveSvc.onModuleInit();
    liveSvc.onModuleDestroy();
  } finally {
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = prevUrl;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevKeepAliveEnabled === undefined) delete process.env.KEEP_ALIVE_ENABLED;
    else process.env.KEEP_ALIVE_ENABLED = prevKeepAliveEnabled;
  }
});

test('EXPERT_DIRECTORY covers 32+ real domain experts and scoreExpertCompetenceForTopic scores competence accurately', () => {
  assert.ok(EXPERT_DIRECTORY.length >= 32, `Expected >= 32 experts, got ${EXPERT_DIRECTORY.length}`);

  const slugs = new Set();
  for (const expert of EXPERT_DIRECTORY) {
    assert.ok(!slugs.has(expert.slug), `Duplicate expert slug: ${expert.slug}`);
    slugs.add(expert.slug);
    assert.ok(expert.profileUrl.startsWith('https://'), `Expected https profileUrl for ${expert.slug}`);
    assert.ok(expert.knownAffiliationsUk.length >= 10);
    assert.ok(expert.documentedPositions.length >= 1);
    for (const pos of expert.documentedPositions) {
      assert.ok(pos.url.startsWith('https://'), `Expected https position URL for ${expert.slug}`);
    }
  }

  const nonOtherCategories = CATEGORIES.filter((cat) => cat !== 'other');
  for (const cat of nonOtherCategories) {
    const matching = EXPERT_DIRECTORY.filter((expert) => expert.primaryDomains.includes(cat));
    assert.ok(
      matching.length >= 2,
      `Expected >= 2 experts for domain ${cat}, found ${matching.length}`,
    );
  }

  const troyHunt = EXPERT_DIRECTORY.find((e) => e.slug === 'troy-hunt');
  assert.ok(troyHunt);
  const directMatch = scoreExpertCompetenceForTopic(
    troyHunt,
    'cybersecurity',
    'Critical cloud credential breach exposes millions of passwords in CVE analysis',
    'Security disclosure covering phishing and API authentication risks.',
  );
  assert.equal(directMatch.isDirectDomainMatch, true);
  assert.ok(
    directMatch.score >= 90 && directMatch.score <= 99,
    `Expected direct competence in 90-99, got ${directMatch.score}`,
  );
  assert.ok(directMatch.potentialBiasUk.length > 5);
  assert.ok(directMatch.conflictOfInterestUk.length > 5);

  const outOfDomain = scoreExpertCompetenceForTopic(
    troyHunt,
    'science_space',
    'NASA Webb telescope captures distant exoplanet atmospheric spectra in deep orbit',
    'Astrophysics discovery regarding methane spectral lines.',
  );
  assert.equal(outOfDomain.isDirectDomainMatch, false);
  assert.ok(outOfDomain.score < 55, `Expected out-of-domain score < 55, got ${outOfDomain.score}`);
});

test('evaluateShouldDisplayExpertBlock, buildOfficialEmbedInfo, and validateExpertOpinionItem enforce quality and anti-hallucination rules', () => {
  const minor = evaluateShouldDisplayExpertBlock({
    title: 'Minor patch v1.4.2 bugfix and dependency bump changelog',
    summary: 'Fixed typo in config.',
    category: 'coding',
    importance: 'low',
  });
  assert.equal(minor.shouldDisplayBlock, false);
  assert.ok(minor.skipReasonUk && minor.skipReasonUk.length > 10);

  const major = evaluateShouldDisplayExpertBlock({
    title: 'Anthropic & Brave1 unveil autonomous defense drone benchmark and zero-day CVE response framework',
    summary: 'Comprehensive architectural release affecting enterprise API security and Ukrainian defense robotics.',
    category: 'defense',
    importance: 'high',
  });
  assert.equal(major.shouldDisplayBlock, true);
  assert.ok(major.valueAddScore >= 75);

  const xEmbed = buildOfficialEmbedInfo('https://x.com/karpathy/status/123456', '@karpathy', 'Important context');
  assert.equal(xEmbed.type, 'x_oembed');
  assert.ok(xEmbed.embedUrl.startsWith('https://publish.twitter.com/oembed?url='));
  assert.equal(xEmbed.interactiveSupported, true);

  const fbEmbed = buildOfficialEmbedInfo('https://www.facebook.com/fedorenko.ukraine/posts/98765');
  assert.equal(fbEmbed.type, 'facebook_plugin');
  assert.ok(fbEmbed.embedUrl.startsWith('https://www.facebook.com/plugins/post.php?href='));

  const bskyEmbed = buildOfficialEmbedInfo('https://bsky.app/profile/simonwillison.net/post/3abcd', '@simonw', 'SQLite insight');
  assert.equal(bskyEmbed.type, 'bsky_oembed');
  assert.ok(bskyEmbed.embedUrl.startsWith('https://embed.bsky.app/oembed?url='));

  const hnEmbed = buildOfficialEmbedInfo('https://news.ycombinator.com/item?id=420000');
  assert.equal(hnEmbed.type, 'hn_card');
  assert.equal(hnEmbed.embedUrl, 'https://news.ycombinator.com/item?id=420000');

  assert.throws(() =>
    validateExpertOpinionItem({
      expertName: 'Fake Test',
      handle: '@fake',
      platform: 'x',
      roleUk: 'Analyst',
      directQuote: 'http insecure link should fail',
      stanceSummaryUk: 'Summary text long enough',
      keyArgumentsUk: ['Arg 1'],
      contextUk: 'Context long enough',
      publishedAt: '2026-11-14T10:00:00Z',
      sourceUrl: 'http://x.com/fake/status/1',
      domainCompetenceScore: 80,
      potentialBiasUk: 'None disclosed',
      conflictOfInterestUk: 'None disclosed',
      embed: xEmbed,
    }),
  );

  const valid = validateExpertOpinionItem({
    expertSlug: 'andrej-karpathy',
    expertName: 'Andrej Karpathy',
    handle: '@karpathy',
    platform: 'x',
    roleUk: 'Дослідник ШІ',
    directQuote: 'Verification loops and tool-use clarity matter far more than raw parameter scale.',
    stanceSummaryUk: 'Акцент на якості циклів верифікації та інструментів.',
    keyArgumentsUk: ['Цикли верифікації визначають практичну користь моделі'],
    contextUk: 'Публічний коментар у відповідь на реліз моделі.',
    publishedAt: '2026-11-14T10:00:00Z',
    sourceUrl: 'https://x.com/karpathy/status/123456',
    domainCompetenceScore: 95,
    credibilityWeight: 97,
    potentialBiasUk: 'Колишній співзасновник OpenAI.',
    conflictOfInterestUk: 'Освітні проєкти Eureka Labs.',
    verificationStatus: 'verified_expert_registry',
    embed: xEmbed,
  });
  assert.equal(valid.expertSlug, 'andrej-karpathy');
  assert.equal(valid.domainCompetenceScore, 95);
});

test('ExpertOpinionsService handles live fetch, 24h caching, DB missing-table fallback, refresh, and NewsController endpoints', async () => {
  const dbCacheByKey = new Map();
  let simulateMissingTable = true;
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes('FROM news_items n')) {
        const id = params?.[0];
        if (id === 'article-cve-1') {
          return {
            rows: [
              {
                id: '101',
                external_id: 'article-cve-1',
                url: 'https://cloudflare.com/security-cve-analysis',
                title_uk: 'Критична вразливість CVE-2026-8812 у TLS та хмарній інфраструктурі',
                original_title: 'Critical CVE-2026-8812 vulnerability in cloud TLS zero-day analysis',
                summary_uk: 'Терміновий розбір ризиків автентифікації та захисту API.',
                original_summary: 'Zero-day vulnerability impacting cloud security.',
                category: 'cybersecurity',
                importance: 'high',
                source_name: 'Cloudflare Security',
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (sql.includes('news_expert_opinions_cache')) {
        if (simulateMissingTable) {
          throw new Error('relation "news_expert_opinions_cache" does not exist');
        }
        if (sql.trim().startsWith('SELECT payload')) {
          const hit = dbCacheByKey.get(String(params?.[0] || ''));
          return hit ? { rows: [{ payload: hit }] } : { rows: [] };
        }
        if (sql.includes('INSERT INTO news_expert_opinions_cache')) {
          dbCacheByKey.set(String(params?.[0] || ''), JSON.parse(params[6]));
          return { rows: [] };
        }
      }
      return { rows: [] };
    },
  };

  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const href = String(url);
    if (href.includes('hn.algolia.com')) {
      return new Response(
        JSON.stringify({
          hits: [
            {
              objectID: '49001122',
              author: 'troyhunt',
              comment_text: 'Zero-day TLS issues reinforce why short-lived credentials and automated patching are non-negotiable.',
              created_at: '2026-11-14T11:00:00Z',
              points: 145,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (href.includes('public.api.bsky.app')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:abc/app.bsky.feed.post/3ktestpost',
              indexedAt: '2026-11-14T11:30:00Z',
              author: { handle: 'simonwillison.net', displayName: 'Simon Willison' },
              record: {
                text: 'Defensive TLS inspection and reproducible dependency locks reduce zero-day blast radius substantially.',
                createdAt: '2026-11-14T11:30:00Z',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (href.includes('embed.bsky.app/oembed')) {
      return new Response(
        JSON.stringify({
          html: '<blockquote class="bluesky-embed" data-testid="bsky-oembed">Verified Bluesky oEmbed</blockquote>',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const opinionsService = new ExpertOpinionsService(mockDb);
    opinionsService.clearCacheForTests();
    const controller = new NewsController(mockDb, undefined, undefined, opinionsService);

    // 1. Directory endpoint filters by domain and alias
    const secDir = await controller.expertsDirectory('cybersecurity');
    assert.equal(secDir.domain, 'cybersecurity');
    assert.ok(secDir.total >= 3);
    assert.ok(secDir.items.some((e) => e.slug === 'troy-hunt'));

    const aiDir = await controller.expertsDirectory('ai');
    assert.ok(aiDir.total >= 4);
    assert.ok(aiDir.items.some((e) => e.slug === 'andrej-karpathy'));

    // 2. Live fetch + missing DB table graceful fallback
    const first = await controller.expertsForArticle('article-cve-1');
    assert.equal(first.shouldDisplayBlock, true);
    assert.equal(first.cached, false);
    assert.equal(first.sourceMode, 'live_hybrid');
    assert.ok(first.opinions.length >= 2);
    assert.ok(first.consensusSummary?.dominantConsensusUk);
    const bskyItem = first.opinions.find((o) => o.platform === 'bluesky');
    assert.ok(bskyItem?.embed.htmlSnippet?.includes('data-testid="bsky-oembed"'));
    assert.equal(fetchCalls, 3);

    // 3. Second call hits 24h in-memory cache with 0 extra network requests
    const second = await controller.expertsForArticle('article-cve-1');
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 3);

    // 4. Refresh forces fresh evaluation & bypasses cache
    simulateMissingTable = false;
    const refreshed = await controller.expertsForArticle('article-cve-1', 'true');
    assert.equal(refreshed.cached, false);
    assert.equal(fetchCalls, 6);
    assert.ok(dbCacheByKey.has('article-cve-1'));

    // 5. DB cache hit after memory cache cleared
    opinionsService.clearCacheForTests();
    const fromDb = await controller.expertsForArticle('article-cve-1');
    assert.equal(fromDb.cached, true);
    assert.equal(fetchCalls, 6);

    // 6. Routine patch skips expert block cleanly
    const skipped = await controller.expertsForArticle(
      'patch-99',
      undefined,
      'Minor bugfix patch v2.0.1',
      'coding',
    );
    assert.equal(skipped.shouldDisplayBlock, false);
    assert.equal(skipped.sourceMode, 'skipped');
    assert.deepEqual(skipped.opinions, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ExpertOpinionsService loads experts from PostgreSQL and Gemini automatically adds and edits experts', async () => {
  const expertRows = new Map([
    [
      'andrej-karpathy',
      {
        slug: 'andrej-karpathy',
        full_name: 'Andrej Karpathy',
        handle: '@karpathy',
        platform: 'x',
        role_uk: 'Дослідник ШІ, співзасновник OpenAI',
        organization: 'Eureka Labs',
        primary_domains: ['model', 'coding'],
        specializations: ['llm', 'coding'],
        profile_url: 'https://x.com/karpathy',
        public_feed_url: null,
        known_affiliations_uk: 'Колишній директор з ШІ у Tesla та співзасновник OpenAI.',
        credibility_weight: 97,
        bias_keywords: ['openai'],
        conflict_disclosure_uk: 'Потенційний інтерес до Eureka Labs.',
        documented_positions: [],
        source_mode: 'seed',
        last_ai_reviewed_at: null,
      },
    ],
  ]);

  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('FROM expert_profiles')) {
        return { rows: Array.from(expertRows.values()) };
      }
      if (sql.includes('INSERT INTO expert_profiles')) {
        const [
          slug,
          fullName,
          handle,
          platform,
          roleUk,
          organization,
          primaryDomains,
          specializations,
          profileUrl,
          knownAffiliationsUk,
          credibilityWeight,
          conflictDisclosureUk,
          documentedPositionsJson,
          sourceMode,
        ] = args;
        const existing = expertRows.get(slug);
        expertRows.set(slug, {
          slug,
          full_name: fullName,
          handle,
          platform,
          role_uk: roleUk,
          organization,
          primary_domains: primaryDomains,
          specializations,
          profile_url: profileUrl,
          public_feed_url: null,
          known_affiliations_uk: knownAffiliationsUk,
          credibility_weight: credibilityWeight,
          bias_keywords: existing?.bias_keywords ?? [],
          conflict_disclosure_uk: conflictDisclosureUk ?? existing?.conflict_disclosure_uk ?? null,
          documented_positions: JSON.parse(documentedPositionsJson),
          source_mode: existing ? (existing.source_mode === 'ai_discovered' ? 'ai_discovered' : 'ai_enriched') : sourceMode,
          last_ai_reviewed_at: new Date().toISOString(),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const origFetch = globalThis.fetch;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      addExperts: [
                        {
                          fullName: 'Dario Amodei',
                          handle: '@DarioAmodei',
                          platform: 'x',
                          roleUk: 'CEO та співзасновник Anthropic, дослідник безпеки ШІ',
                          organization: 'Anthropic',
                          primaryDomains: ['model', 'research'],
                          specializations: ['safety', 'scaling', 'alignment'],
                          profileUrl: 'https://x.com/DarioAmodei',
                          knownAffiliationsUk: 'Співзасновник і CEO Anthropic; раніше VP of Research в OpenAI.',
                          conflictDisclosureUk: 'Прямий інтерес до екосистеми Claude та Anthropic.',
                          credibilityWeight: 94,
                          documentedPosition: {
                            topicKeywords: ['safety', 'scaling', 'model'],
                            thesisUk: 'Масштабування моделей має супроводжуватися інтерпретованістю та тестуванням на небезпечні можливості.',
                            quoteUk: 'Безпека передового ШІ потребує вимірюваних стандартів до релізу.',
                            keyArgumentsUk: ['Потрібні незалежні оцінки ризиків перед розгортанням.'],
                            url: 'https://www.anthropic.com/news',
                            publishedAt: '2026-11-10T10:00:00Z',
                          },
                        },
                      ],
                      updateExperts: [
                        {
                          slug: 'andrej-karpathy',
                          fullName: 'Andrej Karpathy',
                          handle: '@karpathy',
                          platform: 'x',
                          roleUk: 'Засновник Eureka Labs, дослідник LLM та ШІ-освіти',
                          organization: 'Eureka Labs',
                          primaryDomains: ['model', 'coding', 'education_grants'],
                          specializations: ['llm', 'coding', 'education'],
                          profileUrl: 'https://x.com/karpathy',
                          knownAffiliationsUk: 'Засновник Eureka Labs; ex-OpenAI / Tesla.',
                          credibilityWeight: 97,
                          documentedPosition: {
                            topicKeywords: ['agent', 'coding', 'verification'],
                            thesisUk: 'Агентні цикли в кодингу ефективні лише за наявності автоматичних тестів.',
                            quoteUk: 'Найкращий підсилювач якості LLM-коду — швидкий цикл верифікації.',
                            keyArgumentsUk: ['Тести важливіші за довжину промпта.'],
                            url: 'https://x.com/karpathy/status/123456',
                            publishedAt: '2026-11-12T10:00:00Z',
                          },
                        },
                      ],
                    }),
                  },
                ],
              },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://www.anthropic.com/news' } },
                  { web: { uri: 'https://x.com/karpathy/status/123456' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const service = new ExpertOpinionsService(mockDb);
    const result = await service.curateExpertsWithGemini({ category: 'model' });
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.rejected, 0);

    const directory = await service.listDirectory('model');
    assert.equal(directory.total, 2);

    const dario = directory.items.find((e) => e.slug === 'dario-amodei');
    assert.ok(dario, 'Expected Gemini to add Dario Amodei to DB directory');
    assert.equal(dario.sourceMode, 'ai_discovered');
    assert.equal(dario.documentedPositionsCount, 1);

    const karpathy = directory.items.find((e) => e.slug === 'andrej-karpathy');
    assert.ok(karpathy);
    assert.equal(karpathy.sourceMode, 'ai_enriched');
    assert.match(karpathy.roleUk, /Eureka Labs/);
    assert.equal(karpathy.documentedPositionsCount, 2);
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('NewsController.list sorts chronologically by published_at and enforces 24h cutoff for important & maxAgeHours', async () => {
  const now = Date.now();
  const isoHoursAgo = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

  const dbRows = [
    {
      id: '10',
      external_id: 'ext-10',
      url: 'https://www.pravda.com.ua/news/10',
      original_title: 'Older important politics item',
      title_uk: 'Тижнева політична новина про податки та бюджет',
      summary_uk: 'Детальний огляд тижневої давності.',
      why_it_matters: 'Важливо для контексту.',
      category: 'politics',
      importance: 'high',
      important: true,
      published_at: isoHoursAgo(96),
      updated_at: isoHoursAgo(96),
      source_name: 'Українська правда',
      source_slug: 'pravda-ua',
      hydrogen_deep_analysis: true,
    },
    {
      id: '20',
      external_id: 'ext-20',
      url: 'https://www.epravda.com.ua/news/20',
      original_title: 'Fresh economy & currency rates update',
      title_uk: 'Сьогоднішній курс валют, інфляція та ставки депозитів',
      summary_uk: 'Свіжі дані фінансового ринку за сьогодні.',
      why_it_matters: 'Впливає на особисті фінанси та кредити.',
      category: 'finance',
      importance: 'high',
      important: true,
      published_at: isoHoursAgo(2),
      updated_at: isoHoursAgo(2),
      source_name: 'Економічна правда',
      source_slug: 'epravda-ua',
      hydrogen_deep_analysis: false,
    },
    {
      id: '30',
      external_id: 'ext-30',
      url: 'https://suspilne.media/news/30',
      original_title: 'Middle-age law update',
      title_uk: 'Вчорашні зміни правил перетину кордону і документів у Дії',
      summary_uk: 'Корисне уточнення вчорашнього дня.',
      why_it_matters: 'Практичні правила для поїздок.',
      category: 'law',
      importance: 'medium',
      important: false,
      published_at: isoHoursAgo(12),
      updated_at: isoHoursAgo(12),
      source_name: 'Суспільне Новини',
      source_slug: 'suspilne-news',
      hydrogen_deep_analysis: false,
    },
  ];

  const mockDb = {
    query: async () => ({ rows: dbRows.map((r) => ({ ...r })) }),
  };
  const mockFeeds = {
    list: async () => ({ items: [] }),
  };

  const controller = new NewsController(mockDb, mockFeeds);

  // 1. Default sort (newest) even with topics passed must order newest -> oldest and demote stale (>24h) important flag
  // Signature: list(limit, offset, category, sources, important, topics, depth, sort, maxAgeHours)
  const newestRes = await controller.list(
    '30',
    '0',
    undefined,
    undefined,
    undefined,
    'politics,finance,law',
    'balanced',
  );
  assert.deepEqual(
    newestRes.items.map((i) => i.id),
    ['20', '30', '10'],
  );
  const staleInGeneral = newestRes.items.find((i) => i.id === '10');
  assert.equal(staleInGeneral.important, false);

  // 2. Oldest sort reverses chronological order
  const oldestRes = await controller.list(
    '30',
    '0',
    undefined,
    undefined,
    undefined,
    'politics,finance,law',
    'balanced',
    'oldest',
  );
  assert.deepEqual(
    oldestRes.items.map((i) => i.id),
    ['10', '30', '20'],
  );

  // 3. important=true defaults to 24h cutoff and excludes week-old important items
  const importantRes = await controller.list(undefined, undefined, undefined, undefined, 'true');
  assert.deepEqual(
    importantRes.items.map((i) => i.id),
    ['20'],
  );

  // 4. maxAgeHours=24 excludes 96h-old entry
  const dayRes = await controller.list(
    '30',
    '0',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'newest',
    '24',
  );
  assert.deepEqual(
    dayRes.items.map((i) => i.id),
    ['20', '30'],
  );

  await assert.rejects(
    () => controller.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'invalid_sort'),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'newest', '0'),
    BadRequestException,
  );
});

test('FeedEditorialService skips RSS entries older than 24 hours and processes only recent articles', async () => {
  const now = Date.now();
  const ingestedUrls = [];

  const mockFeeds = {
    list: async () => ({
      items: [
        {
          id: 'feed-stale-48h',
          url: 'https://www.pravda.com.ua/news/stale',
          original_title: 'Old article 48h ago',
          original_summary: 'Should be skipped by 24h gate',
          source_name: 'Українська правда',
          source_slug: 'pravda-ua',
          published_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
          category: 'politics',
        },
        {
          id: 'feed-fresh-2h',
          url: 'https://www.bbc.com/news/health/fresh',
          original_title: 'Fresh sleep longevity study published today',
          original_summary: 'New evidence on sleep and exercise.',
          source_name: 'BBC Health',
          source_slug: 'bbc-health',
          published_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          category: 'health',
        },
      ],
    }),
    getActiveFeeds: () => [
      { slug: 'pravda-ua', name: 'Українська правда', domain: 'pravda.com.ua', url: 'https://www.pravda.com.ua/rss/', category: 'politics' },
      { slug: 'bbc-health', name: 'BBC Health', domain: 'bbc.com', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', category: 'health' },
    ],
  };

  const mockEditor = {
    enabled: true,
    planBatchAnglesWithHydrogen: async () => new Map(),
    polishArticlesBatchWithHydrogen: async () => ({ polishedCount: 0, modelUsed: null }),
  };

  const mockIngest = {
    ingest: async (dto) => {
      for (const entry of dto.items ?? []) {
        ingestedUrls.push(entry.url);
      }
      return { ok: true, written: 1, skipped: 0, duplicate: false, item: { id: 'new-1', status: 'published' } };
    },
  };

  const mockDb = {
    query: async () => ({ rows: [] }),
  };

  const mockCatalog = {
    notifyArticlePublished: async () => undefined,
  };

  const service = new FeedEditorialService(mockFeeds, mockEditor, mockIngest, mockDb, mockCatalog);
  const summary = await service.runOnce();
  assert.equal(summary.processed, 1);
  assert.deepEqual(ingestedUrls, ['https://www.bbc.com/news/health/fresh']);
});

test('NewsTtsService sends clean script without spoken style directives or meta filler', async () => {
  resetGeminiClientStateForTests();

  const dirty = 'Озвуч українською виразно та спокійно. У цьому аудіоогляді: Ключове рішення бюджету ухвалено сьогодні.';
  const cleaned = stripTtsPromptDirectives(dirty);
  assert.ok(!/озвуч/i.test(cleaned));
  assert.ok(!/у цьому аудіоогляді/i.test(cleaned));
  assert.ok(cleaned.includes('Ключове рішення бюджету ухвалено сьогодні.'));

  const script = buildBroadcastScriptUk(
    {
      titleUk: 'Нацбанк оновив орієнтири інфляції та ставок за депозитами',
      summaryUk: 'Регулятор зафіксував зниження інфляційних очікувань і стабільність валютного ринку.',
      whyItMatters: 'Це впливає на дохідність гривневих заощаджень та вартість кредитів для родин.',
      sourceName: 'Економічна правда',
    },
    { depth: 'balanced', style: 'podcast_story' },
  );
  assert.ok(!/у цьому аудіоогляді|головне зі світу технологій|почнемо з головного/i.test(script));

  const mockDb = {
    query: async () => ({
      rows: [
        {
          id: '501',
          external_id: 'finance-501',
          title_uk: 'Нацбанк оновив орієнтири інфляції та ставок за депозитами',
          original_title: 'NBU inflation and deposit outlook',
          summary_uk: 'Регулятор зафіксував зниження інфляційних очікувань і стабільність валютного ринку.',
          original_summary: null,
          why_it_matters: 'Це впливає на дохідність гривневих заощаджень та вартість кредитів для родин.',
          importance: 'high',
          important_flag: true,
          source_name: 'Економічна правда',
          hydrogen_insight: null,
          comparisons: [],
          facts: [],
        },
      ],
    }),
  };

  let sentTtsText = '';
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-tts-clean';
  const pcm = Buffer.from([1, 2, 3, 4]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const parsed = JSON.parse(String(init?.body ?? '{}'));
    sentTtsText = String(parsed?.contents?.[0]?.parts?.[0]?.text ?? '');
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;rate=24000',
                    data: pcm.toString('base64'),
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
    const svc = new NewsTtsService(mockDb);
    const res = await svc.generateImportantNewsBriefing('finance-501', undefined, {
      depth: 'balanced',
      style: 'podcast_story',
    });
    assert.ok(sentTtsText.length > 20);
    assert.ok(!/озвуч|інтонац|передай новину|у цьому аудіоогляді|читай виключно/i.test(sentTtsText));
    assert.equal(sentTtsText, res.scriptUk);
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('NewsMemesService searches multiple public memes and jokes, caches results, supports custom query, and skips tragic news', async () => {
  const dbCache = new Map();
  let simulateMissingTable = true;

  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('FROM news_items')) {
        if (args[0] === 'tragic-1') {
          return {
            rows: [
              {
                id: 'tragic-1',
                external_id: 'tragic-1',
                url: 'https://example.com/tragic',
                title_uk: 'Повідомлення про масові жертви обстрілу',
                original_title: 'Mass casualties reported after attack',
                summary_uk: 'Є загиблі та постраждалі серед цивільних.',
                original_summary: null,
                category: 'politics',
                source_name: 'News',
              },
            ],
          };
        }
        if (args[0] === 'ai-meme-1') {
          return {
            rows: [
              {
                id: 'ai-meme-1',
                external_id: 'ai-meme-1',
                url: 'https://openai.com/news/gpt-coding',
                title_uk: 'Новий ШІ-агент для програмування переписує продакшн у пʼятницю',
                original_title: 'New AI coding agent deploys to production on Friday',
                summary_uk: 'Розробники обговорюють автономні деплої та тести.',
                original_summary: null,
                category: 'coding',
                source_name: 'GitHub Blog',
              },
            ],
          };
        }
        return { rows: [] };
      }
      if (sql.includes('news_memes_cache')) {
        if (simulateMissingTable) {
          throw new Error('relation "news_memes_cache" does not exist');
        }
        if (sql.includes('INSERT INTO news_memes_cache')) {
          dbCache.set(args[0], JSON.parse(args[4]));
          return { rows: [] };
        }
        const hit = dbCache.get(args[0]);
        return { rows: hit ? [{ payload: hit }] : [] };
      }
      return { rows: [] };
    },
  };

  let fetchCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls += 1;
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('reddit.com/search.json')) {
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  title: 'When the AI agent deploys directly to prod on Friday lol',
                  selftext: '',
                  permalink: '/r/ProgrammerHumor/comments/abc123/ai_friday/',
                  url_overridden_by_dest: 'https://i.redd.it/friday-prod-meme.png',
                  post_hint: 'image',
                  subreddit: 'ProgrammerHumor',
                  author: 'dev_joker',
                  ups: 4200,
                  over_18: false,
                  created_utc: 1794700000,
                },
              },
              {
                data: {
                  title: 'Senior dev watching junior ask AI to fix prod bug',
                  selftext: 'It deleted the migration table.',
                  permalink: '/r/memes/comments/xyz789/senior_dev/',
                  subreddit: 'memes',
                  author: 'meme_smith',
                  ups: 1500,
                  over_18: false,
                  created_utc: 1794700100,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('public.api.bsky.app')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:xyz/app.bsky.feed.post/joke99',
              likeCount: 310,
              repostCount: 45,
              author: { handle: 'funnydev.bsky.social', displayName: 'Funny Dev' },
              record: {
                text: 'My AI coding agent just opened a PR arguing with itself 😂',
                createdAt: '2026-11-15T08:00:00Z',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    const memesService = new NewsMemesService(mockDb);
    const controller = new NewsController(mockDb, undefined, undefined, undefined, memesService);

    // 1. Finds multiple memes & jokes (Reddit + Bluesky) even if cache table is missing
    const first = await controller.memesForArticle('ai-meme-1');
    assert.equal(first.hasMemes, true);
    assert.ok(first.total >= 3, `Expected >= 3 memes/jokes, got ${first.total}`);
    assert.equal(first.items.length, first.total);
    assert.ok(first.items.some((i) => i.platform === 'reddit' && i.imageUrl === 'https://i.redd.it/friday-prod-meme.png'));
    assert.ok(first.items.some((i) => i.platform === 'bluesky' && i.kind === 'joke'));
    assert.equal(first.cached, false);
    assert.equal(fetchCalls, 2);

    // 2. Second request hits 12h memory cache
    const second = await controller.memesForArticle('ai-meme-1');
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 2);

    // 3. Custom search query (?q=...) runs a distinct search & writes DB cache
    simulateMissingTable = false;
    const custom = await controller.memesForArticle('ai-meme-1', undefined, 'copilot bugs');
    assert.equal(custom.queryUsed, 'copilot bugs');
    assert.equal(custom.cached, false);
    assert.equal(fetchCalls, 4);
    assert.ok(dbCache.size >= 1);

    // 4. Tragic casualty news skips memes cleanly
    const skipped = await controller.memesForArticle('tragic-1');
    assert.equal(skipped.hasMemes, false);
    assert.equal(skipped.sourceMode, 'skipped');
    assert.deepEqual(skipped.items, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});
