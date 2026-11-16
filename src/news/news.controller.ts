import { Controller, Get, Optional, Param, ParseIntPipe, Patch, Post, Query, UseGuards, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CATEGORIES } from '../ingest/ingest.dto';
import { CompanyFeedsService, isPublishedWithinHours, maxFeedArticles } from './company-feeds.service';
import { EXPERT_DIRECTORY } from './expert-directory';
import { ExpertOpinionsService } from './expert-opinions.service';
import { ClusterableArticle, ClusterSource, NewsClusteringService } from './news-clustering.service';
import { NewsMemesService } from './news-memes.service';
import { NEWS_AUDIO_STYLES, NEWS_DEPTHS, NewsTtsService } from './news-tts.service';
import { SourceDiscoveryService } from './source-discovery.service';
import { analyzeCoverage, localizeProfile, resolveProfile } from './source-profiles';
const ENGLISH_FIELDS_SQL = `
  COALESCE(CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en'
    THEN NULLIF(n.ai_metadata->'article'->>'title', '') END,
    NULLIF(n.ai_metadata->'article'->>'title_en', ''), tr.title) AS title_en,
  COALESCE(CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en'
    THEN NULLIF(n.ai_metadata->'article'->>'summary', '') END,
    NULLIF(n.ai_metadata->'article'->>'summary_en', ''), tr.summary) AS summary_en,
  COALESCE(CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en'
    THEN NULLIF(n.ai_metadata->'article'->>'importance_reason', '') END,
    NULLIF(n.ai_metadata->'article'->>'why_it_matters_en', ''), tr.why_it_matters) AS why_it_matters_en`;

const ENGLISH_TRANSLATION_JOIN = `LEFT JOIN news_translations tr ON tr.news_id = n.id AND tr.lang = 'en'`;

@Controller('news')
export class NewsController {
  private readonly clustering: NewsClusteringService;

  constructor(
    private readonly db: DatabaseService,
    private readonly companyFeeds: CompanyFeedsService,
    @Optional() private readonly newsTts?: NewsTtsService,
    @Optional() private readonly expertOpinions?: ExpertOpinionsService,
    @Optional() private readonly newsMemes?: NewsMemesService,
    @Optional() clustering?: NewsClusteringService,
    @Optional() private readonly discovery?: SourceDiscoveryService,
  ) {
    this.clustering = clustering ?? new NewsClusteringService();
  }

  @Get('test-notification')
  testNotification() {
    return {
      title: 'Anthropic news test',
      message: 'Your app received this test notification from NestJS.',
    };
  }

  @Get()
  async list(
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('category') category?: string,
    @Query('sources') sourcesRaw?: string,
    @Query('important') important?: string,
    @Query('topics') topicsRaw?: string,
    @Query('depth') depthRaw?: string,
    @Query('sort') sortRaw?: string,
    @Query('maxAgeHours') maxAgeHoursRaw?: string,
    @Query('lang') langRaw?: string,
    /** Internal use (FeedController): return up to this many ranked items instead of one page. */
    poolSize?: number,
  ) {
    const lang: 'uk' | 'en' | null = langRaw === 'en' ? 'en' : langRaw === 'uk' ? 'uk' : null;
    if (langRaw !== undefined && langRaw !== 'en' && langRaw !== 'uk') {
      throw new BadRequestException('lang must be uk or en');
    }
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('limit: 1–50, offset: 0–10000');
    }
    if (category && !(CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException('Invalid category');
    }
    if (depthRaw !== undefined && !(NEWS_DEPTHS as readonly string[]).includes(depthRaw)) {
      throw new BadRequestException('Invalid depth');
    }
    const sortOrder: 'newest' | 'oldest' | 'relevance' =
      sortRaw === undefined ? 'newest' : (sortRaw as 'newest' | 'oldest' | 'relevance');
    if (sortRaw !== undefined && sortRaw !== 'newest' && sortRaw !== 'oldest' && sortRaw !== 'relevance') {
      throw new BadRequestException('Invalid sort');
    }
    let effectiveMaxAgeHours: number | null = null;
    if (maxAgeHoursRaw !== undefined) {
      const parsedAge = Number(maxAgeHoursRaw);
      if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 720) {
        throw new BadRequestException('maxAgeHours must be an integer between 1 and 720');
      }
      effectiveMaxAgeHours = parsedAge;
    } else if (important === 'true') {
      effectiveMaxAgeHours = 24;
    }

    const topics = typeof topicsRaw === 'string'
      ? topicsRaw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
      : [];
    if (topicsRaw !== undefined && (topics.length === 0 || topics.length > 20 || topics.some((t) => !/^[a-z0-9_-]{2,48}$/.test(t)))) {
      throw new BadRequestException('topics must contain 1–20 comma-separated topic tokens');
    }
    const sources = typeof sourcesRaw === 'string' ? sourcesRaw.split(',') : [];
    if (sourcesRaw !== undefined && (sources.length === 0 || sources.length > 20 ||
        sources.some(slug => !/^[a-z0-9][a-z0-9-]{2,79}$/.test(slug)))) {
      throw new BadRequestException('sources must contain 1–20 comma-separated source slugs');
    }
    if (important !== undefined && important !== 'true' && important !== 'false') {
      throw new BadRequestException('important must be true or false');
    }
    const onlyDatabase = !!category || important === 'true';
    const sqlLimit =
      onlyDatabase && topics.length === 0 && effectiveMaxAgeHours === null ? offset + limit + 50 : offset + limit + maxFeedArticles;
    const sqlOffset = 0;

