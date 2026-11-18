import { BadRequestException, Controller, Get, Header, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CATEGORIES } from '../ingest/ingest.dto';
import { YoutubeRadarService } from './youtube-radar.service';
import { YoutubeChannelDiscoveryService } from './youtube-channel-discovery.service';

@Controller('youtube')
export class YoutubeController {
  constructor(
    private readonly youtubeRadar: YoutubeRadarService,
    private readonly channelDiscovery: YoutubeChannelDiscoveryService,
    private readonly db: DatabaseService,
  ) {}

  /** Videos that cover the same event as a news article: judged relevant by AI and analysed with timestamps. */
  @Get('news/:newsId/videos')
  @Header('Cache-Control', 'public, max-age=120')
  async newsVideos(@Param('newsId', ParseIntPipe) newsId: number) {
    const rows = (await this.db.query(
      `SELECT v.video_id, v.url, v.title, v.channel, v.duration_sec, v.published_hint, v.views, v.relevance,
              v.verdict->>'kind' AS kind, v.verdict->>'channel_authority' AS authority, v.analysis
       FROM event_videos v JOIN news_items n ON n.kb_event_id = v.event_id
       WHERE n.id = $1 AND v.status = 'analyzed' ORDER BY v.relevance DESC NULLS LAST LIMIT 6`, [newsId],
    )).rows;
    return {
      items: rows.map((r) => ({
        videoId: r.video_id, url: r.url, title: r.title, channel: r.channel, durationSec: r.duration_sec, published: r.published_hint, views: r.views,
        relevance: r.relevance, kind: r.kind, channelAuthority: r.authority, thumbnail: `https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg`,
        summaryUk: r.analysis?.summary_uk ?? null, summaryEn: r.analysis?.summary_en ?? null, language: r.analysis?.language ?? null,
        keyPoints: (r.analysis?.key_points ?? []).map((p: { t: number; point: string }) => ({ ...p, url: `${r.url}&t=${p.t}s` })),
        quotes: (r.analysis?.quotes ?? []).map((q: { t: number; speaker: string; text: string }) => ({ ...q, url: `${r.url}&t=${q.t}s` })),
      })),
    };
  }

  @Get('insights')
  async listInsights(
    @Query('limit') limitRaw?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('channel') channelId?: string,
    @Query('sort') sort?: string,
    @Query('maxAgeHours') maxAgeHoursRaw?: string,
    @Query('important') important?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0 || offset > 500) throw new BadRequestException('offset: 0–500');
    if (channelId !== undefined && !/^UC[\w-]{22}$/.test(channelId)) throw new BadRequestException('Invalid channel id');
    if (sort !== undefined && sort !== 'top' && sort !== 'latest') throw new BadRequestException('sort must be top or latest');
    const maxAgeHours = maxAgeHoursRaw === undefined ? undefined : Number(maxAgeHoursRaw);
    if (maxAgeHours !== undefined && (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 720)) {
      throw new BadRequestException('maxAgeHours: 1–720');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('limit must be an integer between 1 and 50');
    }
    if (category && !(CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException('Invalid category');
    }
    const allowedStatuses = new Set(['transcribed', 'skipped_low_value', 'skipped_short', 'failed', 'all']);
    if (status && !allowedStatuses.has(status)) {
      throw new BadRequestException('Invalid status');
    }

    return this.youtubeRadar.listInsights({
      limit,
      category,
      status,
      channelId,
      sort: sort as 'top' | 'latest' | undefined,
      maxAgeHours,
      importantOnly: important === 'true',
      offset,
    });
  }

  @Get('channels')
  async listChannels() {
    const channels = await this.youtubeRadar.listChannelsWithStats();
    return { total: channels.length, items: channels };
  }

  /** What Gemini discovered (including rejected / pending), for review. */
  @Get('channels/discovered')
  async discoveredChannels(@Query('limit') limitRaw?: string) {
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new BadRequestException('limit: 1–400');
    return { items: await this.channelDiscovery.listDiscovered(limit) };
  }

  @Post('channels/discover')
  @UseGuards(IngestKeyGuard)
  async discoverChannels() {
    return this.channelDiscovery.discover();
  }

  @Get('quota')
  async quota() {
    return this.youtubeRadar.getQuotaStatus();
  }

  @Post('sync')
  @UseGuards(IngestKeyGuard)
  async sync(@Query('maxTranscribe') maxTranscribeRaw?: string) {
    const maxTranscribe =
      maxTranscribeRaw === undefined ? undefined : Number(maxTranscribeRaw);
    if (
      maxTranscribe !== undefined &&
      (!Number.isInteger(maxTranscribe) || maxTranscribe < 1 || maxTranscribe > 10)
    ) {
      throw new BadRequestException('maxTranscribe must be an integer between 1 and 10');
    }
    return this.youtubeRadar.syncOnce({ maxTranscribe });
  }
}
