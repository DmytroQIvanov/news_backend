import { Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
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
    const published = this.db.query<{ id: string; url: string; published_at: Date | null }>(`
      SELECT n.id,n.url,n.title_uk,n.summary_uk,n.original_title,n.category,n.importance,
             n.free_access,n.published_at,n.updated_at,s.name AS source_name,s.slug AS source_slug
      FROM news_items n JOIN sources s ON s.id=n.source_id
      WHERE n.status='published' AND ($1::text IS NULL OR n.category=$1)
        AND ($4::text[] IS NULL OR s.slug = ANY($4::text[]))
      ORDER BY n.published_at DESC NULLS LAST,n.id DESC LIMIT $2 OFFSET $3`,
    [category || null, category ? limit : offset + limit + maxFeedArticles, category ? offset : 0,
      sources.length ? sources : null]);
    if (category) return { items: (await published).rows, limit, offset };

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