    type NewsRow = {
      id: string;
      url: string;
      published_at: Date | string | null;
      category?: string;
      source_name?: string;
      source_slug?: string;
      title_uk?: string | null;
      original_title?: string;
      summary_uk?: string | null;
      original_summary?: string | null;
      important?: boolean;
      importance?: string;
      hydrogen_deep_analysis?: boolean;
      cluster_id?: string | null;
      cluster_sources?: ClusterSource[] | null;
      ai_generated?: boolean;
      [key: string]: unknown;
    };

    const queryParams = [
      category || null,
      sqlLimit,
      sqlOffset,
      sources.length ? sources : null,
      important === 'true',
      effectiveMaxAgeHours,
      sortOrder,
    ];

    const published = this.db
      .query<NewsRow>(
        `SELECT n.id,n.url,n.title_uk,n.summary_uk,n.original_title,n.original_summary,n.category,n.importance,
                COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
                n.free_access,n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,
                n.published_at,n.updated_at,s.name AS source_name,s.slug AS source_slug,
                s.unofficial AS source_is_unofficial,
                n.ai_metadata->>'model' AS ai_model,
                COALESCE((n.ai_metadata->>'hydrogen_polished')::boolean, false) AS hydrogen_polished,
                COALESCE((n.ai_metadata->>'hydrogen_deep_analysis')::boolean, false) AS hydrogen_deep_analysis,
                n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight,
                n.cluster_id,
                COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources,
                COALESCE(n.ai_generated, n.ai_metadata ? 'editorial_fingerprint') AS ai_generated,
                n.why_it_matters,
                ${ENGLISH_FIELDS_SQL},
                n.ai_metadata->>'source_type' AS source_type,
                n.ai_metadata->>'thumbnail_url' AS thumbnail_url,
                n.media->'hero' AS hero_image,
                jsonb_array_length(COALESCE(n.media->'visuals', '[]'::jsonb)) AS visuals_count,
                NULLIF(n.ai_metadata->'article'->>'content_warning', 'none') AS content_warning,
                n.ai_metadata->'article'->'headline_check' AS headline_check
         FROM news_items n JOIN sources s ON s.id=n.source_id
         ${ENGLISH_TRANSLATION_JOIN}
         WHERE n.status='published' AND ($1::text IS NULL OR n.category=$1)
           AND ($4::text[] IS NULL OR s.slug = ANY($4::text[]))
           AND (NOT $5::boolean OR n.ai_metadata->'article'->'important' = 'true'::jsonb)
           AND ($6::int IS NULL OR n.published_at >= now() - ($6::int * interval '1 hour'))
         ORDER BY
           CASE WHEN $7::text = 'oldest' THEN n.published_at END ASC NULLS LAST,
           n.published_at DESC NULLS LAST,
           n.id DESC
         LIMIT $2 OFFSET $3`,
        queryParams,
      )
      .catch(() =>
        // Pre-migration 013 fallback
        this.db.query<NewsRow>(
          `SELECT n.id,n.url,n.title_uk,n.summary_uk,n.original_title,n.category,n.importance,
                  COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
                  n.free_access,n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,
                  n.published_at,n.updated_at,s.name AS source_name,s.slug AS source_slug,
                  n.ai_metadata->>'model' AS ai_model,
                  COALESCE((n.ai_metadata->>'hydrogen_polished')::boolean, false) AS hydrogen_polished,
                  COALESCE((n.ai_metadata->>'hydrogen_deep_analysis')::boolean, false) AS hydrogen_deep_analysis,
                  n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight
           FROM news_items n JOIN sources s ON s.id=n.source_id
           WHERE n.status='published' AND ($1::text IS NULL OR n.category=$1)
             AND ($4::text[] IS NULL OR s.slug = ANY($4::text[]))
             AND (NOT $5::boolean OR n.ai_metadata->'article'->'important' = 'true'::jsonb)
             AND ($6::int IS NULL OR n.published_at >= now() - ($6::int * interval '1 hour'))
           ORDER BY
             CASE WHEN $7::text = 'oldest' THEN n.published_at END ASC NULLS LAST,
             n.published_at DESC NULLS LAST,
             n.id DESC
           LIMIT $2 OFFSET $3`,
          queryParams,
        ),
      );

    const localize = <T extends Record<string, unknown>>(item: T): T => {
      if (!lang) return item;
      const pick = (...keys: string[]) => {
        for (const k of keys) {
          const v = item[k];
          if (typeof v === 'string' && v.trim()) return v;
        }
        return null;
      };
      return {
        ...item,
        lang,
        display_title: lang === 'en' ? pick('title_en', 'original_title', 'title_uk') : pick('title_uk', 'original_title'),
        display_summary: lang === 'en' ? pick('summary_en', 'original_summary', 'summary_uk') : pick('summary_uk', 'original_summary'),
        display_why: lang === 'en' ? pick('why_it_matters_en', 'why_it_matters') : pick('why_it_matters'),
      };
    };

    const normalizeItemFreshness = <T extends Record<string, unknown>>(item: T): T => {
      const pub = item.published_at as Date | string | null | undefined;
      const fresh24h = isPublishedWithinHours(pub, 24);
      if (pub && !fresh24h && item.important) {
        return {
          ...item,
          important: false,
          ...(item.importance === 'high' ? { importance: 'medium' } : {}),
        };
      }
      return item;
    };

