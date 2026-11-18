import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { KeepAliveService } from './health/keep-alive.service';
import { SourcesController } from './sources/sources.controller';
import { NewsController } from './news/news.controller';
import { CompanyFeedsService } from './news/company-feeds.service';
import { FeedEditorialService } from './news/feed-editorial.service';
import { NewsClusteringService } from './news/news-clustering.service';
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
import { YoutubeController } from './youtube/youtube.controller';
import { YoutubeRadarService } from './youtube/youtube-radar.service';
import { FeedController } from './news/feed.controller';
import { PersonalizationService } from './news/personalization.service';
import { StoryBriefingService } from './news/story-briefing.service';
import { CaricatureService } from './news/caricature.service';
import { NewsMediaService } from './news/news-media.service';
import { PhotoStorageService } from './common/photo-storage.service';
import { PhotoMediaInterceptor } from './common/photo-media.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ResponseCacheInterceptor } from './common/response-cache.interceptor';
import { AudioBriefingService } from './news/audio-briefing.service';
import { TranslationService } from './news/translation.service';
import { YoutubeChannelDiscoveryService } from './youtube/youtube-channel-discovery.service';
import { AiRankingsController } from './ai-rankings/ai-rankings.controller';
import { AiRankingsService } from './ai-rankings/ai-rankings.service';
import { ObjectivityController } from './news/objectivity.controller';
import { TopicsService } from './news/topics.service';
import { InsightsController } from './insights/insights.controller';
import { InsightsService } from './insights/insights.service';
import { LlmStatsController } from './common/llm-stats.controller';
import { LlmStatsService } from './common/llm-stats';
import { KbController } from './kb/kb.controller';
import { KbEditorialService } from './kb/kb-editorial.service';
import { KbFlagshipService } from './kb/kb-flagship.service';
import { KbCorroborationService } from './kb/kb-corroboration.service';
import { WorldSourceDiscoveryService } from './news/world-source-discovery.service';
import { EventVideosService } from './youtube/event-videos.service';
import { RelatedNewsService } from './news/related-news.service';
import { PeopleDiscoveryService } from './news/people-discovery.service';
import { DiscoveryController } from './news/discovery.controller';
import { KbTranslationService } from './kb/kb-translation.service';
import { KbReadService } from './kb/kb-read.service';
import { KbDataService } from './kb/kb-data.service';

@Module({
  controllers: [
    HealthController,
    SourcesController,
    DiscoveryController,
    NewsController,
    IngestController,
    CatalogController,
    GamesController,
    KgController,
    GrantsController,
    YoutubeController,
    FeedController,
    AiRankingsController,
    ObjectivityController,
    InsightsController,
    LlmStatsController,
    KbController,
  ],
  providers: [
    DatabaseService,
    KeepAliveService,
    IngestService,
    IngestKeyGuard,
    CompanyFeedsService,
    NewsClusteringService,
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
    YoutubeRadarService,
    PersonalizationService,
    StoryBriefingService,
    CaricatureService,
    NewsMediaService,
    PhotoStorageService,
    { provide: APP_INTERCEPTOR, useClass: PhotoMediaInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseCacheInterceptor },
    AudioBriefingService,
    TranslationService,
    YoutubeChannelDiscoveryService,
    AiRankingsService,
    TopicsService,
    InsightsService,
    LlmStatsService,
    KbReadService,
    KbDataService,
    KbEditorialService,
    KbFlagshipService,
    KbCorroborationService,
    WorldSourceDiscoveryService,
    EventVideosService,
    PeopleDiscoveryService,
    RelatedNewsService,
    KbTranslationService,
  ],
})
export class AppModule {}
