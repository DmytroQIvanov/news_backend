import { BadRequestException, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CATEGORIES } from '../ingest/ingest.dto';
import { YoutubeRadarService } from './youtube-radar.service';

@Controller('youtube')
export class YoutubeController {
  constructor(private readonly youtubeRadar: YoutubeRadarService) {}

  @Get('insights')
  async listInsights(
    @Query('limit') limitRaw?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
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

    return this.youtubeRadar.listInsights({ limit, category, status });
  }

  @Get('channels')
  listChannels() {
    const channels = this.youtubeRadar.getChannels();
    return { total: channels.length, items: channels };
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