    const filterClusterAndSortItems = <T extends Record<string, unknown>>(rawItems: T[]) => {
      let filtered = rawItems.map(normalizeItemFreshness).map(localize);
      if (effectiveMaxAgeHours !== null) {
        filtered = filtered.filter((item) =>
          isPublishedWithinHours(item.published_at as Date | string | null | undefined, effectiveMaxAgeHours!),
        );
      }
      if (important === 'true') {
        filtered = filtered.filter((item) => Boolean(item.important));
      }

      const clustered = this.clustering.clusterItems(
        filtered as unknown as Array<NewsRow & { id: string; url: string; published_at?: Date | string | null }>,
      );

      let postCluster: Array<(typeof clustered)[number]> = clustered;
      const scores = new Map<(typeof clustered)[number], number>();
      if (topics.length > 0) {
        postCluster = postCluster.filter((item) => {
          const score = scoreTopicMatch(item, topics);
          if (score > 0) {
            scores.set(item, score);
            return true;
          }
          return false;
        });
      }
      return [...postCluster].sort((a, b) => {
        if (sortOrder === 'oldest') {
          return publishedTime((a.published_at as Date | string | null) ?? null) -
            publishedTime((b.published_at as Date | string | null) ?? null);
        }
        if (sortOrder === 'relevance') {
          if (topics.length > 0) {
            const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
            if (diff !== 0) return diff;
          }
          if (depthRaw === 'deep_technical') {
            const aDeep = (a.hydrogen_deep_analysis ? 2 : 0) + (a.important ? 1 : 0) + (a.source_count > 1 ? 1 : 0);
            const bDeep = (b.hydrogen_deep_analysis ? 2 : 0) + (b.important ? 1 : 0) + (b.source_count > 1 ? 1 : 0);
            if (bDeep !== aDeep) return bDeep - aDeep;
          }
        }
        return (
          publishedTime((b.published_at as Date | string | null) ?? null) -
          publishedTime((a.published_at as Date | string | null) ?? null)
        );
      });
    };

    if (onlyDatabase) {
      const rows = (await published).rows;
      const ranked = filterClusterAndSortItems(rows);
      if (category && ranked.length < 3 && offset === 0) {
        this.discovery?.triggerDiscoveryIfNeeded([category]);
      }
      const page = poolSize ? ranked.slice(0, poolSize) : ranked.slice(offset, offset + limit);
      return {
        items: page,
        limit,
        offset,
        hasMore: offset + page.length < ranked.length,
        sort: sortOrder,
        ...(depthRaw ? { depth: depthRaw } : {}),
      };
    }

    const result = await published;
    let feeds = await this.companyFeeds.list(sources, result.rows.length === 0);
    if (feeds.unavailable && result.rows.length && topics.length && !filterClusterAndSortItems(result.rows).length) {
      feeds = await this.companyFeeds.list(sources);
    }
    if (feeds.unavailable && !result.rows.length) {
      throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
    }

