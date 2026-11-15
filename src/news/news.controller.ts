import { Controller, Get, Optional, Param, ParseIntPipe, Patch, Post, Query, UseGuards, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CATEGORIES } from '../ingest/ingest.dto';
import { CompanyFeedsService, isPublishedWithinHours, maxFeedArticles } from './company-feeds.service';
import { EXPERT_DIRECTORY } from './expert-directory';
import { ExpertOpinionsService } from './expert-opinions.service';
import { NEWS_AUDIO_STYLES, NEWS_DEPTHS, NewsTtsService } from './news-tts.service';
@Controller('news')
export class NewsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly companyFeeds: CompanyFeedsService,
    @Optional() private readonly newsTts?: NewsTtsService,
    @Optional() private readonly expertOpinions?: ExpertOpinionsService,
  ) {}

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
  ) {
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
      onlyDatabase && topics.length === 0 && effectiveMaxAgeHours === null ? limit : offset + limit + maxFeedArticles;
    const sqlOffset = onlyDatabase && topics.length === 0 && effectiveMaxAgeHours === null ? offset : 0;
    const published = this.db.query<{
      id: string;
      url: string;
      published_at: Date | string | null;
      category?: string;
      source_name?: string;
      source_slug?: string;
      title_uk?: string | null;
      original_title?: string;
      summary_uk?: string | null;
      important?: boolean;
      importance?: string;
      hydrogen_deep_analysis?: boolean;
    }>(`
      SELECT n.id,n.url,n.title_uk,n.summary_uk,n.original_title,n.category,n.importance,
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
    [
      category || null,
      sqlLimit,
      sqlOffset,
      sources.length ? sources : null,
      important === 'true',
      effectiveMaxAgeHours,
      sortOrder,
    ]);

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

    const filterAndSortItems = <T extends Record<string, unknown>>(rawItems: T[]): T[] => {
      let filtered = rawItems.map(normalizeItemFreshness);
      if (effectiveMaxAgeHours !== null) {
        filtered = filtered.filter((item) =>
          isPublishedWithinHours(item.published_at as Date | string | null | undefined, effectiveMaxAgeHours!),
        );
      }
      if (important === 'true') {
        filtered = filtered.filter((item) => Boolean(item.important));
      }
      const scores = new Map<T, number>();
      if (topics.length > 0) {
        filtered = filtered.filter((item) => {
          const score = scoreTopicMatch(item, topics);
          if (score > 0) {
            scores.set(item, score);
            return true;
          }
          return false;
        });
      }
      return [...filtered].sort((a, b) => {
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
            const aDeep = (a.hydrogen_deep_analysis ? 2 : 0) + (a.important ? 1 : 0);
            const bDeep = (b.hydrogen_deep_analysis ? 2 : 0) + (b.important ? 1 : 0);
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
      if (
        topics.length > 0 ||
        depthRaw === 'deep_technical' ||
        effectiveMaxAgeHours !== null ||
        sortOrder !== 'newest'
      ) {
        const ranked = filterAndSortItems(rows);
        const page = ranked.slice(offset, offset + limit);
        return {
          items: page,
          limit,
          offset,
          hasMore: offset + page.length < ranked.length,
          sort: sortOrder,
          ...(depthRaw ? { depth: depthRaw } : {}),
        };
      }
      return {
        items: rows.map(normalizeItemFreshness),
        limit,
        offset,
        hasMore: rows.length === limit,
        sort: sortOrder,
        ...(depthRaw ? { depth: depthRaw } : {}),
      };
    }

    const [result, feeds] = await Promise.all([published, this.companyFeeds.list(sources)]);
    if (feeds.unavailable && !result.rows.length) {
      throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
    }

    const publishedUrls = new Set(result.rows.map(item => articleKey(item.url)));
    const fresh = feeds.items.filter(item => !publishedUrls.has(articleKey(item.url)))
      .map(item => ({
        ...item,
        title_uk: null,
        summary_uk: null,
        important: false,
        importance: 'medium',
        ai_model: null,
        hydrogen_polished: false,
        hydrogen_deep_analysis: false,
        hydrogen_insight: null,
      }));
    const combined = [...result.rows, ...fresh];
    const items = filterAndSortItems(combined);
    const page = items.slice(offset, offset + limit);
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

  @Get(':id')
  async detail(@Param('id') id: string, @Query('source') source?: string) {
    if (/^rss-[a-f0-9]{24}$/.test(id)) {
      const result = await this.db.query(`
        SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
               n.category,n.importance,n.why_it_matters,n.free_access,
               n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
               n.ai_metadata,n.ai_metadata->'article' AS article,
               s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial
        FROM news_items n JOIN sources s ON s.id=n.source_id
        WHERE n.external_id=$1 AND n.status='published' LIMIT 1`, [id]);
      if (result.rows[0]) return result.rows[0];
      const feeds = await this.companyFeeds.list(source ? [source] : []);
      const item = feeds.items.find(article => article.id === id);
      if (item) {
        return {
          ...item,
          category: item.category || 'other',
          importance: 'unknown',
          why_it_matters: null,
          free_access: 'unknown',
          article: null,
          ai_metadata: null,
          source_is_unofficial: false,
        };
      }
      if (feeds.unavailable) throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
    } else if (/^\d{1,18}$/.test(id)) {
      const { rows } = await this.db.query(`
        SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
               n.category,n.importance,n.why_it_matters,n.free_access,
               n.credibility_tier,n.is_retracted,n.correction_note,n.corrected_at,n.fact_claims,
               n.ai_metadata,n.ai_metadata->'article' AS article,
               s.name AS source_name,s.slug AS source_slug,s.homepage_url,s.unofficial AS source_is_unofficial
        FROM news_items n JOIN sources s ON s.id=n.source_id
        WHERE n.id=$1 AND n.status='published'`, [id]);
      if (rows[0]) return rows[0];
    }
    throw new NotFoundException('Article not found');
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
             COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
             n.published_at, s.name AS source_name, s.slug AS source_slug
      FROM news_items n JOIN sources s ON s.id = n.source_id
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
}

function articleKey(value: string): string {
  const url = URL.parse(value);
  return url ? `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}` : value;
}

function publishedTime(date: Date | string | null): number {
  return date ? new Date(date).getTime() : 0;
}

const TOPIC_ALIAS_MAP: Record<string, { categories: string[]; keywords: string[] }> = {
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
};

function scoreTopicMatch(item: Record<string, unknown>, topics: string[]): number {
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
      if (alias.keywords.some((kw) => text.includes(kw))) {
        score += 2;
      }
    } else if (text.includes(token)) {
      score += 2;
    }
  }
  return score;
}
