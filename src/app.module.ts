import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { SourcesController } from './sources/sources.controller';
import { NewsController } from './news/news.controller';
import { IngestController } from './ingest/ingest.controller';
import { IngestService } from './ingest/ingest.service';
import { IngestKeyGuard } from './common/ingest-key.guard';
@Module({
  controllers: [HealthController, SourcesController, NewsController, IngestController],
  providers: [DatabaseService, IngestService, IngestKeyGuard],
})
export class AppModule {}