    const publishedUrls = new Set(result.rows.map(item => articleKey(item.url)));
    const feedMetaBySlug = new Map((this.companyFeeds.getActiveFeeds?.() ?? []).map(f => [f.slug, f]));
    const fresh = feeds.items.filter(item => !publishedUrls.has(articleKey(item.url)))
      .map(item => {
        const meta = feedMetaBySlug.get(item.source_slug);
        return {
          ...item,
          title_uk: null,
          summary_uk: null,
          important: false,
          importance: 'medium',
          ai_model: null,
          ai_generated: false,
          hydrogen_polished: false,
          hydrogen_deep_analysis: false,
          hydrogen_insight: null,
          source_is_unofficial: item.source_is_unofficial ?? Boolean(meta?.unofficial || meta?.alias),
        };
      });
    const combined = [...result.rows, ...fresh];
    const items = filterClusterAndSortItems(combined);
    const page = poolSize ? items.slice(0, poolSize) : items.slice(offset, offset + limit);
    return {
      items: page,
      limit,
      offset,
      hasMore: offset + page.length < items.length,
      sort: sortOrder,
      ...(depthRaw ? { depth: depthRaw } : {}),
    };
  }
  @Get('review')
  @UseGuards(IngestKeyGuard)
  async review(@Query('limit') limitRaw?: string) {
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Invalid limit');
    const result = await this.db.query(`
      SELECT n.*,s.name AS source_name FROM news_items n JOIN sources s ON s.id=n.source_id
      WHERE n.status='needs_review' ORDER BY n.updated_at DESC LIMIT $1`, [limit]);
    return { items: result.rows };
  }

  @Get('briefings/latest')
  async latestBriefings(
    @Query('limit') limitRaw?: string,
    @Query('depth') depth?: string,
    @Query('style') style?: string,
    @Query('includeAudio') includeAudioRaw?: string,
  ) {
    if (!this.newsTts) {
      throw new ServiceUnavailableException('TTS service is unavailable');
    }
    if (depth !== undefined && !(NEWS_DEPTHS as readonly string[]).includes(depth)) {
      throw new BadRequestException('Invalid depth');
    }
    if (style !== undefined && !(NEWS_AUDIO_STYLES as readonly string[]).includes(style)) {
      throw new BadRequestException('Invalid style');
    }
    const parsedLimit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('Invalid limit');
    }
    const includeAudio = includeAudioRaw === '1' || includeAudioRaw === 'true';
    return this.newsTts.listLatestBriefings({
      limit: parsedLimit,
      depth,
      style,
      includeAudio,
    });
  }

  @UseGuards(IngestKeyGuard)
  @Post('briefings/prewarm')
  async prewarmBriefings(
    @Query('limit') limitRaw?: string,
    @Query('depth') depth?: string,
    @Query('style') style?: string,
  ) {
    if (!this.newsTts) {
      throw new ServiceUnavailableException('TTS service is unavailable');
    }
    if (depth !== undefined && !(NEWS_DEPTHS as readonly string[]).includes(depth)) {
      throw new BadRequestException('Invalid depth');
    }
    if (style !== undefined && !(NEWS_AUDIO_STYLES as readonly string[]).includes(style)) {
      throw new BadRequestException('Invalid style');
    }
    const parsedLimit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('Invalid limit');
    }
    return this.newsTts.prewarmImportantBriefings({
      limit: parsedLimit,
      depth,
      style,
    });
  }

  @Get(':id/tts')
  async tts(
    @Param('id') id: string,
    @Query('source') source?: string,
    @Query('depth') depth?: string,
    @Query('style') style?: string,
  ) {
    if (!this.newsTts) {
      throw new ServiceUnavailableException('TTS service is unavailable');
    }
    if (depth !== undefined && !(NEWS_DEPTHS as readonly string[]).includes(depth)) {
      throw new BadRequestException('Invalid depth');
    }
    if (style !== undefined && !(NEWS_AUDIO_STYLES as readonly string[]).includes(style)) {
      throw new BadRequestException('Invalid style');
    }
    return this.newsTts.generateImportantNewsBriefing(id, source, { depth, style });
  }

  @Get('experts/directory')
  async expertsDirectory(@Query('domain') domain?: string) {
    const cleanDomain = domain?.trim().toLowerCase() || '';
    const alias = cleanDomain ? TOPIC_ALIAS_MAP[cleanDomain] : undefined;
    const targetCategories = alias ? alias.categories : cleanDomain ? [cleanDomain] : [];

    if (this.expertOpinions) {
      return this.expertOpinions.listDirectory(cleanDomain, targetCategories);
    }

    const filtered = cleanDomain
      ? EXPERT_DIRECTORY.filter(
          (expert) =>
            expert.primaryDomains.some((d) => targetCategories.includes(d)) ||
            expert.specializations.some((spec) => spec.toLowerCase().includes(cleanDomain)),
        )
      : EXPERT_DIRECTORY;

    const sorted = [...filtered].sort((a, b) => b.credibilityWeight - a.credibilityWeight);
    const items = sorted.map((expert) => ({
      slug: expert.slug,
      fullName: expert.fullName,
      handle: expert.handle,
      platform: expert.platform,
      roleUk: expert.roleUk,
      organization: expert.organization,
      primaryDomains: expert.primaryDomains,
      specializations: expert.specializations,
      profileUrl: expert.profileUrl,
      publicFeedUrl: expert.publicFeedUrl ?? null,
      knownAffiliationsUk: expert.knownAffiliationsUk,
      conflictDisclosureUk: expert.conflictDisclosureUk ?? null,
      credibilityWeight: expert.credibilityWeight,
      documentedPositionsCount: expert.documentedPositions.length,
      sourceMode: 'seed' as const,
      lastAiReviewedAt: null,
    }));

    return {
      domain: cleanDomain || 'all',
      total: items.length,
      items,
    };
  }

  @Post('experts/curate')
  @UseGuards(IngestKeyGuard)
  async curateExperts(@Query('category') category?: string) {
    if (!this.expertOpinions) {
      throw new ServiceUnavailableException('Expert opinions service is not available.');
    }
    return this.expertOpinions.curateExpertsWithGemini({ category });
  }

  @Get(':id/experts')
  async expertsForArticle(
    @Param('id') id: string,
    @Query('refresh') refreshRaw?: string,
    @Query('title') title?: string,
    @Query('category') category?: string,
    @Query('source') source?: string,
  ) {
    if (!this.expertOpinions) {
      throw new ServiceUnavailableException('Expert opinions service is unavailable');
    }
    const refresh = refreshRaw === 'true' || refreshRaw === '1';
    return this.expertOpinions.getOpinionsForNews(id, {
      refresh,
      title,
      category,
      source,
    });
  }

  @Get(':id/memes')
  async memesForArticle(
    @Param('id') id: string,
    @Query('refresh') refreshRaw?: string,
    @Query('q') query?: string,
    @Query('title') title?: string,
    @Query('category') category?: string,
    @Query('source') source?: string,
  ) {
    if (!this.newsMemes) {
      throw new ServiceUnavailableException('News memes service is unavailable');
    }
    const refresh = refreshRaw === 'true' || refreshRaw === '1';
    return this.newsMemes.getMemesForNews(id, {
      refresh,
      query,
      title,
      category,
      source,
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string, @Query('source') source?: string) {
    let resolved: Record<string, unknown> | null = null;
    if (/^rss-[a-f0-9]{24}$/.test(id)) {
      const result = await this.db
        .query<Record<string, unknown>>(
          `SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
                  n.category,n.importance,n.why_it_matters,n.free_access,
                  n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
                  n.ai_metadata,n.ai_metadata->'article' AS article,n.media AS media,
                  ${ENGLISH_FIELDS_SQL}, tr.body AS body_en,
                  s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial,
                  n.cluster_id,COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources,
                  COALESCE(n.ai_generated, n.ai_metadata ? 'editorial_fingerprint') AS ai_generated
           FROM news_items n JOIN sources s ON s.id=n.source_id
           ${ENGLISH_TRANSLATION_JOIN}
           WHERE n.external_id=$1 AND n.status='published' LIMIT 1`,
          [id],
        )
        .catch(() =>
          this.db.query<Record<string, unknown>>(
            `SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
                    n.category,n.importance,n.why_it_matters,n.free_access,
                    n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
                    n.ai_metadata,n.ai_metadata->'article' AS article,n.media AS media,
                    s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial
             FROM news_items n JOIN sources s ON s.id=n.source_id
             WHERE n.external_id=$1 AND n.status='published' LIMIT 1`,
            [id],
          ),
        );
      if (result.rows[0]) {
        resolved = result.rows[0];
      } else {
        const feeds = await this.companyFeeds.list(source ? [source] : []);
        const item = feeds.items.find(article => article.id === id);
        if (item) {
          const activeFeed = (this.companyFeeds.getActiveFeeds?.() ?? []).find(f => f.slug === item.source_slug);
          resolved = {
            ...item,
            category: item.category || 'other',
            importance: 'unknown',
            why_it_matters: null,
            free_access: 'unknown',
            article: null,
            ai_metadata: null,
            ai_generated: false,
            source_is_unofficial: item.source_is_unofficial ?? Boolean(activeFeed?.unofficial || activeFeed?.alias),
          };
        } else if (feeds.unavailable) {
          throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
        }
      }
    } else if (/^\d{1,18}$/.test(id)) {
      const { rows } = await this.db
        .query<Record<string, unknown>>(
          `SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
                  n.category,n.importance,n.why_it_matters,n.free_access,
                  n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
                  n.ai_metadata,n.ai_metadata->'article' AS article,n.media AS media,
                  ${ENGLISH_FIELDS_SQL}, tr.body AS body_en,
                  s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial,
                  n.cluster_id,COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources,
                  COALESCE(n.ai_generated, n.ai_metadata ? 'editorial_fingerprint') AS ai_generated
           FROM news_items n JOIN sources s ON s.id=n.source_id
           ${ENGLISH_TRANSLATION_JOIN}
           WHERE n.id=$1 AND n.status='published'`,
          [id],
        )
        .catch(() =>
          this.db.query<Record<string, unknown>>(
            `SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
                    n.category,n.importance,n.why_it_matters,n.free_access,
                    n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
                    n.ai_metadata,n.ai_metadata->'article' AS article,n.media AS media,
                    s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial
             FROM news_items n JOIN sources s ON s.id=n.source_id
             WHERE n.id=$1 AND n.status='published'`,
            [id],
          ),
        );
      if (rows[0]) resolved = rows[0];
    }
    if (!resolved) throw new NotFoundException('Article not found');

    const storedClusterSources = Array.isArray(resolved.cluster_sources)
      ? (resolved.cluster_sources as ClusterSource[])
      : [];
    if (storedClusterSources.length <= 1) {
      const [feeds, recentDb] = await Promise.all([
        this.companyFeeds.list([], false).catch(() => ({ items: [] as ClusterableArticle[] })),
        this.db
          .query<ClusterableArticle>(
            `SELECT n.id::text AS id, n.url, n.canonical_url AS "canonicalUrl",
                    n.original_title, n.title_uk, n.summary_uk, n.published_at,
                    s.name AS source_name, s.slug AS source_slug, s.unofficial AS source_is_unofficial,
                    n.cluster_id, COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources
             FROM news_items n JOIN sources s ON s.id = n.source_id
             WHERE n.status = 'published'
               AND COALESCE(n.published_at, n.created_at) >= now() - interval '48 hours'
             ORDER BY n.published_at DESC NULLS LAST
             LIMIT 150`,
          )
          .catch(() => ({ rows: [] as ClusterableArticle[] })),
      ]);
      const candidates = [
        ...(Array.isArray(recentDb?.rows) ? recentDb.rows : []),
        ...(Array.isArray(feeds?.items) ? feeds.items : []),
      ];
      const matched = this.clustering.findRelatedSourcesForArticle(
        resolved as { id: string; url: string },
        candidates,
      );
      return withObjectivity({
        ...resolved,
        cluster_id: (resolved.cluster_id as string | null) ?? matched.clusterId ?? null,
        cluster_sources: matched.clusterSources,
        source_count: matched.clusterSources.length,
      });
    }

    return withObjectivity({
      ...resolved,
      source_count: storedClusterSources.length,
    });
  }

  @Get(':id/related')
  async related(@Param('id') id: string, @Query('source') source?: string) {
    const { rows: targetRows } = await this.db.query<{
      id: string;
      category: string;
      source_slug: string;
    }>(`
      SELECT n.id::text, n.category, s.slug AS source_slug
      FROM news_items n JOIN sources s ON s.id = n.source_id
      WHERE (n.external_id = $1 OR n.id::text = $1) AND n.status = 'published'
      LIMIT 1
    `, [id]);

    const target = targetRows[0];
    const targetCategory = target?.category || null;
    const targetSource = target?.source_slug || source || null;

    const { rows } = await this.db.query(`
      SELECT n.id, n.url, n.title_uk, n.summary_uk, n.original_title, n.category, n.importance,
             ${ENGLISH_FIELDS_SQL},
             COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
             n.published_at, s.name AS source_name, s.slug AS source_slug
      FROM news_items n JOIN sources s ON s.id = n.source_id
      ${ENGLISH_TRANSLATION_JOIN}
      WHERE n.status = 'published'
        AND n.id::text <> COALESCE($1, '')
        AND n.external_id <> $2
        AND (
          ($3::text IS NOT NULL AND n.category = $3)
          OR ($4::text IS NOT NULL AND s.slug = $4)
        )
      ORDER BY
        (CASE WHEN s.slug = $4 THEN 0 ELSE 1 END),
        n.published_at DESC NULLS LAST,
        n.id DESC
      LIMIT 5
    `, [target?.id || null, id, targetCategory, targetSource]);

    return { items: rows };
  }

  @Patch(':id/publish')
  @UseGuards(IngestKeyGuard)
  async publish(@Param('id', ParseIntPipe) id: number) {
    const result = await this.db.query(`UPDATE news_items SET status='published',updated_at=now()
      WHERE id=$1 AND status='needs_review' RETURNING id,status`,[id]);
    if (!result.rowCount) throw new BadRequestException('Unknown id or not awaiting review');
    return result.rows[0];
  }

  @Patch(':id/reject')
  @UseGuards(IngestKeyGuard)
  async reject(@Param('id', ParseIntPipe) id: number) {
    const result = await this.db.query(`UPDATE news_items SET status='rejected',updated_at=now()
      WHERE id=$1 AND status IN ('needs_review','published') RETURNING id,status`,[id]);
    if (!result.rowCount) throw new BadRequestException('Unknown id or cannot reject');
    return result.rows[0];
  }
}

/** Source card of the publishing outlet and the blindspot analysis of who else covered the story. */
function withObjectivity(item: Record<string, unknown>): Record<string, unknown> {
  const clusterSources = Array.isArray(item.cluster_sources)
    ? (item.cluster_sources as Array<{ sourceSlug?: string; sourceName?: string; url?: string }>)
    : [];
  const coverageInput = clusterSources.length
    ? clusterSources.map((c) => ({ sourceSlug: c.sourceSlug, sourceName: c.sourceName, url: c.url }))
    : [{ sourceSlug: String(item.source_slug || ''), url: String(item.url || '') }];
  return {
    ...item,
    source_profile: localizeProfile(resolveProfile(String(item.source_slug || ''), String(item.url || '')), 'uk'),
    source_profile_en: localizeProfile(resolveProfile(String(item.source_slug || ''), String(item.url || '')), 'en'),
    coverage: analyzeCoverage(coverageInput, 'uk'),
    coverage_en: analyzeCoverage(coverageInput, 'en'),
  };
}

function articleKey(value: string): string {
  const url = URL.parse(value);
  return url ? `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}` : value;
}

function publishedTime(date: Date | string | null): number {
  return date ? new Date(date).getTime() : 0;
}

export const TOPIC_ALIAS_MAP: Record<string, { categories: string[]; keywords: string[] }> = {
  politics: { categories: ['politics', 'law'], keywords: ['politics', 'election', 'treaty', 'summit', 'diplomacy', 'world', 'політик', 'україн', 'міжнародн', 'безпек', 'вибор'] },
  politics_ukraine: { categories: ['politics', 'law', 'defense'], keywords: ['україн', 'політик', 'закон', 'податк', 'кордон', 'правда', 'суспільне', 'bbc', 'міжнародн', 'дипломат'] },
  ukraine_world_events: { categories: ['politics', 'defense'], keywords: ['україн', 'світ', 'саміт', 'дипломат', 'безпек', 'міжнародн', 'єс', 'нато'] },
  law: { categories: ['law', 'politics'], keywords: ['law', 'tax', 'border', 'passport', 'benefits', 'legislation', 'закон', 'податк', 'документ', 'кордон', 'соцвиплат', 'права'] },
  laws_rights_citizens: { categories: ['law', 'politics'], keywords: ['закон', 'податк', 'документ', 'кордон', 'соцвиплат', 'дія', 'права', 'пенсі'] },
  economy: { categories: ['economy', 'finance', 'business'], keywords: ['economy', 'gdp', 'budget', 'trade', 'inflation', 'економік', 'бюджет', 'інфляц', 'тариф'] },
  economy_finance: { categories: ['economy', 'finance', 'career', 'startups_fintech', 'business'], keywords: ['курс', 'валют', 'нбу', 'інфляц', 'депозит', 'кредит', 'нерухоміст', 'зарплат', 'робот', 'бізнес', 'фоп'] },
  finance: { categories: ['finance', 'economy', 'startups_fintech'], keywords: ['currency', 'exchange rate', 'inflation', 'deposit', 'mortgage', 'bond', 'real estate', 'курс', 'валют', 'інфляц', 'депозит', 'кредит', 'інвестиц', 'нерухоміст'] },
  personal_finance_rates: { categories: ['finance', 'economy'], keywords: ['курс', 'валют', 'долар', 'євро', 'нбу', 'інфляц', 'депозит', 'кредит', 'інвестиц', 'нерухоміст', 'овдп'] },
  career: { categories: ['career', 'economy', 'business'], keywords: ['career', 'salary', 'remote work', 'jobs', 'small business', 'професі', 'зарплат', 'віддален', 'ринок праці', 'малий бізнес', 'фоп'] },
  labor_market_business: { categories: ['career', 'business', 'economy'], keywords: ['професі', 'зарплат', 'віддален', 'ринок праці', 'малий бізнес', 'вакансі', 'фоп'] },
  health: { categories: ['health', 'psychology', 'science_space'], keywords: ['health', 'medicine', 'sleep', 'nutrition', 'longevity', 'fitness', 'медицин', 'довголітт', 'сон', 'харчуван', 'активніст', 'здоров'] },
  health_psychology: { categories: ['health', 'psychology'], keywords: ['сон', 'харчуван', 'здоров', 'медицин', 'стрес', 'вигоран', 'звичк', 'психолог', 'продуктивніст'] },
  medicine_longevity: { categories: ['health', 'science_space'], keywords: ['медицин', 'довголітт', 'сон', 'харчуван', 'фізичн', 'профілактик', 'клінічн', 'хвороб'] },
  psychology: { categories: ['psychology', 'health'], keywords: ['psychology', 'stress', 'burnout', 'habits', 'productivity', 'mindfulness', 'психолог', 'стрес', 'вигоран', 'звичк', 'навчання', 'продуктивн'] },
  psychology_productivity: { categories: ['psychology', 'career'], keywords: ['стрес', 'вигоран', 'звичк', 'психолог', 'продуктивн', 'навчання', 'ментальн'] },
  culture: { categories: ['culture', 'hardware_gaming'], keywords: ['culture', 'cinema', 'movie', 'series', 'music', 'festival', 'book', 'podcast', 'кіно', 'серіал', 'музик', 'прем\'єр', 'рейтинг', 'фестивал', 'книг', 'подкаст'] },
  culture_entertainment: { categories: ['culture', 'hardware_gaming'], keywords: ['кіно', 'серіал', 'музик', 'прем\'єр', 'фестивал', 'відеоігор', 'ігр', 'книг', 'подкаст', 'тренд'] },
  cinema_series_music: { categories: ['culture'], keywords: ['кіно', 'серіал', 'музик', 'фільм', 'прем\'єр', 'рейтинг', 'фестивал', 'netflix', 'cinema'] },
  games_pop_culture: { categories: ['culture', 'hardware_gaming'], keywords: ['ігр', 'відеоігор', 'книг', 'подкаст', 'тренд', 'eurogamer', 'gaming', 'game'] },
  discoveries_research: { categories: ['science_space', 'research', 'health'], keywords: ['відкритт', 'досліджен', 'біотехнолог', 'клімат', 'енергетик', 'медицин', 'наук', 'science'] },
  space_astronomy: { categories: ['science_space'], keywords: ['космос', 'космонавтик', 'nasa', 'spacex', 'затемнен', 'комет', 'магнітн', 'орбіт', 'телескоп'] },
  ai: { categories: ['model', 'api', 'coding', 'open_source', 'research'], keywords: ['ai', 'llm', 'gpt', 'claude', 'gemini', 'openai', 'anthropic', 'mistral', 'нейромереж'] },
  defense: { categories: ['defense'], keywords: ['defense', 'defence', 'drone', 'uav', 'brave1', 'military', 'дрон', 'оборон', 'зсу', 'бпла'] },
  defensetech: { categories: ['defense'], keywords: ['defense', 'defence', 'drone', 'uav', 'brave1', 'military', 'дрон', 'оборон', 'зсу'] },
  ukraine: { categories: ['politics', 'law', 'economy', 'defense', 'global_tech', 'education_grants', 'startups_fintech'], keywords: ['ukraine', 'ukrainian', 'pravda', 'suspilne', 'itc', 'dou', 'dev.ua', 'україн', 'київ', 'зсу'] },
  cybersecurity: { categories: ['cybersecurity'], keywords: ['cyber', 'security', 'cve', 'vulnerability', 'ransomware', 'malware', 'cloudflare', 'hacker', 'кібер', 'вразлив'] },
  security: { categories: ['cybersecurity', 'politics'], keywords: ['cyber', 'security', 'cve', 'vulnerability', 'malware', 'cloudflare', 'hacker', 'безпек'] },
  science: { categories: ['science_space', 'research'], keywords: ['science', 'nasa', 'space', 'quantum', 'biotech', 'nature', 'arstechnica', 'космос', 'наук', 'клімат', 'енергетик'] },
  space: { categories: ['science_space'], keywords: ['nasa', 'spacex', 'space', 'orbit', 'rocket', 'comet', 'eclipse', 'космос', 'орбіт', 'бурі'] },
  science_space: { categories: ['science_space', 'research'], keywords: ['nasa', 'space', 'science', 'quantum', 'biotech', 'nature', 'клімат', 'енергетик', 'космос'] },
  hardware: { categories: ['hardware_gaming'], keywords: ['gpu', 'cpu', 'nvidia', 'amd', 'intel', 'chip', 'hardware', 'tomshardware', 'процесор', 'відеокарт'] },
  gaming: { categories: ['hardware_gaming', 'culture'], keywords: ['gaming', 'game', 'eurogamer', 'playstation', 'xbox', 'nintendo', 'steam', 'геймінг', 'ігор', 'відеоігор'] },
  hardware_gaming: { categories: ['hardware_gaming', 'culture'], keywords: ['gpu', 'cpu', 'hardware', 'gaming', 'eurogamer', 'tomshardware'] },
  startups: { categories: ['startups_fintech', 'business', 'career'], keywords: ['startup', 'venture', 'seed', 'funding', 'ycombinator', 'techcrunch', 'стартап', 'інвестиц', 'малий бізнес'] },
  fintech: { categories: ['startups_fintech', 'finance', 'business'], keywords: ['fintech', 'payments', 'crypto', 'stripe', 'bank', 'фінтех', 'валют', 'банк'] },
  startups_fintech: { categories: ['startups_fintech', 'finance', 'career'], keywords: ['startup', 'fintech', 'venture', 'techcrunch', 'ycombinator', 'малий бізнес'] },
  education: { categories: ['education_grants', 'psychology'], keywords: ['education', 'grant', 'fellowship', 'hackathon', 'university', 'грант', 'освіт', 'хакатон', 'навчання'] },
  grants: { categories: ['education_grants'], keywords: ['grant', 'fellowship', 'hackathon', 'accelerator', 'грант', 'стипенд'] },
  education_grants: { categories: ['education_grants'], keywords: ['grant', 'education', 'hackathon', 'fellowship'] },
  global: { categories: ['politics', 'global_tech', 'economy'], keywords: ['global', 'world', 'tech', 'itc', 'dou', 'dev.ua', 'технологі', 'світ'] },
  global_tech: { categories: ['global_tech'], keywords: ['global', 'tech', 'itc', 'dou', 'dev.ua'] },
  climate_energy: { categories: ['climate_energy', 'science_space', 'economy', 'research'], keywords: ['climate', 'energy', 'solar', 'battery', 'nuclear', 'renewable', 'emission', 'клімат', 'енергетик', 'сонячн', 'батаре', 'атомн', 'відновлюван'] },
  robotics: { categories: ['robotics', 'research', 'global_tech', 'hardware_gaming'], keywords: ['robot', 'robotics', 'humanoid', 'boston dynamics', 'figure ai', 'робот', 'гуманоїд'] },
  crypto_web3: { categories: ['crypto_web3', 'finance', 'startups_fintech'], keywords: ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'stablecoin', 'біткоїн', 'крипт', 'блокчейн'] },
  smartphones_gadgets: { categories: ['hardware_gaming', 'global_tech'], keywords: ['iphone', 'android', 'pixel', 'galaxy', 'smartphone', 'wearable', 'смартфон', 'гаджет', 'годинник'] },
  ev_transport: { categories: ['mobility_ev', 'global_tech', 'business', 'science_space'], keywords: ['tesla', 'electric vehicle', 'ev', 'autonomous', 'self-driving', 'waymo', 'електромобіл', 'автопілот'] },
  biotech_medicine: { categories: ['biotech', 'health', 'research', 'science_space'], keywords: ['biotech', 'crispr', 'vaccine', 'clinical trial', 'fda', 'drug', 'біотех', 'вакцин', 'клінічн', 'ліки'] },
  ai_policy_safety: { categories: ['ai_policy', 'model', 'law', 'politics', 'research'], keywords: ['ai act', 'regulation', 'safety', 'alignment', 'copyright', 'регулюван', 'безпека ші', 'авторськ'] },
  ai_tools_productivity: { categories: ['model', 'api', 'coding', 'career'], keywords: ['assistant', 'copilot', 'agent', 'workflow', 'automation', 'prompt', 'асистент', 'агент', 'автоматизац'] },
  movies_streaming: { categories: ['culture'], keywords: ['netflix', 'hbo', 'disney', 'trailer', 'box office', 'streaming', 'фільм', 'серіал', 'трейлер', 'прокат'] },
  esports_gaming: { categories: ['hardware_gaming', 'culture'], keywords: ['esports', 'tournament', 'steam', 'playstation', 'xbox', 'nintendo', 'кіберспорт', 'турнір'] },
  media_social: { categories: ['media_social', 'culture'], keywords: ['tiktok', 'instagram', 'creator', 'influencer', 'соцмереж', 'блогер'] },
  sports: { categories: ['sports'], keywords: ['football', 'olympic', 'nba', 'f1', 'футбол', 'олімпі'] },
  travel_lifestyle: { categories: ['travel_lifestyle'], keywords: ['travel', 'airline', 'tourism', 'подорож', 'туризм', 'авіа'] },
  real_estate: { categories: ['real_estate', 'finance'], keywords: ['real estate', 'mortgage', 'housing', 'нерухомост', 'іпотек'] },
  ukraine_tech: { categories: ['global_tech', 'startups_fintech', 'defense', 'career'], keywords: ['dou', 'dev.ua', 'itc', 'ukrainian startup', 'brave1', 'дія', 'український стартап', 'айті'] },
};

