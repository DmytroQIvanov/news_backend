import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CompanyFeedsService } from '../news/company-feeds.service';
import { FeedEditorialService } from '../news/feed-editorial.service';
import { SourceDiscoveryService } from '../news/source-discovery.service';
import { IngestRequestDto } from './ingest.dto';
import { IngestService } from './ingest.service';

@Controller('ingest')
@UseGuards(IngestKeyGuard)
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly feeds: CompanyFeedsService,
    private readonly editorial: FeedEditorialService,
    private readonly catalog: CatalogService,
    private readonly discovery: SourceDiscoveryService,
  ) {}

  @Post('news')
  ingestNews(@Body() dto: IngestRequestDto) {
    return this.ingest.ingest(dto);
  }

  /**
   * Protected endpoint for Render Cron Jobs or GitHub Actions scheduled triggers.
   * Polls all RSS/Atom feeds, processes new articles via Gemini, and runs incremental
   * encyclopedia verification (plus optional source discovery when ?discover=true).
   */
  @Post('sync')
  async syncAll(@Query('discover') discover?: string) {
    const discoveryResult = discover === 'true' ? await this.discovery.discoverAndVerify() : null;
    const feedResult = await this.feeds.pollAll(true);
    const editorialResult = await this.editorial.runOnce();
    const catalogResult = await this.catalog.syncAndVerifyAll(false);
    return {
      discovery: discoveryResult,
      feeds: feedResult,
      editorial: editorialResult,
      catalog: { updated: catalogResult.updated, skipped: catalogResult.skipped },
      syncedAt: new Date().toISOString(),
    };
  }
}
