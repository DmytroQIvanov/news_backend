import { Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards, BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CompanyFeedsService, maxFeedArticles } from './company-feeds.service';
@Controller('news')
export class NewsController {
  constructor(private readonly db: DatabaseService, private readonly companyFeeds: CompanyFeedsService) {}

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
  ) {
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new BadRequestException('limit: 1–50, offset: 0–10000');
    }
    if (category && !['model','api','coding','open_source','research','business','other'].includes(category)) {
      throw new BadRequestException('Invalid category');
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
    const published = this.db.query<{ id: string; url: string; published_at: Date | null }>(`
      SELECT n.id,n.url,n.title_uk,n.summary_uk,n.original_title,n.category,n.importance,
             COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
             n.free_access,n.published_at,n.updated_at,s.name AS source_name,s.slug AS source_slug
      FROM news_items n JOIN sources s ON s.id=n.source_id
      WHERE n.status='published' AND ($1::text IS NULL OR n.category=$1)
        AND ($4::text[] IS NULL OR s.slug = ANY($4::text[]))
        AND (NOT $5::boolean OR n.ai_metadata->'article'->'important' = 'true'::jsonb)
      ORDER BY n.published_at DESC NULLS LAST,n.id DESC LIMIT $2 OFFSET $3`,
    [category || null, onlyDatabase ? limit : offset + limit + maxFeedArticles, onlyDatabase ? offset : 0,
      sources.length ? sources : null, important === 'true']);
    if (onlyDatabase) return { items: (await published).rows, limit, offset };

    const [result, feeds] = await Promise.all([published, this.companyFeeds.list(sources)]);
    if (feeds.unavailable && !result.rows.length) {
      throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
    }

    const publishedUrls = new Set(result.rows.map(item => articleKey(item.url)));
    const fresh = feeds.items.filter(item => !publishedUrls.has(articleKey(item.url)))
      .map(item => ({ ...item, title_uk: null, summary_uk: null }));
    const items = [...result.rows, ...fresh].sort((a, b) => publishedTime(b.published_at) - publishedTime(a.published_at));
    return { items: items.slice(offset, offset + limit), limit, offset };
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
  @Get(':id')
  async detail(@Param('id') id: string, @Query('source') source?: string) {
    if (/^rss-[a-f0-9]{24}$/.test(id)) {
      const result = await this.db.query(`
        SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
               n.ai_metadata->'article' AS article,s.name AS source_name,s.slug AS source_slug
        FROM news_items n JOIN sources s ON s.id=n.source_id
        WHERE n.external_id=$1 AND n.status='published' LIMIT 1`, [id]);
      if (result.rows[0]) return result.rows[0];
      const feeds = await this.companyFeeds.list(source ? [source] : []);
      const item = feeds.items.find(article => article.id === id);
      if (item) return item;
      if (feeds.unavailable) throw new ServiceUnavailableException('Company feeds are temporarily unavailable');
    } else if (/^\d{1,18}$/.test(id)) {
      const { rows } = await this.db.query(`
        SELECT n.id,n.url,n.original_title,n.original_summary,n.title_uk,n.summary_uk,n.published_at,
               n.ai_metadata->'article' AS article,s.name AS source_name,s.slug AS source_slug
        FROM news_items n JOIN sources s ON s.id=n.source_id
        WHERE n.id=$1 AND n.status='published'`, [id]);
      if (rows[0]) return rows[0];
    }
    throw new NotFoundException('Article not found');
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
