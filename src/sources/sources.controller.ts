import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { DatabaseService } from '../database/database.service';
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
    const result = await this.db.query(
      'SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id, auto_discovered, last_fetched_at, last_error FROM sources WHERE enabled = true ORDER BY auto_discovered ASC, name ASC',
    );
    return { items: result.rows };
  }

  @Get('health')
  health() {
    const items = this.feeds.getHealthSnapshot();
    const healthy = items.filter(i => !i.lastError && i.articleCount > 0).length;
    return { total: items.length, healthy, items };
  }

  @Post('discover')
  @UseGuards(IngestKeyGuard)
  discover() {
    return this.discovery.discoverAndVerify();
  }
}
