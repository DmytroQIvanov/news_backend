import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { GamesService } from './games.service';

@Controller('games')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  list(
    @Query('type') type?: string,
    @Query('store') store?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 30;
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    return this.games.list({
      type: type?.trim() || undefined,
      store: store?.trim() || undefined,
      q: q?.trim() || undefined,
      sort: sort?.trim() || undefined,
      limit: Number.isFinite(limit) ? limit : 30,
      offset: Number.isFinite(offset) ? offset : 0,
    });
  }

  @Post('refresh')
  @UseGuards(IngestKeyGuard)
  refresh() {
    return this.games.syncGames();
  }
}
