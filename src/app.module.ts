import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { SourcesController } from './sources/sources.controller';
import { NewsController } from './news/news.controller';
import { CompanyFeedsService } from './news/company-feeds.service';
import { FeedEditorialService } from './news/feed-editorial.service';
import { SourceDiscoveryService } from './news/source-discovery.service';
import { GeminiEditorService } from './ingest/gemini-editor.service';
import { IngestController } from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { IngestKeyGuard } from './common/ingest-key.guard';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';

@Module({
  controllers: [
    HealthController,
    SourcesController,
    NewsController,
    IngestController,
    CatalogController,
  ],
  providers: [
    DatabaseService,
    IngestService,
    IngestKeyGuard,
    CompanyFeedsService,
    SourceDiscoveryService,
    GeminiEditorService,
    FeedEditorialService,
    CatalogService,
  ],
})
export class AppModule {}
