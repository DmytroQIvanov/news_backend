import { BadRequestException, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CATEGORIES } from '../ingest/ingest.dto';
import { YoutubeRadarService } from './youtube-radar.service';
import { YoutubeChannelDiscoveryService } from './youtube-channel-discovery.service';

@Controller('youtube')
export class YoutubeController {
  constructor(
    private readonly youtubeRadar: YoutubeRadarService,
    private readonly channelDiscovery: YoutubeChannelDiscoveryService,
  ) {}

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
