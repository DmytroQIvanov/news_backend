import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { LicenseMode } from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, LICENSE_MODES, NewsCategory } from '../ingest/ingest.dto';
import { CompanyFeedsService } from '../news/company-feeds.service';
import { SourceDiscoveryService } from '../news/source-discovery.service';
import { LENS_LABELS, localizeProfile, resolveProfile, SOURCE_LENSES, SOURCE_PROFILES } from '../news/source-profiles';

function emptyRecord() {
  return { published: 0, corrected: 0, retracted: 0, reportsAccepted: 0 };
}

@Controller('sources')
export class SourcesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly feeds: CompanyFeedsService,
    private readonly discovery: SourceDiscoveryService,
  ) {}

  @Get()
  async list() {
    const result = await this.db
      .query(
        `SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id,
                auto_discovered, license_mode, review_status, last_fetched_at, last_error
         FROM sources
         WHERE enabled = true AND COALESCE(review_status, 'approved') = 'approved'
         ORDER BY auto_discovered ASC, name ASC`,
      )
      .catch(() =>
        this.db.query(
          'SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id, auto_discovered, last_fetched_at, last_error FROM sources WHERE enabled = true ORDER BY auto_discovered ASC, name ASC',
        ),
      );
    return { items: result.rows };
  }

  /** Source cards: ownership, funding, country, lens — plus this app's own corrections record per source. */
  @Get('profiles')
  async profiles(@Query('lang') langRaw?: string) {
    const lang = langRaw === 'en' ? 'en' : 'uk';
    const stats = await this.correctionStats();
    return {
      lenses: SOURCE_LENSES.map((l) => ({ lens: l, label: LENS_LABELS[l][lang] })),
      items: SOURCE_PROFILES.map((p) => ({ ...localizeProfile(p, lang), record: stats.get(p.slug) ?? emptyRecord() })),
    };
  }

  @Get('profiles/:slug')
  async profile(@Param('slug') slug: string, @Query('lang') langRaw?: string, @Query('url') url?: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) throw new BadRequestException('Invalid source slug');
    const lang = langRaw === 'en' ? 'en' : 'uk';
    const profile = resolveProfile(slug, url);
    const stats = await this.correctionStats(profile?.slug ?? slug);
    return {
      slug,
      profile: localizeProfile(profile, lang),
      lensLabel: LENS_LABELS[profile?.lens ?? 'unknown'][lang],
      record: stats.get(profile?.slug ?? slug) ?? emptyRecord(),
    };
  }

  private async correctionStats(slug?: string) {
    const out = new Map<string, ReturnType<typeof emptyRecord>>();
    const { rows } = await this.db
      .query<{ slug: string; published: number; corrected: number; retracted: number; reports_accepted: number }>(
        `SELECT s.slug,
                COUNT(n.id)::int AS published,
                COUNT(n.id) FILTER (WHERE n.correction_note IS NOT NULL OR n.corrected_at IS NOT NULL)::int AS corrected,
                COUNT(n.id) FILTER (WHERE n.is_retracted)::int AS retracted,
                COALESCE((SELECT COUNT(*) FROM error_reports e JOIN news_items n2 ON n2.id = e.news_id
                          WHERE n2.source_id = s.id AND e.status = 'accepted'), 0)::int AS reports_accepted
         FROM sources s LEFT JOIN news_items n ON n.source_id = s.id AND n.status = 'published'
         WHERE ($1::text IS NULL OR s.slug = $1)
         GROUP BY s.id, s.slug`,
        [slug ?? null],
      )
      .catch(() => ({ rows: [] as Array<{ slug: string; published: number; corrected: number; retracted: number; reports_accepted: number }> }));
    for (const r of rows) {
      out.set(r.slug, { published: r.published, corrected: r.corrected, retracted: r.retracted, reportsAccepted: r.reports_accepted });
    }
    return out;
  }

  @Get('health')
  health() {
    const items = this.feeds.getHealthSnapshot();
    const healthy = items.filter(i => !i.lastError && i.articleCount > 0).length;
    return { total: items.length, healthy, items };
  }

  @Get('pending')
  @UseGuards(IngestKeyGuard)
  pending() {
    return this.discovery.listPendingSources();
  }

  @Post('discover')
  @UseGuards(IngestKeyGuard)
  discover(@Body() body?: { focusCategories?: string[]; query?: string; requireModeration?: boolean }) {
    const focusCategories = Array.isArray(body?.focusCategories)
      ? body.focusCategories.filter((c): c is string => typeof c === 'string')
      : undefined;
    const query = typeof body?.query === 'string' ? body.query.trim().slice(0, 200) : undefined;
    const requireModeration =
      typeof body?.requireModeration === 'boolean' ? body.requireModeration : undefined;
    return this.discovery.discoverAndVerify(
      focusCategories?.length || query || requireModeration !== undefined
        ? { focusCategories, query, requireModeration }
        : undefined,
    );
  }

  @Post(':slug/approve')
  @UseGuards(IngestKeyGuard)
  async approve(
    @Param('slug') slug: string,
    @Body() body?: { licenseMode?: LicenseMode; category?: NewsCategory },
  ) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(slug)) {
      throw new BadRequestException('Invalid source slug');
    }
    if (body?.licenseMode && !(LICENSE_MODES as readonly string[]).includes(body.licenseMode)) {
      throw new BadRequestException('Invalid licenseMode');
    }
    if (body?.category && !(CATEGORIES as readonly string[]).includes(body.category)) {
      throw new BadRequestException('Invalid category');
    }
    const updated = await this.discovery.approveSource(slug, {
      licenseMode: body?.licenseMode,
      category: body?.category,
    });
    if (!updated) throw new NotFoundException('Source not found');
    return updated;
  }

  @Post(':slug/reject')
  @UseGuards(IngestKeyGuard)
  async reject(@Param('slug') slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(slug)) {
      throw new BadRequestException('Invalid source slug');
    }
    const updated = await this.discovery.rejectSource(slug);
    if (!updated) throw new NotFoundException('Source not found');
    return updated;
  }
}