const EXACT_BOUNDARY_TOKENS = new Set([
  'ai', 'ml', 'api', 'sdk', 'llm', 'gpt', 'gpu', 'cpu', 'cve', 'ev', '5g', '6g',
  'uk', 'eu', 'ua', 'us', 'bbc', 'nasa', 'nato', 'сон', 'зсу', 'бпла', 'єс',
  'нбу', 'фоп', 'дія', 'нато',
]);

function matchesTopicKeyword(text: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactOnly = EXACT_BOUNDARY_TOKENS.has(kw) || kw.length <= 2 || /[\s.-]/.test(kw);
  const pattern = exactOnly
    ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
    : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}\\p{L}*`, 'iu');
  return pattern.test(text);
}

export function scoreTopicMatch(item: Record<string, unknown>, topics: string[]): number {
  const category = String(item.category || '').toLowerCase();
  const sourceSlug = String(item.source_slug || '').toLowerCase();
  const sourceName = String(item.source_name || '').toLowerCase();
  const text = `${String(item.title_uk || '')} ${String(item.original_title || '')} ${String(item.summary_uk || '')} ${String(item.original_summary || '')} ${sourceName} ${sourceSlug}`.toLowerCase();

  let score = 0;
  for (const token of topics) {
    if (category === token) {
      score += 4;
      continue;
    }
    if (sourceSlug.includes(token) || sourceName.includes(token)) {
      score += 3;
    }
    const alias = TOPIC_ALIAS_MAP[token];
    if (alias) {
      if (alias.categories.includes(category)) {
        score += 3;
      }
      if (alias.keywords.some((kw) => matchesTopicKeyword(text, kw))) {
        score += 2;
      }
    } else if (matchesTopicKeyword(text, token)) {
      score += 2;
    }
  }
  return score;
}
