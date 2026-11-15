import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { LicenseMode } from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, LICENSE_MODES, NewsCategory } from '../ingest/ingest.dto';
import { CompanyFeedsService } from '../news/company-feeds.service';
import { SourceDiscoveryService } from '../news/source-discovery.service';

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
