import quotaFixture from './quota-ledger.cjs';
quotaFixture.installQuotaLedger();
process.env.DATABASE_URL = 'postgresql://unit-test.invalid/test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { canonicalizeUrl, retryWithBackoff } from '../dist/common/url-utils.js';
import {
  classifyFeedArticleCategory,
  COMPANY_FEED_CATALOG,
  fetchAndParseFeedUrl,
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
import {
  assessDiscoveredFeedQuality,
  extractAlternateFeedLinksFromHtml,
  slugifySource,
  SourceDiscoveryService,
} from '../dist/news/source-discovery.service.js';
import { IngestService } from '../dist/ingest/ingest.service.js';
import { dedupeGameOffers, detectStoreName } from '../dist/games/games.service.js';
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
  stripBriefingSectionLabels,
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
import {
  checkHtmlRobotsAndTdmMeta,
  checkHttpRobotsAndTdmHeaders,
  checkRobotsTxtPermission,
  isSafePublicHttpUrl,
  resolveAndValidatePublicUrl,
} from '../dist/common/source-compliance.js';
import { clusterNewsItems, NewsClusteringService } from '../dist/news/news-clustering.service.js';
import { SourcesController } from '../dist/sources/sources.controller.js';
import { buildYoutubeRssUrl, extractYoutubeVideoId, YOUTUBE_RSS_CHANNELS } from '../dist/youtube/youtube-channels.js';
import {
  buildCompressedGeminiYoutubeBody,
  evaluateYoutubeVideoWorthiness,
  extractApifyTranscriptText,
  extractChaptersFromDescription,
  getConfiguredApifyToken,
  YoutubeRadarService,
} from '../dist/youtube/youtube-radar.service.js';
import { YoutubeController } from '../dist/youtube/youtube.controller.js';

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

test('game offers collapse a syndicated giveaway while keeping distinct products and store offers', () => {
  const direct = { title: 'A Space Game', externalId: 'steam-123', url: 'https://store.steampowered.com/app/123', storeName: 'Steam', offerType: 'giveaway' };
  const syndicated = { ...direct, title: 'A Space Game (Steam) Giveaway', externalId: 'gp-7', url: 'https://www.gamerpower.com/open/7' };
  const tracked = { ...direct, externalId: 'gp-8', url: `${direct.url}/?utm_source=gamerpower` };
  const demo = { ...direct, externalId: 'steam-456', url: 'https://store.steampowered.com/app/456', offerType: 'demo' };
  const epic = { ...direct, externalId: 'epic-9', url: 'https://store.epicgames.com/uk/p/a-space-game', storeName: 'Epic Games' };
  assert.deepEqual(dedupeGameOffers([syndicated, tracked, direct, demo, epic, direct]), [direct, demo, epic]);
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
  assert.equal(meta.lastAiVerificationAt, GrantsService.lastAiVerificationAt);
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
  assert.equal(summary.grants.lastAiVerificationAt, GrantsService.lastAiVerificationAt);
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
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-4-hydrogen',
    'gemma-4-31b-it',
  ]);
  assert.equal(normalizeGeminiModel(undefined), 'gemini-3.1-flash-lite');
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

test('HydrogenQuotaGuard enforces 10 RPM / 20 RPD limits and fast 404 fallback caches unavailable models', async () => {
  resetGeminiClientStateForTests();
  try {
    const initial = getHydrogenQuotaStatus();
    assert.equal(initial.maxRpm, 10);
    assert.equal(initial.maxRpd, 20);
    assert.equal(initial.remainingToday, 20);
    assert.equal(canUseHydrogenQuota(), true);

    recordHydrogenUsage(19);
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
      { slug: 'openai', name: 'OpenAI', homepageUrl: 'https://openai.com', licenseMode: 'summary' },
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
    assert.equal(edited.aiMetadata?.model, 'gemini-3.1-flash-lite');
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
    'climate_energy',
    'robotics',
    'crypto_web3',
    'mobility_ev',
    'biotech',
    'ai_policy',
    'media_social',
    'sports',
    'travel_lifestyle',
    'real_estate',
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

  // v2.1 categories get experts dynamically; the hand-verified seed covers the original domains.
  const nonOtherCategories = [...EXPERT_SEEDED_CATEGORIES];
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

test('NewsMemesService uses keyless Lemmy/Mastodon search, never anonymous Bluesky, disables unauthenticated Reddit scraping, caches results, and skips tragic news', async () => {
  const dbCache = new Map();
  let simulateMissingTable = true;
  let redditCalled = false;

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
  let blueskyAnonymousCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls += 1;
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('reddit.com')) {
      redditCalled = true;
      return new Response(JSON.stringify({}), { status: 403 });
    }
    if (url.includes('public.api.bsky.app')) {
      blueskyAnonymousCalled = true;
      return new Response(JSON.stringify({}), { status: 403 });
    }
    if (url.includes('lemmy.world/api/v3/search')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              post: { id: 991, name: 'My AI coding agent just opened a PR arguing with itself lol', published: '2026-11-15T08:00:00Z', nsfw: false },
              community: { name: 'programmerhumor' },
              creator: { name: 'funnydev' },
              counts: { score: 310 },
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

    // 1. Queries keyless Lemmy (anonymous Bluesky search answers 403 and Reddit scraping is disabled)
    const first = await controller.memesForArticle('ai-meme-1');
    assert.equal(redditCalled, false);
    assert.equal(blueskyAnonymousCalled, false);
    assert.equal(first.hasMemes, true);
    assert.ok(first.total >= 1);
    assert.ok(first.items.some((i) => i.platform === 'lemmy'));
    assert.equal(first.cached, false);
    const callsAfterFirst = fetchCalls;
    assert.ok(callsAfterFirst >= 1);

    // 2. Second request hits 12h memory cache
    const second = await controller.memesForArticle('ai-meme-1');
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, callsAfterFirst);

    // 3. Custom search query (?q=...) runs a distinct search & writes DB cache
    simulateMissingTable = false;
    const custom = await controller.memesForArticle('ai-meme-1', undefined, 'copilot bugs');
    assert.equal(custom.queryUsed, 'copilot bugs');
    assert.equal(custom.cached, false);
    assert.ok(fetchCalls > callsAfterFirst);
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

test('CompanyFeeds compliance: dead xai removed, RSS 1.0 + guid isPermaLink + HTML entities + windows-1251 + subdomain allowlist + word-boundary category', async () => {
  assert.equal(
    COMPANY_FEED_CATALOG.some((f) => f.slug === 'xai-news-community-feed'),
    false,
    'Dead 404 xai community feed must be removed from COMPANY_FEED_CATALOG',
  );

  // RSS 1.0 rdf:RDF + dc:date + HTML entities
  const rss10 = `<?xml version="1.0" encoding="UTF-8"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <item rdf:about="https://ai.meta.com/blog/llama-release/">
      <title>Meta &amp; Llama &quot;4&quot; &#8230; Research</title>
      <link>https://ai.meta.com/blog/llama-release/</link>
      <description>&lt;p&gt;Price &amp;pound;0 open weights.&lt;/p&gt;</description>
      <dc:date>2026-11-15T09:30:00Z</dc:date>
    </item>
  </rdf:RDF>`;

  const metaFeed = {
    slug: 'meta-ai',
    name: 'Meta AI',
    domain: 'meta.com',
    url: 'https://ai.meta.com/feed.xml',
    category: 'ai',
  };
  const parsedRss10 = parseFeedXml(rss10, metaFeed);
  assert.equal(parsedRss10.length, 1);
  assert.equal(parsedRss10[0].original_title, 'Meta & Llama "4" … Research');
  assert.equal(parsedRss10[0].original_summary, 'Price £0 open weights.');
  assert.ok(parsedRss10[0].published_at);

  // guid isPermaLink="true" fallback when <link> omitted + host subdomain check
  const rssGuid = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel>
    <item>
      <title>Subdomain Link Post</title>
      <guid isPermaLink="true">https://research.meta.com/blog/post-1</guid>
      <pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Spoofed Lookalike Domain</title>
      <link>https://evil-meta.com/phish</link>
      <pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;
  const parsedGuid = parseFeedXml(rssGuid, metaFeed);
  assert.equal(parsedGuid.length, 1);
  assert.equal(parsedGuid[0].url, 'https://research.meta.com/blog/post-1');

  // Word-boundary category classifier prevents substring false positives
  assert.equal(classifyFeedArticleCategory('Документальний фільм про армію', 'Нова премʼєра кіно у прокаті'), 'culture');
  assert.equal(classifyFeedArticleCategory('Claude Code v2.1.325', 'New CLI workflows for TypeScript refactoring'), 'coding');

  // Charset windows-1251 decoding in fetchAndParseFeedUrl
  // Encode Cyrillic bytes cleanly in windows-1251 for "Новини" -> 0xCD 0xEE 0xE2 0xE8 0xED 0xE8
  const cp1251Head = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><rss version="2.0"><channel><item><title>');
  const cp1251Word = Buffer.from([0xcd, 0xee, 0xe2, 0xe8, 0xed, 0xe8]);
  const cp1251Tail = Buffer.from('</title><link>https://example.com/cp1251</link><pubDate>Fri, 14 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>');
  const cp1251Body = Buffer.concat([cp1251Head, cp1251Word, cp1251Tail]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(cp1251Body, {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=windows-1251' },
    });
  try {
    const articles = await fetchAndParseFeedUrl({
      slug: 'example-cp1251',
      name: 'Example',
      domain: 'example.com',
      url: 'https://example.com/rss.xml',
      category: 'other',
    });
    assert.equal(articles.length, 1);
    assert.equal(articles[0].original_title, 'Новини');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('source-compliance enforces SSRF/DNS, robots.txt, TDM/noai headers, and GeminiEditorService respects headline_link', async () => {
  assert.equal(isSafePublicHttpUrl('http://127.0.0.1/feed.xml', { allowHttp: true }), false);
  assert.equal(isSafePublicHttpUrl('https://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isSafePublicHttpUrl('https://localhost/admin'), false);
  assert.equal(isSafePublicHttpUrl('https://openai.com/news/rss.xml'), true);

  const dnsPrivate = await resolveAndValidatePublicUrl('https://rebind.example.com/rss.xml', {
    lookupFn: async () => [{ address: '10.0.0.5' }],
  });
  assert.equal(dnsPrivate.safe, false);

  const dnsPublic = await resolveAndValidatePublicUrl('https://public.example.com/rss.xml', {
    lookupFn: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(dnsPublic.safe, true);

  const robotsRes = await checkRobotsTxtPermission('https://strict-publisher.example.com/private/article', {
    lookupFn: async () => [{ address: '93.184.216.34' }],
    fetchFn: async () =>
      new Response('User-agent: *\nDisallow: /private/\nAllow: /private/open/\n', { status: 200 }),
  });
  assert.equal(robotsRes.allowed, false);

  assert.equal(
    checkHttpRobotsAndTdmHeaders({ 'x-robots-tag': 'noai, noimageai' }).allowed,
    false,
  );
  assert.equal(
    checkHttpRobotsAndTdmHeaders({ 'tdm-reservation': '1' }).allowed,
    false,
  );
  assert.equal(
    checkHtmlRobotsAndTdmMeta('<html><head><meta name="robots" content="noai"></head></html>').allowed,
    false,
  );

  // headline_link mode must NOT scrape article HTML even when Gemini API key is set
  let scrapedArticle = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('publisher.example.com')) scrapedArticle = true;
    return new Response('', { status: 404 });
  };
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const editor = new GeminiEditorService({ query: async () => ({ rows: [] }) });
    const pack = await editor.collectArticleEvidencePack(
      { slug: 'pub', name: 'Publisher', homepageUrl: 'https://publisher.example.com', licenseMode: 'headline_link' },
      {
        externalId: 'hl-1',
        url: 'https://publisher.example.com/story',
        originalTitle: 'Story Headline',
        originalSummary: 'Short RSS teaser.',
        category: 'tech',
        importance: 'unknown',
        freeAccess: 'unknown',
      },
      undefined,
      { licenseMode: 'headline_link' },
    );
    assert.equal(scrapedArticle, false);
    assert.ok(pack.includes('headline_link'));
  } finally {
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('NewsClusteringService + NewsController collapse multi-source events and prevent topic substring false positives', async () => {
  const now = new Date().toISOString();
  const clustered = clusterNewsItems([
    {
      id: 'item-a',
      url: 'https://openai.com/news/gpt-5-5-launch/',
      original_title: 'OpenAI launches GPT-5.5 coding model for developers',
      title_uk: 'OpenAI випустила модель GPT-5.5 для розробників',
      source_name: 'OpenAI News',
      source_slug: 'openai',
      published_at: now,
      important: true,
      article: { body: '...' },
    },
    {
      id: 'item-b',
      url: 'https://simonwillison.net/2026/Nov/15/openai-gpt-5-5/',
      original_title: 'OpenAI releases GPT-5.5 model for developers and coding',
      title_uk: 'OpenAI представила модель програмування GPT-5.5',
      source_name: 'Simon Willison',
      source_slug: 'simonwillison',
      published_at: now,
      important: false,
    },
    {
      id: 'item-c',
      url: 'https://science.org/news/mars-water-basin',
      original_title: 'NASA rover finds ancient river delta signatures on Mars',
      title_uk: 'Марсохід NASA знайшов сліди давньої дельти річки на Марсі',
      source_name: 'Science.org',
      source_slug: 'science',
      published_at: now,
      important: false,
    },
  ]);

  assert.equal(clustered.length, 2, 'Two overlapping sources about GPT-5.5 should merge into one clustered entry');
  const gptCluster = clustered.find((c) => c.id === 'item-a');
  assert.ok(gptCluster?.cluster_id);
  assert.equal(gptCluster?.source_count, 2);
  assert.equal(gptCluster?.cluster_sources.length, 2);

  // Verify NewsController.list word-boundary matching ('said' / 'Thailand' must NOT match topic 'ai')
  const mockDb = {
    async query(sql) {
      if (sql.includes('FROM news_items')) {
        return {
          rows: [
            {
              id: '101',
              url: 'https://example.com/thailand',
              original_title: 'Ambassador said Thailand travel rules updated today',
              title_uk: 'Уряд у Таїланді оновив правила подорожей',
              summary_uk: 'Посол пояснив нові митні вимоги.',
              published_at: now,
              category: 'society',
              importance: 'low',
              why_it_matters: null,
              free_access: 'free',
              source_name: 'World News',
              source_slug: 'world',
              source_is_unofficial: false,
              ai_generated: true,
              cluster_sources: [],
            },
            {
              id: '102',
              url: 'https://openai.com/news/ai-agents',
              original_title: 'New AI agents benchmark released',
              title_uk: 'Вийшов новий бенчмарк для ШІ-агентів',
              summary_uk: 'Тестування автономного ШІ у розробці.',
              published_at: now,
              category: 'ai',
              importance: 'high',
              why_it_matters: 'Важливо для команд розробки.',
              free_access: 'free',
              source_name: 'OpenAI',
              source_slug: 'openai',
              source_is_unofficial: false,
              ai_generated: true,
              cluster_sources: [],
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const controller = new NewsController(mockDb, {
    list: async () => ({ items: [], totalSources: 0, healthySources: 0 }),
    getActiveFeeds: () => [],
  });
  const aiFiltered = await controller.list('20', '0', undefined, undefined, undefined, 'ai');
  assert.equal(aiFiltered.items.length, 1);
  assert.equal(aiFiltered.items[0].id, '102');
});

test('SourceDiscoveryService + SourcesController validate public feeds via <link rel=alternate>, block SSRF, save as pending_review, and support approve/reject', async () => {
  const insertedSources = [];
  const statusUpdates = [];
  let reloadCalls = 0;
  let capturedPrompt = '';
  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('INSERT INTO sources')) {
        insertedSources.push(args);
        return { rows: [] };
      }
      if (sql.includes('FROM sources') && sql.includes('review_status')) {
        return {
          rows: insertedSources.map((argsRow) => ({
            slug: argsRow[0],
            name: argsRow[1],
            homepage_url: argsRow[2],
            feed_url: argsRow[3],
            category: argsRow[5],
            auto_discovered: true,
            review_status: argsRow[10] ?? 'pending_review',
            enabled: Boolean(argsRow[9]),
          })),
        };
      }
      if (sql.includes("review_status = 'approved'")) {
        statusUpdates.push({ slug: args[0], action: 'approve', licenseMode: args[1] });
        return {
          rowCount: 1,
          rows: [{ slug: args[0], enabled: true, review_status: 'approved', license_mode: args[1] }],
        };
      }
      if (sql.includes("review_status = 'rejected'")) {
        statusUpdates.push({ slug: args[0], action: 'reject' });
        return {
          rowCount: 1,
          rows: [{ slug: args[0], enabled: false, review_status: 'rejected' }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const mockFeeds = {
    getActiveFeeds: () => [
      { slug: 'openai', name: 'OpenAI', domain: 'openai.com', url: 'https://openai.com/news/rss.xml', category: 'ai' },
      { slug: 'broken-tech', name: 'Broken Tech Blog', domain: 'brokentech.example', url: 'https://brokentech.example/rss.xml', category: 'tech' },
    ],
    getHealthSnapshot: () => [
      { slug: 'openai', name: 'OpenAI', category: 'ai', articleCount: 5, consecutiveFailures: 0, fetchedAt: new Date().toISOString() },
      { slug: 'broken-tech', name: 'Broken Tech Blog', category: 'tech', articleCount: 0, lastError: 'HTTP 500', consecutiveFailures: 4, fetchedAt: new Date().toISOString() },
    ],
    refreshAllFeeds: async () => undefined,
    reloadFeedsFromDatabase: async () => {
      reloadCalls += 1;
    },
  };

  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-discovery-key';
  const origFetch = globalThis.fetch;

  let round = 1;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      const reqBody = JSON.parse(String(init?.body || '{}'));
      capturedPrompt = reqBody?.contents?.[0]?.parts?.[0]?.text || '';
      const roundCandidates =
        round === 1
          ? [
              {
                name: 'SSRF Evil Target',
                homepageUrl: 'https://169.254.169.254/',
                feedUrl: 'https://169.254.169.254/feed.xml',
                category: 'tech',
                rationaleUk: 'Internal metadata leak test',
              },
              {
                name: 'Reddit Tech Community',
                homepageUrl: 'https://www.reddit.com/r/technology',
                feedUrl: 'https://www.reddit.com/r/technology/.rss',
                category: 'tech',
                rationaleUk: 'Social aggregator must be blocked',
              },
              {
                name: 'Ukrinform Science',
                homepageUrl: 'https://ukrinform.ua/rubric-technology',
                category: 'tech',
                rationaleUk: 'Офіційне державне інформаційне агентство України з верифікованою редакцією.',
              },
            ]
          : [
              {
                name: 'Suspilne Tech',
                homepageUrl: 'https://suspilne.media/tech',
                category: 'tech',
                rationaleUk: 'Суспільний мовник України з перевіреними стандартами журналістики.',
              },
            ];
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({ candidates: roundCandidates }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200 });
    }
    if (url.includes('ukrinform.ua')) {
      return new Response(
        '<html><head><link rel="alternate" type="application/rss+xml" href="/rss/technology.xml"></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }
    if (url.includes('suspilne.media')) {
      return new Response(
        '<html><head><link rel="alternate" type="application/rss+xml" href="/rss/tech.xml"></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }
    return new Response('', { status: 404 });
  };

  try {
    const discovery = new SourceDiscoveryService(mockDb, mockFeeds);
    const autoResult = await discovery.discoverAndVerify({
      lookupFn: async () => [{ address: '185.199.108.153' }],
      parseFeedFn: async (feed) => [
        {
          id: `${feed.slug}-1`,
          url: `${feed.url.replace('/rss/', '/news/')}#1`,
          original_title: 'Українські інженери запустили нову лабораторну мережу тестування',
          original_summary: 'Короткий огляд запуску.',
          published_at: new Date().toISOString(),
          source_name: feed.name,
          source_slug: feed.slug,
          category: 'tech',
        },
        {
          id: `${feed.slug}-2`,
          url: `${feed.url.replace('/rss/', '/news/')}#2`,
          original_title: 'Науковий центр оприлюднив відкритий звіт з телеметрії',
          original_summary: 'Деталі звіту.',
          published_at: new Date().toISOString(),
          source_name: feed.name,
          source_slug: feed.slug,
          category: 'tech',
        },
      ],
    });

    assert.ok(capturedPrompt.includes('Broken Tech Blog'), 'Gap prompt should flag failing/empty feeds');
    assert.equal(autoResult.proposed, 3);
    assert.equal(autoResult.verified, 1);
    assert.equal(autoResult.autoApproved.length, 1);
    assert.equal(autoResult.pendingReview.length, 0);
    assert.equal(autoResult.rejected.length, 2);
    assert.equal(reloadCalls, 1, 'Auto-enabled verified source must reload active feeds immediately');
    assert.equal(insertedSources[0][3], 'https://ukrinform.ua/rss/technology.xml');
    assert.equal(insertedSources[0][9], true, 'Strict quality check passes -> auto-enabled in headline_link mode');
    assert.equal(insertedSources[0][10], 'approved');

    // Second run in moderation mode queues pending_review & supports approve/reject
    round = 2;
    const modResult = await discovery.discoverAndVerify({
      requireModeration: true,
      focusCategories: ['tech'],
      lookupFn: async () => [{ address: '185.199.108.153' }],
      parseFeedFn: async (feed) => [
        {
          id: 'suspilne-1',
          url: 'https://suspilne.media/news/1',
          original_title: 'Суспільне запустило відкриту платформу технологічної освіти',
          original_summary: 'Деталі проєкту.',
          published_at: new Date().toISOString(),
          source_name: feed.name,
          source_slug: feed.slug,
          category: 'tech',
        },
        {
          id: 'suspilne-2',
          url: 'https://suspilne.media/news/2',
          original_title: 'Українські університети оновили програми з інженерії систем',
          original_summary: 'Огляд змін.',
          published_at: new Date().toISOString(),
          source_name: feed.name,
          source_slug: feed.slug,
          category: 'tech',
        },
      ],
    });
    assert.equal(modResult.verified, 1);
    assert.equal(modResult.pendingReview.length, 1);
    assert.equal(modResult.pendingModeration, 1);

    const sourcesController = new SourcesController(mockDb, mockFeeds, discovery);
    const approved = await sourcesController.approve(modResult.added[0], { licenseMode: 'summary' });
    assert.equal(approved.review_status, 'approved');
    assert.equal(approved.license_mode, 'summary');

    const rejected = await sourcesController.reject(modResult.added[0]);
    assert.equal(rejected.review_status, 'rejected');
    assert.equal(statusUpdates.length, 2);

    // Logical feed quality validator blocks stale (>30d) & link-farm feeds
    const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
    const staleQuality = assessDiscoveredFeedQuality(
      [
        { id: 's1', url: 'https://example.org/a', original_title: 'Long enough headline one here', published_at: staleDate, source_name: 'Ex', source_slug: 'ex' },
        { id: 's2', url: 'https://example.org/b', original_title: 'Long enough headline two here', published_at: staleDate, source_name: 'Ex', source_slug: 'ex' },
      ],
      'example.org',
      'example.org',
    );
    assert.equal(staleQuality.ok, false);

    const linkFarmQuality = assessDiscoveredFeedQuality(
      [
        { id: 'l1', url: 'https://other-site.net/1', original_title: 'External aggregated article one', published_at: new Date().toISOString(), source_name: 'Ex', source_slug: 'ex' },
        { id: 'l2', url: 'https://another-site.net/2', original_title: 'External aggregated article two', published_at: new Date().toISOString(), source_name: 'Ex', source_slug: 'ex' },
      ],
      'example.org',
      'example.org',
    );
    assert.equal(linkFarmQuality.ok, false);

    // On-demand trigger cooldown check
    assert.equal(discovery.triggerDiscoveryIfNeeded(['science_space'], { cooldownMs: 60_000 }), true);
    assert.equal(discovery.triggerDiscoveryIfNeeded(['science_space'], { cooldownMs: 60_000 }), false);

    // HTML alternate link extraction helper check
    const links = extractAlternateFeedLinksFromHtml(
      '<link rel="alternate" type="application/atom+xml" href="/atom.xml">',
      'https://example.org/news',
    );
    assert.deepEqual(links, ['https://example.org/atom.xml']);
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    globalThis.fetch = origFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('ExpertOpinionsService never synthesizes fake oEmbed HTML, validates HTTPS sourceUrl, and does not fabricate quotes when grounding is disabled', async () => {
  const xEmbed = buildOfficialEmbedInfo('https://x.com/karpathy/status/1234567890', '@karpathy', 'Quote text');
  assert.equal(xEmbed.htmlSnippet, undefined);
  assert.equal(xEmbed.interactiveSupported, true);

  assert.throws(
    () =>
      validateExpertOpinionItem({
        expertName: 'Andrej Karpathy',
        handle: '@karpathy',
        platform: 'x',
        roleUk: 'Дослідник ШІ',
        sourceUrl: 'http://127.0.0.1/bad',
        publishedAt: '2026-11-15T08:00:00Z',
        directQuote: 'Test quote with enough characters',
        stanceSummaryUk: 'Аналітичний коментар',
        contextUk: 'Контекст публікації',
        potentialBiasUk: 'Опис ролі',
        conflictOfInterestUk: 'Eureka Labs',
        keyArgumentsUk: ['Аргумент перший'],
      }),
    /Invalid or non-HTTPS expert sourceUrl/,
  );

  // Without live search grounding or real post URLs in expert_opinions/documentedPositions,
  // ExpertOpinionsService must not fabricate placeholder quotes from profile URLs.
  const prevGrounding = process.env.GEMINI_EXPERT_SEARCH_GROUNDING;
  delete process.env.GEMINI_EXPERT_SEARCH_GROUNDING;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 404 });
  try {
    const mockDb = {
      query: async (sql) => {
        if (sql.includes('FROM news_items')) {
          return {
            rows: [
              {
                id: 'news-exp-1',
                url: 'https://openai.com/news/test-model',
                original_title: 'OpenAI releases new reasoning model',
                title_uk: 'OpenAI випустила нову модель міркувань',
                summary_uk: 'Короткий огляд релізу.',
                category: 'ai',
                importance: 'high',
                source_name: 'OpenAI',
              },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const svc = new ExpertOpinionsService(mockDb);
    svc.clearCacheForTests();
    const controller = new NewsController(mockDb, undefined, undefined, svc);
    const res = await controller.expertsForArticle('news-exp-1');
    assert.equal(res.opinions.length, 0);
  } finally {
    globalThis.fetch = origFetch;
    if (prevGrounding !== undefined) process.env.GEMINI_EXPERT_SEARCH_GROUNDING = prevGrounding;
  }
});

test('FeedEditorialService clusters RSS items before spending Gemini quota and stops cleanly on Gemini HTTP 429', async () => {
  const now = new Date().toISOString();
  const ingestCalls = [];
  const mockFeeds = {
    getActiveFeeds: () => [
      { slug: 'openai', name: 'OpenAI News', domain: 'openai.com', url: 'https://openai.com/news/rss.xml', category: 'ai', licenseMode: 'summary' },
      { slug: 'simonw', name: 'Simon Willison', domain: 'simonwillison.net', url: 'https://simonwillison.net/atom.xml', category: 'ai', licenseMode: 'summary' },
    ],
    list: async () => ({
      items: [
        {
          id: 'oa-1',
          url: 'https://openai.com/news/gpt-5-5-launch',
          canonical_url: 'https://openai.com/news/gpt-5-5-launch',
          original_title: 'OpenAI launches GPT-5.5 coding model for developers',
          original_summary: 'Official release notes.',
          published_at: now,
          source_name: 'OpenAI News',
          source_slug: 'openai',
          category: 'ai',
        },
        {
          id: 'sw-1',
          url: 'https://simonwillison.net/2026/Nov/15/gpt-5-5-launch/',
          canonical_url: 'https://simonwillison.net/2026/Nov/15/gpt-5-5-launch',
          original_title: 'OpenAI launches GPT-5.5 coding model notes',
          original_summary: 'Independent developer commentary.',
          published_at: now,
          source_name: 'Simon Willison',
          source_slug: 'simonw',
          category: 'ai',
        },
      ],
    }),
  };
  const mockEditor = {
    enabled: true,
    planBatchAnglesWithHydrogen: async () => ({}),
    polishArticlesBatchWithHydrogen: async () => ({ checked: 0, polished: 0, failed: 0, skipped: 0 }),
  };
  const mockIngest = {
    ingest: async (dto, _useEditor, options) => {
      ingestCalls.push({ dto, options });
      throw new Error('Gemini HTTP 429 Too Many Requests');
    },
  };
  const mockDb = { query: async () => ({ rows: [] }) };
  const mockCatalog = { notifyArticlePublished: async () => undefined };

  const editorialService = new FeedEditorialService(
    mockFeeds,
    mockEditor,
    mockIngest,
    mockDb,
    mockCatalog,
    new NewsClusteringService(),
  );
  const summary = await editorialService.runOnce();
  assert.equal(ingestCalls.length, 1, 'Overlapping event across 2 feeds must trigger only 1 clustered ingest attempt');
  assert.equal(ingestCalls[0].options.clusterSources.length, 2);
  assert.equal(summary.errors, 1);
});

test('Multi-source DB persistence: FeedEditorialService, IngestService, and NewsController.detail attach overlapping 48h sources cleanly', async () => {
  const now = new Date().toISOString();
  const persistedRows = [
    {
      id: '101',
      url: 'https://openai.com/news/gpt-5-5-launch/',
      canonicalUrl: 'https://openai.com/news/gpt-5-5-launch',
      original_title: 'OpenAI launches GPT-5.5 coding model for developers',
      title_uk: 'OpenAI випустила модель GPT-5.5 для розробників',
      summary_uk: 'Офіційний анонс моделі GPT-5.5.',
      published_at: now,
      category: 'ai',
      importance: 'high',
      article: { body: '...' },
      source_name: 'OpenAI News',
      source_slug: 'openai',
      source_is_unofficial: false,
      cluster_id: null,
      cluster_sources: [],
    },
  ];
  const clusterUpdates = [];

  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('UPDATE news_items') && sql.includes('SET cluster_id')) {
        const target = persistedRows.find(r => r.id === String(args[0]));
        const parsedSources = JSON.parse(String(args[2] || '[]'));
        if (target) {
          target.cluster_id = args[1];
          target.cluster_sources = parsedSources;
        }
        clusterUpdates.push({ id: args[0], clusterId: args[1], sources: parsedSources });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("n.status = 'published'") && sql.includes("48 hours")) {
        return { rows: persistedRows };
      }
      if (sql.includes('WHERE n.id=$1')) {
        const found = persistedRows.find(r => r.id === String(args[0]));
        return { rows: found ? [{ ...found, cluster_sources: [] }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, args = []) {
          return mockDb.query(sql, args);
        },
        release() {},
      };
    },
  };

  // 1. FeedEditorialService detects existing DB story and attaches secondary RSS without calling Gemini ingest
  const ingestCalls = [];
  const mockFeeds = {
    getActiveFeeds: () => [
      { slug: 'simonw', name: 'Simon Willison', domain: 'simonwillison.net', url: 'https://simonwillison.net/atom.xml', category: 'ai', licenseMode: 'summary' },
    ],
    list: async () => ({
      items: [
        {
          id: 'sw-later',
          url: 'https://simonwillison.net/2026/Nov/15/gpt-5-5-launch/',
          canonical_url: 'https://simonwillison.net/2026/Nov/15/gpt-5-5-launch',
          original_title: 'OpenAI launches GPT-5.5 coding model notes',
          original_summary: 'Independent developer commentary.',
          published_at: now,
          source_name: 'Simon Willison',
          source_slug: 'simonw',
          category: 'ai',
        },
      ],
    }),
  };
  const editorial = new FeedEditorialService(
    mockFeeds,
    { enabled: true, planBatchAnglesWithHydrogen: async () => ({}), polishArticlesBatchWithHydrogen: async () => ({ checked: 0, polished: 0, failed: 0, skipped: 0 }) },
    { ingest: async (dto) => { ingestCalls.push(dto); return { written: 1, unchanged: 0 }; } },
    mockDb,
    { notifyArticlePublished: async () => undefined },
    new NewsClusteringService(),
  );
  const cycle = await editorial.runOnce();
  assert.equal(ingestCalls.length, 0, 'Secondary source matching 48h DB item must NOT re-run Gemini ingest');
  assert.equal(cycle.skipped, 1);
  assert.equal(clusterUpdates.length, 1);
  assert.equal(persistedRows[0].cluster_sources.length, 2);

  // 2. IngestService attaches third feed source into the same persisted cluster
  let editorEditCalled = false;
  const ingestService = new IngestService(
    mockDb,
    {
      enabled: true,
      fingerprint: () => 'fp',
      edit: async () => {
        editorEditCalled = true;
        throw new Error('Must not call Gemini editor when 48h DB cluster already matched');
      },
    },
    new NewsClusteringService(),
  );
  const ingestRes = await ingestService.ingest(
    {
      source: { slug: 'arstechnica', name: 'Ars Technica', homepageUrl: 'https://arstechnica.com', licenseMode: 'headline_link' },
      items: [
        {
          externalId: 'ars-1',
          url: 'https://arstechnica.com/ai/2026/11/openai-gpt-5-5-coding-model/',
          originalTitle: 'OpenAI releases GPT-5.5 coding model for developers',
          originalSummary: 'Coverage by Ars Technica.',
          publishedAt: now,
          category: 'ai',
          importance: 'unknown',
          freeAccess: 'unknown',
        },
      ],
    },
    true,
  );
  assert.equal(editorEditCalled, false);
  assert.equal(ingestRes.written, 0);
  assert.equal(ingestRes.unchanged, 1);
  assert.equal(persistedRows[0].cluster_sources.length, 3);

  // 3. NewsController.detail enriches even if stored cluster_sources on the single row was empty
  // Provide clean sync list mock with additional RSS match
  const controllerWithRss = new NewsController(
    mockDb,
    {
      list: async () => ({
        items: [
          {
            id: 'rss-techcrunch',
            url: 'https://techcrunch.com/2026/11/15/openai-gpt-5-5-coding-model/',
            original_title: 'OpenAI launches GPT-5.5 coding model',
            published_at: now,
            source_name: 'TechCrunch',
            source_slug: 'techcrunch',
          },
        ],
      }),
      getActiveFeeds: () => [],
    },
    undefined,
    undefined,
    undefined,
    new NewsClusteringService(),
  );
  const detail = await controllerWithRss.detail('101');
  assert.ok(detail.cluster_id);
  assert.ok(detail.source_count >= 2, `Expected >=2 clustered sources in detail(), got ${detail.source_count}`);
  assert.ok(detail.cluster_sources.some(s => s.sourceSlug === 'techcrunch'));
});

test('Briefing script removes "Практичне значення" / section labels, uses dedicated briefingScript, and deduplicates title in description', () => {
  assert.equal(
    stripBriefingSectionLabels('Практичне значення: Компанія знизила ціну. Чому це важливо: це економить час.'),
    'Компанія знизила ціну. це економить час.',
  );

  // Without dedicated briefingScript, repetitive summary overlapping with title is suppressed
  const deduped = buildBroadcastScriptUk({
    titleUk: 'OpenAI випустила нову швидку модель GPT-5 Mini для розробників',
    summaryUk: 'OpenAI випустила нову швидку модель GPT-5 Mini для розробників зі зниженою вартістю API.',
    whyItMatters: 'Практичне значення: Це зменшує витрати команд на інтеграцію ШІ.',
    sourceName: 'OpenAI',
    facts: ['Підтверджені факти: Затримка скоротилася на 35 відсотків.'],
    comparisons: ['Контекст порівняння: Попередня версія коштувала вдвічі дорожче.'],
    depth: 'balanced_feed',
    style: 'podcast_story',
  });
  assert.ok(!/Практичне значення/i.test(deduped), `Must not contain "Практичне значення": ${deduped}`);
  assert.ok(!/Чому це важливо/i.test(deduped), `Must not contain "Чому це важливо": ${deduped}`);
  assert.ok(!/Підтверджені факти/i.test(deduped), `Must not contain "Підтверджені факти": ${deduped}`);
  assert.ok(!/Контекст порівняння/i.test(deduped), `Must not contain "Контекст порівняння": ${deduped}`);
  const titleMatches = deduped.match(/GPT-5 Mini/gi) ?? [];
  assert.equal(titleMatches.length, 1, `Title should not repeat in description script: ${deduped}`);

  // When dedicated briefingScript is supplied, it drives the script cleanly without redundant headings
  const dedicated = buildBroadcastScriptUk({
    titleUk: 'Anthropic оновила Claude Code',
    summaryUk: 'Anthropic оновила Claude Code для команд.',
    whyItMatters: 'Практичне значення: Швидший пошук багів.',
    briefingScript: 'Інженери Anthropic запустили автономний цикл перевірки pull request у Claude Code. Практичне значення: Це прискорює ревʼю коду вдвічі.',
    depth: 'balanced_feed',
    style: 'podcast_story',
  });
  assert.ok(dedicated.includes('автономний цикл перевірки pull request'));
  assert.ok(!/Практичне значення/i.test(dedicated));
  assert.ok(!dedicated.startsWith('Anthropic оновила Claude Code.'), 'Dedicated briefingScript avoids mechanical title prefixing');
});

test('NewsTtsService DB persistence, prewarmImportantBriefings, listLatestBriefings, and NewsController endpoints', async () => {
  resetGeminiClientStateForTests();
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-tts-prewarm-key';
  const prevDbAudio = process.env.TTS_DB_AUDIO_CACHE;
  process.env.TTS_DB_AUDIO_CACHE = 'true'; // legacy DB audio cache is opt-in
  const prevFetch = globalThis.fetch;

  const cacheRows = new Map();
  const nowIso = new Date().toISOString();
  const fakeArticle = {
    id: '501',
    external_id: 'ext-501',
    title_uk: 'Google DeepMind представила нову модель для науки',
    original_title: 'Google DeepMind unveils new science model',
    summary_uk: 'Опис оновлення.',
    original_summary: 'Summary.',
    why_it_matters: 'Практичне значення: Прискорює відкриття матеріалів.',
    importance: 'high',
    important_flag: true,
    category: 'ai',
    published_at: nowIso,
    source_name: 'DeepMind Blog',
    source_slug: 'deepmind',
    hydrogen_insight: null,
    briefing_script: 'Дослідники DeepMind презентували систему моделювання нових каталізаторів без дорогих лабораторних циклів.',
    comparisons: [],
    facts: ['Тести підтвердили точність 94 відсотки.'],
  };

  let geminiTtsCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('-tts:generateContent')) {
      geminiTtsCalls += 1;
    }
    const pcm = Buffer.alloc(1600, 1);
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

  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('INSERT INTO news_tts_cache')) {
        cacheRows.set(args[0], {
          cache_key: args[0],
          news_id: args[1],
          external_id: args[2],
          depth: args[3],
          style: args[4],
          voice_name: args[5],
          status: args[6],
          model_used: args[7],
          mime_type: args[8],
          audio_base64: args[9],
          script_uk: args[10],
          duration_estimate_sec: args[11],
          updated_at: new Date(),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM news_tts_cache') && sql.includes('WHERE cache_key = $1')) {
        const row = cacheRows.get(args[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM news_items n') && sql.includes('LIMIT $1')) {
        return { rows: [fakeArticle] };
      }
      if (sql.includes('FROM news_items n') && sql.includes('n.id::text = $1')) {
        return { rows: [fakeArticle] };
      }
      return { rows: [] };
    },
  };

  try {
    // 1. Prewarm populates DB cache cleanly
    const ttsWriter = new NewsTtsService(mockDb);
    const prewarmSummary = await ttsWriter.prewarmImportantBriefings({ limit: 5 });
    assert.equal(prewarmSummary.checked, 1);
    assert.equal(prewarmSummary.generated, 1);
    assert.equal(prewarmSummary.cached, 0);
    assert.equal(geminiTtsCalls, 1);
    assert.equal(cacheRows.size, 1);

    // 2. Fresh NewsTtsService instance reads from news_tts_cache without calling Gemini again
    const ttsReader = new NewsTtsService(mockDb);
    const list = await ttsReader.listLatestBriefings({ limit: 5, includeAudio: true });
    assert.equal(list.total, 1);
    assert.equal(list.preloadedCount, 1);
    assert.equal(list.items[0].audioReady, true);
    assert.ok(list.items[0].audioBase64);
    assert.ok(!/Практичне значення/i.test(list.items[0].scriptUk));

    const detailAudio = await ttsReader.generateImportantNewsBriefing('501');
    assert.equal(detailAudio.cached, true);
    assert.equal(geminiTtsCalls, 1, 'Fresh service instance must reuse persisted news_tts_cache entry');

    // 3. NewsController endpoints expose briefings/latest and briefings/prewarm cleanly
    const controller = new NewsController(
      mockDb,
      { list: async () => ({ items: [] }), getActiveFeeds: () => [] },
      ttsReader,
    );
    const latestResp = await controller.latestBriefings('5', undefined, undefined, 'false');
    assert.equal(latestResp.total, 1);
    assert.equal(latestResp.items[0].audioReady, true);
    assert.equal(latestResp.items[0].audioBase64, undefined);

    const prewarmResp = await controller.prewarmBriefings('5');
    assert.equal(prewarmResp.checked, 1);
    assert.equal(prewarmResp.cached, 1);
    assert.equal(geminiTtsCalls, 1);

    await assert.rejects(() => controller.latestBriefings('0'), BadRequestException);
    await assert.rejects(() => controller.latestBriefings('5', 'bad_depth'), BadRequestException);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    if (prevDbAudio === undefined) delete process.env.TTS_DB_AUDIO_CACHE;
    else process.env.TTS_DB_AUDIO_CACHE = prevDbAudio;
  }
});

test('NewsTtsService does not persist audio to Postgres by default', async () => {
  resetGeminiClientStateForTests();
  const prev = process.env.TTS_DB_AUDIO_CACHE;
  delete process.env.TTS_DB_AUDIO_CACHE;
  const queries = [];
  const db = { async query(sql) { queries.push(sql); return { rows: [] }; } };
  try {
    const svc = new NewsTtsService(db);
    await svc.writeDbCache('k', { id: '1', external_id: 'e' }, {
      status: 'gemini_audio', audioBase64: 'AAAA', depth: 'short', style: 'news',
      voiceName: 'Kore', modelUsed: 'm', mimeType: 'audio/wav', scriptUk: 's', durationEstimateSec: 5,
    });
    assert.equal(await svc.readDbCache('k', '1', 'short', 'news', 'Kore'), null);
    assert.equal(queries.length, 0, 'no news_tts_cache queries when flag is off');
  } finally {
    if (prev === undefined) delete process.env.TTS_DB_AUDIO_CACHE;
    else process.env.TTS_DB_AUDIO_CACHE = prev;
  }
});

test('parseFeedXml parses YouTube Atom RSS media:description, yt:videoId, statistics, starRating, and Shorts flag', () => {
  const nowIso = new Date().toISOString();
  const ytAtom = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
    <title>Andrej Karpathy</title>
    <entry>
      <id>yt:video:EWvNQjAaOHw</id>
      <yt:videoId>EWvNQjAaOHw</yt:videoId>
      <yt:channelId>UCXUPKJO5MZQN11PqgIvyuvQ</yt:channelId>
      <title>How I use LLMs</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=EWvNQjAaOHw"/>
      <published>${nowIso}</published>
      <media:group>
        <media:title>How I use LLMs</media:title>
        <media:thumbnail url="https://i2.ytimg.com/vi/EWvNQjAaOHw/hqdefault.jpg" width="480" height="360"/>
        <media:description>Deep walkthrough of LLM workflows.
00:00 Intro
02:30 Thinking models and benchmarks
15:10 Tool use and agents</media:description>
        <media:community>
          <media:starRating count="70289" average="5.00" min="1" max="5"/>
          <media:statistics views="2925719"/>
        </media:community>
      </media:group>
    </entry>
    <entry>
      <id>yt:video:Sh0rtVid123</id>
      <yt:videoId>Sh0rtVid123</yt:videoId>
      <yt:channelId>UCXUPKJO5MZQN11PqgIvyuvQ</yt:channelId>
      <title>Quick #shorts clip</title>
      <link rel="alternate" href="https://www.youtube.com/shorts/Sh0rtVid123"/>
      <published>${nowIso}</published>
      <media:group>
        <media:description>Short clip</media:description>
      </media:group>
    </entry>
  </feed>`;

  const items = parseFeedXml(ytAtom, {
    slug: 'yt-andrej-karpathy',
    name: 'Andrej Karpathy',
    domain: 'youtube.com',
    allowedDomains: ['youtube.com', 'm.youtube.com', 'youtu.be'],
    url: buildYoutubeRssUrl('UCXUPKJO5MZQN11PqgIvyuvQ'),
  });

  assert.equal(items.length, 2);
  const full = items.find((i) => i.video_id === 'EWvNQjAaOHw');
  const short = items.find((i) => i.video_id === 'Sh0rtVid123');
  assert.ok(full);
  assert.equal(full.channel_id, 'UCXUPKJO5MZQN11PqgIvyuvQ');
  assert.equal(full.views_count, 2925719);
  assert.equal(full.likes_count, 70289);
  assert.equal(full.thumbnail_url, 'https://i2.ytimg.com/vi/EWvNQjAaOHw/hqdefault.jpg');
  assert.equal(full.is_youtube_short, false);
  assert.ok(full.raw_description?.includes('02:30 Thinking models'));
  assert.ok(short);
  assert.equal(short.is_youtube_short, true);
  assert.equal(extractYoutubeVideoId(full.url), 'EWvNQjAaOHw');
});

test('YouTube worthiness gate, compressed audio-first Gemini payload, and YouTube oEmbed work cleanly', () => {
  assert.ok(YOUTUBE_RSS_CHANNELS.length >= 10);
  const karpathy = YOUTUBE_RSS_CHANNELS[0];
  const nowIso = new Date().toISOString();

  const shortRes = evaluateYoutubeVideoWorthiness(
    {
      url: 'https://www.youtube.com/shorts/abc12345',
      original_title: 'AI update #shorts',
      original_summary: 'Short clip',
      published_at: nowIso,
      is_youtube_short: true,
    },
    karpathy,
  );
  assert.equal(shortRes.worthy, false);
  assert.equal(shortRes.isShort, true);
  assert.equal(shortRes.worthScore, 0);

  const giveawayRes = evaluateYoutubeVideoWorthiness(
    {
      url: 'https://www.youtube.com/watch?v=giveaway123',
      original_title: 'Channel Update & Merch Giveaway!',
      original_summary: 'Subscribe to win merch.',
      published_at: nowIso,
    },
    karpathy,
  );
  assert.equal(giveawayRes.worthy, false);

  const deepDesc = [
    'Practical breakdown of LLM reasoning benchmarks and agent architectures.',
    '00:00 Intro',
    '02:00 Benchmark methodology',
    '12:30 Agent tool verification',
    '28:00 Open-weight GPU inference',
    '52:00 Summary and takeaways',
    'https://arxiv.org/abs/2501.00001 https://github.com/example/repo',
  ].join('\n');

  const worthyRes = evaluateYoutubeVideoWorthiness(
    {
      url: 'https://www.youtube.com/watch?v=deepDive999',
      original_title: 'Deep Dive into LLM Reasoning Benchmarks and GPU Inference',
      original_summary: deepDesc,
      raw_description: deepDesc,
      published_at: nowIso,
      views_count: 140_000,
      likes_count: 6_200,
    },
    karpathy,
  );
  assert.equal(worthyRes.worthy, true);
  assert.ok(worthyRes.worthScore >= 75);
  assert.equal(worthyRes.chapters.length, 5);
  assert.equal(worthyRes.preferApifyFallback, true);

  const geminiBody = buildCompressedGeminiYoutubeBody('https://www.youtube.com/watch?v=deepDive999', {
    title: 'Deep Dive into LLM Reasoning Benchmarks and GPU Inference',
    channelName: 'Andrej Karpathy',
    description: deepDesc,
    chapters: worthyRes.chapters,
    estimatedDurationSec: worthyRes.estimatedDurationSec,
    defaultCategory: 'model',
  });
  const genCfg = geminiBody.generationConfig;
  assert.equal(genCfg.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.ok(genCfg.maxOutputTokens <= 1500);
  const videoPart = geminiBody.contents[0].parts[0];
  assert.equal(videoPart.fileData.fileUri, 'https://www.youtube.com/watch?v=deepDive999');
  assert.equal(videoPart.videoMetadata.fps, 0.01);
  assert.equal(videoPart.videoMetadata.startOffset.seconds, 120); // skipped 00:00 Intro

  const embed = buildOfficialEmbedInfo('https://www.youtube.com/watch?v=deepDive999');
  assert.equal(embed.type, 'youtube_oembed');
  assert.equal(embed.providerName, 'YouTube');
  assert.ok(embed.embedUrl.includes('youtube.com/oembed'));
});

test('YoutubeRadarService prioritizes compressed Gemini audio, uses apify_token sparingly as fallback, and enforces 30/day cap', async () => {
  resetGeminiClientStateForTests();
  const prevFetch = globalThis.fetch;
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevApifyToken = process.env.apify_token;
  const prevMaxDaily = process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS;
  const prevMaxApify = process.env.YOUTUBE_MAX_DAILY_APIFY;

  process.env.GEMINI_API_KEY = 'test-gemini-key-youtube';
  process.env.apify_token = 'test-render-apify-token-123';
  process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS = '30';
  process.env.YOUTUBE_MAX_DAILY_APIFY = '5';
  assert.equal(getConfiguredApifyToken(), 'test-render-apify-token-123');

  const nowIso = new Date().toISOString();
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
    <title>Digital Foundry</title>
    <entry>
      <id>yt:video:vidGemini1</id>
      <yt:videoId>vidGemini1</yt:videoId>
      <yt:channelId>UC9PBzalIcEQCsiIkq36PyUA</yt:channelId>
      <title>Metro Upgrade GPU Benchmark and Frame-Time Analysis</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=vidGemini1"/>
      <published>${nowIso}</published>
      <media:group>
        <media:description>Full benchmark analysis of rendering and 120Hz performance.
00:00 Intro
02:00 Console GPU performance test
10:00 Frame-time comparison
18:00 Conclusion</media:description>
        <media:community>
          <media:starRating count="3200" average="5.00"/>
          <media:statistics views="85000"/>
        </media:community>
      </media:group>
    </entry>
    <entry>
      <id>yt:video:vidApifyFb2</id>
      <yt:videoId>vidApifyFb2</yt:videoId>
      <yt:channelId>UC9PBzalIcEQCsiIkq36PyUA</yt:channelId>
      <title>Unreal Engine Deep Dive Interview on Next-Gen Rendering</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=vidApifyFb2"/>
      <published>${nowIso}</published>
      <media:group>
        <media:description>Long engineering interview on rendering architecture.
00:00 Intro
03:00 Nanite &amp; Lumen deep dive
25:00 Shader compilation
55:00 Future hardware</media:description>
        <media:community>
          <media:starRating count="4100" average="5.00"/>
          <media:statistics views="120000"/>
        </media:community>
      </media:group>
    </entry>
  </feed>`;

  const geminiAudioCalls = [];
  const geminiTextCalls = [];
  const apifyCalls = [];
  const dbVideos = new Map();
  const dbNews = [];

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('youtube.com/feeds/videos.xml')) {
      return new Response(rssXml, { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
    }
    if (u.includes('api.apify.com/v2/actors/')) {
      apifyCalls.push(u);
      assert.ok(u.includes('token=test-render-apify-token-123'));
      return new Response(
        JSON.stringify([
          {
            transcript: [
              { start: 0, text: 'Welcome to the Unreal Engine deep dive.' },
              { start: 185, text: 'Shader compilation pipelines improved by 40 percent.' },
            ],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      const parsedBody = JSON.parse(String(init?.body || '{}'));
      const firstPart = parsedBody?.contents?.[0]?.parts?.[0];
      if (firstPart?.fileData?.fileUri) {
        geminiAudioCalls.push(firstPart.fileData.fileUri);
        assert.equal(parsedBody.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
        assert.equal(firstPart.videoMetadata.fps, 0.01);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        worthKeeping: true,
                        titleUk: 'Технічний розбір 120 Гц у Metro: тест GPU та frame-time',
                        summaryUk: 'Детальний аналіз продуктивності консолей на частоті 120 Гц.',
                        whyItMattersUk: 'Показує реальні межі апскейлінгу на поточному поколінні GPU.',
                        keyTakeawaysUk: ['Стабільні 120 Гц досягнуто в режимі продуктивності.'],
                        timestampedQuotes: [
                          {
                            timestampSec: 120,
                            timestampLabel: '02:00',
                            speaker: 'Digital Foundry',
                            insightUk: 'Порівняння затримок кадру на PS5 Pro та Xbox.',
                          },
                        ],
                        category: 'hardware_gaming',
                        importance: 'high',
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

      geminiTextCalls.push(u);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      worthKeeping: true,
                      titleUk: 'Інтерв’ю про рендеринг Unreal Engine наступного покоління',
                      summaryUk: 'Інженери пояснили оптимізацію компіляції шейдерів на 40%.',
                      whyItMattersUk: 'Важливо для розробників ігор та студій на UE.',
                      keyTakeawaysUk: ['Компіляція шейдерів прискорена на 40%.'],
                      timestampedQuotes: [
                        {
                          timestampSec: 185,
                          timestampLabel: '03:05',
                          speaker: 'Інженер UE',
                          insightUk: 'Новий пайплайн знімає статери на ПК.',
                        },
                      ],
                      category: 'hardware_gaming',
                      importance: 'high',
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
    throw new Error(`Unexpected fetch URL in test: ${u}`);
  };

  const mockDb = {
    async query(sql, args = []) {
      if (sql.includes('COUNT(*)::int AS total') && sql.includes('FROM youtube_videos')) {
        let total = 0;
        let apify_count = 0;
        for (const row of dbVideos.values()) {
          if (row.transcribed_at) {
            total += 1;
            if (row.transcription_provider === 'apify_transcript') apify_count += 1;
          }
        }
        return { rows: [{ total, apify_count }] };
      }
      if (sql.includes('SELECT status FROM youtube_videos WHERE video_id = $1')) {
        const row = dbVideos.get(args[0]);
        return { rows: row ? [{ status: row.status }] : [] };
      }
      if (sql.includes('INSERT INTO sources')) {
        return { rows: [{ id: '99' }] };
      }
      if (sql.includes('INSERT INTO news_items')) {
        dbNews.push({ externalId: args[1], titleUk: args[6] });
        return { rows: [{ id: String(1000 + dbNews.length) }] };
      }
      if (sql.includes('INSERT INTO youtube_videos')) {
        dbVideos.set(args[0], {
          video_id: args[0],
          status: args[15],
          transcription_provider: args[16],
          transcribed_at: args[25],
        });
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
  };

  try {
    assert.equal(
      extractApifyTranscriptText([{ transcript: [{ start: 0, text: 'Hello' }, { start: 35, text: 'World' }] }]),
      '[00:00] Hello [00:35] World',
    );

    const service = new YoutubeRadarService(mockDb);
    const controller = new YoutubeController(service);
    const channel = YOUTUBE_RSS_CHANNELS.find((c) => c.slug === 'yt-digital-foundry');

    const syncRes = await service.syncOnce({ maxTranscribe: 4, channels: [channel] });
    assert.equal(syncRes.channelsPolled, 1);
    assert.equal(syncRes.videosDiscovered, 2);
    assert.equal(syncRes.transcribed, 2);
    assert.equal(syncRes.apifyUsed, 1, 'Long 58-min high-score interview uses Apify sparingly, shorter video uses Gemini audio');
    assert.equal(geminiAudioCalls.length, 1);
    assert.equal(apifyCalls.length, 1);
    assert.equal(geminiTextCalls.length, 1);
    assert.equal(dbNews.length, 2);

    const quota = await controller.quota();
    assert.equal(quota.limitPerDay, 30);
    assert.equal(quota.usedToday, 2);
    assert.equal(quota.remainingToday, 28);
    assert.equal(quota.apifyLimitPerDay, 5);
    assert.equal(quota.apifyUsedToday, 1);
    assert.equal(quota.apifyConfigured, true);

    await assert.rejects(() => controller.listInsights('0'), BadRequestException);
    await assert.rejects(() => controller.sync('15'), BadRequestException);

    // Verify hard 30/day cap blocks further transcriptions even if more videos arrive
    process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS = '2';
    const cappedSync = await service.syncOnce({ maxTranscribe: 4, channels: [channel] });
    assert.equal(cappedSync.quotaReached, true);
    assert.equal(cappedSync.transcribed, 0);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevApifyToken === undefined) delete process.env.apify_token;
    else process.env.apify_token = prevApifyToken;
    if (prevMaxDaily === undefined) delete process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS;
    else process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS = prevMaxDaily;
    if (prevMaxApify === undefined) delete process.env.YOUTUBE_MAX_DAILY_APIFY;
    else process.env.YOUTUBE_MAX_DAILY_APIFY = prevMaxApify;
    resetGeminiClientStateForTests();
  }
});

// ---- v2.0: personal feed, stories, caricatures, R2, memes tone filter ----
import { signR2Request, isSafeObjectKey } from '../dist/common/r2-storage.js';
import {
  applyEvents,
  decayWeights,
  pickTopStories,
  rankForReader,
  isValidDeviceId,
} from '../dist/news/personalization.service.js';
import { TRAGEDY_SENSITIVITY_RE, extractMemeSearchQuery, withMemeAttribution } from '../dist/news/news-memes.service.js';
import { isCaricatureCandidate, sanitizeCaricatureScene } from '../dist/news/caricature.service.js';
import { videoMatchesStory, normalizeLocalized } from '../dist/news/story-briefing.service.js';
import { declaredTopicsToCategories } from '../dist/news/feed.controller.js';

test('R2 SigV4 signing produces a path-style URL and a scoped Authorization header', () => {
  const signed = signR2Request({
    config: { endpoint: 'https://abc123.r2.cloudflarestorage.com', bucket: 'news-radar', accessKeyId: 'AKID', secretAccessKey: 'SECRET', publicBaseUrl: null },
    method: 'PUT',
    key: 'caricatures/42-abcd.jpg',
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    extraHeaders: { 'content-type': 'image/jpeg' },
    now: new Date('2026-11-15T10:00:00Z'),
  });
  assert.equal(signed.url, 'https://abc123.r2.cloudflarestorage.com/news-radar/caricatures/42-abcd.jpg');
  assert.match(signed.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20261115\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(signed.headers['x-amz-date'], '20261115T100000Z');
  assert.equal(isSafeObjectKey('caricatures/../secret'), false);
  assert.equal(isSafeObjectKey('caricatures/1-a.jpg'), true);
});

test('Reader model: events raise topic weight, weights decay, hidden items are removed', () => {
  const base = { deviceId: '0b7f2a5e-3c1d-4f6a-9b8c-1d2e3f4a5b6c', lang: 'uk', topicWeights: {}, sourceWeights: {}, declaredTopics: [], eventsCount: 0, updatedAt: Date.now() };
  assert.equal(isValidDeviceId(base.deviceId), true);
  assert.equal(isValidDeviceId('not-a-uuid'), false);
  const p = applyEvents(base, [
    { itemId: '1', type: 'read', category: 'model', sourceSlug: 'openai-news', dwellMs: 60_000 },
    { itemId: '2', type: 'hide', category: 'culture' },
  ]);
  assert.ok(p.topicWeights.model > 2.5);
  assert.ok(p.topicWeights.culture < 0);
  const decayed = decayWeights({ model: 10 }, 21 * 86_400_000);
  assert.ok(Math.abs(decayed.model - 5) < 0.01, 'half-life is 21 days');

  const now = Date.now();
  const iso = (h) => new Date(now - h * 3_600_000).toISOString();
  const items = [
    { id: 'a', category: 'culture', source_slug: 'bbc-culture', published_at: iso(1) },
    { id: 'b', category: 'model', source_slug: 'openai-news', published_at: iso(3) },
    { id: 'c', category: 'model', source_slug: 'the-decoder', published_at: iso(2) },
    { id: 'd', category: 'model', source_slug: 'venturebeat-ai', published_at: iso(2) },
    { id: 'e', category: 'model', source_slug: 'wired', published_at: iso(2) },
  ];
  const ranked = rankForReader(items, { ...p, hiddenItemIds: new Set(['e']) }, new Set());
  assert.equal(ranked[0].category, 'model', 'liked topic first');
  assert.ok(!ranked.some((i) => i.id === 'e'), 'hidden item filtered');
  assert.equal(ranked.length, 4);
});

test('Top stories prefer big multi-source, important news and dedupe by cluster', () => {
  const now = Date.now();
  const iso = (h) => new Date(now - h * 3_600_000).toISOString();
  const top = pickTopStories([
    { id: '1', important: true, source_count: 5, cluster_id: 'c1', published_at: iso(2) },
    { id: '2', important: false, source_count: 5, cluster_id: 'c1', published_at: iso(2) },
    { id: '3', important: false, source_count: 1, published_at: iso(1) },
    { id: '4', important: true, source_count: 1, published_at: iso(40) },
  ], 5, now);
  assert.deepEqual(top.map((t) => t.id), ['1']);
});

test('Tone filter blocks humour on tragedies and war, allows light tech news', () => {
  assert.equal(TRAGEDY_SENSITIVITY_RE.test('Нічний обстріл Харкова: є загиблі'), true);
  assert.equal(TRAGEDY_SENSITIVITY_RE.test('Earthquake hits the region, death toll rises'), true);
  assert.equal(TRAGEDY_SENSITIVITY_RE.test('Nintendo announces a new Switch model'), false);
  assert.equal(isCaricatureCandidate({ category: 'model', title: 'OpenAI ships GPT-5 voice mode' }), true);
  assert.equal(isCaricatureCandidate({ category: 'politics', title: 'Parliament votes on budget' }), false);
  assert.equal(isCaricatureCandidate({ category: 'model', title: 'AI lab office fire: two killed' }), false);
  assert.equal(sanitizeCaricatureScene('A photorealistic portrait of Sam Altman holding a robot'), null);
  assert.ok(sanitizeCaricatureScene('A tiny robot juggling oversized GPUs while a cloud server sweats'));
});

test('Meme search uses short entity-focused English query and adds attribution/embed', () => {
  const q = extractMemeSearchQuery('OpenAI releases GPT-5 with a new reasoning mode for developers');
  assert.ok(q.includes('OpenAI') && q.includes('GPT-5'), q);
  assert.ok(q.split(' ').length <= 3);
  const item = withMemeAttribution({ id: 'x', kind: 'meme', platform: 'bluesky', titleUk: 't', originalText: 'o', captionUk: 'c', author: '@a.bsky.social', sourceUrl: 'https://bsky.app/profile/a.bsky.social/post/1', publishedAt: new Date().toISOString(), verificationStatus: 'live_public_api' });
  assert.equal(item.imagePolicy, 'hotlink_original');
  assert.match(item.embedUrl, /^https:\/\/embed\.bsky\.app\/oembed\?url=/);
  assert.match(item.attribution, /Bluesky/);
});

test('YouTube videos attach to stories by shared entities; story JSON is normalised', () => {
  assert.equal(videoMatchesStory('Nvidia unveils RTX 5090 Ti with Blackwell refresh', 'Nvidia RTX 5090 Ti review: Blackwell refresh benchmarks'), true);
  assert.equal(videoMatchesStory('Nvidia unveils RTX 5090 Ti', 'SpaceX Starship flight 12 recap'), false);
  const loc = normalizeLocalized({
    title: 'T', tldr: 'S', whatHappened: 'W', whyItMatters: 'Y', background: 'B', whatsNext: 'N',
    timeline: [{ when: '10:00', event: 'e' }, { when: '', event: 'bad' }],
    perspectives: [{ source: 'BBC', angle: 'a' }],
    videoInsights: [{ videoIndex: 1, insight: 'ok' }, { videoIndex: 5, insight: 'out of range' }],
  }, 1);
  assert.equal(loc.timeline.length, 1);
  assert.equal(loc.videoInsights.length, 1);
  assert.equal(normalizeLocalized({ title: '' }, 0), null);
});

test('Declared onboarding topics map to categories for the interest prior', () => {
  const cats = declaredTopicsToCategories(['robotics', 'model', 'ai']);
  assert.ok(cats.has('model'));
  assert.ok(cats.has('research'));
});

// ---- v2.0: YouTube channel discovery ----
import {
  channelTitleMatches,
  credibilityFor,
  extractChannelIdFromHtml,
  normalizeHandle,
  parseCandidatesJson,
  toCandidate,
} from '../dist/youtube/youtube-channel-discovery.service.js';

test('YouTube channel discovery: handles, page parsing, title matching and candidate validation', () => {
  assert.equal(normalizeHandle('https://www.youtube.com/@NVIDIA/videos'), '@NVIDIA');
  assert.equal(normalizeHandle('lexfridman'), '@lexfridman');
  assert.equal(normalizeHandle('bad handle with spaces'), null);

  const html = '<html><meta property="og:title" content="NVIDIA"><script>{"externalId":"UCHuiy8bXnmK5nisYHUd1J5g"}</script></html>';
  assert.deepEqual(extractChannelIdFromHtml(html), { channelId: 'UCHuiy8bXnmK5nisYHUd1J5g', title: 'NVIDIA' });
  assert.equal(extractChannelIdFromHtml('<html>nothing</html>'), null);

  assert.equal(channelTitleMatches('NVIDIA Official', '@NVIDIA', 'NVIDIA'), true);
  assert.equal(channelTitleMatches('Google DeepMind', '@googledeepmind', 'Random Gaming Clips'), false);

  const parsed = parseCandidatesJson('```json\n{"channels":[{"name":"NVIDIA","handle":"@NVIDIA","kind":"company","category":"hardware_gaming","language":"en","topics":["gpu"],"rationaleUk":"Офіційний канал"},{"name":"","handle":"@x"}]}\n```');
  const candidates = parsed.map((c) => toCandidate(c)).filter(Boolean);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'company');
  assert.equal(candidates[0].category, 'hardware_gaming');

  assert.deepEqual(credibilityFor('company', 2_000_000), { weight: 92, tier: 'high' });
  assert.equal(credibilityFor('media', null).tier, 'standard');
});

import { EXPERT_SEEDED_CATEGORIES } from '../dist/news/expert-directory.js';

// ---- v2.1: R2 audio queue, English-first editorial, new categories ----
import { audioCacheKey, audioPriority, buildScript, planEviction } from '../dist/news/audio-briefing.service.js';
import { detectCanonicalLang } from '../dist/ingest/gemini-editor.service.js';

test('Audio queue: LRU eviction stays under the cap, priorities favour important multi-source news', () => {
  const MB = 1024 * 1024;
  const objects = [
    { key: 'old', bytes: 400 * MB, lastAccess: 1 },
    { key: 'mid', bytes: 400 * MB, lastAccess: 2 },
    { key: 'new', bytes: 400 * MB, lastAccess: 3 },
  ];
  assert.deepEqual(planEviction(objects, 1024 * MB), ['old'], 'evicts least recently played until under 90% of the cap');
  assert.deepEqual(planEviction(objects.slice(0, 2), 1024 * MB), []);

  const now = Date.now();
  const important = audioPriority({ important: true, importance: 'high', source_count: 4, published_at: new Date(now - 3_600_000) }, now);
  const minor = audioPriority({ important: false, importance: 'low', source_count: 1, published_at: new Date(now - 3_600_000) }, now);
  assert.ok(important > minor);
  assert.notEqual(audioCacheKey('1', 'en', 'balanced', 'podcast_story', 'Kore'), audioCacheKey('1', 'uk', 'balanced', 'podcast_story', 'Kore'));
});

test('Audio script follows the language: canonical English vs Ukrainian translation', () => {
  const row = {
    id: '7', title_uk: 'Нова модель', original_title: 'New model', summary_uk: 'Український підсумок новини про модель.',
    original_summary: 'Original RSS summary', why_it_matters: 'Це важливо для розробників.', source_name: 'Lab',
    article: { canonical_lang: 'en', title: 'Lab ships a new model', summary: 'The lab released a faster model for developers today.', importance_reason: 'It cuts costs.' },
    briefing_script: 'The lab released a faster, cheaper model today, which matters for every developer.',
    importance: 'high', important: true, source_count: 2, published_at: new Date(),
  };
  assert.match(buildScript(row, 'en', 'balanced', 'podcast_story'), /faster, cheaper model/);
  assert.match(buildScript(row, 'uk', 'balanced', 'podcast_story'), /[А-Яа-яІіЇїЄє]/);
  assert.equal(detectCanonicalLang('Lab ships a new model', 'The lab released'), 'en');
  assert.equal(detectCanonicalLang('Лабораторія випустила модель', 'Сьогодні'), 'uk');
  const legacy = { ...row, article: { canonical_lang: 'uk' }, original_summary: 'Раніше опублікована новина.',
    title_en: 'Translated release', summary_en: 'The release brings support for more devices.', why_en: 'It extends compatibility.' };
  assert.match(buildScript(legacy, 'en', 'balanced', 'analyst_brief'), /Translated release.*more devices.*compatibility/);
});

test('New v2.1 categories are recognised by the feed classifier', () => {
  assert.equal(classifyFeedArticleCategory('Figure unveils a new humanoid robot for warehouses', ''), 'robotics');
  assert.equal(classifyFeedArticleCategory('Bitcoin hits a record as stablecoin rules pass', ''), 'crypto_web3');
  assert.equal(classifyFeedArticleCategory('Waymo expands robotaxi service to three cities', ''), 'mobility_ev');
  assert.ok(CATEGORIES.includes('climate_energy'));
});

// ---- v2.1: multi-provider LLM router (Gemini, Groq, OpenRouter) ----
import { canUse, chainFor, generateWithRouter, getTargets, parseJsonLoose, resetLlmRouterForTests } from '../dist/common/llm-router.js';
import { buildTranslationPrompt } from '../dist/news/translation.service.js';

test('LLM router: task roles, free-tier budgets and failover to the next provider', async () => {
  resetLlmRouterForTests();
  assert.deepEqual(chainFor('editorial'), ['gemini', 'groq', 'openrouter']);
  assert.deepEqual(chainFor('translate'), ['groq', 'gemini', 'openrouter']);
  assert.deepEqual(chainFor('story'), ['gemini', 'openrouter', 'groq']);

  const groq = getTargets().groq[0];
  assert.equal(canUse(groq, 7000), true);
  assert.equal(canUse(groq, 9000), false, 'a single request above Groq free TPM is skipped');

  const saved = { groq: process.env.groq_api_key, or: process.env.openrouter_api_key, gem: process.env.GEMINI_API_KEY };
  process.env.groq_api_key = 'test-groq';
  process.env.openrouter_api_key = 'test-or';
  delete process.env.GEMINI_API_KEY;
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('groq.com')) return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await generateWithRouter({ task: 'translate', prompt: 'hello', maxTokens: 100 });
    assert.equal(res.provider, 'openrouter');
    assert.deepEqual(parseJsonLoose(res.text), { ok: true });
    assert.ok(calls[0].includes('groq.com'));
    // Groq is now cooling down after the 429, so the next call goes straight to OpenRouter.
    calls.length = 0;
    await generateWithRouter({ task: 'translate', prompt: 'again', maxTokens: 100 });
    assert.ok(calls.every((u) => u.includes('openrouter.ai')));
  } finally {
    globalThis.fetch = realFetch;
    if (saved.groq === undefined) delete process.env.groq_api_key; else process.env.groq_api_key = saved.groq;
    if (saved.or === undefined) delete process.env.openrouter_api_key; else process.env.openrouter_api_key = saved.or;
    if (saved.gem !== undefined) process.env.GEMINI_API_KEY = saved.gem;
    resetLlmRouterForTests();
  }
  assert.match(buildTranslationPrompt('pl', [{ id: '1', title: 'T', summary: 'S', why: 'W' }]), /Polish/);
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test('IMA ADPCM: Gemini-style PCM16 WAV compresses ~4x and decodes back close to the original', async () => {
  const { compressWavToImaAdpcm, parsePcm16Wav } = await import('../dist/common/ima-adpcm.js');
  const { pcm16ToWavBase64 } = await import('../dist/news/news-tts.service.js');
  const rate = 24000;
  const n = rate * 3 + 123; // not a multiple of the block size
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t); // speech-like loudness changes
    pcm.writeInt16LE(Math.round(env * (9000 * Math.sin(2 * Math.PI * 220 * t) + 4000 * Math.sin(2 * Math.PI * 1300 * t))), i * 2);
  }
  const wav = Buffer.from(pcm16ToWavBase64(pcm, rate, 1, 16), 'base64');
  const adpcm = compressWavToImaAdpcm(wav);
  assert.ok(adpcm);
  assert.ok(adpcm.length < wav.length / 3.8, `ratio ${wav.length / adpcm.length}`);
  assert.equal(adpcm.readUInt16LE(20), 0x11);
  assert.equal(adpcm.readUInt32LE(48), n); // fact chunk = real sample count
  assert.equal(compressWavToImaAdpcm(adpcm), null); // already compressed / not PCM16

  // Independent reference decoder (standard IMA algorithm).
  const steps = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const idxT = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
  const blockAlign = adpcm.readUInt16LE(32);
  const perBlock = adpcm.readUInt16LE(38);
  const data = adpcm.subarray(60);
  const out = [];
  for (let b = 0; b * blockAlign < data.length; b += 1) {
    const o = b * blockAlign;
    let pred = data.readInt16LE(o);
    let idx = data[o + 2];
    out.push(pred);
    for (let i = 1; i < perBlock; i += 1) {
      const byte = data[o + 4 + ((i - 1) >> 1)];
      const code = (i - 1) & 1 ? byte >> 4 : byte & 15;
      const step = steps[idx];
      let d = step >> 3;
      if (code & 4) d += step;
      if (code & 2) d += step >> 1;
      if (code & 1) d += step >> 2;
      pred = Math.max(-32768, Math.min(32767, pred + (code & 8 ? -d : d)));
      idx = Math.max(0, Math.min(88, idx + idxT[code]));
      out.push(pred);
    }
  }
  const orig = parsePcm16Wav(wav).samples;
  let sig = 0;
  let noise = 0;
  for (let i = 0; i < n; i += 1) {
    sig += orig[i] ** 2;
    noise += (orig[i] - out[i]) ** 2;
  }
  const snr = 10 * Math.log10(sig / noise);
  assert.ok(snr > 20, `SNR ${snr.toFixed(1)} dB`);
});

test('AI rankings taxonomy: unique slugs, known groups, every seed tool defined', async () => {
  const { AI_GROUPS, AI_SUBCATEGORIES, SEED_TOOLS, slugifyToolName } = await import('../dist/ai-rankings/taxonomy.js');
  const groups = new Set(AI_GROUPS.map((g) => g.slug));
  const subs = AI_SUBCATEGORIES.map((s) => s.slug);
  assert.equal(new Set(subs).size, subs.length, 'duplicate subcategory slug');
  assert.ok(subs.length >= 100, `only ${subs.length} subcategories`);
  for (const s of AI_SUBCATEGORIES) {
    assert.ok(groups.has(s.group), `${s.slug}: unknown group ${s.group}`);
    assert.ok(s.arena || (s.seed && s.seed.length), `${s.slug}: needs arena or seed`);
    assert.ok(!(s.arena && s.seed), `${s.slug}: arena and seed are exclusive`);
    for (const t of s.seed || []) assert.ok(SEED_TOOLS[t], `${s.slug}: seed tool ${t} not defined`);
    assert.ok(s.slug.length <= 64);
  }
  for (const g of groups) assert.ok(AI_SUBCATEGORIES.some((s) => s.group === g), `group ${g} is empty`);
  for (const [slug, t] of Object.entries(SEED_TOOLS)) assert.match(t.url, /^https:\/\//, slug);
  assert.equal(slugifyToolName('GPT-Image-2.5 Sunburst (Medium)'), 'gpt-image-2-5-sunburst-medium');
});

test('AI rankings: LMArena rows map to ranked, de-duplicated entries; news tools are validated', async () => {
  const { mapArenaRows, validateDiscoveredTools, rankMovement } = await import('../dist/ai-rankings/ai-rankings.util.js');
  const rows = mapArenaRows({ rows: [
    { row: { model_name: 'Veo 4', organization: 'google', license: 'Proprietary', rating: 1501.2, vote_count: 900, rank: 3, leaderboard_publish_date: '2026-11-12' } },
    { row: { model_name: 'veo-4', organization: 'google', license: 'Proprietary', rating: 1490, vote_count: 10, rank: 4 } },
    { row: { model_name: 'Wan 3', organization: 'alibaba', license: 'Apache 2.0', rating: 1400, vote_count: 500, rank: 9 } },
    { row: { model_name: '', rating: 1 } },
  ] });
  assert.deepEqual(rows.map((r) => [r.slug, r.rank, r.isOpen]), [['veo-4', 1, false], ['wan-3', 2, true]]);
  assert.equal(rows[0].publishDate, '2026-11-12');
  assert.deepEqual(mapArenaRows(null), []);

  const tools = validateDiscoveredTools({ tools: [
    { newsId: '7', name: 'Nano Studio', vendor: 'Acme', subcategory: 'image-apps', url: 'https://nano.example', hasFree: true, descriptionUk: 'Генерує фото' },
    { newsId: '7', name: 'Nano Studio', subcategory: 'image-apps' },
    { newsId: '8', name: 'X', subcategory: 'image-apps' },
    { newsId: '7', name: 'Fake', subcategory: 'llm-overall' },
    { newsId: '999', name: 'Other', subcategory: 'audio-music' },
    { newsId: 7, name: 'Tune', subcategory: 'audio-music', url: 'javascript:alert(1)' },
  ] }, new Set(['image-apps', 'audio-music']), new Set(['7', '8']));
  assert.deepEqual(tools.map((t) => [t.slug, t.subcategory, t.url]), [['nano-studio', 'image-apps', 'https://nano.example'], ['tune', 'audio-music', null]]);
  assert.equal(rankMovement(2, 5), 3);
  assert.equal(rankMovement(2, null), null);
});

// ---- v2.2: objectivity layer ----
import {
  normalizeInsight,
  normalizePredictions,
  normalizeTopic,
  parseResearchMode,
  storyMemoryTerms,
} from '../dist/ingest/gemini-editor.service.js';
import { analyzeCoverage, lensOf, profileForUrl } from '../dist/news/source-profiles.js';
import { predictionAccuracy, normalizeExplainer } from '../dist/news/topics.service.js';
import { readerLensProfile } from '../dist/news/objectivity.controller.js';

test('GEMINI_RESEARCH accepts true/strict/all/important and defaults to off', () => {
  assert.equal(parseResearchMode('true'), 'all');
  assert.equal(parseResearchMode('strict'), 'all');
  assert.equal(parseResearchMode('important'), 'important');
  assert.equal(parseResearchMode('false'), 'off');
  assert.equal(parseResearchMode(undefined), 'off');
});

test('normalizeInsight keeps valid entries, drops broken ones and never throws', () => {
  const insight = normalizeInsight({
    tldr: 'NBU kept the key rate at 15.5%.',
    key_points: ['Rate unchanged', '', 42],
    claims: [
      { claim: 'Inflation slowed to 9%', kind: 'fact', confidence: 'confirmed', confirmed_by: ['NBU', 'Reuters'], disputed_by: [] },
      { claim: 'Rate will fall in spring', kind: 'nonsense', confidence: '???' },
      { kind: 'fact' },
    ],
    timeline: [{ when: '2026-10-23', event: 'Previous decision' }, { when: '', event: 'no date' }],
    media_positions: [{ outlet: 'Ekonomichna Pravda', stance: 'Focus on loans', framing: '' }],
  });
  assert.equal(insight.tldr, 'NBU kept the key rate at 15.5%.');
  assert.deepEqual(insight.key_points, ['Rate unchanged']);
  assert.equal(insight.claims.length, 2);
  assert.equal(insight.claims[1].kind, 'official_claim');
  assert.equal(insight.claims[1].confidence, 'unverified');
  assert.equal(insight.timeline.length, 1);
  assert.equal(insight.media_positions.length, 1);
  assert.equal(normalizeInsight({ tldr: '' }), undefined);
  assert.equal(normalizeInsight('oops'), undefined);
});

test('topic keys are stable ASCII slugs and predictions need a statement and a real date', () => {
  assert.equal(normalizeTopic({ key: 'NBU Key Rate!!', title_en: 'NBU key rate' }).key, 'nbu-key-rate');
  assert.equal(normalizeTopic({ key: 'облікова', title_en: 'x' }), undefined);
  const preds = normalizePredictions([
    { statement_en: 'Parliament votes on the bill', due_by: '2026-12-01' },
    { statement_en: 'Launch', due_by: 'next week' },
    { statement_en: '', due_by: '2026-12-01' },
  ]);
  assert.equal(preds.length, 2);
  assert.equal(preds[0].due_by, '2026-12-01');
  assert.equal(preds[1].due_by, null);
});

test('source lenses and blindspot detection', () => {
  assert.equal(lensOf('pravda-ua'), 'ua_media');
  assert.equal(lensOf(null, 'https://www.bbc.co.uk/news/world-1'), 'intl_media');
  assert.equal(profileForUrl('https://blog.google/technology/ai/x')?.lens, 'official');
  assert.equal(analyzeCoverage([{ sourceSlug: 'openai-news' }]).blindspot.kind, 'single_source');
  assert.equal(analyzeCoverage([{ sourceSlug: 'openai-news' }, { sourceSlug: 'google-deepmind' }]).blindspot.kind, 'only_official');
  assert.equal(analyzeCoverage([{ sourceSlug: 'pravda-ua' }, { sourceSlug: 'suspilne-news' }]).blindspot.kind, 'only_ua');
  assert.equal(analyzeCoverage([{ sourceSlug: 'pravda-ua' }, { sourceSlug: 'bbc-world' }]).blindspot, null);
});

test('reader lens profile needs enough history and finds the dominant lens', () => {
  assert.equal(readerLensProfile({ 'pravda-ua': 2 }), null);
  const p = readerLensProfile({ 'pravda-ua': 8, 'suspilne-news': 6, 'bbc-world': 1, 'unknown-x': 50, 'openai-news': -3 });
  assert.equal(p.dominant, 'ua_media');
  assert.ok(p.share >= 0.9);
});

test('prediction accuracy counts partly as half and ignores unclear', () => {
  const s = predictionAccuracy({ came_true: 3, partly: 2, did_not_happen: 5, unclear: 4, pending: 7 });
  assert.equal(s.resolved, 10);
  assert.equal(s.accuracy, 0.4);
  assert.equal(predictionAccuracy({}).accuracy, null);
  assert.equal(normalizeExplainer({ essence: '' }), null);
});

test('story memory finds earlier coverage by shared entities', async () => {
  assert.ok(storyMemoryTerms('OpenAI releases GPT-6 for developers').length > 0);
  let sqlSeen = '';
  const db = {
    query: async (sql, params) => {
      sqlSeen = sql;
      assert.ok(Array.isArray(params[2]) && params[2].every((p) => p.startsWith('%')));
      return {
        rows: [
          { id: 1, original_title: 'OpenAI previews GPT-6 to partners', title_uk: null, summary_uk: 'Preview', original_summary: null, published_at: '2026-10-01T00:00:00Z', source_name: 'The Verge', topic: 'openai-model-releases' },
          { id: 2, original_title: 'Football results', title_uk: null, summary_uk: null, original_summary: null, published_at: '2026-10-02T00:00:00Z', source_name: 'BBC', topic: null },
        ],
      };
    },
  };
  const editor = new GeminiEditorService(db);
  const memory = await editor.findStoryMemory({ externalId: 'x', url: 'https://openai.com/x', originalTitle: 'OpenAI releases GPT-6 for developers', category: 'model', importance: 'unknown', freeAccess: 'unknown' });
  assert.ok(sqlSeen.includes('120 days'));
  assert.equal(memory.length, 1);
  assert.equal(memory[0].topic, 'openai-model-releases');
});

test('news visuals sanitizer keeps valid data, drops invented/invalid shapes, enforces limits', async () => {
  const { sanitizeVisuals } = await import('../dist/news/news-visuals.js');
  const out = sanitizeVisuals(
    [
      { type: 'bar', title: 'Виручка за кварталами', unit: '$ млрд', source: { name: 'Звіт компанії', url: 'http://insecure.example' }, items: [{ label: 'Q1', value: 4.2 }, { label: 'Q2', value: '5,1' }] },
      { type: 'bar', title: 'Одна точка', source: { name: 'X' }, items: [{ label: 'Q1', value: 1 }] },
      { type: 'line', title: 'Динаміка', source: { name: 'NBU' }, labels: ['a', 'b', 'c'], series: [{ name: 'USD', values: [1, null, 3] }] },
      { type: 'donut', title: 'Частки', source: { name: 'S' }, items: [{ label: 'A', value: -1 }, { label: 'B', value: 2 }] },
      { type: 'table', title: 'Порівняння', source: { name: 'S' }, columns: ['Модель', 'Ціна'], rows: [['A', '1'], ['B', '2'], ['bad']] },
      { type: 'nonsense', title: 'x', source: { name: 'S' } },
      { type: 'stat', title: 'Без джерела', items: [{ label: 'n', value: 5 }] },
    ],
    'researched',
  );
  assert.deepEqual(out.map((v) => v.type), ['bar', 'line', 'table']);
  assert.equal(out[0].items[1].value, 5.1);
  assert.equal(out[0].source.url, undefined, 'non-https source urls are dropped');
  assert.equal(out[2].rows.length, 2, 'malformed rows are dropped');
  const extracted = sanitizeVisuals([{ type: 'stat', title: 'Ключова цифра', items: [{ label: 'ВВП', value: 3.2, unit: '%', delta: 0.4 }] }], 'extracted');
  assert.equal(extracted[0].source.name, 'За даними статті');
});

test('image extraction finds figure captions, skips junk, upgrades to https; RSS media tags and Ukrainian dates parse', async () => {
  const { extractArticleImages, extractPageImages, normalizeImageUrl } = await import('../dist/news/image-extraction.js');
  const { parseFeedXml, parseFeedDate } = await import('../dist/news/company-feeds.service.js');
  const imgs = extractArticleImages(
    '<figure><img src="//cdn.example.com/a.jpg" width="900"><figcaption>Люди на площі під час святкування ювілею міста</figcaption></figure>' +
      '<img src="https://cdn.example.com/pixel.gif"><img src="https://cdn.example.com/logo.png"><img src="http://cdn.example.com/b.webp" alt="b.webp">',
    { baseUrl: 'https://news.example.com/x' },
  );
  assert.equal(imgs[0].url, 'https://cdn.example.com/a.jpg');
  assert.match(imgs[0].caption, /святкування/);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[1].caption, undefined, 'a file name is not a caption');
  assert.equal(normalizeImageUrl('https://127.0.0.1/a.jpg'), null);
  const page = extractPageImages('<meta property="og:image" content="/img/hero.jpg"><meta property="og:image:alt" content="Президент виступає перед журналістами у Києві">', 'https://news.example.com/a/1');
  assert.equal(page[0].url, 'https://news.example.com/img/hero.jpg');

  const feed = { slug: 'demo', name: 'Demo', domain: 'example.com', url: 'https://example.com/rss' };
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>t</title>
    <item><title>Hello world story</title><link>https://example.com/a</link><pubDate>Mon, 16 Nov 2026 09:30:18 +0100</pubDate>
    <description>text</description><media:content url="https://example.com/p.jpg" medium="image"><media:description>Підпис до світлини зі стрічки</media:description></media:content></item></channel></rss>`;
  const [item] = parseFeedXml(xml, feed);
  assert.equal(item.image_url, 'https://example.com/p.jpg');
  assert.match(item.image_caption, /Підпис/);
  assert.equal(new Date(parseFeedDate("13 Листопад 2026, П'Ятниця  17:02")).toISOString(), '2026-11-13T15:02:00.000Z');
});

test('open-data adapters turn API payloads into articles with built-in charts', async () => {
  const A = await import('../dist/news/api-adapters.js');
  const feed = { slug: 'f', name: 'F', domain: 'ec.europa.eu', allowedDomains: ['ec.europa.eu', 'bank.gov.ua'], url: 'https://ec.europa.eu/x', category: 'economy' };
  const now = Date.parse('2026-11-16T12:00:00Z');
  const eu = A.buildEurostatArticle(
    feed,
    A.EUROSTAT_SPECS[0],
    { dimension: { time: { category: { index: { '2026-08': 0, '2026-09': 1, '2026-10': 2 } } } }, value: { 0: 2.1, 1: 2.2, 2: 2.4 } },
    now,
  );
  assert.match(eu.original_title, /2\.4%/);
  assert.equal(eu.prebuilt_visuals.length, 2);
  const nbu = A.buildNbuArticle(feed, { usd: [{ rate: 41.5, exchangedate: '16.11.2026' }, { rate: 41.3, exchangedate: '13.11.2026' }] }, now);
  assert.match(nbu.original_title, /USD 41,50 \(\+0,20\)/);
  const kev = A.parseCisaKev(
    { ...feed, allowedDomains: ['nvd.nist.gov'], domain: 'nvd.nist.gov' },
    { vulnerabilities: [{ cveID: 'CVE-2026-1', vendorProject: 'V', product: 'P', vulnerabilityName: 'N', dateAdded: '2026-11-15', shortDescription: 'd', dueDate: '2026-12-01' }] },
    now,
  );
  assert.equal(kev.length, 1);
  assert.equal(kev[0].category, 'cybersecurity');
  assert.equal(A.reconstructAbstract({ Hello: [0], world: [1] }), 'Hello world');
});

// ---- AI usage statistics (llm_usage_daily) ----
test('LLM stats: router records ok/429/skips, report flags limits to tune', async () => {
  const { pendingLlmStats, resetLlmStatsForTests, buildLlmReport, formatLlmReportText } = await import('../dist/common/llm-stats.js');
  resetLlmRouterForTests();
  resetLlmStatsForTests();
  const saved = { groq: process.env.groq_api_key, or: process.env.openrouter_api_key, gem: process.env.GEMINI_API_KEY };
  process.env.groq_api_key = 'test-groq';
  process.env.openrouter_api_key = 'test-or';
  delete process.env.GEMINI_API_KEY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('groq.com')) return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 42 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await generateWithRouter({ task: 'translate', prompt: 'hello', maxTokens: 100 });
    await generateWithRouter({ task: 'translate', prompt: 'again', maxTokens: 100 }); // groq cooling down -> skipped_cooldown
    const rows = pendingLlmStats();
    const find = (provider, outcome) => rows.find((r) => r.provider === provider && r.outcome === outcome);
    assert.equal(find('groq', 'rate_limited')?.count, 1);
    assert.ok(find('groq', 'skipped_cooldown')?.count >= 1);
    assert.equal(find('openrouter', 'ok')?.count, 2);
    assert.equal(find('openrouter', 'ok')?.tokens, 84, 'real token usage from the provider is recorded');
  } finally {
    globalThis.fetch = realFetch;
    if (saved.groq === undefined) delete process.env.groq_api_key; else process.env.groq_api_key = saved.groq;
    if (saved.or === undefined) delete process.env.openrouter_api_key; else process.env.openrouter_api_key = saved.or;
    if (saved.gem !== undefined) process.env.GEMINI_API_KEY = saved.gem;
    resetLlmRouterForTests();
  }

  const row = (o) => ({ day: '2026-11-15', provider: 'groq', model: 'm', task: 'translate', tokens: 0, latencyMs: 0, count: 1, ...o });
  const report = buildLlmReport(
    [row({ outcome: 'ok', count: 95 }), row({ outcome: 'rate_limited', count: 5 }), row({ outcome: 'skipped_daily', count: 3 }), row({ provider: 'router', model: '-', outcome: 'exhausted', count: 2 })],
    [{ provider: 'groq', model: 'm', rpd: 100, rpm: 30 }],
    7,
  );
  assert.equal(report.models[0].requests, 100);
  assert.equal(report.models[0].peakDayUsagePct, 100);
  assert.equal(report.allProvidersExhausted.translate, 2);
  assert.ok(report.hints.some((h) => /429/.test(h)) && report.hints.some((h) => /майже вичерпується/.test(h)));
  assert.match(formatLlmReportText(report), /groq\/m: запитів 100/);
  resetLlmStatsForTests();
});


// ---- Extended media: flux-2-klein-9b, 4/day caricature limit, Pexels scoring, event video timecodes, 20-type visual catalog ----
test('Workers AI defaults to flux-2-klein-9b with multipart FormData and CaricatureService caps dailyMax at 4', async () => {
  const { DEFAULT_WORKERS_IMAGE_MODEL, generateImageWithWorkersAi, isMultipartWorkersImageModel } = await import('../dist/common/workers-ai.js');
  const { CaricatureService } = await import('../dist/news/caricature.service.js');

  assert.equal(DEFAULT_WORKERS_IMAGE_MODEL, '@cf/black-forest-labs/flux-2-klein-9b');
  assert.equal(isMultipartWorkersImageModel('@cf/black-forest-labs/flux-2-klein-9b'), true);
  assert.equal(isMultipartWorkersImageModel('@cf/leonardo/lucid-origin'), false);

  const saved = {
    acc: process.env.cloudflare_account_id,
    tok: process.env.cloudflare_api_token,
    model: process.env.cloudflare_image_model,
    max: process.env.CARICATURE_DAILY_MAX,
  };
  process.env.cloudflare_account_id = '0123456789abcdef0123456789abcdef';
  process.env.cloudflare_api_token = 'cf-test-token';
  delete process.env.cloudflare_image_model;
  delete process.env.CARICATURE_DAILY_MAX;

  try {
    let seenBody = null;
    let seenContentType = '';
    const out = await generateImageWithWorkersAi('Exaggerated robot rocket test', {
      fetchFn: async (_url, init) => {
        seenBody = init?.body;
        seenContentType = (init?.headers)?.['Content-Type'] || '';
        return new Response(JSON.stringify({ result: { image: Buffer.from('fake-img-bytes').toString('base64') } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.ok(seenBody instanceof FormData, 'flux-2-klein-9b must send multipart FormData');
    assert.equal(seenContentType, '', 'must not hardcode JSON Content-Type for FormData');
    assert.equal(seenBody.get('width'), '768');
    assert.equal(out.model, '@cf/black-forest-labs/flux-2-klein-9b');

    const svc = new CaricatureService();
    assert.equal(svc.diagnostics().dailyMax, 4);
  } finally {
    if (saved.acc === undefined) delete process.env.cloudflare_account_id; else process.env.cloudflare_account_id = saved.acc;
    if (saved.tok === undefined) delete process.env.cloudflare_api_token; else process.env.cloudflare_api_token = saved.tok;
    if (saved.model !== undefined) process.env.cloudflare_image_model = saved.model;
    if (saved.max !== undefined) process.env.CARICATURE_DAILY_MAX = saved.max;
  }
});

test('Pexels scorer filters cluttered/duplicate images, prefers dark backgrounds, and formats credits', async () => {
  const { hexLuminance, pickBestPexelsPhoto } = await import('../dist/common/pexels.js');
  assert.ok((hexLuminance('#0B0F19') ?? 255) < 30);
  const candidates = [
    {
      id: 1, url: 'https://images.pexels.com/photos/1/a.jpg', thumbUrl: 'https://images.pexels.com/photos/1/t.jpg',
      photoPageUrl: 'https://www.pexels.com/photo/1', photographer: 'Alice', photographerUrl: 'https://www.pexels.com/@alice',
      alt: 'Empty whiteboard mockup template with quote text', width: 1600, height: 900, avgColor: '#ffffff',
    },
    {
      id: 2, url: 'https://images.pexels.com/photos/2/b.jpg', thumbUrl: 'https://images.pexels.com/photos/2/t.jpg',
      photoPageUrl: 'https://www.pexels.com/photo/2', photographer: 'Bob', photographerUrl: 'https://www.pexels.com/@bob',
      alt: 'Rocket launch smoke pad at night', width: 1920, height: 1080, avgColor: '#121826',
    },
    {
      id: 3, url: 'https://images.pexels.com/photos/3/c.jpg', thumbUrl: 'https://images.pexels.com/photos/3/t.jpg',
      photoPageUrl: 'https://www.pexels.com/photo/3', photographer: 'Carol', photographerUrl: 'https://www.pexels.com/@carol',
      alt: 'Bright rocket toy on white desk', width: 1400, height: 1000, avgColor: '#f5f5f5',
    },
  ];
  const used = new Set(['https://images.pexels.com/photos/3/c.jpg']);
  const picked = pickBestPexelsPhoto(candidates, { query: 'rocket launch night', usedUrls: used, preferDark: true });
  assert.equal(picked?.id, 2);
  assert.equal(picked?.credit, 'Bob / Pexels');
});

test('Event video verification and timecodes extract ?t= links and prioritize key-moment chapters', async () => {
  const { extractUrlTimecodeSec } = await import('../dist/common/video-timecodes.js');
  const { attachUrlTimecodeToVideoFigure, selectKeyVideoTimecodes, verifyYoutubeVideoMatchesEvent } = await import('../dist/news/event-media.js');

  assert.equal(extractUrlTimecodeSec('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m5s'), 125);
  assert.equal(extractUrlTimecodeSec('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90'), 90);

  assert.equal(
    verifyYoutubeVideoMatchesEvent(
      { title: 'ULA Vulcan Centaur launch anomaly during Kuiper mission', description: 'Live stream coverage' },
      ['vulcan', 'ula', 'kuiper'],
    ),
    true,
  );
  assert.equal(
    verifyYoutubeVideoMatchesEvent(
      { title: 'Popular SpaceX rocket simulation', description: 'Unrelated clip' },
      ['ula', 'rocket'],
    ),
    false,
    'must not match substring ula inside simulation',
  );
  assert.equal(
    verifyYoutubeVideoMatchesEvent(
      { title: 'Top 10 SpaceX rockets compilation', description: 'Unrelated clip' },
      ['vulcan', 'ula', 'kuiper'],
    ),
    false,
  );

  const tcs = selectKeyVideoTimecodes('abc123def45', [
    { timestampSec: 0, timestampLabel: '00:00', title: 'Intro' },
    { timestampSec: 610, timestampLabel: '10:10', title: 'Booster anomaly and loss of payload' },
  ]);
  assert.equal(tcs[0].url, 'https://www.youtube.com/watch?v=abc123def45&t=0s'.replace('&t=0s', ''));
  assert.equal(tcs[1].url, 'https://www.youtube.com/watch?v=abc123def45&t=610s');

  const fig = attachUrlTimecodeToVideoFigure(
    { id: 'f1', kind: 'video', url: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg', credit: 'YT', link: 'https://www.youtube.com/watch?v=abc123def45', match: [], position: 0.2, origin: 'embed' },
    'https://www.youtube.com/watch?v=abc123def45&t=45s',
    '00:00 Start\n00:45 Liftoff\n02:10 Booster anomaly',
  );
  assert.equal(fig.verified, true);
  assert.ok(fig.timecodes?.some((x) => x.sec === 45 && x.url.includes('t=45s')));
  assert.ok(fig.timecodes?.some((x) => x.sec === 130 && x.title === 'Booster anomaly'));
});

test('Extended visual catalog validates all 9 new animated visual types and drops invalid payloads', async () => {
  const { sanitizeVisuals } = await import('../dist/news/news-visuals.js');
  const valid = sanitizeVisuals(
    [
      { type: 'step_flow', title: 'Перебіг події', source: { name: 'ULA' }, steps: [{ label: 'Старт', sub: 'T+0:00' }, { label: 'Аномалія', sub: 'T+10 хв', tone: 'alert' }, { label: 'Втрата', tone: 'alert' }] },
      { type: 'impact_bars', title: 'Оцінка впливу', unit: '%', source: { name: 'Ринок' }, items: [{ label: 'Amazon', value: -2.1 }, { label: 'Starlink', value: 1.3 }] },
      { type: 'scenarios', title: 'Ризики та сценарії', source: { name: 'Аналіз' }, scenarios: [{ name: 'Базовий', probability: 60, detail: 'Затримка 3-6 міс', tone: 'neutral' }, { name: 'Негативний', probability: 25, detail: 'Повторні збої', tone: 'negative' }] },
      { type: 'network_graph', title: 'Звʼязки та учасники', source: { name: 'Огляд' }, center: { label: 'Аварія Vulcan' }, nodes: [{ label: 'Amazon', role: 'Kuiper', tone: 'warning' }, { label: 'ULA', role: 'носій' }, { label: 'Starlink', role: 'конкурент', tone: 'success' }] },
      { type: 'market_chart', title: 'Ринкова реакція', unit: '%', source: { name: 'Yahoo Finance' }, labels: ['Пн', 'Вт', 'Ср'], series: [{ name: 'Amazon', values: [0, -1.4, -2.1] }, { name: 'Starlink', values: [0, 0.8, 1.3] }] },
      { type: 'pros_cons', title: 'Аргументи сторін', source: { name: 'Експерти' }, pros: ['Швидший вихід на орбіту'], cons: ['Вищі ризики перших запусків'] },
    ],
    'extracted',
  );
  assert.equal(valid.length, 6);
  assert.deepEqual(valid.map((v) => v.type), ['step_flow', 'impact_bars', 'scenarios', 'network_graph', 'market_chart', 'pros_cons']);

  const extra = sanitizeVisuals(
    [
      { type: 'heatmap', title: 'Матриця ризиків', source: { name: 'S' }, columns: ['Q1', 'Q2'], rowLabels: ['Шанс', 'Вплив'], matrix: [[10, 40], [80, 90]] },
      { type: 'funnel', title: 'Воронка запусків', source: { name: 'S' }, items: [{ label: 'План', value: 100 }, { label: 'Підготовка', value: 60 }, { label: 'Успіх', value: 40 }] },
      { type: 'split_ratio', title: 'Частка орбіти', source: { name: 'S' }, items: [{ label: 'Starlink', value: 75 }, { label: 'Інші', value: 25 }] },
      { type: 'step_flow', title: 'Замало кроків', source: { name: 'S' }, steps: [{ label: '1' }, { label: '2' }] },
      { type: 'scenarios', title: 'Погана ймовірність', source: { name: 'S' }, scenarios: [{ name: 'A', probability: 150, detail: 'x' }, { name: 'B', probability: 20, detail: 'y' }] },
      { type: 'heatmap', title: 'Крива матриця', source: { name: 'S' }, columns: ['A', 'B'], rowLabels: ['R1', 'R2'], matrix: [[1], [2, 3]] },
    ],
    'extracted',
  );
  assert.deepEqual(extra.map((v) => v.type), ['heatmap', 'funnel', 'split_ratio']);

  const emptyTruncatedLine = sanitizeVisuals(
    [{ type: 'line', title: 'Null slice', source: { name: 'S' }, labels: ['a', 'b'], series: [{ name: 'X', values: [null, null, 100] }] }],
    'extracted',
  );
  assert.equal(emptyTruncatedLine.length, 0);
});

test('SSRF redirect guard blocks private redirect targets, robots private DNS, and extractEmbeds keeps startSec', async () => {
  const { checkRobotsTxtPermission, clearRobotsCacheForTests, fetchPublicUrl } = await import('../dist/common/source-compliance.js');
  const { extractEmbeds } = await import('../dist/news/article-resources.js');

  clearRobotsCacheForTests();
  let robotsFetched = false;
  const robotsBlocked = await checkRobotsTxtPermission('https://internal-alias.example.com/article', {
    lookupFn: async () => [{ address: '127.0.0.1' }],
    fetchFn: async () => {
      robotsFetched = true;
      return new Response('User-agent: *\nAllow: /', { status: 200 });
    },
  });
  assert.equal(robotsBlocked.allowed, false);
  assert.equal(robotsFetched, false, 'must not send robots.txt request to host resolving to 127.0.0.1');

  clearRobotsCacheForTests();
  let robotsRedirectedToPrivate = false;
  const robotsRedirectBlocked = await checkRobotsTxtPermission('https://public-redirect.example.com/article', {
    lookupFn: async (h) => (h === 'public-redirect.example.com' ? [{ address: '93.184.216.34' }] : [{ address: '127.0.0.1' }]),
    fetchFn: async (u) => {
      if (String(u).includes('127.0.0.1') || String(u).includes('internal.example.com')) {
        robotsRedirectedToPrivate = true;
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      return new Response(null, { status: 302, headers: { location: 'https://internal.example.com/robots.txt' } });
    },
  });
  assert.equal(robotsRedirectBlocked.allowed, false);
  assert.equal(robotsRedirectedToPrivate, false, 'must block robots.txt redirect to private IP');

  const blocked = await fetchPublicUrl('https://public.example.com/article', {
    lookupFn: async () => [{ address: '93.184.216.34' }],
    fetchFn: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } }),
  });
  assert.equal(blocked, null);

  const embeds = extractEmbeds('<article><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=125"></iframe></article>');
  assert.equal(embeds[0]?.videoId, 'dQw4w9WgXcQ');
  assert.equal(embeds[0]?.startSec, 125);
});

test('CaricatureService holds one PoolClient for advisory lock, fails closed on lock error, and discards client on unlock failure', async () => {
  const { CaricatureService } = await import('../dist/news/caricature.service.js');
  const saved = { pol: process.env.POLLINATIONS_ENABLED, gem: process.env.GEMINI_API_KEY, max: process.env.CARICATURE_DAILY_MAX };
  process.env.POLLINATIONS_ENABLED = 'true';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.CARICATURE_DAILY_MAX = '99';

  try {
    const clientQueries = [];
    let releasedArg;
    const mockClient = {
      query: async (sql) => {
        clientQueries.push(sql);
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
        return { rows: [] };
      },
      release: (arg) => {
        releasedArg = arg;
      },
    };
    const mockDb = {
      connect: async () => mockClient,
      query: async (sql) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ n: 4 }] };
        return { rows: [] };
      },
    };
    const svc = new CaricatureService(mockDb);
    assert.equal(svc.diagnostics().dailyMax, 4, 'CARICATURE_DAILY_MAX=99 must still clamp to 4');
    const out = await svc.generateBatch(2);
    assert.deepEqual(out, { generated: 0, skipped: 0 });
    assert.ok(clientQueries.some((q) => q.includes('pg_try_advisory_lock')));
    assert.ok(clientQueries.some((q) => q.includes('pg_advisory_unlock')));
    assert.ok(releasedArg instanceof Error, 'failed unlock must pass Error to client.release(err) to destroy connection');

    // Lock error must fail closed (not proceed)
    let queriedUsageAfterLockFail = false;
    const failLockSvc = new CaricatureService({
      connect: async () => ({
        query: async () => { throw new Error('lock unavailable'); },
        release: () => undefined,
      }),
      query: async () => {
        queriedUsageAfterLockFail = true;
        return { rows: [{ n: 0 }] };
      },
    });
    const failRes = await failLockSvc.generateBatch(2);
    assert.deepEqual(failRes, { generated: 0, skipped: 0 });
    assert.equal(queriedUsageAfterLockFail, false);
  } finally {
    if (saved.pol === undefined) delete process.env.POLLINATIONS_ENABLED; else process.env.POLLINATIONS_ENABLED = saved.pol;
    if (saved.gem === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.gem;
    if (saved.max === undefined) delete process.env.CARICATURE_DAILY_MAX; else process.env.CARICATURE_DAILY_MAX = saved.max;
  }
});
