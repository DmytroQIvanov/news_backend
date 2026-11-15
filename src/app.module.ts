import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { KeepAliveService } from './health/keep-alive.service';
import { SourcesController } from './sources/sources.controller';
import { NewsController } from './news/news.controller';
import { CompanyFeedsService } from './news/company-feeds.service';
import { FeedEditorialService } from './news/feed-editorial.service';
import { NewsTtsService } from './news/news-tts.service';
import { ExpertOpinionsService } from './news/expert-opinions.service';
import { NewsMemesService } from './news/news-memes.service';
import { SourceDiscoveryService } from './news/source-discovery.service';
import { GeminiEditorService } from './ingest/gemini-editor.service';
import { IngestController } from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { IngestKeyGuard } from './common/ingest-key.guard';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { GamesController } from './games/games.controller';
import { GamesService } from './games/games.service';
import { KgController } from './kg/kg.controller';
import { KgService } from './kg/kg.service';
import { GrantsController } from './grants/grants.controller';
import { GrantsService } from './grants/grants.service';

@Module({
  controllers: [
    HealthController,
    SourcesController,
    NewsController,
    IngestController,
    CatalogController,
    GamesController,
    KgController,
    GrantsController,
  ],
  providers: [
    DatabaseService,
    KeepAliveService,
    IngestService,
    IngestKeyGuard,
    CompanyFeedsService,
    SourceDiscoveryService,
    GeminiEditorService,
    FeedEditorialService,
    NewsTtsService,
    ExpertOpinionsService,
    NewsMemesService,
    CatalogService,
    GamesService,
    KgService,
    GrantsService,
  ],
})
export class AppModule {}
